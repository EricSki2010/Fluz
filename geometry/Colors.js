// Colors — tiny color math shared by anything that draws. Kept in `ui/` (rather than
// inside one drawing module) because the same derivation is needed in two places: the
// view's entity polygons and the HUD's petal containers, which must come out looking
// identical. Imports nothing, so it can't create a cycle.

/**
 * Darken a color by `frac` (0..1) per channel — used to derive a shape's border from
 * its fill (e.g. a 20%-darker edge). Accepts anything `PIXI.Color` parses (CSS hex
 * string, number); returns a 24-bit number.
 * @param {string|number} color @param {number} frac @returns {number}
 */
export function darken(color, frac) {
  const n = new PIXI.Color(color).toNumber();
  const k = 1 - frac;
  const r = Math.round(((n >> 16) & 0xff) * k);
  const g = Math.round(((n >> 8) & 0xff) * k);
  const b = Math.round((n & 0xff) * k);
  return (r << 16) | (g << 8) | b;
}
