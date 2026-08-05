// Client — the browser side. Renders the world the server streams; never
// authoritative. It runs a FULL local simulation AND consumes the server's
// snapshots on a fixed delay. The two combine:
//
//   LOCAL SIM (responsive): the client owns its own GameEngine and steps it every
//     frame — your own player moves on local input, and nearby mobs chase / move
//     toward their (server-decided) targets locally and smoothly. The authoritative
//     DECISIONS — who targets whom, damage, death — stay on the server (that step
//     runs with those phases off). So nothing ever waits on the network to move,
//     and nothing freezes on a lag spike.
//
//   DELAYED BUFFER (smooth + jitter-proof): snapshots aren't used the instant they
//     arrive — they're buffered and "played out" a fixed delay (PLAYOUT_DELAY)
//     behind their server timestamp. Each frame the client builds an interpolated
//     authoritative state at (newest − delay) from the two snapshots bracketing it,
//     and RECONCILES the local sim toward it. The delay is the cushion: a snapshot
//     that arrives a few ms late still lands inside the window, so the reconcile
//     target keeps moving smoothly instead of stuttering. This applies to EVERYONE.
//     Other players (the one thing the client can't simulate — they're driven by a
//     remote human's input) follow that delayed interpolation directly, which is
//     exactly the smooth real-data movement we want.
//
// Input goes up as timestamped commands; the SERVER stays the one authority.
// Entity defs must be loaded (`loadEntityDefs()`) first — the client rebuilds
// entities from snapshots.

import { GameEngine } from "../prediction/Engine.js";
import { Entity } from "../entities/Entity.js";
import { WallField } from "../prediction/WallField.js";
import { lerpAngle } from "../calculations/Angles.js";
import { cmdMoveDir, cmdMoveToward, cmdStop, cmdView, cmdWarp, cmdSwapPetal, cmdSwapAllPetals, cmdAccountInfo, cmdSignUp, cmdSignIn, MSG } from "./protocol/Protocol.js";

/** Monotonic-ish clock in ms (browser `performance.now`, else `Date.now`). @private */
const now = (typeof performance !== "undefined" && performance.now)
  ? () => performance.now()
  : () => Date.now();

const LOCAL = "self";                    // local-sim input controller id
const SIM_HZ = 60;                       // must match the server tick rate
/** Client local-sim step: movement + collision PHYSICS (so you don't phase through
 * mobs), but NOT the authoritative decisions — targeting, damage/death and
 * onUpdate stay server-only and arrive via snapshots. @private */
const CLIENT_OPTS = Object.freeze({ retarget: false, collide: true, attributes: false, onUpdate: false });

// Interpolate mobs/others this far behind the newest snapshot — the jitter cushion.
// Must comfortably exceed the snapshot spacing so two snapshots always bracket the
// playout time: at the default 20Hz broadcast (server `snapshotEvery:3`) that's 50ms
// apart, so 120ms ≈ 2.4 intervals — enough to ride out a dropped snapshot too. Raise
// it if you broadcast less often (larger `snapshotEvery`).
const PLAYOUT_DELAY = 120;
const RESYNC_MS = 250;                   // snap the playout clock if it drifts this far
const BUFFER_MS = 300;                   // keep ~0.3s of snapshots (≥6 at 20Hz — plenty to interpolate)

const DEBUG_DEFAULT = false;             // reconcile diagnostics off by default; set `client.debug = true` to log
const DEBUG_EVERY = 30;                  // frames between throttled log lines (~0.5s at 60fps)

const PLAYER_BLEND = 0.15;               // pull our own player toward the server pos past its deadzone
const MOB_BLEND = 0.3;                   // pull a mob toward the server pos past its deadzone
const IDLE_BLEND = 0.4;                  // snappier convergence when an entity is at rest
/** Deadzone = wiggle room before we correct. The key to killing BOTH the backward
 * tug and the persistent offset: trust the local prediction WHILE MOVING (a wide
 * deadzone, since the prediction legitimately leads the authoritative pose), but
 * converge TIGHTLY when at rest (a tiny deadzone, so any residual desync closes
 * instead of sitting there forever — the diagnostics showed self stuck ~22u off
 * while idle). The moving values are sized above the measured lead: self rode
 * ~30–56u ahead, a moving mob ~33u. @private */
const PLAYER_DEADZONE_MOVE = 64;         // moving: trust our own input prediction
const PLAYER_DEADZONE_IDLE = 3;          // at rest: snap onto the server pos
const MOB_DEADZONE_MOVE = 46;            // moving mob: trust the local sim's lead
const MOB_DEADZONE_IDLE = 3;             // resting mob: sit exactly on the server pos

/** Camera follow-lag: seconds for the view to close HALF the gap to the player.
 * Higher = floatier/laggier, lower = snappier. Governs ONLY the camera scroll.
 * Applied frame-rate-independently (`1 - 2^(-dt/halflife)`), identical at any FPS.
 * @private */
const CAMERA_HALFLIFE = 0.12;
/** Player-render follow-lag: how far the drawn player trails its true collision
 * pos. Smaller = drawn closer to its collision box (but reconcile tugs are
 * filtered less, so they show more). Independent of the camera, so the player can
 * sit near its box while the camera stays floaty (it'll lead screen-center while
 * moving, since it follows tighter than the camera). @private */
const PLAYER_RENDER_HALFLIFE = 0.035;
/** Same idea for every OTHER entity. Looser than the player's because a mob's true
 * position is corrected in bigger discrete steps (`MOB_BLEND` past a deadzone) rather
 * than input-predicted, so it needs more filtering to read as smooth — and unlike the
 * player, nobody is judging a mob's pixels against their own input. @private */
