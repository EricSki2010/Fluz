// Petal-geometry registry — how each petal is DRAWN, kept deliberately separate from
// `GameEngine/mechanics/collisions/geometry/`, which is how entities COLLIDE.
//
// The two answer different questions and want different answers. A rock petal collides
// as a lumpy outline seeded by its entity id (so no two boulders match); it should DRAW
// as one fixed pentagon (so every rock icon matches). Tying the icon to the collider
// forced one shape to do both jobs badly, so drawing gets its own registry here.
//
// This side is view-only: it knows nothing about entities, colliders, spawning, or the
// sim, and nothing in GameEngine imports it. A petal is just a name → a shape + colors,
// which callers can place at any size, on a container or anywhere else.
//
// To add a petal: write a `<name>.js` exporting `(radius, seed) => { verts,
// boundingRadius, visual }` (see rock.js for the contract) and list it below.

import { rockPetalShape } from "./rock.js";

/** Petal def id → (radius, seed) => { verts, boundingRadius, visual }. Keyed by the
 * def id the rest of the game already passes around (hotbar slots, `entity.petal`,
 * the wire's `ptl`), so no separate naming scheme has to be kept in sync. @private */
const PETAL_SHAPES = {
  rock_petal: rockPetalShape,
};

/**
 * Build a petal's drawn shape.
 *
 * Returns `null` for an unknown or absent petal rather than throwing — unlike the
 * entity-geometry registry, whose unknown shape IS a bug worth crashing on. Here the
 * caller is drawing UI from server-supplied data (a hotbar slot, a container's held
 * petal), and a petal this client doesn't know about should render as an empty slot,
 * never take the HUD down.
 *
 * @param {string|null} petal A petal def id (e.g. `"rock_petal"`), or null.
 * @param {number} radius Size to build it at — the distance from center to the
 *   outline's furthest point.
 * @param {number} [seed=0] Seed for petals with procedural variation. Fixed shapes
 *   ignore it.
 * @returns {{verts: {x:number,y:number}[], boundingRadius: number, visual: object} | null}
 */
export function makePetalShape(petal, radius, seed = 0) {
  if (!petal) return null;
  const shape = PETAL_SHAPES[petal];
  return shape === undefined ? null : shape(radius, seed);
}

/** Is `petal` a petal this client knows how to draw? @param {string} petal */
export function hasPetalShape(petal) {
  return Object.prototype.hasOwnProperty.call(PETAL_SHAPES, petal);
}
