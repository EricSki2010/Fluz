// Spatial hash grid + the "placeable" contract objects must satisfy.

/**
 * The contract for anything that can be placed into a {@link SpatialGrid}.
 *
 * Swift used a `GridPlaceable: AnyObject` protocol so the grid could store
 * objects *by reference*. JS objects are already reference types, so there is
 * no protocol to declare — an object is "grid placeable" simply by exposing a
 * position and a radius:
 *
 *   - `x`, `y` — world-space center.
 *   - `collisionRadius` — circle radius. The grid registers the object in every
 *     cell its axis-aligned bounding box (`center ± collisionRadius`) overlaps.
 *
 * (Earlier versions indexed by a `collisionPoints` array sampled around the
 * disk; that's gone — the AABB cell range is exact for circles, costs nothing
 * to recompute on a move, and doesn't depend on point spacing vs cell size.)
 *
 * @typedef {Object} Point
 * @property {number} x
 * @property {number} y
 *
 * @typedef {Object} GridPlaceable
 * @property {number} x               World-space center x.
 * @property {number} y               World-space center y.
 * @property {number} collisionRadius Circle radius driving cell membership.
 */

/**
 * @typedef {Object} Rect
 * @property {number} x      Left edge (min x).
 * @property {number} y      Top/bottom edge (min y).
 * @property {number} width  Extent along x.
 * @property {number} height Extent along y.
 */

/**
 * A cell-index range an object currently occupies — `[minCx..maxCx] ×
 * [minCy..maxCy]` (inclusive). One record per registered object lives in
 * `_placement`, so the grid always knows where it put something without
 * re-reading the (possibly already-mutated) object.
 *
 * @typedef {Object} CellRange
 * @property {number} minCx
 * @property {number} minCy
 * @property {number} maxCx
 * @property {number} maxCy
 */

/**
 * Uniform spatial hash grid for fast 2D range queries.
 *
 * World space is divided into fixed-size cells. Each object is inserted into
 * every cell its bounding box (`center ± collisionRadius`) overlaps. Queries
 * (e.g. "what's inside the camera's viewport?") only walk the cells the query
 * rect touches.
 *
 * Only **references** to objects are stored — one shared instance per object
 * regardless of how many cells it spans. The grid also tracks each object's
 * current {@link CellRange} in `_placement`, which lets `update` cheaply skip
 * the re-index entirely when a move stays within the same cells.
 */
export class SpatialGrid {
  /**
   * @param {number} cellSize Width/height of a single cell, in world units.
   */
  constructor(cellSize) {
    if (!(cellSize > 0)) {
      throw new Error("SpatialGrid cellSize must be positive");
    }

    /** Width/height of a single cell, in world units (read-only after init). */
    this.cellSize = cellSize;

    /**
     * Cell key (`"x,y"`) → bucket of object references that overlap that cell.
     * The string key stands in for Swift's `Coord: Hashable` struct, since JS
     * Maps key objects by identity rather than by value.
     * @type {Map<string, GridPlaceable[]>}
     * @private
     */
    this._cells = new Map();

    /**
     * Object → the {@link CellRange} it is currently registered under. Lets
     * `remove`/`update` find the object's cells without recomputing from its
     * (maybe-already-changed) state, and lets `update` detect a no-op move.
     * @type {Map<GridPlaceable, CellRange>}
     * @private
     */
    this._placement = new Map();

    /**
     * Reused scratch for `query` dedup — cleared, never returned. Safe to share
     * because `query` is never re-entrant (it calls nothing that calls `query`).
     * @type {Set<GridPlaceable>}
     * @private
     */
    this._querySeen = new Set();
  }

  /**
   * No-op kept for API parity with the Swift version.
   *
   * Swift pre-allocated dictionary buckets to avoid mid-load rehash spikes.
   * JS `Map` has no equivalent reserve API, so there is nothing to do here.
   * @param {number} _minimumCapacity
   */
  reserveCapacity(_minimumCapacity) {
    // Intentionally empty — Map grows transparently.
  }

  // MARK: - Mutation

  /** Insert `object` into every cell its bounding box overlaps. */
  insert(object) {
    const range = { minCx: 0, minCy: 0, maxCx: 0, maxCy: 0 };
    this._writeRange(object, range);
    this._addToCells(object, range);
    this._placement.set(object, range);
  }

  /**
   * Remove `object` from the grid. Uses the object's *stored* cell range, so it
   * works regardless of whether the object's position has since changed — no
   * "remove before you mutate" ordering to remember.
   */
  remove(object) {
    const range = this._placement.get(object);
    if (range === undefined) return;
    this._removeFromRange(object, range);
    this._placement.delete(object);
  }

  /**
   * Re-index `object` after its position/radius changed. Recomputes the cell
   * range and, **only if it differs from where the object is currently
   * registered**, moves it (the common slow-mover case stays in the same cells
   * and returns immediately — no bucket churn). Inserts if not yet present.
   * @param {GridPlaceable} object
   */
  update(object) {
    const range = this._placement.get(object);
    if (range === undefined) {
      this.insert(object);
      return;
    }

    const cs = this.cellSize;
    const r = object.collisionRadius;
    const minCx = Math.floor((object.x - r) / cs);
    const minCy = Math.floor((object.y - r) / cs);
    const maxCx = Math.floor((object.x + r) / cs);
    const maxCy = Math.floor((object.y + r) / cs);

    // Same cells as last time → nothing to do (this is the cheap fast path that
    // most moving entities hit most frames).
    if (
      minCx === range.minCx && minCy === range.minCy &&
      maxCx === range.maxCx && maxCy === range.maxCy
    ) {
      return;
    }

    this._removeFromRange(object, range); // clear the OLD cells
    range.minCx = minCx;
    range.minCy = minCy;
    range.maxCx = maxCx;
    range.maxCy = maxCy;
    this._addToCells(object, range); // register the NEW cells
  }

