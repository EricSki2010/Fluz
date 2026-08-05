// Codec — the binary wire format for the dedicated-server transport. Protocol.js
// stays pure plain-object messages; ONLY the WebSocket transport calls this, right
// at the socket boundary (encode on send, decode on receive). Loopback/WebRTC don't
// use it — they pass live objects — so nothing else in Server/Client changes.
//
// Two framings, picked by the first byte:
//   TAG_SNAPSHOT (1) — the hot path. A header + one VARIABLE-size record per entity,
//     packed into a DataView. Each record is a 17-byte head (id, def, rarity, a u16
//     field mask, x, y) plus only the fields the mask names — so a static rock spends
//     nothing on the links, container fields, or momentum it isn't using, while a
//     player still sends everything plus a hotbar tail. See `FIELD`.
//     Positions/momentum/health are float32 (no world-bound assumption, so nothing
//     clips); angles are int16 over [-π, π] (always in range). Roughly 23 bytes for an
//     idle mob and 33 for a moving one, vs the hundreds JSON spends — the whole point
//     of the format.
//   TAG_JSON (0) — everything else (welcome, commands): low-frequency and
//     open-ended (a command's `data` is arbitrary), so it rides as UTF-8 JSON. We
//     still own the frame, so it can be tightened later without touching callers.
//
// `def` is a string on the wire-free side but can't pack to a number, so snapshots
// send the manifest index (see EntityRegistry `defWireId`); both ends load the same
// manifest, so the mapping agrees without being transmitted.

import { MSG, WORLD_STAT } from "./Protocol.js";
import { defWireId, wireDefId } from "../../entities/EntityRegistry.js";
import { rarityTier, RARITY } from "../../entities/Rarity.js";
import { HOTBAR_ROWS } from "../../entities/Entity.js";
// Shared with the sim so a stored angle and a transmitted one wrap identically.
import { normalizeAngle } from "../../calculations/Angles.js";

const TAG_JSON = 0;
const TAG_SNAPSHOT = 1;

/**
 * Bytes every record ALWAYS carries: `id` u32, `def` u16, `rarity` u8, the field mask
 * u16, and `x`/`y` float32. Every other field is optional and written only when the
 * mask says so — see {@link FIELD}.
 */
const BASE_BYTES = 17;

/**
 * Field-presence mask: one bit per OPTIONAL field, written after `rarity` as a u16.
 * A field is on the wire only when its bit is set; absent means "the default", which
 * the decoder fills in. That's what keeps a static rock small — it sends neither the
 * five link/container fields a mob never uses NOR the momentum/heading it isn't using
 * right now, and both ends agree without a shape table to maintain.
 *
 * `AG` (aggroed) is a boolean, so the BIT IS THE VALUE — it costs zero payload bytes.
 * The rest pair a bit with the payload in {@link FIELD_BYTES}; `HB`'s payload is
 * variable (see {@link hotbarBytes}).
 *
 * SELF-DESCRIBING, deliberately. The obvious alternative is a per-kind record shape
 * chosen from the def, but then stride depends on both ends agreeing about the def
 * manifest — and a mismatch would desync every following record in the frame instead
 * of just mislabeling one. The mask travels with the record, so it can't drift.
 *
 * ORDER IS THE WIRE ORDER: fields are written and read low bit → high bit. Appending
 * a new field means a new HIGH bit (and a `FIELD_BYTES` entry); reordering these is a
 * format break.
 */
const FIELD = Object.freeze({
  AG:    1 << 0,  // aggroed — no payload, the bit is the value
  ANGLE: 1 << 1,
  DIR:   1 << 2,
  MO:    1 << 3,
  TGT:   1 << 4,
  PAR:   1 << 5,
  STK:   1 << 6,
  PTL:   1 << 7,
  CNT:   1 << 8,
  OBA:   1 << 9,
  OROT:  1 << 10,
  HP:    1 << 11,
  HB:    1 << 12, // variable-length tail, sized by `hotbarBytes`
});

/** Payload bytes each {@link FIELD} bit adds when set, in the same low→high order.
 * `AG` is 0 (the bit alone carries it) and `HB` is 0 here because its tail is
 * measured separately. @private */
const FIELD_BYTES = Object.freeze([0, 2, 2, 4, 4, 4, 4, 2, 2, 2, 2, 4, 0]);

