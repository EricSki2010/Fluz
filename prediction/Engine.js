import { MemorySubsystem } from "../memory/MemorySubsystem.js";
import { Mechanics } from "./Mechanics.js";
import { Disposition } from "../entities/Disposition.js";
import { pointInAnyRegion } from "../calculations/Regions.js";
import { TWO_PI } from "../calculations/Angles.js";
import { tickFades } from "../entities/Entity.js";
import { MOVEMENT, KINEMATIC } from "./Movement.js";

// Step tuning (PLACEHOLDERS — balance later).
const ACTIVE_MARGIN = 1.5; // simulate entities within 1.5× the camera rect
const RETARGET_INTERVAL = 10; // entities re-pick targets every N steps
const KNOCKBACK_DENSITY_CAP = 20; // max bounce from the density ratio (other/me)
const MOVE_THRESHOLD = 0.5; // intended movement below this is zeroed
const MOVE_DECAY = 0.2; // intended movement is scaled by this PER REFERENCE TICK (friction)

// Reference tick rate the movement/decay constants are tuned for. `step(dt)`
// scales movement (and the decay smoothing) by `dt × TICK_RATE`, so real-world
// speed is the same regardless of the actual sim rate or render framerate —
// change `SIM_HZ` freely without retuning, and slow machines stay in sync.
export const TICK_RATE = 60;

// Level-of-detail: entities NOT inside any real render region (the active-set
// margin + the corner padding created when regions merge) are simulated only
// every LOD_STRIDE steps, moving LOD_STRIDE× as far when they do — average speed
// unchanged, ~1/LOD_STRIDE the cost. Entities inside a render region always run
// full-rate, so the throttle is invisible to players; it's what makes the merged
// corners cheap. (Step phase is offset by id so cold entities don't bunch up.)
const HOT_MARGIN = 1.05; // inside a render region ×this (edge slack) → "hot"
const LOD_STRIDE = 4; // cold entities simulate every Nth step
const FULL_SWEEP_INTERVAL = 60; // every Nth step, sim ALL entities (incl. at-rest)


/**
 * Knockback magnitude applied to `me`, caused by colliding with `other`. The push
 * is along `(pushX,pushY)` — the unit normal pointing FROM `other` toward `me`
 * (i.e. away from `other`). Three additive parts:
 *   - `p` — base separation: `(other.density / (me.density+other.density)) × overlap`,
 *     so a denser `other` drives `me` out harder (a light `me` is flung, a heavy
 *     `me` barely budges).
 *   - density bounce — `other.density / me.density`, capped at `KNOCKBACK_DENSITY_CAP`
 *     (a much-denser `other` flings a light `me` hard, but never unboundedly).
 *   - momentum intent — how hard `me` is charging INTO the contact (toward
 *     `other`): its OWN `momentum` times how aligned its heading is OPPOSITE the
 *     push direction (clamped dot — 1 = charging straight in, 0 = perpendicular or
 *     already moving away). So a mob ramming a wall bounces itself back, while a
 *     stationary `me` (momentum 0) gets no intent push — the thing it hit only
 *     adds intent if IT is the one moving in.
 * Pure. @private
 */
function knockbackMagnitude(me, other, overlap, pushX, pushY) {
  const p = (other.density / (me.density + other.density)) * overlap;
  const ratio = other.density / me.density;
  const densityBounce = ratio < KNOCKBACK_DENSITY_CAP ? ratio : KNOCKBACK_DENSITY_CAP;
  // How much `me` is heading INTO the contact = its heading aligned opposite the
  // push (which points away from `other`). Only `me`'s own charge bounces it back.
  let intent = -(Math.cos(me.direction) * pushX + Math.sin(me.direction) * pushY);
  if (intent < 0) intent = 0; // perpendicular or already moving away → nothing
  return p + densityBounce + intent * me.momentum;
}

