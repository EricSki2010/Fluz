// Session — the orchestrator that builds a running game and normalizes it to the
// shape the render loop expects: { grid, client, ... }. The loop just draws
// `session.grid` from `session.client.camera` and sends intent via `session.client`.
//
// This is the client-app glue, but it stays renderer-agnostic: it imports the
// engine + net pieces, NOT VisualEngine. The page wires the view to the session.
//
// JOIN-ONLY, one mode. The client connects to a DEDICATED server over WebSocket and
// runs a local sim corrected toward the snapshots it streams back. It never hosts:
// the old `single` and `host` modes ran the authoritative server on a worker thread
// on this machine, and a client-only deployment doesn't ship the server. The WebRTC
// room-code join went with them — it could only reach a browser host.
//
// The shape still carries `server`/`roomCode` (always null) so the render loop and
// anything reading a session stay unchanged if a local mode ever comes back.

import { GameClient } from "./Client.js";
import { connectClient } from "./transports/WebSocketTransport.js";

/**
 * Join a DEDICATED server over WebSocket — the only way into a game.
 * Input goes up as intent, snapshots come down,
 * the client runs a local sim corrected toward them. No local server.
 * @param {string} url e.g. `ws://localhost:8080` or `wss://your-host`.
 */
export async function startJoinWS(url) {
  const conn = await connectClient(url);
  const client = new GameClient(conn);
  return { mode: "join", grid: client.grid, client, server: null, engine: null, roomCode: null,
    stop() { conn.close(); } };
}
