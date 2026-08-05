// Collision detection — broadphase (spatial grid) + narrowphase (circle test),
// with within-frame pair dedup and deferred (return-a-list) dispatch.
//
// Design notes (the reasoning behind the choices here):
//   - An entity spans MULTIPLE grid cells (it's indexed by its bounding box), so
//     the same pair (A, B) surfaces many times in a sweep. We dedup with an
//     integer-keyed Set of ordered id pairs — this kills the A-vs-B / B-vs-A
//     duplicate AND the multi-cell duplicate in one structure.
//   - The pair key is a NUMBER, not a string, so there's no per-pair allocation
//     (string keys would churn the GC, which is what actually causes stutter).
//   - Narrowphase compares SQUARED distances, so no sqrt per pair.
//   - Reused scratch structures (`_checkedPairs`, `_results`) are cleared each
//     frame instead of reallocated — no per-frame garbage.
//   - This module only DETECTS. The response/prevention logic consumes the
//     returned list; it lives elsewhere.

/**
 * The shape an entity must have to take part in collision. The grid indexes it
 * by the same `x`/`y`/`collisionRadius` (as a bounding box), so there's nothing
 * else to maintain.
 *
 * @typedef {Object} CollisionEntity
 * @property {number} x               World-space center x.
 * @property {number} y               World-space center y.
 * @property {number} collisionRadius Bounding-circle radius (broad gate + the
 *   plain-circle shape).
 * @property {null | { type: string }} [collider] Shape refine, or null/absent for
 *   a plain circle. Dispatched on in `_narrowphase`.
 *
 * @typedef {Object} Collision
 * @property {CollisionEntity} a
 * @property {CollisionEntity} b
 * @property {number} overlap How deep they penetrate: `(ra + rb) - distance`.
 * @property {number} nx Unit contact normal x, pointing from `a` toward `b`.
 * @property {number} ny Unit contact normal y, pointing from `a` toward `b`.
 */

// 2^26. Entity ids must stay below this, and ID_SPAN^2 (~4.5e15) stays under
// Number.MAX_SAFE_INTEGER (~9.0e15), so packed pair keys never lose precision.
// Supports ~67M distinct entities over a session — far more than any frame.
const ID_SPAN = 67108864;

// --- Fast trig for oval rotation ------------------------------------------
// `fastSin`/`fastCos` are a polynomial approximation (Nick's quadratic + one
// precision pass), max error ~0.0009 over the whole circle — way below anything
// visible in a 2D collision normal. They're cheaper than Math.sin/cos, and the
// oval kernel ALSO caches the result per-collider per-frame, so the trig runs
// roughly once per oval per frame regardless of how many collisions it has.
const PI = Math.PI;
const TWO_PI = PI * 2;
const HALF_PI = PI / 2;
const SIN_B = 4 / PI;
const SIN_C = -4 / (PI * PI);

/** Approximate sin(x), any x (wrapped into [-π, π] first). @private */
function fastSin(x) {
  x -= TWO_PI * Math.floor((x + PI) / TWO_PI); // wrap into [-π, π]
  let y = SIN_B * x + SIN_C * x * Math.abs(x);
  y = 0.225 * (y * Math.abs(y) - y) + y; // extra-precision pass (→ ~0.0009 err)
  return y;
}

/** Approximate cos(x) via sin(x + π/2). @private */
function fastCos(x) {
  return fastSin(x + HALF_PI);
}

/**
 * Collision system. Reachable as `GameEngine.shared.mechanics.collisions`.
 */
