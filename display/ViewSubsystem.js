// The view: the PixiJS presentation layer. Owns the renderer/canvas, the camera
// transform, and per-frame drawing of whatever the grid says is on screen.
//
// Three coordinate spaces are in play:
//   - pixel space   — the actual tab/canvas pixels (varies per device/window)
//   - gameMeasure   — a resolution-independent logical space: the LONGER screen
//                     axis is always GAME_LONG (2000), the shorter is scaled to
//                     keep aspect. Game logic/camera sizing live here.
//   - world space   — where entities + the SpatialGrid live.
//
// Requires PixiJS loaded as a global `PIXI` before any method that touches it.

import { allEntityIds, entityDef } from "../entities/EntityRegistry.js";
import { lerpAngle } from "../calculations/Angles.js";
import { sdfShape } from "./shaders/SdfShape.js";
import { healthBar } from "./ui/HealthBar.js";
import { playerHUD } from "./ui/PlayerHUD.js";
import { polygonGraphic } from "../geometry/PolygonShape.js";
import { petalEmblem, countBadge } from "../geometry/PetalContainer.js";
import { TerrainLayer, TILE_WORLD } from "./TerrainLayer.js";
import { animationScreen } from "./animation/Animation.js";

const GAME_LONG = 2000; // gameMeasure units along the longer screen axis

// Floating health bar size, relative to an entity's collision radius (so bars
// scale with the thing they label). Feeds `healthBar(size)`, whose bar width is
// `size × 0.6` → ≈ the entity diameter. The bar is placed one bar-height below
// the entity's lowest collision point (see `draw`).
const HEALTHBAR_SIZE_FACTOR = 10 / 3;

// Terrain textures (structures) — not referenced by any entity def, so they're
// loaded explicitly. Floor cells get GRASS, everything else gets BARRIER.
const GRASS_TEX = "Assets/textures/structures/Grass.png";
const BARRIER_TEX = "Assets/textures/structures/Barrier.png";
const BARRIER_HIGHER_TEX = "Assets/textures/structures/BarrierHigher.png"; // up/right edges
const BARRIER_LOWER_TEX = "Assets/textures/structures/BarrierLower.png"; //  left/down edges
const BARRIER_OUTER_TEX = "Assets/textures/structures/BarrierOuterCorner.png"; // convex corner
const BARRIER_INNER_TEX = "Assets/textures/structures/BarrierInnerCorner.png"; // concave corner


/**
 * Presentation subsystem. Reachable as `VisualEngine.shared.view`.
 */
export class ViewSubsystem {
  constructor() {
    /** gameMeasure dimensions (longest axis = GAME_LONG). Set by `measureGameSize`. */
    this.gameWidth = 0;
    this.gameHeight = 0;

    /** @type {any} PIXI.Application — created by `createCanvas`. */
    this.app = null;
    /** @type {any} The container the camera transforms; sprites live in here. */
    this.world = null;
    /** @type {any} Screen-space UI layer — drawn ABOVE `world` and never given the
     * camera transform, so its children stay fixed on screen (the HUD). Append to
     * it with `addUI(node)` / `view.ui.addChild(node)`. @see createCanvas */
    this.ui = null;
    /** What the player HUD's "Quit" button does — set by the app, handed to the
     * player HUD as it's built (see `drawPlayerHUD`). Null → Quit no-ops. */
    this.onQuit = null;
    /** The local player's HUD — owned by the VIEW (not the player entity), so it
     * PERSISTS across world switches (the entity is demolished + rebuilt on a switch;
     * the HUD must not be). Built lazily in `drawPlayerHUD`, dropped in `clearHUD`. */
    this.playerHud = null;

    /** The screen in-flight visuals are drawn on — a petal travelling between hotbar
     * slots, and anything else that has to exist between two places. Built with the
     * canvas so it's ready before the first HUD piece asks for it. Advanced by
     * {@link ViewSubsystem#updateAnimations} from the render loop. */
    this.animations = null;

    /** path → PIXI.Texture cache. @private */
    this._textures = new Map();
    /** Reused grid-query buffer (zero per-frame alloc). @private */
    this._visibleBuf = [];
    /** Sprites shown this/last frame, for cull toggling. Reused. @private */
    this._shown = new Set();
    this._nextShown = new Set();
  }

