/**
 * Verified Earnings client methods — over a stubbed fetch (no network).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { CreddaClient, CreddaError } from './client.js';

const BASE = 'https://api.test';
afterEach(() => vi.unstubAllGlobals());

function stub(status: number, body: unknown, capture?: (url: string) => void) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    capture?.(String(url));
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
  }));
}

const summary = {
  userId: 'u1',
  earningsVersion: '1.0',
  currency: null,
  note: 'values are platform-reported units',
  window: { from: '2025-08-01T00:00:00.000Z', to: '2026-07-15T12:00:00.000Z', months: 12 },
  trailing12mVerifiedTotal: 42000,
  medianMonthly: 3200,
  monthsWithEarnings: 11,
  volatility: 0.42,
  verifiedShare: 0.87,
  selfReportedShare: 0.12,
  platformCount: 3,
  longestConsecutiveMonths: 8,
  disclosures: ['This is an attestation of outcomes recorded on the Credda ledger.'],
};

describe('getEarnings', () => {
  it('GETs the earnings endpoint with the window query and bearer auth', async () => {
    let url = '';
    let init: any = {};
    vi.stubGlobal('fetch', vi.fn(async (u: string, i: any) => {
      url = String(u);
      init = i;
      return {
        ok: true, status: 200, json: async () => ({
          ...summary,
          periods: [{ month: '2026-06', grossVerified: 3200, eventCount: 4, platformBreakdown: [{ platform: 'upwork', gross: 3200, eventCount: 4 }] }],
          attested: { grossVerified: 42000, eventCount: 40, trailing12mTotal: 42000, platformCount: 3, platformBreakdown: [] },
          stability: { monthsWithEarnings: 11, medianMonthly: 3200, meanMonthly: 3500, coefficientOfVariation: 0.42, longestConsecutiveMonths: 8 },
          unverifiedReported: { gross: 6000, eventCount: 5 },
          excluded: { disputedEvents: 1, disputedValue: 500, valuelessEvents: 0 },
          coverage: { verifiedShare: 0.87, selfReportedShare: 0.12 },
        }),
      } as Response;
    }));
    const r = await new CreddaClient({ apiBase: BASE }).getEarnings('u1', 'crd_live_k', { months: 12 });
    expect(url).toBe('https://api.test/api/v1/users/u1/earnings?months=12');
    expect(init.headers.Authorization).toBe('Bearer crd_live_k');
    // currency is never invented, and unverified value is never blended in
    expect(r.currency).toBeNull();
    expect(r.attested.grossVerified).toBe(42000);
    expect(r.unverifiedReported.gross).toBe(6000);
    expect(r.disclosures.length).toBeGreaterThan(0);
  });

  it('omits the query string entirely when no window is given', async () => {
    let url = '';
    stub(200, summary, (u) => { url = u; });
    await new CreddaClient({ apiBase: BASE }).getEarnings('u1', 'k');
    expect(url).toBe('https://api.test/api/v1/users/u1/earnings');
  });
});

describe('getEarningsSummary', () => {
  it('passes an explicit from/to window through', async () => {
    let url = '';
    stub(200, summary, (u) => { url = u; });
    await new CreddaClient({ apiBase: BASE }).getEarningsSummary('u1', 'k', {
      from: '2026-01-01T00:00:00Z',
      to: '2026-06-30T00:00:00Z',
    });
    expect(url).toContain('/users/u1/earnings/summary?');
    expect(url).toContain('from=2026-01-01T00%3A00%3A00Z');
    expect(url).toContain('to=2026-06-30T00%3A00%3A00Z');
  });

  it('returns the compact summary shape, with a nullable volatility', async () => {
    stub(200, { ...summary, volatility: null, verifiedShare: null });
    const r = await new CreddaClient({ apiBase: BASE }).getEarningsSummary('u1', 'k');
    expect(r.volatility).toBeNull();
    expect(r.verifiedShare).toBeNull();
    expect(r.trailing12mVerifiedTotal).toBe(42000);
  });
});

describe('mintEarningsCredential', () => {
  it('POSTs the window options and returns the signed credential', async () => {
    let url = '';
    let init: any = {};
    vi.stubGlobal('fetch', vi.fn(async (u: string, i: any) => {
      url = String(u);
      init = i;
      return {
        ok: true, status: 201, json: async () => ({
          format: 'jwt_vc_json', credentialVc: 'ey.a.b', credentialType: 'CreddaEarningsCredential',
          issuer: 'did:web:api.credda.io', kid: 'did:web:api.credda.io#k', scope: 'earnings',
          earningsVersion: '1.0', claims: { credentialKind: 'verified-earnings' },
          issuedAt: 'x', expiresAt: 'y', didDocument: '/.well-known/did.json',
          trustRegistry: '/.well-known/credda-trust-registry.json',
          statusList: 'https://api.test/api/v1/status/revocation',
        }),
      } as Response;
    }));
    const r = await new CreddaClient({ apiBase: BASE }).mintEarningsCredential('u1', 'crd_live_k', {
      months: 6,
      ttlSeconds: 600,
    });
    expect(url).toBe('https://api.test/api/v1/users/u1/earnings/credential');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ months: 6, ttlSeconds: 600 });
    expect(r.credentialType).toBe('CreddaEarningsCredential');
    expect(r.credentialVc).toBeTruthy();
  });

  it('surfaces the test-mode refusal as a CreddaError', async () => {
    stub(403, { error: 'test mode', code: 'TEST_MODE_NOT_ALLOWED' });
    await expect(
      new CreddaClient({ apiBase: BASE }).mintEarningsCredential('u1', 'k'),
    ).rejects.toBeInstanceOf(CreddaError);
  });
});
