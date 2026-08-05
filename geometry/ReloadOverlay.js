// ReloadOverlay — a black wash over a slot, with a settable amount cut away from the
// bottom up.
//
// Give it a percentage and it removes that much of the square, measured from the BOTTOM
// edge upward: 0 leaves the whole square covered, 100 leaves nothing. What's left is
// always a band anchored to the TOP edge, so the wash recedes downward-to-upward as the
// number climbs.
//
// It draws INSIDE the border, never over it. The border is what tells you a slot is a
// slot — its shape, and (when filled) its rarity — and a state overlay that swallowed it
// would take away the thing you're reading while you wait. So the wash is inset by the
// border width and the slot's outline stays untouched at every value.
//
// Deliberately knows nothing about reloading. It takes a percentage; the caller decides
// what that percentage means. Anything else that needs "part of a slot greyed out" —
// a locked slot, an unaffordable cost — uses the same graphic.

import { makeGeometry } from "../prediction/collisions/shapes/index.js";

/** The engine geometry the wash borrows its outline from — same square as the slot. */
const DEF_ID = "petalContainer";

/** The wash. Black at half strength: dark enough to read as "not ready", light enough
 * that the petal underneath stays identifiable. @private */
const WASH_COLOR = 0x000000;
const WASH_ALPHA = 0.5;

/**
 * Build a reload wash sized to a slot.
 *
 * @param {number} side Side length in screen pixels — the same `side` the slot uses.
 * @param {object} [opts]
 * @param {number} [opts.inset=0] Pixels to pull the wash in from the square's edge, so
 *   it lands inside the slot's border rather than on top of it.
 * @param {number} [opts.removed=0] Starting percentage cut away from the bottom.
 * @returns {any} a PIXI.Container with `setRemoved(percent)` on it.
 */
export function reloadOverlay(side, opts = {}) {
  const inset = opts.inset ?? 0;
  // Shrink the square by the inset, so the wash sits within the border.
  const radius = Math.max(0, side / Math.SQRT2 - inset * Math.SQRT2);
  const { verts } = makeGeometry(DEF_ID, radius, 0); // seed unused — the square is fixed

  const container = new PIXI.Container();

  const pts = [];
  for (let i = 0; i < verts.length; i++) pts.push(verts[i].x, verts[i].y);

  // Half-height of the inset square, which is what the cut is measured against.
  let half = 0;
  for (let i = 0; i < verts.length; i++) half = Math.max(half, Math.abs(verts[i].y));

  const wash = new PIXI.Graphics();
  wash.poly(pts).fill({ color: WASH_COLOR, alpha: WASH_ALPHA });

  // A mask that exposes only the band still covered. Redrawn on every change rather
  // than scaling the wash: scaling would stretch the square's corners, where clipping
  // keeps the visible part the same shape as the slot it sits in.
  const mask = new PIXI.Graphics();
  container.addChild(wash, mask);
  wash.mask = mask;

  /** Last percentage drawn, so a repeat is free. @private */
  let removedPct;

  /**
   * Cut `percent` of the square away, from the bottom edge upward.
   *
   * @param {number} percent 0 = fully covered, 100 = nothing left. Values outside the
   *   range are clamped, so a caller doing `remaining / total * 100` can't produce a
   *   mask taller than the square by being a frame late.
   * @returns {any} the overlay, for chaining.
   */
  container.setRemoved = (percent) => {
    const next = percent <= 0 ? 0 : percent >= 100 ? 100 : percent;
    if (next === removedPct) return container;
    removedPct = next;
    // Height of what SURVIVES, anchored to the top edge.
    const keep = (half * 2) * (1 - next / 100);
    mask.clear();
    // Nothing left → an empty mask hides the wash entirely (Pixi treats a mask with no
    // geometry as "show nothing", which is exactly right here).
    if (keep > 0) mask.rect(-half, -half, half * 2, keep).fill(0xffffff);
    return container;
  };

  container.setRemoved(opts.removed ?? 0);
  return container;
}
