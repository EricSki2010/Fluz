// PlayerHUD — the LOCAL player's screen-space HUD (heads-up display). One per
// client: the view builds it for the entity the client owns (`client.player`) and
// parents it to the fixed `ui` layer, so it stays pinned to the screen while the
// camera pans/zooms (see VisualEngine/ui/API.md and `ViewSubsystem.drawPlayerHUD`).
//
// ALL of the HUD is per-world now: `loadUI(worldId)` builds the UI the world's
// databank declares (`hud: [...]` in WorldRegistry), via the `UI_BUILDERS` registry
// below. Nothing is assumed for every world — a world with no `hud` list gets a bare
// HUD (e.g. a menu/cutscene world with no health bar AND no pause menu). The world
// declares WHICH UI (data, server-safe); this file owns HOW to build each (Pixi).
//
// Builders add world-dependent nodes (cleared on the next world change) and push a
// `(player, screen) => …` refresher into `liveUpdaters` if the element needs live
// data / per-frame layout. Like the rest of ui/, it READS game state, never mutates it.

import { healthBar } from "./HealthBar.js";
import { makeHud } from "./Hud.js";
import { button } from "./Button.js";
import { hotbarSlot } from "../../geometry/HotbarSlot.js";
import { petalContainer } from "../../geometry/PetalContainer.js";
import { entityDef, hasEntityDef } from "../../entities/EntityRegistry.js";
import { transition } from "../animation/Transition.js";
import { worldHud } from "./WorldUI.js";
import { HOTBAR_ROWS, HOTBAR_SLOTS } from "../../entities/Entity.js";

/** Health-bar `size` (its width is size×0.6 → ~270px). Tune for prominence. */
const BAR_SIZE = 450;
/** Gap from the TOP edge to the health bar, in logical screen px. */
const TOP_MARGIN = 28;
/** Pause dim is oversized this much past the screen, so a resize can't reveal an edge. */
const PAUSE_OVERSCAN = 1.2;
/** Vertical gap between the two stacked pause buttons, px. */
const BTN_GAP = 16;

/** The account board's colour — a warm yellowish brown. The dark border comes free:
 * `polygonGraphic` derives it by darkening the fill, the same way a petal container
 * gets its edge, so the board reads as the same family of object. @private */
const BOARD_FILL = 0xb5893f;
/** Side the board is BUILT at. It's scaled to the screen each frame rather than rebuilt,
 * so this is only a reference resolution — big enough that scaling up stays crisp. @private */
const BOARD_BUILD_SIDE = 400;
/** Board side as a fraction of the smaller screen dimension. @private */
const BOARD_SCREEN_FRAC = 0.62;
/** Petal-container slot side length for the MAIN row, in logical screen px. */
const SLOT_SIDE = 51;
/** Rows after the first draw at this fraction of the main row's size — 30% smaller.
 * Scales the row's gap too, so a smaller row reads as proportionally smaller rather
 * than as full-size spacing around shrunken slots. */
const SECONDARY_SLOT_SCALE = 0.7;
/** Horizontal gap between slots in the MAIN row, px (scaled per row with the slots). */
const SLOT_GAP = 10;
/** Vertical gap between the hotbar's rows, px. */
const ROW_GAP = 8;
/** Gap from the bottom edge to the BOTTOM of the whole hotbar stack, px. */
const HOTBAR_BOTTOM_MARGIN = 24;
/** Seed for a hotbar slot's petal emblem. FIXED (not the slot index) so the same petal
 * looks the same in every slot — a world container seeds from its entity id, but a
 * hotbar is a legend, and two "rock" slots reading as different rocks would be noise.
 * Irrelevant for fixed petal shapes (like rock), which ignore the seed. */
const SLOT_EMBLEM_SEED = 0;

/** Draw order within the hotbar. An EMPTY well goes UNDER a filled one, so a slot's
 * frame can never be painted over the petal sitting in the slot beside it — the emblem
 * is drawn at the container's full radius, and a neighbouring frame would otherwise
 * clip its edge.
 *
 * NEGATIVE on purpose. Every HUD piece is a sibling in the one `hud` container (it sets
 * `sortableChildren`), and the pause overlay already claims 0 for its dim and 1 for its
 * buttons. Slots sitting below both means the pause screen can never end up underneath
 * a hotbar well, and it doesn't depend on insertion order to break a tie. @private */
const SLOT_Z_EMPTY = -2;
const SLOT_Z_FILLED = -1;