  /**
   * Derive the gameMeasure dimensions from the tab/viewport size. The longer
   * pixel axis maps to `GAME_LONG` (2000); the shorter is scaled proportionally
   * (`shorterPx / longerPx * GAME_LONG`) so aspect ratio is preserved. This makes
   * game/camera logic resolution-independent.
   *
   * @param {number} [pxWidth=window.innerWidth]   Viewport width in pixels.
   * @param {number} [pxHeight=window.innerHeight]  Viewport height in pixels.
   * @returns {{ gameWidth: number, gameHeight: number }}
   */
  measureGameSize(pxWidth = window.innerWidth, pxHeight = window.innerHeight) {
    const longest = Math.max(pxWidth, pxHeight);
    const shortest = Math.min(pxWidth, pxHeight);
    const shortGame = (shortest / longest) * GAME_LONG;

    if (pxWidth >= pxHeight) {
      this.gameWidth = GAME_LONG; // wide (the common case)
      this.gameHeight = shortGame;
    } else {
      this.gameHeight = GAME_LONG; // tall
      this.gameWidth = shortGame;
    }
    return { gameWidth: this.gameWidth, gameHeight: this.gameHeight };
  }

  /**
   * Create the Pixi renderer + canvas at the viewport's pixel size and attach it
   * so it fills the tab with no margins or letterboxing. `resizeTo: window` keeps
   * it filling as the window changes. Also creates the camera-transformed
   * `world` container that sprites are added to.
   *
   * @param {number} [background=0x1a1a1a]
   * @returns {Promise<any>} the PIXI.Application
   */
  async createCanvas(background = 0x1a1a1a) {
    this.measureGameSize();

    this.app = new PIXI.Application();
    await this.app.init({
      resizeTo: window, // fill the tab, auto-resize, no blank edges
      background,
      antialias: true,
      preference: "webgl", // SDF shapes (sdfShape) need WebGL2/GLSL ES 3.00
      // Render at the display's physical pixel density (2× on Retina) so art is
      // crisp instead of upscaled-and-blurry. `autoDensity` keeps the canvas its
      // CSS size while the backing buffer is `resolution`× larger.
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    });
    document.body.appendChild(this.app.canvas);

    this.world = new PIXI.Container();
    // Draw entities by their def's `visual.zIndex` (higher = on top) rather than
    // insertion order. Pixi only re-sorts when a child's zIndex changes, so this
    // is ~free for a stable scene. Ties keep insertion order.
    this.world.sortableChildren = true;
    this.app.stage.addChild(this.world);

    // Screen-space UI layer. Added to the stage AFTER `world` (so it draws on top)
    // and — critically — NOT touched by the camera transform in `draw()` (which only
    // scales/moves `world`). So its children live in fixed LOGICAL SCREEN pixels
    // (`app.screen` space, top-left origin), not world units: a HUD that stays put
    // as the camera pans/zooms. `sortableChildren` lets HUD pieces z-order by zIndex.
    this.ui = new PIXI.Container();
    this.ui.sortableChildren = true;
    this.app.stage.addChild(this.ui);

    // The animation layer, ABOVE every HUD piece: something in flight between two HUD
    // elements belongs to neither, and must not be clipped or re-sorted by either.
    this.animations = animationScreen();
    this.animations.container.zIndex = 200; // over the player HUD (100)
    this.ui.addChild(this.animations.container);

    // Ground tiles, under the entities. Grass over known floor, barrier elsewhere;
    // culled to the camera each frame so only on-screen tiles exist.
    //
    // Starts EMPTY (all barrier) — the ground is streamed. The client replaces this
    // with its own live floor set on `onWorldChange`, and fills that set in as
    // snapshots arrive. Generating a room here instead would paint whichever room
    // this build happens to ship before the server has said where we are.
    this.setTerrain(new Set());
    return this.app;
  }

  /**
   * Add a display object to the screen-space {@link ViewSubsystem#ui} layer (the
   * HUD). Positions are in LOGICAL SCREEN pixels — top-left is `(0,0)`, bottom-right
   * is `(screenSize.width, screenSize.height)` — and are NOT affected by the camera.
   * Set `node.zIndex` to order it against other HUD pieces. Returns the node so you
   * can keep a handle to update it per frame.
   * @param {any} node A PIXI.Container / mesh / Graphics.
   * @returns {any} the same node
   */
  addUI(node) {
    this.ui.addChild(node);
    return node;
  }

