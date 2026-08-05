// Scalars — range math on plain numbers: clamping a value into bounds.
//
// Small, but it was written out twice already (the noise sampler folding its output
// into a 0-1 weight, and the health bar folding health/maxHealth into a fill
// fraction) with byte-identical bodies. Different subsystems, same rule — so it
// lives here rather than being re-typed a third time. Imports nothing.

/**
 * Clamp `v` into [0, 1] — the "fraction" clamp, for anything that has to end up a
 * ratio: a fill percentage, a blend weight, a normalized sample.
 *
 * Written as nested ternaries rather than `Math.min(Math.max(...))` so a NaN input
 * falls through to `v` (both comparisons are false) instead of silently becoming a
 * bound. A NaN ratio is a bug worth seeing, not one worth rounding to 0.
 *
 * @param {number} v
 * @returns {number} `v` clamped to [0, 1].
 */
export function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Clamp `v` into [`min`, `max`]. The general form of {@link clamp01}, with the same
 * NaN behaviour and the same reason for it.
 *
 * @param {number} v @param {number} min @param {number} max
 * @returns {number} `v` clamped to the range.
 */
export function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}