export class Collisions {
  constructor() {
    /** Reused each frame; holds packed integer pair keys already checked. @private */
    this._checkedPairs = new Set();

    /** Stable integer id per entity, assigned lazily. WeakMap so dead entities
     * don't leak. @private @type {WeakMap<object, number>} */
    this._ids = new WeakMap();

    /** @private */
    this._nextId = 1;

    /** Reused per-call output array — cleared (not reallocated) each `detect`.
     * Holds references into `_pool`. @private */
    this._results = [];

    /** Pool of reusable Collision objects — `detect` writes into these instead
     * of allocating a fresh `{a,b,overlap,nx,ny}` per hit, so a sweep produces
     * ZERO garbage (no GC stutter on weak machines). Grows to the high-water
     * mark of simultaneous hits, then never allocates again. @private */
    this._pool = [];
    /** Next free `_pool` slot. Reset to 0 once per TICK by `resetPool` (not per
     * `detect`), so objects stay valid across the tick's multiple region sweeps
     * until they're consumed. @private */
    this._poolIdx = 0;

    /** Reused query rect, mutated per entity instead of allocated. @private */
    this._rect = { x: 0, y: 0, width: 0, height: 0 };

    /** Reused broadphase buffer handed to `grid.query`. @private */
    this._nearby = [];

    /** Reused scratch for `_pointInPolygon` to write its outward normal into,
     * so the polygon-vs-polygon vertex sweep allocates nothing. @private */
    this._scratchN = { nx: 0, ny: 0 };

    /** Reused "virtual circle" entity backing {@link probe} — a plain circle
     * (`collider: null`) whose pose is rewritten per call, so probing allocates
     * nothing. `angle` exists only because the oval kernel reads it. @private */
    this._probe = { x: 0, y: 0, collisionRadius: 0, collider: null, angle: 0 };

    /** Dedicated result object for {@link probe}. Deliberately NOT drawn from
     * `_pool` — a probe runs during the movement phase, when the tick's `detect`
     * results are still live, and taking a pool slot would overwrite one of them.
     * @private */
    this._probeOut = { a: null, b: null, overlap: 0, nx: 0, ny: 0 };
  }

  /**
   * Free the whole result pool for reuse. Call once per tick BEFORE the tick's
   * `detect` sweeps (a tick may sweep several regions). Pooled objects from the
   * previous tick stay valid until this is called, then get overwritten.
   */
  resetPool() {
    this._poolIdx = 0;
  }

  /** Next reusable Collision object from the pool (grows the pool on demand). @private */
  _poolNext() {
    let o = this._pool[this._poolIdx];
    if (o === undefined) {
      o = { a: null, b: null, overlap: 0, nx: 0, ny: 0 };
      this._pool[this._poolIdx] = o;
    }
    return o;
  }

  /**
   * Stable integer id for an entity (assigned on first sight).
   * @private
   */
  _idOf(entity) {
    let id = this._ids.get(entity);
    if (id === undefined) {
      id = this._nextId++;
      this._ids.set(entity, id);
    }
    return id;
  }

  /**
   * Run one collision sweep: for each entity, broadphase the grid for
   * neighbours, skip pairs already handled this frame, narrowphase the rest.
   * The body is pure orchestration — each step is a method below.
   *
   * `_narrowphase` is the ONLY shape-specific step; dispatch there to add
   * ovals/polygons later. Broadphase, dedup, and the response layer stay as-is.
   *
   * @param {CollisionEntity[]} entities The entity list to sweep (broadphase
   *   initiators — typically the awake/scheduled subset of the active set).
   * @param {import("../../memory/SpatialGrid.js").SpatialGrid} grid
   *   The spatial index to broadphase against (e.g. `GameEngine.shared.memory.worldMap`).
   * @returns {Collision[]} Colliding pairs (pooled objects). NOTE: reused — read
   *   it before the next tick's `resetPool`. Within a tick, successive `detect`
   *   calls draw fresh pool slots, so earlier results stay valid.
   */
  detect(entities, grid) {
    this._checkedPairs.clear();
    const results = this._results;
    results.length = 0;

    for (let i = 0; i < entities.length; i++) {
      const a = entities[i];
      const nearby = this._broadphase(a, grid);
      for (let j = 0; j < nearby.length; j++) {
        const b = nearby[j];
        if (b === a || this._seenPair(a, b)) continue;
        const out = this._poolNext(); // reusable slot; advanced only on a real hit
        if (this._narrowphase(a, b, out)) {
          results.push(out);
          this._poolIdx++;
        }
      }
    }
    return results;
  }