const ENTITY_RENDER_HALFLIFE = 0.06;
// A petal's ORBITAL offset from its parent — how it moves AROUND the body, as opposed
// to how the body moves — uses an ADAPTIVE halflife rather than a fixed one, because the
// two things it has to handle want opposite settings:
//   - Ordinary orbiting is fast, smooth, high-frequency motion. Filtering it hard shrinks
//     the drawn orbit radius and lags the ring behind its true angle, so when the petal
//     is near where it belongs the filter should be GENTLE and let it ease.
//   - A ring rebuild, a reconcile step or a stick release can move it a long way at once.
//     Easing gently through that reads as the petal swimming back into place, so a large
//     error should be closed FAST.
// So the halflife slides from SOFT to TIGHT as the error grows, smoothly (smoothstep, no
// kink) — the response depends only on how far off it is, never on frame timing or how
// late a snapshot was, so server jitter can't change how the motion feels.
/** Halflife when the petal is essentially where it belongs — gentle, so it's free to run
 * a little ahead or behind and ease back rather than being chased. @private */
const PETAL_SOFT_HALFLIFE = 0.02;
/** Halflife once the error reaches {@link PETAL_CATCHUP_DIST} — snappy catch-up. @private */
const PETAL_TIGHT_HALFLIFE = 0.005;
/** Error (world units) at which the easing is fully tight. Below it the two blend. @private */
const PETAL_CATCHUP_DIST = 24;
/** Gap (× the larger view dimension) beyond which the camera JUMPS instead of
 * panning — so a respawn/teleport doesn't sweep the whole map. @private */
const CAMERA_SNAP_VIEWS = 1.5;

export class GameClient {
  /**
   * @param {import("./transports/WebSocketTransport.js").Connection} conn Link to the server.
   * @param {object} [opts]
   * @param {(ownerId:number, playerId:number)=>void} [opts.onWelcome] Fires once on join.
   * @param {(worldId:string)=>void} [opts.onWorldChange] Fires when the player's
   *   world changes (join + each transfer). The host uses it to rebuild terrain;
   *   the Net layer doesn't touch the view itself.
   * @param {(spawns:Array)=>void} [opts.onSpawn] Fires on a reliable SPAWN event for
   *   the current world (`spawns` = `[{id, def, rarity, x, y, angle}]`). The entities
   *   also arrive via snapshots; this is the one-shot signal for spawn reactions.
   */
  constructor(conn, { onWelcome, onWorldChange, onSpawn } = {}) {
    this.conn = conn;
    this.onWelcome = onWelcome;
    this.onWorldChange = onWorldChange;
    this.onSpawn = onSpawn;
    this.ownerId = null;
    this.playerId = null;
    /** Id of the world the player is currently in (from WELCOME / snapshots). */
    this.worldId = null;
    this.viewWidth = 0;
    this.viewHeight = 0;

    /** Own a real engine; ITS grid is what the view draws (predicted self + mobs +
     *  delayed-interpolated other players all live here). */
    this.sim = new GameEngine();
    // No barriers until a snapshot brings this world's wall faces (see `_applyGeometry`).
    // Deliberately NOT `new WallField()`: that defaults to the TEST room's floor plan,
    // which is both a guess about which world we're joining and the last thing tying
    // the client's barriers to the world generator.
    this.sim.walls = WallField.fromWalls([]);
    /** Floor cells learned so far, as `"cx,cy"` keys. The VIEW holds this exact Set
     *  and re-reads it every frame, so adding to it repaints terrain with no rebuild.
     *  Accumulates: snapshots only carry the patch around the player, and ground we
     *  already walked past shouldn't blink out when it leaves the box. */
    /** Who this connection is signed in as, or `null` for NOT SIGNED IN. Starts null
     *  and stays null until the server says otherwise — the server owns identity, so
     *  the client never assumes one. `undefined` means "haven't asked yet", which the
     *  UI can tell apart from a confirmed "nobody". */
    this.account = undefined;
    /** Reason the last account attempt failed, or null. See the ACCOUNT handler. */
    this.accountError = null;
    /** Bumped on every account reply. The UI watches this rather than `account` itself:
     * a failed sign-in leaves `account` exactly as it was, so the VALUE can't tell you an
     * answer arrived — only a counter can. */
    this.accountSeq = 0;
    this.floorCells = new Set();
    /** Wall faces learned so far, keyed `"cx,cy,dir"` so a repeat is free. @private */
    this._wallFaces = new Map();
    this.grid = this.sim.memory.worldMap;
    /** entity id → live proxy Entity (lives in `this.grid`). @private */
    this._byId = new Map();

    /** Buffered snapshots: `{ time, step, entities: Map<id, entityData> }`, oldest first. @private */
    this._snaps = [];
    /** Playout clock in SERVER-time units; we reconcile toward this (delayed) time. @private */
    this._renderTime = 0;
    /** Newest snapshot's server time. @private */
    this._newestTime = 0;
    /** Leftover real time (s) not yet consumed by a fixed local-sim step. @private */
    this._acc = 0;
    /** Latest input direction — drives movement-aware self reconcile. @private */
    this._inputDx = 0;
    this._inputDy = 0;
    /** Cumulative local fixed sim steps — compared against the server's step rate
     *  in diagnostics to catch a client/server timestep-rate mismatch. @private */
    this._localSteps = 0;

    /** Smoothed camera center — eases toward the live player each frame so the
     *  view lags slightly instead of snapping. `null` until the first frame
     *  (then it snaps on). @private */
    this._camX = null;
    this._camY = null;
    // Per-entity render points live on the entities themselves (`Entity#renderX`), not
    // here — every entity has one now, not just the player. See `_smoothRender`.

    /** Reconcile diagnostics on/off. Throttled console logs of the buffer/clock
     *  health and how hard the reconcile is correcting (the jitter signal). Flip
     *  to false at runtime (`session.client.debug = false`) to silence. */
    this.debug = DEBUG_DEFAULT;
    /** Per-window worst-case accumulators for the throttled log. @private */
    this._dbg = { frames: 0, dtMax: 0, selfLeadMax: 0, selfCorrMax: 0, mobCorrPeak: 0, mobCorrMax: 0,
      lastT: 0, lastLocalSteps: 0, lastServerStep: 0, primed: false };

    conn.onMessage((message) => this._onMessage(message));
  }

