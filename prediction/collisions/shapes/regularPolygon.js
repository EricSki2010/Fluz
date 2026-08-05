// regularPolygon — the shared builder behind every FIXED (non-procedural) shape in this
// folder. A regular n-gon with its vertices on the radius circle, which is the same
// reading of `radius` the procedural generators use (rock's spokes vary around it), so
// `boundingRadius` always comes out exactly `radius`.
//
// Not registered as a shape itself — the registry's contract is `(radius, seed)`, with
// no room for a vertex count, so each concrete shape is a thin named wrapper around
// this (see petalContainer.js). The petal-drawing registry in VisualEngine uses it too.

/**
 * Build a regular polygon's outline.
 * @param {number} sides How many vertices (3 = triangle, 4 = square, 5 = pentagon…).
 * @param {number} radius Distance from the center to each VERTEX.
 * @param {number} [firstAngle=0] Angle of the first vertex, in radians. Rotates the
 *   whole shape — e.g. `-π/2` puts a point straight up, `π/4` makes a 4-gon read as an
 *   axis-aligned square rather than a diamond.
 * @returns {{ verts: {x:number,y:number}[], boundingRadius: number }} `verts` are local
 *   (relative to the center) and ordered by angle.
 */
export function regularPolygon(sides, radius, firstAngle = 0) {
  const step = (Math.PI * 2) / sides;
  const verts = [];
  for (let i = 0; i < sides; i++) {
    const ang = firstAngle + i * step;
    verts.push({ x: Math.cos(ang) * radius, y: Math.sin(ang) * radius });
  }
  return { verts, boundingRadius: radius };
}
