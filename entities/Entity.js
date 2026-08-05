// Base game entity — the object the other subsystems read from:
//   - GameEngine's SpatialGrid indexes it by `x`, `y`, `collisionRadius` (the
//     bounding box → cell range); no per-entity point list anymore.
//   - mechanics/collisions uses `x`, `y`, `collisionRadius`
//   - the view uses `display` (its Pixi object) + position
//
// One class with a `kind` field (composition over deep inheritance), so every
// entity shares the same hidden class — keeping property access monomorphic in
// the hot collision/AI loops.

import { Rarity, RARITY, rarityTier } from "./Rarity.js";
import { sizeScaleAt, healthAt, damageScaleAt, densityAt, speedAt } from "../calculations/RarityScaling.js";
import { Disposition } from "./Disposition.js";
import { entityDef } from "./EntityRegistry.js";
import { makeGeometry } from "../prediction/collisions/shapes/index.js";

// Re-export so `import { Rarity, RARITY, Disposition } from "./Entity.js"` works.
export { Rarity, RARITY, Disposition };

/**
 * This DEF's size multiplier at a rarity tier — the shared `1.5^tier` curve from
 * `calculations/RarityScaling.js`, plus the one piece of per-def policy that curve
 * shouldn't know about.
 *
 * A def can opt OUT with `sizeScalesWithRarity: false`, which pins it to its authored
 * size at every rarity. That's for things whose rarity describes their CONTENTS rather
 * than themselves — a petal container carries the rarity of the petal inside it, and a
 * legendary drop should be a normal-sized box holding a legendary petal, not a box four
 * times the size of the player. @private
 * @param {import("./EntityRegistry.js").EntityDef} def
 * @param {number} tier
 * @returns {number}
 */
function rarityScaleAt(def, tier) {
  if (def.sizeScalesWithRarity === false) return 1;
  return sizeScaleAt(tier);
}

/**
 * The hotbar's rows, in a FIXED order. Exported because the binary snapshot codec
 * packs rows positionally and has to agree with this list — adding a row here changes
 * the wire format, so both ends must ship together.
 * @type {readonly string[]}
 */
export const HOTBAR_ROWS = Object.freeze(["main", "secondary"]);

/** Slots per hotbar row — the 1–5 a player selects. Slot *n* is index *n-1*. Exported
 * so HUD that draws a slot per entry doesn't have to hardcode the count. */
export const HOTBAR_SLOTS = 5;

/** What every hotbar slot starts holding — a petal def id, or `null` for empty.
 *
 * A PLACEHOLDER: a real game grants petals (drops, crafting, a loadout screen) rather
 * than handing every player a full bar at spawn. It lives here so the whole pipeline —
 * state → snapshot → HUD — has something real to carry; move it to wherever petals are
 * actually awarded (e.g. `GameServer.accept`) once that exists. @private */
const STARTING_SLOT_PETAL = "rock_petal";

/**
 * One hotbar slot. Every slot is an object — an EMPTY slot is `petal: null`, not a null
 * slot — so its reload state always has somewhere to live.
 *
 *   petal           the def id this slot carries, or null for empty
 *   loaded          is its petal alive in the world right now?
 *   timeTillLoaded  seconds until it respawns; only counts down while unloaded
 *   entity          the live petal, or null. SERVER-ONLY — it never crosses the wire
 *                   (the client gets `petal`/`loaded`/`timeTillLoaded` and rebuilds
 *                   nothing), and it's what lets the reload tick notice a petal died
 *                   by polling `dead` instead of needing a death hook.
 *
 * @param {string|null} petal @returns {object} @private
 */
function newSlot(petal) {
  return { petal, loaded: false, timeTillLoaded: 0, entity: null };
}

/**
 * A fresh hotbar: one array per {@link HOTBAR_ROWS} entry, each `HOTBAR_SLOTS` slots
 * carrying {@link STARTING_SLOT_PETAL}. Rows are INDEPENDENT arrays (never a shared
 * reference), and so is every slot object.
 *
 * Slots start UNLOADED with a zero timer, so the reload tick spawns their petals on the
 * first step rather than making a fresh player wait out a reload they didn't earn.
 * @returns {{[row: string]: object[]}} @private
 */
function newHotbar() {
  const hotbar = {};
  for (const row of HOTBAR_ROWS) {
    const slots = new Array(HOTBAR_SLOTS);
    for (let i = 0; i < HOTBAR_SLOTS; i++) slots[i] = newSlot(STARTING_SLOT_PETAL);
    hotbar[row] = slots;
  }
  return hotbar;
}

/** Hard ceiling on `stickDepth`, as a fraction of the collision radius. A depth ≥ the
 * radius would place the stuck entity's CENTER at or past the enemy's surface (it
 * would look swallowed, and the placement loses the sign that tells it which way is
 * out), so the def's value is capped here. @private */
const STICK_DEPTH_MAX_FRACTION = 0.75;

/**
 * Entities whose body is gone but whose TEXTURE is still fading out. Each entry is
 * `{ entity, grid, left, total }` — `left` counts down one per sim tick and drives
 * the sprite's alpha, and the sprite is freed for real when it hits 0.
 *
 * A module-level list rather than a field on every entity: fading is rare, and this
 * way the 99% of entities that never fade pay nothing (no extra field, no hidden-class
 * churn). The entry holds the `grid` the entity died in so {@link tickFades} can tick
 * ONLY that world's fades — several worlds step per server tick, and a shared list
 * ticked by each of them would run every fade N× too fast.
 * @private
 */
const _fading = [];

/**
 * Advance the death fades for one world by a single sim tick, and free any that
 * finish. Called once per `GameEngine.step` with that world's grid.
 *
 * Alpha is `left / total`, so a `fade: 10` sprite steps 0.9, 0.8, … 0.1, then is
 * destroyed on the tick it would have reached 0 — a linear dissolve over exactly the
 * requested number of ticks.
 *
 * Duck-typed like the rest of the view handling here, so a headless run (no Pixi, no
 * `display`) is a no-op rather than a crash.
 *
 * @param {import("../memory/SpatialGrid.js").SpatialGrid} [grid] The stepping world's
 *   grid. Only fades registered against it are ticked.
 */