/**
 * Hard cap on walls per snapshot: the count is a `uint8`, so a world can stream at
 * most this many faces. The shipped rooms use 80 (`test`) and 128 (`test2`), so
 * there's headroom — but not much, and a room bigger than ~64x64 cells would exceed
 * it. {@link encodeSnapshot} clamps rather than letting the count wrap and desync the
 * reader; widening to a `uint16` is a one-line format change when a room needs it.
 */
const WALL_MAX = 0xff;

/** Bytes one wall face's POSITION takes: `cx` + `cy` as int16 (cell coords, so ±32767
 * cells — far beyond any room). Its direction is not here: directions are packed
 * separately, 2 bits each, four to a byte. @private */
const WALL_POS_BYTES = 4;

/** Bytes the packed direction run takes for `n` walls — 2 bits each, rounded up to a
 * whole byte. @private */
function wallDirBytes(n) {
  return (n + 3) >> 2;
}

/** Header bytes of a floor patch: `cx0`/`cy0` int16 + `w`/`h` uint8. The mask follows.
 * @private */
const FLOOR_HEAD_BYTES = 6;

/** Bytes the floor bitmask takes for a `w`x`h` cell box — one bit per cell, rounded up
 * to a whole byte. @private */
function floorMaskBytes(w, h) {
  return (w * h + 7) >> 3;
}

/** Sentinel for "no petal" in a HOTBAR SLOT. A petal is packed as its manifest index
 * (like `def`), and index 0 is a real entity, so absence needs a value outside the
 * range rather than a falsy one. Slots sit in a positional array and can't be skipped
 * individually, so they still need this; the record's own `ptl` doesn't — a clear
 * {@link FIELD}.PTL bit says "none" and costs no bytes at all. */
const PETAL_NONE = 0xffff;

/** Bytes a single hotbar slot occupies on the wire: a `uint16` petal def index (same
 * manifest table `def` and `ptl` use, {@link PETAL_NONE} when empty), a `uint8` RARITY
 * tier (what the slot's petal is, which is also what colors it), a `uint8` loaded flag,
 * and a `float32` of seconds until it reloads. */
const SLOT_BYTES = 8;

/**
 * Wire size of a hotbar: each row contributes a `uint8` length plus its slots. Rows are
 * packed POSITIONALLY in {@link HOTBAR_ROWS} order — the names never travel, so both
 * ends must ship the same list. `null` (no hotbar) costs nothing. @private
 */
function hotbarBytes(hotbar) {
  if (!hotbar) return 0;
  let bytes = 0;
  for (let r = 0; r < HOTBAR_ROWS.length; r++) bytes += 1 + hotbar[HOTBAR_ROWS[r]].length * SLOT_BYTES;
  return bytes;
}
/** Largest stack size a `cnt` field can carry (uint16). @private */
const COUNT_MAX = 0xffff;

/**
 * Clamp a container's stack size into the uint16 the record reserves for it. An absent
 * or nonsense value reads as 1 (a single) rather than 0 — "no count" and "a stack of
 * none" are the same thing to the view, and 1 is what a plain entity sends. @private
 */
function packCount(count) {
  if (!Number.isFinite(count)) return 1;
  const v = Math.round(count);
  if (v < 0) return 0;
  return v > COUNT_MAX ? COUNT_MAX : v;
}

/** int16 full-scale ↔ angle in [-π, π]. */
const ANGLE_SCALE = 32767 / Math.PI;

/** Quantize a radians value in [-π, π] to int16. @private */
function packAngle(a) {
  let v = Math.round(a * ANGLE_SCALE);
  if (v > 32767) v = 32767;
  else if (v < -32767) v = -32767;
  return v;
}
/** uint16 full-scale ↔ a TURN angle in [0, 2π). @private */
const TURN_SCALE = 65535 / (Math.PI * 2);

/**
 * Quantize a ring position to uint16 over [0, 2π) — UNSIGNED, unlike {@link packAngle}.
 *
 * `oba` cannot use the signed packing the other angles do. It carries its own "absent"
 * sentinel downstream (`orbitBase < 0` means "not on a ring", see `MOVEMENT.orbit`), so
 * folding it into [-π, π] turns every legitimate position past 180° negative and the
 * receiver reads it as "no ring" — the petal then free-runs its own angle and drifts
 * out of formation with no correction. Keeping the whole turn on the positive side
 * makes a real value and the sentinel disjoint by construction. Same 2 bytes.
 * @private
 */