/**
 * May `sticker` latch onto `other` and ride its surface? True only for a target it
 * would actually DAMAGE on contact — which is the useful reading of "an enemy" here.
 *
 * Deliberately NOT a disposition test. `disposition` says how a thing BEHAVES, not
 * whose side it's on: a rock and a petal container are both `passive`, yet one is the
 * main thing you hit and the other is inert scenery. Reusing the damage gate's own
 * fields instead means stick and contact damage can never disagree about what counts as
 * a target — a petal sticks to exactly what it hurts, so it can't end up glued to a HUD
 * prop, a teammate's petal, or another player.
 * @private
 */
function canStickTo(sticker, other) {
  if (sticker.stickDepth <= 0 || sticker.stick !== null) return false;
  const otherAllied = other.disposition === Disposition.ALLIED;
  const damage = otherAllied ? sticker.contactDamageAllies : sticker.contactDamage;
  return damage > 0 && other.damageable && (!otherAllied || other.takesAllyDamage);
}

/**
 * Central coordinator for the game's simulation side — the counterpart to
 * `VisualEngine`. Where `VisualEngine` owns drawing and the spatial index,
 * `GameEngine` owns the rules: mechanics, collisions, and (later) AI.
 *
 * Other parts of the app talk to `GameEngine.shared` rather than reaching into
 * the subsystem folders directly.
 *
 * Usage (rough):
 *     const grid = GameEngine.shared.memory.worldMap;
 *     const hits = GameEngine.shared.mechanics.collisions.detect(entities, grid);
 *     for (const { a, b } of hits) { ...resolve... }
 */
export class GameEngine {
  constructor() {
    /** Authoritative world state — the spatial index. See `memory/MemorySubsystem.js`. */
    this.memory = new MemorySubsystem();

    /** Rules/simulation logic. See `mechanics/Mechanics.js`. */
    this.mechanics = new Mechanics();

    /** Steps elapsed — drives the periodic retarget. @private */
    this._stepCount = 0;
    /** Reused active-entity buffer (filled by the grid query each step). @private */
    this._active = [];
    /** Reused membership set for active entities. @private */
    this._activeSet = new Set();
    /** Reused buffer of entities actually simulated this step (the awake +
     * scheduled subset of `_active`). @private */
    this._sim = [];
    /** Reused per-region grid-query buffer (each region's hits are folded into the
     * one combined `_active` set). @private */
    this._regionBuf = [];
    /** Reused accumulator for the tick's collisions. @private */
    this._allHits = [];

    /** Optional barrier collision field (see `WorldGeneration/WallField.js`). When
     * set, each entity's per-frame displacement is clamped to the walls at the
     * integration step. Null → no world barriers. Set by the world builder. */
    this.walls = null;
  }

