import { describe, it, expect, beforeAll } from 'vitest';
import { extractFunctions, evalInScope } from './helpers/extract.js';

describe('filterSnapshotSpikes() — portfolio chart outlier removal', () => {
  let scope;

  beforeAll(() => {
    const src = extractFunctions('filterSnapshotSpikes');
    scope = evalInScope(src);
  });

  it('removes a single-point spike that returns to baseline', () => {
    const points = [
      { value_usd: 2459 }, { value_usd: 2146 }, { value_usd: 2461 },
    ];
    const filtered = scope.filterSnapshotSpikes(points);
    expect(filtered.map(p => p.value_usd)).toEqual([2459, 2461]);
  });

  it('removes a multi-point run that eventually returns to baseline — real bug this exists to catch', () => {
    // The actual failure mode found in production: a bad session logs the
    // same wrong value several times in a row (fire-and-forget on every
    // render) before a healthy session corrects it. A naive single-point
    // filter only caught 2 of 27 confirmed-bad points in the real dataset
    // this was built against — this run-aware version has to catch the
    // whole run, not just an isolated point.
    const points = [
      { value_usd: 2457 }, { value_usd: 2146 }, { value_usd: 2146 }, { value_usd: 2147 },
      { value_usd: 2459 },
    ];
    const filtered = scope.filterSnapshotSpikes(points);
    expect(filtered.map(p => p.value_usd)).toEqual([2457, 2459]);
  });

  it('does NOT remove a genuine sustained change that never returns to baseline', () => {
    // A real deposit/withdrawal — the whole point of the "never returns"
    // check: this must never be mistaken for a spike just because it's a
    // big jump, or a real balance change would silently vanish from the
    // chart.
    const points = [
      { value_usd: 2000 }, { value_usd: 2000 }, { value_usd: 3500 }, { value_usd: 3510 }, { value_usd: 3505 },
    ];
    const filtered = scope.filterSnapshotSpikes(points);
    expect(filtered.map(p => p.value_usd)).toEqual([2000, 2000, 3500, 3510, 3505]);
  });

  it('leaves fewer than 3 points untouched (nothing to compare against)', () => {
    const points = [{ value_usd: 2000 }, { value_usd: 9999999 }];
    expect(scope.filterSnapshotSpikes(points)).toEqual(points);
  });

  it('handles null/zero value_usd gracefully without throwing', () => {
    const points = [{ value_usd: 2000 }, { value_usd: null }, { value_usd: 2010 }];
    expect(() => scope.filterSnapshotSpikes(points)).not.toThrow();
  });

  it('a small, sub-threshold wobble is not flagged as a spike', () => {
    const points = [{ value_usd: 2000 }, { value_usd: 2020 }, { value_usd: 2005 }]; // ~1% wobble, well under the 8% threshold
    const filtered = scope.filterSnapshotSpikes(points);
    expect(filtered).toHaveLength(3);
  });
});
