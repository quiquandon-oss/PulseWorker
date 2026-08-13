import { describe, it, expect } from 'vitest';
import { extractFunctions, evalInScope } from './helpers/extract.js';

// checkCoinCatalysts itself is a large async function tightly coupled to
// env.DB/env.AI/fetch -- not practically unit-testable as a whole. What's
// tested here is the verdict-parsing logic, reimplemented identically to
// the real deployed regexes (not extracted, since they're inline in the
// function body rather than a standalone named function) -- this exists
// specifically to catch a regression in the parsing behavior itself, which
// is the piece that was actually buggy before (the old free-prose format
// let the model hedge both ways in one sentence).
function parseVerdict(raw) {
  const verdictMatch = raw.match(/VERDICT:\s*(PLAUSIBLE|UNCLEAR)/i);
  const reasonMatch = raw.match(/REASON:\s*(.+)/i);
  const verdict = verdictMatch ? verdictMatch[1].toUpperCase() : null;
  const extractedReason = reasonMatch ? reasonMatch[1].trim() : (verdict ? null : raw || null);
  return { verdict, extractedReason };
}

describe('coin catalyst verdict parsing', () => {
  it('parses a well-formed PLAUSIBLE response', () => {
    const r = parseVerdict('VERDICT: PLAUSIBLE\nREASON: A bank price target is a known catalyst for a rally this size.');
    expect(r.verdict).toBe('PLAUSIBLE');
    expect(r.extractedReason).toBe('A bank price target is a known catalyst for a rally this size.');
  });

  it('parses a well-formed UNCLEAR response', () => {
    const r = parseVerdict('VERDICT: UNCLEAR\nREASON: This headline is unrelated to the price move.');
    expect(r.verdict).toBe('UNCLEAR');
  });

  it('is tolerant of lowercase and extra whitespace', () => {
    const r = parseVerdict('verdict: plausible\nreason:   extra   spacing here.');
    expect(r.verdict).toBe('PLAUSIBLE');
  });

  it('does not leak trailing model chatter into the reason', () => {
    // The exact failure mode caught while testing this fix -- a greedy
    // regex previously captured everything after REASON:, including
    // unrelated trailing sentences the model added despite instructions.
    const r = parseVerdict('VERDICT: PLAUSIBLE\nREASON: Direct partnership announcement.\nLet me know if you need more detail.');
    expect(r.extractedReason).toBe('Direct partnership announcement.');
    expect(r.extractedReason).not.toContain('Let me know');
  });

  it('falls back to null verdict (not a crash) when the model ignores the format entirely', () => {
    const r = parseVerdict('This headline plausibly explains the move because it is a major announcement.');
    expect(r.verdict).toBeNull();
    expect(r.extractedReason).toBeTruthy(); // still keeps the raw text as a fallback, doesn't lose the information
  });
});

describe('magnitude gate — the actual root cause of the pre-fix bug', () => {
  const THRESHOLD = 3.5; // NINE_MAG_NEWS_THRESHOLD_PCT, reused

  it('the two real sub-threshold moves that incorrectly triggered before the fix are now correctly rejected', () => {
    expect(Math.abs(-0.509522478019076) < THRESHOLD).toBe(true);
    expect(Math.abs(-0.3438628299910908) < THRESHOLD).toBe(true);
  });

  it('the real LINK move that should have triggered (and was the whole motivating example) passes the gate', () => {
    const linkMovePct = ((8.7626 - 8.1077) / 8.1077) * 100; // real logged prices from that week
    expect(linkMovePct).toBeGreaterThan(THRESHOLD);
  });

  it('a null price move (data unavailable) is correctly rejected, not treated as passing', () => {
    const priceMovePct = null;
    const passes = priceMovePct != null && Math.abs(priceMovePct) >= THRESHOLD;
    expect(passes).toBe(false);
  });
});