  /** This client's own player entity, or null until welcomed + first snapshot. */
  get player() {
    return this.playerId === null ? null : this._byId.get(this.playerId) ?? null;
  }

  /** Camera rect centered on the SMOOTHED follow point (eases toward the player,
   *  see `_updateCamera`), sized to the view. Falls back to the raw player pos
   *  before the first smoothing step. */
  get camera() {
    if (this.viewWidth === 0) return null;
    if (this._camX === null) {
      const player = this.player;
      if (player === null) return null;
      return { x: player.x, y: player.y, width: this.viewWidth, height: this.viewHeight };
    }
    return { x: this._camX, y: this._camY, width: this.viewWidth, height: this.viewHeight };
  }

  /** Low-pass ONE entity's render point toward its true position and write the
   *  resulting `renderOffset`. See `Entity#renderX` for why every entity wants this:
   *  a true position moves in discrete jumps (predict, then tug toward the server),
   *  and that stepping is what reads as jitter.
   *
   *  Frame-rate-independent (`1 - 2^(-dt/halflife)`), identical at any FPS. Snaps
   *  instead of sweeping on the first frame and on a huge jump (respawn/teleport/world
   *  change), so a warp doesn't drag a sprite across the map. @private */
  _smoothRender(entity, targetX, targetY, targetAngle, dtSec, halflife, snap2) {
    const t = 1 - Math.pow(2, -dtSec / halflife);
    if (entity.renderX === null) {
      entity.renderX = targetX; entity.renderY = targetY; entity.renderAngle = targetAngle;
    } else {
      const dx = targetX - entity.renderX, dy = targetY - entity.renderY;
      if (dx * dx + dy * dy > snap2) {
        // A teleport re-seats the facing too — easing into a new heading across the map
        // would look like the sprite spinning on arrival.
        entity.renderX = targetX; entity.renderY = targetY; entity.renderAngle = targetAngle;
      } else {
        entity.renderX += dx * t; entity.renderY += dy * t;
        // Same halflife as position, so facing and apparent motion stay in step; short
        // way around, so a heading crossing ±π doesn't unwind the long way.
        entity.renderAngle = lerpAngle(entity.renderAngle, targetAngle, t);
      }
    }
    // Short-way delta, not a raw subtraction: the eased angle and the target can sit on
    // different turns of the circle (6.28 vs 0.01), where subtracting would produce a
    // full-rotation offset instead of the small one actually between them.
    entity.renderAngleOffset = lerpAngle(targetAngle, entity.renderAngle, 1) - targetAngle;
    // Offset is relative to the SAME point the view interpolates to, so the two compose:
    // the view draws `target + offset`, which lands exactly on `renderX/renderY`.
    // Measuring against `entity.x` instead would break at every tick boundary — `x`
    // jumps a whole tick while the target doesn't, so the offset would jump the
    // opposite way and the sprite would kick backward once per step.
    entity.renderOffsetX = entity.renderX - targetX;
    entity.renderOffsetY = entity.renderY - targetY;
  }