function packTurn(a) {
  const t = Math.PI * 2;
  let v = a % t;
  if (v < 0) v += t;
  const q = Math.round(v * TURN_SCALE);
  return q > 65535 ? 65535 : q;
}

/** Inverse of {@link packTurn} — always returns a value in [0, 2π). @private */
function unpackTurn(v) {
  return v / TURN_SCALE;
}

/** Inverse of {@link packAngle}. @private */
function unpackAngle(v) {
  return v / ANGLE_SCALE;
}

/**
 * Which optional fields this entity actually needs on the wire. A field is included
 * only when it differs from the default the decoder would fill in.
 *
 * Quantized fields are tested through their PACKER (`packAngle`, `packCount`), not
 * raw: an angle small enough to quantize to 0 decodes as 0 either way, so sending it
 * would buy nothing. That makes "bit set" mean exactly "the decoded value would
 * differ from the default".
 *
 * @param {object} entity One packed entity from a `snapshot()` message.
 * @returns {number} the u16 mask, ready to write. @private
 */
function fieldMask(entity) {
  let mask = entity.ag ? FIELD.AG : 0;
  if (packAngle(entity.angle) !== 0) mask |= FIELD.ANGLE;
  if (packAngle(entity.dir) !== 0) mask |= FIELD.DIR;
  if (entity.mo) mask |= FIELD.MO;
  if (entity.tgt) mask |= FIELD.TGT;
  if (entity.par) mask |= FIELD.PAR;
  if (entity.stk) mask |= FIELD.STK;
  if (entity.ptl) mask |= FIELD.PTL;
  if (packCount(entity.cnt) !== 1) mask |= FIELD.CNT;
  if ((entity.oba ?? -1) >= 0) mask |= FIELD.OBA;
  if (packAngle(normalizeAngle(entity.orot ?? 0)) !== 0) mask |= FIELD.OROT;
  if (entity.hp !== undefined && entity.hp !== null) mask |= FIELD.HP;
  if (entity.hb) mask |= FIELD.HB;
  return mask;
}

/** Wire size of one record given its mask: the fixed base, every set bit's payload,
 * and the hotbar tail when there is one. @private */
function recordBytes(mask, entity) {
  let bytes = BASE_BYTES;
  for (let i = 0; i < FIELD_BYTES.length; i++) if (mask & (1 << i)) bytes += FIELD_BYTES[i];
  if (mask & FIELD.HB) bytes += hotbarBytes(entity.hb);
  return bytes;
}

/**
 * One reusable record, filled from a live `Entity` right before it's written.
 *
 * The socket path used to go entity -> plain packed object -> bytes, allocating one
 * throwaway object per entity per player per snapshot (~200 x 60 x 20/s). They existed
 * only to rename fields for the encoder, and were garbage a microsecond later. This
 * object is that rename step with the allocation removed: filled, written, refilled.
 *
 * Safe to share because encoding is synchronous and single-threaded — the bytes are
 * out before the next entity overwrites it. Shape is fixed and assigned in a constant
 * order so it keeps one hidden class. @private
 */
const _record = {
  id: 0, def: "", rarity: "", x: 0, y: 0, angle: 0, mo: 0, dir: 0, ag: 0,
  tgt: 0, par: 0, stk: 0, ptl: null, cnt: 1, oba: -1, orot: 0, hb: null, hp: undefined,
};

/**
 * Project a live `Entity` onto the wire's field names, into `out`. Mirrors
 * `Protocol.snapshot`'s packing exactly — if one changes the other must.
 *
 * The hotbar is passed by REFERENCE rather than deep-copied (which `Protocol.snapshot`
 * has to do, since a loopback peer would otherwise receive live slot objects holding a
 * real petal entity). Here nothing escapes: the encoder reads `petal`, `loaded` and
 * `timeTillLoaded` and writes bytes, so there's nothing to leak. @private
 */
function fromEntity(e, out) {
  out.id = e.id;
  out.def = e.defId;
  out.rarity = e.rarity;
  out.x = e.x;
  out.y = e.y;
  out.angle = e.angle;
  out.mo = e.momentum;
  out.dir = e.direction;
  out.ag = e.aggroed ? 1 : 0;
  out.tgt = e.targetAlly ? e.targetAlly.id : 0;
  out.par = e.parent ? e.parent.id : 0;
  out.stk = e.stick ? e.stick.id : 0;
  out.ptl = e.petal ?? null;
  out.cnt = e.count ?? 1;
  out.oba = e.orbitBase ?? -1;
  out.orot = e.orbit1Rotation ?? 0;
  out.hb = e.hotbar ?? null;
  out.hp = e.health;
  return out;
}

