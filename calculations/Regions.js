// Sim regions ("regions of interest") — the rectangles the simulation runs
// inside. Each corresponds to a client's render area; the engine itself is
// headless, so it thinks in regions, not cameras. A tick can have one region
// (single player) or many (one per player), passed to `GameEngine.step`, which
// unions them into a single combined-area sim.
//
// Rectangles are CENTER-based: { x, y, width, height } with (x, y) the center
// (same convention the camera already used). `pointInAnyRegion` is the hot/cold
// LOD test `step` runs against the real render regions.

/**
 * Is point (px, py) inside center-based rect `r` (optionally with a `slack`
 * multiplier on the extents, e.g. 1.05 for a little edge hysteresis)?
 * @param {number} px
 * @param {number} py
 * @param {{x:number,y:number,width:number,height:number}} r
 * @param {number} [slack=1]
 * @returns {boolean}
 */
export function pointInRegion(px, py, r, slack = 1) {
  return (
    Math.abs(px - r.x) <= (r.width * slack) / 2 &&
    Math.abs(py - r.y) <= (r.height * slack) / 2
  );
}

/** Is (px, py) inside ANY of `regions` (with optional `slack`)? */
export function pointInAnyRegion(px, py, regions, slack = 1) {
  for (let i = 0; i < regions.length; i++) {
    if (pointInRegion(px, py, regions[i], slack)) return true;
  }
  return false;
}