  /** Wipe the entire grid. */
  removeAll() {
    this._cells.clear();
    this._placement.clear();
  }

  /**
   * Remove every object in the cell containing `point`, then insert `newObject`.
   * @param {Point} point
   * @param {GridPlaceable} newObject
   * @returns {GridPlaceable[]} The objects that were removed.
   */
  replace(point, newObject) {
    // Snapshot first: `queryAt` returns the live bucket and `remove` mutates
    // buckets in place, so iterate a copy.
    const removed = this.queryAt(point).slice();
    for (let i = 0; i < removed.length; i++) {
      this.remove(removed[i]);
    }
    this.insert(newObject);
    return removed;
  }

  // MARK: - Queries

  /**
   * All objects whose cells overlap `rect`. Objects spanning multiple cells are
   * returned exactly once.
   *
   * Allocation-free internally: the `seen` set used for dedup is reused across
   * calls. Results are written into `out` — pass your own reused array for a
   * zero-alloc hot path; omit it and a fresh array is returned.
   *
   * @param {Rect} rect
   * @param {GridPlaceable[]} [out] Destination array (cleared first). Defaults to
   *   a fresh array. If you pass a reused buffer, its contents are overwritten on
   *   the next `query` — consume them before querying again.
   * @returns {GridPlaceable[]} `out`, filled with the results.
   */
  query(rect, out = []) {
    out.length = 0;
    const seen = this._querySeen;
    seen.clear();

    const cs = this.cellSize;
    const minCx = Math.floor(rect.x / cs);
    const minCy = Math.floor(rect.y / cs);
    const maxCx = Math.floor((rect.x + rect.width) / cs);
    const maxCy = Math.floor((rect.y + rect.height) / cs);

    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        const bucket = this._cells.get(this._key(cx, cy));
        if (bucket === undefined) continue;
        for (let i = 0; i < bucket.length; i++) {
          const obj = bucket[i];
          if (!seen.has(obj)) {
            seen.add(obj);
            out.push(obj);
          }
        }
      }
    }
    return out;
  }

  /**
   * All objects registered in the cell containing `point`.
   * @param {Point} point
   * @returns {GridPlaceable[]}
   */
  queryAt(point) {
    const bucket = this._cells.get(this._cellKey(point.x, point.y));
    return bucket !== undefined ? bucket : [];
  }

  // MARK: - Internals

  /** @private */
  _key(x, y) {
    return x + "," + y;
  }

  /**
   * Cell key (`"cx,cy"`) for a world-space coordinate — floors into cell indices
   * and joins them. String keys (over numeric packing) keep cell indices
   * unbounded and negative-coordinate-safe.
   * @private
   */
  _cellKey(worldX, worldY) {
    return (
      Math.floor(worldX / this.cellSize) + "," + Math.floor(worldY / this.cellSize)
    );
  }

  /**
   * Fill `range` with the inclusive cell-index span of `object`'s bounding box
   * (`center ± collisionRadius`).
   * @private
   * @param {GridPlaceable} object
   * @param {CellRange} range
   */
  _writeRange(object, range) {
    const cs = this.cellSize;
    const r = object.collisionRadius;
    range.minCx = Math.floor((object.x - r) / cs);
    range.minCy = Math.floor((object.y - r) / cs);
    range.maxCx = Math.floor((object.x + r) / cs);
    range.maxCy = Math.floor((object.y + r) / cs);
  }

  /**
   * Register `object` in every cell of `range`.
   * @private
   * @param {GridPlaceable} object
   * @param {CellRange} range
   */
  _addToCells(object, range) {
    for (let cx = range.minCx; cx <= range.maxCx; cx++) {
      for (let cy = range.minCy; cy <= range.maxCy; cy++) {
        const key = cx + "," + cy;
        let bucket = this._cells.get(key);
        if (bucket === undefined) {
          bucket = [];
          this._cells.set(key, bucket);
        }
        bucket.push(object);
      }
    }
  }

  /**
   * Unregister `object` from every cell of `range` (swap-remove in place — cell
   * order doesn't matter, and `_addToCells` registers each object at most once
   * per cell).
   * @private
   * @param {GridPlaceable} object
   * @param {CellRange} range
   */
  _removeFromRange(object, range) {
    for (let cx = range.minCx; cx <= range.maxCx; cx++) {
      for (let cy = range.minCy; cy <= range.maxCy; cy++) {
        const key = cx + "," + cy;
        const bucket = this._cells.get(key);
        if (bucket === undefined) continue;
        const i = bucket.indexOf(object);
        if (i !== -1) {
          bucket[i] = bucket[bucket.length - 1];
          bucket.pop();
        }
        if (bucket.length === 0) this._cells.delete(key);
      }
    }
  }
}