/**
 * Scratch for `encodeSnapshot`'s two passes (measure the buffer, then fill it), so each
 * entity's mask is computed once instead of twice. Module-level and reused rather than
 * allocated per call — `encodeSnapshot` never yields, so no other call can interleave
 * with one in flight. @private
 */
const _maskScratch = [];

/**
 * Encode a Protocol message to an ArrayBuffer. Snapshots pack to binary; all other
 * messages ride as tagged JSON.
 * @param {object} msg A Protocol message (`welcome`, `snapshot`, `command`, …).
 * @returns {ArrayBuffer}
 */
export function encode(message) {
  if (message && message.type === MSG.SNAPSHOT) return encodeSnapshot(message);
  return encodeJson(message);
}

/**
 * Decode a wire frame back to the plain Protocol message. Accepts an ArrayBuffer, a
 * TypedArray, or a Node Buffer (the browser and `ws` hand back different shapes).
 * @param {ArrayBuffer|ArrayBufferView} buf
 * @returns {object}
 */
export function decode(buffer) {
  const dataView = asDataView(buffer);
  const tag = dataView.getUint8(0);
  if (tag === TAG_SNAPSHOT) return decodeSnapshot(dataView);
  return decodeJson(dataView);
}

// --- snapshot (binary) -------------------------------------------------------