  /**
   * Remove a node previously added with {@link ViewSubsystem#addUI}. Does not
   * destroy it (the caller owns its lifecycle); call `node.destroy()` yourself if done.
   * @param {any} node
   */
  removeUI(node) {
    if (node && node.parent === this.ui) this.ui.removeChild(node);
  }

  /**
   * The HUD coordinate space: the logical screen size in CSS pixels (NOT physical/
   * retina pixels — Pixi scales the framebuffer by `resolution` itself). This is the
   * box `ui`-layer children live in; read it to anchor HUD to corners/edges, and
   * re-read it after a resize to reposition. `{0,0}` before `createCanvas`.
   * @returns {{ width: number, height: number }}
   */
  get screenSize() {
    return { width: this.app?.screen.width ?? 0, height: this.app?.screen.height ?? 0 };
  }

  /**
   * (Re)build the ground tiles for a set of floor cells — called at boot and on a
   * world switch (the client hands the new world's `floorCellSet`). Tears down any
   * existing terrain first. `floorCells` is a `Set<"cx,cy">`.
   * @param {Set<string>} floorCells
   */
  setTerrain(floorCells) {
    if (this.terrain) this.terrain.container.destroy({ children: true });
    this.terrain = new TerrainLayer(this.world, (p) => this._texture(p), {
      floorCells,
      grass: GRASS_TEX,
      barrier: BARRIER_TEX,
      higher: BARRIER_HIGHER_TEX,
      lower: BARRIER_LOWER_TEX,
      outerCorner: BARRIER_OUTER_TEX,
      innerCorner: BARRIER_INNER_TEX,
      tile: TILE_WORLD,
    });
  }

  /**
   * Preload textures into the cache so sprites show immediately. Call once at
   * boot with the paths you'll use.
   * @param {string[]} paths
   */
  async load(paths) {
    for (const path of paths) {
      try {
        this._textures.set(path, await PIXI.Assets.load(path));
      } catch (err) {
        // A missing/failed texture must NOT abort the rest — it just falls back
        // to the white placeholder. (e.g. only some art exists yet.)
        console.warn("texture failed to load (using placeholder):", path);
      }
    }
  }

  /**
   * Preload every sprite texture referenced by a loaded entity def (deduped, so
   * shared art like `bug.png` loads once). Requires `loadEntityDefs()` to have
   * run. Circle-drawn entities (the player) reference no texture and are skipped.
   */
  async loadTextures() {
    const paths = new Set();
    for (const id of allEntityIds()) {
      const v = entityDef(id).visual;
      if (v && v.type === "sprite" && v.texture) paths.add(v.texture);
    }
    const terrain = [GRASS_TEX, BARRIER_TEX, BARRIER_HIGHER_TEX, BARRIER_LOWER_TEX, BARRIER_OUTER_TEX, BARRIER_INNER_TEX];
    for (const p of terrain) paths.add(p); // terrain tiles aren't in the entity defs
    await this.load([...paths]);

    // Terrain art is 32×32 pixel art scaled up to 100-unit tiles. Default LINEAR
    // filtering blurs that magnification; NEAREST keeps the source pixels crisp.
    for (const p of terrain) {
      const t = this._textures.get(p);
      if (t) t.source.scaleMode = "nearest";
    }
  }