  /** Smooth the camera and EVERY entity's render point each frame, on independent
   *  halflives: the camera center (floaty, `CAMERA_HALFLIFE`), our own player (tightest,
   *  `PLAYER_RENDER_HALFLIFE` — it's judged against your own input) and everything else
   *  (`ENTITY_RENDER_HALFLIFE`). The sim, collision and input all keep using true
   *  positions; only the pixels lag.
   *  @private @param {number} dtSec real frame seconds */
  _updateCamera(dtSec) {
    const player = this.player;
    // Teleport threshold. The `|| ` fallbacks matter: `viewWidth/Height` are 0 until the
    // app reports a view size, which would make this 0 — and a threshold of 0 means
    // EVERY move counts as a teleport, i.e. no smoothing at all. Same defaults `_region`
    // uses.
    const span = Math.max(this.viewWidth || 2000, this.viewHeight || 1200);
    const snap2 = (span * CAMERA_SNAP_VIEWS) ** 2;

    // Camera center — floaty, and the only one of the three that needs a player.
    if (player !== null) {
      if (this._camX === null) { this._camX = player.x; this._camY = player.y; }
      else {
        const dx = player.x - this._camX, dy = player.y - this._camY;
        if (dx * dx + dy * dy > snap2) { this._camX = player.x; this._camY = player.y; }
        else {
          const t = 1 - Math.pow(2, -dtSec / CAMERA_HALFLIFE);
          this._camX += dx * t; this._camY += dy * t;
        }
      }
    }

    // Every entity gets a render point, ours on the tighter halflife. The target is the
    // TICK-INTERPOLATED position (the same one the view draws from), not the raw `x`,
    // so the sub-tick interpolation and this filter stack instead of fighting.
    const alpha = this.renderAlpha();
    for (const entity of this._byId.values()) {
      this._smoothRender(
        entity,
        entity.prevX + (entity.x - entity.prevX) * alpha,
        entity.prevY + (entity.y - entity.prevY) * alpha,
        lerpAngle(entity.prevAngle, entity.angle, alpha),
        dtSec,
        entity === player ? PLAYER_RENDER_HALFLIFE : ENTITY_RENDER_HALFLIFE,
        snap2
      );
    }

    // Attached children (petals) orbit their parent's HITBOX in the sim, but are DRAWN
    // in the parent's SMOOTHED frame: `drawn child = drawn parent + eased orbital offset`.
    //
    // Two things that both have to hold, and which pull against each other:
    //   - The ring must stay rigidly attached to the body. Smoothing a petal's ABSOLUTE
    //     position can't do that — the petal and the player ease on different halflives,
    //     so during fast movement the ring visibly trails behind.
    //   - The orbital motion itself deserves the same easing everything else gets. It's
    //     the one part of a petal's movement that had none: gluing it to the parent's
    //     offset handed it the parent's smoothing and left its own motion raw.
    // Easing the offset FROM the parent satisfies both — the attachment is exact
    // (measured against the parent's already-smoothed point), and the orbital component
    // is low-passed on its own halflife.
    //
    // That halflife is deliberately TIGHT. A petal's position relative to the player is
    // fast, high-frequency motion, and over-filtering it would visibly shrink the orbit
    // radius and lag the ring behind its true angle. At PETAL_RENDER_HALFLIFE against a
    // ~3s orbit the radius loss is under 0.1% — it takes the edge off reconcile steps
    // and ring rebuilds without softening the orbit itself.
    //
    // Runs AFTER the loop above, overwriting what that computed for children.
    for (const entity of this._byId.values()) {
      if (entity.children.size === 0) continue;
      const parentTargetX = entity.prevX + (entity.x - entity.prevX) * alpha;
      const parentTargetY = entity.prevY + (entity.y - entity.prevY) * alpha;
      for (const child of entity.children) {
        // POSITION only — a petal's facing is its own (it spins independently of the
        // body it orbits), so the rotational easing from the loop above is left alone.
        const childTargetX = child.prevX + (child.x - child.prevX) * alpha;
        const childTargetY = child.prevY + (child.y - child.prevY) * alpha;
        // Ease the ORBITAL VECTOR, never the absolute position. Easing the absolute
        // puts the parent's TRANSLATION inside the filter, so the ring trails the body
        // by the filter's steady-state error the whole time the owner is running. The
        // vector doesn't translate — it only turns — so this leaves the attachment exact.
        const orbitalX = childTargetX - parentTargetX;
        const orbitalY = childTargetY - parentTargetY;
        const dx = orbitalX - child.orbitEaseX, dy = orbitalY - child.orbitEaseY;
        const err2 = dx * dx + dy * dy;
        if (child.orbitEaseX == null || err2 > snap2) { // `== null` also catches undefined
          child.orbitEaseX = orbitalX; child.orbitEaseY = orbitalY; // first frame / teleport
        } else {
          // Halflife by how far off it is: soft when close, tight when far, smoothstep
          // between so there's no point where the motion changes character abruptly.
          const k = Math.min(1, Math.sqrt(err2) / PETAL_CATCHUP_DIST);
          const blend = k * k * (3 - 2 * k); // smoothstep
          const halflife = PETAL_SOFT_HALFLIFE + (PETAL_TIGHT_HALFLIFE - PETAL_SOFT_HALFLIFE) * blend;
          const ease = 1 - Math.pow(2, -dtSec / halflife);
          child.orbitEaseX += dx * ease;
          child.orbitEaseY += dy * ease;
        }
        // Rigidly on the drawn body, offset by the eased orbital vector.
        child.renderX = entity.renderX + child.orbitEaseX;
        child.renderY = entity.renderY + child.orbitEaseY;
        // Offset is measured against what the VIEW interpolates to, so `interp + offset`
        // lands exactly on the eased point (same contract as `_smoothRender`).
        child.renderOffsetX = child.renderX - childTargetX;
        child.renderOffsetY = child.renderY - childTargetY;
      }
    }
  }

  /** How far the render frame sits INTO the current sim tick, 0..1 — the view's
   *  interpolation factor between each entity's `prevX/prevY` and `x/y`.
   *
   *  This has to be the real accumulator fraction, not 1. The local sim advances in
   *  discrete `1/SIM_HZ` slices (see `update`) while the display refreshes at its own
   *  rate, so the two don't line up: at 144Hz most frames run NO sim step at all, and
   *  even at 60Hz uneven frame times mean the occasional frame runs zero or two.
   *  Drawing at `e.x` (alpha 1) then repeats a pixel on one frame and double-jumps on
   *  the next — which is exactly the stutter you see. Interpolating across the tick
   *  removes it without touching the sim: `prevX/prevY` are snapshotted at the top of
   *  every step (`GameEngine.step`), so this is a pure render-side read.
   *
   *  Always < 1: `update`'s catch-up loop leaves `_acc` below one tick. @returns {number} */
  renderAlpha() { return this._acc / (1 / SIM_HZ); }

  /** Report view size (world units) to the server (scopes its sim + snapshots) and
   *  store it for the camera. Call on join + resize. */
  setView(width, height) {
    this.viewWidth = width;
    this.viewHeight = height;
    this.conn.send(cmdView(width, height, now()));
  }

  // --- commands up (timestamped) ---
  moveDir(dx, dy) { this.conn.send(cmdMoveDir(dx, dy, now())); }
  moveToward(x, y) { this.conn.send(cmdMoveToward(x, y, now())); }
  stop() { this.conn.send(cmdStop(now())); }
  /** DEV: ask the server to warp us to the next world (the server toggles). */
  warp() { this.conn.send(cmdWarp(now())); }

  /**
   * Ask the server to swap hotbar slot `slot` (1-based, as typed) with its reserve.
   * Pure intent — the hotbar is server state, so nothing changes locally; the new
   * loadout arrives in the next snapshot like any other authoritative change.
   * @param {number} slot
   */
  swapPetal(slot) { this.conn.send(cmdSwapPetal(slot, now())); }

  /** Ask the server to swap every hotbar slot with its reserve at once. Intent only —
   * like {@link GameClient#swapPetal}, the new loadout arrives in the next snapshot. */
  swapAllPetals() { this.conn.send(cmdSwapAllPetals(now())); }

