// Shared rarity definitions. Lives in its own module so Entity (and anything
// else) can depend on it without import cycles.

/**
 * Rarity "enum" — named ids for each tier, lowest → highest. Use these constants
 * (e.g. `Rarity.MYTHIC`) instead of raw strings to avoid typos; the string
 * values double as the rarity ids stored on entities. Frozen-object enum.
 * Definition order IS tier order.
 */
export const Rarity = Object.freeze({
  COMMON: "common",
  UNUSUAL: "unusual",
  RARE: "rare",
  EPIC: "epic",
  LEGENDARY: "legendary",
  MYTHIC: "mythic",
  ULTRA: "ultra",
  SUPER: "super",
  OMEGA: "omega",
  FABLED: "fabled",
  DIVINE: "divine",
  SUPREME: "supreme",
  OMNIPOTENT: "omnipotent",
  ASTRAL: "astral",
  CELESTIAL: "celestial",
  SERAPHIC: "seraphic",
  TRANSCENDENT: "transcendent",
  QUANTUM: "quantum",
  GALACTIC: "galactic"
});

/**
 * Tiers lowest → highest, derived from `Rarity`'s insertion order. The index is
 * the tier number that size formulas scale off of.
 * @type {readonly string[]}
 */
export const RARITY = Object.freeze(Object.values(Rarity));

/**
 * Tier index for a rarity id, clamped so an unknown rarity reads as the lowest
 * tier (0) rather than -1.
 * @param {string} rarity
 * @returns {number}
 */
export function rarityTier(rarity) {
  const t = RARITY.indexOf(rarity);
  return t < 0 ? 0 : t;
}

// --- Per-tier stat growth ----------------------------------------------------
// What a tier DOES to an entity's stats lives in
// `mechanics/calculations/RarityScaling.js` — the growth fractions and multipliers
// together with the formulas that apply them. This file stays the tier ENUM and the
// id → tier lookup, so anything can depend on it without pulling in the scaling
// rules (or vice versa).
