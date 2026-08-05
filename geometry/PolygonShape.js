// PolygonShape — draw a filled polygon with an INNER border, from a local-space vertex
// list. Extracted because three things need the identical look: world entities with a
// polygon collider (rocks, petals), the HUD's petal containers, and the petal drawn
// inside a container. Keeping one implementation is what makes a container in the
// hotbar and one standing in the world actually match.
//
// The border trick: Pixi strokes straddle the path (half of the width falls outside
// it), which would put pixels past the collision edge. So we stroke at 2× the width and
// mask to the polygon, leaving exactly the inner half.

import { darken } from "./Colors.js";
import { rarityColor } from "./RarityColors.js";

/** Fill used when a visual block names none. @private */
const DEFAULT_FILL = "#808080";
/** Border width as a fraction of the diameter, when the visual gives no explicit one. @private */
const DEFAULT_STROKE_SCALE = 0.05;
/** How much darker a derived border is than its fill. @private */
const BORDER_DARKEN = 0.2;

/**
 * Build a filled, inner-bordered polygon.
 *
 * @param {{x:number,y:number}[] | null} verts Outline in LOCAL space (relative to the
 *   shape's center). Null/empty falls back to a circle of `radius`, so a caller with a
 *   non-polygon collider still gets something sensible rather than nothing.
 * @param {number} radius Bounding radius. Only used to scale the border (and for the
 *   circle fallback) — the outline itself comes from `verts`.
 * @param {{fill?: string|number, stroke?: string|number, strokeWidth?: number,
 *   strokeScale?: number, fillFromRarity?: boolean}} [visual] An entity def's `visual`
 *   block (or a subset). `strokeScale` is the border width as a fraction of the diameter;
 *   `strokeWidth` is an absolute override. An absent `stroke` is derived as a darker
 *   shade of the fill. `fillFromRarity` swaps the flat `fill` for the RARITY's color
 *   (see below).
 * @param {string} [rarity] The drawn entity's rarity. Only read when the visual sets
 *   `fillFromRarity`; omit it (a HUD slot with nothing in it) and the flat `fill` stands.
 * @returns {any} A `PIXI.Container` (origin-centered) holding the graphics, plus the
 *   mask when there's a border.
 */
export function polygonGraphic(verts, radius, visual = {}, rarity) {
  const container = new PIXI.Container();
  // `fillFromRarity` is for shapes whose color IS their rarity — a petal container on
  // the ground is green for a common drop and purple for an epic one. Resolved here, in
  // the one place a visual block becomes pixels, so the world entity and the HUD slot
  // can't drift apart. The border follows automatically: it's derived from the fill.
  const fill = visual.fillFromRarity === true && rarity != null
    ? rarityColor(rarity)
    : visual.fill ?? DEFAULT_FILL;

  // Flat point list once, reused for fill, stroke, and mask.
  let pts = null;
  if (verts && verts.length > 0) {
    pts = [];
    for (let i = 0; i < verts.length; i++) pts.push(verts[i].x, verts[i].y);
  }
  const trace = (gfx) => (pts ? gfx.poly(pts) : gfx.circle(0, 0, radius));

  const border =
    visual.strokeWidth != null ? visual.strokeWidth : radius * 2 * (visual.strokeScale ?? DEFAULT_STROKE_SCALE);

  /** Draw the body at `color` — fill, then the derived border. Split out so
   * {@link polygonGraphic~setRarity} can repaint without rebuilding the shape. @private */
  const paint = (g, color) => {
    g.clear();
    trace(g);
    g.fill(color);
    if (border > 0) {
      const stroke = visual.stroke ?? darken(color, BORDER_DARKEN);
      // Stroke at 2× so the inner half equals `border`; the mask clips the outer half
      // (and anything past the outline) away.
      trace(g);
      g.stroke({ color: stroke, width: border * 2 });
    }
  };

  const g = new PIXI.Graphics();
  paint(g, fill);

  /**
   * Repaint for a different rarity — the same mapping the constructor used, so a shape
   * recolored later is indistinguishable from one built at that rarity.
   *
   * Exists because a HUD slot's rarity changes while the node lives: the hotbar arrives
   * from snapshots, so the slot that was common last frame can be epic this one. The
   * grid of slot nodes is built once and repainted, rather than destroyed and rebuilt.
   *
   * A no-op unless the color actually changes, so it's cheap to call every frame. Only
   * meaningful when the visual set `fillFromRarity`; otherwise the flat fill stands and
   * this does nothing.
   *
   * @param {string} nextRarity @returns {any} the container, for chaining.
   */
  container.setRarity = (nextRarity) => {
    if (visual.fillFromRarity !== true || nextRarity == null) return container;
    const next = rarityColor(nextRarity);
    if (next === container.paintedFill) return container;
    container.paintedFill = next;
    paint(g, next);
    return container;
  };
  /** The fill currently painted, so `setRarity` can skip redundant repaints. */
  container.paintedFill = fill;

  if (border > 0) {
    const mask = new PIXI.Graphics();
    trace(mask).fill(0xffffff);
    container.addChild(g, mask);
    g.mask = mask;
  } else {
    container.addChild(g);
  }
  return container;
}