/** Ticks a slot takes to fly to its counterpart on a swap. Very short on purpose — this
 * is feedback, not spectacle: just enough to see WHICH two slots traded, and gone before
 * it could delay reading the bar. @private */
const SWAP_TICKS = 5;

/** Reload time assumed when a petal def doesn't state one. Mirrors the server's
 * `DEFAULT_RELOAD_SECONDS` — the ratio has to be measured against the same total the
 * countdown was armed from, or the wash would drain at the wrong rate. @private */
const DEFAULT_RELOAD_SECONDS = 2.5;

/** Seconds `petal` takes to reload, from its def. @private */
function reloadSeconds(petal) {
  if (!petal || !hasEntityDef(petal)) return DEFAULT_RELOAD_SECONDS;
  return entityDef(petal).reloadTime ?? DEFAULT_RELOAD_SECONDS;
}

/** The UI ids a world mounts — client presentation, see `WorldUI.js`. @private */
function worldUI(worldId) {
  return worldHud(worldId);
}

/**
 * THE HOTBAR CENTER — the one point the whole hotbar is laid out around. Every row is
 * centered on its `x`, and the row stack is centered on its `y`, so moving the hotbar
 * anywhere on screen is a change to this function alone.
 *
 * It's derived from the bottom edge MINUS half the stack's own height (rather than being
 * a fixed offset), so resizing slots or adding a row can't push anything off-screen —
 * the block grows upward from a fixed bottom margin.
 * @param {{width:number,height:number}} screen
 * @param {number} stackHeight Total height of all rows + the gaps between them.
 * @returns {{x:number,y:number}} @private
 */
function hotbarCenter(screen, stackHeight) {
  return {
    x: screen.width / 2,
    y: screen.height - HOTBAR_BOTTOM_MARGIN - stackHeight / 2,
  };
}

/**
 * Build the local player's HUD (a tag-aware {@link makeHud} container). Returns it
 * with `update(player, screen)` (each frame by the view), `loadUI(worldId)` (build the
 * world's declared UI on enter/transfer), `togglePause()`, and `isPaused()`. The last
 * two no-op in a world whose UI list omits `"pausemenu"`.
 * @returns {any} a Hud container
 */
/**
 * @param {{animations?: object}} [deps] `animations` is the view's animation screen —
 *   where a petal in flight between two slots is drawn. Optional: without it the HUD
 *   still works, swaps just snap instead of animating.
 */
