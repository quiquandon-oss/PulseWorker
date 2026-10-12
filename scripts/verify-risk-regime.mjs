// Post-deploy check of the live worker for the "riskregime" source, run by
// .github/workflows/verify-risk-regime.yml after "Deploy Worker". GET requests only:
// it never POSTs, so it writes nothing except what GET /risk-regime itself stores
// (at most the one reading for the current hour, as any page load would).
const WORKER = 'https://sentiment-ff75.quiquandon.workers.dev';
const failures = [];
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failures.push(what); };
async function get(path) {
  const r = await fetch(WORKER + path, { cache: 'no-store' });
  const text = await r.text();
  let body = null; try { body = JSON.parse(text); } catch (_) { /* not JSON */ }
  return { status: r.status, body, text };
}

const rr = await get('/risk-regime?history=24');
const b = rr.body || {};
console.log('GET /risk-regime ->', rr.status, JSON.stringify({
  source: b.source, version: b.version, status: b.status, score: b.score, regime: b.regime,
  scoring_ts: b.scoring_ts && new Date(b.scoring_ts).toISOString(), generated_ts: b.generated_ts && new Date(b.generated_ts).toISOString(),
  underlying_open: b.underlying_open, explanation: b.explanation, reason: b.reason, counts: b.counts, rejected: b.rejected,
  inputs: (b.inputs || []).map(i => ({ symbol: i.symbol, status: i.status, age_min: i.age_min, ret_6h: i.ret_6h, pct_6h: i.pct_6h, abnormal: i.abnormal, vote: i.vote })),
  history: (b.history || []).map(h => `${new Date(h.ts).toISOString().slice(11, 16)} ${h.status} ${h.score ?? ''}`),
}, null, 1));
check(rr.status === 200 && b.ok === true && b.source === 'riskregime' && b.version === 'rrs-v1', 'live /risk-regime answers 200 with source riskregime, version rrs-v1');
check(['OK', 'MARKETS_CLOSED', 'INSUFFICIENT_DATA', 'STALE', 'NO_DATA'].includes(b.status), `status is a documented value (${b.status})`);
check(b.status !== 'OK' || (Number.isFinite(b.score) && b.score >= 10 && b.score <= 90 && Array.isArray(b.inputs) && b.inputs.length === 8 && typeof b.explanation === 'string'),
  'an OK reading has a 10-90 score, 8 inputs and an explanation');
check(b.status === 'OK' || b.score === undefined, 'a non-OK reading carries no score');
check(Array.isArray(b.history) && b.history.length >= 1, 'history has at least the current hour (stored reading)');
const again = await get('/risk-regime?history=24');
check(again.body && again.body.scoring_ts === b.scoring_ts && (again.body.history || []).length === (b.history || []).length,
  'a second request serves the same stored hour without adding a row');

const wa = await get('/weight-adaptation');
console.log('GET /weight-adaptation ->', wa.status, 'defaults_version', wa.body && wa.body.defaults_version, 'riskregime', JSON.stringify(wa.body && wa.body.defaults && wa.body.defaults.riskregime), 'mode', wa.body && wa.body.mode);
check(wa.status === 200 && wa.body && wa.body.defaults_version === '2026-10-12-riskregime' && JSON.stringify(wa.body.defaults.riskregime) === '[4,0.3]' && wa.body.mode === 'shadow',
  'shadow adaptation defaults include riskregime 4 x 0.3 and stay in shadow mode');
// Existing sources and history still served.
const hl = await get('/hl-oi');
console.log('GET /hl-oi ->', hl.status, hl.body && hl.body.status);
check(hl.status === 200 && hl.body && hl.body.source === 'hloi', 'existing /hl-oi still answers');
const hist = await get('/history');
const rows = Array.isArray(hist.body) ? hist.body : (hist.body && (hist.body.history || hist.body.rows)) || null;
console.log('GET /history ->', hist.status, Array.isArray(rows) ? `${rows.length} rows` : (hist.text || '').slice(0, 120));
check(hist.status === 200, 'existing /history still answers');

if (failures.length) { console.log(`\n${failures.length} check(s) failed`); process.exit(1); }
console.log('\nall checks passed');
