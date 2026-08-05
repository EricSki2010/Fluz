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
 * }} handlers `liveServerUrl` (if set) adds a one-click "Join Live Server" button
 *   that connects straight to it, so the usual player never types an address.
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

  const btnJoinServer = mkBtn("Join Server");
  // One-click join to the preset live server — the path nearly every player takes.
  const btnJoinLive = liveServerUrl ? mkBtn("Join Live Server") : null;

  /** Back to the main buttons. */
  function showMain() {
    status.textContent = "";
    const buttons = btnJoinLive ? [btnJoinLive, btnJoinServer] : [btnJoinServer];
    panel.replaceChildren(title, ...buttons, status);
  }

  btnJoinServer.onclick = () => showJoinServerForm();
  if (btnJoinLive) btnJoinLive.onclick = async () => {
    status.textContent = "Connecting to live server…";
    btnJoinLive.disabled = true;
    try { await onJoinServer(liveServerUrl); overlay.remove(); }
    catch (e) { status.textContent = "Join failed: " + (e?.message ?? e); btnJoinLive.disabled = false; }
  };

  /** Join a dedicated server: a `wss://` URL input + Connect. The last-used URL is
   * remembered (localStorage) so a returning player doesn't re-paste it. */
  function showJoinServerForm() {
    const label = el("div", { fontSize: "13px", color: "#aaa" }, "Server address");
    const input = el("input", {
      padding: "11px", fontSize: "15px", textAlign: "center", borderRadius: "6px",
      border: "1px solid #555", background: "#111", color: "#eee", width: "100%",
      boxSizing: "border-box",
    });
    input.placeholder = "wss://your-server.trycloudflare.com";
    input.value = localStorage.getItem("fluz.serverUrl") || "";
    const connect = mkBtn("Connect");
    const back = mkBtn("Back");
    back.onclick = showMain;
    connect.onclick = async () => {
      const url = input.value.trim();
      if (!url) { status.textContent = "Enter a server address."; return; }
      if (!/^wss?:\/\//.test(url)) { status.textContent = "Address must start with wss:// or ws://"; return; }
      localStorage.setItem("fluz.serverUrl", url); // remember for next time
      status.textContent = "Connecting…";
      connect.disabled = true;
      try { await onJoinServer(url); overlay.remove(); }
      catch (e) { status.textContent = "Join failed: " + (e?.message ?? e); connect.disabled = false; }
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") connect.click(); });
    panel.replaceChildren(title, label, input, connect, back, status);
    input.focus();
  }

  showMain();
  document.body.appendChild(overlay);
  return { close: () => overlay.remove() };
}
