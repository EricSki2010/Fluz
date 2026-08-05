// WallField — barrier collision for the world step. Floor cells (the room) are
// passable; every other cell is solid barrier — so the infinite outside is solid
// without being enumerated (a cell is solid simply by NOT being a floor cell).
//
// Barriers are "special": entities are NOT pushed out of walls by the knockback
// system. Instead, at the movement-integration step, an entity's intended per-frame
// displacement is CLAMPED to the wall, one axis at a time — "want to move 5, the
// wall is 3 away → move 3 and stop." The two axes are clamped independently (x with
// the current y, then y with the post-x position), so sliding along a wall works.
//
// The collidable wall sits `inset` on the FLOOR side of the floor/barrier border
// (the visual wall is drawn just inside the floor edge), so an entity halts a touch
// before the border. Flip the sign of `inset` to put the wall inside the barrier.

/**
 * World units per cell. The client's ONE world-geometry constant: the wall field
 * clamps against this grid and the terrain layer draws one tile per cell, so both
 * must agree or the visual wall and the collidable wall drift apart. It lives here
 * rather than in a generator because the client doesn't generate worlds — it receives
 * their geometry (see `WORLD_STAT.INGAME` in the protocol) and only needs to know the
 * scale that geometry is expressed in. Must match the server's `CELL_WORLD`.
 */
export const CELL_WORLD = 100;

/** Wall surface inset from the floor/barrier border, as a fraction of one cell. */
const WALL_INSET_FRAC = 6 / 32;

/** The four sides of a floor cell a wall can sit on, as `dir -> [dx, dy]` on the
 * cell grid. The index IS the 2-bit code on the wire (see `WALL_DIR` in Protocol.js),
 * and the neighbour it points at is the SOLID cell behind that wall. */
export const WALL_DIR_STEP = Object.freeze([[1, 0], [-1, 0], [0, 1], [0, -1]]);

/**
 * How many cells deep to make the barrier band built from streamed faces. Derived
 * client-side, so depth costs nothing on the wire.
 *
 * It must be >1. A floor-plan field answers "solid?" for the whole infinite outside,
 * so an entity that is somehow already PAST the first wall face still gets stopped by
 * the next column out. A one-cell band has nothing behind it and would let that entity
 * walk away. The clamp itself never produces such a state — a flush entity sits with
 * its edge exactly on the inset face — but knockback, a teleport, or a spawn inside
 * geometry can, and "escapes the map" is a bad failure. Three cells covers an overlap
 * of up to two full cells, well past anything the sim generates.
 * @private
 */
const WALL_BAND_DEPTH = 3;

/**
 * Build the SOLID-cell set a {@link WallField} needs, from streamed wall faces. Each
 * face names a floor cell and the side its wall is on; the cells beyond that side are
 * barrier.
 *
 * This is a BAND {@link WALL_BAND_DEPTH} cells thick around the room, not "everything
 * outside" — the clamp stops at the first solid cell an entity would cross, so a band
 * is indistinguishable from an infinite exterior for anything approaching from inside,
 * while staying proportional to the room's perimeter instead of the whole plane.
 *
 * @param {Array<{cx:number, cy:number, dir:number}>} faces
 * @param {number} [depth=WALL_BAND_DEPTH] Cells of barrier behind each face.
 * @returns {Set<string>} solid cells as `"cx,cy"` keys.
 */
export function solidCellsFromWalls(faces, depth = WALL_BAND_DEPTH) {
  const solid = new Set();
  for (const f of faces) {
    const [dx, dy] = WALL_DIR_STEP[f.dir] ?? [0, 0];
    // Straight out from the face…
    for (let d = 1; d <= depth; d++) solid.add((f.cx + dx * d) + "," + (f.cy + dy * d));
    // …and the same band shifted along the face, which fills the diagonal cells at a
    // corner. Without it, an outside corner has a gap the two cardinal bands miss.
    for (let d = 1; d <= depth; d++) {
      for (let t = -depth; t <= depth; t++) {
        solid.add((f.cx + dx * d + dy * t) + "," + (f.cy + dy * d + dx * t));
      }
    }
  }
  return solid;
}