export function tickFades(grid) {
  for (let i = _fading.length - 1; i >= 0; i--) {
    const entry = _fading[i];
    if (entry.grid !== grid) continue;
    entry.left--;
    const display = entry.entity.display;
    const alive = display !== null && !display.destroyed;
    if (entry.left > 0) {
      if (alive) display.alpha = entry.left / entry.total;
      continue;
    }
    // Done (or the sprite vanished under us — freed by a world switch, say). Drop the
    // visuals for real and swap-remove; order in the list carries no meaning.
    entry.entity._freeVisuals();
    _fading[i] = _fading[_fading.length - 1];
    _fading.pop();
  }
}

/**
 * Source of locally-generated unique entity ids. Each `new Entity` without an
 * explicit `id` gets the next integer. NOTE: this is a unique *instance* id
 * (this bee vs that bee) — distinct from `kind`/`mobType`, which are the species
 * *type*. In server-authoritative multiplayer the server assigns ids; pass
 * `{ id }` to use an authoritative one instead of the local counter.
 */
let _nextEntityId = 1;

/**
 * Steps a freshly-spawned entity stays awake regardless of motion (~0.5s @ 60hz).
 * A stationary mob (e.g. a rock: `speed 0`, no target) is otherwise asleep the
 * instant it spawns, so it never *initiates* a collision sweep — two rocks
 * dropped overlapping would clip through each other forever (only a MOVING
 * neighbour ever tests a sleeper). This window lets a spawn-overlap resolve:
 * the pair pushes apart, knockback keeps them awake until separated, then they
 * settle back to sleep. See `GameEngine.step`'s awake test.
 */
export const SPAWN_WAKE_TICKS = 30;

/**
 * A game entity: a positioned circle with a collision radius.
 */