/** @param {object} message a `snapshot()` result @returns {ArrayBuffer} @private */
function encodeSnapshot(message) {
  const entities = message.entities;
  const worldId = message.worldId ?? "";
  // Header: tag(1) + worldIdLen(1) + worldId(ascii) + WORLD BLOCK + step(u32)
  //        + time(f64) + count(u16).
  //
  // The world block describes the world itself rather than what's in it: a `uint8`
  // WORLD_STAT, and — for INGAME — the barrier geometry, so a client can predict
  // against the same walls the server clamps to without owning the generator that
  // made the room. Positions first (int16 cx, int16 cy each), then the directions in
  // one packed run at 2 bits apiece.
  const walls = message.walls ?? [];
  const wallCount = Math.min(walls.length, WALL_MAX);
  const floor = message.floor ?? null;
  // An absent patch is sent as a 0x0 box — "no ground news this snapshot" — so the
  // reader's branch is on the size, not on a second presence flag.
  const fw = floor ? floor.w : 0;
  const fh = floor ? floor.h : 0;
  const worldStat = message.worldStat ?? WORLD_STAT.INGAME;
  const worldBlockBytes = 1 + (worldStat === WORLD_STAT.INGAME
    ? FLOOR_HEAD_BYTES + floorMaskBytes(fw, fh)
      + 1 + wallCount * WALL_POS_BYTES + wallDirBytes(wallCount)
    : 0);
  const headerBytes = 1 + 1 + worldId.length + worldBlockBytes + 4 + 8 + 2;
  // Records have no uniform stride: each carries only the fields its mask names (plus a
  // hotbar tail on the few that have one), so the body is measured rather than
  // multiplied. Decoding is unaffected — it already walks a running offset, never
  // indexing by record. Masks are kept in `_maskScratch` so the write pass below doesn't
  // recompute what this pass already worked out.
  let bodyBytes = 0;
  _maskScratch.length = entities.length;
  // `raw` means `entities` are live Entity objects rather than packed records — the
  // socket path, which skips building the intermediate objects entirely.
  const raw = message.raw === true;
  for (let i = 0; i < entities.length; i++) {
    const e = raw ? fromEntity(entities[i], _record) : entities[i];
    const mask = fieldMask(e);
    _maskScratch[i] = mask;
    bodyBytes += recordBytes(mask, e);
  }
  const buffer = new ArrayBuffer(headerBytes + bodyBytes);
  const dataView = new DataView(buffer);
  let offset = 0;
  dataView.setUint8(offset, TAG_SNAPSHOT); offset += 1;
  dataView.setUint8(offset, worldId.length); offset += 1;
  for (let i = 0; i < worldId.length; i++) { dataView.setUint8(offset, worldId.charCodeAt(i) & 0xff); offset += 1; }
  // --- world block ---
  dataView.setUint8(offset, worldStat); offset += 1;
  if (worldStat === WORLD_STAT.INGAME) {
    // Floor patch: box origin + size, then one bit per cell (row-major, LSB first).
    dataView.setInt16(offset, floor ? floor.cx0 : 0, true); offset += 2;
    dataView.setInt16(offset, floor ? floor.cy0 : 0, true); offset += 2;
    dataView.setUint8(offset, fw); offset += 1;
    dataView.setUint8(offset, fh); offset += 1;
    const maskBytes = floorMaskBytes(fw, fh);
    for (let i = 0; i < maskBytes; i++) { dataView.setUint8(offset, floor.bits[i] ?? 0); offset += 1; }
    dataView.setUint8(offset, wallCount); offset += 1;
    for (let i = 0; i < wallCount; i++) {
      dataView.setInt16(offset, walls[i].cx, true); offset += 2;
      dataView.setInt16(offset, walls[i].cy, true); offset += 2;
    }
    // Directions, 2 bits each, four per byte, low bits first. Written as a separate
    // run so the position records stay a fixed stride the reader can walk.
    for (let i = 0; i < wallCount; i += 4) {
      let packed = 0;
      for (let j = 0; j < 4 && i + j < wallCount; j++) packed |= (walls[i + j].dir & 3) << (j * 2);
      dataView.setUint8(offset, packed); offset += 1;
    }
  }
  dataView.setUint32(offset, message.step >>> 0, true); offset += 4;
  dataView.setFloat64(offset, message.time, true); offset += 8;
  dataView.setUint16(offset, entities.length, true); offset += 2;

  for (let i = 0; i < entities.length; i++) {
    const entity = raw ? fromEntity(entities[i], _record) : entities[i];
    const mask = _maskScratch[i];
    // Always-present head. The mask rides here, right before the optional fields it
    // describes, so the reader knows what follows before it reaches any of it.
    dataView.setUint32(offset, entity.id >>> 0, true); offset += 4;
    dataView.setUint16(offset, defWireId(entity.def), true); offset += 2;
    dataView.setUint8(offset, rarityTier(entity.rarity)); offset += 1;
    dataView.setUint16(offset, mask, true); offset += 2;
    dataView.setFloat32(offset, entity.x, true); offset += 4;
    dataView.setFloat32(offset, entity.y, true); offset += 4;
    // Optional fields, LOW BIT → HIGH BIT. `decodeSnapshot` reads them in exactly this
    // order; anything whose bit is clear simply isn't here. (`ag` needs no write — its
    // bit in the mask already carried it.)
    if (mask & FIELD.ANGLE) { dataView.setInt16(offset, packAngle(entity.angle), true); offset += 2; }
    if (mask & FIELD.DIR) { dataView.setInt16(offset, packAngle(entity.dir), true); offset += 2; }
    if (mask & FIELD.MO) { dataView.setFloat32(offset, entity.mo, true); offset += 4; }
    if (mask & FIELD.TGT) { dataView.setUint32(offset, entity.tgt >>> 0, true); offset += 4; }
    if (mask & FIELD.PAR) { dataView.setUint32(offset, entity.par >>> 0, true); offset += 4; }
    if (mask & FIELD.STK) { dataView.setUint32(offset, entity.stk >>> 0, true); offset += 4; }
    // Held petal as a manifest index, same table `def` uses (so the id string never
    // travels). No PETAL_NONE sentinel needed anymore — absence is the clear bit.
    if (mask & FIELD.PTL) { dataView.setUint16(offset, defWireId(entity.ptl), true); offset += 2; }
    // Stack size of a container. A uint16 — counts are small, but a byte would silently
    // wrap a big stack. Only present when it isn't the default 1.
    if (mask & FIELD.CNT) { dataView.setUint16(offset, packCount(entity.cnt), true); offset += 2; }
    // Ring place + the entity's own ring rotation. Both are angles, so both quantize to
    // int16 like `angle`/`dir`. `oba` is normalized into [-π, π] first — it's used as an
    // offset, so which turn of the circle it names doesn't matter.
    if (mask & FIELD.OBA) { dataView.setUint16(offset, packTurn(entity.oba), true); offset += 2; }
    if (mask & FIELD.OROT) { dataView.setInt16(offset, packAngle(normalizeAngle(entity.orot)), true); offset += 2; }
    if (mask & FIELD.HP) { dataView.setFloat32(offset, entity.hp, true); offset += 4; }
    // Hotbar tail (only when present): per row, its slot count then its slots, in
    // HOTBAR_ROWS order — row NAMES never travel. Each slot is a petal def index, or
    // PETAL_NONE when empty. Mirrored in `decodeSnapshot`.
    if (mask & FIELD.HB) {
      const hotbar = entity.hb;
      for (let r = 0; r < HOTBAR_ROWS.length; r++) {
        const slots = hotbar[HOTBAR_ROWS[r]];
        dataView.setUint8(offset, slots.length); offset += 1;
        for (let s = 0; s < slots.length; s++) {
          const slot = slots[s];
          const petal = slot != null ? slot.petal : null;
          dataView.setUint16(offset, petal ? defWireId(petal) : PETAL_NONE, true); offset += 2;
          dataView.setUint8(offset, rarityTier(slot != null ? slot.rarity : undefined)); offset += 1;
          dataView.setUint8(offset, slot != null && slot.loaded ? 1 : 0); offset += 1;
          dataView.setFloat32(offset, slot != null ? slot.timeTillLoaded : 0, true); offset += 4;
        }
      }
    }
  }
  return buffer;
}

