import { SpatialGrid } from "./SpatialGrid.js";

/**
 * Authoritative world-state storage for the game engine.
 *
 * Owns the `worldMap` — a {@link SpatialGrid} that indexes everything placed in
 * the world by 2D position, so collision and the (client) camera can quickly ask
 * "what's inside this rect?". This is game state, not visual state: the view
 * receives the grid to draw from but does not own it.
 */
export class MemorySubsystem {
  /**
   * @param {number} [cellSize=256] World units per grid cell. Tuned for the
   *   game's typical ~size-200 mobs: at 256 a big mob spans far fewer cells, so
   *   moving/re-indexing it is much cheaper (benchmarked ~−73% vs 128) while the
   *   broadphase false-positive cost stays low (you can't pack many big mobs on
   *   screen). Drop toward ~128 if the world becomes dominated by small, densely
   *   packed mobs instead. Rule of thumb: cellSize ≈ typical entity diameter.
   */
  constructor(cellSize = 256) {
    /** The 2D world map. Camera viewport queries go through this. */
    this.worldMap = new SpatialGrid(cellSize);
  }
}
