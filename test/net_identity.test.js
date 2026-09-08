/* Transport identity must survive reconnect when localStorage is blocked. */
const assert = require('assert');
const vm = require('vm');
const fs = require('fs');
const sent = [], sockets = [];
class Socket {
  constructor() { this.readyState = 1; sockets.push(this); }
  send(msg) { sent.push(JSON.parse(msg)); }
  close() {}
}
const ctx = { window: {}, WebSocket: Socket, crypto: require('crypto').webcrypto,
  location: { protocol: 'https:', host: 'example.test' },
  localStorage: { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } },
  setInterval: () => 1, clearInterval() {}, setTimeout, clearTimeout, console };
vm.runInNewContext(fs.readFileSync(require.resolve('../js/net.js'), 'utf8'), ctx);
ctx.window.Net.connect('ABC', 'A'); sockets.at(-1).onopen();
const first = sent.at(-1).token;
ctx.window.Net.close(); ctx.window.Net.connect('ABC', 'A'); sockets.at(-1).onopen();
assert.strictEqual(sent.at(-1).token, first);
ctx.window.Net.close(); ctx.window.Net.connect('DEF', 'A'); sockets.at(-1).onopen();
assert.notStrictEqual(sent.at(-1).token, first);
assert.match(first, /^tok-[0-9a-f]{48}$/);
ctx.window.Net.close();
console.log('PASS stable secure identity with blocked storage and separate rooms');
