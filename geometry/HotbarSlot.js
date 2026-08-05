// HotbarSlot — the empty frame a hotbar slot is drawn as, plus whatever petal is put
// in it.
//
// SAME SQUARE as a petal container: the outline comes from the engine's `petalContainer`
// collision geometry (`makeGeometry`), so a slot in the hotbar and a container standing
// in the world are literally the same shape, and reshaping the generator reshapes both.
//
// A slot has TWO looks, and which one it wears says whether it holds anything:
//
//   FILLED — painted exactly like the world container: solid, opaque, filled with the
//     rarity's colour and bordered with a darkened shade of it. A petal in your hotbar
//     should look like the same object it is lying on the ground, so this reads the def's
//     own `visual` block rather than restating any of it.
//
//   EMPTY — a recessed translucent well, which is chrome rather than an object:
//       centre   grey at CENTER_ALPHA (60%) — dim and see-through
//       edge     the same grey at EDGE_ALPHA (80%) — brighter than the centre
//       border   near-white at BORDER_ALPHA — brightest, defines the shape
//     Colour and opacity both step UP from the middle outward, so it reads as a lip
//     around a hollow rather than a flat tile.
//
// Only the EMPTY look is translucent. A filled slot is as solid as the thing it holds.
//
// The petal inside and the stack badge are the container's own machinery, reused
// wholesale (`petalEmblem`, `countBadge`) — a petal drawn in a slot and a petal drawn in
// a world container are the same graphic, which is the point.
//
// Origin-centered like `petalContainer`, so place it by setting `.x`/`.y`. Reads game
// state, never mutates it.

// PIXI is a GLOBAL here — index.html loads it from a CDN <script>, and there's no
// importmap, so a bare `import ... from "pixi.js"` would fail to resolve. Same as every
// other drawing module in this tree.
import { makeGeometry } from "../prediction/collisions/shapes/index.js";
import { entityDef, hasEntityDef } from "../entities/EntityRegistry.js";
import { petalEmblem, countBadge } from "./PetalContainer.js";
import { rarityColor } from "./RarityColors.js";
import { reloadOverlay } from "./ReloadOverlay.js";
import { darken } from "./Colors.js";

/** The engine geometry a slot borrows its outline from. @private */
const DEF_ID = "petalContainer";

/** The slot's base grey. Neutral on purpose: the frame is furniture, and anything that
 * carries meaning (the petal, its rarity) is drawn ON it. @private */
const SLOT_GREY = 0x9aa0a6;
/** Border colour — near-white, so the slot's edge is the brightest thing in it. @private */
const SLOT_BORDER = 0xe8eaed;

const CENTER_ALPHA = 0.6;  // hollow middle
const EDGE_ALPHA = 0.8;    // brighter lip inside the border
const BORDER_ALPHA = 0.95; // brightest, defines the shape

/** Edge band thickness, as a fraction of the square's radius. EMPTY slots only. @private */
const EDGE_SCALE = 0.10;
/** Border thickness, as a fraction of the square's radius. EMPTY slots only. @private */
const BORDER_SCALE = 0.07;

/** How much darker a FILLED slot's border is than its fill — the same shade shift
 * `polygonGraphic` derives for a world container, so the two match. @private */
const BORDER_DARKEN = 0.2;
/** Border width fraction used when the container def doesn't state one. @private */
const DEFAULT_STROKE_SCALE = 0.05;
/** Stand-in visual if the registry hasn't loaded — a HUD piece must never be the thing
 * that throws. Mirrors `PetalContainer`'s fallback. @private */
const FALLBACK_VISUAL = { fill: "#4a6fa5", strokeScale: 0.08 };

/** The container def's `visual` block — the single place a container's look is
 * authored, so a filled slot can't drift from the world object. @private */
function containerVisual() {
  return hasEntityDef(DEF_ID) ? (entityDef(DEF_ID).visual ?? FALLBACK_VISUAL) : FALLBACK_VISUAL;
}

