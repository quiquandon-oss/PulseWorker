// POST /history provenance, write token, idempotency and append-only mode, plus the 0001 migration and its
// rollback applied in isolation to an in-memory SQLite database (node:sqlite) behind a minimal D1 adapter.
// Nothing here touches a real D1 database.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import rawWorker from '../worker.js';

// Every request authenticates as a V1 device would (X-V1-Token / V1_ACCESS_TOKEN). On a Worker without the sec-v1
// route gate these are ignored; with it (PulseWorker #4) the history routes are fail-closed and need them.
const V1_TOKEN = 'history-tests-v1-access-token-0123456789abcdef';
const worker = {
  fetch: (req, env) => {
    const headers = new Headers(req.headers);
    if (!headers.has('X-V1-Token')) headers.set('X-V1-Token', V1_TOKEN);
    return rawWorker.fetch(new Request(req, { headers }), { V1_ACCESS_TOKEN: V1_TOKEN, ...env });
  },
};

// vite does not resolve node:sqlite as a builtin yet; plain require does.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

const MIGRATION = readFileSync(new URL('../db/migrations/0001_history_provenance.sql', import.meta.url), 'utf8');
const ROLLBACK = readFileSync(new URL('../db/rollback/0001_history_provenance.sql', import.meta.url), 'utf8');
// The live history table predates this repository's migrations; this mirrors the columns the Worker reads and writes.
const HISTORY_DDL = `CREATE TABLE history (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, score REAL NOT NULL,
  technical_score REAL, btc_price REAL, gold_regime TEXT, sources_json TEXT, regime_mag REAL, bottom_score REAL, global_mcap REAL)`;

function d1(db, { failBatch = null } = {}) {
  let queue = Promise.resolve();
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    first: async () => db.prepare(sql).get(...args) ?? null,
  });
  return {
    prepare: (sql) => stmt(sql),
    // D1 runs each batch as one serialized transaction: no other statement interleaves with it.
    batch: (stmts) => (queue = queue.then(async () => {
      if (failBatch) throw new Error(failBatch);
      db.exec('BEGIN');
      try { const out = []; for (const s of stmts) out.push(await s.run()); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; }
    })),
  };
}

function freshDb({ migrate = true } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(HISTORY_DDL);
  if (migrate) db.exec(MIGRATION);
  return db;
}

const NOW = Date.UTC(2026, 10, 1, 12);
function provenance(over = {}) {
  return {
    formula_version: 'v1-composite-1', computed_at: NOW - 1000, weights_version: '2026-10-12-riskregime', weights_overridden: [],
    completeness: 0.8,
    sources: [
      { id: 'fng', score: 70, base_weight: 10, confidence: 1, boost: 1, observed_at: NOW - 60000 },
      { id: 'foufi', score: 30, base_weight: 4, confidence: 0.5, boost: 1.5, observed_at: null },
    ],
    missing: [{ id: 'riskregime', base_weight: 2, reason: 'status not OK' }],
    ...over,
  };
}
// (70*10 + 30*3) / 13 = 60.769 -> the browser would have written 61
const post = (env, body, headers = {}) => worker.fetch(new Request('https://w/history', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }), env);
const rows = (db, t) => db.prepare(`SELECT * FROM ${t} ORDER BY id`).all();

