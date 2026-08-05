// WorldUI — per-world CLIENT presentation: which HUD pieces a world shows, and
// whether the player is drawn with a body.
//
// This is display config, not world state. It used to be read off the world databank
// (`hud` / `tags` in `WorldRegistry`), which meant the renderer depended on the world
// GENERATOR to know which buttons to draw — and the client shipped a duplicate of the
// server's world definitions to answer a question the server never asks.
//
// Both fields are presentation-only:
//   hud       which UI builders to mount (see `UI_BUILDERS` in PlayerHUD.js)
//   showBody  draw the player's body, or just park a camera at its position
//
// `showBody` MIRRORS a server rule ("movement" tag) rather than being one. The server
// enforces it — it drops movement intent from a world without the tag — so being wrong
// here can only make the client draw a body it can't move, never let it move a body it
// shouldn't. Keep them in step anyway; that's the deal with a client-side copy.
//
// If worlds ever stop being a fixed list, this is the thing to stream in the snapshot's
// world block alongside floor and walls, and delete.

/** Presentation for a world id. @private */
const WORLD_UI = new Map([
  ["test",  { hud: ["healthbar", "petalContainerUI", "pausemenu"], showBody: true }],
  ["test2", { hud: ["healthbar", "petalContainerUI", "pausemenu"], showBody: true }],
]);

/** What an unknown world gets: no HUD, no body. Safe defaults — a world we have no
 * presentation for renders as a bare camera rather than guessing. @private */
const DEFAULT_UI = Object.freeze({ hud: [], showBody: false });

/**
 * The UI builder ids a world mounts. Empty for an unknown id.
 * @param {string|null} worldId
 * @returns {string[]}
 */
export function worldHud(worldId) {
  return (worldId != null ? WORLD_UI.get(worldId) ?? DEFAULT_UI : DEFAULT_UI).hud;
}

/**
 * Is the player drawn as a body in this world (vs. a disembodied viewpoint)? Also
 * gates whether the client bothers sending movement intent — see the note above on
 * why that's a courtesy and not the rule.
 * @param {string|null} worldId
 * @returns {boolean}
 */
export function worldShowsBody(worldId) {
  return (worldId != null ? WORLD_UI.get(worldId) ?? DEFAULT_UI : DEFAULT_UI).showBody;
}
