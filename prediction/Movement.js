// Movement — the per-entity "how do I move" strategies, dispatched in the engine
// step's intended-movement phase. An entity names one via its def (`movement: "seek"
// | "orbit" | …`, default "seek") and the step looks it up here.
//
// This is the DECISION layer only — a strategy sets heading/momentum (or, for a
// KINEMATIC strategy, scripts its position directly). The universal INTEGRATION
// (apply momentum + knockback to position, clamp to walls) stays in GameEngine.step
// and is shared by every entity.
//
// Targeting is SEPARATE: it picks WHO to chase (fills `targetAlly`); `seek` only
// CONSUMES that. So any target source (input, targeting, none) composes with any
// movement (seek, orbit, …) — a petal can target the nearest mob yet move by orbit.

import { angleDelta } from "../calculations/Angles.js";
import { clamp } from "../calculations/Scalars.js";

const DEG = Math.PI / 180; // degrees → radians (orbit `speed` is degrees/tick)

// Max radians/tick the stick contact normal may swing (see `applyStick`). A petal
// riding a surface turns its normal at roughly `anchor speed / enemy radius` — a few
// degrees a tick — so this leaves normal gliding untouched and only bites on the
// medial-axis flip, stretching that 180° jump into a ~9-tick slide around the enemy.
const STICK_TURN = 0.35;

/** Slew `from` toward `to` by at most `maxStep` radians, the short way around. Pure.
 * Used by `seek` for rate-limited turning (a mob that pivots instead of snapping).
 * The short-way part is `angleDelta`; this only adds the per-step rate limit. */
function turnToward(from, to, maxStep) {
  return from + clamp(angleDelta(from, to), -maxStep, maxStep);
}

/**
 * STICK: pin a stuck orbiter to the surface of `e.stick` instead of letting it sit on
 * its orbit anchor, so it GLIDES along the enemy rather than passing through it (or
 * being bounced off).
 *
 * The whole trick is that the test point is the orbit ANCHOR `(ax, ay)` — the bare
 * rotating point, disturbed by nothing — and NOT the petal's own body. The petal is
 * deliberately left overlapping, so testing IT would report a hit forever and the
 * stick would never release; the anchor keeps sweeping regardless of where the petal
 * is pinned, so "the anchor is clear" is a release condition that always arrives.
 *
 * Placement, given the enemy's outward normal `n` at the anchor's nearest surface
 * point and the anchor's penetration `overlap`:
 *
 *     push = max(0, overlap - stickDepth);   position = anchor + n × push
 *
 * i.e. slide the petal back out along the normal until it is exactly `stickDepth`
 * deep — landing its center `collisionRadius - stickDepth` clear of the surface, the
 * same result for a barely-grazing anchor and one buried at the enemy's center. The
 * `max(0, …)` matters: without it a contact SHALLOWER than `stickDepth` would be
 * yanked deeper on latch and spat back out on release, popping at both ends. With it,
 * shallow contact leaves the petal exactly where the spring already had it, so stick
 * engages and disengages continuously.
 *
 * Velocity is zeroed (like the safety snap) so the integration phase adds nothing on
 * top of the scripted position — which is also what drops the petal's knockback: it
 * was accumulated in the collision phase and is discarded here, unapplied, while the
 * ENEMY's own accumulator is untouched and still shoves it away.
 *
 * @param {object} e The stuck orbiter.
 * @param {number} ax Orbit anchor x. @param {number} ay Orbit anchor y.
 * @param {number} fdt Frame-equivalent scale (rate-independent normal slew).
 * @param {import("../memory/SpatialGrid.js").SpatialGrid} grid
 * @param {import("./collisions/Collisions.js").Collisions} collisions
 * @returns {boolean} true if the petal was pinned (caller skips the spring), false if
 *   the stick released (caller falls through to normal orbiting).
 * @private
 */
