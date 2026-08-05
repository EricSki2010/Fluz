// Transition — move something from one place and size to another over a fixed number
// of ticks.
//
// PURE. It owns no display object, allocates no graphics, and touches no Pixi: give it
// two poses and a duration and it tells you where the thing is at any point between
// them. That's deliberate — the same curve drives a petal flying between hotbar slots,
// and would drive anything else that needs to travel (a drop arcing into the bar, a
// number floating off a hit). What's being moved is the caller's problem.
//
// Duration is in TICKS rather than seconds because the rest of the game thinks in
// ticks, and a designer picking "30" should get the same motion on a 60Hz and a 144Hz
// display. `Animation.js` converts real elapsed time into ticks before stepping, so the
// motion is frame-rate independent.
//
// The interpolation is LINEAR — constant speed and a constant rate of size change, so
// something shrinking as it travels does both evenly rather than easing.

/** Ticks per second the `time` argument is expressed in. Matches the sim's rate, so a
 * duration reads the same here as it does in engine code. */
export const TICK_RATE = 60;

/** Linear blend. @private */
const lerp = (a, b, k) => a + (b - a) * k;

/**
 * A move from `pos`/`size` to `newPos`/`newSize` over `time` ticks.
 *
 * @param {{x:number, y:number}} pos Starting position (screen pixels).
 * @param {{x:number, y:number}} newPos Ending position.
 * @param {number} size Starting size (the same unit the caller draws in — a side
 *   length, a radius, a scale; this only interpolates the number).
 * @param {number} newSize Ending size.
 * @param {number} time Duration in ticks. Clamped to at least 1, so a zero or negative
 *   duration completes on the first step rather than dividing by zero.
 * @returns {{at(t:number):{x:number,y:number,size:number},
 *   step(ticks:number):{x:number,y:number,size:number,done:boolean},
 *   elapsed:number, total:number, done:boolean}}
 */
export function transition(pos, newPos, size, newSize, time) {
  const total = Math.max(1, time);
  let elapsed = 0;

  /** Pose at `t` ticks in. Clamped at both ends, so asking past the end gives the
   * destination rather than overshooting it. */
  const at = (t) => {
    const k = t <= 0 ? 0 : t >= total ? 1 : t / total;
    return { x: lerp(pos.x, newPos.x, k), y: lerp(pos.y, newPos.y, k), size: lerp(size, newSize, k) };
  };

  return {
    at,
    /** Advance by `ticks` and return the new pose, plus whether it's arrived. */
    step(ticks) {
      elapsed = Math.min(total, elapsed + ticks);
      const pose = at(elapsed);
      pose.done = elapsed >= total;
      return pose;
    },
    get elapsed() { return elapsed; },
    get total() { return total; },
    get done() { return elapsed >= total; },
  };
}
