// Angles — wraparound angle math, shared by anything that stores, blends, or
// compares a heading.
//
// Its own tiny module (like Regions.js) because callers with nothing else in common
// need IDENTICAL behaviour and must not drift apart: the client interpolating a
// remote player's facing between snapshots, the view interpolating every entity's
// facing across a sim tick, `seek` rate-limiting a mob's turn, and the codec
// normalizing an angle before quantizing it to int16. Imports nothing.
//
// Everything here is built on one primitive — `normalizeAngle`, which folds any
// angle into [-π, π). `angleDelta` is that applied to a difference (the SHORT way
// between two headings), and `lerpAngle` is `angleDelta` scaled. Written once so a
// fix lands everywhere rather than in whichever copy someone remembered.

/** One full turn. The wrap period every function here folds against. */
export const TWO_PI = Math.PI * 2;

/**
 * Fold any angle into [-π, π) — the canonical range for a stored heading.
 *
 * The double modulo is deliberate: JS `%` keeps the SIGN of its left operand, so a
 * single `% TWO_PI` maps negative inputs to (-2π, 0] instead of the range we want.
 * Adding `TWO_PI` and taking the modulo again lands both signs in [0, 2π) before the
 * final shift.
 *
 * @param {number} a Any angle in radians, however many turns from zero.
 * @returns {number} the equivalent angle in [-π, π).
 */
export function normalizeAngle(a) {
  return (((a + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI - Math.PI;
}

/**
 * Signed shortest rotation from `from` to `to`, in [-π, π). Positive turns one way,
 * negative the other, and it always picks the short arc — going 350° → 10° gives
 * +20°, not -340°.
 *
 * This is the primitive behind "turn toward" and "blend between" logic. Note it's
 * exactly `normalizeAngle(to - from)`: the difference of two angles is itself an
 * angle, and the short way round IS its canonical form.
 *
 * @param {number} from Start angle. @param {number} to End angle.
 * @returns {number} the shortest signed delta.
 */
export function angleDelta(from, to) {
  return normalizeAngle(to - from);
}

/**
 * Interpolate angle `a` → `b` the SHORT way around, in radians.
 *
 * The wraparound is the whole point: a naive `a + (b - a) * t` from 350° to 10°
 * sweeps 340° backwards through the full circle instead of 20° forwards, which reads
 * as a sprite spinning wildly whenever its facing crosses ±π.
 *
 * @param {number} a Start angle. @param {number} b End angle.
 * @param {number} t Blend factor, 0 = `a`, 1 = `b`.
 * @returns {number} the blended angle (NOT normalized — it stays near `a`, so a
 *   caller lerping in small steps doesn't see a jump when it crosses the seam).
 */
export function lerpAngle(a, b, t) {
  return a + angleDelta(a, b) * t;
}
