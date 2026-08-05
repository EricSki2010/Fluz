// PetalContainer — a petal-container square, plus the petal drawn inside it.
//
// The outline is NOT hand-drawn here: it comes from the engine's `petalContainer`
// collision geometry (`makeGeometry`), the same generator the world entity uses. So a
// container in the hotbar and a container standing in the world are literally the same
// square, and reshaping the generator reshapes both. (UI → GameEngine is the allowed
// dependency direction; the reverse isn't.)
//
// Colors come from the `petalContainer` entity def's `visual` block when it's loaded,
// so the def stays the single place a container's look is authored. Falls back to
// built-in values when the registry hasn't loaded (or the def was removed), since a
// HUD piece must never be the thing that throws.
//
// The def opts into `fillFromRarity`, so a container is colored by the RARITY it carries
// — green for a common drop, purple for an epic one — with the flat `fill` standing in
// when no rarity is given (an empty HUD slot). A container's rarity describes the petal
// INSIDE it, which is why the box is the thing that shows it.
//
// A HELD PETAL is drawn as a plain nested graphic on top — NOT a child entity. It has no
// position, collider, or sim presence of its own. Its shape comes from the PETAL
// registry (`ui/petals/`), which is separate from entity collision geometry on purpose:
// how a rock collides and how a rock is drawn are different questions.
//
// A STACK of more than one wears a right-tilted "3x" badge in the top-right corner
// (`countBadge`). Same idea: a container holding three is still ONE container with one
// collider — the count is a number it carries, and the badge is the only thing that
// changes on screen.
//
// Origin-centered like `button`, so place it by setting `.x`/`.y`. Reads game state,
// never mutates it.

import { makeGeometry } from "../prediction/collisions/shapes/index.js";
import { entityDef, hasEntityDef } from "../entities/EntityRegistry.js";
import { makePetalShape } from "./petals/index.js";
import { polygonGraphic } from "./PolygonShape.js";

/** The def whose geometry + visual this mirrors. */
const DEF_ID = "petalContainer";
/** Used only when the def isn't registered — see the module header. @private */
const FALLBACK = { fill: "#4a6fa5", strokeScale: 0.08 };

/** Held petal's drawn radius, as a fraction of the container's. Deliberately a FRACTION
 * of the container rather than the petal def's own `size`: the inset is an emblem, not a
 * to-scale model, so it fits any container/petal size pairing without tuning. @private */
const PETAL_INSET_FRACTION = 0.44;

/** Smallest stack size that wears a badge. A container holds one by default, so drawing
 * "1x" on every ordinary one would be pure noise — the badge means "more than one". */
export const COUNT_BADGE_MIN = 2;

/** Badge geometry + look, all as fractions of the container's SIDE so a HUD slot, a
 * 30%-smaller secondary slot and a world container all wear the same-looking badge.
 * `TILT` turns the WHOLE label as one rigid piece (radians, POSITIVE = clockwise on
 * screen, so the label runs downhill to the right). Not a shear: the letterforms stay
 * upright relative to each other rather than being slanted individually. @private */
const COUNT_FONT_FRACTION = 0.33;
const COUNT_INSET_FRACTION = 0.05;
const COUNT_TILT = 0.3;
/** Final nudge off the corner the placement math lands on — up and to the right, again
 * as fractions of the side. Tuned by eye: a badge kept strictly inside the outline reads
 * as floating in the square rather than sitting ON its corner, so this pushes it out to
 * ride the edge. @private */
const COUNT_NUDGE_X = 0.05;
const COUNT_NUDGE_Y = 0.08;
/** Badge text color + its outline, and the outline's width as a fraction of the font
 * size — the badge sits on top of both the container and the petal emblem, so it needs
 * its own contrast rather than borrowing the container's. @private */
const COUNT_FILL = 0xffffff;
const COUNT_STROKE = 0x000000;
const COUNT_STROKE_FRACTION = 0.16;

/** The def's `visual` block, or the fallback if the registry can't answer. @private */
function containerVisual() {
  return hasEntityDef(DEF_ID) ? (entityDef(DEF_ID).visual ?? FALLBACK) : FALLBACK;
}

