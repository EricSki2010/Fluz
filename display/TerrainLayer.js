// TerrainLayer — draws the ground as a grid of per-unit tile sprites, culled to
// the camera so only ON-SCREEN tiles exist. Floor cells (the room) get the grass
// texture; every other visible cell gets the barrier texture — so the barrier
// fills the (infinite) outside without ever enumerating it.
//
// Floor cells bordering barrier are decorated with full-cell transparent overlays,
// rotated to face the right way (anchor-centered → rotation pivots in place):
//   - EDGE   on a straight border (one orthogonal neighbour is barrier):
//            "higher" on up/right, "lower" on left/down.
//   - CORNER on a diagonal (a cell with a corner gets NO edges — they'd double up):
//            INNER — two adjacent sides are barrier (the barrier wraps a concave
//                    corner, e.g. the room's four corners).
//            OUTER — both sides are floor but the diagonal cell is barrier (a
//                    barrier corner poking out into the open).
// Corners draw above the base tiles. All sprites recycle through pools, so the tile
// count stays bounded to roughly what's on screen.
//
// Lives in the camera-transformed `world` container, under the entities. Requires
// PixiJS as the global `PIXI`.

import { CELL_WORLD } from "../prediction/WallField.js";

/** World units per terrain cell (one tile) — shared with the gamestate/collision
 * from the WALL FIELD itself, so the drawn tile and the collidable wall
 * can never disagree about where a cell is. */
export const TILE_WORLD = CELL_WORLD;

/** Straight-edge sides: when that neighbour is barrier, overlay an edge on this
 * floor cell. `hi` picks the texture (higher vs lower); `rot` (CW radians) turns
 * the art's decorated edge to face that side (base flipped 180° overall). */
const SIDES = [
  { dx: 0, dy: -1, hi: true, rot: Math.PI }, //            barrier above → higher
  { dx: 0, dy: 1, hi: false, rot: Math.PI }, //            barrier below → lower
  { dx: 1, dy: 0, hi: true, rot: (3 * Math.PI) / 2 }, //   barrier right → higher
  { dx: -1, dy: 0, hi: false, rot: (3 * Math.PI) / 2 }, // barrier left → lower
];

/** The four corner quadrants. `a`/`b` are the two orthogonal neighbour offsets,
 * `d` the diagonal between them; `rot` (CW radians) orients the corner art (base
 * assumed pointing at this quadrant, +90° per quadrant clockwise from NE). */
const CORNERS = [
  { a: [0, -1], b: [1, 0], d: [1, -1], rot: 0 }, //              NE
  { a: [0, 1], b: [1, 0], d: [1, 1], rot: Math.PI / 2 }, //      SE
  { a: [0, 1], b: [-1, 0], d: [-1, 1], rot: Math.PI }, //        SW
  { a: [0, -1], b: [-1, 0], d: [-1, -1], rot: (3 * Math.PI) / 2 }, // NW
];

export class TerrainLayer {
  /**
   * @param {any} world The camera-transformed PIXI.Container sprites live in.
   * @param {(path:string)=>any} getTexture Resolve a texture path → PIXI.Texture.
   * @param {object} opts
   * @param {Set<string>} opts.floorCells Room cells as `"cx,cy"` keys (unit grid).
   * @param {string} opts.grass Grass texture (floor cells).
   * @param {string} opts.barrier Barrier texture (everywhere else).
   * @param {string} opts.higher Edge texture for up/right sides.
   * @param {string} opts.lower Edge texture for left/down sides.
   * @param {string} opts.outerCorner Convex-corner texture.
   * @param {string} opts.innerCorner Concave-corner texture.
   * @param {number} [opts.tile=TILE_WORLD] World units per cell.
   */
  constructor(world, getTexture, { floorCells, grass, barrier, higher, lower, outerCorner, innerCorner, tile = TILE_WORLD }) {
    this._getTexture = getTexture;
    this._floor = floorCells;
    this._grass = grass;
    this._barrier = barrier;
    this._higher = higher;
    this._lower = lower;
    this._outer = outerCorner;
    this._inner = innerCorner;
    this._tile = tile;

    // Own container, under the entities. Stacked sub-layers (base → edges →
    // corners) so draw order is stable regardless of pool recycling.
    this.container = new PIXI.Container();
    this.container.zIndex = -1000; // below entities (default zIndex 0)
    world.addChild(this.container);
    this._layers = { base: new PIXI.Container(), edge: new PIXI.Container(), corner: new PIXI.Container() };
    this.container.addChild(this._layers.base, this._layers.edge, this._layers.corner);

    // One {active, pool} per sub-layer.
    this._sprites = {
      base: { active: [], pool: [] },
      edge: { active: [], pool: [] },
      corner: { active: [], pool: [] },
    };
  }

