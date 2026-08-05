// Entity definition registry — the data-driven replacement for the old
// MobVariety `switch`. Every spawnable entity is described by a JSON file under
// `Assets/jsons/entities/` (stats AND visual together), listed in `index.json`.
//
// Why a load step: entity stats are read SYNCHRONOUSLY inside the `Entity`
// constructor (so the collision/AI hot loops get plain instance fields, not a
// lookup per access). JSON is fetched ASYNCHRONOUSLY. So the app must
// `await loadEntityDefs()` ONCE at boot, before constructing any entity; after
// that, `entityDef(id)` is a synchronous Map read.
//
// `Assets/` is a neutral location: the GameEngine reads the gameplay fields
// (size/density/speed/…), the view reads `def.visual` — neither reaches into the
// other, so the headless-engine / view split is preserved even though the data
// lives in one file.

/**
 * @typedef {Object} EntityVisual
 * @property {"sprite"|"circle"} type How the view should draw it.
 *   - `sprite`: textured. Uses `texture` (filename under the view's texture dir),
 *     `scale` (drawn diameter ÷ collision diameter), `offsetX`/`offsetY`
 *     (fraction-of-size nudge), `directionOffset` (radians added to facing).
 *   - `circle`: an SDF circle. Uses `fill`, `stroke`, `strokeWidth`, `smooth`
 *     (edge feather as a percent of radius). The player draws this way.
 * @property {number} [zIndex] Draw priority — higher draws on top, default 0.
 *   The world container is z-sorted, so this orders entities regardless of spawn
 *   order (e.g. the player sits above mobs). Common to both visual types.
 *
 * @typedef {Object} EntityDef
 * @property {string} id            The entity id (filename stem; injected on load).
 * @property {string} kind          Entity tag ("mob" / "player" / "petal" / …).
 * @property {string} disposition   One of {@link Disposition} ("hostile" / …).
 * @property {number} size          Base collision radius at the lowest rarity.
 * @property {number} density       Mass-like value at the lowest rarity.
 * @property {number} [health]      Base (common-tier) max hit points; scaled ×3
 *                                  per rarity tier in `Entity`. Absent → 0.
 * @property {number} speed         Movement magnitude per step at the lowest rarity.
 * @property {number} rangeMult     Detection range as a multiple of collision radius.
 * @property {number} [turnRate]     Max heading change per tick in DEGREES, for
 *   gradual turning toward a target. Omit / 0 → snap instantly to face the target.
 * @property {object} [collided]    Collision behaviour: `knockback` toggles, a
 *   `doDamage { self, other, allies? }` contact-damage block, the `runOnCollided` /
 *   `runOnSelf` attribute lists, and a `resistance` name list. List items are a
 *   bare name `"x"` or `{ "do": "x", ...params }`. See `Attributes.js`.
 * @property {Array<string|object>} [onDeath] Attribute entries run when the entity
 *   is destroyed (e.g. `["explode", { "do": "dropLoot", "count": 3 }]`). Fired by
 *   `Entity.destroy` (not `demolish`). See `Attributes.js` `runOnDeath`.
 * @property {Array<string|object>} [onUpdate] Attribute entries run every sim tick
 *   on the entity (e.g. `["checkIfDead"]`, regen, status timers). Same entry shape.
 *   Fired by `GameEngine.step`. See `Attributes.js` `runOnUpdate`.
 * @property {EntityVisual} visual  How the view draws it.
 */

/** Default location of the entity JSON, relative to the loading document. */
const DEFAULT_BASE = "Assets/jsons/entities";

/** A manifest entry's bare id — the basename of its path ("mobs/hornet" → "hornet",
 * "player" → "player"). The def is keyed/spawned by this, never the folder. @private */