/**
 * Build one hotbar slot.
 *
 * @param {number} side Side length in screen pixels (the square's width).
 * @param {object} [opts]
 * @param {string|null} [opts.petal] Petal def id to show immediately, or null for empty.
 * @param {number} [opts.seed=0] Seed for a procedural emblem shape (fixed shapes ignore it).
 * @param {number} [opts.count=1] Stack size — see {@link countBadge}.
 * @param {string} [opts.rarity] Tints the frame when the slot HOLDS something. Omit for
 *   a plain grey well.
 * @returns {any} a PIXI.Container with `setPetal` / `setCount` / `setRarity` on it.
 */
export function hotbarSlot(side, opts = {}) {
  const radius = side / Math.SQRT2;
  const { verts } = makeGeometry(DEF_ID, radius, 0); // seed unused — the square is fixed

  const container = new PIXI.Container();

  // Flat point list once, reused for every pass.
  const pts = [];
  for (let i = 0; i < verts.length; i++) pts.push(verts[i].x, verts[i].y);
  const trace = (gfx) => gfx.poly(pts);

  const edgeWidth = radius * EDGE_SCALE;
  const borderWidth = radius * BORDER_SCALE;

  /** The frame graphic. Repainted (not rebuilt) when the tint changes. @private */
  const frame = new PIXI.Graphics();

  /**
   * Repaint the frame. `tint` is the rarity colour when the slot HOLDS something, or
   * null when it's empty — and the two take different paths on purpose. @private
   */
  const paint = (tint) => {
    frame.clear();
    if (tint !== null) {
      // FILLED: the world container's paint, opaque. Same fill, same darkened border,
      // same stroke width the def asks for — so a petal in the bar and the same petal
      // on the ground are indistinguishable.
      const visual = containerVisual();
      const solidBorder = radius * 2 * (visual.strokeScale ?? DEFAULT_STROKE_SCALE);
      trace(frame);
      frame.fill(tint);
      if (solidBorder > 0) {
        trace(frame);
        frame.stroke({ color: visual.stroke ?? darken(tint, BORDER_DARKEN), width: solidBorder * 2 });
      }
      return;
    }
    // EMPTY: the translucent well — three bands stepping up from the middle out.
    trace(frame);
    frame.fill({ color: SLOT_GREY, alpha: CENTER_ALPHA });
    // Edge band. Stroked INSIDE the outline (the mask clips the outer half away), so it
    // reads as a lip rather than a second outline.
    trace(frame);
    frame.stroke({ color: SLOT_GREY, width: edgeWidth * 2, alpha: EDGE_ALPHA });
    // Border — brightest, drawn last so it sits over the edge band.
    trace(frame);
    frame.stroke({ color: SLOT_BORDER, width: borderWidth * 2, alpha: BORDER_ALPHA });
  };
  paint(opts.rarity != null ? rarityColor(opts.rarity) : null);

  // Clip the outer half of both strokes so the slot's footprint is exactly `side` —
  // otherwise a stroked polygon bleeds half its width past the outline and neighbouring
  // slots would appear to touch.
  const mask = new PIXI.Graphics();
  trace(mask).fill(0xffffff);
  container.addChild(frame, mask);
  frame.mask = mask;

  /** The reload wash, built lazily — most slots never reload while on screen, and a
   * graphic per slot per frame for a state that's usually absent isn't worth it. Sits
   * OVER the petal (it's dimming the petal) but UNDER the count badge (a number you
   * still need to read). @private */
  let wash = null;

  /** The petal graphic currently on top, or null. @private */
  let emblem = null;
  /** The stack badge, or null when the count doesn't warrant one. @private */
  let badge = null;
  /** What `frame` is currently tinted with, so repaints can be skipped. @private */
  let paintedTint = opts.rarity != null ? rarityColor(opts.rarity) : null;

  /** Which petal `emblem` was built for. `undefined` so the first call always applies. */
  container.heldPetal = undefined;
  /** Which count `badge` was built for. @private */
  container.heldCount = undefined;

  /**
   * Put a petal in the slot (or `null` to empty it), rebuilding the emblem.
   *
   * This is the "set the value of a slot and it draws it" entry point. Cheap to call
   * every frame — it no-ops unless the petal actually differs, so an unchanged slot
   * costs one comparison and touches no Pixi objects.
   *
   * @param {string|null} petalDefId @param {number} [seed=0]
   * @returns {any} the slot, for chaining.
   */
  container.setPetal = (petalDefId, seed = 0) => {
    const next = petalDefId ?? null;
    if (next === container.heldPetal) return container;
    container.heldPetal = next;
    if (emblem !== null) {
      container.removeChild(emblem);
      emblem.destroy({ children: true });
      emblem = null;
    }
    // Over the frame. The mask applies to `frame` only, not siblings, so the emblem
    // isn't clipped by it.
    emblem = petalEmblem(next, radius, seed);
    if (emblem !== null) container.addChild(emblem);
    // Restack: the wash dims the petal, so it goes over the emblem; the badge is a
    // number you read regardless, so it stays topmost. (`addChild` moves an existing
    // child to the end.)
    if (wash !== null) container.addChild(wash);
    if (badge !== null) container.addChild(badge);
    return container;
  };

  /**
   * Show a different stack size, rebuilding the corner badge. No-ops when unchanged.
   * @param {number} count @returns {any} the slot, for chaining.
   */
  container.setCount = (count) => {
    const next = count ?? 1;
    if (next === container.heldCount) return container;
    container.heldCount = next;
    if (badge !== null) {
      container.removeChild(badge);
      badge.destroy({ children: true });
      badge = null;
    }
    badge = countBadge(next, radius);
    if (badge !== null) container.addChild(badge);
    return container;
  };

  /**
   * Set the slot's rarity — or `null` to make it read as EMPTY.
   *
   * This is what switches between the two looks: a rarity paints the solid world-container
   * fill, `null` paints the translucent well. So the caller only has to say what the slot
   * holds; how that looks is decided here. No-ops unless the colour actually changes.
   *
   * @param {string|null} rarity @returns {any} the slot, for chaining.
   */
  container.setRarity = (rarity) => {
    const next = rarity != null ? rarityColor(rarity) : null;
    if (next === paintedTint) return container;
    paintedTint = next;
    paint(next);
    return container;
  };

  /**
   * Show a reload wash over the slot, or `null` to clear it.
   *
   * `percent` is how much of the square is CUT AWAY from the bottom up — so 100 shows
   * nothing and 0 covers the whole slot. See `ReloadOverlay.js`; the meaning of the
   * number is the caller's to decide.
   *
   * Inset by the slot's border so the outline is never covered: a slot mid-reload still
   * reads as a slot, and a filled one still shows its rarity on the edge.
   *
   * @param {number|null} percent @returns {any} the slot, for chaining.
   */
  container.setReload = (percent) => {
    if (percent == null) {
      if (wash !== null) { container.removeChild(wash); wash.destroy({ children: true }); wash = null; }
      return container;
    }
    if (wash === null) {
      // Inset by whichever border this slot is currently wearing — the filled look and
      // the empty well use different widths.
      const visual = containerVisual();
      const filledBorder = radius * 2 * (visual.strokeScale ?? DEFAULT_STROKE_SCALE);
      const edge = paintedTint !== null ? filledBorder : borderWidth;
      wash = reloadOverlay(side, { inset: edge });
      container.addChild(wash);
      // Keep the badge on top — `addChild` moves an existing child to the end.
      if (badge !== null) container.addChild(badge);
    }
    wash.setRemoved(percent);
    return container;
  };

  container.setPetal(opts.petal ?? null, opts.seed ?? 0);
  container.setCount(opts.count ?? 1);
  return container;
}
