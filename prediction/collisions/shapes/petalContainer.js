// petalContainer — collision geometry for the petal container: a plain square.
//
// Unlike `rock`, there is NO randomness here. A container is a frame, not a creature:
// every one is identical, so `seed` is ignored (the parameter stays for the shared
// generator contract — see rock.js). That also makes it trivially deterministic across
// server and client, which is the property the seeding in rock.js exists to buy.
//
// The square's CORNERS sit on the `radius` circle, matching how every other generator
// reads `radius` (rock's spokes vary around it, ladybug's ring sits on it). So
// `boundingRadius` comes out exactly `radius`, and an entity's `collisionRadius` stays
// exactly its def `size`. The side length is therefore `radius × √2` — if you want
// `size` to mean the half-side instead, scale by SQRT1_2 here and return
// `radius * Math.SQRT2` as the bounding radius.
//
// COLOR lives in the def's `visual` block, not here: this module is on the GameEngine
// side (the headless server owns its physics shapes) and only ever produces collision
// verts. The view draws those same verts filled with `visual.fill` and borders them
// with a darker shade of it automatically — see `ViewSubsystem._polygonDisplay`.

import { regularPolygon } from "./regularPolygon.js";

/** A square, so: four corners. @private */
const CORNERS = 4;
/** First corner at 45°, which lands the four AXIS-ALIGNED (a square, not a diamond). */
const FIRST_CORNER = Math.PI / 4;

/**
 * Generate a petal container's collision outline: an axis-aligned square.
 * @param {number} radius Base radius (the rarity-scaled `def.size`) — the distance to
 *   each CORNER, so the square measures `radius × √2` on a side.
 * @param {number} [seed] Unused (the shape has no variation); accepted so this matches
 *   the generator contract in `geometry/index.js`.
 * @returns {{ verts: {x:number,y:number}[], boundingRadius: number }}
 *   `verts` are local (relative to the entity center), ordered by angle;
 *   `boundingRadius` is the corner distance, so a circle of that radius encloses the
 *   square (broadphase + the narrowphase bounds gate).
 */
export function generatePetalContainer(radius, seed) {
  return regularPolygon(CORNERS, radius, FIRST_CORNER);
}
