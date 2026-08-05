import { Collisions } from "./collisions/Collisions.js";
import { Inputs } from "../input/Inputs.js";

/**
 * Mechanics subsystem — the game's rules/simulation logic (as opposed to the
 * visual side, which lives in `VisualEngine`).
 *
 * Owns collision detection and player input; future mechanics (damage, spawning,
 * ...) register here too, exposed as named properties.
 */
export class Mechanics {
  constructor() {
    /** Collision detection. See `collisions/Collisions.js`. */
    this.collisions = new Collisions();

    /** Player input → movement intent. See `inputs/Inputs.js`. */
    this.inputs = new Inputs();
  }
}