/** @param {DataView} dataView @returns {object} @private */
function decodeSnapshot(dataView) {
  let offset = 1; // tag already read
  const worldLen = dataView.getUint8(offset); offset += 1;
  let worldId = "";
  for (let i = 0; i < worldLen; i++) { worldId += String.fromCharCode(dataView.getUint8(offset)); offset += 1; }
  // --- world block --- (mirror of the encoder; see there for the layout)
  const worldStat = dataView.getUint8(offset); offset += 1;
  const walls = [];
  let floor = null;
  if (worldStat === WORLD_STAT.INGAME) {
    const cx0 = dataView.getInt16(offset, true); offset += 2;
    const cy0 = dataView.getInt16(offset, true); offset += 2;
    const fw = dataView.getUint8(offset); offset += 1;
    const fh = dataView.getUint8(offset); offset += 1;
    const maskBytes = floorMaskBytes(fw, fh);
    const bits = new Uint8Array(maskBytes);
    for (let i = 0; i < maskBytes; i++) { bits[i] = dataView.getUint8(offset); offset += 1; }
    // A 0x0 box means the sender had nothing to say about the ground this snapshot.
    if (fw > 0 && fh > 0) floor = { cx0, cy0, w: fw, h: fh, bits };
    const wallCount = dataView.getUint8(offset); offset += 1;
    for (let i = 0; i < wallCount; i++) {
      const cx = dataView.getInt16(offset, true); offset += 2;
      const cy = dataView.getInt16(offset, true); offset += 2;
      walls.push({ cx, cy, dir: 0 });
    }
    for (let i = 0; i < wallCount; i += 4) {
      const packed = dataView.getUint8(offset); offset += 1;
      for (let j = 0; j < 4 && i + j < wallCount; j++) walls[i + j].dir = (packed >> (j * 2)) & 3;
    }
  }
  const step = dataView.getUint32(offset, true); offset += 4;
  const time = dataView.getFloat64(offset, true); offset += 8;
  const count = dataView.getUint16(offset, true); offset += 2;

  const entities = new Array(count);
  for (let i = 0; i < count; i++) {
    const id = dataView.getUint32(offset, true); offset += 4;
    const def = wireDefId(dataView.getUint16(offset, true)); offset += 2;
    const rarity = RARITY[dataView.getUint8(offset)]; offset += 1;
    const mask = dataView.getUint16(offset, true); offset += 2;
    const x = dataView.getFloat32(offset, true); offset += 4;
    const y = dataView.getFloat32(offset, true); offset += 4;
    // Optional fields, in the encoder's low→high bit order. A clear bit means the field
    // isn't on the wire, so the DEFAULT below stands — and these defaults are the
    // contract: they have to match what `snapshot()` would have sent, or a skipped
    // field changes meaning. `hp` is the exception, left off the object entirely when
    // absent (Protocol/Client both treat "no hp" as distinct from 0).
    let angle = 0, dir = 0, mo = 0, tgt = 0, par = 0, stk = 0;
    let ptl = null, cnt = 1, oba = -1, orot = 0;
    if (mask & FIELD.ANGLE) { angle = unpackAngle(dataView.getInt16(offset, true)); offset += 2; }
    if (mask & FIELD.DIR) { dir = unpackAngle(dataView.getInt16(offset, true)); offset += 2; }
    if (mask & FIELD.MO) { mo = dataView.getFloat32(offset, true); offset += 4; }
    if (mask & FIELD.TGT) { tgt = dataView.getUint32(offset, true); offset += 4; }
    if (mask & FIELD.PAR) { par = dataView.getUint32(offset, true); offset += 4; }
    if (mask & FIELD.STK) { stk = dataView.getUint32(offset, true); offset += 4; }
    if (mask & FIELD.PTL) { ptl = wireDefId(dataView.getUint16(offset, true)); offset += 2; }
    if (mask & FIELD.CNT) { cnt = dataView.getUint16(offset, true); offset += 2; }
    if (mask & FIELD.OBA) { oba = unpackTurn(dataView.getUint16(offset, true)); offset += 2; }
    if (mask & FIELD.OROT) { orot = unpackAngle(dataView.getInt16(offset, true)); offset += 2; }
    let hp = 0;
    if (mask & FIELD.HP) { hp = dataView.getFloat32(offset, true); offset += 4; }
    // Hotbar tail — mirror of the encoder, rows rebuilt by position from HOTBAR_ROWS.
    // Absent (bit clear) → null, matching what Protocol sends for a non-player.
    let hb = null;
    if (mask & FIELD.HB) {
      hb = {};
      for (let r = 0; r < HOTBAR_ROWS.length; r++) {
        const count = dataView.getUint8(offset); offset += 1;
        const slots = new Array(count);
        for (let s = 0; s < count; s++) {
          const wire = dataView.getUint16(offset, true); offset += 2;
          const rarity = RARITY[dataView.getUint8(offset)]; offset += 1;
          const loaded = dataView.getUint8(offset) === 1; offset += 1;
          const timeTillLoaded = dataView.getFloat32(offset, true); offset += 4;
          slots[s] = { petal: wire === PETAL_NONE ? null : wireDefId(wire), rarity, loaded, timeTillLoaded };
        }
        hb[HOTBAR_ROWS[r]] = slots;
      }
    }
    // Rebuilt WHOLE, defaults filled in — the mask is a wire concern only, so callers
    // (Client, tests) see the same uniform shape `snapshot()` produces either way.
    const entity = { id, def, rarity, x, y, angle, mo, dir, ag: mask & FIELD.AG ? 1 : 0,
      tgt, par, stk, ptl, cnt, oba, orot, hb };
    if (mask & FIELD.HP) entity.hp = hp; // omit when absent, matching Protocol/Client
    entities[i] = entity;
  }
  return { type: MSG.SNAPSHOT, step, time, worldId, worldStat, walls, floor, entities };
}

