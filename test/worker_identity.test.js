/* Exercise the actual transport handler with in-memory DO storage/sockets. */
const assert = require('assert');
const vm = require('vm');
const fs = require('fs');
const RoomAuthority = require('../js/room.js').Room;
const DB = require('../data/cards.json'), MEGA_DB = require('../data/megas.json'), POKEMART_DB = require('../data/pokemart.json');
const source = fs.readFileSync(require.resolve('../worker/index.js'), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace('export class Room', 'class Room')
  .replace('export default {', 'const entry = {') + '\nthis.WorkerRoom = Room;';
const context = { RoomAuthority, DB, MEGA_DB, POKEMART_DB };
vm.runInNewContext(source, context);
const sockets = [];
let snap;
const state = {
  storage: { get: async () => snap, put: async (_, value) => { snap = value; } },
  getWebSockets: () => sockets,
};
const socket = id => {
  const ws = { meta: { connId: id }, send() {},
    serializeAttachment(value) { this.meta = value; }, deserializeAttachment() { return this.meta; } };
  sockets.push(ws); return ws;
};
(async () => {
  const old = socket('old'), other = socket('other'), fresh = socket('fresh');
  const room = new context.WorkerRoom(state, {});
  const join = (ws, token) => room.webSocketMessage(ws, JSON.stringify({ t: 'join', token, name: 'A' }));
  await join(old, 'a'); await join(other, 'b'); await join(fresh, 'a');
  assert.strictEqual(old.meta.token, null, 'superseded socket attachment revoked');
  assert.strictEqual(fresh.meta.token, 'a');
  await join(fresh, 'b'); // rejected identity switch must not survive hibernation
  assert.strictEqual(fresh.meta.token, 'a');
  assert.strictEqual(room.authority.conns.fresh, 0);
  const restored = new context.WorkerRoom(state, {});
  await restored._init();
  assert.strictEqual(restored.authority.conns.old, -1);
  assert.strictEqual(restored.authority.conns.fresh, 0);
  await restored.webSocketClose(old);
  assert.strictEqual(restored.authority.seats[0].connected, true);
  assert.strictEqual(restored.authority.seats[0].connId, 'fresh');
  console.log('PASS accepted socket identities survive hibernation; revoked sockets stay spectators');
})().catch(e => { console.error(e); process.exitCode = 1; });