  /** Ask the server who we're signed in as. The answer lands asynchronously in
   * {@link GameClient#account} and fires `onAccount`. */
  requestAccountInfo() { this.conn.send(cmdAccountInfo(now())); }

  /** Ask the server to create an account and sign us into it. Result arrives as an
   * account message — see {@link GameClient#account} / `onAccount`. */
  signUp(username, password) { this.conn.send(cmdSignUp(username, password, now())); }

  /** Ask the server to sign us into an existing account. */
  signIn(username, password) { this.conn.send(cmdSignIn(username, password, now())); }

  /**
   * Per-frame: send intent, step the local sim (your player + mobs move now), then
   * reconcile toward the delayed authoritative buffer. Call once per render frame.
   * @param {number} dx @param {number} dy @param {number} dtSec real frame seconds.
   */
  update(dx, dy, dtSec) {
    this.moveDir(dx, dy);
    this._inputDx = dx; this._inputDy = dy; // for the movement-aware self reconcile
    if (this.player !== null) this.sim.mechanics.inputs.moveDir(LOCAL, dx, dy);
    // Step the local sim at a FIXED timestep matching the server's tick rate.
    // Stepping with the variable render dt integrates motion (momentum, collision)
    // differently from the server's fixed 1/SIM_HZ step, so the two diverge every
    // frame and the reconcile has to drag everything back — that drag IS the
    // jitter. Consume real elapsed time in fixed slices instead; the server and
    // local sim then walk the same path, so corrections shrink toward zero.
    const fixed = 1 / SIM_HZ;
    this._acc += dtSec;
    // Cap the backlog so a long stall (tab refocus, GC) catches up in a few steps
    // instead of spiraling.
    if (this._acc > fixed * 5) this._acc = fixed * 5;
    while (this._acc >= fixed) {
      this.sim.step([this._region()], fixed, CLIENT_OPTS);
      this._acc -= fixed;
      this._localSteps++;
    }
    this._reconcile(dtSec);
    this._updateCamera(dtSec); // ease the follow-camera toward the now-updated player pos
  }



  /** The local-sim region: our view box centered on our player. @private */
  _region() {
    const player = this.player;
    return {
      x: player ? player.x : 0, y: player ? player.y : 0,
      width: this.viewWidth || 2000, height: this.viewHeight || 1200,
    };
  }