  /**
   * Cached (cos, sin) of a polygon entity's facing, so a shape that takes several
   * collisions in a frame does the trig once. Stored on the collider — which is a FRESH
   * object per entity, not the shared def's — exactly like the oval kernel's cache.
   *
   * Rather than rotating every vertex (O(verts) per test), callers rotate the query
   * point INTO the polygon's local frame and rotate the resulting normal back out
   * (O(1)); the vertex list itself is never touched. @private
   */
  _polyTrig(poly) {
    const col = poly.collider;
    const ang = poly.angle;
    if (col._trigAngle !== ang) {
      col._trigAngle = ang;
      col._cos = fastCos(ang);
      col._sin = fastSin(ang);
    }
    return col;
  }

  /**
   * Test a VIRTUAL circle — a point + radius that is not an entity and isn't in the
   * grid — against one specific entity, using the same narrowphase kernels as a real
   * sweep (so an oval/polygon/box `entity` is refined exactly as it would be in
   * `detect`). One pair, no broadphase: for asking "would something of this size,
   * placed HERE, be touching that?".
   *
   * Used by `MOVEMENT.orbit` to test a petal's orbit ANCHOR — a bare point that
   * rotates around the parent — against the enemy it's stuck to, which is what makes
   * the stick release when the anchor sweeps past rather than when the (deliberately
   * still-overlapping) petal does.
   *
   * @param {number} x World-space center of the virtual circle.
   * @param {number} y
   * @param {number} radius Its radius.
   * @param {CollisionEntity} entity The entity to test against.
   * @returns {Collision|null} A REUSED result — `overlap` plus the unit normal
   *   `nx,ny` pointing FROM the circle TOWARD `entity` (negate for the entity's
   *   outward normal). Null if they don't touch. Valid only until the next `probe`.
   */
  probe(x, y, radius, entity) {
    const p = this._probe;
    p.x = x;
    p.y = y;
    p.collisionRadius = radius;
    return this._narrowphase(p, entity, this._probeOut) ? this._probeOut : null;
  }

  /**
   * Broadphase: the grid neighbours whose cells overlap `a`'s bounding box.
   * Reuses the scratch rect + buffer, so it allocates nothing. A big neighbour
   * spans many cells, so it's still found from `a`'s own extent.
   * @private
   * @returns {CollisionEntity[]} the reused `_nearby` buffer.
   */
  _broadphase(a, grid) {
    const r = a.collisionRadius;
    const rect = this._rect;
    rect.x = a.x - r;
    rect.y = a.y - r;
    rect.width = r * 2;
    rect.height = r * 2;
    return grid.query(rect, this._nearby);
  }

  /**
   * Pair dedup: `true` if `(a, b)` was already handled this frame (recording it
   * if not). One ordered integer key (`lo * ID_SPAN + hi`) kills both the
   * A-vs-B / B-vs-A duplicate and the multi-cell duplicate, with no allocation.
   * @private
   */
  _seenPair(a, b) {
    const aId = this._idOf(a);
    const bId = this._idOf(b);
    const key = aId < bId ? aId * ID_SPAN + bId : bId * ID_SPAN + aId;
    if (this._checkedPairs.has(key)) return true;
    this._checkedPairs.add(key);
    return false;
  }

