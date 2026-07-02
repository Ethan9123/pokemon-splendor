/* =====================================================================
 * AI Web Worker — runs the heavy AI searches OFF the main thread.
 * ---------------------------------------------------------------------
 * The 究极 (VSearch determinized MCTS) turn takes hundreds of ms — a full
 * second or more on phones — and used to run synchronously in ui.js,
 * freezing animations. Here the SAME engine + AI files are loaded in a
 * worker; ui.js posts a serialized game state and gets the plan back.
 *
 *   in : { id, kind:'ultra'|'hard'|..., g:<dyn state>, opts:{sims,dets,...} }
 *   out: { id, plan:{action,discards,evolution} } | { id, error }
 * ===================================================================== */
'use strict';
// The game files use UMD wrappers that only export to `window` — give the
// worker one so cards.js/engine.js/ai.js/vsearch.js register normally.
self.window = self;
importScripts('cards.js', 'megas.js', 'pokemart.js', 'engine.js', 'ai.js', 'vsearch.js');

const E = self.Engine, AI = self.AI, VS = self.VSearch;
const DB = self.CARD_DB || [], MEGA_DB = self.MEGA_DB || [], PM_DB = self.POKEMART_DB || [];

// reattach the shared static card refs the sender stripped (same as room.js)
function reattach(dyn) {
  const s = dyn;
  s.cardDB = DB; s.megaDB = MEGA_DB; s.pokemartDB = PM_DB;
  s.byId = {};
  [].concat(DB, MEGA_DB, PM_DB).forEach(c => { if (c) s.byId[c.id] = c; });
  if (!Array.isArray(s.log)) s.log = [];
  return s;
}

self.onmessage = (e) => {
  const m = e.data || {};
  try {
    const g = reattach(m.g);
    const plan = (m.kind === 'ultra' && VS)
      ? VS.chooseTurn(g, m.opts || {})
      : AI.chooseTurn(g, { difficulty: m.kind || 'hard' });
    self.postMessage({ id: m.id, plan });
  } catch (err) {
    self.postMessage({ id: m.id, error: String(err) });
  }
};
