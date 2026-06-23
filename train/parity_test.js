// Verify js/azai.js encode + forward match Python (train/dump_parity.py output).
const fs = require('fs');
const cards = require('../data/cards.json');
const byId = {}; cards.forEach(c => byId[c.id] = c);
const AZ = require('../js/azai.js');
const policy = JSON.parse(fs.readFileSync(__dirname + '/ckpt/policy_frozen.json'));
AZ.setWeights(policy);
const data = JSON.parse(fs.readFileSync(__dirname + '/parity_states.json'));

function rebuild(st) {
  return {
    numPlayers: st.np, supply: st.supply, decks: st.decks, field: st.field,
    players: st.players.map(p => ({ tokens: p.tokens, board: p.board, reserve: p.reserve, buried: p.buried })),
    turn: st.turn, round: st.round, lastRound: st.last_round, phase: 'play', winner: null, byId,
  };
}
function maxabs(a, b) { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; }

let encMax = 0, maskMismatch = 0, polMax = 0, valMax = 0, legalMaskMax = 0;
for (const s of data) {
  const js = rebuild(s.state);
  const jf = AZ.encode(js);
  encMax = Math.max(encMax, maxabs(jf, s.features));
  const jm = AZ.legalMask(js);
  legalMaskMax = Math.max(legalMaskMax, maxabs(jm, s.legal));
  // net forward on PYTHON features (isolate net) and on python mask
  const r = AZ.forward(Float32Array.from(s.features), Float32Array.from(s.legal));
  polMax = Math.max(polMax, maxabs(r.policy, s.policy));
  valMax = Math.max(valMax, Math.abs(r.value - s.value));
}
console.log('samples:', data.length);
console.log('encode  max|JS-PY| :', encMax.toExponential(2));
console.log('legalmask max diff :', legalMaskMax.toExponential(2));
console.log('policy  max|JS-PY| :', polMax.toExponential(2));
console.log('value   max|JS-PY| :', valMax.toExponential(2));
const ok = encMax < 1e-4 && legalMaskMax < 1e-6 && polMax < 1e-3 && valMax < 1e-3;
console.log(ok ? 'PARITY OK' : 'PARITY FAIL');
process.exit(ok ? 0 : 1);