  /**
   * Narrowphase. First the broad **bounding-circle** test (every shape's cheap
   * gate): if the circles don't even reach each other there's no collision. If
   * they DO, refine by the `collider` tag — plain circles (`collider === null`,
   * the common case) take the exact circle contact; an oval/polygon collider
   * routes to its refine. Each branch FILLS `out` (`{ a, b, overlap, nx, ny }`)
   * and returns `true`, or returns `false` for no contact — so `detect` can pool
   * `out` and never allocate.
   * @private
   * @param {Collision} out Pooled result object to fill on a hit.
   * @returns {boolean} true if they collide (and `out` is filled).
   */
  _narrowphase(a, b, out) {
    // Broad bounding-circle test — squared distance, no sqrt unless they touch.
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const r = a.collisionRadius + b.collisionRadius;
    const d2 = dx * dx + dy * dy;
    if (d2 >= r * r) return false; // bounds don't reach → definitely no collision

    // Bounds overlap → refine by shape. null collider = plain circle = fast path.
    const ca = a.collider;
    const cb = b.collider;
    if (ca === null && cb === null) {
      return this._circleContact(a, b, dx, dy, d2, r, out);
    }
    if ((ca !== null && ca.type === "aabb") || (cb !== null && cb.type === "aabb")) {
      return this._boxContact(a, b, out);
    }
    if ((ca !== null && ca.type === "polygon") || (cb !== null && cb.type === "polygon")) {
      return this._polygonContact(a, b, out);
    }
    if ((ca !== null && ca.type === "oval") || (cb !== null && cb.type === "oval")) {
      return this._ovalContact(a, b, out);
    }
    // Collider present but not a refined type → treat as a plain circle.
    return this._circleContact(a, b, dx, dy, d2, r, out);
  }

  /**
   * Circle-vs-circle contact: fills `out` with penetration **depth** (`overlap`)
   * + unit contact **normal** (`nx,ny`, from `a` toward `b`). Reuses the
   * `dx/dy/d2/r` the bounds test already computed, so the sqrt happens only here.
   * Always a hit (it's only called when the bounds already overlap).
   * @private
   * @returns {boolean}
   */
  _circleContact(a, b, dx, dy, d2, r, out) {
    let dist = Math.sqrt(d2);
    let nx, ny;
    if (dist > 1e-9) {
      nx = dx / dist;
      ny = dy / dist;
    } else {
      // Coincident centers — pick an arbitrary axis to push along.
      dist = 0;
      nx = 1;
      ny = 0;
    }
    out.a = a;
    out.b = b;
    out.overlap = r - dist;
    out.nx = nx;
    out.ny = ny;
    return true;
  }

  /**
   * Oval refine. We only reach here because at least one entity is an oval, so
   * we pick it by reading the collider type once (no "is it an oval" re-test).
   * The other entity is treated as a point + radius (a circle, or another oval's
   * bounding circle — exact ellipse-vs-ellipse is deferred). `_circleVsOval`
   * fills `out.overlap/nx/ny` (oval → other); we set `a`/`b` and flip the normal
   * when the oval is `b` (the contract wants `a → b`).
   * @private
   * @returns {boolean}
   */
  _ovalContact(a, b, out) {
    const ov = a.collider !== null && a.collider.type === "oval" ? a : b;
    const other = ov === a ? b : a;

    if (!this._circleVsOval(ov, other.x, other.y, other.collisionRadius, out)) {
      return false;
    }
    out.a = a;
    out.b = b;
    if (ov === b) {
      out.nx = -out.nx;
      out.ny = -out.ny;
    }
    return true;
  }

