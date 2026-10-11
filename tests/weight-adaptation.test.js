import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions, evalInScope } from './helpers/extract.js';

const SRC = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const constBlock = (name) => { const i = SRC.indexOf(`const ${name} = `); return SRC.slice(i, SRC.indexOf('};', i) + 2); };
const S = evalInScope(
  [constBlock('SENTIMENT_DEFAULT_WEIGHTS'), constBlock('WEIGHT_ADAPT_POLICY'), "const SENTIMENT_DEFAULT_WEIGHTS_VERSION = 'test';",
   extractFunctions('buildAdaptationSamples', 'compositeFrom', 'hitRate', 'effectiveShares', 'proposeWeights', 'evaluateProposalOutOfSample',
     'ensureWeightAdaptationTable', 'loadSentimentObservations', 'runWeightAdaptation')].join('\n\n') +
  '\nfunction __get(){return {SENTIMENT_DEFAULT_WEIGHTS, WEIGHT_ADAPT_POLICY};}');
const { SENTIMENT_DEFAULT_WEIGHTS: D, WEIGHT_ADAPT_POLICY: P } = S.__get();
const H = 3600000;

// fng is informative on even rows (neutral 50 on odd ones), usd is anti-informative and decides the odd rows.
function samples(n, { usdNoise = true } = {}) {
  return Array.from({ length: n }, (_, i) => {
    const up = i % 3 !== 0;
    return { ts: i * 6 * H, fwdReturn: up ? 0.02 : -0.02,
      sources: { fng: i % 2 ? 50 : (up ? 80 : 20), usd: usdNoise ? (up ? 30 : 70) : 50, funding: 50 + (i % 4 < 2 ? 1 : -1) } };
  });
}

describe('V1 default weights mirror', () => {
  it('matches CryptoPulse COMPOSITE_SOURCES_DEFAULTS when that checkout is present', () => {
    let html; try { html = readFileSync(new URL('../../CryptoPulse/index.html', import.meta.url), 'utf8'); } catch { return; }
    const block = html.slice(html.indexOf('const COMPOSITE_SOURCES_DEFAULTS'), html.indexOf('function loadSentimentWeights'));
    const v1 = Object.fromEntries([...block.matchAll(/\{id:'([a-z0-9]+)',label:'[^']*',weight:([\d.]+),confidence:([\d.]+)\}/g)].map(m => [m[1], [+m[2], +m[3]]]));
    expect(v1).toEqual(D);
    expect(html).toContain("const COMPOSITE_WEIGHTS_VERSION='" + SRC.match(/SENTIMENT_DEFAULT_WEIGHTS_VERSION = '([^']+)'/)[1] + "'");
  });
});

describe('proposeWeights', () => {
  it('raises a source with positive incremental value and lowers a harmful one, one bounded step at a time', () => {
    const { weights, evidence, changed } = S.proposeWeights(samples(60), D);
    expect(evidence.fng.decision).toBe('increase');
    expect(evidence.usd.decision).toBe('decrease');
    expect(weights.fng[0]).toBeLessThanOrEqual(D.fng[0] * 1.1 + 1e-9);
    expect(weights.usd[0]).toBeGreaterThanOrEqual(D.usd[0] * 0.9 - 1e-9);
    expect(changed).toEqual(expect.arrayContaining(['fng', 'usd']));
    expect(weights.funding).toEqual(D.funding);           // no measurable incremental value -> unchanged
    expect(evidence.hloi.decision).toBe('insufficient_samples'); // never observed -> unchanged
    expect(weights.hloi).toEqual(D.hloi);
  });
  it('never leaves [0.5, 1.5] x default however many runs, and never exceeds the 20% share cap', () => {
    let w = D;
    for (let i = 0; i < 40; i++) w = S.proposeWeights(samples(60), w).weights;
    expect(w.fng[0]).toBeLessThanOrEqual(D.fng[0] * 1.5 + 1e-9);
    expect(w.usd[0]).toBeGreaterThanOrEqual(D.usd[0] * 0.5 - 1e-9);
    for (const sh of Object.values(S.effectiveShares(w))) expect(sh).toBeLessThanOrEqual(20 + 1e-6);
  });
  it('a source redundant with another gets ~zero incremental value', () => {
    const smp = samples(60, { usdNoise: false }).map(x => ({ ...x, sources: { ...x.sources, funding: x.sources.fng } }));
    const { evidence } = S.proposeWeights(smp, D);
    expect(Math.abs(evidence.funding.delta_pts)).toBeLessThan(P.minDeltaPts);
  });
});

describe('hitRate', () => {
  it('an all-neutral reading makes no call even with float rounding', () => {
    const r = S.hitRate([{ ts: 0, fwdReturn: -0.01, sources: { fng: 50, usd: 50, funding: 50 } }], D);
    expect(r.n).toBe(0);
  });
});

describe('samples and out-of-sample evaluation', () => {
  it('spaces samples and only uses a forward price within tolerance', () => {
    const rows = [0, 0.25, 6, 24, 30].map(h => ({ ts: h * H, btc_price: 100 + h, sources: { fng: 60 } }));
    const sm = S.buildAdaptationSamples(rows);
    expect(sm.map(x => x.ts / H)).toEqual([0, 6]);
    expect(sm[0].fwdReturn).toBeCloseTo(124 / 100 - 1, 9);
  });
  it('scores a proposal only on later data and gives an honest verdict', () => {
    const smp = samples(100);
    const prop = { run_ts: smp[49].ts, weights: S.proposeWeights(smp.slice(0, 50), D).weights };
    const ev = S.evaluateProposalOutOfSample(smp, prop);
    expect(ev.samples_after).toBe(50);
    expect(['IMPROVED', 'NO_DIFFERENCE', 'WORSE']).toContain(ev.verdict);
    expect(S.evaluateProposalOutOfSample(smp.slice(0, 55), prop).verdict).toBe('INSUFFICIENT_DATA');
  });
});

describe('runWeightAdaptation', () => {
  it('logs every run with previous/new weights, evidence and reason; insufficient data changes nothing', async () => {
    const writes = [];
    const db = { prepare(sql) { let a = []; const q = { bind(...x) { a = x; return q; },
      async run() { if (/^INSERT/.test(sql)) writes.push(a); return {}; },
      async first() { return null; },
      async all() { return { results: /FROM history/.test(sql) ? [{ ts: 0, btc_price: 100, sources_json: '{"fng":60}' }] : [] }; } }; return q; } };
    const r = await S.runWeightAdaptation({ DB: db }, 1000);
    expect(r.changed).toEqual([]);
    expect(r.reason).toMatch(/insufficient evidence/);
    expect(writes).toHaveLength(1);
    const [runTs, mode, , , prev, next, , reason, n, changed] = writes[0];
    expect([runTs, mode, n, changed]).toEqual([1000, 'shadow', 0, 0]);
    expect(JSON.parse(prev)).toEqual(D);
    expect(JSON.parse(next)).toEqual(D);
    expect(reason).toMatch(/insufficient/);
  });
});