function applyStick(e, ax, ay, fdt, grid, collisions) {
  const enemy = e.stick;
  // Released: target gone/dead, or (the normal case) the anchor swept clear of it.
  // Also bails when there's no collision system to ask — a bare `MOVEMENT.orbit`
  // call outside the engine step just orbits.
  if (enemy.dead || collisions === undefined || collisions === null) { releaseStick(e); return false; }
  const hit = collisions.probe(ax, ay, e.collisionRadius, enemy);
  if (hit === null) { releaseStick(e); return false; }

  // `probe`'s normal points anchor → enemy; we want the enemy's OUTWARD normal.
  let nx = -hit.nx;
  let ny = -hit.ny;
  // Rate-limit the swing so a nearest-surface flip can't teleport the petal (see
  // STICK_TURN). Skipped on the first tick of a stick, which has no previous normal.
  if (e.stickNX !== 0 || e.stickNY !== 0) {
    const turned = turnToward(Math.atan2(e.stickNY, e.stickNX), Math.atan2(ny, nx), STICK_TURN * fdt);
    nx = Math.cos(turned);
    ny = Math.sin(turned);
  }
  e.stickNX = nx;
  e.stickNY = ny;

  const push = hit.overlap > e.stickDepth ? hit.overlap - e.stickDepth : 0;
  let px = ax + nx * push;
  let py = ay + ny * push;

  // Refine. `push` is the depth measured at the ANCHOR, but it's applied along the
  // rate-limited normal — and while that limit is active (a flip) the two disagree, so
  // sliding by `push` doesn't actually surface the petal by `push` and it ends up
  // visibly buried. Re-probe where we're about to put it and correct by whatever depth
  // is really there. This can only ever push further OUT: penetration is 1-Lipschitz in
  // position, so a move of `push` sheds at most `push` of it and the petal is always
  // still at least `stickDepth` deep — the probe can't miss and the correction can't
  // overshoot into a gap. One pass gets it within a pixel; two settles the flip.
  for (let i = 0; i < 2; i++) {
    const check = collisions.probe(px, py, e.collisionRadius, enemy);
    if (check === null) break; // unreachable by the argument above, but don't trust it
    const fix = check.overlap - e.stickDepth;
    if (fix <= 0.01) break;
    px += nx * fix;
    py += ny * fix;
  }

  e.momentum = 0;
  e.knockbackX = 0;
  e.knockbackY = 0;
  e.moveTo(px, py, grid);
  return true;
}

/** Drop a stick link and its remembered normal, so the next latch starts clean
 * instead of rate-limiting away from a stale enemy's normal. @private */
function releaseStick(e) {
  e.stick = null;
  e.stickNX = 0;
  e.stickNY = 0;
}

/**
 * Named movement strategies. Each is `(entity, fdt, decay, grid, collisions) => void`,
 * run once per entity per step. `fdt` = frame-equivalent scale (rate independence),
 * `decay` = the per-step friction factor, `grid` = the world index (for a kinematic
 * `moveTo`), `collisions` = the collision system (for shape queries; may be absent).
 */