  /**
   * Circle-vs-oval. `ov` is the oval entity — collider `{ rx, ry }`, rotated by
   * `ov.angle`; the circle is a point `(px, py)` + radius `r`. Fills
   * `out.overlap` + the oval's OUTWARD unit normal (`out.nx/ny`, oval → point)
   * and returns `true`, or returns `false` if they don't actually overlap (which
   * rejects a bounding-circle false hit). Does NOT set `out.a/b` — the caller does.
   *
   * Approximation: the contact point is where the center→point ray crosses the
   * ellipse (cheap; exact closest point is a quartic); the normal is the ellipse
   * gradient there — accurate enough for response, crisp on mild ovals.
   * @private
   * @returns {boolean}
   */
  _circleVsOval(ov, px, py, r, out) {
    const col = ov.collider;
    const A = col.rx;
    const B = col.ry;

    // Effective oval rotation = the entity's facing PLUS the collider's static
    // offset (`col.angle` — e.g. to sit diagonally on the body). Cached cos/sin,
    // recomputed only when that combined angle changes (≈once per frame) via the
    // fast approximation, and reused across all this oval's collisions — so the
    // trig runs ~once per oval per frame. One (cos,sin) pair drives BOTH the
    // rotate-in here and the normal's rotate-out.
    const ang = ov.angle + col.angle;
    if (col._trigAngle !== ang) {
      col._trigAngle = ang;
      col._cos = fastCos(ang);
      col._sin = fastSin(ang);
    }
    const c = col._cos;
    const s = col._sin;

    // center→point, rotated into the oval's local (axis-aligned) frame (by -angle).
    const dx = px - ov.x;
    const dy = py - ov.y;
    const lx = dx * c + dy * s;
    const ly = -dx * s + dy * c;

    // Implicit value: <1 inside the ellipse, >1 outside.
    const m = Math.sqrt((lx * lx) / (A * A) + (ly * ly) / (B * B));
    if (m < 1e-6) {
      // Point at the oval's center — push out the SHORTER axis (nearest exit).
      if (A <= B) this._writeOvalNormal(out, 1, 0, r + A, c, s);
      else this._writeOvalNormal(out, 0, 1, r + B, c, s);
      return true;
    }

    // Boundary point along the center→point ray (m scales it onto the ellipse).
    const cpx = lx / m;
    const cpy = ly / m;

    // Distance point→boundary (rotation preserves distance, so local is fine).
    const gx = lx - cpx;
    const gy = ly - cpy;
    const dist = Math.sqrt(gx * gx + gy * gy);

    // Outside (m≥1): gap is `dist`. Inside (m<1): center is `dist` past the wall.
    const overlap = m >= 1 ? r - dist : r + dist;
    if (overlap <= 0) return false;

    // Outward normal = ellipse gradient (x/A², y/B²) at the boundary, normalized.
    let nlx = cpx / (A * A);
    let nly = cpy / (B * B);
    const nlen = Math.sqrt(nlx * nlx + nly * nly) || 1;
    this._writeOvalNormal(out, nlx / nlen, nly / nlen, overlap, c, s);
    return true;
  }

  /**
   * Rotate a local-frame unit normal back into world (by +angle) using the
   * already-computed (cos, sin) pair, and write it (+ overlap) into `out`.
   * @private
   */
  _writeOvalNormal(out, nlx, nly, overlap, c, s) {
    out.overlap = overlap;
    out.nx = nlx * c - nly * s;
    out.ny = nlx * s + nly * c;
  }

  /**
   * AABB refine. At least one entity is an axis-aligned box (`collider {type:"aabb",
   * hw, hh}` — half-extents, centered on `x`,`y`; rotation is ignored, that's the
   * point of an AABB). Both boxes → box-vs-box (minimum-translation axis); else
   * box-vs-circle. Fills `out` with the a→b normal + penetration depth, or returns
   * false if they don't actually overlap (rejecting a bounding-circle false hit).
   * The box entity's `collisionRadius` must be ≥ its half-diagonal so broadphase +
   * the bounds gate never miss a real contact.
   * @private
   * @returns {boolean}
   */
  _boxContact(a, b, out) {
    const aBox = a.collider !== null && a.collider.type === "aabb";
    const bBox = b.collider !== null && b.collider.type === "aabb";
    if (aBox && bBox) return this._aabbVsAabb(a, b, out);

    const box = aBox ? a : b;
    const other = box === a ? b : a;
    if (!this._circleVsBox(box, other.x, other.y, other.collisionRadius, out)) {
      return false;
    }
    out.a = a;
    out.b = b;
    // `_circleVsBox` writes the box→circle normal; flip when the box is `b` so the
    // a→b contract holds.
    if (box === b) {
      out.nx = -out.nx;
      out.ny = -out.ny;
    }
    return true;
  }