describe('migration 0001 and rollback, in isolation', () => {
  it('applies, is idempotent, and leaves the history table untouched', () => {
    const db = freshDb();
    db.exec(MIGRATION);                                  // IF NOT EXISTS everywhere: re-applying is a no-op
    db.prepare('INSERT INTO history (ts, score) VALUES (1, 50)').run();
    const cols = db.prepare('PRAGMA table_info(history_provenance)').all().map((c) => c.name);
    expect(cols).toContain('provenance_json');
    expect(db.prepare('PRAGMA table_info(history)').all().map((c) => c.name)).toEqual(
      ['id', 'ts', 'score', 'technical_score', 'btc_price', 'gold_regime', 'sources_json', 'regime_mag', 'bottom_score', 'global_mcap']);
  });
  it('makes provenance append-only: UPDATE and DELETE abort', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO history_provenance (idempotency_key, history_ts, received_ts, client_computed_ts, formula_version,
      reproducible, n_active, n_missing, n_freshness_known, weights_overridden, n_boosted, auth_state, request_id, provenance_json)
      VALUES ('k1234567', 1, 1, 1, 'v1-composite-1', 1, 0, 0, 0, 0, 0, 'open', 'r', '{}')`).run();
    expect(() => db.exec("UPDATE history_provenance SET client_score = 1")).toThrow(/append-only/);
    expect(() => db.exec('DELETE FROM history_provenance')).toThrow(/append-only/);
    expect(() => db.exec(`INSERT INTO history_provenance (idempotency_key, history_ts, received_ts, client_computed_ts, formula_version,
      reproducible, n_active, n_missing, n_freshness_known, weights_overridden, n_boosted, auth_state, request_id, provenance_json)
      VALUES ('k2234567', 1, 1, 1, 'v', 1, 0, 0, 0, 0, 0, 'anonymous', 'r', '{}')`)).toThrow(/CHECK/);
  });
  it('rolls back cleanly and only removes what it created', () => {
    const db = freshDb();
    db.prepare('INSERT INTO history (ts, score) VALUES (1, 50)').run();
    db.exec(ROLLBACK);
    const objs = db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%provenance%'").all();
    expect(objs).toEqual([]);
    expect(rows(db, 'history')).toHaveLength(1);
    db.exec(ROLLBACK);                                   // idempotent
    db.exec(MIGRATION);                                  // and re-applicable
  });
});

describe('POST /history: legacy behaviour when nothing is configured', () => {
  it('writes the row exactly as before, prunes to 500, ignores provenance', async () => {
    const db = freshDb({ migrate: false });
    const env = { DB: d1(db) };
    for (let i = 0; i < 3; i++) db.prepare('INSERT INTO history (ts, score) VALUES (?, 50)').run(i);
    const r = await post(env, { score: 61, technicalScore: 40, sources: { fng: 70 }, provenance: provenance() });
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.provenance).toEqual({ recorded: false, reason: 'provenance disabled' });
    const last = rows(db, 'history').at(-1);
    expect([last.score, last.technical_score, last.sources_json]).toEqual([61, 40, '{"fng":70}']);
  });
  it('still rejects a non-numeric score', async () => {
    const r = await post({ DB: d1(freshDb()) }, { score: 'x' });
    expect(r.status).toBe(400);
  });
});

describe('write token', () => {
  it('when HISTORY_WRITE_TOKEN is set, POST /history and /backfill-sources need X-History-Token', async () => {
    const db = freshDb();
    const env = { DB: d1(db), HISTORY_WRITE_TOKEN: 'tok-abcdefgh' };
    expect((await post(env, { score: 50 })).status).toBe(401);
    expect((await post(env, { score: 50 }, { 'X-History-Token': 'wrong' })).status).toBe(401);
    expect((await post(env, { score: 50 }, { 'X-App-Secret': 'tok-abcdefgh' })).status).toBe(401);   // other header: no
    expect((await post(env, { score: 50 }, { 'X-History-Token': 'tok-abcdefgh' })).status).toBe(200);
    const bf = (h) => worker.fetch(new Request('https://w/backfill-sources', { method: 'POST', headers: h, body: JSON.stringify({ updates: [] }) }), env);
    expect((await bf({})).status).toBe(401);
    expect((await bf({ 'X-History-Token': 'tok-abcdefgh' })).status).toBe(200);
    expect(rows(db, 'history')).toHaveLength(1);
  });
  it('preflight allows the new header', async () => {
    const r = await worker.fetch(new Request('https://w/history', { method: 'OPTIONS' }), { DB: d1(freshDb()) });
    expect(r.headers.get('Access-Control-Allow-Headers') || '').toContain('X-History-Token');
  });
});

describe('provenance (HISTORY_PROVENANCE=1)', () => {
  let db, env;
  beforeEach(() => { db = freshDb(); env = { DB: d1(db), HISTORY_PROVENANCE: '1' }; });

  it('records inputs, effective weights, boost, missing reasons, freshness and a server recomputation', async () => {
    const j = await (await post(env, { score: 61, provenance: provenance(), idempotencyKey: 'cp:abc12345' })).json();
    expect(j.provenance).toMatchObject({ recorded: true, reproducible: true, idempotency_key: 'cp:abc12345' });
    const [p] = rows(db, 'history_provenance');
    expect(p.history_ts).toBe(rows(db, 'history')[0].ts);
    expect(p.server_score).toBeCloseTo(60.7692, 3);
    expect([p.client_score, p.reproducible, p.n_active, p.n_missing, p.n_boosted, p.n_freshness_known, p.auth_state])
      .toEqual([61, 1, 2, 1, 1, 1, 'open']);
    expect(p.max_source_age_ms).toBe(59000);
    const pj = JSON.parse(p.provenance_json);
    expect(pj.sources.find((s) => s.id === 'fng').effective_weight_pct).toBeCloseTo(76.9231, 3);
    expect(pj.sources.find((s) => s.id === 'foufi')).toMatchObject({ boost: 1.5, observed_at: null });
    expect(pj.missing).toEqual([{ id: 'riskregime', base_weight: 2, reason: 'status not OK' }]);
  });

  it('flags a composite the recorded inputs do not reproduce', async () => {
    const j = await (await post(env, { score: 45, provenance: provenance() })).json();
    expect(j.provenance.reproducible).toBe(false);
    expect(rows(db, 'history_provenance')[0].reproducible).toBe(0);
  });

  it('is idempotent: a retry writes neither a second history row nor a second provenance row', async () => {
    const body = { score: 61, provenance: provenance(), idempotencyKey: 'cp:retry0001' };
    const a = await (await post(env, body)).json();
    const b = await (await post(env, body)).json();
    expect(b).toMatchObject({ ok: true, duplicate: true, ts: a.ts });
    expect(rows(db, 'history')).toHaveLength(1);
    expect(rows(db, 'history_provenance')).toHaveLength(1);
  });

  it('derives a content hash key when the client sends none, so identical retries still dedupe', async () => {
    const body = { score: 61, provenance: provenance() };
    await post(env, body);
    const b = await (await post(env, body)).json();
    expect(b.duplicate).toBe(true);
    expect(b.idempotency_key).toMatch(/^h:[0-9a-f]{64}$/);
    expect(rows(db, 'history')).toHaveLength(1);
  });

  it('invalid provenance never blocks the history write and is reported, not silently dropped', async () => {
    const bad = provenance({ sources: [{ id: 'fng', score: 170, base_weight: 1, confidence: 1 }] });
    const j = await (await post(env, { score: 61, provenance: bad })).json();
    expect(j.ok).toBe(true);
    expect(j.provenance.recorded).toBe(false);
    expect(j.provenance.reason).toMatch(/score 0-100/);
    expect(rows(db, 'history')).toHaveLength(1);
    expect(rows(db, 'history_provenance')).toHaveLength(0);
  });

  it('when the table is missing (migration not applied) the history row is still written', async () => {
    const db2 = freshDb({ migrate: false });
    const j = await (await post({ DB: d1(db2), HISTORY_PROVENANCE: '1' }, { score: 61, provenance: provenance() })).json();
    expect(j.ok).toBe(true);
    expect(j.provenance.recorded).toBe(false);
    expect(j.provenance.reason).toMatch(/provenance store unavailable/);
    expect(rows(db2, 'history')).toHaveLength(1);
  });

  it('records a skipped low-completeness reading as provenance only, with its reason', async () => {
    const body = { provenanceOnly: true, skipReason: 'low_completeness', score: 14, provenance: provenance({ completeness: 0.3 }) };
    const j = await (await post(env, body)).json();
    expect(j).toMatchObject({ ok: true, recorded: true, duplicate: false });
    expect((await (await post(env, body)).json()).duplicate).toBe(true);
    expect(rows(db, 'history')).toHaveLength(0);
    const [p] = rows(db, 'history_provenance');
    expect([p.history_ts, p.skip_reason, p.completeness]).toEqual([null, 'low_completeness', 0.3]);
    expect((await post(env, { ...body, skipReason: 'throttled' })).status).toBe(400);
  });

  it('rejects duplicated or malformed source ids', async () => {
    const dup = provenance({ sources: [provenance().sources[0], provenance().sources[0]] });
    expect((await (await post(env, { score: 61, provenance: dup })).json()).provenance.reason).toMatch(/duplicated/);
    const inj = provenance({ missing: [{ id: "x'); DROP TABLE history;--", reason: 'r' }] });
    expect((await (await post(env, { score: 61, provenance: inj })).json()).provenance.reason).toMatch(/missing id invalid/);
  });
});

describe('append-only mode (HISTORY_APPEND_ONLY=1)', () => {
  it('stops pruning history and refuses /backfill-sources', async () => {
    const db = freshDb();
    const ins = db.prepare('INSERT INTO history (ts, score) VALUES (?, 50)');
    for (let i = 0; i < 505; i++) ins.run(i);
    await post({ DB: d1(db) }, { score: 50 });
    expect(rows(db, 'history')).toHaveLength(500);                                 // legacy: pruned
    for (let i = 0; i < 5; i++) ins.run(1000 + i);
    const env = { DB: d1(db), HISTORY_APPEND_ONLY: '1' };
    await post(env, { score: 50 });
    expect(rows(db, 'history')).toHaveLength(506);                                 // append-only: kept
    const r = await worker.fetch(new Request('https://w/backfill-sources', { method: 'POST',
      body: JSON.stringify({ updates: [{ ts: 1000, patch: { fng: 1 } }] }) }), env);
    expect(r.status).toBe(409);
    expect(db.prepare('SELECT sources_json FROM history WHERE ts = 1000').get().sources_json).toBeNull();
  });
});

describe('robustness and upgrade order', () => {
  it('concurrent identical requests write exactly one history row and one provenance row', async () => {
    const db = freshDb();
    const env = { DB: d1(db), HISTORY_PROVENANCE: '1' };
    const body = { score: 61, provenance: provenance(), idempotencyKey: 'cp:concurrent1' };
    const res = await Promise.all(Array.from({ length: 8 }, () => post(env, body).then((r) => r.json())));
    expect(rows(db, 'history')).toHaveLength(1);
    expect(rows(db, 'history_provenance')).toHaveLength(1);
    expect(res.filter((r) => r.duplicate).length).toBe(7);
  });
  it('an old frontend (no provenance, no key) still writes against an upgraded Worker', async () => {
    const db = freshDb();
    const j = await (await post({ DB: d1(db), HISTORY_PROVENANCE: '1', HISTORY_APPEND_ONLY: '1' },
      { score: 52, technicalScore: 48, sources: { fng: 50 }, btcPrice: 70000 })).json();
    expect(j).toMatchObject({ ok: true, provenance: { recorded: false, reason: 'no provenance sent' } });
    expect(rows(db, 'history')).toHaveLength(1);
  });
  it('the exact payload shape built by CryptoPulse buildCompositeProvenance is accepted (when that checkout is present)', async () => {
    let html; try { html = readFileSync(new URL('../../CryptoPulse/index.html', import.meta.url), 'utf8'); } catch { return; }
    if (!html.includes('function buildCompositeProvenance(')) return;
    const grab = (name) => { const i = html.indexOf(`function ${name}(`); let d = 0, j = html.indexOf('{', i);
      for (; j < html.length; j++) { if (html[j] === '{') d++; else if (html[j] === '}' && --d === 0) break; } return html.slice(i, j + 1); };
    const F = new Function(`const COMPOSITE_WEIGHTS_VERSION='v';const HISTORY_FORMULA_VERSION='v1-composite-1';${grab('sourceObservedAt')}\n${grab('buildCompositeProvenance')}\nreturn buildCompositeProvenance;`)();
    const all = [{ id: 'fng', weight: 14, confidence: 1 }, { id: 'regulatory', weight: 6, confidence: 0.5 }, { id: 'oil', weight: 3, confidence: 1 }];
    const active = [{ ...all[0], baseWeight: 14, value: { score: 70, ts: NOW - 1000 } }, { ...all[1], baseWeight: 6, weight: 9, value: { score: 20 } }];
    const p = F(active, all, { oil: { message: 'HTTP 429' } }, NOW, []);
    const db = freshDb();
    const j = await (await post({ DB: d1(db), HISTORY_PROVENANCE: '1' }, { score: Math.round((70 * 14 + 20 * 4.5) / 18.5), provenance: p })).json();
    expect(j.provenance).toMatchObject({ recorded: true, reproducible: true });
    const pj = JSON.parse(rows(db, 'history_provenance')[0].provenance_json);
    expect(pj.sources.find((s) => s.id === 'regulatory').boost).toBe(1.5);
    expect(pj.missing).toEqual([{ id: 'oil', base_weight: 3, reason: 'HTTP 429' }]);
  });
});

describe('failure semantics', () => {
  it('a transient batch failure writes nothing and answers 503, so a retry with the same key stays idempotent', async () => {
    const db = freshDb();
    const r = await post({ DB: d1(db, { failBatch: 'D1_ERROR: database is locked' }), HISTORY_PROVENANCE: '1' },
      { score: 61, provenance: provenance(), idempotencyKey: 'cp:transient1' });
    expect(r.status).toBe(503);
    expect(rows(db, 'history')).toHaveLength(0);
    const ok = await (await post({ DB: d1(db), HISTORY_PROVENANCE: '1' }, { score: 61, provenance: provenance(), idempotencyKey: 'cp:transient1' })).json();
    expect(ok.provenance.recorded).toBe(true);
    expect(rows(db, 'history')).toHaveLength(1);
  });
});
