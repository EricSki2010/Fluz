// startup.js — the page's whole boot sequence, lifted out of index.html so the HTML
// is just a shell that calls `startGame()`. It wires the view, loads assets, captures
// input, runs the render+input loop, and drives the lobby → session → world-seed flow.
//
// This is the app's COMPOSITION ROOT: it's the one place that pulls together the view
// (VisualEngine), the network (Net/), and the engine (GameEngine/) — so it sits at the
// TOP of the dependency graph and lives at the repo root, beside index.html, rather
// than inside any one layer.

import { VisualEngine } from "./display/Display.js";
import { loadEntityDefs } from "./entities/EntityRegistry.js";
import { attachDebugOverlay } from "./dev/DebugOverlay.js";
import { showMenu } from "./Menu.js";
import { startJoinWS } from "./net/Session.js";
import { worldShowsBody } from "./display/ui/WorldUI.js";

/** The always-on dedicated server, for the lobby's one-click "Join Live Server".
 * NOTE: a trycloudflare.com quick-tunnel URL changes every time cloudflared restarts
 * — update this line and re-deploy when that happens. (A named tunnel would give a
 * permanent URL; see Net/SCALING_ROADMAP.txt.) */
const LIVE_SERVER_URL = "wss://douglas-printing-informative-mens.trycloudflare.com";

// (The starting mobs used to live here and were pushed to the worker-hosted server
// at boot. A dedicated server seeds its own worlds — see `seedWorlds` in
// Server/main.js — so the client no longer carries world content at all.)

/**
 * Boot the game: set up the view + assets, then show the lobby and run the render loop
 * for the lifetime of the page. Call once from the page.
 */
