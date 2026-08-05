// Collision-geometry registry — maps a def's `collider.shape` name to the
// generator that builds that shape's procedural outline. Keeps `Entity` generic:
// it asks for a shape by name instead of importing each species' geometry.
//
// This is how entities COLLIDE. How a PETAL is DRAWN is a separate registry
// (`VisualEngine/ui/petals/`), because the two want different answers for the same
// thing — a rock collides as a lumpy id-seeded outline (no two boulders alike) and
// draws as one fixed pentagon (every icon alike). Nothing here knows about that side.
//
// To add a procedural collider: write a `generate<Name>(radius, seed)` module
// (see rock.js for the contract) and list it here.

import { generateRock } from "./rock.js";
import { generatePetalContainer } from "./petalContainer.js";

/** name → (radius, seed) => { verts, boundingRadius }. @private */
const GENERATORS = {
  rock: generateRock,
  petalContainer: generatePetalContainer,
};

/**
 * Build the outline for a named procedural shape.
 * @param {string} shape Shape name from `def.collider.shape` (e.g. "rock").
 * @param {number} radius Base radius (rarity-scaled `def.size`).
 * @param {number} seed Per-entity seed — pass the entity `id` for net-stable,
 *   server/client-identical shapes.
 * @returns {{ verts: {x:number,y:number}[], boundingRadius: number }}
 * @throws if `shape` is unregistered.
 */
export function makeGeometry(shape, radius, seed) {
  const gen = GENERATORS[shape];
  if (gen === undefined) throw new Error(`unknown collider shape "${shape}"`);
  return gen(radius, seed);
}