/**
 * Draw the emblem for a held petal — the petal's own shape + colors, sized to sit
 * inside a container of `containerRadius`. Returns null for an empty slot or a petal
 * this client can't draw, so callers just skip adding a child.
 *
 * The shape comes from the PETAL registry (`ui/petals/`), not from the petal's entity
 * def or collider. That's the separation: an entity's geometry answers "how does this
 * collide", a petal's answers "how does this draw", and a rock wants different answers
 * to those (a lumpy id-seeded boulder vs. one fixed pentagon every icon shares).
 *
 * Not an entity either way: no position, no collider, no place in the sim.
 *
 * @param {string|null} petalDefId A petal def id (e.g. `"rock_petal"`), or null.
 * @param {number} containerRadius The container's bounding radius.
 * @param {number} [seed=0] Seed for petals with procedural variation; fixed shapes
 *   ignore it.
 * @returns {any|null} A `PIXI.Container` (origin-centered), or null.
 */
export function petalEmblem(petalDefId, containerRadius, seed = 0) {
  const radius = containerRadius * PETAL_INSET_FRACTION;
  const shape = makePetalShape(petalDefId, radius, seed);
  if (shape === null) return null;
  return polygonGraphic(shape.verts, shape.boundingRadius, shape.visual ?? {});
}

/**
 * Draw the "3x" stack badge for a container holding more than one — a right-tilted label
 * tucked into the square's TOP-RIGHT corner.
 *
 * Returns null below {@link COUNT_BADGE_MIN} (which is the common case: one petal, no
 * badge), so callers just skip adding a child. Nothing here is a separate entity or slot
 * — a stack of three is still one container; only the label says otherwise.
 *
 * The label is ROTATED as one rigid piece, not sheared and not set in italic: the text
 * keeps its normal upright shapes and the whole thing is simply turned. Everything scales
 * off the container's side, so the badge is proportional at any slot size.
 *
 * @param {number} count How many the container stands for.
 * @param {number} containerRadius The container's bounding (corner) radius — the same
 *   number the square's geometry is built from.
 * @returns {any|null} A `PIXI.Text` positioned in the corner, or null when there's
 *   nothing worth labelling.
 */
export function countBadge(count, containerRadius) {
  if (!(count >= COUNT_BADGE_MIN)) return null; // also rejects NaN/undefined
  const side = containerRadius * Math.SQRT2; // corners sit on the radius circle
  const fontSize = side * COUNT_FONT_FRACTION;
  const text = new PIXI.Text({
    text: `${Math.round(count)}x`,
    style: {
      fill: COUNT_FILL,
      fontSize,
      fontFamily: "system-ui, sans-serif",
      fontWeight: "700",
      stroke: { color: COUNT_STROKE, width: fontSize * COUNT_STROKE_FRACTION },
    },
  });
  // Anchored by its own top-right corner, so it grows down-and-left into the square and
  // a wider number ("12x") can't spill out past the right edge.
  text.anchor.set(1, 0);
  text.rotation = COUNT_TILT;
  // The turn pivots on that same corner, which swings the far (left) end UP by
  // sin(tilt) × the label's width. Drop the whole badge by exactly that, measured rather
  // than guessed, so a tilted "12x" sits under the top edge just like a tilted "3x".
  const lift = Math.sin(COUNT_TILT) * (text.width || 0);
  const inset = side * COUNT_INSET_FRACTION;
  text.x = side / 2 - inset + side * COUNT_NUDGE_X;
  text.y = -side / 2 + inset + lift - side * COUNT_NUDGE_Y;
  return text;
}

