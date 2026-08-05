// RarityScaling — how a rarity TIER scales an entity's base stats.
//
// One rule per stat, applied uniformly across every species: a def carries the
// COMMON-tier value and these turn it into the value for the tier actually spawned.
// Gathered here because the formulas were duplicated between `Entity`'s constructor
// and `Entity.setRarity` (whose doc still says "keep the two in sync" — that sync is
// now structural, not a promise), and because the constants themselves were split
// across two files: the growth fractions sat in `entities/Rarity.js` while the
// multipliers sat in `entities/Entity.js`, each pointing at the other in a comment.
//
// Two shapes of curve, and the difference is deliberate:
//   - GEOMETRIC (`base × mult^tier`) for size, health and damage — the stats meant
//     to run away with rarity, so a high tier is genuinely a different fight.
//   - LINEAR (`base × (1 + tier × growth)`) for density and speed — the stats that
//     would make a mob unplayable if they exploded. A 10th-tier mob is 6× as dense,
//     not 57×.
//
// `entities/Rarity.js` keeps the tier ENUM and the id → tier lookup; this file owns
// what a tier DOES. Takes a tier number, not a rarity id, so it stays pure math and
// callers do the lookup once. Imports nothing.

/** Size multiplies by this per tier — common ×1, unusual ×1.5, rare ×2.25, … */
export const SIZE_RARITY_MULT = 1.5;

/** Max health multiplies by this per tier — common ×1, unusual ×3, rare ×9, … */
export const HEALTH_RARITY_MULT = 3;

/** Contact damage multiplies by this per tier — common ×1, unusual ×2, rare ×4, … */
export const DAMAGE_RARITY_MULT = 2;

/** Each tier adds this FRACTION of the base density (linear, not geometric). */
export const DENSITY_RARITY_GROWTH = 0.5; // +50% per tier

/** Each tier adds this FRACTION of the base speed (linear, not geometric). */
export const SPEED_RARITY_GROWTH = 0.1; // +10% per tier

/**
 * Size multiplier at `tier` — `SIZE_RARITY_MULT^tier`, so each rarity is 1.5× the
 * last and common (tier 0) is ×1. Callers multiply a def's `size` (and any collider
 * extent derived from it) by this.
 * @param {number} tier @returns {number}
 */
export function sizeScaleAt(tier) {
  return SIZE_RARITY_MULT ** tier;
}

/**
 * Max health for a base value at `tier`. A def with no numeric `health` has none at
 * any tier — 0 rather than NaN, which is what "not a damageable thing" means to the
 * view (no health bar) and to `checkIfDead`.
 * @param {number|undefined} base The def's common-tier `health`.
 * @param {number} tier @returns {number}
 */
export function healthAt(base, tier) {
  if (typeof base !== "number") return 0;
  return base * HEALTH_RARITY_MULT ** tier;
}

/**
 * Contact-damage multiplier at `tier` — applied to both the `other` and `allies`
 * amounts of a `doDamage` block, so a rarer body hits harder without the def
 * restating it per tier.
 * @param {number} tier @returns {number}
 */
export function damageScaleAt(tier) {
  return DAMAGE_RARITY_MULT ** tier;
}

/**
 * Density at `tier` — LINEAR growth. Density drives knockback, so a geometric curve
 * here would make a high-tier mob an immovable wall that flings everything it
 * touches off-screen.
 * @param {number} base The def's common-tier `density`. @param {number} tier
 * @returns {number}
 */
export function densityAt(base, tier) {
  return base * (1 + tier * DENSITY_RARITY_GROWTH);
}

/**
 * Speed at `tier` — LINEAR, for the same reason as {@link densityAt}: a geometric
 * curve would put a high-tier mob past anything a player could outrun.
 * @param {number} base The def's common-tier `speed`. @param {number} tier
 * @returns {number}
 */
export function speedAt(base, tier) {
  return base * (1 + tier * SPEED_RARITY_GROWTH);
}
