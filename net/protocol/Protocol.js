// Protocol — the wire format shared by Server and Client. Pure data + tiny
// message constructors; imports NOTHING (no engine, no transport, no DOM/Node),
// so both sides — and any transport — depend on it without coupling.
//
// Messages are plain JS objects. The transport is responsible for getting them
// across (serialize/deserialize); here we only define their shape. Two
// directions:
//   client → server :  INTENT   (a point/direction to steer toward, or stop)
//   server → client :  WELCOME  (your ids, once on join)
//                       SNAPSHOT (authoritative entity state, every tick)
//
// Snapshots are currently FULL state (every entity near the player). That's the
// simplest correct thing; delta/compressed snapshots are a later optimization.

/** Message type tags. @readonly */
export const MSG = Object.freeze({
  WELCOME: "welcome",
  SNAPSHOT: "snapshot",
  SPAWN: "spawn",     // server → client: a one-shot "these entities just spawned" event
  COMMAND: "command", // client → server: a timestamped, named command (extensible)
  ACCOUNT: "account", // server → client: who this connection is signed in as (or nobody)
});

/**
 * What the world a snapshot describes is DOING. Sent on every snapshot, right after
 * the world id, and it decides what the rest of the world block contains — so a
 * reader must branch on it before it can keep parsing.
 *
 * Only `INGAME` exists so far: a live, playable world, whose block carries the
 * barrier geometry. The enum is here so states that carry different payloads (a
 * loading world, a finished round, a lobby) can be added without another format
 * break — each just defines what follows its tag.
 * @readonly
 */
export const WORLD_STAT = Object.freeze({
  INGAME: 0, // followed by: the floor patch, then the wall faces
});

/**
 * The world's geometry near one player, as a snapshot carries it. Both parts are
 * CULLED to that player's snapshot box — the same box the entities are — so what a
 * client receives is the ground it can actually see, not the whole map. A client
 * accumulates patches as it moves rather than being handed a world up front.
 *
 * `floor` is a BITMASK, not a cell list: one bit per cell over the box, set = walkable.
 * A 16x12 view is 192 cells = 24 bytes, where a list of `{cx, cy}` pairs would be 768.
 * The mask's origin and size travel with it, since the box moves with the player.
 *
 * @typedef {Object} FloorPatch
 * @property {number} cx0 Cell x of the box's low corner.
 * @property {number} cy0 Cell y of the box's low corner.
 * @property {number} w   Box width in cells (<=255).
 * @property {number} h   Box height in cells (<=255).
 * @property {Uint8Array} bits Row-major, LSB-first; bit `(y * w + x)` is cell
 *   `(cx0 + x, cy0 + y)`. Set = floor.
 */

/**
 * Which side of its floor cell a wall sits on — the 2-bit direction code that rides
 * with every wall face. The index matches `WALL_DIR_STEP` in `WallField.js`, and the
 * neighbouring cell in that direction is the SOLID one behind the wall.
 *
 * Two bits is the whole point: a face is a cell plus one of four sides, so the
 * directions for a whole room pack four-to-a-byte instead of one byte each.
 * @readonly
 */
export const WALL_DIR = Object.freeze({ EAST: 0, WEST: 1, SOUTH: 2, NORTH: 3 });

// --- server → client ---------------------------------------------------------

/**
 * Sent once when a connection is accepted. Tells the client which controller it
 * is (`ownerId`, for input) and which entity id is its own player (`playerId`,
 * so the client can follow it with the camera).
 * @param {number} ownerId  Controller id the server assigned this connection.
 * @param {number} playerId Entity id of this connection's player.
 * @param {string} [worldId] Id of the world the player starts in (the client
 *   builds its terrain/sim from it; also stamped on every snapshot).
 */
export function welcome(ownerId, playerId, worldId) {
  return { type: MSG.WELCOME, ownerId, playerId, worldId };
}