/**
 * Build one petal-container square, optionally holding a petal.
 *
 * @param {number} side The square's SIDE length in screen px. The geometry generator
 *   takes a corner distance (its `radius`), and the square's corners sit on that
 *   circle, so this converts: `radius = side / √2`.
 * @param {{fill?: string|number, stroke?: string|number, strokeScale?: number,
 *   petal?: string|null, seed?: number, count?: number, rarity?: string}} [opts]
 *   Overrides for the def's visual, plus `petal` (a petal def id to draw inside), its
 *   `seed`, `count` (how many it stands for — see {@link countBadge}), and `rarity`,
 *   which COLORS the square when the def opts into `fillFromRarity`. Omitting `rarity`
 *   leaves the def's flat fill, which is what an empty HUD slot wants.
 * @returns {any} A `PIXI.Container` (origin-centered) with `.slotSide`, `.heldPetal`,
 *   `.heldCount`, and {@link petalContainer~setPetal} / {@link petalContainer~setCount}
 *   for changing what it shows later.
 */
export function petalContainer(side, opts = {}) {
  const visual = containerVisual();
  const radius = side / Math.SQRT2;
  const { verts } = makeGeometry(DEF_ID, radius, 0); // seed unused — the square is fixed

  const container = polygonGraphic(verts, radius, {
    fill: opts.fill ?? visual.fill ?? FALLBACK.fill,
    // The def colors containers BY RARITY; an explicit `fill` override wins over it, so
    // a caller asking for a specific color still gets one.
    fillFromRarity: opts.fill == null && visual.fillFromRarity === true,
    stroke: opts.stroke ?? visual.stroke,
    strokeScale: opts.strokeScale ?? visual.strokeScale ?? FALLBACK.strokeScale,
  }, opts.rarity);

  /** The emblem child currently on top, or null. @private */
  let emblem = null;
  /** The stack badge child, or null when the count doesn't warrant one. @private */
  let badge = null;
  /** Which petal `emblem` was built for. `undefined` until the first `setPetal`, so
   * that call always applies (even when the petal is null). @private */
  container.heldPetal = undefined;

  /**
   * Show a different petal (or `null` for empty), rebuilding the emblem graphic.
   *
   * This is the HUD's counterpart to what a world container does through
   * `_freeVisuals`: the emblem is BAKED into the display when it's built, so a slot
   * whose contents change has to redraw rather than be patched. Cheap to call every
   * frame — it no-ops unless the petal actually differs, so the common case (an
   * unchanged slot) costs one comparison and touches no Pixi objects.
   *
   * @param {string|null} petalDefId A petal def id, or null.
   * @param {number} [seed=0] Seed for a procedural emblem shape. Fixed shapes like
   *   the rock petal ignore it. NOT part of the change check — a slot's seed is stable.
   * @returns {any} the container, for chaining.
   */
  container.setPetal = (petalDefId, seed = 0) => {
    const next = petalDefId ?? null;
    if (next === container.heldPetal) return container; // unchanged → keep the graphic
    container.heldPetal = next;
    if (emblem !== null) {
      container.removeChild(emblem);
      emblem.destroy({ children: true });
      emblem = null;
    }
    // Added last, so it draws over the container. The border mask applies only to the
    // border graphic, not to siblings, so the emblem isn't clipped by it.
    emblem = petalEmblem(next, radius, seed);
    if (emblem !== null) container.addChild(emblem);
    // Re-add the badge so it stays the topmost child (Pixi's `addChild` moves an
    // existing child to the end): the corner label reads over the emblem, not under it.
    if (badge !== null) container.addChild(badge);
    return container;
  };

  /** Which count `badge` was built for. `undefined` until the first `setCount`, so that
   * call always applies. @private */
  container.heldCount = undefined;

  /**
   * Show a different stack size, rebuilding the corner badge. Like
   * {@link petalContainer~setPetal} this is cheap to call every frame — it no-ops unless
   * the count actually differs, and a count below {@link COUNT_BADGE_MIN} just means no
   * badge at all.
   * @param {number} count How many the slot stands for.
   * @returns {any} the container, for chaining.
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
    if (badge !== null) container.addChild(badge); // last → over the emblem
    return container;
  };

  container.setPetal(opts.petal ?? null, opts.seed ?? 0);
  container.setCount(opts.count ?? 1);
  container.slotSide = side;
  return container;
}