export class WallField {
  /**
   * @param {Set<string>} [floorCells] Passable cells as `"cx,cy"` keys (defaults to
   *   the test room's footprint).
   * @param {number} [cellWorld=CELL_WORLD] Cell size in world units.
   * @param {number} [inset] Wall inset in world units (default = 6/32 of a cell).
   * @param {Set<string>} [solidCells] Barrier cells as `"cx,cy"` keys. When given it
   *   REPLACES the floor test: a cell is solid iff it's in this set. That's the mode a
   *   client uses after {@link solidCellsFromWalls}, where it knows the barrier ring
   *   the server sent but never had the floor plan that produced it.
   */
  constructor(floorCells = new Set(), cellWorld = CELL_WORLD, inset = WALL_INSET_FRAC * CELL_WORLD, solidCells = null) {
    this.floor = floorCells;
    this.cell = cellWorld;
    this.inset = inset;
    this.solid = solidCells;
  }

  /**
   * Build a field straight from streamed wall faces — the client's path. No floor
   * plan is involved, so nothing here depends on the world generator.
   * @param {Array<{cx:number, cy:number, dir:number}>} faces
   * @param {number} [cellWorld=CELL_WORLD]
   * @returns {WallField}
   */
  static fromWalls(faces, cellWorld = CELL_WORLD) {
    return new WallField(new Set(), cellWorld, WALL_INSET_FRAC * cellWorld, solidCellsFromWalls(faces));
  }

  /** Solid (barrier) cell? With an explicit solid set, membership IS the answer;
   * otherwise anything that isn't a floor cell is solid. */
  isSolidCell(cx, cy) {
    const key = cx + "," + cy;
    return this.solid !== null ? this.solid.has(key) : !this.floor.has(key);
  }

  /**
   * Allowed x displacement for a circle (center `x`,`y`, radius `r`) trying to move
   * `vx` this step: `vx`, unless a wall is nearer — then just enough to sit against
   * it (`0` if already flush). Scans only the cells the leading edge would cross.
   * @returns {number}
   */
  clampX(x, y, r, vx) {
    if (vx === 0) return 0;
    const S = this.cell;
    const I = this.inset;
    const cyMin = Math.floor((y - r) / S);
    const cyMax = Math.floor((y + r) / S);
    if (vx > 0) {
      const dest = x + r + vx; // where the right edge wants to end up
      for (let cx = Math.floor((x + r) / S) + 1; cx * S - I < dest; cx++) {
        const wall = cx * S - I; // left face of barrier column cx, pulled onto the floor side
        if (wall < x + r) continue; // already past it (inset) — not a blocker
        for (let cy = cyMin; cy <= cyMax; cy++) {
          if (this.isSolidCell(cx, cy)) return wall - r - x;
        }
      }
    } else {
      const dest = x - r + vx; // where the left edge wants to end up
      for (let cx = Math.floor((x - r) / S) - 1; (cx + 1) * S + I > dest; cx--) {
        const wall = (cx + 1) * S + I; // right face of barrier column cx, on the floor side
        if (wall > x - r) continue;
        for (let cy = cyMin; cy <= cyMax; cy++) {
          if (this.isSolidCell(cx, cy)) return wall + r - x;
        }
      }
    }
    return vx;
  }

  /**
   * Allowed y displacement — `clampX` with the axes swapped.
   * @returns {number}
   */
  clampY(x, y, r, vy) {
    if (vy === 0) return 0;
    const S = this.cell;
    const I = this.inset;
    const cxMin = Math.floor((x - r) / S);
    const cxMax = Math.floor((x + r) / S);
    if (vy > 0) {
      const dest = y + r + vy;
      for (let cy = Math.floor((y + r) / S) + 1; cy * S - I < dest; cy++) {
        const wall = cy * S - I;
        if (wall < y + r) continue;
        for (let cx = cxMin; cx <= cxMax; cx++) {
          if (this.isSolidCell(cx, cy)) return wall - r - y;
        }
      }
    } else {
      const dest = y - r + vy;
      for (let cy = Math.floor((y - r) / S) - 1; (cy + 1) * S + I > dest; cy--) {
        const wall = (cy + 1) * S + I;
        if (wall > y - r) continue;
        for (let cx = cxMin; cx <= cxMax; cx++) {
          if (this.isSolidCell(cx, cy)) return wall + r - y;
        }
      }
    }
    return vy;
  }
}