  /**
   * Reconcile the local sim toward the DELAYED authoritative state. Advances the
   * playout clock, finds the two snapshots bracketing it, and for every entity:
   *   - our player → nudge toward the interpolated server pos past its deadzone;
   *   - mob        → apply server AI state, then nudge its position past its deadzone;
   *   - other player → set straight to the interpolated pos (pure smooth interp,
   *                    since we can't simulate a remote human's input).
   * Existence (spawns / despawns) is keyed off the delayed snapshot too, so it's on
   * the same cushion — a late packet never pops an entity in/out. @private
   */
  _reconcile(dtSec) {
    const snaps = this._snaps;
    if (snaps.length === 0) return;

    const newestSnap = snaps[snaps.length - 1];
    const newest = newestSnap.time;
    // Advance the playout clock by real elapsed time, kept ~PLAYOUT_DELAY behind the
    // newest snapshot. Physical bounds first: can't read past the newest snapshot,
    // nor before the oldest buffered one (an overrun freezes at `newest`). Then
    // steer toward the delayed target so the clock keeps its cushion instead of
    // riding the newest edge — riding the edge made the interpolation fraction
    // (and every interpolated mob) slosh ±30ms. Big gap snaps; small drift eases,
    // proportional to the frame so a zero-dt probe leaves the clock untouched.
    this._renderTime += dtSec * 1000;
    const target = newest - PLAYOUT_DELAY;
    if (this._renderTime > newest) this._renderTime = newest;
    if (this._renderTime < snaps[0].time) this._renderTime = snaps[0].time;
    const drift = this._renderTime - target;
    if (Math.abs(drift) > RESYNC_MS) this._renderTime = target;
    else if (dtSec > 0) this._renderTime -= drift * Math.min(1, dtSec * 6);
    const rt = this._renderTime;

    // Bracket: A (latest snapshot with time ≤ rt), B (first with time ≥ rt).
    let A = snaps[0], B = snaps[snaps.length - 1];
    for (let i = 0; i < snaps.length - 1; i++) {
      if (snaps[i].time <= rt && snaps[i + 1].time >= rt) { A = snaps[i]; B = snaps[i + 1]; break; }
    }
    const span = B.time - A.time;
    const frac = span > 0 ? (rt - A.time) / span : 0;

    // Diagnostics for this frame (worst-case across entities); folded into the
    // throttled log at the end. selfLead = how far our prediction sits from the
    // authoritative pose; *Corr = how far the reconcile actually yanked something.
    let selfLead = 0, selfCorr = 0, mobCorrCount = 0, mobCorrMax = 0;

    // Pass 1: existence + pose, driven by the delayed snapshot B.
    const seen = new Set();
    for (const [id, snapEntity] of B.entities) {
      seen.add(id);
      const isMe = id === this.playerId;
      const isPlayer = snapEntity.def === "player";
      let entity = this._byId.get(id);
      if (entity === undefined) {
        // `petal`/`count` go in at CONSTRUCTION (not patched after) so the view builds
        // the display already holding the right petal and badge — the display is cached
        // on first sight, so a later assignment would draw an empty container for a frame.
        entity = new Entity({ id, mobType: snapEntity.def, rarity: snapEntity.rarity, x: snapEntity.x, y: snapEntity.y, angle: snapEntity.angle, petal: snapEntity.ptl ?? null, count: snapEntity.cnt ?? 1 });
        this._byId.set(id, entity);
        this.grid.insert(entity);
        if (isMe) this.sim.mechanics.inputs.register(LOCAL, entity);
        // Seed an orbiter's phase from the server's geometry (its angle around the
        // parent in this snapshot) so the client starts IN PHASE; both sides then
        // advance it deterministically at the same rate, so they stay aligned.
        if (entity.movement === "orbit" && snapEntity.par) {
          const parentSnap = B.entities.get(snapEntity.par);
          if (parentSnap) entity.orbitAngle = Math.atan2(snapEntity.y - parentSnap.y, snapEntity.x - parentSnap.x);
        }
      }

      // Rarity can change at runtime (upgrades). When the server's rarity differs
      // from ours, re-derive this entity's stats + drop its visuals so the view
      // rebuilds them at the new size/shape/rarity. A just-created entity already
      // matches, so this only fires on a real change. BEFORE health so its clamp
      // uses the new max (the authoritative `hp` below then sets the real value).
      if (snapEntity.rarity !== entity.rarity) entity.setRarity(snapEntity.rarity);

      // Held petal is server-owned too. It's baked into the cached display, so a change
      // has to drop the visuals and let the view rebuild — the same treatment rarity
      // gets. `undefined` means a peer on an older protocol: leave ours alone.
      if (snapEntity.ptl !== undefined && (snapEntity.ptl ?? null) !== entity.petal) {
        entity.petal = snapEntity.ptl ?? null;
        entity._freeVisuals();
      }

      // Same for the stack size: it's drawn as a baked-in badge, so a change rebuilds.
      if (snapEntity.cnt !== undefined && snapEntity.cnt !== entity.count) {
        entity.count = snapEntity.cnt;
        entity._freeVisuals();
      }

      // Health is server-authoritative (the local sim never changes it) — just
      // copy the latest value through for UI bars. `maxHealth` is set from
      // def+rarity (constructor / setRarity), so `health/maxHealth` is ready to draw.
      if (snapEntity.hp !== undefined) entity.health = snapEntity.hp;

      // Ring state is server-owned. `oba` is the petal's fixed place on its parent's
      // circle and `orot` how far that parent's own ring has turned — together they're
      // what let a client DERIVE petal angles instead of integrating them. Without this
      // a client's petals fall back to advancing themselves at their own `speed`, and
      // since the reconcile deliberately never repositions an orbiter, that drift never
      // gets corrected. `orot` also seeds a client that joined mid-rotation.
      if (snapEntity.oba !== undefined) entity.orbitBase = snapEntity.oba;
      if (snapEntity.orot !== undefined) entity.orbit1Rotation = snapEntity.orot;

      // Hotbar is server-owned outright — the local sim never touches it, so there's
      // nothing to reconcile and it's taken wholesale rather than merged. The array
      // arrives already copied (see Protocol.snapshot), so this can't alias the
      // server's own on a loopback/Worker transport. `undefined` means a peer on an
      // older protocol; leave ours alone rather than wiping it to null.
      if (snapEntity.hb !== undefined) entity.hotbar = snapEntity.hb;

      // Interpolated authoritative pose at the playout time (smooth across jitter).
      const prevEntity = A.entities.get(id);
      const ix = prevEntity ? prevEntity.x + (snapEntity.x - prevEntity.x) * frac : snapEntity.x;
      const iy = prevEntity ? prevEntity.y + (snapEntity.y - prevEntity.y) * frac : snapEntity.y;

      if (isMe) {
        // Our own player is input-predicted, so reconcile against the NEWEST
        // authoritative pose (not the delayed playout — that only bakes in extra
        // lead). While moving, a wide deadzone trusts the prediction so it isn't
        // tugged back; at rest, a tiny deadzone + snappier blend converge onto the
        // server pos so no offset lingers. Don't touch its velocity/target.
        const moving = this._inputDx !== 0 || this._inputDy !== 0;
        const newestEntity = newestSnap.entities.get(id) || snapEntity;
        const ex = newestEntity.x - entity.x, ey = newestEntity.y - entity.y;
        const distSq = ex * ex + ey * ey;
        selfLead = Math.sqrt(distSq);
        const dz = moving ? PLAYER_DEADZONE_MOVE : PLAYER_DEADZONE_IDLE;
        if (distSq > dz * dz) {
          const blend = moving ? PLAYER_BLEND : IDLE_BLEND;
          entity.x += ex * blend;
          entity.y += ey * blend;
          selfCorr = selfLead * blend; // distance actually applied this frame
        }
      } else if (isPlayer) {
        // A remote human's player — can't be simulated, so render it straight from
        // the delayed buffer: smooth, real, ~PLAYOUT_DELAY behind. momentum 0 so the
        // local sim doesn't drift it between corrections.
        entity.x = ix; entity.y = iy;
        entity.angle = prevEntity ? lerpAngle(prevEntity.angle, snapEntity.angle, frac) : snapEntity.angle;
        entity.momentum = 0;
      } else if (entity.movement === "orbit") {
        // Orbit petals are positioned by their OWN local orbit sim, glued to the
        // locally-predicted parent — so DON'T nudge them toward the delayed snapshot
        // (that would make them lag a moving player). Phase was seeded at creation and
        // both sides advance it deterministically, so they stay in sync without a tug.
      } else {
        // Mob: the local sim moves it (toward its server target); feed it the server
        // AI state and nudge its position toward the delayed-interp reference past
        // the deadzone. Facing is left to the sim (it points mobs along motion).
        entity.aggroed = snapEntity.ag === 1;
        entity.momentum = snapEntity.mo;
        entity.direction = snapEntity.dir;
        const ex = ix - entity.x, ey = iy - entity.y;
        const distSq = ex * ex + ey * ey;
        // Moving (it shifted between the bracketing snapshots) → trust the local
        // sim's lead with a wide deadzone; at rest → converge tightly so it sits
        // exactly on the server pos instead of buzzing at the deadzone edge.
        const movedSq = prevEntity ? (snapEntity.x - prevEntity.x) ** 2 + (snapEntity.y - prevEntity.y) ** 2 : 1;
        const moving = movedSq > 1;
        const dz = moving ? MOB_DEADZONE_MOVE : MOB_DEADZONE_IDLE;
        if (distSq > dz * dz) {
          const blend = moving ? MOB_BLEND : IDLE_BLEND;
          entity.x += ex * blend;
          entity.y += ey * blend;
          mobCorrCount++;
          const applied = Math.sqrt(distSq) * blend;
          if (applied > mobCorrMax) mobCorrMax = applied;
        }
      }
      this.grid.update(entity);
    }

    // Despawn anything not in B — BEFORE resolving targets, so a mob can't resolve
    // its target to one that's about to be pruned (a 1-frame ghost). `demolish`
    // (silent teardown — onDeath already ran server-side) removes it from the grid
    // and frees ALL its view objects (display + health bar) via `_teardown`.
    for (const [id, entity] of this._byId) {
      if (!seen.has(id)) {
        entity.demolish(this.grid);
        this._byId.delete(id);
      }
    }

    // Pass 2: resolve each mob's target ally against the now-pruned set. Our own
    // player isn't given a target here — local input drives it.
    for (const [id, snapEntity] of B.entities) {
      if (id === this.playerId || snapEntity.def === "player") continue;
      const entity = this._byId.get(id);
      const ally = snapEntity.tgt ? this._byId.get(snapEntity.tgt) ?? null : null;
      entity.targetAlly = ally;
      entity.hasTarget = ally !== null;
    }

    // Resolve attachment links (and rebuild the reverse `children` sets) the same way
    // — id → live entity, via setParent so both sides stay consistent. Covers every
    // entity (a petal can belong to a player). A parent momentarily out of view
    // resolves to null and re-links on the next snapshot that includes it.
    for (const [id, snapEntity] of B.entities) {
      const entity = this._byId.get(id);
      const parent = snapEntity.par ? this._byId.get(snapEntity.par) ?? null : null;
      entity.setParent(parent);

      // Surface-stick link, resolved the same way — and AUTHORITATIVE. The local sim
      // latches petals on its own (it must: the reconcile never repositions an orbiter,
      // so an unpredicted petal would visibly phase through mobs), which means it can
      // be stuck when the server isn't, or stuck to the wrong thing. This is where
      // that's settled: `stk: 0` releases a locally-latched petal, and a differing id
      // moves it. Resetting the remembered normal on any change stops the new contact
      // from being rate-limited away from the old one's direction.
      const stuck = snapEntity.stk ? this._byId.get(snapEntity.stk) ?? null : null;
      if (entity.stick !== stuck) {
        entity.stick = stuck;
        entity.stickNX = 0;
        entity.stickNY = 0;
      }
    }

    // Prune snapshots older than the buffer window (keep ≥2 to interpolate).
    while (snaps.length > 2 && newest - snaps[0].time > BUFFER_MS) snaps.shift();

    if (this.debug) {
      this._dbgLog(dtSec, snaps.length, rt - target, newestSnap.arrival, newestSnap.step, selfLead, selfCorr, mobCorrCount, mobCorrMax);
    }
  }

