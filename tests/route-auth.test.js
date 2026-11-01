// sec-v1: route authentication, server-held third-party keys and allowlisted proxies. Real worker.fetch, fake env.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../worker.js';

const TOKEN = 'test-access-token-0123456789';
// A DB that records any use, so a rejected request can be proven to have touched nothing.
function trapDb() {
  const used = [];
  const stmt = () => ({ bind: () => stmt(), run: async () => { used.push('run'); return { meta: {} }; }, all: async () => { used.push('all'); return { results: [] }; }, first: async () => { used.push('first'); return null; } });
  return { used, prepare: (sql) => { used.push(sql); return stmt(); }, batch: async () => { used.push('batch'); return []; } };
}
const req = (method, path, headers = {}, body) => new Request('https://w' + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: method === 'GET' ? undefined : (body ?? '{}') });

const PROTECTED = [
  ['POST', '/whale-analysis'], ['POST', '/whale-log'], ['POST', '/portfolio-log'], ['POST', '/txs-backup'], ['GET', '/txs-backup'],
  ['GET', '/portfolio-history'], ['POST', '/liquidation-analysis'], ['POST', '/history'], ['POST', '/backfill-sources'],
  ['POST', '/alert-configs'], ['POST', '/alert-configs/toggle'], ['POST', '/alert-configs/delete'], ['POST', '/test-telegram'],
  ['GET', '/run-technical-eval'], ['POST', '/run-technical-eval'], ['POST', '/trader-analysis'], ['POST', '/trader-analysis-gemini'],
  ['POST', '/gemini-outlook'], ['GET', '/foufi-backfill-rss'], ['GET', '/foufi-check'],
];

let realFetch;
beforeEach(() => { realFetch = globalThis.fetch; globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 })); vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

describe('protected routes with V1_ACCESS_TOKEN set', () => {
  for (const [m, p] of PROTECTED) {
    it(`${m} ${p}: missing, wrong or X-App-Secret token -> 401 with no DB or network access; correct token -> handler runs`, async () => {
      for (const h of [{}, { 'X-V1-Token': 'wrong' }, { 'X-App-Secret': TOKEN }, { 'X-V1-Token': TOKEN + 'x' }]) {
        const db = trapDb();
        const r = await worker.fetch(req(m, p, h), { DB: db, V1_ACCESS_TOKEN: TOKEN });
        expect(r.status).toBe(401);
        expect(db.used).toEqual([]);
        expect(globalThis.fetch).not.toHaveBeenCalled();
      }
      const r = await worker.fetch(req(m, p, { 'X-V1-Token': TOKEN }), { DB: trapDb(), V1_ACCESS_TOKEN: TOKEN });
      expect(r.status).not.toBe(401);
    });
  }
});

describe('fail-open only while unconfigured (avoids the 2026-08-11 outage)', () => {
  it('without V1_ACCESS_TOKEN a protected route behaves as before (no 401)', async () => {
    const r = await worker.fetch(req('GET', '/txs-backup'), { DB: trapDb() });
    expect(r.status).not.toBe(401);
  });
  it('/security-status reports the state and key presence by name only', async () => {
    const open = await (await worker.fetch(req('GET', '/security-status'), { DB: trapDb() })).json();
    expect(open.route_auth).toMatch(/^open/);
    const on = await (await worker.fetch(req('GET', '/security-status'), { DB: trapDb(), V1_ACCESS_TOKEN: TOKEN, FRED_API_KEY: 'fred-secret-value' })).json();
    expect(on.route_auth).toBe('enforced');
    expect(on.server_keys).toEqual({ FRED_API_KEY: true, CG_API_KEY: false, SOSO_API_KEY: false });
    expect(JSON.stringify(on)).not.toContain('fred-secret-value');
    expect(JSON.stringify(on)).not.toContain(TOKEN);
  });
});

