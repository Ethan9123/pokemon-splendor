const assert = require('assert');
const vm = require('vm');
const fs = require('fs');
function harness() {
  let now = 0, next = 1;
  const timers = new Map(), sockets = [], states = [], events = {}, docEvents = {};
  const set = (fn, ms, repeat = false) => { const id = next++; timers.set(id, { fn, at: now + ms, ms, repeat }); return id; };
  class Socket {
    constructor() { this.readyState = 0; this.sent = []; sockets.push(this); }
    send(text) { this.sent.push(JSON.parse(text)); }
    close() { this.readyState = 3; }
    open() { this.readyState = 1; this.onopen(); }
    receive(m) { this.onmessage({ data: JSON.stringify(m) }); }
  }
  const ctx = { window: { addEventListener: (n, fn) => events[n] = fn },
    document: { visibilityState: 'visible', addEventListener: (n, fn) => docEvents[n] = fn },
    navigator: { onLine: true }, WebSocket: Socket, crypto: require('crypto').webcrypto,
    location: { protocol: 'https:', host: 'test.invalid' },
    localStorage: { getItem: () => null, setItem() {} }, console,
    setTimeout: (fn, ms) => set(fn, ms), clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => set(fn, ms, true), clearInterval: id => timers.delete(id) };
  vm.runInNewContext(fs.readFileSync(require.resolve('../js/net.js'), 'utf8'), ctx);
  const net = ctx.window.Net; net.on('status', s => states.push(s));
  function tick(ms) {
    const end = now + ms;
    for (;;) {
      const due = [...timers].filter(([,t]) => t.at <= end).sort((a,b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, t] = due; now = t.at;
      if (t.repeat) t.at += t.ms; else timers.delete(id);
      t.fn();
    }
    now = end;
  }
  function connected() {
    net.connect('abc', 'A'); const s = sockets.at(-1); s.open();
    s.receive({ t: 'welcome', seat: 0 }); s.receive({ t: 'state', state: {}, seq: 1 }); return s;
  }
  return { net, sockets, states, tick, connected, ctx, events, docEvents };
}
{
  const h = harness(); h.net.connect('abc', 'A'); const s = h.sockets[0]; s.open();
  assert.strictEqual(h.net.action({type:'take'}), false, 'handshake is not ready');
  s.receive({t:'welcome',seat:0}); assert.strictEqual(h.net.isOpen(),false);
  s.receive({t:'roster',started:false}); assert.strictEqual(h.net.isOpen(),true);
  h.net.close();
}
{
  const h = harness(); const s = h.connected();
  h.net.action({type:'reserve'}); h.tick(8000);
  assert.strictEqual(h.states.at(-1),'syncing');
  assert.strictEqual(s.sent.at(-1).t,'sync');
  assert.strictEqual(s.sent.filter(m=>m.t==='action').length,1,'never replay an uncertain move');
  s.receive({t:'state',state:{},seq:2}); assert.strictEqual(h.net.isOpen(),true);
  h.net.close();
}
{
  const h = harness(); const s = h.connected(); h.tick(25000);
  assert.strictEqual(s.sent.at(-1).t,'ping'); h.tick(10000);
  assert.strictEqual(h.states.at(-1),'disconnected'); h.tick(1000);
  assert.strictEqual(h.sockets.length,2,'half-open connection is replaced'); h.net.close();
}
{
  const h = harness(); const s = h.connected(), stale = s.onclose;
  h.net.connect('other','B'); stale(); h.tick(1000);
  assert.strictEqual(h.sockets.length,2,'old callbacks cannot replace a new room socket');
  h.net.close(); h.tick(60000); assert.strictEqual(h.sockets.length,2,'explicit leave never reconnects');
}
{
  const h = harness(); h.connected(); h.ctx.navigator.onLine=false; h.events.offline();
  assert.strictEqual(h.states.at(-1),'offline'); h.tick(60000); assert.strictEqual(h.sockets.length,1);
  h.ctx.navigator.onLine=true; h.events.online(); assert.strictEqual(h.sockets.length,2); h.net.close();
}
{
  const h = harness(); const s=h.connected(); h.docEvents.visibilitychange();
  assert.strictEqual(s.sent.at(-1).t,'sync');
  h.tick(8000); assert.strictEqual(h.states.at(-1),'disconnected'); h.net.close();
}
{
  const h=harness(); h.net.connect('abc','A'); h.sockets[0].open(); h.tick(12000);
  assert.strictEqual(h.states.at(-1),'disconnected','socket open but no welcome must time out'); h.net.close();
}
{
  const h=harness(); const s=h.connected(); h.net.action({type:'take'}); h.tick(8000);
  s.receive({t:'reject',reason:'late rejection'}); h.tick(8000);
  assert.strictEqual(h.states.at(-1),'disconnected','a late rejection cannot cancel snapshot recovery'); h.net.close();
}
console.log('PASS eight transport recovery scenarios');
