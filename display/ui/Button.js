// Button — a clickable Pixi UI button: a rounded-rect background + centered text
// label, wired for pointer interaction (hover tint + tap callback). Screen-space,
// for the HUD / `ui` layer (e.g. pause-menu buttons). Origin-centered, so place it
// by setting `.x`/`.y`. Reads/does nothing to game state itself — the `onClick` it's
// given decides what happens.

import { roundedRect } from "../shaders/RoundedRect.js";

const DEFAULTS = {
  width: 220, height: 54, radius: 18,
  color: 0x3a7755, hover: 0x4a936b,        // green, lighter on hover
  textColor: 0xffffff, fontSize: 20,
};

/**
 * Build a clickable button.
 * @param {string} label Button text.
 * @param {() => void} onClick Fired on tap/click.
 * @param {Partial<typeof DEFAULTS>} [opts] Visual overrides.
 * @returns {any} A `PIXI.Container` (origin-centered) with `.btnWidth`/`.btnHeight`
 *   and a `setEnabled(on)` helper.
 */
export function button(label, onClick, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const c = new PIXI.Container();

  const bg = roundedRect({ width: o.width, height: o.height, radius: o.radius, color: o.color });
  c.addChild(bg);

  const text = new PIXI.Text({
    text: label,
    style: { fill: o.textColor, fontSize: o.fontSize, fontFamily: "system-ui, sans-serif", fontWeight: "700" },
  });
  text.anchor.set(0.5);
  c.addChild(text);

  // Interactivity. An explicit rectangular hit area (centered) so the whole button
  // is clickable regardless of the SDF mesh's reported bounds.
  c.eventMode = "static";
  c.cursor = "pointer";
  c.hitArea = new PIXI.Rectangle(-o.width / 2, -o.height / 2, o.width, o.height);
  let enabled = true;
  c.on("pointertap", () => { if (enabled) onClick?.(); });
  c.on("pointerover", () => { if (enabled) bg.setColor(o.hover); });
  c.on("pointerout", () => bg.setColor(o.color));

  c.btnWidth = o.width;
  c.btnHeight = o.height;
  /** Enable/disable clicks + dim when disabled. */
  c.setEnabled = (on) => { enabled = on; c.alpha = on ? 1 : 0.5; c.cursor = on ? "pointer" : "default"; };
  return c;
}
