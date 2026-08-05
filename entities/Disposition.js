// Disposition "enum" — an entity's allegiance / behaviour. Its own module so
// Entity and the entity defs can share the values without importing each other
// (same no-cycle reason Rarity.js is separate). Def `disposition` strings map to
// these.

/**
 * Frozen-object enum, same pattern as `Rarity`.
 *   - `HOSTILE` — always seeks allied targets (detection range ×1.5).
 *   - `NEUTRAL` — only seeks once `aggroed` (detection off until provoked).
 *   - `PASSIVE` — never aggressive (wanders / flees).
 *   - `ALLIED`  — players / pets: the side hostile mobs target. Doesn't seek.
 */
export const Disposition = Object.freeze({
  HOSTILE: "hostile",
  NEUTRAL: "neutral",
  PASSIVE: "passive",
  ALLIED: "allied",
});
