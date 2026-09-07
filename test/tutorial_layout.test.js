/* Tutorial coach-bubble layout — run: node test/tutorial_layout.test.js  (from project root)
 * Regression for the mobile bug where the bubble covered the action bar ("拿取 3 个"). */
const assert = require('assert');
global.window = {};                       // tutorial.js exports the pure helper, then bails out without PSGame
const { placeBubble } = require('../js/tutorial.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}
const overlaps = (top, h, r) => top < r.bottom && top + h > r.top;

// Geometry (CSS px) read off the bug recording: iPhone portrait, supply near the bottom,
// the action bar with the confirm button directly above it, bubble ~216px tall.
const viewTop = 0, viewH = 717, bh = 216, safe = 10;
const bar = { top: 470, bottom: 553 }, supply = { top: 555, bottom: 645 };

test('regression: target-only avoidance reproduces the bug (bubble lands on the action bar)', () => {
  const old = placeBubble({ viewTop, viewH, bh, safe, avoid: supply });
  assert.ok(overlaps(old.top, bh, bar), 'placing "above the supply" is exactly on top of the bar');
});

test('fix: merging the action bar into the keep-clear band puts the bubble above the bar', () => {
  const avoid = { top: Math.min(supply.top, bar.top), bottom: Math.max(supply.bottom, bar.bottom) };
  const p = placeBubble({ viewTop, viewH, bh, safe, avoid });
  assert.ok(!overlaps(p.top, bh, bar), 'must not cover the action bar');
  assert.ok(!overlaps(p.top, bh, supply), 'must not cover the supply');
  assert.strictEqual(p.maxHeight, null, 'the bubble fits without shrinking');
  assert.ok(p.top >= viewTop + safe, 'stays inside the viewport');
});

test('when there is room below the band, the bubble goes below it', () => {
  const avoid = { top: 100, bottom: 200 };
  const p = placeBubble({ viewTop, viewH, bh, safe, avoid });
  assert.strictEqual(p.top, 214);
  assert.strictEqual(p.maxHeight, null);
});

test('when neither side fits, the bubble takes the roomier side and is capped so it still never overlaps', () => {
  const smallView = 400, tallBubble = 300, avoid = { top: 150, bottom: 380 };
  const p = placeBubble({ viewTop, viewH: smallView, bh: tallBubble, safe, avoid });
  assert.ok(p.maxHeight, 'a max-height is set so the bubble scrolls internally');
  assert.ok(p.top + p.maxHeight <= avoid.top, 'capped bubble ends above the band');
  assert.ok(p.top >= viewTop + safe);
});

test('visualViewport offset (iOS keyboard / URL bar) is respected', () => {
  const p = placeBubble({ viewTop: 120, viewH, bh, safe, avoid: { top: 120 + 470, bottom: 120 + 645 } });
  assert.ok(p.top >= 120 + safe && p.top + bh <= 120 + 470 - 14);
});

test('no target: default slot near the top, clamped to the viewport', () => {
  const p = placeBubble({ viewTop, viewH, bh, safe, avoid: null });
  assert.strictEqual(p.top, 58);
  const tiny = placeBubble({ viewTop, viewH: 200, bh: 190, safe, avoid: null });
  assert.strictEqual(tiny.top, safe, 'clamped up when the bubble is taller than the default slot allows');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
