/* =====================================================================
 * 璀璨宝石：宝可梦  —  Cloudflare Worker entry + Room Durable Object
 * ---------------------------------------------------------------------
 * Routes  /room/:code/ws  to a per-room Durable Object (one authoritative
 * coordinator per room code) over a WebSocket, and serves the static game for
 * everything else via the ASSETS binding. The DO owns NO game rules — it wraps
 * the pure, unit-tested authority in js/room.js and only adds the transport:
 * WebSocket Hibernation (idle rooms cost nothing) + durable-storage snapshots
 * (a room survives eviction/restart; clients reconnect with their token) + the
 * pacing of bot turns (one DO alarm per bot turn).
 *
 * Cost shape (Workers Free plan): inbound WS messages billed 20:1, outbound
 * free, no GB-s while hibernating. A heartbeat ping/pong is handled by the
 * runtime via setWebSocketAutoResponse so it never wakes the DO.
 * ===================================================================== */
import { Room as RoomAuthority } from '../js/room.js';
import AI from '../js/ai.js';
import DB from '../data/cards.json';
import MEGA_DB from '../data/megas.json';
import POKEMART_DB from '../data/pokemart.json';

const MAX_CONNS = 16;      // hard cap on concurrent sockets per room (DoS guard)
const MAX_MSG = 8192;      // protocol messages are tiny; drop anything larger
// One bot turn per alarm, this far apart: brisk, yet slow enough that the humans
// can follow each bot move on the board.
const AI_TURN_DELAY_MS = 1200;
// Persist on anything that mutates room state. `join` MUST persist: it adds a
// seat, and because the heartbeat auto-response never wakes the DO, an idle
// lobby evicts within ~30s — without this the un-started lobby's seats are lost.
// 任何会改变房间状态的消息都必须落盘。name 和 rematch 也在其列：
// 心跳的 auto-response 不唤醒 DO，空闲房间几十秒就被驱逐；只要没落盘，
// 改的名字/重开后的大厅状态就会在唤醒时被旧快照覆盖回去（生产实测过）。
// 大厅里加/删电脑、改难度、随机座位同理。
const MUTATING = new Set(['join', 'start', 'action', 'name', 'rematch', 'takeover',
  'addAI', 'removeAI', 'aiLevel', 'shuffle']);

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
        cardDB: DB, megaDB: MEGA_DB, pokemartDB: POKEMART_DB, ai: AI,
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
        this.authority.rebind(meta.connId, meta.token); // spectators also need future broadcasts
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

  // Bot turns are executed by the authority, one per DO alarm. An alarm is armed only
  // while some human is connected: a room whose humans all left pauses its bots (no
  // wake-ups, no cost) and resumes as soon as someone reconnects. Every inbound
  // message re-checks this, so a client's `sync` also revives a bot turn whose alarm
  // was lost (e.g. the platform gave up retrying it).
  async _armAI() {
    const a = this.authority;
    if (!a || !a.aiPending() || !a.humansConnected()) return;
    if (await this.state.storage.getAlarm() == null) {
      await this.state.storage.setAlarm(Date.now() + AI_TURN_DELAY_MS);
    }
  }

  async alarm() {
    await this._init();
    const a = this.authority;
    if (!a.aiPending() || !a.humansConnected()) return;   // nothing to do / nobody here → pause
    // Alarms are delivered at-least-once: a duplicate (or late retry) of the alarm that
    // just played the previous bot must not make the next bot move instantly.
    const due = a.turnStartedAt + AI_TURN_DELAY_MS;
    if (Date.now() < due - 100) { await this.state.storage.setAlarm(due); return; }
    // Count attempts per bot TURN (seq), durably and BEFORE thinking — not the alarm's own
    // retryCount, which counts redeliveries of one alarm event. If the think dies (e.g. the
    // CPU limit resets the object and its memory), the next try — the platform's retry or a
    // fresh alarm re-armed by a client's sync — thinks more cheaply (see aiThinkOpts).
    const rec = (await this.state.storage.get('aiAttempt')) || {};
    const attempt = rec.seq === a.seq ? (rec.n | 0) + 1 : 0;
    await this.state.storage.put('aiAttempt', { seq: a.seq, n: attempt });
    a.now = Date.now();
    try { a.stepAI(attempt); }
    catch (e) { /* stepAI falls back internally; never let the bot loop die here */ }
    await this._persist();
    if (a.aiPending() && a.humansConnected()) {
      await this.state.storage.setAlarm(Date.now() + AI_TURN_DELAY_MS);  // next bot in a row
    }
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
    this.authority.now = Date.now();   // inject server clock (idle-timeout / takeover)
    try { this.authority.onMessage(connId, msg); }
    catch (e) { /* one hostile/buggy message must never escape the hibernation handler */ }
    // Attach only accepted identities. A rejected re-join must never replace the
    // socket's identity, and a superseded socket must remain a spectator on wake.
    // (Attachments carry the token, not the seat index, so lobby reordering is safe.)
    if (msg.t === 'join') {
      for (const [socket, cid] of this.conns) {
        const seat = this.authority.conns[cid];
        const token = seat != null && seat >= 0 ? this.authority.seats[seat].token : null;
        socket.serializeAttachment({ connId: cid, token });
      }
    }
    if (MUTATING.has(msg.t)) await this._persist();
    await this._armAI();
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
