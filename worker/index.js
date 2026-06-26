/* =====================================================================
 * 璀璨宝石：宝可梦  —  Cloudflare Worker entry + Room Durable Object
 * ---------------------------------------------------------------------
 * Routes  /room/:code/ws  to a per-room Durable Object (one authoritative
 * coordinator per room code) over a WebSocket, and serves the static game for
 * everything else via the ASSETS binding. The DO owns NO game rules — it wraps
 * the pure, unit-tested authority in js/room.js and only adds the transport:
 * WebSocket Hibernation (idle rooms cost nothing) + durable-storage snapshots
 * (a room survives eviction/restart; clients reconnect with their token).
 *
 * Cost shape (Workers Free plan): inbound WS messages billed 20:1, outbound
 * free, no GB-s while hibernating. A heartbeat ping/pong is handled by the
 * runtime via setWebSocketAutoResponse so it never wakes the DO.
 * ===================================================================== */
import { Room as RoomAuthority } from '../js/room.js';
import DB from '../data/cards.json';
import MEGA_DB from '../data/megas.json';
import POKEMART_DB from '../data/pokemart.json';

const MAX_CONNS = 16;      // hard cap on concurrent sockets per room (DoS guard)
const MAX_MSG = 8192;      // protocol messages are tiny; drop anything larger

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.conns = new Map();     // live WebSocket -> connId
    this.authority = null;
    this._ready = null;
  }

  // Lazily build the authority and rehydrate from storage + hibernated sockets.
  // Runs once per isolate lifetime; safe to await on every handler entry.
  _init() {
    if (!this._ready) this._ready = (async () => {
      // runtime answers {"t":"ping"} with {"t":"pong"} WITHOUT waking the DO
      try {
        this.state.setWebSocketAutoResponse(
          new WebSocketRequestResponsePair(JSON.stringify({ t: 'ping' }), JSON.stringify({ t: 'pong' }))
        );
      } catch (e) { /* older runtime: client falls back to no-op heartbeats */ }
      this.authority = new RoomAuthority({
        cardDB: DB, megaDB: MEGA_DB, pokemartDB: POKEMART_DB,
        send: (connId, msg) => this._send(connId, msg),
      });
      const snap = await this.state.storage.get('snap');
      if (snap) this.authority.restore(snap);
      // re-bind sockets that were hibernated — QUIET (no welcome/roster/state storm),
      // and unconditionally (a lobby that hibernated before start must not be bricked).
      for (const ws of this.state.getWebSockets()) {
        const meta = ws.deserializeAttachment() || {};
        if (!meta.connId) continue;
        this.conns.set(ws, meta.connId);
        if (meta.token) this.authority.rebind(meta.connId, meta.token);
      }
    })();
    return this._ready;
  }

  _send(connId, msg) {
    const data = JSON.stringify(msg);
    for (const [ws, cid] of this.conns) {
      if (cid === connId) { try { ws.send(data); } catch (e) { /* socket gone */ } }
    }
  }

  async _persist() {
    if (this.authority) await this.state.storage.put('snap', this.authority.snapshot());
  }

  // WebSocket upgrade for /room/:code/ws
  async fetch(request) {
    await this._init();
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    if (this.conns.size >= MAX_CONNS) return new Response('room full', { status: 503 });
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    const connId = crypto.randomUUID();
    this.state.acceptWebSocket(server);              // hibernation API (not server.accept())
    server.serializeAttachment({ connId });
    this.conns.set(server, connId);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    await this._init();
    const connId = this.conns.get(ws);
    if (!connId) return;
    const len = typeof message === 'string' ? message.length : (message && message.byteLength) || 0;
    if (!len || len > MAX_MSG) return;               // bound attacker-controlled allocation
    let msg;
    try { msg = JSON.parse(typeof message === 'string' ? message : ''); } catch (e) { return; }
    if (!msg || typeof msg.t !== 'string') return;
    // persist identity on the socket so we can rebind it after hibernation
    if (msg.t === 'join') ws.serializeAttachment({ connId, token: msg.token, name: msg.name });
    try { this.authority.onMessage(connId, msg); }
    catch (e) { /* one hostile/buggy message must never escape the hibernation handler */ }
    if (msg.t === 'start' || msg.t === 'action') await this._persist();  // only mutating messages write storage
  }

  async webSocketClose(ws) {
    await this._init();
    const connId = this.conns.get(ws);
    if (connId && this.authority) this.authority.leave(connId);   // seat keeps its token → reclaimable
    this.conns.delete(ws);
    await this._persist();
  }

  async webSocketError(ws) {
    await this._init();
    const connId = this.conns.get(ws);
    if (connId && this.authority) this.authority.leave(connId);
    this.conns.delete(ws);
    await this._persist();
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/room\/([A-Za-z0-9_-]{1,32})\/ws$/);
    if (m) {
      const id = env.ROOM.idFromName(m[1].toUpperCase());        // room code → one DO globally
      return env.ROOM.get(id).fetch(request);
    }
    return env.ASSETS.fetch(request);                            // everything else = the static game
  },
};