  /**
   * Circle-vs-AABB. `box` is the box entity (`collider {hw, hh}`, centered on its
   * `x`,`y`); the circle is a point `(px, py)` + radius `r`. Fills `out.overlap` +
   * the box's OUTWARD unit normal (box → point) and returns true, or false if they
   * don't overlap. Does NOT set `out.a/b` — the caller does.
   * @private
   * @returns {boolean}
   */
  _circleVsBox(box, px, py, r, out) {
    const col = box.collider;
    const hw = col.hw;
    const hh = col.hh;
    const dx = px - box.x;
    const dy = py - box.y;
    // Closest point on the box to the circle center (clamp into the box extents).
    const cx = dx < -hw ? -hw : dx > hw ? hw : dx;
    const cy = dy < -hh ? -hh : dy > hh ? hh : dy;
    const ox = dx - cx;
    const oy = dy - cy;
    const d2 = ox * ox + oy * oy;

    if (d2 > 1e-12) {
      // Center OUTSIDE the box: contact along the closest-point → center vector.
      const dist = Math.sqrt(d2);
      const overlap = r - dist;
      if (overlap <= 0) return false; // bounds touched but the box didn't
      out.overlap = overlap;
      out.nx = ox / dist;
      out.ny = oy / dist;
      return true;
    }

    // Center INSIDE the box → push out the nearest face (smallest penetration).
    const penX = hw - Math.abs(dx);
    const penY = hh - Math.abs(dy);
    if (penX < penY) {
      out.nx = dx < 0 ? -1 : 1;
      out.ny = 0;
      out.overlap = r + penX;
    } else {
      out.nx = 0;
      out.ny = dy < 0 ? -1 : 1;
      out.overlap = r + penY;
    }
    return true;
  }

  /**
   * AABB-vs-AABB via the minimum-translation axis: overlap on each axis, push along
   * the smaller. Fills `out` (a→b normal + depth), false if separated.
   * @private
   * @returns {boolean}
   */
  _aabbVsAabb(a, b, out) {
    const ca = a.collider;
    const cb = b.collider;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const px = ca.hw + cb.hw - Math.abs(dx);
    if (px <= 0) return false;
    const py = ca.hh + cb.hh - Math.abs(dy);
    if (py <= 0) return false;
    out.a = a;
    out.b = b;
    if (px < py) {
      out.nx = dx < 0 ? -1 : 1;
      out.ny = 0;
      out.overlap = px;
    } else {
      out.nx = 0;
      out.ny = dy < 0 ? -1 : 1;
      out.overlap = py;
    }
    return true;
  }

  /**
   * Polygon refine. At least one entity is a polygon (`collider {type:"polygon",
   * verts}` — an outline in LOCAL space about its center). When BOTH are polygons
   * (rock-vs-rock) we test the real outlines (`_polyVsPoly`); when only one is, we
   * treat the other as a point + radius and use the circle-vs-polygon kernel.
   * Fills `out.a/b` + the a→b normal + depth, or returns false.
   * @private
   * @returns {boolean}
   */
  _polygonContact(a, b, out) {
    const aPoly = a.collider !== null && a.collider.type === "polygon";
    const bPoly = b.collider !== null && b.collider.type === "polygon";
    if (aPoly && bPoly) return this._polyVsPoly(a, b, out);

    const poly = aPoly ? a : b;
    const other = poly === a ? b : a;
    if (!this._circleVsPolygon(poly, other.x, other.y, other.collisionRadius, out)) {
      return false;
    }
    out.a = a;
    out.b = b;
    if (poly === b) {
      out.nx = -out.nx;
      out.ny = -out.ny;
    }
    return true;
  }