  /**
   * Throttled reconcile diagnostics. Accumulates the worst values seen over a
   * ~DEBUG_EVERY-frame window and prints ONE line, so spikes show up without
   * flooding the console. Read it as: a healthy single-player run should show
   * buf≈2–3, drift/age near a frame or two, and tiny corr/mobs values; large
   * `corr`/`by` (the reconcile dragging things) or a jumpy `dt`/`age` is exactly
   * the jitter/rubber-band you feel. @private
   */
  _dbgLog(dtSec, bufDepth, drift, newestArrival, serverStep, selfLead, selfCorr, mobCorrCount, mobCorrMax) {
    const dbg = this._dbg;
    dbg.frames++;
    if (dtSec * 1000 > dbg.dtMax) dbg.dtMax = dtSec * 1000;
    if (selfLead > dbg.selfLeadMax) dbg.selfLeadMax = selfLead;
    if (selfCorr > dbg.selfCorrMax) dbg.selfCorrMax = selfCorr;
    if (mobCorrCount > dbg.mobCorrPeak) dbg.mobCorrPeak = mobCorrCount;
    if (mobCorrMax > dbg.mobCorrMax) dbg.mobCorrMax = mobCorrMax;
    if (dbg.frames < DEBUG_EVERY) return;
    // Steps-per-second over the window: cl = client local sim, sv = server ticks
    // (from the snapshot step counter). If these diverge (e.g. sv < cl), the two
    // sims advance game-time at different rates → the predicted world runs ahead
    // of the authoritative one and the reconcile fights it forever.
    const t = now();
    let cl = 0, sv = 0;
    if (dbg.primed) {
      const secs = (t - dbg.lastT) / 1000;
      if (secs > 0) {
        cl = (this._localSteps - dbg.lastLocalSteps) / secs;
        sv = (serverStep - dbg.lastServerStep) / secs;
      }
    }
    dbg.primed = true;
    dbg.lastT = t; dbg.lastLocalSteps = this._localSteps; dbg.lastServerStep = serverStep;
    console.log(
      `[net/client] buf=${bufDepth} drift=${drift.toFixed(1)}ms age=${(t - newestArrival).toFixed(1)}ms ` +
      `dt≤${dbg.dtMax.toFixed(1)}ms | steps/s cl=${cl.toFixed(1)} sv=${sv.toFixed(1)} ` +
      `| self lead≤${dbg.selfLeadMax.toFixed(1)} corr≤${dbg.selfCorrMax.toFixed(1)} ` +
      `| mobs corrected≤${dbg.mobCorrPeak} by≤${dbg.mobCorrMax.toFixed(1)}`
    );
    dbg.frames = 0; dbg.dtMax = 0; dbg.selfLeadMax = 0; dbg.selfCorrMax = 0; dbg.mobCorrPeak = 0; dbg.mobCorrMax = 0;
  }