export const MOVEMENT = {
  /**
   * Seek: aim the heading at the entity's `target` point and push at `speed`. The
   * default for mobs (target = the locked ally, refreshed to its live position) AND
   * the input-driven player (target = the point `Inputs` set). No target → no move.
   * This is verbatim the engine's original intended-movement phase.
   */
  seek(e, fdt, decay) {
    if (!e.hasTarget) return;
    // Track the locked ally's LIVE position so the heading aims where it IS, not the
    // stale point from the last (periodic) retarget. The player has no targetAlly and
    // keeps its input-set point.
    if (e.targetAlly !== null) {
      e.target.x = e.targetAlly.x;
      e.target.y = e.targetAlly.y;
    }
    const desired = Math.atan2(e.target.y - e.y, e.target.x - e.x);
    if (e.turnRate > 0) {
      // Rate-limited turn: slew toward the target by at most turnRate/tick, then move
      // along the new heading (a mob that pivots gradually).
      e.direction = turnToward(e.direction, desired, e.turnRate * fdt);
      e.addMovement(e.direction, e.speed * (1 - decay));
    } else {
      e.addMovement(desired, e.speed * (1 - decay)); // instant aim (default)
    }
  },

  /**
   * Orbit: a SPRING toward a moving "home" point. Each tick the home advances by `speed`
   * (DEGREES/tick) in `orbitDir` (±1 spin) around `parent` — `parent.pos +
   * polar(orbitAngle, orbitRadius)`. The entity then adds intended movement TOWARD that
   * home, at a speed that grows with how far it currently is (`orbitPull × distance`).
   * It does NOT force its position, so the normal integration applies momentum AND
   * knockback — an enemy can shove it off and the spring reels it back. No parent (out
   * of view / not linked) → hold still this step.
   *
   * `orbitRigid` in the def swaps the spring for direct placement: no standing lag, so
   * the ring never trails a moving owner, at the cost of the entity being immovable by
   * knockback. See `Entity#orbitRigid`.
   *
   * STICK overrides the spring: while `e.stick` is set the entity is pinned to that
   * enemy's surface instead (see `applyStick`), which also pre-empts the safety snap —
   * a stuck petal is held at most `enemy radius + its own` from the anchor, well inside
   * any sane `orbitSnap` threshold, so the snap has nothing to fix.
   */
  orbit(e, fdt, decay, grid, collisions) {
    if (e.parent === null) return;
    // The ANCHOR — a point that just rotates around the parent by its own `speed` and
    // time, disturbed by NOTHING. (Orbiters are kept always-awake, so this never stalls.)
    // WHERE ON THE CIRCLE. On a managed ring the RING owns the rotation and this petal
    // owns only its NUMBER, so the angle is derived — `(index / ringSize) × 2π` plus the
    // ring's rotation — never integrated here. That's the point: every petal on a ring
    // reads the same rotation, so they physically cannot drift out of formation. Petals
    // used to each advance their own angle by their own `speed`, which is rarity-scaled,
    // so any mixed-rarity loadout slowly came apart.
    // A lone orbiter with no ring (no `orbitIndex`, or a parent that owns no ring) still
    // advances itself, so a plain "circle this thing" entity works without a hotbar.
    // Keyed on the BASE, not the index: the index needs the ring's size to turn into an
    // angle, and a client only ever receives the base (see the `oba` snapshot field).
    if (e.orbitBase >= 0) {
      e.orbitAngle = e.orbitBase + e.parent.orbit1Rotation;
    } else {
      e.orbitAngle += e.speed * DEG * e.orbitDir * fdt;
    }
    const ax = e.parent.x + Math.cos(e.orbitAngle) * e.orbitRadius;
    const ay = e.parent.y + Math.sin(e.orbitAngle) * e.orbitRadius;
    // Stuck to an enemy → ride its surface off the anchor and skip the spring entirely.
    // `stickDepth > 0` is the opt-in gate (and keeps this off for anything without it).
    if (e.stickDepth > 0 && e.stick !== null && applyStick(e, ax, ay, fdt, grid, collisions)) return;
    // RIGID: sit exactly on the anchor. A spring can't do this — it needs to be
    // stretched to pull, so it always trails a moving anchor by however far it takes to
    // generate the force to keep up. Placing directly has no such standing error, so the
    // ring stays welded to its owner at any speed.
    if (e.orbitRigid) {
      e.momentum = 0;
      e.knockbackX = 0;
      e.knockbackY = 0;
      e.moveTo(ax, ay, grid);
      return;
    }

    const dx = ax - e.x, dy = ay - e.y;
    const dist = Math.hypot(dx, dy);
    // Strayed too far (flung / wedged) → hard-snap to the anchor. Threshold is
    // `orbitSnap × orbitRadius` (so e.g. orbitSnap 2 = snap at twice the orbit radius).
    if (e.orbitSnap > 0 && dist > e.orbitSnap * e.orbitRadius) {
      e.momentum = 0;
      e.knockbackX = 0;
      e.knockbackY = 0;
      e.moveTo(ax, ay, grid);
      return;
    }
    if (dist > 0) {
      // Pull the physical petal toward its anchor, growing with the SQUARE of the distance
      // (normalized by radius) — gentle near home, much harder the farther it's strayed, so
      // the farther it goes the faster it heads back. Capped at `dist` so it can't overshoot
      // into an oscillation. Momentum-based, so knockback still shoves it off and it returns.
      let target = e.orbitPull * dist * dist / e.orbitRadius;
      if (target > dist) target = dist;
      e.addMovement(Math.atan2(dy, dx), target * (1 - decay));
    }
  },
};

/** Strategies whose position is SCRIPTED, not integrated from momentum. The step skips
 * momentum-integration for these (they already placed themselves); it only clears their
 * per-step knockback. (None currently — `orbit` is a spring that DOES integrate, so it
 * can be knocked — but the mechanism stays available for truly scripted movement.) */
export const KINEMATIC = new Set();
