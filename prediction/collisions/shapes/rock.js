// rock — procedural collision geometry for the rock entity.
//
// A rock's shape is a lumpy ring of vertices around the entity's center: each
// spoke sits at a roughly-even angle with a jittered length, so no two rocks look
// alike. It's a polygon collider (a "triangle set" fan from the center, see
// Collisions._polygonContact), NOT a circle — that's why it can't live in
// rock.json: the shape is GENERATED with random variation, which static JSON
// can't express.
//
// DETERMINISM: the randomness is seeded by the entity's `id` (network-stable —
// the server assigns it and the client rebuilds the entity with the same id from
// each snapshot). So the server and every client independently generate the
// IDENTICAL rock — the shape never has to be sent over the wire, yet collision
// (server) and rendering (client) agree. Never seed this from a wall clock or an
// unsynced counter, or the client's rock would drift from the server's.
//
// Lives on the GameEngine side so the headless server owns its own physics
// shapes; the renderer may import this geometry (renderer → engine is the allowed
// dependency direction).

/** Vertices ordered by angle around the local origin (the jitter below stays
 * under half the spoke spacing, so they never reorder → a simple, non-self-
 * intersecting ring). The narrowphase uses a closest-feature test that handles
 * any simple polygon, so concave dents are fine; ordering just keeps the outline
 * clean for rendering. */
const MIN_SPOKES = 7;
const MAX_SPOKES = 10;
const RAD_MIN = 0.78; // shortest spoke as a fraction of the base radius
const RAD_MAX = 1.22; // longest spoke
const ANG_JITTER = 0.4; // angular wobble, as a fraction of the spoke spacing (<0.5)

/**
 * Deterministic RNG (mulberry32) — same seed → same stream, on any machine. A
 * tiny self-contained generator so the geometry doesn't depend on (and can't be
 * desynced by) the global `Math.random`.
 * @param {number} seed @returns {() => number} next float in [0, 1)
 * @private
 */
function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generate a rock's collision outline.
 * @param {number} radius Base radius (the rarity-scaled `def.size`); spokes vary
 *   around it by RAD_MIN..RAD_MAX.
 * @param {number} seed Per-entity seed — pass the entity `id` so server & client
 *   agree (see the determinism note above).
 * @returns {{ verts: {x:number,y:number}[], boundingRadius: number }}
 *   `verts` are local (relative to the entity center), ordered by angle;
 *   `boundingRadius` is the longest spoke, so a bounding circle of that radius
 *   encloses the whole shape (broadphase + the narrowphase bounds gate).
 */
export function generateRock(radius, seed) {
  const rand = mulberry32(seed);
  const spokes = MIN_SPOKES + Math.floor(rand() * (MAX_SPOKES - MIN_SPOKES + 1));
  const step = (Math.PI * 2) / spokes;
  const verts = [];
  let boundingRadius = 0;
  for (let i = 0; i < spokes; i++) {
    // Jitter stays within ±ANG_JITTER·step (<half the spacing), so the spokes
    // never reorder — the ring stays star-shaped.
    const ang = i * step + (rand() - 0.5) * step * (ANG_JITTER * 2);
    const rad = radius * (RAD_MIN + rand() * (RAD_MAX - RAD_MIN));
    if (rad > boundingRadius) boundingRadius = rad;
    verts.push({ x: Math.cos(ang) * rad, y: Math.sin(ang) * rad });
  }
  return { verts, boundingRadius };
}