  /**
   * Advance THIS world's simulation by one tick. Each world instance steps
   * independently (its own grid + mechanics), which is what multiple rooms need.
   *
   * **Single combined-area sim.** The given regions (one per player on a server)
   * are folded into ONE shared active set — the union of each region's
   * neighbourhood — and stepped ONCE. There's no per-region merge and no separate
   * passes: overlapping AND disjoint players all simulate together in one map, so
   * a mob near two players, or straddling two views, is handled exactly once with
   * no ownership ambiguity. Querying each region separately (rather than one big
   * bounding box) means spread-out players never pay to sweep the gap between them.
   *
   * The pipeline, run once over the combined set:
   *   1. Active set — the union of every region's box expanded by `ACTIVE_MARGIN`
   *      (so just-outside things still simulate), deduped across overlaps.
   *   2. Retarget every `RETARGET_INTERVAL` steps (see `entities/Targeting.js`):
   *      hostile/aggroed mobs lock onto the nearest ALLIED entity, chosen from a
   *      GLOBAL ally list (every player in the area) so iteration order can't bias
   *      it. A sleeping mob wakes when an ally comes in range.
   *   3. Sim set — the subset actually simulated: AWAKE (moving / knocked / has a
   *      target — at-rest mobs are skipped, #2) and SCHEDULED. "Hot" = inside a
   *      real render region (`regionList`) → every step; "cold" = only in the
   *      margin → every `LOD_STRIDE` steps (#5). The grid still holds everyone, so
   *      a mover still collides with sleepers.
   *   4. Collision detection over the sim set (penetration + contact normal).
   *   5. Knockback — push each entity away from the other: a penetration-based
   *      separation term + a capped density-ratio bounce + how hard the entity
   *      itself is charging into the contact (its own momentum × heading
   *      alignment, so a mob ramming something bounces itself back). See
   *      `knockbackMagnitude`. Lands on any active entity (waking a struck
   *      sleeper). Accumulated, SEPARATE from intended movement.
   *   6. Intended movement — each sim entity adds an impulse toward its target.
   *   7. Integrate (intended movement + knockback) → new positions (grid synced).
   *      Cold entities move LOD_STRIDE× to cover the steps they sat out. A moving
   *      entity also faces its intended heading (`angle = direction`).
   *   8. Clear knockback + decay intended movement.
   *   9. onUpdate — per-entity per-tick self logic over the whole active set.
   *
   * @param {{x:number,y:number,width:number,height:number}
   *   | Array<{x:number,y:number,width:number,height:number}>} regions One
   *   render region, or an array of them (center + size, world units) — one per
   *   player on a server. All are unioned into the single combined sim. Allied
   *   targets (player / pets) are discovered from that union, so no separate
   *   player arg.
   * @param {number} [dt] Seconds of game time this tick represents. Movement and
   *   timers scale by it, so real speed is rate-independent. Defaults to
   *   `1 / TICK_RATE` (the reference rate → no scaling, the original behaviour).
   * @param {{retarget?:boolean, collide?:boolean, attributes?:boolean, onUpdate?:boolean}} [opts]
   *   Phase switches (each defaults ON). `collide` = collision detection + the
   *   physical push-apart (knockback); `attributes` = the collision EFFECTS
   *   (body damage, destroy-on-hit). Split so a CLIENT can run local physics
   *   (so you don't phase through mobs) WITHOUT the authoritative effects. A
   *   client prediction sim passes `{ retarget:false, attributes:false,
   *   onUpdate:false }` (keeping `collide` on) — local movement + push, but
   *   targeting / damage / death stay server-authoritative and arrive via
   *   snapshots. The server passes nothing (full authoritative step).
   * @returns {Array} the collisions detected this tick (reused array).
   */
  step(regions, dt = 1 / TICK_RATE, opts = {}) {
    const grid = this.memory.worldMap;
    const step = ++this._stepCount;
    const regionList = Array.isArray(regions) ? regions : [regions];

    const allHits = this._allHits;
    allHits.length = 0;
    if (opts.collide !== false) this.mechanics.collisions.resetPool(); // free pooled hits

    // ONE combined active set: the union of every region's neighbourhood (each box
    // expanded by ACTIVE_MARGIN), folded into a single deduped list. This is the
    // "single combined-area sim" — overlapping OR disjoint players all land in the
    // one map and step ONCE. Per-region queries (not one big bounding box) keep
    // spread-out players from sweeping the empty space between them.
    const active = this._active;
    active.length = 0;
    const activeSet = this._activeSet;
    activeSet.clear();
    for (let r = 0; r < regionList.length; r++) {
      const region = regionList[r];
      const w = region.width * ACTIVE_MARGIN;
      const h = region.height * ACTIVE_MARGIN;
      const found = grid.query(
        { x: region.x - w / 2, y: region.y - h / 2, width: w, height: h },
        this._regionBuf
      );
      for (let i = 0; i < found.length; i++) {
        const e = found[i];
        if (activeSet.has(e)) continue; // dedup across overlapping regions
        activeSet.add(e);
        active.push(e);
        // Snapshot pre-step POSE for render interpolation (static if unmoved). Facing
        // rides along with position: it steps once per tick too, so a display running
        // faster than the sim needs both to interpolate.
        e.prevX = e.x;
        e.prevY = e.y;
        e.prevAngle = e.angle;
      }
    }

    this._simulate(regionList, active, activeSet, step, grid, allHits, dt, opts);

    // Death fades — purely visual, and driven from here rather than `_simulate`
    // because a fading sprite belongs to an entity that's already OUT of the grid
    // and therefore out of every active set. Once per step per world, keyed on this
    // world's grid so a server stepping several worlds doesn't tick a fade twice.
    // NOT gated by `opts`: a client prediction sim has to dissolve its sprites too.
    tickFades(grid);
    return allHits;
  }