export function playerHUD(deps = {}) {
  const animations = deps.animations ?? null;
  const hud = makeHud();
  hud.zIndex = 100; // above any other HUD pieces added later

  /** Set by the app (ViewSubsystem.drawPlayerHUD ← view.onQuit) — what "Quit" does. */
  hud.onQuit = null;
  /** Which world's UI is currently loaded (so the view only reloads on a change). */
  hud.loadedWorld = null;

  /** Per-frame refreshers for the CURRENT world's UI. Rebuilt by `loadUI`. @private */
  let liveUpdaters = [];
  /** The pause dim sprite WHEN this world has a pause menu, else null. @private */
  let pauseDim = null;

  /** id → builder. Add an entry here, then list the id in a world's `hud:` array. */
  const UI_BUILDERS = {
    // The gameplay health bar (TOP-center), tied to the player's health. It used to sit
    // bottom-center; the hotbar owns the bottom edge now.
    healthbar: () => {
      const bar = healthBar(BAR_SIZE, 1, 1, "common");
      hud.add(bar, "health", "Combat", "Active"); // world-dependent (default)
      if (pauseDim && pauseDim.visible) bar.visible = false; // built while paused → stay hidden
      liveUpdaters.push((player, screen) => {
        bar.x = Math.round(screen.width / 2);
        bar.y = Math.round(TOP_MARGIN + bar.barHeight / 2);
        bar.setHealth(player.health, player.maxHealth);
      });
    },

    // The petal-container slots: one square per hotbar slot, in rows stacked around
    // {@link hotbarCenter} (main on top at full size, the rest 30% smaller). Tagged
    // "petalContainers" (just these squares) AND "hotbar" (the whole hotbar group, so
    // later pieces — counts, key hints, petal icons — can be flipped with them), plus
    // "Active" so pausing hides them like the rest of the live HUD.
    //
    // The grid is built ONCE (rows × slots from the engine's own constants); the
    // refresher only positions it and hides slots the player's actual hotbar doesn't
    // have. Reads `player.hotbar`, never writes it — that's server-owned.
    petalContainerUI: () => {
      // Per-row metrics, resolved once. Row 0 (main) is full size; later rows scale by
      // SECONDARY_SLOT_SCALE — slot side AND gap together, so each row stays in
      // proportion. `dy` is the row's center measured DOWN from the stack's top edge.
      const rows = [];
      let stackHeight = 0;
      for (let r = 0; r < HOTBAR_ROWS.length; r++) {
        const scale = r === 0 ? 1 : SECONDARY_SLOT_SCALE;
        const side = SLOT_SIDE * scale;
        const gap = SLOT_GAP * scale;
        if (r > 0) stackHeight += ROW_GAP;
        rows.push({
          name: HOTBAR_ROWS[r],
          side,
          gap,
          width: HOTBAR_SLOTS * side + (HOTBAR_SLOTS - 1) * gap,
          dy: stackHeight + side / 2,
        });
        stackHeight += side;
      }

      // What each slot held last frame, so a SWAP can be spotted. Keyed "row:index".
      // The hotbar is server state that arrives whole in each snapshot, so a swap shows
      // up as two slots having exchanged contents between one frame and the next —
      // there's no event to listen for.
      const lastPetal = new Map();
      /** Slots whose petal is currently in the air; their emblem is suppressed until it
       * lands, so the destination doesn't draw the petal that's still flying to it. */
      const inFlight = new Set();

      const slots = []; // [{ node, row }] — `row` is the metrics object above
      for (const row of rows) {
        for (let i = 0; i < HOTBAR_SLOTS; i++) {
          const node = hotbarSlot(row.side);
          hud.add(node, "petalContainers", "hotbar", "Active");
          slots.push({ node, row, index: i });
        }
      }

      liveUpdaters.push((player, screen) => {
        const center = hotbarCenter(screen, stackHeight);
        const top = center.y - stackHeight / 2;
        const paused = hud.isPaused();
        // --- 1. POSITION every slot, before anything reads its contents ----------
        // Positions depend only on the row metrics and the screen, never on what a slot
        // holds, so they can be settled first — and the swap check below needs them.
        const geom = new Map(); // "row:index" -> { x, y, side }
        for (let s = 0; s < slots.length; s++) {
          const { node, row, index } = slots[s];
          // Each row centers on the hotbar center's x independently, so rows of
          // different widths stay aligned with each other.
          node.x = Math.round(center.x - row.width / 2 + row.side / 2 + index * (row.side + row.gap));
          node.y = Math.round(top + row.dy);
          geom.set(`${row.name}:${index}`, { x: node.x, y: node.y, side: row.side });
        }

        // --- 2. SPOT SWAPS, before the slots are drawn ---------------------------
        // Order matters: this populates `inFlight`, and step 3 reads it. Drawing first
        // would paint the arriving petal for one frame before the flight hid it — a
        // one-frame flash of the petal at its destination while it's still in the air.
        //
        // The hotbar arrives whole in each snapshot, so there's no swap EVENT to hook:
        // a swap is two slots at the same INDEX, in different rows, that have exchanged
        // contents since last frame.
        if (animations !== null && player && player.hotbar) {
          const rowNames = rows.map((r) => r.name);
          for (let i = 0; i < HOTBAR_SLOTS; i++) {
            for (let a = 0; a < rowNames.length; a++) {
              for (let b = a + 1; b < rowNames.length; b++) {
                const ka = `${rowNames[a]}:${i}`;
                const kb = `${rowNames[b]}:${i}`;
                const nowA = player.hotbar[rowNames[a]]?.[i] ?? null;
                const nowB = player.hotbar[rowNames[b]]?.[i] ?? null;
                const wasA = lastPetal.get(ka);
                const wasB = lastPetal.get(kb);
                // Both changed, and each became what the other was → an exchange.
                // `undefined` (first frame) never matches, so nothing fires on load.
                const swapped = wasA !== undefined && wasB !== undefined
                  && wasA.petal !== (nowA?.petal ?? null) && wasB.petal !== (nowB?.petal ?? null)
                  && wasA.petal === (nowB?.petal ?? null) && wasB.petal === (nowA?.petal ?? null);
                if (swapped) {
                  flyBetween(ka, kb, wasA, geom);
                  flyBetween(kb, ka, wasB, geom);
                }
              }
            }
            for (const name of rowNames) {
              const slot = player.hotbar[name]?.[i] ?? null;
              lastPetal.set(`${name}:${i}`, { petal: slot?.petal ?? null, rarity: slot?.rarity ?? null });
            }
          }
        }

        // --- 3. DRAW each slot's contents ---------------------------------------
        for (let s = 0; s < slots.length; s++) {
          const { node, row, index } = slots[s];
          // Visibility is decided FRESH each frame rather than only ever hidden — the
          // hotbar arrives from a snapshot, so a slot that didn't exist on frame 1 has
          // to be able to come back. Pause is folded in here for the same reason: the
          // "Active" tag flips these off the instant you pause, and this keeps them off
          // (a hide-only refresher would leave a late hotbar invisible forever, and a
          // show-only one would fight the pause tag every frame).
          const bar = player && player.hotbar ? player.hotbar[row.name] : null;
          const has = !!bar && index < bar.length;
          node.visible = has && !paused;
          const slot = has ? bar[index] : null;
          // A slot whose contents are mid-flight draws as an EMPTY well — the graphic in
          // the air IS that slot, and drawing both would show it twice.
          const flying = inFlight.has(`${row.name}:${index}`);
          const filled = !flying && slot != null && slot.petal != null;
          // Draw order: an EMPTY well sits UNDER the filled ones, so an empty frame can
          // never be painted over the petal in the slot next to it. Re-set every frame
          // because a slot changes between filled and empty as petals are gained and
          // spent, and `sortableChildren` re-sorts on its own once zIndex moves.
          node.zIndex = filled ? SLOT_Z_FILLED : SLOT_Z_EMPTY;
          node.setPetal(filled ? slot.petal : null, SLOT_EMBLEM_SEED);
          // Tint the well by the slot's RARITY, using the same `rarityColor` mapping a
          // ground petalContainer uses — so a common petal reads the same in the hotbar
          // as it does lying in the world. An EMPTY slot passes null and stays neutral
          // grey, which is what makes a gap in the bar look like a gap.
          node.setRarity(filled ? slot.rarity ?? null : null);
          // Stack size, drawn as the same corner badge a world container wears. Slots
          // don't carry a count yet (nothing stacks INTO the hotbar), so this reads 1 and
          // draws nothing — it's here so the badge appears on its own once they do.
          node.setCount(slot != null && slot.count != null ? slot.count : 1);
          // Reload wash. Only while a slot is actually counting down — a loaded slot,
          // an empty one, and one whose petal is mid-flight all clear it.
          //
          // `setReload` takes how much of the square is CUT AWAY, so this passes the
          // ELAPSED fraction: at the start nothing is cut (fully covered), and by the
          // end all of it is (nothing left). The wash drains bottom-to-top as the petal
          // comes back — the slot is darkest when it's least usable.
          const reloading = filled && slot.timeTillLoaded > 0;
          node.setReload(reloading
            ? (1 - slot.timeTillLoaded / reloadSeconds(slot.petal)) * 100
            : null);
        }
      });

      /**
       * Fly slot `fromKey`'s old contents across to `toKey`.
       *
       * The thing that travels is a WHOLE SLOT — the same `hotbarSlot` geometry the bar
       * is made of, built at the source's size and scaled to the destination's — not
       * just the petal emblem. A bare emblem sliding between two wells reads as the
       * petal leaping out of its box; moving the box makes it read as the slot's
       * contents changing places, which is what actually happened.
       *
       * Suppresses the DESTINATION until it lands. Both directions of a swap call this,
       * so both slots stay as empty wells for the flight and reveal together.
       *
       * An empty slot has nothing to draw, so no flight is launched — but the
       * destination is still held and released, so the two sides stay in step. @private
       */
      function flyBetween(fromKey, toKey, was, geom) {
        const from = geom.get(fromKey);
        const to = geom.get(toKey);
        if (!from || !to) return;
        inFlight.add(toKey);
        const release = () => inFlight.delete(toKey);
        if (was == null || was.petal == null) { release(); return; } // nothing to draw
        const node = hotbarSlot(from.side, { petal: was.petal, rarity: was.rarity ?? undefined });
        animations.play(node, transition({ x: from.x, y: from.y }, { x: to.x, y: to.y },
          from.side, to.side, SWAP_TICKS), release);
      }
    },

    // The pause screen: a screen-covering 50% dim + Continue/Quit, hidden until Esc.
    // Tagged "pause"; togglePause/isPaused operate on this world's `pauseDim`.
    pausemenu: () => {
      const dim = new PIXI.Sprite(PIXI.Texture.WHITE);
      dim.anchor.set(0.5);
      dim.tint = 0x000000;
      dim.alpha = 0.5;
      dim.zIndex = 0; // under the buttons
      hud.add(dim, "pause");

      // The pause menu has two SCREENS, both under the "pause" tag so unpausing takes
      // the whole thing away whichever one is open. A second tag per screen is what
      // switches between them: "pauseMain" is the button column, "pauseAccount" is the
      // board. `togglePause` resets to main on the way in, so pausing always opens
      // where you expect rather than wherever you last were.
      const continueBtn = button("Continue", () => hud.togglePause());
      const accountBtn = button("Account", () => {
        hud.tag("pauseMain").hide();
        hud.tag("pauseAccount").show();
      });
      const quitBtn = button("Quit", () => hud.onQuit?.(), { color: 0x8a3a3a, hover: 0xa84a4a });
      for (const b of [continueBtn, accountBtn, quitBtn]) {
        b.zIndex = 1;
        hud.add(b, "pause", "pauseMain");
      }

      // The account board: the petal container's own graphic with the fill overridden —
      // solid panel, darker edge derived from it. Empty for now; whatever goes in it
      // parents here. Built at a reference size and SCALED to the screen each frame, so
      // a resize never has to rebuild the geometry.
      const board = petalContainer(BOARD_BUILD_SIDE, { fill: BOARD_FILL });
      board.zIndex = 1;
      hud.add(board, "pause", "pauseAccount");
      const backBtn = button("Back", () => {
        hud.tag("pauseAccount").hide();
        hud.tag("pauseMain").show();
      });
      backBtn.zIndex = 2; // over the board, in case the two ever overlap
      hud.add(backBtn, "pause", "pauseAccount");

      hud.tag("pause").hide(); // start unpaused (dim + every pause screen hidden)
      hud.tag("pauseAccount").hide(); // …and the account screen closed within it
      pauseDim = dim;

      liveUpdaters.push((player, screen) => {
        const cx = screen.width / 2, cy = screen.height / 2;
        dim.x = cx; dim.y = cy;
        dim.width = screen.width * PAUSE_OVERSCAN;
        dim.height = screen.height * PAUSE_OVERSCAN;
        // Main screen: the three buttons stacked around centre.
        const step = continueBtn.btnHeight + BTN_GAP;
        continueBtn.x = cx; continueBtn.y = cy - step;
        accountBtn.x = cx; accountBtn.y = cy;
        quitBtn.x = cx; quitBtn.y = cy + step;
        // Account screen: board centred, Back under it. The board is squared off the
        // SMALLER screen dimension so it always fits, portrait or landscape.
        const side = Math.min(screen.width, screen.height) * BOARD_SCREEN_FRAC;
        board.scale.set(side / BOARD_BUILD_SIDE);
        board.x = cx; board.y = cy - backBtn.btnHeight / 2;
        backBtn.x = cx;
        backBtn.y = board.y + side / 2 + BTN_GAP + backBtn.btnHeight / 2;
      });
    },
  };

  /**
   * Load the UI for `worldId`: clear the previous world's UI, then run the builder for
   * each id the world's databank declares (`hud: [...]`). Unknown ids are skipped.
   * Called on first sight + whenever the world changes. @param {string} worldId
   */
  hud.loadUI = (worldId) => {
    hud.clearWorldDependent(); // remove the old world's UI (destroys nodes)
    liveUpdaters = [];         // their refreshers are stale now
    pauseDim = null;           // the old pause dim (if any) was just destroyed
    for (const id of worldUI(worldId)) UI_BUILDERS[id]?.();
    hud.loadedWorld = worldId;
  };

  /** Re-anchor + refresh the current world's UI. @param {any} player
   * @param {{width,height}} screen */
  hud.update = (player, screen) => {
    hud.x = 0; hud.y = 0; // container in screen space, top-left origin
    for (const refresh of liveUpdaters) refresh(player, screen);
  };

  /** Toggle pause (no-op if this world has no pause menu). First call hides the live
   * HUD ("Active") + shows the dim ("pause"); next reverses it. @returns {boolean} now paused? */
  hud.togglePause = () => {
    if (pauseDim === null) return false; // this world has no pause menu
    if (pauseDim.visible) {
      hud.tag("pause").hide();
      hud.tag("Active").show();
      return false;
    }
    hud.tag("Active").hide();
    hud.tag("pause").show();
    // Always open on the button column, never on whichever sub-screen was last left
    // showing. `show()` on "pause" reveals every pause element regardless of tag, so
    // this has to come after it.
    hud.tag("pauseAccount").hide();
    hud.tag("pauseMain").show();
    return true;
  };

  /** Whether the pause screen is up (false if this world has no pause menu). The
   * render loop reads this to freeze movement. @returns {boolean} */
  hud.isPaused = () => pauseDim !== null && pauseDim.visible;

  return hud;
}