export class Entity {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.x=0]
   * @param {number} [opts.y=0]
   * @param {string} [opts.kind="mob"] Entity type tag (player / mob / petal / …).
   * @param {string} [opts.rarity="common"] One of {@link RARITY}.
   * @param {string|null} [opts.mobType=null] A mob species id (a def in
   *   `Assets/jsons/entities/`). When set, the entity's def is that species; when
   *   null, the def is looked up by `kind` (e.g. "player"). Either way all stats
   *   come from the {@link EntityDef} and the view draws from `def.visual`.
   * @param {number} [opts.angle=0] Facing/rotation in radians (visual only).
   * @param {number} [opts.momentum=0] Movement magnitude (how fast it's moving).
   * @param {number} [opts.direction=0] Movement heading in radians.
   * @param {string} [opts.disposition] One of {@link Disposition}. Defaults to
   *   the def's `disposition`. Pass to override (e.g. force `ALLIED`).
   * @param {*} [opts.ownerId=null] Controller id (a connection/player id) when
   *   input-driven; null for AI entities.
   * @param {number} [opts.id] Unique instance id. Defaults to a local counter;
   *   pass one to use a server-assigned id (multiplayer).
   * @param {string|null} [opts.petal=null] For a petal CONTAINER: the def id of the
   *   petal it holds (e.g. `"rock_petal"`), or null for empty. See {@link Entity#petal}.
   * @param {number} [opts.count=1] For a petal CONTAINER: how many it stands for (a
   *   stack size — still one entity). See {@link Entity#count}.
   */
  constructor({ x = 0, y = 0, kind = "mob", rarity = Rarity.COMMON, mobType = null, disposition, ownerId = null, angle = 0, momentum = 0, direction = 0, orbitAngle = 0, petal = null, count = 1, id = _nextEntityId++ } = {}) {
    // Always assign the same fields in the same order → one shared hidden class.

    /** Unique instance id (this entity, not its species). Network-stable. */
    this.id = id;

    this.x = x;
    this.y = y;

    /** Position at the START of the last sim step. The view lerps between
     * (`prevX`,`prevY`) and (`x`,`y`) so a high-refresh display shows smooth
     * motion while the sim ticks at a fixed rate. Snapshotted by `GameEngine.step`. */
    this.prevX = x;
    this.prevY = y;

    /** Facing at the START of the last sim step — the rotational counterpart of
     * `prevX`/`prevY`, snapshotted by the same code. The view lerps it the SHORT way
     * around (see `Angles.lerpAngle`), so a turning mob rotates smoothly between ticks
     * instead of stepping; without it, `angle` jumps once per tick and a display running
     * faster than the sim shows that as rotational stutter. */
    this.prevAngle = angle;

    /** VISUAL-only render nudge (world units), added to the drawn position by the
     * view and never read by the sim. The netcode client uses it to draw the local
     * player at a smoothed follow point (absorbing reconcile tugs) while the true
     * `x`/`y` keep driving collision and prediction. 0 for everything else. */
    this.renderOffsetX = 0;
    this.renderOffsetY = 0;

    /** The smoothed point this entity is DRAWN at — a low-passed follow of `x`/`y`,
     * from which `renderOffset` is derived each frame. `null` until the first smoothing
     * step (and reset to it on a teleport), which makes the entity snap rather than
     * sweep in from wherever it used to be.
     *
     * Why it exists: an entity's true position moves in DISCRETE jumps — the local sim
     * predicts, then the reconcile tugs it toward the server's pose in blend steps. That
     * stepping is exactly what reads as jitter. Drawing from a low-passed follow of the
     * true position filters it out; the sim, collision and input all keep using the true
     * position, so only the pixels lag. Owned by the client (see `GameClient`);
     * a headless run never touches it. */
    this.renderX = null;
    this.renderY = null;

    /** The smoothed FACING the entity is drawn at, and its offset from the true one —
     * the rotational half of `renderX`/`renderOffsetX`, on the same halflife.
     *
     * Both halves have to lag by the SAME amount or the sprite comes apart during a
     * turn: the body eases toward the hitbox while the facing snaps to the new heading,
     * so it visibly points one way while still traveling the other. Matching the lag
     * keeps facing and apparent motion coherent. Eased the short way around (see
     * `Angles.lerpAngle`). Visual only — `angle` itself is untouched. */
    this.renderAngle = null;
    this.renderAngleOffset = 0;

    /** For an ATTACHED entity (a petal): its eased offset FROM its parent's drawn point
     * — the orbital vector, low-passed. `null` until the first frame.
     *
     * The vector is eased, not the absolute position, and that distinction is the whole
     * point: an absolute ease has the parent's TRANSLATION inside the filter, so the
     * whole ring visibly trails the body whenever the owner runs. The orbital vector
     * doesn't translate — it only turns — so filtering it leaves the ring rigidly
     * attached while still smoothing how it moves around the body. Owned by the client
     * (see `GameClient`); a headless run never touches it. */
    this.orbitEaseX = null;
    this.orbitEaseY = null;

    /** Facing/rotation in radians. Plain circles are rotation-invariant, so this
     * never affects grid placement or the circle path — but OVAL and POLYGON colliders
     * turn with it in the narrowphase, so a spinning petal's hitbox spins with its
     * sprite. It's also what the view renders as `sprite.rotation`. `GameEngine.step` sets it to `direction` while the
     * entity is intending to move, so sprites face where they're headed. */
    this.angle = angle;

    /** Movement magnitude — how fast the entity is moving (0 = at rest). */
    this.momentum = momentum;

    /** Movement heading in radians (independent of `angle`, the visual facing). */
    this.direction = direction;

    /** The petal this container HOLDS — a def id (e.g. `"rock_petal"`), or null when
     * empty. Only meaningful on a petal container; null everywhere else.
     *
     * It is NOT a child entity: nothing is spawned, nothing collides, nothing simulates.
     * The container just remembers which petal it stands for, and the view draws that
     * petal's own geometry + colors as a graphic inside the container's square (see
     * `ui/PetalContainer.js`'s `petalEmblem`).
     *
     * Server-authoritative and network-stable: only the def id travels (`ptl`, packed as
     * the same manifest index `def` uses), and the client passes it to the constructor so
     * the display is built holding the right petal from the first frame. A change at
     * runtime frees the cached visuals so the view rebuilds — the same path `setRarity`
     * uses. */
    this.petal = petal;

    /** HOW MANY the container stands for — a stack size, not a count of anything real.
     * 1 (a single) unless it was created holding more; meaningless off a container.
     *
     * Like {@link Entity#petal} this spawns nothing: a container holding three petals is
     * still ONE entity with one collider. The view draws the difference — a `3x` badge in
     * the square's top-right corner, and only from {@link COUNT_BADGE_MIN} up, since
     * every ordinary container would otherwise wear a "1x" (see `ui/PetalContainer.js`).
     *
     * Server-authoritative on the same terms: it rides the wire as `cnt`, goes in at
     * construction so the first frame is already right, and a runtime change frees the
     * cached visuals so the view rebuilds — the badge is baked into the display. */
    this.count = count;

    /** This entity's NUMBER on its parent's orbit ring, or -1 when it isn't on one.
     * Assigned by `mechanics/petalManagement`'s `rebuildOrbit`. Its angle is derived from
     * this every tick — `(index / ringSize) × 2π + the ring's rotation` — rather than
     * being integrated per-petal, so nothing can drift out of formation. */
    this.orbitIndex = -1;

    /** This entity's fixed place on its parent's orbit ring, in radians, or -1 when it
     * isn't on one. Derived from {@link orbitIndex} when the ring is built — but it's
     * the BASE that travels over the wire (`oba`), not the index, because the angle
     * needs the ring's SIZE to reconstruct and the base doesn't.
     *
     * Its live angle is this plus the ring owner's `orbit1Rotation`, recomputed every
     * tick. Constant while the ring's membership holds still. */
    this.orbitBase = -1;

    /** Orbit phase (radians) for the `"orbit"` movement strategy — advanced each step
     * by `speed` degrees (× `orbitDir`). Per-entity so several petals spread around the
     * same parent. 0 and inert for non-orbiters. */
    this.orbitAngle = orbitAngle;

    /** Per-frame knockback accumulator (cartesian). Summed during collision
     * response, applied, then cleared each step. Kept SEPARATE from momentum so
     * "being shoved" and "wanting to move" don't bleed into each other. */
    this.knockbackX = 0;
    this.knockbackY = 0;

    /** Counts down each simulated step; while > 0 the entity is forced AWAKE
     * (see `GameEngine.step`) so a just-spawned mob participates in collision even
     * with no motion — letting a spawn-overlap shove itself apart before sleeping.
     * Starts at `SPAWN_WAKE_TICKS`. */
    this.wakeTicks = SPAWN_WAKE_TICKS;

    /** AI target as a world POINT — always an `{ x, y }`; `hasTarget` flags
     * whether it's active. Movement reads this point. Reused (mutated) so
     * retargeting allocates nothing. */
    this.target = { x: 0, y: 0 };
    this.hasTarget = false;

    /** The ALLIED entity this seeker locked onto, or null. Set by `Targeting`
     * during the periodic re-SELECT (the costly nearest-ally search). Movement
     * refreshes `target` from its LIVE position every frame, so the mob tracks a
     * moving player smoothly instead of chasing a point that only updates each
     * RETARGET_INTERVAL. A reference (no allocation); cleared when the seeker
     * drops its target. Input-driven entities (the player) leave it null. */
    this.targetAlly = null;

    /** The entity this one is ATTACHED to (e.g. a petal's owner / a segment's lead),
     * or null. Set via {@link setParent}, which keeps both sides in sync. Over the
     * wire only the parent's id travels (like `targetAlly` → `tgt`); the client
     * resolves it back to the live entity and rebuilds `children`. A child positions
     * itself off the parent (orbit = parent.pos + its own angle), and is destroyed
     * with the parent (see {@link destroy}). */
    this.parent = null;

    /** ORBIT 1 — this player's primary petal ring: every petal currently out, in the
     * order its slot sits in the hotbar, each with its BASE angle around the circle.
     * Entries are `{ entity, row, index, angle }`. Empty for anything that isn't a
     * player, and rebuilt by `mechanics/petalManagement`'s `rebuildOrbit` whenever a
     * petal joins or leaves — that's what re-spreads the survivors evenly instead of
     * leaving a gap where one died. (`orbit1`, not `orbit`, because a second ring for
     * the secondary row is the obvious next one.)
     *
     * `angle` is the petal's slot on a STILL ring. Where it actually sits is
     * `angle + orbit1Rotation`. */
    this.orbit1 = [];

    /** How far orbit 1 has turned, in radians, wrapped to [0, 2π). Advanced every tick
     * at the same rate `MOVEMENT.orbit` advances a petal, so the two never drift.
     *
     * This is what lets a petal join a ring already in motion: it takes its base angle
     * and ADDS this, so a ring turned halfway puts a new petal half a turn round from
     * where a still ring would — rather than popping in at the ring's original zero and
     * being visibly out of step with everything already circling. A whole turn wraps to
     * 0, so a full rotation adds nothing. */
    this.orbit1Rotation = 0;

    /** Radians orbit 1 turns per REFERENCE tick, signed (negative = clockwise). From the
     * def's `orbitSpeed`, in DEGREES/tick. The ring owns its rate — a petal's own `speed`
     * no longer turns it — so every petal on the circle moves as one piece regardless of
     * what each of them is or what rarity it happens to be. */
    this.orbit1Speed = 0; // set from the def below

    /** Entities attached to THIS one — the reverse of {@link parent}, maintained by
     * `setParent`. Used for cascade-destroy and queries ("how many petals"); NOT
     * transmitted (the client rebuilds it from incoming parent links). */
    this.children = new Set();

    /** The entity this orbiter is STUCK to — gliding along its surface instead of
     * sitting on its orbit anchor — or null. Latched in the engine step's collision
     * phase (see `GameEngine._simulate`) when an orbiter with `stickDepth` hits a
     * non-allied entity, and released by `MOVEMENT.orbit` once the orbit ANCHOR has
     * swept clear of it. Server-authoritative: like {@link parent}, only the id
     * travels (`stk`) and the client re-resolves it every snapshot, so a client that
     * latched on locally is un-stuck the moment the server says otherwise. */
    this.stick = null;

    /** Last outward contact normal (unit, enemy → petal) used while stuck. Kept so
     * the next tick can RATE-LIMIT how far the normal is allowed to swing — without
     * it, an anchor crossing the enemy's medial axis flips the nearest-surface point
     * ~180° in one tick and the petal teleports across the enemy. `(0,0)` = no
     * previous normal (first tick of a stick), so the raw normal is taken as-is. */
    this.stickNX = 0;
    this.stickNY = 0;

    /** In-combat flag. Hostile mobs seek regardless; a NEUTRAL mob only seeks
     * once this is set (e.g. by being attacked). Cleared by `Targeting` after a
     * few seconds without a target in range (the mob gives up the chase). */
    this.aggroed = false;

    /** Step at which a target was last in range — the aggro give-up timer's
     * reference point (see `Targeting.updateTargets`). */
    this.lastTargetStep = 0;

    /** Definition id for this entity — its species (for mobs) or `kind`
     * (player, …). The key into the shared {@link EntityDef}, read both here for
     * stats and by the view for `def.visual`. */
    this.defId = mobType ?? kind;
    const def = entityDef(this.defId); // throws if unknown / defs not loaded yet

    /** Entity tag from the def ("mob" / "player" / "petal" / …). */
    this.kind = def.kind;
    this.rarity = rarity;

    /** HOTBAR — `{ main: [...], secondary: [...] }`, two independent rows of 5 slots
     * (see {@link HOTBAR_ROWS} / `emptyHotbar`), or `null` for anything that isn't a
     * player (the field exists on every entity so they all share one hidden class;
     * `null` is the "no hotbar at all" case, distinct from a player's empty one).
     *
     * Slot *n* (the 1–5 a player selects) is index *n-1*. Each slot is a record — see
     * `newSlot` — carrying the petal def id plus its reload state (`loaded`,
     * `timeTillLoaded`, and a server-only handle on the live petal). Driven each step
     * by `mechanics/petalManagement`'s `reloadPetals`.
     *
     * **Server-authoritative, like {@link stick}.** It's owned by the server sim,
     * shipped in every snapshot (`hb`), and overwritten wholesale on the client — the
     * client never decides what's in it. The HUD's petal containers draw whatever each
     * slot holds (`ui/PlayerHUD.js`'s `petalContainerUI`); nothing else reads it. */
    this.hotbar = def.kind === "player" ? newHotbar() : null;

    /** Mob species (a def id) when this is a mob, else null. */
    this.mobType = mobType;

    /** Allegiance/behaviour — one of {@link Disposition}. Explicit arg wins;
     * otherwise the def's default. */
    this.disposition = disposition ?? def.disposition;

    /** Named movement strategy — which `MOVEMENT[...]` runs in the step's intended-
     * movement phase. `"seek"` (aim at target — mobs + the input-driven player; the
     * default) / `"orbit"` (kinematic, circles its `parent`) / … See
     * `mechanics/movement/Movement.js`. */
    this.movement = def.movement ?? "seek";

    /** Controller id (a connection/player id) when input-driven, else null.
     * Set by the inputs subsystem; links a player entity to its controller. */
    this.ownerId = ownerId;

    // Derived stats from the def + rarity (single path → one stable hidden
    // class). SIZE/density/speed/health/damage all scale off the tier by the
    // shared curves in `mechanics/calculations/RarityScaling.js`;
    // density/speed by the global per-tier growth (see Rarity.js).
    const tier = rarityTier(rarity);
    const scale = rarityScaleAt(def, tier);

    // Collision shape from the def (`def.collider`): an OVAL refines the bounding
    // circle; a POLYGON is a procedural lumpy outline (e.g. a rock); absent →
    // plain circle. rx/ry scale with rarity like size, and the bounding
    // `collisionRadius` is the larger semi-axis so it still encloses the ellipse
    // for broadphase + the narrowphase circle gate.
    const oval = def.collider != null && def.collider.type === "oval" ? def.collider : null;
    const rx = oval ? oval.rx * scale : 0;
    const ry = oval ? oval.ry * scale : 0;
    // Static rotation of the oval relative to the entity's facing (radians, e.g.
    // π/4 to point diagonal); rarity-independent. Added to `angle` in collision.
    const ovalAngle = oval ? (oval.angle ?? 0) : 0;

    // Polygon: generate the outline NOW from the rarity-scaled radius, seeded by
    // this entity's (network-stable) `id` so server & client produce the same
    // rock — see geometry/rock.js. `verts` are local; `boundingRadius` is the
    // longest spoke, which becomes `collisionRadius` so the bounds gate encloses
    // the shape.
    const poly = def.collider != null && def.collider.type === "polygon" ? def.collider : null;
    const polyGeom = poly ? makeGeometry(poly.shape, def.size * scale, this.id) : null;

    /** Bounding radius — broadphase AABB + the narrowphase circle gate. */
    this.collisionRadius = polyGeom ? polyGeom.boundingRadius : oval ? Math.max(rx, ry) : def.size * scale;
    /** Mass-like value driving collision push ratios. */
    this.density = densityAt(def.density, tier);
    /** Movement magnitude applied per step toward a target. */
    this.speed = speedAt(def.speed, tier);
    /** Detection range — scales with size (radius × per-def multiplier). */
    this.range = this.collisionRadius * def.rangeMult;
    /** Orbit radius (world units) for the `"orbit"` movement strategy — how far the
     * entity circles its `parent`. The orbital rate is `speed` DEGREES/tick; `orbitDir`
     * is the spin direction (+1 CCW / -1 CW). From the def; 0 for non-orbiters. */
    this.orbitRadius = def.orbitRadius ?? 0;
    this.orbitDir = def.orbitDir ?? 1;
    /** Orbit pull gain — the petal is drawn toward its anchor at a speed that grows with
     * the SQUARE of the distance: `orbitPull × dist² / orbitRadius` (capped at `dist`). So
     * the farther it strays the much faster it returns. Higher = stiffer/snappier. From the
     * def. */
    this.orbitPull = def.orbitPull ?? 1;
    /** RIGID orbit: place the entity exactly on its anchor every tick instead of
     * springing toward it (`def.orbitRigid`; default false = the spring).
     *
     * The spring is physical — it only produces force when stretched, so keeping pace
     * with a moving anchor requires a standing displacement, and the whole ring visibly
     * trails an owner who's running (~26% of the orbit radius at the stock numbers).
     * That's the right feel for something that can be knocked around and reels itself
     * back in; it's the wrong feel for a ring that should look welded to its owner.
     * Rigid gives up being shoved off by knockback — a rigid orbiter is immovable — but
     * STICK still overrides position, so surface-riding is unaffected. */
    this.orbitRigid = def.orbitRigid === true;
    /** Orbit SAFETY snap, as a MULTIPLE of `orbitRadius`: if the orbiter ends up further
     * than `orbitSnap × orbitRadius` from its anchor (flung / wedged), it hard-snaps back
     * so it can never get permanently stuck. From the def; 0 = disabled. (e.g. 2 = snap at
     * twice the orbit radius.) */
    this.orbitSnap = def.orbitSnap ?? 0;
    /** Independent self-rotation rate in RADIANS per reference tick (from `def.spin`,
     * given in DEGREES/tick). When non-zero the entity's `angle` (drawn rotation) spins
     * at this constant rate regardless of movement — e.g. a petal whose image rotates on
     * its own. 0 → face the movement heading (the default). */
    this.spin = def.spin != null ? def.spin * (Math.PI / 180) : 0;
    // Ring rate (see `orbit1Speed`) — DEGREES/tick in the def, radians here.
    this.orbit1Speed = def.orbitSpeed != null ? def.orbitSpeed * (Math.PI / 180) : 0;
    /** How deep (world units) this entity rides INTO an enemy while stuck to it — an
     * ORBIT-only stat (from `def.stickDepth`; 0 = sticking disabled, the default).
     * Non-zero makes the orbiter latch onto enemies it hits and glide along their
     * surface at exactly this penetration, so the contact keeps being DETECTED and
     * collision effects (contact damage, `collided`) keep firing while it slides.
     * Clamped to `STICK_DEPTH_MAX_FRACTION` of the collision radius so the petal's
     * CENTER can never be placed at or inside the enemy's surface (which a small petal
     * and a big depth would otherwise do). A safety rail, not a tuning knob — it's
     * loose enough that a sanely-authored depth passes through untouched. */
    this.stickDepth = Math.min(def.stickDepth ?? 0, this.collisionRadius * STICK_DEPTH_MAX_FRACTION);
    /** Max hit points — the def's base `health` × 3 per rarity tier (saved at
     * spawn; the denominator for a health bar). Absent → 0. */
    this.maxHealth = healthAt(def.health, tier);
    /** Current hit points; starts full. `bodyDamage` lowers it, regen raises it,
     * and `checkIfDead` reaps the entity at ≤0 (both opt-in via the def's
     * `collided`/`onUpdate`). Server-authoritative — a client prediction sim
     * doesn't change it (damage/death arrive via snapshots). */
    this.health = this.maxHealth;
    /** Max heading change per reference tick, in RADIANS, for gradual turning
     * toward a target (a mob that pivots instead of snapping). Converted from the
     * def's `turnRate` (DEGREES per tick); `0`/absent → snap instantly (the
     * default, so existing mobs are unchanged). `GameEngine.step` slews
     * `direction` toward the target by `turnRate × fdt` each tick. */
    this.turnRate = def.turnRate != null ? def.turnRate * (Math.PI / 180) : 0;

    /**
     * Collision shape descriptor, or `null` for a plain circle (the common case
     * — uses `collisionRadius` and the fast circle-circle path). When the def
     * supplies an oval it's a per-entity `{ type: "oval", rx, ry, angle }`
     * (rx/ry rarity-scaled above; `angle` = static rotation vs. facing) — a refine
     * over the bounding circle, which stays `collisionRadius`. A POLYGON is
     * `{ type: "polygon", shape, verts }` with local outline `verts` generated
     * per-entity (seeded by `id`). A FRESH object per entity (not the shared
     * def's), because the oval kernel caches rotation on it (`_trigAngle/_cos/_sin`).
     * Assigned here, never bolted on after construction, so the hidden class stays
     * stable.
     * @type {null | { type: string }}
     */
    this.collider = polyGeom
      ? { type: "polygon", shape: poly.shape, verts: polyGeom.verts }
      : oval
        ? { type: "oval", rx, ry, angle: ovalAngle }
        : null;

    /**
     * Data-driven collision behaviour from the def's `collided` block, or null
     * when the def has none (the common case). Read by the collision-response
     * step and `entities/Attributes/Attributes.js` to run attributes / honour resistances
     * when this entity collides. References the shared def object — READ-ONLY.
     * `runOnCollided`/`runOnSelf` items are a bare name or `{ do, ...params }`;
     * `resistance` is names only. See `Attributes.js`.
     * @type {null | { knockback?: boolean|object, runOnCollided?: Array<string|object>, runOnSelf?: Array<string|object>, resistance?: string[] }}
     */
    this.collided = def.collided ?? null;

    // Knockback is TWO-SIDED — `self` = is this entity pushed on contact,
    // `others` = does it push the things it hits — each defaulting true and
    // independent. The def's `knockback` may be omitted (both on), a boolean
    // (both → that value; `false` = a full ghost that neither pushes nor is
    // pushed), or `{ self?, others?, allies? }` for per-side control. `allies`
    // (optional) is whether it pushes ALLIED-disposition victims specifically —
    // absent → same as `others` (push allies like anyone). Precomputed into flags so
    // the hot knockback loop doesn't re-parse `collided` per hit; the loop picks
    // `knockbackAllies` vs `knockbackOthers` by the VICTIM's disposition.
    const kb = this.collided === null ? undefined : this.collided.knockback;
    const kbObj = kb !== null && typeof kb === "object" ? kb : null;
    /** Is this entity shoved when it collides? (`knockback.self`, default true.) */
    this.knockbackSelf = kb === false ? false : kbObj === null ? true : kbObj.self !== false;
    /** Does this entity shove the (non-allied) things it hits? (`knockback.others`, default true.) */
    this.knockbackOthers = kb === false ? false : kbObj === null ? true : kbObj.others !== false;
    /** Does this entity shove ALLIED victims? (`knockback.allies`, default = `others`.) */
    this.knockbackAllies = kb === false ? false
      : kbObj === null ? this.knockbackOthers
      : kbObj.allies !== undefined ? kbObj.allies !== false
      : this.knockbackOthers;

    // Contact damage from `collided.doDamage = { self, other, allies? }` (parallel
    // to knockback). `other` is the body damage this entity deals to NON-allied
    // victims; `allies` (optional) is the damage to victims with the ALLIED
    // disposition — absent → falls back to `other` (allies hurt the same as
    // anyone). `self` is whether DoDamage RUNS on this entity (is it vulnerable).
    // On a hit, the victim loses the attacker's amount (picked by the victim's
    // disposition) only if the victim's `self` is true. Both amounts scale ×2 per
    // rarity tier like `other`. Precomputed so the hot collision loop doesn't
    // re-parse. Absent block → deals nothing, takes nothing.
    const dd = this.collided === null ? undefined : this.collided.doDamage;
    const otherBase = dd != null && typeof dd.other === "number" ? dd.other : 0;
    const alliesBase = dd != null && typeof dd.allies === "number" ? dd.allies : otherBase;
    const dmgScale = damageScaleAt(tier);
    /** Body damage dealt to NON-allied victims (`doDamage.other`, rarity-scaled). */
    this.contactDamage = otherBase * dmgScale;
    /** Body damage dealt to ALLIED-disposition victims (`doDamage.allies`, or
     * `other` if that field is omitted; rarity-scaled). */
    this.contactDamageAllies = alliesBase * dmgScale;
    /** Is this entity affected by contact damage? (`doDamage.self`, default false.) */
    this.damageable = dd != null && dd.self === true;
    /** Does it take contact damage from ALLIED-disposition attackers? (`doDamage.fromAllies`,
     * default true.) Set false for a petal so its own player/teammates can't hurt it while
     * it still takes ENEMY damage — the victim-side mirror of `knockbackSelf` blocking push,
     * but disposition-aware. */
    this.takesAllyDamage = dd == null ? true : dd.fromAllies !== false;


    /**
     * Attribute names run when this entity dies (the def's top-level `onDeath`
     * list, or null). Fired by `destroy` (not `demolish`) before removal — e.g.
     * explode, drop loot, spawn children. Items are a bare name or
     * `{ do, ...params }`. References the shared def array — READ-ONLY. Resolved
     * through `entities/Attributes/Attributes.js`.
     * @type {null | Array<string|object>}
     */
    this.onDeath = def.onDeath ?? null;

    /**
     * Attribute entries run every sim tick on this entity (the def's top-level
     * `onUpdate` list, or null) — per-tick self logic like regen, status timers,
     * or `checkIfDead`. Fired by `GameEngine.step` over the simulated active set.
     * Items are a bare name or `{ do, ...params }`. Shared def array — READ-ONLY.
     * @type {null | Array<string|object>}
     */
    this.onUpdate = def.onUpdate ?? null;

    /**
     * Attribute entries run when this PETAL loads into its owner's orbit (the def's
     * top-level `onLoad` list, or null) — fired by `mechanics/petalManagement`'s
     * `reloadPetals` via `runOnLoad`, with the OWNER passed as the attribute's `source`.
     * Items are a bare name or `{ do, ...params }`. Shared def array — READ-ONLY.
     *
     * Fires on every load, INCLUDING a reload after death: it means "this petal just
     * entered the world", not "the player equipped this".
     * @type {null | Array<string|object>}
     */
    this.onLoad = def.onLoad ?? null;

    /**
     * Set once this entity has been destroyed/demolished (removed from the world).
     * The sim loops skip a `dead` entity so it isn't re-indexed, and `destroy`/
     * `demolish` short-circuit on it (idempotent). Declared here so the hidden
     * class is stable.
     */
    this.dead = false;

    /**
     * The entity's Pixi display object. Null until the view builds it on first
     * sight, then cached here. Declared up front so the hidden class is stable.
     */
    this.display = null;

    /**
     * The entity's floating health-bar Pixi object, or null. The view builds it on
     * first sight for any entity with `maxHealth > 0`; torn down with the display.
     * Declared up front for hidden-class stability. (View-only, like `display`.)
     */
    this.healthBar = null;

    /**
     * Which {@link World} this entity currently lives in (its `id`), or null until
     * placed. Set by `World.add`; a player's `worldId` IS its "which world" state —
     * a transfer changes it (move between grids) and the camera/terrain follow.
     */
    this.worldId = null;
  }

  /**
   * Run an arbitrary function "on" this entity without the entity owning it —
   * the hook the data-driven collision attributes (see `entities/Attributes/Attributes.js`)
   * use to act on an entity the def only named by string. The function is called
   * as `fn(this, ...args)`; any throw is caught and logged so one misbehaving
   * attribute can't abort the whole collision sweep.
   *
   * (Off the hot path for the vast majority of entities — only invoked for ones
   * whose def has a `collided` block — so the rest-arg spread here is fine.)
   *
   * @param {(self: Entity, ...args: any[]) => any} fn The function to run.
   * @param {...any} args Extra arguments passed after `this`.
   * @returns {any} the function's return value, or undefined if it threw or `fn`
   *   wasn't a function.
   */
  runFunction(fn, ...args) {
    if (typeof fn !== "function") return undefined;
    try {
      return fn(this, ...args);
    } catch (err) {
      console.error(`Entity#${this.id} (${this.defId}) runFunction threw:`, err);
      return undefined;
    }
  }

  // MARK: - Parenting

  /**
   * Attach this entity to `parent` (or detach with `null`), keeping BOTH sides of the
   * link consistent: it leaves any previous parent's `children` and joins the new
   * one's. Idempotent when the parent is unchanged (so the client can call it every
   * snapshot). Chainable.
   * @param {Entity|null} parent The new parent, or null to detach.
   */
  setParent(parent) {
    if (parent === this.parent) return this;
    if (this.parent) this.parent.children.delete(this);
    this.parent = parent;
    if (parent) parent.children.add(this);
    return this;
  }

  // MARK: - Lifecycle

  /**
   * Destroy this entity — the full "something killed it" path:
   *   1. run its `onDeath` attributes (explode / drop loot / spawn children…),
   *      each via `runFunction` so a throw is logged, not fatal;
   *   2. CASCADE-destroy its attached `children` (a flower's petals die with it);
   *   3. remove it from the spatial `grid` so collision / AI / the view stop
   *      seeing it;
   *   4. tear down its display and flag it `dead`.
   *
   * **Idempotent** — a second call (including one re-entered from an `onDeath`
   * effect) is a no-op. Pass the grid the entity lives in: the engine keeps
   * `Entity` decoupled from world state, so the grid is handed in (like
   * `moveTo` / `spawn`), not reached for. JS can't truly free an object — this
   * drops everything the entity itself holds (grid entry, display) and sets
   * `dead`; **external** references (a spawner's array, the inputs registry) are
   * the caller's to drop, with `dead` as the signal.
   *
   * **`fade` changes the TEXTURE only.** Everything that makes the entity part of
   * the game — its grid entry, links, health bar, `dead` flag — is gone the moment
   * this returns, exactly as with `fade: 0`. What lingers is a sprite frozen at the
   * death position, dissolving over `fade` sim ticks (see {@link tickFades}) so a
   * kill doesn't just pop out of existence. It can't be collided with, targeted,
   * damaged, or picked up while it fades: as far as the sim is concerned it is
   * already gone.
   *
   * @param {import("../memory/SpatialGrid.js").SpatialGrid} [grid] World index to
   *   remove from. Omit for an entity that was never inserted.
   * @param {number} [fade=0] Sim ticks to dissolve the sprite over. 0 (the default)
   *   frees it immediately — the original behaviour, so a bare `destroy()` is
   *   unchanged. Ignored when there's no sprite to fade or no `grid` to tick against
   *   (a headless run), which free immediately instead of leaking the entry.
   */
  destroy(grid, fade = 0) {
    if (this.dead) return;
    // Latch `dead` BEFORE running onDeath, so a destroy() re-entered from an
    // onDeath effect hits the guard above — onDeath fires exactly once.
    this.dead = true;
    // No onDeath attributes on the client: death is decided server-side and arrives
    // as an entity dropping out of the snapshot. The client's job is to stop drawing
    // it, which is all `_teardown` below does. (The SERVER copy of this file runs the
    // full `runOnDeath` — the two engines are deliberately separate now.)
    // Cascade to attached children (petals die with their flower). `destroy` so each
    // runs its own onDeath; the `dead` guard above stops any re-entry loop. Iterate a
    // copy — each child's teardown removes itself from `this.children`. Children fade
    // on the same schedule, so a flower and its petals dissolve together.
    if (this.children.size) for (const child of [...this.children]) child.destroy(grid, fade);
    this._teardown(grid, fade);
  }

  /**
   * Remove this entity WITHOUT running `onDeath` — a silent teardown (culled out
   * of bounds, replaced, hot-swapped, …). Otherwise identical to `destroy`:
   * removes from the grid, tears down the display, flags `dead`. Idempotent.
   * @param {import("../memory/SpatialGrid.js").SpatialGrid} [grid]
   */
  demolish(grid) {
    if (this.dead) return;
    this.dead = true;
    this._teardown(grid);
  }

  /**
   * Shared removal: grid → display. `dead` is already latched by the caller
   * (`destroy`/`demolish`) before this runs, so the sim loops skip the entity
   * instead of re-indexing it into the grid via `moveTo`. @private
   * @param {import("../memory/SpatialGrid.js").SpatialGrid} [grid]
   * @param {number} [fade=0] Ticks to dissolve the sprite over instead of freeing it
   *   now. Everything else here is torn down regardless — see {@link Entity#destroy}.
   */
  _teardown(grid, fade = 0) {
    if (grid) grid.remove(this);
    // Sever parent links so nothing keeps a dead reference. Detach from our parent,
    // and orphan any remaining children (cascade already ran in `destroy`; on a silent
    // `demolish` we just drop the links — the child re-resolves next snapshot).
    if (this.parent) { this.parent.children.delete(this); this.parent = null; }
    if (this.children.size) {
      for (const child of this.children) if (child.parent === this) child.parent = null;
      this.children.clear();
    }
    // Drop our own stick link too. The reverse direction (someone stuck TO us) isn't
    // indexed, so it's cleared lazily instead: `MOVEMENT.orbit` releases as soon as it
    // sees a dead target, which costs nothing and avoids maintaining a second set.
    this.stick = null;
    // The TEXTURE is the one thing a fade holds back. Everything above is already
    // gone; here we either free the sprite now (the default) or hand it to
    // `tickFades` to dissolve. Either way the health BAR goes immediately — a bar
    // floating under a corpse reads as "still alive", which is the opposite of what
    // the fade is for.
    const canFade = fade > 0 && grid != null && this.display !== null && !this.display.destroyed;
    if (!canFade) { this._freeVisuals(); return; }
    this._freeHealthBar();
    // Flag the sprite so the view's cull pass leaves it alone: it's no longer in the
    // grid, so it won't appear in any frame's visible set, and the pass would
    // otherwise hide it on the very next frame — fading something invisible.
    this.display._fading = true;
    _fading.push({ entity: this, grid, left: fade, total: fade });
  }

  /**
   * Destroy + drop this entity's Pixi view objects (display + floating health bar)
   * if any. Duck-typed and headless-safe: a headless run never sets them (the view
   * does, on first sight), so this no-ops there; the view guards its cull pass
   * against destroyed objects. Used by `_teardown` (death) and `setRarity` (so the
   * view rebuilds them at the new size/shape/rarity). @private
   */
  _freeVisuals() {
    const d = this.display;
    if (d !== null) {
      if (typeof d.removeFromParent === "function") d.removeFromParent();
      if (typeof d.destroy === "function") d.destroy({ children: true });
      this.display = null;
    }
    this._freeHealthBar();
  }

  /**
   * Drop just the floating health bar. Separate from {@link Entity#_freeVisuals}
   * because it's a separate Pixi object in the world (not a child of `display`) and
   * a fading death frees it on its own schedule — immediately, while the sprite is
   * still dissolving. @private
   */
  _freeHealthBar() {
    const hb = this.healthBar;
    if (hb !== null) {
      if (typeof hb.removeFromParent === "function") hb.removeFromParent();
      if (typeof hb.destroy === "function") hb.destroy({ children: true });
      this.healthBar = null;
    }
  }

  /**
   * Change rarity at runtime, re-deriving every rarity-dependent stat for the new
   * tier (collider, `collisionRadius`, `density`, `speed`, `range`, `maxHealth`,
   * contact damage) and dropping the cached visuals so the view rebuilds them at
   * the new size/shape/rarity (the bar also re-tints to the rarity color). Current
   * `health` is kept, only clamped down if it now exceeds the new max — heal
   * explicitly (`health = maxHealth`) after an upgrade for a top-up. No-op if the
   * rarity is unchanged.
   *
   * Only reassigns EXISTING fields, so the hidden class is unaffected. **Mirrors
   * the rarity derivation in the constructor — keep the two in sync.**
   * @param {string} rarity One of the {@link Rarity} strings.
   */
  setRarity(rarity) {
    if (rarity === this.rarity) return;
    const def = entityDef(this.defId);
    const tier = rarityTier(rarity);
    const scale = rarityScaleAt(def, tier);
    this.rarity = rarity;

    // Collider — oval rx/ry rescale; a polygon outline regenerates at the new
    // rarity-scaled radius (same `id` seed → same shape, just bigger/smaller).
    const oval = def.collider != null && def.collider.type === "oval" ? def.collider : null;
    const rx = oval ? oval.rx * scale : 0;
    const ry = oval ? oval.ry * scale : 0;
    const ovalAngle = oval ? (oval.angle ?? 0) : 0;
    const poly = def.collider != null && def.collider.type === "polygon" ? def.collider : null;
    const polyGeom = poly ? makeGeometry(poly.shape, def.size * scale, this.id) : null;
    this.collisionRadius = polyGeom ? polyGeom.boundingRadius : oval ? Math.max(rx, ry) : def.size * scale;
    this.collider = polyGeom
      ? { type: "polygon", shape: poly.shape, verts: polyGeom.verts }
      : oval
        ? { type: "oval", rx, ry, angle: ovalAngle }
        : null;

    this.density = densityAt(def.density, tier);
    this.speed = speedAt(def.speed, tier);
    this.range = this.collisionRadius * def.rangeMult;
    // Re-clamp against the NEW collision radius (the depth itself is rarity-independent).
    this.stickDepth = Math.min(def.stickDepth ?? 0, this.collisionRadius * STICK_DEPTH_MAX_FRACTION);

    this.maxHealth = healthAt(def.health, tier);
    if (this.health > this.maxHealth) this.health = this.maxHealth;

    const dd = this.collided === null ? undefined : this.collided.doDamage;
    const otherBase = dd != null && typeof dd.other === "number" ? dd.other : 0;
    const alliesBase = dd != null && typeof dd.allies === "number" ? dd.allies : otherBase;
    const dmgScale = damageScaleAt(tier);
    this.contactDamage = otherBase * dmgScale;
    this.contactDamageAllies = alliesBase * dmgScale;

    this._freeVisuals(); // view rebuilds display + bar at the new size/shape/rarity
  }

  /**
   * Set the position WITHOUT touching any grid. Use this before the entity is
   * inserted (initial placement / spawning); the grid reads `x`/`y` at insert.
   * @param {number} x
   * @param {number} y
   */
  setPosition(x, y) {
    this.x = x;
    this.y = y;
  }

  /**
   * Move an entity that is already in `grid`, keeping the grid in sync.
   *
   * Sets the new position, then `grid.update(this)` re-indexes it — but only if
   * the move crossed a cell boundary (the grid tracks where each object lives,
   * so a small move that stays in the same cells is a cheap no-op). The grid
   * works off `x`/`y`/`collisionRadius`, so there are no points to rewrite.
   *
   * @param {number} x
   * @param {number} y
   * @param {import("../memory/SpatialGrid.js").SpatialGrid} grid
   */
  moveTo(x, y, grid) {
    this.x = x;
    this.y = y;
    grid.update(this);
  }

  // MARK: - Movement / AI

  /**
   * Add a movement impulse to the entity's `momentum`/`direction` (the "wanting
   * to move" velocity). Polar in, polar out — converts to cartesian, sums, and
   * converts back, so impulses from different directions combine correctly.
   * @param {number} dir Heading of the impulse, in radians.
   * @param {number} magnitude Impulse strength.
   */
  addMovement(dir, magnitude) {
    const vx = this.momentum * Math.cos(this.direction) + magnitude * Math.cos(dir);
    const vy = this.momentum * Math.sin(this.direction) + magnitude * Math.sin(dir);
    this.momentum = Math.hypot(vx, vy);
    this.direction = Math.atan2(vy, vx);
  }

  /**
   * Accumulate knockback (cartesian), kept separate from intended movement.
   * @param {number} x
   * @param {number} y
   */
  addKnockback(x, y) {
    this.knockbackX += x;
    this.knockbackY += y;
  }

  /**
   * Decay residual intended movement: zero it below `threshold` (so tiny drift
   * stops), otherwise scale by `factor` (friction/coast-to-stop).
   * @param {number} threshold
   * @param {number} factor
   */
  decayMovement(threshold, factor) {
    if (this.momentum < threshold) this.momentum = 0;
    else this.momentum *= factor;
  }

}