  /**
   * Run the simulation pipeline ONCE over the pre-built combined active set:
   * retarget, sim-set selection, collisions/knockback/attributes, intended
   * movement, integration, onUpdate. `step` builds the active set (the union of
   * all regions) and calls this a single time, so every player's neighbourhood —
   * overlapping or not — is simulated together in one shared pass.
   *
   * @param {Array} regionList The real render regions (drives the hot/cold LOD split).
   * @param {Array} active The combined active set (union of all regions, deduped).
   * @param {Set} activeSet Membership set for `active` (also gates knockback).
   * @param {number} step Current step count (LOD phase).
   * @param {import("../memory/SpatialGrid.js").SpatialGrid} grid
   * @param {Array} allHits Accumulator the tick's collisions are pushed into.
   * @param {number} dt Seconds this tick represents (for rate-independent motion).
   * @param {{retarget?:boolean, collide?:boolean, attributes?:boolean, onUpdate?:boolean}} opts
   *   Phase switches (see `step`). Each defaults ON unless explicitly `false`.
   * @private
   */
  _simulate(regionList, active, activeSet, step, grid, allHits, dt, opts) {
    const sources = regionList; // "hot" = inside a real view region (HOT_MARGIN edge)

    // Frame-equivalent scale: 1 at the reference rate, 2 at half-rate, etc. All
    // movement displacement is multiplied by it, and the decay smoothing is
    // raised to it, so both steady-state speed AND acceleration are the same in
    // real time regardless of `dt`.
    const fdt = dt * TICK_RATE;
    const decay = Math.pow(MOVE_DECAY, fdt);

    // 2. Periodic retargeting over the combined active set (so a sleeping/cold mob
    //    can re-acquire a target — and thus wake — when an ally comes in range).
    //    AUTHORITATIVE: a client prediction sim skips this (targets come from

    // 3. Sim set: awake (#2) AND scheduled this step (#5). "Hot" = inside one of
    //    the real render regions (HOT_MARGIN edge slack) → every step;
    //    "cold" = only margin/merge-padding → every LOD_STRIDE, id-phased.
    const sim = this._sim;
    sim.length = 0;
    // Every FULL_SWEEP_INTERVAL steps, sim EVERYONE regardless of awake state, so
    // at-rest mobs are periodically re-checked (e.g. resolve a settled overlap).
    const fullSweep = step % FULL_SWEEP_INTERVAL === 0;
    for (let i = 0; i < active.length; i++) {
      const e = active[i];
      const awake =
        e.momentum > 0 || e.knockbackX !== 0 || e.knockbackY !== 0 || e.hasTarget || e.wakeTicks > 0 ||
        e.parent !== null; // attached entities (petals) must keep tracking their parent
      if (!awake && !fullSweep) continue; // #2: at-rest mobs aren't swept or moved (a
      //    just-spawned one stays awake for SPAWN_WAKE_TICKS so a spawn-overlap can push apart)
      const hot = pointInAnyRegion(e.x, e.y, sources, HOT_MARGIN);
      if (fullSweep || hot || (step + e.id) % LOD_STRIDE === 0) sim.push(e); // #5
    }

    // 4-5. Collisions + knockback + attributes. AUTHORITATIVE: a client prediction
    //    sim skips this whole block (no local damage/death/push — those are
    //    server-decided and arrive via snapshots), so its world can't diverge on
    //    things it isn't allowed to decide.
    if (opts.collide !== false) {
      // 4. Collisions over the sim set (grid still indexes every active entity, so
      //    a moving entity is still tested against sleeping neighbours).
      const hits = this.mechanics.collisions.detect(sim, grid);

      // 5. Knockback (see `knockbackMagnitude`): base separation + a capped
      //    density-ratio bounce + how hard the OTHER entity is driving into this one.
      //    Two-sided + gated: an entity is pushed only if IT receives knockback
      //    (`knockbackSelf`) AND the other IMPARTS it (`knockbackOthers`). So an
      //    immovable wall (self off) still shoves movers; a weightless thing (others
      //    off) slides away without pushing; both off → phases through untouched.
      //    Collision is still DETECTED either way, so attributes (body damage,
      //    destroy-on-hit, …) fire regardless — a no-op unless one carries `collided`.
      //    `nx,ny` is the unit normal from `a` toward `b`, so `a` is pushed along
      //    −n (away from `b`) and `b` along +n (away from `a`).
      for (let i = 0; i < hits.length; i++) {
        const hit = hits[i];
        const { a, b, overlap, nx, ny } = hit;
        // Whether a pusher shoves THIS victim depends on the victim's disposition: a
        // pusher uses `knockbackAllies` against an ALLIED victim, else `knockbackOthers`
        // (mirroring how the server gates contact damage). Lets a petal push enemies
        // but not allies.
        const bPushesA = a.disposition === Disposition.ALLIED ? b.knockbackAllies : b.knockbackOthers;
        if (a.knockbackSelf && bPushesA) {
          const onA = knockbackMagnitude(a, b, overlap, -nx, -ny);
          a.addKnockback(-nx * onA, -ny * onA); // `a` is always in the sim set
        }
        const aPushesB = b.disposition === Disposition.ALLIED ? a.knockbackAllies : a.knockbackOthers;
        if (b.knockbackSelf && aPushesB && activeSet.has(b)) {
          // `b` may be a sleeper — the knockback wakes it (next step it's awake).
          const onB = knockbackMagnitude(b, a, overlap, nx, ny);
          b.addKnockback(nx * onB, ny * onB);
        }
        // STICK acquisition. An orbiter carrying `stickDepth` latches onto an ENEMY it
        // just hit — see `canStickTo`, which defines that as "something this entity
        // would damage", so inert scenery and anything on its own side are excluded.
        // `MOVEMENT.orbit` then rides that enemy's surface (and decides when to let go —
        // from the ORBIT ANCHOR, not from this contact, which by design never stops
        // overlapping). Only latches when free, so a petal already gliding on one enemy
        // isn't yanked between two it's touching at once. NOT gated on `attributes`: the
        // client's prediction sim must latch the same way or its locally-simulated petals
        // — which the reconcile deliberately never repositions — would phase straight
        // through. The server still has the last word via the snapshot's `stk` field.
        if (!a.dead && !b.dead) {
          if (canStickTo(a, b)) a.stick = b;
          if (canStickTo(b, a)) b.stick = a;
        }
        allHits.push(hit); // detect allocates fresh hit objects, so refs are safe
      }
    }

    // 5b. ORBIT RINGS turn — once per tick, on the ring's OWNER. This is the single
    //     integrator for a ring: every petal on it derives its angle from this rotation
    //     plus its own index, so nothing can drift out of formation (petals used to each
    //     advance their own angle, which came apart the moment two of them had different
    //     speeds — `speed` is rarity-scaled, so that was any mixed-rarity loadout).
    //     Over the ACTIVE set, not the sim set: a player standing perfectly still isn't
    //     "awake", and their petals must not freeze with them. NOT gated by any `opts` —
    //     the client has to turn its rings too or its locally-simulated petals stall.
    for (let i = 0; i < active.length; i++) {
      const e = active[i];
      if (e.orbit1Speed === 0) continue;
      e.orbit1Rotation = (e.orbit1Rotation + e.orbit1Speed * fdt) % TWO_PI;
      if (e.orbit1Rotation < 0) e.orbit1Rotation += TWO_PI;
    }

    // 6. Intended movement — each entity runs its named MOVEMENT strategy ("seek" by
    //    default: aim heading at target, push at speed, pre-scaled by (1 - decay) so
    //    the decay residual keeps steady-state momentum = `speed`). A KINEMATIC
    //    strategy (orbit) instead scripts its own position; phase 7-8 then skips it.
    //    Gets the collision system too, for strategies that need shape queries (orbit
    //    probes its anchor against the enemy it's stuck to).
    for (let i = 0; i < sim.length; i++) {
      const e = sim[i];
      if (e.dead) continue; // destroyed mid-step (e.g. by a collision attribute)
      const strategy = MOVEMENT[e.movement];
      if (strategy !== undefined) strategy(e, fdt, decay, grid, this.mechanics.collisions);
    }

    // 7-8. Integrate, clear knockback, decay — sim set only. Displacement is
    //      scaled by `fdt` so real travel is rate-independent. Cold entities
    //      integrate LOD_STRIDE× the intended velocity to cover skipped steps;
    //      knockback is applied as-is (already accumulated).
    for (let i = 0; i < sim.length; i++) {
      const e = sim[i];
      // Skip an entity destroyed mid-step — otherwise `moveTo` below would
      // re-insert it into the grid (`grid.update` inserts if absent), undoing the
      // removal `destroy` just did.
      if (e.dead) continue;
      // Kinematic strategies (orbit) already scripted their position in phase 6 —
      // integrating momentum here would drag them off along the tangent. Just clear
      // the per-step knockback accumulator and tick the spawn-wake window down.
      if (KINEMATIC.has(e.movement)) {
        e.knockbackX = 0;
        e.knockbackY = 0;
        if (e.wakeTicks > 0) e.wakeTicks--;
        continue;
      }
      // Facing: an entity with `spin` rotates its own image at a constant rate,
      // independent of where it's moving (e.g. a petal). Otherwise it faces its
      // INTENDED heading while moving (a resting/shoved entity keeps its last facing).
      if (e.spin !== 0) e.angle += e.spin * fdt;
      else if (e.momentum > 0) e.angle = e.direction;
      const hot = pointInAnyRegion(e.x, e.y, sources, HOT_MARGIN);
      const lod = hot ? 1 : LOD_STRIDE;
      let vx = (e.momentum * Math.cos(e.direction) * lod + e.knockbackX) * fdt;
      let vy = (e.momentum * Math.sin(e.direction) * lod + e.knockbackY) * fdt;
      // Barriers: clamp the intended displacement to the wall, one axis at a time
      // (x against the current row, then y against the post-x position → sliding).
      if (this.walls !== null) {
        vx = this.walls.clampX(e.x, e.y, e.collisionRadius, vx);
        vy = this.walls.clampY(e.x + vx, e.y, e.collisionRadius, vy);
      }
      if (vx !== 0 || vy !== 0) e.moveTo(e.x + vx, e.y + vy, grid);
      e.knockbackX = 0;
      e.knockbackY = 0;
      if (e.wakeTicks > 0) e.wakeTicks--; // spawn-wake window counts down only while simmed
      e.decayMovement(MOVE_THRESHOLD, decay);
    }


  }

  /**
   * Singleton instance — the canonical reference other files load.
   * @type {GameEngine}
   */
  static get shared() {
    if (!GameEngine._shared) {
      GameEngine._shared = new GameEngine();
    }
    return GameEngine._shared;
  }
}