  /**
   * Draw one frame: ask the grid what's inside the camera, then create/position
   * a sprite for each visible entity and hide ones that left the view.
   *
   * The camera is in WORLD units; its aspect ratio should match the screen
   * (e.g. width = some world span, height = width * gameHeight/gameWidth) or the
   * image will stretch.
   *
   * @param {import("../memory/SpatialGrid.js").SpatialGrid} grid
   * @param {{ x: number, y: number, width: number, height: number }} camera
   *   World-space camera center (`x`,`y`) and size (`width`,`height`).
   * @param {number} [alpha=1] Interpolation factor (0..1) between each entity's
   *   previous and current sim position. Pass `accumulator / fixedDt` for smooth
   *   motion at a render rate higher than the sim rate; `1` renders the current
   *   state (no interpolation).
   */
  draw(grid, camera, alpha = 1) {
    const app = this.app;
    if (!app) return;

    const left = camera.x - camera.width / 2;
    const top = camera.y - camera.height / 2;

    // Camera transform: the camera's world rect maps onto the whole canvas. Use
    // the LOGICAL screen width (resolution-independent) — Pixi scales the
    // framebuffer by `resolution` itself, so world units map to CSS pixels here.
    const scale = app.screen.width / camera.width;
    this.world.scale.set(scale);
    this.world.position.set(-left * scale, -top * scale);

    // Ground tiles under everything — only the cells covering the camera.
    if (this.terrain) this.terrain.draw(left, top, camera.width, camera.height);

    // What's on screen this frame.
    const visible = grid.query(
      { x: left, y: top, width: camera.width, height: camera.height },
      this._visibleBuf
    );

    const next = this._nextShown;
    next.clear();
    for (let i = 0; i < visible.length; i++) {
      const e = visible[i];
      const sprite = this._spriteFor(e);
      sprite.visible = true;
      // Interpolate between last and current sim position for smooth motion at a
      // render rate above the sim rate (alpha=1 → exactly current, no interp). This is
      // what hides the fixed-timestep stepping: the sim advances in discrete ticks that
      // don't line up with the display's refresh, so without it a frame that ran no sim
      // step repeats a pixel and the next one double-jumps.
      // `renderOffsetX/Y` is a VISUAL-only nudge (default 0) — the client uses it to
      // draw entities at a low-passed follow point so reconcile tugs don't snap. It's
      // measured against this same interpolated point, so the two compose. The
      // sim/collision pos (e.x/e.y) is untouched by either.
      const rx = e.prevX + (e.x - e.prevX) * alpha + (e.renderOffsetX || 0); // world coords
      const ry = e.prevY + (e.y - e.prevY) * alpha + (e.renderOffsetY || 0);
      sprite.x = rx;
      sprite.y = ry;
      // Facing, interpolated across the tick the same way position is — a turning mob
      // (or a spinning petal) steps its `angle` once per sim tick, which a faster
      // display shows as rotational stutter. Blended the SHORT way around, so a heading
      // crossing ±π doesn't spin the sprite the long way. `_texRotation` is the
      // texture's baked-in facing offset (0 for circle visuals like the player), set
      // once in `_spriteFor`. Visual only — `e.angle` itself is untouched.
      // `renderAngleOffset` is the rotational twin of `renderOffsetX/Y` — the same
      // low-pass on the same halflife, so the drawn facing lags exactly as much as the
      // drawn body. Without it the sprite snaps to a new heading while still visibly
      // traveling the old one, which reads as the picture turning independently of the
      // thing it's attached to.
      const prevAngle = e.prevAngle !== undefined ? e.prevAngle : e.angle;
      sprite.rotation =
        lerpAngle(prevAngle, e.angle, alpha) + (e.renderAngleOffset || 0) + (sprite._texRotation || 0);
      next.add(sprite);

      // Floating health bar for any entity with health — built once, then
      // positioned below the entity and refilled each frame. Sits one bar-height
      // below the lowest collision point (the bottom of the collision circle).
      // Unrotated (it follows the smoothed render pos but never the facing).
      // Linked to the sprite so the cull pass below can hide it too.
      const bar = this._healthBarFor(e);
      if (bar !== null) {
        bar.visible = true;
        bar.x = rx;
        bar.y = ry + e.collisionRadius + bar.barHeight; // lowest point + one bar-height
        bar.setHealth(e.health, e.maxHealth);
        sprite._healthBar = bar;
      }
    }

    // Hide sprites that were shown last frame but aren't visible now. Skip any
    // whose entity was destroyed (Entity.destroy tore the display + bar down) —
    // touching a destroyed Pixi object would throw; it drops out of tracking on the
    // swap. Hide each sprite's linked health bar alongside it.
    //
    // `_fading` sprites are skipped too, and for the opposite reason: their entity is
    // out of the grid, so they can never appear in `next` again, and hiding one would
    // make the death fade invisible. `Entity.tickFades` owns it from here — it drives
    // the alpha down and destroys the sprite at the end, and `s.destroyed` above
    // catches it once that happens.
    for (const s of this._shown) {
      if (!next.has(s) && !s.destroyed && !s._fading) {
        s.visible = false;
        if (s._healthBar && !s._healthBar.destroyed) s._healthBar.visible = false;
      }
    }

    // Swap the reused sets (no allocation).
    const tmp = this._shown;
    this._shown = next;
    this._nextShown = tmp;

    return visible;
  }