export async function startGame() {
  const view = VisualEngine.shared.view;

  await view.createCanvas();
  await loadEntityDefs(); // stats are read synchronously when entities are built
  try { await view.loadTextures(); } catch (err) {
    console.warn("texture preload failed; using placeholder:", err);
  }

  // Dev overlay (collision shapes / ranges) — press "Q". Wraps view.draw.
  attachDebugOverlay(view, { toggleKey: "KeyQ" });

  // The session the menu started (single | host | join). All three expose
  // { grid, client }, so the loop below doesn't care which it is.
  let active = null;

  // --- WASD capture (client side; only INTENT is ever sent to the server) ---
  const held = { w: false, a: false, s: false, d: false };
  const keyMap = { KeyW: "w", KeyA: "a", KeyS: "s", KeyD: "d" };

  /** Number row → 1-based hotbar slot. `0` is slot 10, the way it reads on a keyboard.
   * Only the slots a row actually HAS do anything; the server ignores the rest, so this
   * doesn't need to know how long a row is. */
  const slotKeys = {
    Digit1: 1, Digit2: 2, Digit3: 3, Digit4: 4, Digit5: 5,
    Digit6: 6, Digit7: 7, Digit8: 8, Digit9: 9, Digit0: 10,
  };

  /** Is the player allowed to act right now? FALSE in a world that gives no body, and
   * while the pause overlay is up. The single predicate for BOTH movement and hotbar
   * input, so the two can't drift apart — pause one and you pause the other. */
  const inputFrozen = () =>
    !active
    || !worldShowsBody(active.client.worldId)
    || (view.playerHud?.isPaused?.() ?? false);
  addEventListener("keydown", (e) => {
    if (keyMap[e.code]) held[keyMap[e.code]] = true;
    if (e.code === "KeyG" && active) active.client.warp(); // DEV: warp to the other world
    // Number keys swap a hotbar slot with its reserve. Frozen exactly when movement is
    // — a disembodied viewpoint or a paused game takes no input at all. The server
    // enforces the same rule; this just avoids sending what it would drop.
    const slot = slotKeys[e.code];
    if (slot !== undefined && !inputFrozen()) active.client.swapPetal(slot);
    // R swaps the whole row at once — the same action as pressing every number key,
    // behind the same gate.
    if (e.code === "KeyR" && !inputFrozen()) active.client.swapAllPetals();
    // Esc toggles the pause overlay. Movement-freeze is derived from the HUD's pause
    // state in the loop below (so the Continue button unpauses too, not just Esc).
    // No-op until the HUD exists. The HUD is view-owned (persists across worlds).
    if (e.code === "Escape") view.playerHud?.togglePause();
  });
  addEventListener("keyup",   (e) => { if (keyMap[e.code]) held[keyMap[e.code]] = false; });
  addEventListener("blur", () => { held.w = held.a = held.s = held.d = false; });

  function runSession(session) {
    active = session;
    // DEV handle. ES modules aren't reachable from the console and `active` is a local,
    // so without this there's no way to poke at a running game from devtools. Read-only
    // by convention — it's the live session, so writing through it edits the real world.
    //   game.hotbar()          → table of each slot: petal, loaded, seconds till reload
    //   game.orbit()           → the petal ring: each slot's angle, its anchor, and
    //                            where its petal actually is (single-player / host)
    //   game.client.player     → your entity (position, health, hotbar, …)
    //   game.server            → the authoritative server (single-player / host only)
    globalThis.game = session;
    /** Print this player's hotbar slots as a table. Reads the CLIENT's copy, which is
     * the server's state ~PLAYOUT_DELAY behind — fine for eyeballing reloads. */
    session.hotbar = () => {
      const hotbar = session.client.player?.hotbar;
      if (!hotbar) return "no player yet";
      const rows = [];
      for (const row of Object.keys(hotbar)) {
        hotbar[row].forEach((s, i) => rows.push({
          row, slot: i + 1,
          petal: s.petal ?? "—",
          loaded: s.loaded,
          reloadIn: s.loaded ? 0 : Number(s.timeTillLoaded.toFixed(2)),
        }));
      }
      console.table(rows);
      return `${rows.filter((r) => r.loaded).length}/${rows.filter((r) => r.petal !== "—").length} loaded`;
    };

    /**
     * Print the petal ring: each petal's fixed place on the circle, where that puts it
     * in the world, and where it actually is. `gap` is the distance between the two —
     * a pixel or two of orbit-spring lag normally, and large while a petal is STUCK to
     * an enemy (which pins it off the circle on purpose).
     *
     * Reads the CLIENT's entities. The ring's bookkeeping (`orbit1`) only exists on the
     * server — which runs on a WORKER thread, so the page can't reach it at all — but
     * every petal carries its own `orbitBase` and its owner's `orbit1Rotation` over the
     * wire, which is everything needed to reconstruct the circle here.
     */
    session.orbit = () => {
      const owner = session.client.player;
      if (!owner) return "no player yet";
      const deg = (r) => Number((((r * 180) / Math.PI) % 360).toFixed(1));
      const rot = owner.orbit1Rotation;
      const petals = [...owner.children].filter((c) => c.orbitBase >= 0)
        .sort((a, b) => a.orbitBase - b.orbitBase);
      const rows = petals.map((p) => {
        const live = p.orbitBase + rot;
        const ax = owner.x + Math.cos(live) * p.orbitRadius;
        const ay = owner.y + Math.sin(live) * p.orbitRadius;
        return {
          petal: p.defId,
          baseDeg: deg(p.orbitBase),
          liveDeg: deg(live),
          anchorX: Math.round(ax), anchorY: Math.round(ay),
          petalX: Math.round(p.x), petalY: Math.round(p.y),
          gap: Number(Math.hypot(p.x - ax, p.y - ay).toFixed(1)),
          stuck: p.stick !== null,
        };
      });
      console.table(rows);
      // Equipped-but-reloading slots hold their place on the ring but have no petal out.
      const bar = owner.hotbar ? owner.hotbar.main : [];
      const waiting = bar.filter((sl) => sl.petal && !sl.loaded).length;
      return `rotation ${deg(rot)}°  ·  ${rows.length} out` + (waiting ? `, ${waiting} reloading` : "") + `  ·  owner at (${Math.round(owner.x)}, ${Math.round(owner.y)})`;
    };
    // When the client's world changes (join or a server transfer), point the ground
    // layer at that world's floor set. The set is the CLIENT's and it's live: the
    // server streams the ground around the player, the client accumulates into this
    // same Set, and TerrainLayer re-reads it every frame — so tiles appear as they
    // stream in without another rebuild here. The per-world HUD is (re)loaded by
    // drawPlayerHUD below, which watches the client's worldId.
    session.client.onWorldChange = () => view.setTerrain(session.client.floorCells);
    // Tell the server our tab size (world units) so it scopes our region + snapshots
    // to the screen; resend on resize.
    const reportView = () => session.client.setView(view.gameWidth, view.gameHeight);
    view.measureGameSize();
    reportView();
    addEventListener("resize", () => { view.measureGameSize(); reportView(); });
  }

  // One render+input loop for the lifetime of the page. Idle until a session starts;
  // then each frame it sends intent up and draws the network-fed grid from the camera.
  view.app.ticker.add((ticker) => {
    if (active === null) return;
    const worldId = active.client.worldId;
    // A world we don't draw a body for is a disembodied viewpoint — no body, and we
    // don't bother sending input. The SERVER is what actually enforces that (it drops
    // movement intent from a world without the "movement" tag); this just avoids
    // sending commands we know it will ignore. See `display/ui/WorldUI.js`.
    const canMove = worldShowsBody(worldId);
    // Same predicate the number keys use, so movement and hotbar input freeze together
    // (pause is read from the HUD, so the Continue button unpauses both, not just Esc).
    // Frozen → send no movement; our player coasts to a stop while the world runs on.
    const frozen = inputFrozen();
    const dx = frozen ? 0 : (held.d ? 1 : 0) - (held.a ? 1 : 0);
    const dy = frozen ? 0 : (held.s ? 1 : 0) - (held.w ? 1 : 0); // down is +y on screen
    // One call: sends intent up AND advances the local view (local-sim step). Mobs +
    // player both move smoothly now; the server reconciles via snapshots.
    active.client.update(dx, dy, ticker.deltaMS / 1000);
    const camera = active.client.camera; // null until welcomed + view reported
    if (camera) view.draw(active.grid, camera, active.client.renderAlpha());
    view.drawPlayerHUD(active.client.player, worldId); // screen-space HUD
    // In-flight visuals (a petal travelling between hotbar slots). After the HUD, so a
    // slot that just handed its petal to an animation is already hidden this frame.
    view.updateAnimations(ticker.deltaMS / 1000);
    // Body rendered only in a "movement" world; otherwise just a camera position.
    // After draw() (which re-shows visible entities), so this is the last word.
    view.setPlayerBodyVisible(active.client.player, canMove);
  });

  // Lobby: Join Live Server / Join Server. Joining starts a session and the loop
  // above picks it up; the world's mobs come from the server we connect to, so
  // there's nothing to seed here. Wrapped so we can re-open it after Quit.
  function showLobby() {
    showMenu({
      onJoinServer: async (url) => { runSession(await startJoinWS(url)); },
      liveServerUrl: LIVE_SERVER_URL,
    });
  }

  /** A `?server=ws://…` in the page URL means "join this, skip the lobby" — what
   * `DevRun` opens the browser with, and equally a direct-join link you can hand
   * someone. Only `ws://`/`wss://` is accepted so the parameter can't be used to
   * point the client at some other scheme. Returns the URL, or null. @private */
  function autoJoinUrl() {
    const url = new URLSearchParams(location.search).get("server");
    return url && /^wss?:\/\//.test(url) ? url : null;
  }

  // Quit (pause-menu button): disconnect/stop the session, tear down the HUD, and
  // return to the lobby. Wired into every player HUD via `view.onQuit`.
  view.onQuit = () => {
    if (active) { try { active.stop(); } catch (e) { console.warn("stop failed:", e); } }
    active = null;
    globalThis.game = null; // don't leave the console holding a stopped session
    view.clearHUD(); // drop the pause screen / health bar so it doesn't linger
    showLobby();
  };

  // Auto-join if the URL named a server, else the lobby. A failed auto-join falls
  // back to the lobby rather than leaving a blank page — the server may just not be
  // up yet, and the address is still typeable by hand.
  const direct = autoJoinUrl();
  if (direct === null) {
    showLobby();
  } else {
    startJoinWS(direct).then(runSession).catch((err) => {
      console.warn(`auto-join to ${direct} failed:`, err);
      showLobby();
    });
  }
}
