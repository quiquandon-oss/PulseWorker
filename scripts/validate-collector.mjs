#!/usr/bin/env node
// Read-only post-activation check of the server-side collector against ACTUAL source responses stored by the Worker.
//   node scripts/validate-collector.mjs [base-url] [hours]
//   default: https://sentiment-ff75.quiquandon.workers.dev 24
// Prints the acceptance verdict (scomp-acceptance-v1) and a per-source table that keeps successes and failures apart.
// Exit code: 0 PASS, 1 FAIL, 2 INSUFFICIENT_WINDOW or not reachable. Never writes anything.
const base = (process.argv[2] || 'https://sentiment-ff75.quiquandon.workers.dev').replace(/\/$/, '');
const hours = parseInt(process.argv[3] || '24', 10);
const get = async (p) => { const r = await fetch(base + p, { headers: { 'User-Agent': 'cryptopulse-validate/1.0' } }); return r.json(); };
const pct = (x) => (x == null ? '  n/a' : (x * 100).toFixed(1).padStart(5) + '%');
const acc = await get(`/server-composite/acceptance?hours=${hours}`).catch((e) => ({ ok: false, error: String(e) }));
if (!acc.ok) { console.log('acceptance unavailable:', acc.error); process.exit(2); }
console.log(`collector enabled: ${acc.enabled}   window: ${new Date(acc.window.start).toISOString()} .. ${new Date(acc.window.now).toISOString()}   expected slots: ${acc.window.expected_slots}`);
console.log(`VERDICT: ${acc.verdict}\n`);
for (const [k, c] of Object.entries(acc.criteria)) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${k.padEnd(30)} value=${JSON.stringify(c.value)} threshold=${c.threshold}`);
console.log('\nsource        impl  ok/expected  statuses                         last error');
for (const [id, s] of Object.entries(acc.sources)) {
  const st = Object.entries(s.by_status).map(([k, v]) => `${k}:${v}`).join(' ');
  console.log(`${id.padEnd(13)} ${s.implemented ? 'yes ' : 'no  '} ${pct(s.ok_share).padStart(11)}  ${st.padEnd(32)} ${s.last_error ? `${s.last_error.status}: ${String(s.last_error.error).slice(0, 70)}` : ''}`);
}
process.exit(acc.verdict === 'PASS' ? 0 : acc.verdict === 'FAIL' ? 1 : 2);