/**
 * Authoritative state of the entities near a player, sent every server tick.
 * Per entry:
 *   id, def (def id, e.g. "hornet"/"player"), rarity   — identity / how to build it
 *   x, y, angle                                         — pose
 *   mo, dir                                             — velocity (momentum + heading)
 *   ag                                                  — aggroed (0/1)
 *   tgt                                                 — id of the ally this entity is
 *                                                         chasing (0 = none)
 *   par                                                 — id of the entity this one is
 *                                                         attached to, e.g. a petal's
 *                                                         owner (0 = none)
 *   stk                                                 — id of the entity this one is
 *                                                         STUCK to (gliding along the
 *                                                         surface of; 0 = not stuck).
 *                                                         Authoritative: a client that
 *                                                         latched on in its own sim
 *                                                         releases when this says 0.
 *   oba                                                 — an orbiter's fixed place on its
 *                                                         parent's ring, in radians
 *                                                         (-1 = not on one). The BASE,
 *                                                         not the index: the index needs
 *                                                         the ring's size to reconstruct.
 *   orot                                                — how far this entity's OWN ring
 *                                                         has turned (0 for anything that
 *                                                         owns none). Seeds a client that
 *                                                         joined mid-rotation; it then
 *                                                         advances its own copy.
 *   ptl                                                 — def id of the petal a petal
 *                                                         CONTAINER holds (null = empty
 *                                                         / not a container). Drawn
 *                                                         inside the container; NOT a
 *                                                         separate entity.
 *   cnt                                                 — how many that container stands
 *                                                         for (1 = a single, and what
 *                                                         everything else sends). A
 *                                                         stack size, not entities: 3
 *                                                         still means one container,
 *                                                         drawn with a "3x" badge.
 *   hb                                                  — HOTBAR for a player: one array
 *                                                         of slots per row, `{ main:
 *                                                         [...], secondary: [...] }`
 *                                                         (null for everything else).
 *                                                         Each slot is `{ petal,
 *                                                         loaded, timeTillLoaded }` —
 *                                                         its def id plus reload state.
 *                                                         Server-owned; the client
 *                                                         overwrites its copy wholesale.
 *   hp                                                  — current health (server-
 *                                                         authoritative; for UI bars.
 *                                                         maxHealth is derived client-
 *                                                         side from def+rarity)
 * The last three are the AI/movement STATE the client needs to keep a local
 * simulation steering the same way the server does (so a locally-simulated mob
 * chases the server-decided target instead of picking its own and diverging).
 * @param {Iterable<object>} entities Entities to include (e.g. a grid query result).
 * @param {number} step The server step this snapshot represents (for ordering).
 * @param {number} time The server clock (ms) when this snapshot was produced — the
 *   "timestamp id" the client plays out a fixed delay behind (jitter buffer).
 * @param {string} [worldId] Which world these entities are in. When it differs
 *   from the client's current world the client switches worlds (rebuilds terrain,
 *   resets its sim, drops the old entities).
 */
/**
 * Deep-ish copy of a hotbar (`{ row: slot[] }`) for the wire, or `null` straight
 * through. The rows are COPIED, not aliased: the loopback/Worker transports pass these
 * message objects to the other side live, so shipping the server's own arrays would
 * leave both ends mutating one hotbar.
 *
 * Deliberately shape-AGNOSTIC — it walks whatever rows are there rather than naming
 * them, so adding a row is an engine + codec change and never touches this file
 * (Protocol imports nothing, so it can't share the engine's row list). @private
 */
function copyHotbar(hotbar) {
  if (!hotbar) return null;
  const out = {};
  for (const row of Object.keys(hotbar)) {
    const slots = hotbar[row];
    const copy = new Array(slots.length);
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      // Field-by-field, NOT a spread: a slot also holds a live reference to its spawned
      // petal, which is server-only bookkeeping and must not be handed to the client
      // (over loopback that would leak a real entity straight into client state).
      copy[i] = s == null ? null
        : { petal: s.petal ?? null, rarity: s.rarity ?? "common",
            loaded: !!s.loaded, timeTillLoaded: s.timeTillLoaded ?? 0 };
    }
    out[row] = copy;
  }
  return out;
}

/**
 * A snapshot that carries the LIVE entities instead of packed copies.
 *
 * ONLY for a transport that immediately serializes to bytes (the WebSocket path). The
 * `raw` flag tells `Codec.encodeSnapshot` to project each entity through a reusable
 * record rather than reading pre-packed fields, which skips ~one throwaway object per
 * entity per player per snapshot.
 *
 * MUST NOT be handed to a peer that consumes the message object directly — a loopback
 * client would end up holding the server's real entities. Use {@link snapshot} there;
 * that's what its per-field copying is for.
 *
 * @param {Array} entities Live entities (borrowed, not copied — valid only until the
 *   caller's next tick).
 * @returns {object} a SNAPSHOT message flagged `raw`.
 */
export function snapshotRaw(entities, step, time, worldId, walls = [], floor = null, worldStat = WORLD_STAT.INGAME) {
  return { type: MSG.SNAPSHOT, step, time, worldId, worldStat, walls, floor, entities, raw: true };
}

export function snapshot(entities, step, time, worldId, walls = [], floor = null, worldStat = WORLD_STAT.INGAME) {
  const packed = [];
  for (const entity of entities) {
    packed.push({
      id: entity.id, def: entity.defId, rarity: entity.rarity,
      x: entity.x, y: entity.y, angle: entity.angle,
      mo: entity.momentum, dir: entity.direction,
      ag: entity.aggroed ? 1 : 0,
      tgt: entity.targetAlly ? entity.targetAlly.id : 0,
      par: entity.parent ? entity.parent.id : 0, // attachment link (0 = none)
      stk: entity.stick ? entity.stick.id : 0,   // surface-stick link (0 = none)
      ptl: entity.petal ?? null,                 // held petal def id (null = none)
      cnt: entity.count ?? 1,                    // how many of it the container stands for
      oba: entity.orbitBase ?? -1,               // place on the parent's ring (-1 = none)
      orot: entity.orbit1Rotation ?? 0,          // this entity's own ring rotation
      hb: copyHotbar(entity.hotbar),
      hp: entity.health,
    });
  }
  return { type: MSG.SNAPSHOT, step, time, worldId, worldStat, walls, floor, entities: packed };
}