  /** @private */
  _onMessage(message) {
    if (message.type === MSG.WELCOME) {
      this.ownerId = message.ownerId;
      this.playerId = message.playerId;
      if (message.worldId != null) this._enterWorld(message.worldId); // initial terrain/barriers
      this.onWelcome?.(message.ownerId, message.playerId);
    } else if (message.type === MSG.SNAPSHOT) {
      // A snapshot from a DIFFERENT world means the server transferred us — switch
      // before buffering it (the old buffer/entities belong to the old world).
      if (message.worldId != null && message.worldId !== this.worldId) this._switchWorld(message.worldId);
      // Ground near the player rides along in the world block — fold it in.
      this._applyGeometry(message.worldId, message.floor, message.walls);
      this._bufferSnapshot(message);
    } else if (message.type === MSG.ACCOUNT) {
      // Identity is server-owned; we just record what we're told. `null` is a real
      // answer ("not signed in"), distinct from the `undefined` we start at.
      this.account = message.account ?? null;
      /** Why the last sign-in/sign-up attempt failed, or null. Cleared by any successful
       * reply, so it never outlives the attempt it describes. */
      this.accountError = message.error ?? null;
      this.accountSeq++;
      this.onAccount?.(this.account, this.accountError);
    } else if (message.type === MSG.SPAWN) {
      // Reliable one-shot spawn signal. The entities themselves still arrive via
      // snapshots (the authority for what's in view) — this just lets the view react
      // the instant a spawn happens, independent of the unreliable snapshot channel.
      if (message.worldId == null || message.worldId === this.worldId) this.onSpawn?.(message.spawns);
    }
  }

  /** Point the local sim's barriers at world `worldId` and announce it (host
   *  rebuilds terrain). Used on join and as part of `_switchWorld`.
   *
   *  Barriers start EMPTY and are filled in by the first snapshot for this world —
   *  the server streams the wall faces (see `WORLD_STAT.INGAME`), so the client no
   *  longer derives them from a local copy of the room. An empty field clamps
   *  nothing, so the worst case is a few unclamped ticks before the first snapshot
   *  lands, and the server's authoritative position corrects anything that drifted.
   *  @private */
  _enterWorld(worldId) {
    // Forget the old world's ground — cell coords are per-world, so keeping them
    // would leave the player colliding with another room's walls and drawing its
    // tiles. CLEARED IN PLACE, not reassigned: the view holds this exact Set and
    // re-reads it each frame, so swapping in a new one would strand it on the old.
    this.sim.walls = WallField.fromWalls([]);
    this.floorCells.clear();
    this._wallFaces.clear();
    this.worldId = worldId;
    this.onWorldChange?.(worldId);
  }

  /**
   * Fold this snapshot's geometry patch into what we know. Both parts are culled to
   * the player's box server-side, so each snapshot is a local update, not the map —
   * we accumulate, and terrain already seen stays put.
   *
   * The floor Set is mutated in place because the view holds the same reference and
   * re-reads it each frame; the wall field is REBUILT, but only on a snapshot that
   * actually carried a face we hadn't seen. Standing still, that's never. @private
   */
  _applyGeometry(worldId, floor, walls) {
    if (worldId !== this.worldId) return;

    if (floor != null) {
      // Bitmask over the patch box: bit (y*w + x), LSB first, set = walkable.
      const { cx0, cy0, w, h, bits } = floor;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (bits[i >> 3] & (1 << (i & 7))) this.floorCells.add((cx0 + x) + "," + (cy0 + y));
        }
      }
    }

    let fresh = false;
    if (walls) {
      for (const f of walls) {
        const key = f.cx + "," + f.cy + "," + f.dir;
        if (this._wallFaces.has(key)) continue;
        this._wallFaces.set(key, f);
        fresh = true;
      }
    }
    if (fresh) this.sim.walls = WallField.fromWalls([...this._wallFaces.values()]);
  }

  /** Full client-side world change: drop the old world's entities, snapshot
   *  buffer, and camera, then enter the new world. The next snapshots repopulate
   *  it (the player keeps its id, so the camera re-locks). @private */
  _switchWorld(worldId) {
    for (const entity of this._byId.values()) entity.demolish(this.grid); // frees visuals + grid
    this._byId.clear();
    this._snaps.length = 0; // old-world snapshots are meaningless now
    this._renderTime = 0;
    this._newestTime = 0;
    // Re-snap the camera. Per-entity render points need no reset — the old world's
    // entities were just demolished, and the new world's arrive with `renderX` null.
    this._camX = this._camY = null;
    this._enterWorld(worldId);
  }

  /** Buffer an incoming snapshot for delayed playout. `arrival` is stamped with
   *  the LOCAL clock so diagnostics can age it — `time` is the server's clock,
   *  which (with the server on a worker thread) has a different time origin. @private */
  _bufferSnapshot(message) {
    // The snapshot channel is unreliable + unordered (see WebRtcTransport), so an
    // OLD snapshot can arrive after a newer one. It's already superseded, and the
    // buffer/playout logic assumes increasing `time` — drop anything not newer than
    // what we've already buffered (also discards duplicates). A world switch clears
    // `_snaps`, so the first snapshot of a new world always passes.
    const last = this._snaps[this._snaps.length - 1];
    if (last !== undefined && message.time <= last.time) return;
    const entities = new Map();
    for (let i = 0; i < message.entities.length; i++) entities.set(message.entities[i].id, message.entities[i]);
    this._snaps.push({ time: message.time, step: message.step, entities, arrival: now() });
    if (message.time > this._newestTime) this._newestTime = message.time;
    if (this._renderTime === 0) this._renderTime = message.time - PLAYOUT_DELAY; // init
  }
}
