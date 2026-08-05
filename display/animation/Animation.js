// Animation — the screen in-flight visuals are drawn on, and the loop that advances
// them.
//
// A transition (see `Transition.js`) is pure maths; this is what gives it a body. You
// hand it a display object and a transition, it parents that object into its own
// container, moves and scales it every frame, then destroys it and tells you it's done.
//
// ITS OWN LAYER on purpose. A petal flying between hotbar slots doesn't belong to
// either slot — the source has already given it up and the destination hasn't received
// it yet — so it can't live in either one's node without being clipped, re-sorted, or
// destroyed underneath the animation. A separate container above the HUD means the
// thing in flight is nobody's child until it lands.
//
// The caller is expected to HIDE whatever the animation stands in for while it runs
// (a slot draws no emblem while its petal is in the air) and to show it again from
// `onDone`. This module doesn't know what it's carrying, so it can't do that itself.
//
// Screen space, like the rest of the HUD: positions are logical pixels, unaffected by
// the camera.

import { TICK_RATE } from "./Transition.js";

/**
 * Create an animation screen.
 *
 * @returns {{container: any, play(node:any, tr:object, onDone?:()=>void):any,
 *   update(dtSec:number):void, count:number, clear():void}}
 */
export function animationScreen() {
  const container = new PIXI.Container();
  container.sortableChildren = true;

  /** Live entries: `{ node, tr, onDone }`. @private */
  const running = [];

  return {
    /** The display object to parent into the UI layer. */
    container,

    /**
     * Start an animation: `node` follows `tr` until it arrives, then is destroyed.
     *
     * The node's `scale` is driven from the transition's size relative to its STARTING
     * size, so a caller can build the graphic once at its natural size and let this
     * shrink or grow it. That's why `size` is unit-agnostic in `Transition` — here it
     * only ever matters as a ratio.
     *
     * @param {any} node A Pixi display object, already built at its starting size.
     * @param {object} tr A {@link transition}.
     * @param {() => void} [onDone] Called once, after the node is destroyed — where a
     *   caller un-hides whatever the animation was standing in for.
     * @returns {any} the node.
     */
    play(node, tr, onDone) {
      const start = tr.at(0);
      node.x = start.x;
      node.y = start.y;
      container.addChild(node);
      running.push({ node, tr, onDone, baseSize: start.size || 1 });
      return node;
    },

    /**
     * Advance every running animation by `dtSec` of real time.
     *
     * Converts to TICKS first, so the motion takes the same wall-clock time at any
     * frame rate — 30 ticks is half a second whether the display runs at 60Hz or 144.
     *
     * Iterates BACKWARD so finished entries can be swap-removed without skipping the
     * one that takes their place.
     *
     * @param {number} dtSec Seconds since the last frame.
     */
    update(dtSec) {
      if (running.length === 0) return;
      const ticks = dtSec * TICK_RATE;
      for (let i = running.length - 1; i >= 0; i--) {
        const entry = running[i];
        const pose = entry.tr.step(ticks);
        entry.node.x = pose.x;
        entry.node.y = pose.y;
        const k = pose.size / entry.baseSize;
        entry.node.scale.set(k);
        if (!pose.done) continue;
        // Arrived: drop the graphic, then hand control back. `onDone` runs AFTER the
        // teardown so a caller that re-shows the real thing can't briefly draw both.
        container.removeChild(entry.node);
        entry.node.destroy({ children: true });
        running[i] = running[running.length - 1];
        running.pop();
        entry.onDone?.();
      }
    },

    /** How many animations are in flight. */
    get count() { return running.length; },

    /**
     * Drop everything immediately, WITHOUT running the `onDone` callbacks — for a world
     * switch or a HUD teardown, where whatever the callbacks would restore is being
     * rebuilt anyway and calling them would touch nodes that are already gone.
     */
    clear() {
      for (const entry of running) {
        container.removeChild(entry.node);
        entry.node.destroy({ children: true });
      }
      running.length = 0;
    },
  };
}
