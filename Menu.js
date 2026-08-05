// Menu — the lobby UI. Pure DOM (no Pixi, no engine); it just calls the async
// callback the caller provides to actually start a session, and handles the UI
// around it (the address form, errors). A full-screen overlay that removes itself
// once a session starts.
//
// JOIN-ONLY. The client no longer hosts: Single Player and Host Game ran the real
// server in a worker on this machine, which a client-only deployment doesn't ship.
// Both paths (and the WebRTC room-code join, which had nothing left to join) are
// gone — the only way in is a dedicated server over WebSocket.

/** Tiny element helper: tag + inline styles + optional text. @private */
function el(tag, styles = {}, text) {
  const e = document.createElement(tag);
  Object.assign(e.style, styles);
  if (text != null) e.textContent = text;
  return e;
}

const BTN = {
  padding: "11px 16px", fontSize: "16px", fontWeight: "600", cursor: "pointer",
  background: "#3a7", color: "#062", border: "none", borderRadius: "6px",
};

/**
 * Show the lobby. `onJoinServer` starts a session against a `ws://`/`wss://` address
 * (the caller wires the render loop).
 * @param {{
 *   onJoinServer: (url: string) => Promise<void> | void,
 *   liveServerUrl?: string,
 * }} handlers `liveServerUrl` is the server to join. Without it the lobby has nothing
 *   to offer and says so.
 * @returns {{ close: () => void }}
 */
export function showMenu({ onJoinServer, liveServerUrl }) {
  const overlay = el("div", {
    position: "fixed", inset: "0", display: "flex", alignItems: "center",
    justifyContent: "center", background: "rgba(26,26,26,0.97)", zIndex: "2000",
    font: "16px system-ui, sans-serif", color: "#eee",
  });
  const panel = el("div", {
    display: "flex", flexDirection: "column", gap: "12px", minWidth: "260px",
    padding: "28px", background: "#222", border: "1px solid #444",
    borderRadius: "10px", textAlign: "center",
  });
  overlay.appendChild(panel);

  const title = el("div", { fontSize: "24px", fontWeight: "800", marginBottom: "6px" }, "Fluz");
  const status = el("div", { minHeight: "18px", fontSize: "13px", color: "#9cf" });
  const mkBtn = (label) => el("button", { ...BTN }, label);

  // One-click join to the preset live server — the only way in. The manual
  // address form is gone: with a single hosted server there was nothing to type that
  // wasn't already the default, and a URL box invites pasting an address that no longer
  // exists. Bring it back by re-adding a button that calls `onJoinServer(typedUrl)`.
  const btnJoinLive = liveServerUrl ? mkBtn("Join Live Server") : null;

  /** The main (only) view. */
  function showMain() {
    status.textContent = "";
    if (btnJoinLive === null) {
      // No server configured — say so rather than showing an empty panel with no way
      // forward. `liveServerUrl` comes from `startup.js`, so this is a build problem.
      status.textContent = "No server configured.";
      panel.replaceChildren(title, status);
      return;
    }
    panel.replaceChildren(title, btnJoinLive, status);
  }

  if (btnJoinLive) btnJoinLive.onclick = async () => {
    status.textContent = "Connecting to live server…";
    btnJoinLive.disabled = true;
    try { await onJoinServer(liveServerUrl); overlay.remove(); }
    catch (e) { status.textContent = "Join failed: " + (e?.message ?? e); btnJoinLive.disabled = false; }
  };

  showMain();
  document.body.appendChild(overlay);
  return { close: () => overlay.remove() };
}