/**
 * A one-shot "these entities just spawned" event, sent on the RELIABLE channel when
 * the server drains its spawn queue (see `GameServer.queueSpawn`). The entities also
 * arrive via normal snapshots — this is the discrete, guaranteed signal a dropped
 * (unreliable) snapshot shouldn't gate, so a client can react the instant it happens
 * (e.g. a spawn effect). Carries just enough to identify/place each: `{ id, def,
 * rarity, x, y, angle }`.
 * @param {Iterable<object>} entities The freshly-spawned entities.
 * @param {string} worldId The world they spawned into (clients ignore other worlds).
 */
export function spawnEvent(entities, worldId) {
  const spawns = [];
  for (const entity of entities) {
    spawns.push({ id: entity.id, def: entity.defId, rarity: entity.rarity, x: entity.x, y: entity.y, angle: entity.angle });
  }
  return { type: MSG.SPAWN, worldId, spawns };
}

// --- client → server: timestamped, extensible COMMANDS -----------------------
// Every client→server message is a command: a string `cmd`, the client's clock
// `t` when it was issued (for ordering / future lag-compensation), and a `data`
// payload. New command types (abilities, chat, …) just pick a new `cmd` and a
// server handler — no protocol change. Clients never send positions, only intent.

/**
 * Build a command envelope.
 * @param {string} cmd  Command name (e.g. "move", "view").
 * @param {number} t    Client timestamp (ms) — when the client issued it.
 * @param {object} [data] Command payload.
 */
export function command(cmd, t, data = null) {
  return { type: MSG.COMMAND, cmd, t, data };
}

/** Steer by a direction (WASD): summed key contributions. `(0,0)` = stop. */
export function cmdMoveDir(dx, dy, t) {
  return command("move", t, { mode: "dir", dx, dy });
}

/** Steer toward a world point (e.g. the mouse's world position). */
export function cmdMoveToward(x, y, t) {
  return command("move", t, { mode: "point", x, y });
}

/** Stop steering — coast to a halt. */
export function cmdStop(t) {
  return command("move", t, { mode: "stop" });
}

/**
 * Report this client's view size (world units) so the server scopes its sim area
 * + snapshots to the screen. Send on join and on resize.
 * @param {number} width @param {number} height @param {number} t
 */
export function cmdView(width, height, t) {
  return command("view", t, { width, height });
}

/** DEV: ask the server to warp the player to the next world (toggles test↔test2).
 * A scratch trigger for exercising world transfers; replace with real gameplay. */
export function cmdWarp(t) {
  return command("warp", t, {});
}

/**
 * Ask the server to swap a hotbar slot between the orbiting row and the reserve —
 * what a number key means.
 *
 * `slot` is 1-based as typed (1-10; only the ones a row actually has do anything). The
 * client sends whatever was pressed and the server decides which are real, so this
 * never has to know how long a row is.
 * @param {number} slot @param {number} t Client timestamp (ms).
 */
export function cmdSwapPetal(slot, t) {
  return command("swap", t, { slot });
}

/**
 * Ask the server to swap EVERY hotbar slot with its reserve at once — one key instead
 * of pressing all the numbers. Carries no data; the server knows how many slots there
 * are. @param {number} t Client timestamp (ms).
 */
export function cmdSwapAllPetals(t) {
  return command("swapAll", t, {});
}

/** Ask the server who this connection is signed in as. The answer comes back as an
 * {@link accountInfo} message. @param {number} t Client timestamp (ms). */
export function cmdAccountInfo(t) {
  return command("accountInfo", t, {});
}

/** Ask the server to CREATE an account and sign this connection into it.
 * @param {string} username @param {string} password @param {number} t */
export function cmdSignUp(username, password, t) {
  return command("signUp", t, { username, password });
}

/** Ask the server to sign this connection into an existing account.
 * @param {string} username @param {string} password @param {number} t */
export function cmdSignIn(username, password, t) {
  return command("signIn", t, { username, password });
}

/**
 * Tell a client which account its connection is acting as.
 *
 * `null` means NOT SIGNED IN, and is the honest answer rather than an error — a
 * connection is allowed to play without one today, so "nobody" is a valid state and the
 * client renders it as such. Rides the JSON path: low-frequency, and the shape of an
 * account is going to change as `Server/Account` grows.
 *
 * @param {object|null} account The account, or null when the connection has none.
 * @param {string|null} [error] Why the last attempt failed, for the client to show. An
 *   error and a null account travel together — the attempt failed AND you're still
 *   signed out, which are two facts the UI needs at once.
 */
export function accountInfo(account, error) {
  return { type: MSG.ACCOUNT, account: account ?? null, error: error ?? null };
}
