// HealthBar — builds a health bar sized entirely from one `size` input. Layout
// (all proportional to `size`, so bars scale uniformly):
//   width   = size  × 0.6
//   height  = width × 0.2
//   border  = height × 0.1            (black outline thickness)
//   slip    = height × 0.1            (white margin around the fill)
//   TRACK (rect 1): a RARITY-colored rounded pill (radius 50%) with a black pill
//     inset by `border` on top, so the rarity color reads as a uniform outline.
//   FILL  (rect 2): inset by border+slip on ALL sides, so an even rarity-color slip
//     shows around it; at full health it spans the inner width edge-to-edge. Left-
//     anchored — its width × health/maxHealth, shrinking from the right (the bar
//     drains right→left). Its COLOR comes from the health ratio: green ≥66%, then
//     green→yellow→red→black as it falls (see `healthColor`).
// Returns a PIXI.Container (the three meshes) at zIndex 10, with a `setHealth`
// updater. Reads values only — never touches game state (see ui/API.md).

import { roundedRect } from "../shaders/RoundedRect.js";
import { rarityColor } from "../../geometry/RarityColors.js";
import { clamp01 } from "../../calculations/Scalars.js";


// Fill color by health ratio (RGB 0–255 stops): solid green ≥66%, then a gradient
// green→yellow (66%→33%), yellow→red (33%→5%), red→black (5%→0% = death). Just
// per-channel linear interpolation — cheap.
const C_GREEN = [62, 207, 62];
const C_YELLOW = [240, 210, 30];
const C_RED = [224, 40, 40];
const C_BLACK = [0, 0, 0];

/** Pack RGB (0–255) → 0xRRGGBB. @private */
function rgb(r, g, b) {
  return (r << 16) | (g << 8) | b;
}
/** Blend stops `a`→`b` at `t`∈[0,1] → 0xRRGGBB. @private */
function mix(a, b, t) {
  return rgb(
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t)
  );
}
/** Health ratio (0..1) → fill color (0xRRGGBB). @private */
function healthColor(ratio) {
  if (ratio >= 0.66) return rgb(C_GREEN[0], C_GREEN[1], C_GREEN[2]);
  if (ratio >= 0.33) return mix(C_GREEN, C_YELLOW, (0.66 - ratio) / (0.66 - 0.33));
  if (ratio >= 0.1) return mix(C_YELLOW, C_RED, (0.33 - ratio) / (0.33 - 0.1));
  return mix(C_RED, C_BLACK, (0.1 - ratio) / 0.1);
}

/**
 * Build a health bar from a single size. The fill's color is derived from the
 * health ratio (green→yellow→red→black, see `healthColor`).
 * @param {number} size Drives every dimension (see header).
 * @param {number} [health=1] Current health (sizes + colors the fill).
 * @param {number} [maxHealth=1] Max health (the denominator).
 * @param {string} [rarity="common"] Rarity — tints the outer ring (see RarityColors).
 * @returns {any} A `PIXI.Container` (zIndex 10). Has `setHealth(h, max)` and
 *   `setRarity(r)` (for when rarity becomes a live stat).
 */
export function healthBar(size, health = 1, maxHealth = 1, rarity = "common") {
  const width = size * 0.6;
  const height = width * 0.2;
  const border = height * 0.1; //  black outline thickness
  const slip = height * 0.1; //    white margin (the "slip") between border and fill
  const inset = border + slip; //  fill is inset this much on ALL sides

  const container = new PIXI.Container();
  container.zIndex = 10; // above plain entities (default 0), BELOW the player (20)
  //                        and petal containers (30) — see VisualEngine/view/API.md

  // Rect 1 — track: an outer pill tinted by RARITY, then a black pill inset by
  // `border` so the rarity color reads as a uniform outline ring.
  const outer = roundedRect({ width, height, radius: 50, color: rarityColor(rarity) });
  const inner = roundedRect({ width: width - border * 2, height: height - border * 2, radius: 75, color: "#000000" });

  // Rect 2 — fill: inset by border+slip on EVERY side, so a small, even white slip
  // shows all around it. At full health it spans the inner width edge-to-edge;
  // it shrinks from the right as health drops.
  const fillFullW = width - inset * 2;
  const fillH = height - inset * 2;
  const fill = roundedRect({ width: fillFullW, height: fillH, radius: 50, color: 0x000000 });

  container.addChild(outer, inner, fill);

  // Inner-left edge: the fill's left edge holds here as it shrinks.
  const leftEdge = -width / 2 + inset;

  /** Resize + recolor the fill from health/maxHealth (left-anchored, shrinks from
   * the right → drains right→left; color via `healthColor`). No-ops when the ratio
   * is unchanged, so the per-frame call from the view writes uniforms only on a
   * real health change. */
  let lastRatio = -1;
  function setHealth(h, max) {
    const ratio = max > 0 ? clamp01(h / max) : 0;
    if (ratio === lastRatio) return;
    lastRatio = ratio;
    fill.visible = ratio > 0;
    if (fill.visible) {
      // Never let the fill get narrower than it is tall — below that it'd just be a
      // shrinking circle, which reads worse than a short stub. Clamp to fillH.
      const w = Math.max(fillFullW * ratio, fillH);
      fill.setSize(w, fillH);
      fill.x = leftEdge + w / 2; // keep the left edge fixed
      fill.setColor(healthColor(ratio));
    }
  }
  setHealth(health, maxHealth);

  container.setHealth = setHealth;
  /** Retint the outer ring for a new rarity (for when rarity becomes a live stat
   * — see ui/API.md; today rarity is fixed at spawn). */
  container.setRarity = (r) => outer.setColor(rarityColor(r));
  // Expose the resolved dimensions so callers can place the bar without redoing
  // the size math (e.g. "one bar-height below the entity").
  container.barWidth = width;
  container.barHeight = height;
  return container;
}