describe('public read-only routes stay public with the token set', () => {
  for (const p of ['/history', '/news-proxy?source=crypto', '/foufi-latest', '/risk-regime', '/weight-adaptation', '/alert-configs', '/security-status']) {
    it(`GET ${p}`, async () => {
      const r = await worker.fetch(req('GET', p), { DB: trapDb(), V1_ACCESS_TOKEN: TOKEN });
      expect(r.status).not.toBe(401);
    });
  }
  it('CORS preflight allows X-V1-Token', async () => {
    const r = await worker.fetch(new Request('https://w/txs-backup', { method: 'OPTIONS' }), { DB: trapDb(), V1_ACCESS_TOKEN: TOKEN });
    expect(r.status).toBe(200);
    expect(r.headers.get('Access-Control-Allow-Headers')).toContain('X-V1-Token');
  });
});

describe('server-held third-party keys', () => {
  it('/macro-proxy uses FRED_API_KEY when set and ignores the client-supplied key', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ observations: [] }), { status: 200 }));
    await worker.fetch(req('GET', '/macro-proxy?series=DGS10&key=client-key'), { DB: trapDb(), FRED_API_KEY: 'server-key' });
    const u = String(globalThis.fetch.mock.calls[0][0]);
    expect(u).toContain('api_key=server-key');
    expect(u).not.toContain('client-key');
  });
  it('/macro-proxy still accepts the client key while no server key exists (transition)', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ observations: [] }), { status: 200 }));
    await worker.fetch(req('GET', '/macro-proxy?series=DGS10&key=client-key'), { DB: trapDb() });
    expect(String(globalThis.fetch.mock.calls[0][0])).toContain('api_key=client-key');
  });
  it('/macro-proxy no longer needs a key parameter once the server key exists', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ observations: [] }), { status: 200 }));
    const r = await worker.fetch(req('GET', '/macro-proxy?series=SP500'), { DB: trapDb(), FRED_API_KEY: 'server-key' });
    expect(r.status).toBe(200);
  });
});

describe('/api-proxy (allowlisted upstream paths only)', () => {
  it('CoinGecko: allowed paths pass with query and the server key header; keyless when no key is set', async () => {
    globalThis.fetch = vi.fn(async () => new Response('{"ok":1}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const r = await worker.fetch(req('GET', '/api-proxy/coingecko?path=/coins/bitcoin/market_chart&vs_currency=usd&days=90'), { DB: trapDb(), CG_API_KEY: 'cgk' });
    expect(r.status).toBe(200);
    const [u, init] = globalThis.fetch.mock.calls[0];
    expect(u).toBe('https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=90');
    expect(init.headers['x-cg-demo-api-key']).toBe('cgk');
    await worker.fetch(req('GET', '/api-proxy/coingecko?path=/global'), { DB: trapDb() });
    expect(globalThis.fetch.mock.calls[1][1].headers['x-cg-demo-api-key']).toBeUndefined();
  });
  it('rejects paths outside the allowlist, traversal and unknown services', async () => {
    for (const p of ['/api-proxy/coingecko?path=/coins/list', '/api-proxy/coingecko?path=/global/../key', '/api-proxy/coingecko?path=//evil.example/x',
      '/api-proxy/coingecko?path=/coins/bitcoin/market_chart/../../x', '/api-proxy/coingecko', '/api-proxy/sosovalue?path=/user/info']) {
      const r = await worker.fetch(req('GET', p), { DB: trapDb(), SOSO_API_KEY: 'k' });
      expect(r.status, p).toBe(403);
    }
    expect((await worker.fetch(req('GET', '/api-proxy/evil?path=/x'), { DB: trapDb() })).status).toBe(404);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it('SoSoValue requires the server key and never reveals it', async () => {
    const no = await worker.fetch(req('GET', '/api-proxy/sosovalue?path=/news&page_num=1'), { DB: trapDb() });
    expect(no.status).toBe(503);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    globalThis.fetch = vi.fn(async () => new Response('{"data":{}}', { status: 200 }));
    const ok = await worker.fetch(req('GET', '/api-proxy/sosovalue?path=/etfs/summary-history&symbol=BTC&country_code=US&limit=30'), { DB: trapDb(), SOSO_API_KEY: 'soso-secret' });
    expect(ok.status).toBe(200);
    expect(await ok.text()).not.toContain('soso-secret');
    expect(globalThis.fetch.mock.calls[0][1].headers['x-soso-api-key']).toBe('soso-secret');
  });
});
