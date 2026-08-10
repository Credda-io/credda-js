/**
 * UNMEASURED IS NOT ZERO: the SDK-side half of the rule.
 *
 * The API deliberately sends JSON `null` for a rate it never measured, plus a
 * discriminator (`available` / `insufficientData` / `dataState`) saying so. A
 * client type that hides the discriminator makes it impossible for a caller to
 * tell "never measured" from "measured, and it was zero", which is how a record
 * with no history ends up rendered as a failing record.
 *
 * These tests pin three things, and they are the same three in every language
 * binding:
 *   1. a payload with `available: false` and a null score preserves BOTH facts;
 *   2. a MEASURED zero stays distinguishable from an unmeasured one;
 *   3. a payload from an OLDER API that omits the field decodes safely.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { CreddaClient } from './client.js';
import type {
  ScoreComponentsPayload,
  ScoreExplainPayload,
  TrustSummaryPayload,
  ReliabilityReportPayload,
  ScoreProjectionPayload,
} from './client.js';

const BASE = 'https://api.test';
afterEach(() => vi.unstubAllGlobals());

function stub(body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => body,
  } as Response)));
}

const client = () => new CreddaClient({ apiBase: BASE });

// ─── /score/components ───────────────────────────────────────────────────────

describe('score components', () => {
  it('keeps `available: false` and a null score as two separate facts', async () => {
    stub({
      userId: 'never_scored',
      available: true,
      finalScore: 20,
      scoreBand: 'Unproven',
      components: [
        { key: 'reliability', label: 'Reliability', score: null, weight: 0.4, available: false, description: 'Not measured.' },
      ],
      dataSufficiency: {
        insufficientData: true,
        state: 'no_recorded_outcomes',
        recordedOutcomes: 0,
        verifiedOutcomes: 0,
        note: 'No outcomes recorded yet.',
      },
    });

    const out: ScoreComponentsPayload = await client().getScoreComponents('u1', 'k');
    const c = out.components[0];

    expect(c.available).toBe(false);
    expect(c.score).toBeNull();
    // The bug this guards: reading the score without the branch renders a 0.
    expect(c.score ?? 0).toBe(0);
    expect(out.dataSufficiency?.insufficientData).toBe(true);
    expect(out.dataSufficiency?.state).toBe('no_recorded_outcomes');
  });

  it('a MEASURED zero is distinguishable from an unmeasured component', async () => {
    stub({
      userId: 'measured_badly',
      available: true,
      finalScore: 20,
      scoreBand: 'At Risk',
      components: [
        { key: 'reliability', label: 'Reliability', score: 0, weight: 0.4, available: true, description: 'Completed none of them.' },
        { key: 'timeliness', label: 'Timeliness', score: null, weight: 0.35, available: false, description: 'Not measured.' },
      ],
      dataSufficiency: {
        insufficientData: false, state: 'ok', recordedOutcomes: 12, verifiedOutcomes: 12, note: '',
      },
    });

    const out = await client().getScoreComponents('u1', 'k');
    const [measured, unmeasured] = out.components;

    // A real 0 over a real denominator is genuine bad news and must survive.
    expect(measured.available).toBe(true);
    expect(measured.score).toBe(0);
    expect(unmeasured.available).toBe(false);
    expect(unmeasured.score).toBeNull();
    expect(measured.score === unmeasured.score).toBe(false);
    expect(out.dataSufficiency?.insufficientData).toBe(false);
  });

  it('decodes safely against an API that predates the fields', async () => {
    stub({
      userId: 'old_api',
      available: true,
      components: [{ key: 'reliability', label: 'Reliability', score: 78, weight: 0.4, description: 'Good.' }],
    });

    const out = await client().getScoreComponents('u1', 'k');
    expect(out.components[0].available).toBeUndefined();
    expect(out.dataSufficiency).toBeUndefined();
    // `available !== false` is the safe read for a mixed-version fleet: an old
    // API that never sends the flag still yields its real score.
    expect(out.components[0].available !== false).toBe(true);
  });
});

// ─── /score/explain ──────────────────────────────────────────────────────────

describe('score explain', () => {
  it('carries dataSufficiency, per-factor available, and the informational reason code', async () => {
    stub({
      summary: 'No outcomes recorded yet, so nothing can be measured.',
      factors: [
        { key: 'completionRate', name: 'Completion Rate', value: null, weight: 0.37, weightPercent: '37%', contribution: null, available: false, description: 'Not measured.' },
      ],
      dataSufficiency: {
        insufficientData: true, state: 'no_recorded_outcomes', recordedOutcomes: 0, verifiedOutcomes: 0, note: 'n/a',
      },
      reasonCodes: {
        formulaVersion: '5.3',
        reasonCodesVersion: '1.2',
        finalScore: null,
        method: 'importance-weighted',
        keyFactorLimit: 4,
        adverseActionReasons: [],
        supportingFactors: [],
        informationalFactors: [
          { code: 'NO_RECORDED_OUTCOMES', factor: 'data', direction: 'informational', title: 'No recorded outcomes', description: '', contribution: 0, rank: 1, evidence: {} },
        ],
        insufficientData: true,
        dataState: 'no_recorded_outcomes',
        disclosures: [],
        advisory: '',
      },
      confidence: { eventsRecorded: 0, eventsNeededForFull: 6, level: 'None' },
    });

    const out: ScoreExplainPayload = await client().getScoreExplain('u1', 'k');

    expect(out.dataSufficiency?.insufficientData).toBe(true);
    expect(out.factors[0].available).toBe(false);
    expect(out.factors[0].value).toBeNull();

    const rc = out.reasonCodes!;
    // The load-bearing invariant: an absent measurement yields NO adverse reason.
    expect(rc.insufficientData).toBe(true);
    expect(rc.dataState).toBe('no_recorded_outcomes');
    expect(rc.adverseActionReasons).toHaveLength(0);
    expect(rc.supportingFactors).toHaveLength(0);
    expect(rc.informationalFactors?.[0].direction).toBe('informational');
    expect(rc.finalScore).toBeNull();
  });

  it('distinguishes a pending computation from an empty record', async () => {
    stub({
      summary: '',
      factors: [],
      reasonCodes: {
        formulaVersion: '5.3', reasonCodesVersion: '1.2', finalScore: null,
        method: '', keyFactorLimit: 4,
        adverseActionReasons: [], supportingFactors: [],
        informationalFactors: [
          { code: 'SCORE_NOT_YET_COMPUTED', factor: 'data', direction: 'informational', title: '', description: '', contribution: 0, rank: 1, evidence: {} },
        ],
        insufficientData: true,
        dataState: 'score_not_yet_computed',
        disclosures: [], advisory: '',
      },
      confidence: { eventsRecorded: 3, eventsNeededForFull: 6, level: 'None' },
    });

    const out = await client().getScoreExplain('u1', 'k');
    expect(out.reasonCodes?.dataState).toBe('score_not_yet_computed');
    expect(out.reasonCodes?.dataState).not.toBe('no_recorded_outcomes');
  });

  it('an explain payload from an older API still decodes', async () => {
    stub({
      summary: 'ok',
      factors: [{ name: 'Completion Rate', value: 0.9, weight: 0.37, weightPercent: '37%', contribution: 0.36, description: '' }],
      confidence: { eventsRecorded: 9, eventsNeededForFull: 0, level: 'High' },
    });
    const out = await client().getScoreExplain('u1', 'k');
    expect(out.dataSufficiency).toBeUndefined();
    expect(out.reasonCodes).toBeUndefined();
    expect(out.factors[0].available).toBeUndefined();
  });

  it('weight arrives as a NUMBER and the label rides on weightPercent', async () => {
    // The API split this field on 2026-08-09: `weight` became the fraction the
    // engine applies and the "37%" label moved to `weightPercent`. The declared
    // type of `weight` here is still `string`, which is a known lie kept for
    // published consumers (see the doc comment on the field). This test pins
    // what actually arrives, so nobody re-reads the declaration and believes it.
    //
    // The Go SDK carried the same wrong declaration and it was NOT cosmetic
    // there: encoding/json refuses a number into a string, so GetScoreExplain
    // returned an error for every caller. That one was corrected.
    stub({
      summary: 'Strong record.',
      factors: [
        { key: 'completionRate', name: 'Completion Rate', value: 0.9, weight: 0.37, weightPercent: '37%', contribution: 0.33, available: true, description: 'Strong.' },
        { key: 'onTimeRate', name: 'On-time Rate', value: 0.8, weight: 0.32, weightPercent: '32%', contribution: 0.26, available: true, description: 'Good.' },
      ],
    });
    const out = await client().getScoreExplain('u1', 'k');

    for (const f of out.factors) {
      expect(typeof f.weight, 'weight is the numeric fraction, whatever the type says').toBe('number');
      expect(typeof f.weightPercent).toBe('string');
    }
    expect(out.factors[0].weightPercent).toBe('37%');
    // Reading it as the string the type promises is what breaks a caller.
    expect(() => (out.factors[0].weight as unknown as string).endsWith('%')).toThrow();
  });
});

// ─── trust summary ───────────────────────────────────────────────────────────

describe('trust summary evidence', () => {
  it('reports insufficientData beside null rates, and keeps a measured 0 distinct', async () => {
    stub({
      userId: 'u1', available: true, summary: '',
      evidence: {
        finalScore: 20, scoreBand: 'Unproven', confidenceLevel: 'none',
        completionRate: null, onTimeRate: null,
        verifiedEvents: 0, totalEvents: 0, distinctPlatforms: 0,
        insufficientData: true,
      },
    });
    const empty: TrustSummaryPayload = await client().getTrustSummary('u1', 'k');
    expect(empty.evidence?.insufficientData).toBe(true);
    expect(empty.evidence?.completionRate).toBeNull();

    stub({
      userId: 'u2', available: true, summary: '',
      evidence: {
        finalScore: 20, scoreBand: 'At Risk', confidenceLevel: 'high',
        completionRate: 0, onTimeRate: 0,
        verifiedEvents: 8, totalEvents: 8, distinctPlatforms: 1,
        insufficientData: false,
      },
    });
    const measured = await client().getTrustSummary('u2', 'k');
    expect(measured.evidence?.insufficientData).toBe(false);
    expect(measured.evidence?.completionRate).toBe(0);
  });
});

// ─── reliability report ──────────────────────────────────────────────────────

describe('reliability report metrics', () => {
  it('carries insufficientData + dataState alongside null rates', async () => {
    stub({
      userId: 'u1',
      reliabilityReportVersion: '1.0', note: '',
      reliability: { score: null, band: null, confidence: 0, formulaVersion: '5.3', reasonCodesVersion: '1.2' },
      metrics: {
        completionRate: null, onTimeRate: null, consistency: null, recency: null, disputeRate: null,
        insufficientData: true, dataState: 'score_not_yet_computed',
      },
      verifiedExperience: {}, topFactors: [], recentOutcomes: [],
      benchmark: null, status: { scoreFrozen: false },
      provenance: { formulaVersion: '5.3', computedAt: null },
      disclosures: [], advisory: '',
    });

    const out: ReliabilityReportPayload = await client().getReliabilityReport('u1', 'k');
    expect(out.metrics.insufficientData).toBe(true);
    expect(out.metrics.dataState).toBe('score_not_yet_computed');
    expect(out.metrics.completionRate).toBeNull();
    // topFactors is empty because nothing is attributable, NOT because the
    // record is clean. The discriminator is what says which.
    expect(out.topFactors).toHaveLength(0);
    expect(out.reliability.score).toBeNull();
  });
});

// ─── projection timeliness ───────────────────────────────────────────────────

describe('projection timeliness', () => {
  it('flags an upper-bound projection when a lateness was never stated', async () => {
    stub({
      userId: 'u1', delta: 4,
      current: { finalScore: 20, scoreBand: 'Unproven' },
      projected: { finalScore: 24, scoreBand: 'Provisional' },
      bandChanged: true, formulaVersion: '5.3',
      timeliness: {
        statedEvents: 0, unstatedEvents: 2, basis: 'unstated',
        projectionIsUpperBound: true,
        note: 'No lateness was stated and none was assumed.',
        projectedIfUnstatedWereLate: { finalScore: 21, scoreBand: 'Unproven', delta: 1 },
      },
    });

    const out: ScoreProjectionPayload = await client().projectScore('u1', [], 'k');
    expect(out.timeliness?.projectionIsUpperBound).toBe(true);
    expect(out.timeliness?.basis).toBe('unstated');
    // An unstated lateness is not a claim of punctuality: the bound exists.
    expect(out.timeliness?.projectedIfUnstatedWereLate?.finalScore).toBe(21);
  });

  it('a fully-stated batch is a point estimate, not a bound', async () => {
    stub({
      userId: 'u1', delta: 4,
      current: { finalScore: 20, scoreBand: 'Unproven' },
      projected: { finalScore: 24, scoreBand: 'Provisional' },
      bandChanged: true, formulaVersion: '5.3',
      timeliness: {
        statedEvents: 2, unstatedEvents: 0, basis: 'stated',
        projectionIsUpperBound: false, note: '', projectedIfUnstatedWereLate: null,
      },
    });
    const out = await client().projectScore('u1', [], 'k');
    expect(out.timeliness?.projectionIsUpperBound).toBe(false);
    expect(out.timeliness?.projectedIfUnstatedWereLate).toBeNull();
  });
});
