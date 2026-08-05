// rock — the drawn shape of a rock petal.
//
// A regular five-pointed pentagon, point UP, in the petal's grey. Fixed and seedless on
// purpose: every rock petal should read as the SAME rock wherever it's drawn — in a
// hotbar slot, in a world container, in a tooltip later. That's the whole reason petal
// geometry is separate from entity geometry: the rock ENTITY collides as a lumpy,
// id-seeded outline (`collisions/geometry/rock.js`), which is right for a boulder and
// wrong for an icon.
//
// The geometry is built at whatever radius the caller asks for, so one definition
// serves every size it's placed at.

import { regularPolygon } from "../../prediction/collisions/shapes/regularPolygon.js";

/** Five points. @private */
const SIDES = 5;
/** First vertex straight up (screen y grows downward, so up is -π/2). @private */
const POINT_UP = -Math.PI / 2;

/**
 * Build a rock petal's drawn shape.
 * @param {number} radius Distance from the center to each of the 5 points.
 * @param {number} [seed] Unused (the shape has no variation); accepted so this matches
 *   the generator contract in `petals/index.js`.
 * @returns {{verts: {x:number,y:number}[], boundingRadius: number, visual: object}}
 */
export function rockPetalShape(radius, seed) {
  const { verts, boundingRadius } = regularPolygon(SIDES, radius, POINT_UP);
  return {
    verts,
    boundingRadius,
    // Carried WITH the geometry, so a petal is one self-contained thing to place.
    visual: { fill: "#808080", strokeScale: 0.05 },
  };
}