  /**
   * Polygon-vs-polygon, via deepest penetrating vertex: for each vertex of one
   * outline that lies INSIDE the other, its distance to that other's nearest edge
   * is a penetration depth; the deepest such vertex (checked both ways) is the
   * contact. Real outlines — not bounding circles — so two lumpy rocks only push
   * once their actual shapes overlap (no phantom gap), and the normal is the real
   * edge it's pushing off.
   *
   * Approximation: a pure edge-crossing overlap with NO vertex inside either (e.g.
   * two thin spikes forming an X) is missed — fine for blobby rocks, where a real
   * overlap always sinks a vertex in. Impulse knockback resolves the rest over a
   * few frames, so an exact MTV isn't needed. @private
   * @returns {boolean}
   */
  _polyVsPoly(a, b, out) {
    let depth = 0;
    let nx = 0, ny = 0;
    const s = this._scratchN;
    // b's vertices inside a → normal is a's outward edge = a→b (push b off a).
    // Each outline's vertices have to be rotated by ITS OWN facing before they're world
    // points; `_pointInPolygon` then handles the other shape's rotation internally.
    const bTrig = this._polyTrig(b), bc = bTrig._cos, bs = bTrig._sin;
    const bv = b.collider.verts;
    for (let i = 0; i < bv.length; i++) {
      const vx = bv[i].x, vy = bv[i].y;
      const d = this._pointInPolygon(a, b.x + vx * bc - vy * bs, b.y + vx * bs + vy * bc, s);
      if (d > depth) { depth = d; nx = s.nx; ny = s.ny; }
    }
    // a's vertices inside b → normal is b→a; flip to a→b.
    const aTrig = this._polyTrig(a), ac = aTrig._cos, as = aTrig._sin;
    const av = a.collider.verts;
    for (let i = 0; i < av.length; i++) {
      const vx = av[i].x, vy = av[i].y;
      const d = this._pointInPolygon(b, a.x + vx * ac - vy * as, a.y + vx * as + vy * ac, s);
      if (d > depth) { depth = d; nx = -s.nx; ny = -s.ny; }
    }
    if (depth <= 0) return false; // outlines don't actually overlap
    out.a = a;
    out.b = b;
    out.overlap = depth;
    out.nx = nx;
    out.ny = ny;
    return true;
  }