  /** Is the cell offset (dx,dy) from (cx,cy) a barrier (i.e. not a floor cell)? @private */
  _barrierAt(cx, cy, dx, dy) {
    return !this._floor.has(cx + dx + "," + (cy + dy));
  }

  /** Place a full-cell overlay sprite from `layer`, centered on cell (cx,cy) and
   * rotated `rot` (CW radians). @private */
  _overlay(layer, texPath, cx, cy, rot) {
    const t = this._tile;
    const set = this._sprites[layer];
    let s = set.pool.pop();
    if (s === undefined) {
      s = new PIXI.Sprite();
      s.anchor.set(0.5); // center → rotation pivots in place
      this._layers[layer].addChild(s);
    }
    s.texture = this._getTexture(texPath);
    s.width = t;
    s.height = t;
    s.rotation = rot;
    s.position.set(cx * t + t / 2, cy * t + t / 2);
    s.visible = true;
    set.active.push(s);
  }

  /** Recycle a sub-layer's active sprites back into its pool (hidden). @private */
  _recycle(layer) {
    const set = this._sprites[layer];
    for (let i = 0; i < set.active.length; i++) {
      set.active[i].visible = false;
      set.pool.push(set.active[i]);
    }
    set.active.length = 0;
  }

  /**
   * Draw the tiles (+ grass-facing edges and corners) covering the camera rect.
   * @param {number} left Camera min x (world). @param {number} top Camera min y.
   * @param {number} width @param {number} height Camera size (world).
   */
  draw(left, top, width, height) {
    const t = this._tile;
    const minCx = Math.floor(left / t);
    const minCy = Math.floor(top / t);
    const maxCx = Math.floor((left + width) / t);
    const maxCy = Math.floor((top + height) / t);

    this._recycle("base");
    this._recycle("edge");
    this._recycle("corner");

    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        const isFloor = this._floor.has(cx + "," + cy);
        this._overlay("base", isFloor ? this._grass : this._barrier, cx, cy, 0);
        if (!isFloor) continue; // decorations live on floor cells facing barrier

        // Corners first: INNER where two adjacent sides are barrier (barrier wraps
        // a concave corner — the room's four corners); OUTER where the sides are
        // clear but the diagonal is barrier (a barrier corner poking into the open).
        let cornerPlaced = false;
        for (let k = 0; k < CORNERS.length; k++) {
          const c = CORNERS[k];
          const aBar = this._barrierAt(cx, cy, c.a[0], c.a[1]);
          const bBar = this._barrierAt(cx, cy, c.b[0], c.b[1]);
          // All corners are turned +90° from the quadrant base; outer corners get
          // a further 180° (so they face back out into the open).
          if (aBar && bBar) {
            this._overlay("corner", this._inner, cx, cy, c.rot + Math.PI / 2);
            cornerPlaced = true;
          } else if (!aBar && !bBar && this._barrierAt(cx, cy, c.d[0], c.d[1])) {
            this._overlay("corner", this._outer, cx, cy, c.rot + Math.PI / 2 + Math.PI);
            cornerPlaced = true;
          }
        }

        // Straight edges — skipped on a cell that already has a corner, so a corner
        // never doubles up with top/bottom edges.
        if (!cornerPlaced) {
          for (let s = 0; s < SIDES.length; s++) {
            const side = SIDES[s];
            if (!this._barrierAt(cx, cy, side.dx, side.dy)) continue;
            this._overlay("edge", side.hi ? this._higher : this._lower, cx, cy, side.rot);
          }
        }
      }
    }
  }
}