  /**
   * Draw/refresh the LOCAL player's screen-space HUD. Call once per frame with
   * `client.player` (the entity this client owns) and the client's current `worldId`.
   * The HUD (`this.playerHud`) is built lazily on first sight and owned by the VIEW —
   * so it PERSISTS across world switches (the player entity is demolished + rebuilt
   * on a switch; the HUD reads whichever player it's handed each frame). Per-world UI
   * is (re)loaded whenever `worldId` changes — driven by the CLIENT's worldId, since
   * the player ENTITY's worldId isn't stamped client-side. Parented to the fixed `ui`
   * layer (NOT `world`) so it stays pinned. No-ops when `player` is null.
   * @param {any} player The local player entity, or null.
   * @param {string} [worldId] The client's current world id.
   */
  drawPlayerHUD(player, worldId) {
    if (!player) return;
    if (this.playerHud === null) {
      this.playerHud = playerHUD({ animations: this.animations });
      this.playerHud.onQuit = this.onQuit; // wire the Quit button to the app's handler
      this.ui.addChild(this.playerHud);
    }
    // (Re)load the per-world UI on first sight + whenever the world changes.
    if (worldId && this.playerHud.loadedWorld !== worldId) this.playerHud.loadUI(worldId);
    this.playerHud.update(player, this.screenSize);
  }

  /**
   * Show/hide the LOCAL player's body (its sprite + floating health bar). A world
   * WITHOUT the "movement" tag renders the player as just a camera position — no
   * body. Call each frame AFTER `draw()` (which re-shows every visible entity), so
   * this is the authoritative last word. No-op until the sprite exists.
   * @param {any} player The local player entity, or null.
   * @param {boolean} visible
   */
  setPlayerBodyVisible(player, visible) {
    if (!player) return;
    if (player.display) player.display.visible = visible;
    if (player.healthBar) player.healthBar.visible = visible;
  }

  /**
   * Tear down every HUD element in the screen-space `ui` layer (the player HUD +
   * anything else added there) and forget the player HUD, so leaving a session
   * doesn't leak a stale pause screen / health bar into the next one. A fresh
   * session rebuilds its own HUD on the next `drawPlayerHUD`.
   */
  /**
   * Advance every in-flight animation. Call once per rendered frame from the main loop,
   * with real elapsed seconds — `animationScreen` converts to ticks, so motion takes the
   * same wall-clock time at any frame rate.
   * @param {number} dtSec
   */
  updateAnimations(dtSec) {
    this.animations?.update(dtSec);
  }

  clearHUD() {
    // Drop anything mid-flight FIRST, without its callbacks: they exist to un-hide HUD
    // pieces that are about to be destroyed anyway, and running them would touch nodes
    // that no longer have a parent.
    this.animations?.clear();
    for (const child of [...this.ui.children]) child.destroy({ children: true });
    this.playerHud = null;
    // The UI layer was just emptied — rebuild the animation screen so the next HUD has
    // somewhere to put things.
    this.animations = animationScreen();
    this.animations.container.zIndex = 200;
    this.ui.addChild(this.animations.container);
  }

  /**
   * Get (or lazily create + cache) the floating health bar for an entity, stored
   * on `entity.healthBar`. Only entities with `maxHealth > 0` get one (and never
   * `petal`s — they have HP but no bar); others return `null`. The bar is added to
   * the camera-transformed `world` (so it tracks the entity) at `zIndex 10`, above
   * the entity sprites. Sized from the entity's collision radius. `Entity._teardown`
   * frees it on death. @private
   */
  _healthBarFor(entity) {
    if (entity.healthBar !== null) return entity.healthBar;
    if (!(entity.maxHealth > 0) || entity.kind === "petal") return null;
    const bar = healthBar(entity.collisionRadius * HEALTHBAR_SIZE_FACTOR, entity.health, entity.maxHealth, entity.rarity);
    this.world.addChild(bar);
    entity.healthBar = bar;
    return bar;
  }

  /**
   * Get (or lazily create + cache) the display object for an entity, stored on
   * `entity.display`. Built from the entity's def `visual` block — `sprite`
   * (textured) or `circle` (an SDF circle, e.g. the player). Data-driven: the
   * view reads `def.visual`, the engine never carries render fields.
   * @private
   */
  _spriteFor(entity) {
    if (entity.display) return entity.display;

    const v = entityDef(entity.defId).visual; // how this entity draws
    const display =
      v.type === "circle"
        ? this._circleDisplay(entity, v)
        : v.type === "polygon"
          ? this._polygonDisplay(entity, v)
          : this._spriteDisplay(entity, v);

    display.zIndex = v.zIndex ?? 0; // draw priority (higher = on top), 0 = default
    this.world.addChild(display);
    entity.display = display;
    return display;
  }

