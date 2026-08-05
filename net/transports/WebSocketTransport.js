// WebSocketTransport — Connections over a plain WebSocket, for the DEDICATED
// server. The `{ send, onMessage, close }` Connection contract below is what
// WebRtcTransport, so GameServer/GameClient don't know or care it's a socket.
//
// Two ends, one file (neither statically imports a socket lib, so the browser
// bundle stays clean — the Node server passes its own `ws` sockets in):
//   connectClient(url)    — BROWSER side: a joiner dials the server. Returns a
//                           Promise<Connection> that resolves once the socket opens.
//   wrapServerSocket(ws)  — NODE side: wrap one accepted `ws` socket as a Connection
//                           to hand to `GameServer.accept`.
//
// Unlike loopback (structuredClone) and PeerJS (serializes objects for us), a raw
// WebSocket moves bytes — so THIS is the layer that serializes. It runs every
// message through Codec (binary snapshots, tagged-JSON for the rest); that's the
// whole bandwidth win the dedicated server unlocks.

/**
 * One end of a link to the server — the ONLY thing `GameClient` needs from a
 * transport. Defined here because WebSocket is the client's only transport now; the
 * server keeps its own copy of this contract (loopback, worker) on its side.
 * @typedef {{ send(msg:object):void, onMessage(cb:(msg:object)=>void):void, close():void }} Connection
 */

import { encode, decode } from "../protocol/Codec.js";

/**
 * Wrap a server-side WebSocket (a Node `ws` socket) in the Connection contract.
 * @param {import("ws").WebSocket} ws An open (or opening) `ws` socket.
 * @returns {{ send(msg:object):void, onMessage(cb:(msg:object)=>void):void, close():void }}
 */
export function wrapServerSocket(ws) {
  let handler = null;
  ws.on("message", (data) => {
    if (!handler) return;
    try { handler(decode(data)); }
    catch (err) { console.warn("[net/ws] bad frame:", err && err.message); }
  });
  return {
    send(message) {
      if (ws.readyState === ws.OPEN) ws.send(encode(message));
    },
    onMessage(cb) { handler = cb; },
    close() { try { ws.close(); } catch { /* already closed */ } },
  };
}

/**
 * Dial a dedicated server from the browser. Resolves to a Connection once the
 * socket is open (feed it to `new GameClient(...)`); rejects on connect failure or
 * timeout. Sends issued before the socket opens are buffered and flushed on open
 * (mirrors how the WebRTC transport waits for `dataConn.open`).
 * @param {string} url e.g. `ws://localhost:8080` or `wss://host`.
 * @param {{timeoutMs?:number}} [opts]
 * @returns {Promise<object>} a Connection
 */
export function connectClient(url, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer"; // so onmessage hands back ArrayBuffer, not Blob
    let handler = null;
    const outbox = []; // messages sent before open
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* ignore */ }
      reject(new Error("WebSocket connect timed out — is the server up at " + url + "?"));
    }, timeoutMs);

    ws.onmessage = (ev) => {
      if (!handler) return;
      try { handler(decode(ev.data)); }
      catch (err) { console.warn("[net/ws] bad frame:", err && err.message); }
    };
    ws.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("WebSocket error connecting to " + url));
    };
    ws.onopen = () => {
      settled = true;
      clearTimeout(timer);
      for (const m of outbox) ws.send(encode(m));
      outbox.length = 0;
      resolve({
        send(message) {
          if (ws.readyState === WebSocket.OPEN) ws.send(encode(message));
          else outbox.push(message); // re-opening shouldn't happen, but don't drop
        },
        onMessage(cb) { handler = cb; },
        close() { try { ws.close(); } catch { /* ignore */ } },
      });
    };
  });
}