function basename(path) {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** id → {@link EntityDef}. Empty until {@link loadEntityDefs} runs. @type {Map<string, EntityDef>} */
const _defs = new Map();
let _loaded = false;

/** Wire-id table for the binary protocol: a def's integer index ON THE WIRE is its
 * position in the manifest (`index.json` `entities` order). Both ends load the SAME
 * manifest in the SAME order, so the mapping agrees without being transmitted.
 * `_wireToId[n]` → defId; `_idToWire.get(defId)` → n. Rebuilt on every (re)load. */
const _wireToId = [];
const _idToWire = new Map();

/** (Re)build the wire-id tables from the registry's current insertion order (=
 * manifest order). Called at the end of both load paths. @private */
function buildWireTable() {
  _wireToId.length = 0;
  _idToWire.clear();
  for (const id of _defs.keys()) {
    _idToWire.set(id, _wireToId.length);
    _wireToId.push(id);
  }
}

/**
 * Fetch the manifest (`index.json`) and every entity file it lists, into the
 * registry. Idempotent — a second call is a no-op (so multiple boot paths can
 * call it safely). MUST complete before any `new Entity(...)`.
 *
 * @param {string} [base=DEFAULT_BASE] Directory holding `index.json` + the entity
 *   files, resolved relative to the calling document's URL. Pass a different base
 *   from a page nested below the root (e.g. `"../../Assets/jsons/entities"`).
 * @returns {Promise<Map<string, EntityDef>>} the populated registry.
 */
export async function loadEntityDefs(base = DEFAULT_BASE) {
  if (_loaded) return _defs;

  const manifest = await fetchJson(`${base}/index.json`);
  const paths = manifest.entities;
  if (!Array.isArray(paths)) {
    throw new Error(`entity manifest ${base}/index.json has no "entities" array`);
  }

  // Each manifest entry is a PATH relative to `base`, without `.json` (e.g.
  // "mobs/hornet"); the def's id is the basename ("hornet"). Fetch all in parallel —
  // one slow file doesn't serialize the rest.
  const defs = await Promise.all(
    paths.map((path) => fetchJson(`${base}/${path}.json`).then((d) => ({ ...d, id: basename(path) })))
  );
  for (const def of defs) _defs.set(def.id, def);

  _loaded = true;
  buildWireTable();
  return _defs;
}

/**
 * Register pre-fetched defs SYNCHRONOUSLY — for environments without `fetch`/a DOM
 * (the Node dedicated server reads the JSON off disk; tests pass literals). Pass the
 * defs IN MANIFEST ORDER (the `index.json` `entities` order) so the wire-id table
 * matches a browser `loadEntityDefs`. Idempotent like `loadEntityDefs`.
 * @param {EntityDef[]} defs Each must carry its own `id`.
 * @returns {Map<string, EntityDef>} the populated registry.
 */
export function loadEntityDefsFromList(defs) {
  if (_loaded) return _defs;
  for (const def of defs) _defs.set(def.id, def);
  _loaded = true;
  buildWireTable();
  return _defs;
}

/**
 * A def's integer id ON THE WIRE (its manifest index). The binary codec sends this
 * instead of the def string. Throws on an unknown id (a desync bug, not a silent 0).
 * @param {string} id @returns {number}
 */
export function defWireId(id) {
  const n = _idToWire.get(id);
  if (n === undefined) throw new Error(`defWireId: unknown entity id "${id}"`);
  return n;
}

/**
 * Reverse of {@link defWireId}: the def string for a wire id. Throws on an
 * out-of-range id (the two ends disagree on the roster).
 * @param {number} n @returns {string}
 */
export function wireDefId(n) {
  const id = _wireToId[n];
  if (id === undefined) throw new Error(`wireDefId: out-of-range wire id ${n}`);
  return id;
}

/** Fetch + parse JSON with a clear error on a bad response. @private */
async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`failed to load ${url}: HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * The definition for `id`. Throws (rather than returning a silent fallback) if
 * unknown or if the registry isn't loaded yet — a typo'd id or a forgotten
 * `await loadEntityDefs()` should fail loudly, not spawn a broken entity.
 * @param {string} id An entity id (a key in `index.json`).
 * @returns {EntityDef}
 */
export function entityDef(id) {
  const def = _defs.get(id);
  if (def === undefined) {
    if (!_loaded) {
      throw new Error(
        `entityDef("${id}") before loadEntityDefs() finished — await it at boot`
      );
    }
    throw new Error(
      `unknown entity id "${id}". Known: ${[..._defs.keys()].join(", ")}`
    );
  }
  return def;
}

/** Every loaded entity id (the manifest roster). @returns {string[]} */
export function allEntityIds() {
  return [..._defs.keys()];
}

/** Is a def registered under `id`? (Lets a caller spawn it only if present — e.g. an
 * optional starter loadout that mustn't crash where the def isn't loaded.) @returns {boolean} */
export function hasEntityDef(id) {
  return _defs.has(id);
}

/** Whether {@link loadEntityDefs} has completed. @returns {boolean} */
export function entityDefsLoaded() {
  return _loaded;
}