  /**
   * Build a textured sprite from a `sprite` visual, scaled so its drawn diameter
   * matches the entity's collision diameter × `visual.scale`. @private
   */
  _spriteDisplay(entity, v) {
    const tex = this._texture(v.texture); // `texture` is a full path, owned by the def
    const sprite = new PIXI.Sprite(tex);
    // Offset via the anchor (normalized → scales with the sprite): a +x offset
    // shifts the art right, so the anchored point moves left of center.
    sprite.anchor.set(0.5 - (v.offsetX ?? 0), 0.5 - (v.offsetY ?? 0));
    if (tex.width) {
      sprite.scale.set((entity.collisionRadius * 2 * (v.scale ?? 1)) / tex.width);
    }
    sprite._texRotation = v.directionOffset ?? 0; // read each frame in `draw`
    return sprite;
  }

  /**
   * Build an SDF circle (+ optional stroke ring) from a `circle` visual — the
   * player's body. `fill`/`stroke`/`strokeWidth`/`smooth` come from the def, so
   * the circle is data-driven like the sprites. @private
   */
  _circleDisplay(entity, v) {
    const r = entity.collisionRadius;
    const container = new PIXI.Container();
    const body = sdfShape({ width: r * 2, height: r * 2, color: v.fill, smooth: v.smooth ?? 0 });
    container.addChild(body);
    if (v.stroke != null && v.strokeWidth > 0) {
      const ring = new PIXI.Graphics();
      ring.circle(0, 0, r); // centred on the container origin
      ring.stroke({ color: v.stroke, width: v.strokeWidth });
      container.addChild(ring);
    }
    container._texRotation = 0; // no facing offset for a circle
    return container;
  }

  /**
   * Build a filled polygon from a `polygon` visual — drawn from the entity's own
   * procedural collision outline (`collider.verts`, local to the center, in world
   * units), so the drawn shape IS the collision shape. Filled with `visual.fill`
   * (default grey); bordered with a darker shade of the fill (or `visual.stroke`
   * if given). The border width is `visual.strokeScale` × the rock's diameter
   * (default 0.05 → 5% of size, scaling with the rock), or an absolute
   * `visual.strokeWidth`.
   *
   * The border sits ENTIRELY INSIDE the outline — no pixel crosses the collision
   * edge (see `polygonGraphic`, which owns that trick and is shared with the HUD's
   * petal containers so the two look identical). Verts are built unrotated in LOCAL
   * space; the sprite's own `rotation` turns them, matching the narrowphase, which
   * rotates the query into the polygon's frame by the same `angle`.
   *
   * A petal CONTAINER additionally draws the petal it holds (`entity.petal`) on top,
   * centered — the petal's own geometry + colors, as a plain nested graphic. It is NOT
   * a child entity: nothing is spawned, nothing collides, nothing simulates. Seeded by
   * the container's `id`, so the server and every client draw the identical shape. A
   * container standing for more than one (`entity.count`) also gets a "3x" badge in its
   * top-right corner — again just a label, not extra entities.
   * @private
   */
  _polygonDisplay(entity, v) {
    const col = entity.collider;
    const verts = col && col.type === "polygon" ? col.verts : null;
    // The rarity goes in so a def with `visual.fillFromRarity` (a petal container) is
    // colored by it; anything with a flat `fill` ignores the argument.
    const container = polygonGraphic(verts, entity.collisionRadius, v, entity.rarity);

    // Held petal, added last so it draws over the container. The border mask applies
    // only to the border graphic, not to siblings, so this isn't clipped by it.
    const emblem = petalEmblem(entity.petal, entity.collisionRadius, entity.id);
    if (emblem !== null) container.addChild(emblem);

    // …then the stack badge over that, for a container standing for more than one.
    const badge = countBadge(entity.count, entity.collisionRadius);
    if (badge !== null) container.addChild(badge);

    container._texRotation = 0;
    return container;
  }

  /**
   * Cached texture for a path. Returns a white fallback for a missing path or one
   * not yet preloaded (so call {@link ViewSubsystem#load} first for real art).
   * @private
   */
  _texture(path) {
    if (!path) return PIXI.Texture.WHITE;
    const t = this._textures.get(path);
    return t !== undefined ? t : PIXI.Texture.WHITE;
  }
}
