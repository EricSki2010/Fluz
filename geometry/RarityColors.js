// Rarity → display color, for UI that tints by rarity (health-bar borders, name
// tags, loot glows). UI-layer only — the headless GameEngine carries no colors,
// so this maps the engine's rarity strings to hex here in VisualEngine. (UI → the
// GameEngine Rarity enum is the allowed dependency direction; the reverse isn't.)

import { Rarity } from "../entities/Rarity.js";

/** Rarity string → hex color. @private */
const RARITY_COLORS = {
  [Rarity.COMMON]: "#7eef6d", //    green
  [Rarity.UNUSUAL]: "#ffe65d", //   yellow
  [Rarity.RARE]: "#4f51e2", //      blue
  [Rarity.EPIC]: "#ab18db", //      purple  originally #861de0
  [Rarity.LEGENDARY]: "#de1f1f", // red
  [Rarity.MYTHIC]: "#1fdbde", //    cyan
  [Rarity.ULTRA]: "#ff2b75", //     pink
  [Rarity.SUPER]: "#2bffa3", //     light green
  [Rarity.OMEGA]: "#494849", //     dark grey
  [Rarity.FABLED]: "#ff5500", //    orange
  [Rarity.DIVINE]: "#67549c", //    purple (?)
  [Rarity.SUPREME]: "#b25dd9", //   pink
  [Rarity.OMNIPOTENT]: "#160526", //dark purple (this one is purely a guess)
  [Rarity.ASTRAL]: "#046307", //    dark green
  [Rarity.CELESTIAL]: "#00bfff", // light cyan/blue
  [Rarity.SERAPHIC]: "#c77e5b", //  pinkish orange (?)
  [Rarity.TRANSCENDENT]: "#ffffff",//white
  [Rarity.QUANTUM]: "#61ffdd", //   cyan
  [Rarity.GALACTIC]: "#81102b" //   dark red (?)

};

/**
 * Display color for a rarity. Unknown/absent → common's color.
 * @param {string} rarity One of the `Rarity` strings (e.g. `"epic"`).
 * @returns {string} hex color (e.g. `"#861de0"`).
 */
export function rarityColor(rarity) {
  return RARITY_COLORS[rarity] ?? RARITY_COLORS[Rarity.COMMON];
}