  /**
   * If world point `(wx,wy)` is INSIDE polygon `P` (collider.verts local to its
   * center), return its penetration depth (distance to `P`'s nearest edge) and
   * write the OUTWARD unit normal (point → that edge, i.e. the way to push the
   * point out) into `out`. Returns `-1` if the point is outside. Shares the
   * closest-feature + even-odd logic with `_circleVsPolygon`. @private
   * @returns {number}
   */
  _pointInPolygon(P, wx, wy, out) {
    const verts = P.collider.verts;
    const n = verts.length;
    // Into P's LOCAL frame: translate, then rotate by -angle. The outline is authored
    // unrotated, so this is what makes the shape actually turn with the entity.
    const col = this._polyTrig(P);
    const c = col._cos, sn = col._sin;
    const dx = wx - P.x, dy = wy - P.y;
    const cx = dx * c + dy * sn;
    const cy = -dx * sn + dy * c;
    let bestD2 = Infinity, bestX = 0, bestY = 0;
    let inside = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const jx = verts[j].x, jy = verts[j].y;
      const ix = verts[i].x, iy = verts[i].y;
      const ex = ix - jx, ey = iy - jy;
      const len2 = ex * ex + ey * ey || 1;
      let t = ((cx - jx) * ex + (cy - jy) * ey) / len2;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const qx = jx + ex * t, qy = jy + ey * t;
      const ddx = cx - qx, ddy = cy - qy;
      const d2 = ddx * ddx + ddy * ddy;
      if (d2 < bestD2) { bestD2 = d2; bestX = qx; bestY = qy; }
      if ((iy > cy) !== (jy > cy) && cx < ((jx - ix) * (cy - iy)) / (jy - iy) + ix) {
        inside = !inside;
      }
    }
    if (!inside) return -1;
    const dist = Math.sqrt(bestD2);
    // Normal comes out of the local frame — rotate it back to world by +angle.
    let nlx = 1, nly = 0;
    if (dist > 1e-9) { nlx = (bestX - cx) / dist; nly = (bestY - cy) / dist; }
    out.nx = nlx * c - nly * sn;
    out.ny = nlx * sn + nly * c;
    return dist;
  }

  /**
   * Circle-vs-polygon. `poly` is the polygon entity (`collider.verts` — local to
   * `poly.x`,`poly.y`); the circle is a point `(px, py)` + radius `r`. Fills
   * `out.overlap` + the polygon's OUTWARD unit normal (polygon → point) and
   * returns true, or false if they don't overlap. Does NOT set `out.a/b`.
   *
   * Uses the TRUE CLOSEST FEATURE, not a center-ray: find the nearest point on the
   * outline (over every edge segment) to the circle center, and test inside/outside
   * (even-odd ray crossing). This can't tunnel — overlap is detected whenever the
   * circle truly reaches an edge, and the normal is always the real nearest-feature
   * direction (a center-ray method mis-measured oblique hits near notches/corners,
   * letting a circle phase in until it passed the center).
   *   - center INSIDE  → engulfed: push out the nearest wall, depth `r + dist`.
   *   - center OUTSIDE → hit iff `dist < r`, depth `r - dist`, pushed off that edge.
   * @private
   * @returns {boolean}
   */
  _circleVsPolygon(poly, px, py, r, out) {
    const verts = poly.collider.verts;
    const n = verts.length;
    // Circle center into the polygon's LOCAL frame: translate, then rotate by -angle,
    // so the outline turns with the entity instead of being stuck axis-aligned.
    const col = this._polyTrig(poly);
    const c = col._cos, sn = col._sin;
    const rdx = px - poly.x, rdy = py - poly.y;
    const cx = rdx * c + rdy * sn;
    const cy = -rdx * sn + rdy * c;

    // One pass: nearest boundary point to the circle center, AND an even-odd
    // ray-crossing parity for inside/outside. `j` trails `i` (edge j→i).
    let bestD2 = Infinity, bestX = 0, bestY = 0;
    let inside = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const jx = verts[j].x, jy = verts[j].y;
      const ix = verts[i].x, iy = verts[i].y;
      // Closest point on segment (j→i) to (cx,cy).
      const ex = ix - jx, ey = iy - jy;
      const len2 = ex * ex + ey * ey || 1;
      let t = ((cx - jx) * ex + (cy - jy) * ey) / len2;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const qx = jx + ex * t, qy = jy + ey * t;
      const ddx = cx - qx, ddy = cy - qy;
      const d2 = ddx * ddx + ddy * ddy;
      if (d2 < bestD2) { bestD2 = d2; bestX = qx; bestY = qy; }
      // Even-odd crossing of a +x ray from (cx,cy) through edge i↔j.
      if ((iy > cy) !== (jy > cy) && cx < ((jx - ix) * (cy - iy)) / (jy - iy) + ix) {
        inside = !inside;
      }
    }

    const dist = Math.sqrt(bestD2);
    // Normals are built in the local frame, then rotated back to world by +angle.
    let nlx = 1, nly = 0;
    if (inside) {
      // Center engulfed — push out toward the nearest wall (and clear by `r`).
      out.overlap = r + dist;
      if (dist > 1e-9) { nlx = (bestX - cx) / dist; nly = (bestY - cy) / dist; }
      out.nx = nlx * c - nly * sn;
      out.ny = nlx * sn + nly * c;
      return true;
    }
    if (dist >= r) return false; // outside and not reaching the nearest edge
    out.overlap = r - dist;
    if (dist > 1e-9) { nlx = (cx - bestX) / dist; nly = (cy - bestY) / dist; }
    out.nx = nlx * c - nly * sn;
    out.ny = nlx * sn + nly * c;
    return true;
  }

  /**
   * Optional: turn the flat pair list into a per-entity index, so you can ask
   * "what is entity X touching?". Only build this if your response logic needs
   * it — a symmetric response (push-apart) can just iterate the flat pairs.
   *
   * @param {Collision[]} collisions
   * @returns {Map<CollisionEntity, CollisionEntity[]>}
   */
  groupByEntity(collisions) {
    const map = new Map();
    for (let i = 0; i < collisions.length; i++) {
      const { a, b } = collisions[i];
      let listA = map.get(a);
      if (listA === undefined) { listA = []; map.set(a, listA); }
      listA.push(b);
      let listB = map.get(b);
      if (listB === undefined) { listB = []; map.set(b, listB); }
      listB.push(a);
    }
    return map;
  }
}