// --- everything else (tagged JSON) -------------------------------------------

/** @param {object} message @returns {ArrayBuffer} @private */
function encodeJson(message) {
  const json = JSON.stringify(message);
  // tag(1) + UTF-8 JSON. Prefer TextEncoder (browser/Node); ASCII fallback elsewhere.
  if (typeof TextEncoder !== "undefined") {
    const body = new TextEncoder().encode(json);
    const out = new Uint8Array(body.length + 1);
    out[0] = TAG_JSON;
    out.set(body, 1);
    return out.buffer;
  }
  const out = new Uint8Array(json.length + 1);
  out[0] = TAG_JSON;
  for (let i = 0; i < json.length; i++) out[i + 1] = json.charCodeAt(i) & 0xff;
  return out.buffer;
}

/** @param {DataView} dataView @returns {object} @private */
function decodeJson(dataView) {
  const bytes = new Uint8Array(dataView.buffer, dataView.byteOffset + 1, dataView.byteLength - 1);
  let json;
  if (typeof TextDecoder !== "undefined") {
    json = new TextDecoder().decode(bytes);
  } else {
    json = "";
    for (let i = 0; i < bytes.length; i++) json += String.fromCharCode(bytes[i]);
  }
  return JSON.parse(json);
}

/** Normalize any wire input (ArrayBuffer / TypedArray / Buffer) to a DataView. @private */
function asDataView(buffer) {
  if (buffer instanceof DataView) return buffer;
  if (buffer instanceof ArrayBuffer) return new DataView(buffer);
  if (ArrayBuffer.isView(buffer)) return new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  throw new Error("Codec.decode: unsupported wire frame type");
}
