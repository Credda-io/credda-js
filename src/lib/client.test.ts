/**
 * CreddaClient tests — public methods over a stubbed fetch (no network).
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

describe('automatic retries (opt-in)', () => {
  function flakyStub(failures: number, failStatus = 503) {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++;
      if (calls <= failures) {
        return { ok: false, status: failStatus, json: async () => ({ error: 'blip' }) } as Response;
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
    }));
    return () => calls;
  }

  it('off by default — a transient failure surfaces immediately', async () => {
    const calls = flakyStub(1);
    const client = new CreddaClient({ apiBase: BASE });
    await expect(client.getScore('u1', 'k')).rejects.toBeInstanceOf(CreddaError);
    expect(calls()).toBe(1);
  });

  it('retries GETs on 429/5xx up to the configured count', async () => {
    const calls = flakyStub(2);
    const client = new CreddaClient({ apiBase: BASE, retries: 2, retryBaseMs: 1 });
    const res = await client.getScore('u1', 'k') as unknown as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(calls()).toBe(3);
  });

  it('does NOT retry non-transient statuses (404) even when enabled', async () => {
    const calls = flakyStub(5, 404);
    const client = new CreddaClient({ apiBase: BASE, retries: 3, retryBaseMs: 1 });
    await expect(client.getScore('u1', 'k')).rejects.toBeInstanceOf(CreddaError);
    expect(calls()).toBe(1);
  });

  it('retries an idempotency-keyed reportEvent but never a bare one', async () => {
    const client = new CreddaClient({ apiBase: BASE, retries: 2, retryBaseMs: 1 });

    const keyedCalls = flakyStub(1);
    const keyed = await client.reportEvent(
      { userId: 'u1', eventType: 'CONTRACT_FULFILLED' },
      'k',
      { idempotencyKey: 'evt-1' },
    ) as unknown as { ok: boolean };
    expect(keyed.ok).toBe(true);
    expect(keyedCalls()).toBe(2);

    const bareCalls = flakyStub(1);
    await expect(client.reportEvent({ userId: 'u1', eventType: 'CONTRACT_FULFILLED' }, 'k'))
      .rejects.toBeInstanceOf(CreddaError);
    expect(bareCalls()).toBe(1);
  });

  it('retries network-level failures (fetch rejects)', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++;
      if (calls === 1) throw new TypeError('fetch failed');
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
    }));
    const client = new CreddaClient({ apiBase: BASE, retries: 1, retryBaseMs: 1 });
    const res = await client.getScore('u1', 'k') as unknown as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(calls).toBe(2);
  });
});

describe('replayWebhookDelivery', () => {
  it('POSTs the replay endpoint', async () => {
    let called = '';
    stub(200, { status: 'replayed', success: true, statusCode: 200, error: null }, (u) => { called = u; });
    const res = await new CreddaClient({ apiBase: BASE }).replayWebhookDelivery('wh_1', 'del_1', 'k');
    expect(called).toBe(`${BASE}/api/v1/webhooks/wh_1/deliveries/del_1/replay`);
    expect(res.success).toBe(true);
  });
});

describe('getTrustExport', () => {
  it('GETs the export endpoint and returns the typed bundle', async () => {
    let called = '';
    const bundle = {
      format: 'credda-trust-export/1', exportedAt: '2026-07-18T12:00:00.000Z',
      subject: { token: 'crd_share_abc' },
      score: { finalScore: 82, scoreBand: 'Excellent', confidence: 1, formulaVersion: '3.0', computedAt: null, scoreFrozen: false },
      activity: { verifiedPlatforms: 3, totalEvents: 40 },
      history: [{ finalScore: 70, scoreBand: 'Good', computedAt: '2026-07-01T00:00:00.000Z' }],
      credential: { format: 'jwt_vc_json', vc: 'eyJ.jwt.sig', issuer: 'did:web:api.credda.io' },
      revocation: { statusListCredential: 'https://api.test/api/v1/status/revocation' },
      howToVerify: 'Verify offline …',
    };
    stub(200, bundle, (u) => { called = u; });
    const client = new CreddaClient({ apiBase: BASE });
    const res = await client.getTrustExport('crd_share_abc');
    expect(called).toBe(`${BASE}/api/v1/verify/crd_share_abc/export`);
    expect(res.format).toBe('credda-trust-export/1');
    expect(res.credential.vc).toBe('eyJ.jwt.sig');
    expect(res.history).toHaveLength(1);
  });

  it('url-encodes the token', async () => {
    let called = '';
    stub(200, {}, (u) => { called = u; });
    await new CreddaClient({ apiBase: BASE }).getTrustExport('a/b c');
    expect(called).toBe(`${BASE}/api/v1/verify/a%2Fb%20c/export`);
  });

  it('throws CreddaError on a non-2xx response', async () => {
    stub(404, { error: 'Unknown or revoked trust token', code: 'NOT_FOUND' });
    await expect(new CreddaClient({ apiBase: BASE }).getTrustExport('nope')).rejects.toBeInstanceOf(CreddaError);
  });
});

describe('getPlans', () => {
  it('GETs /plans and returns the typed catalog', async () => {
    let called = '';
    const catalog = {
      pricing: 'official',
      note: 'Prices are official; self-serve checkout is coming.',
      features: [{ key: 'scoreReads', group: 'Read & verify', label: 'Score reads' }],
      plans: [
        { id: 'STARTER', name: 'Starter', tagline: 'Read & verify', scopes: ['scores:read'], rateLimitPerMin: 240, monitorLimit: 5, priceUsdMonthly: 49, support: 'Community', features: ['scoreReads'] },
        { id: 'ENTERPRISE', name: 'Enterprise', tagline: 'Custom terms', scopes: ['scores:read', 'disputes:write'], rateLimitPerMin: 1200, monitorLimit: 2000, priceUsdMonthly: 1500, support: 'Priority', features: ['scoreReads'] },
      ],
    };
    stub(200, catalog, (u) => { called = u; });
    const res = await new CreddaClient({ apiBase: BASE }).getPlans();
    expect(called).toBe(`${BASE}/api/v1/plans`);
    expect(res.pricing).toBe('official');
    expect(res.plans.map((p) => p.id)).toEqual(['STARTER', 'ENTERPRISE']);
    expect(res.plans[1].rateLimitPerMin).toBe(1200);
    expect(res.plans.map((p) => p.priceUsdMonthly)).toEqual([49, 1500]);
  });

  it('throws CreddaError on a non-2xx response', async () => {
    stub(500, { error: 'boom' });
    await expect(new CreddaClient({ apiBase: BASE }).getPlans()).rejects.toBeInstanceOf(CreddaError);
  });
});

describe('getWebhookEvents', () => {
  it('GETs /webhooks/events and returns the typed catalog', async () => {
    let called = '';
    const catalog = {
      envelope: { type: 'string — one of the event types below' },
      signing: 'HMAC-SHA256 over `${timestamp}.${rawBody}`',
      advisory: 'Webhooks are advisory. No event can change anyone’s score.',
      events: [
        { type: 'score.updated', description: 'A score changed.', example: { score: 72 } },
        { type: 'dispute.resolved', description: 'A dispute resolved.', example: { outcome: 'FOR_USER' } },
      ],
      eventTypes: ['score.updated', 'score.band_changed', 'dispute.resolved'],
    };
    stub(200, catalog, (u) => { called = u; });
    const res = await new CreddaClient({ apiBase: BASE }).getWebhookEvents();
    expect(called).toBe(`${BASE}/api/v1/webhooks/events`);
    expect(res.eventTypes).toHaveLength(3);
    expect(res.events.map((e) => e.type)).toContain('score.updated');
    expect(res.signing).toMatch(/HMAC/);
  });

  it('throws CreddaError on a non-2xx response', async () => {
    stub(500, { error: 'boom' });
    await expect(new CreddaClient({ apiBase: BASE }).getWebhookEvents()).rejects.toBeInstanceOf(CreddaError);
  });
});

describe('getChangelog', () => {
  it('GETs /changelog and returns the typed version contract + entries', async () => {
    let called = '';
    const payload = {
      apiVersion: 'v1',
      note: 'Every entry corresponds to a real merge.',
      versioning: {
        version: 'v1',
        scheme: 'The major version is in the URL path.',
        guarantee: 'v1 is additive-only.',
        additive: ['New fields on a response body.'],
        breaking: ['Removing or renaming an endpoint.'],
        behaviourVersions: 'The API shape is versioned by v1.',
        componentVersions: { api: 'v1', scoringFormula: '5.3' },
        nextMajorVersion: 'A v2 would ship alongside v1.',
        deprecation: {
          minimumNoticeDays: 180,
          announcement: 'Announced at least 180 days ahead.',
          headers: 'Deprecation (RFC 9745) and Sunset (RFC 8594).',
          behaviourUnchanged: 'Deprecation changes nothing about behaviour.',
          activeCount: 0,
        },
      },
      deprecations: [],
      categories: ['added', 'changed', 'deprecated', 'fixed', 'security'],
      latestChange: '2026-07-23',
      count: 2,
      entries: [
        { id: '2026-07-23-a', date: '2026-07-23', category: 'added', summary: 'Something shipped.', endpoints: ['/api/v1/changelog'] },
        { id: '2026-07-18-b', date: '2026-07-18', category: 'fixed', summary: 'Something was fixed.' },
      ],
    };
    stub(200, payload, (u) => { called = u; });
    const res = await new CreddaClient({ apiBase: BASE }).getChangelog();
    expect(called).toBe(`${BASE}/api/v1/changelog`);
    expect(res.apiVersion).toBe('v1');
    // An empty deprecation list means nothing is deprecated — a caller must be
    // able to tell that apart from an unavailable list, so it is always present.
    expect(res.deprecations).toEqual([]);
    expect(res.versioning.deprecation.minimumNoticeDays).toBe(180);
    expect(res.entries.map((e) => e.category)).toEqual(['added', 'fixed']);
  });

  it('throws CreddaError on a non-2xx response', async () => {
    stub(500, { error: 'boom' });
    await expect(new CreddaClient({ apiBase: BASE }).getChangelog()).rejects.toBeInstanceOf(CreddaError);
  });
});

describe('getDidDocument', () => {
  it('GETs /.well-known/did.json directly, bypassing the /api/v1 prefix', async () => {
    let called = '';
    const doc = {
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: 'did:web:api.credda.io',
      verificationMethod: [{ id: 'did:web:api.credda.io#k1', type: 'JsonWebKey2020', controller: 'did:web:api.credda.io', publicKeyJwk: { kty: 'OKP' } }],
      assertionMethod: ['did:web:api.credda.io#k1'],
      authentication: ['did:web:api.credda.io#k1'],
      service: [{ id: 'did:web:api.credda.io#trust-registry', type: 'CreddaTrustRegistry', serviceEndpoint: `${BASE}/.well-known/credda-trust-registry.json` }],
    };
    stub(200, doc, (u) => { called = u; });
    const res = await new CreddaClient({ apiBase: BASE }).getDidDocument();
    expect(called).toBe(`${BASE}/.well-known/did.json`);
    expect(res.id).toBe('did:web:api.credda.io');
    expect(res.service[0].type).toBe('CreddaTrustRegistry');
  });

  it('throws CreddaError on a non-2xx response', async () => {
    stub(500, { error: 'boom' });
    await expect(new CreddaClient({ apiBase: BASE }).getDidDocument()).rejects.toBeInstanceOf(CreddaError);
  });
});

describe('getTrustRegistry', () => {
  it('GETs /.well-known/credda-trust-registry.json directly and returns the typed registry', async () => {
    let called = '';
    const registry = {
      version: '1',
      issuers: [{ name: 'Credda', did: 'did:web:api.credda.io', status: 'active', credentialTypes: ['CreddaTrustCredential'], didDocument: `${BASE}/.well-known/did.json`, jwksUri: `${BASE}/.well-known/jwks.json` }],
    };
    stub(200, registry, (u) => { called = u; });
    const res = await new CreddaClient({ apiBase: BASE }).getTrustRegistry();
    expect(called).toBe(`${BASE}/.well-known/credda-trust-registry.json`);
    expect(res.issuers).toHaveLength(1);
    expect(res.issuers[0].did).toBe('did:web:api.credda.io');
  });

  it('throws CreddaError on a non-2xx response', async () => {
    stub(503, { error: 'unavailable' });
    await expect(new CreddaClient({ apiBase: BASE }).getTrustRegistry()).rejects.toBeInstanceOf(CreddaError);
  });
});

describe('getCredentialIssuerMetadata', () => {
  it('GETs /.well-known/openid-credential-issuer directly, bypassing the /api/v1 prefix', async () => {
    let called = '';
    const meta = {
      credential_issuer: BASE,
      credential_endpoint: `${BASE}/oid4vci/credential`,
      nonce_endpoint: `${BASE}/oid4vci/nonce`,
      credential_configurations_supported: {
        CreddaTrustCredential_sd_jwt_vc: { format: 'dc+sd-jwt', vct: 'https://credda.io/credentials/CreddaTrustCredential' },
      },
    };
    stub(200, meta, (u) => { called = u; });
    const res = await new CreddaClient({ apiBase: BASE }).getCredentialIssuerMetadata();
    expect(called).toBe(`${BASE}/.well-known/openid-credential-issuer`);
    expect(res.credential_endpoint).toBe(`${BASE}/oid4vci/credential`);
    expect(Object.keys(res.credential_configurations_supported)).toContain('CreddaTrustCredential_sd_jwt_vc');
  });

  it('throws CreddaError on a non-2xx response', async () => {
    stub(500, { error: 'boom' });
    await expect(new CreddaClient({ apiBase: BASE }).getCredentialIssuerMetadata()).rejects.toBeInstanceOf(CreddaError);
  });
});

describe('createCredentialOffer', () => {
  it('POSTs to /users/:id/credential-offer with bearer auth and returns the offer + deep link', async () => {
    let url = ''; let init: any = {};
    const offer = {
      credentialOffer: {
        credential_issuer: BASE,
        credential_configuration_ids: ['CreddaTrustCredential_sd_jwt_vc'],
        grants: { 'urn:ietf:params:oauth:grant-type:pre-authorized_code': { 'pre-authorized_code': 'crd_pac_x' } },
      },
      credentialOfferUri: 'openid-credential-offer://?credential_offer=%7B%7D',
      expiresIn: 300,
      scope: 'band',
      credentialIssuer: BASE,
      issuerMetadata: '/.well-known/openid-credential-issuer',
    };
    vi.stubGlobal('fetch', vi.fn(async (u: string, i: any) => {
      url = String(u); init = i;
      return { ok: true, status: 201, json: async () => offer } as Response;
    }));

    const res = await new CreddaClient({ apiBase: BASE }).createCredentialOffer('user 1', 'crd_live_k', { scope: 'band' });
    expect(url).toBe(`${BASE}/api/v1/users/user%201/credential-offer`);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer crd_live_k');
    expect(JSON.parse(init.body)).toEqual({ scope: 'band' });
    expect(res.credentialOfferUri.startsWith('openid-credential-offer://')).toBe(true);
    expect(res.expiresIn).toBe(300);
  });

  it('sends an empty body when no options are given', async () => {
    let init: any = {};
    vi.stubGlobal('fetch', vi.fn(async (_u: string, i: any) => {
      init = i;
      return { ok: true, status: 201, json: async () => ({}) } as Response;
    }));
    await new CreddaClient({ apiBase: BASE }).createCredentialOffer('u', 'k');
    expect(JSON.parse(init.body)).toEqual({});
  });
});

describe('reportEvents (batch ingestion)', () => {
  it('POSTs the events array to /events/batch with bearer auth and returns the partial-success result', async () => {
    let url = ''; let init: any = {};
    vi.stubGlobal('fetch', vi.fn(async (u: string, i: any) => {
      url = String(u); init = i;
      return { ok: true, status: 200, json: async () => ({
        total: 2, created: 1, duplicate: 1, failed: 0,
        results: [
          { index: 0, userId: 'u1', status: 'created', eventId: 'ev_1' },
          { index: 1, userId: 'u2', status: 'duplicate', eventId: 'ev_0' },
        ],
      }) } as Response;
    }));
    const c = new CreddaClient({ apiBase: 'https://api.test' });
    const r = await c.reportEvents(
      [
        { userId: 'u1', eventType: 'CONTRACT_FULFILLED', isVerified: true, idempotencyKey: 'plat-evt-1' },
        { userId: 'u2', eventType: 'CONTRACT_FULFILLED', isVerified: true, idempotencyKey: 'plat-evt-0' },
      ],
      'crd_live_k',
    );
    expect(url).toBe('https://api.test/api/v1/events/batch');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer crd_live_k');
    expect(JSON.parse(init.body).events).toHaveLength(2);
    expect(r.created).toBe(1);
    expect(r.duplicate).toBe(1);
    expect(r.results[0].status).toBe('created');
    expect(r.results[1].eventId).toBe('ev_0');
  });
});

describe('createActivationCampaign (the activation engine)', () => {
  it('POSTs rows to /activation/campaigns with bearer auth + Idempotency-Key and returns the funnel-ready result', async () => {
    let url = ''; let init: any = {};
    vi.stubGlobal('fetch', vi.fn(async (u: string, i: any) => {
      url = String(u); init = i;
      return { ok: true, status: 201, json: async () => ({
        campaign: { id: 'camp_1', name: 'March', submittedCount: 2, createdAt: '2026-07-24T00:00:00Z' },
        created: 2, failed: 0, duplicates: [],
        results: [
          { index: 0, ok: true, id: 'cnf_0', userId: 'u1', status: 'PENDING', confirmationToken: 't0', confirmUrl: 'https://api.test/confirm/cnf_0?token=t0' },
          { index: 1, ok: true, id: 'cnf_1', userId: 'u2', status: 'PENDING', confirmationToken: 't1', confirmUrl: 'https://api.test/confirm/cnf_1?token=t1' },
        ],
      }) } as Response;
    }));
    const c = new CreddaClient({ apiBase: 'https://api.test' });
    const r = await c.createActivationCampaign(
      { name: 'March', rows: [
        { userId: 'u1', eventType: 'CONTRACT_FULFILLED', counterpartyRef: 'client-1', rowKey: 'shift-1' },
        { userId: 'u2', eventType: 'CONTRACT_FULFILLED', counterpartyRef: 'client-2' },
      ] },
      'crd_live_k',
      { idempotencyKey: 'roster-import-1' },
    );
    expect(url).toBe('https://api.test/api/v1/activation/campaigns');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer crd_live_k');
    expect(init.headers['Idempotency-Key']).toBe('roster-import-1');
    expect(JSON.parse(init.body).rows).toHaveLength(2);
    expect(r.campaign.id).toBe('camp_1');
    expect(r.created).toBe(2);
    expect(r.results[0].confirmUrl).toContain('/confirm/');
  });
});

describe('getActivationCampaign (funnel)', () => {
  it('GETs the campaign funnel with bearer auth', async () => {
    let url = ''; let init: any = {};
    vi.stubGlobal('fetch', vi.fn(async (u: string, i: any) => {
      url = String(u); init = i;
      return { ok: true, status: 200, json: async () => ({
        campaign: { id: 'camp_1', name: null, submittedCount: 3, createdAt: '2026-07-24T00:00:00Z' },
        funnel: { submitted: 3, pending: 1, confirmed: 1, declined: 1, expired: 0, cancelled: 0, confirmationRate: 0.3333 },
      }) } as Response;
    }));
    const c = new CreddaClient({ apiBase: 'https://api.test' });
    const r = await c.getActivationCampaign('camp_1', 'crd_live_k');
    expect(url).toBe('https://api.test/api/v1/activation/campaigns/camp_1');
    expect(init.headers.Authorization).toBe('Bearer crd_live_k');
    expect(r.funnel.confirmed).toBe(1);
    expect(r.funnel.confirmationRate).toBeCloseTo(0.3333, 4);
  });
});

describe('getScoreDelta', () => {
  it('GETs the delta endpoint with bearer auth and returns the typed explanation', async () => {
    let url = ''; let init: any = {};
    vi.stubGlobal('fetch', vi.fn(async (u: string, i: any) => {
      url = String(u); init = i;
      return { ok: true, status: 200, json: async () => ({
        userId: 'u1', available: true,
        from: { finalScore: 60, computedAt: '2026-07-01T00:00:00.000Z' },
        to:   { finalScore: 66, computedAt: '2026-07-18T00:00:00.000Z' },
        scoreDelta: 6, direction: 'up', confidenceDelta: 0.1, momentumDelta: 0.01,
        factors: [{ factor: 'OTR', before: 0.5, after: 0.7, delta: 0.2, improved: true }],
        topDriver: { factor: 'OTR', before: 0.5, after: 0.7, delta: 0.2, improved: true },
        formulaVersion: '3.0',
      }) } as Response;
    }));
    const c = new CreddaClient({ apiBase: 'https://api.test' });
    const r = await c.getScoreDelta('u1', 'crd_live_k');
    expect(url).toBe('https://api.test/api/v1/users/u1/score/delta');
    expect(init.headers.Authorization).toBe('Bearer crd_live_k');
    expect(r.available).toBe(true);
    expect(r.direction).toBe('up');
    expect(r.topDriver?.factor).toBe('OTR');
    expect(r.topDriver?.improved).toBe(true);
  });

  it('handles the not-yet-available shape (fewer than two computations)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ userId: 'u1', available: false }) } as Response)));
    const r = await new CreddaClient({ apiBase: 'https://api.test' }).getScoreDelta('u1', 'k');
    expect(r.available).toBe(false);
    expect(r.topDriver).toBeUndefined();
  });

  it('throws CreddaError on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ error: 'x', code: 'NOT_FOUND' }) } as Response)));
    await expect(new CreddaClient({ apiBase: 'https://api.test' }).getScoreDelta('u', 'k')).rejects.toBeInstanceOf(CreddaError);
  });
});

describe('getScoreComponents', () => {
  it('GETs the components endpoint with bearer auth and returns the typed breakdown', async () => {
    let url = ''; let init: any = {};
    vi.stubGlobal('fetch', vi.fn(async (u: string, i: any) => {
      url = String(u); init = i;
      return { ok: true, status: 200, json: async () => ({
        userId: 'u1', available: true, finalScore: 72, scoreBand: 'Good',
        components: [
          { key: 'reliability', label: 'Reliability', score: 80, weight: 0.4, description: 'Strong.' },
          { key: 'momentum', label: 'Momentum', score: 50, weight: null, description: 'Neutral.' },
        ],
        computedAt: '2026-07-18T00:00:00.000Z', formulaVersion: '3.0',
      }) } as Response;
    }));
    const c = new CreddaClient({ apiBase: 'https://api.test' });
    const r = await c.getScoreComponents('u1', 'crd_live_k');
    expect(url).toBe('https://api.test/api/v1/users/u1/score/components');
    expect(init.headers.Authorization).toBe('Bearer crd_live_k');
    expect(r.available).toBe(true);
    expect(r.components).toHaveLength(2);
    expect(r.components[0].key).toBe('reliability');
    expect(r.components[0].weight).toBe(0.4);
    expect(r.components[1].weight).toBeNull();
  });

  it('handles the not-yet-available shape (no score computed yet)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ userId: 'u1', available: false, components: [] }) } as Response)));
    const r = await new CreddaClient({ apiBase: 'https://api.test' }).getScoreComponents('u1', 'k');
    expect(r.available).toBe(false);
    expect(r.components).toEqual([]);
  });

  it('throws CreddaError on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ error: 'x', code: 'NOT_FOUND' }) } as Response)));
    await expect(new CreddaClient({ apiBase: 'https://api.test' }).getScoreComponents('u', 'k')).rejects.toBeInstanceOf(CreddaError);
  });
});

describe('getTimeline', () => {
  it('GETs the timeline endpoint with query params + bearer auth and returns the typed feed', async () => {
    let url = ''; let init: any = {};
    vi.stubGlobal('fetch', vi.fn(async (u: string, i: any) => {
      url = String(u); init = i;
      return { ok: true, status: 200, json: async () => ({
        data: [
          { type: 'score_change', id: 's1', occurredAt: '2026-07-18T00:00:00.000Z', finalScore: 70, scoreBand: 'Good', scoreDelta: 6, direction: 'up', topDriver: { factor: 'OTR', before: 0.5, after: 0.7, delta: 0.2, improved: true } },
          { type: 'event', id: 'e1', occurredAt: '2026-07-17T00:00:00.000Z', eventType: 'TRANSACTION_COMPLETED', platformName: 'Upwork', isVerified: true, stakeLevel: 'MEDIUM', daysLate: null, dispute: null },
        ],
        count: 2, nextCursor: '2026-07-17T00:00:00.000Z',
      }) } as Response;
    }));
    const c = new CreddaClient({ apiBase: 'https://api.test' });
    const r = await c.getTimeline('u1', 'crd_live_k', { limit: 2, cursor: '2026-07-19T00:00:00.000Z' });
    expect(url).toBe('https://api.test/api/v1/users/u1/timeline?limit=2&cursor=2026-07-19T00%3A00%3A00.000Z');
    expect(init.headers.Authorization).toBe('Bearer crd_live_k');
    expect(r.count).toBe(2);
    expect(r.data[0].type).toBe('score_change');
    expect(r.nextCursor).toBe('2026-07-17T00:00:00.000Z');
  });

  it('omits the query string when no options are given', async () => {
    let url = '';
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      url = String(u);
      return { ok: true, status: 200, json: async () => ({ data: [], count: 0, nextCursor: null }) } as Response;
    }));
    await new CreddaClient({ apiBase: 'https://api.test' }).getTimeline('u1', 'k');
    expect(url).toBe('https://api.test/api/v1/users/u1/timeline');
  });

  it('throws CreddaError on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ error: 'x', code: 'NOT_FOUND' }) } as Response)));
    await expect(new CreddaClient({ apiBase: 'https://api.test' }).getTimeline('u', 'k')).rejects.toBeInstanceOf(CreddaError);
  });
});

describe('getActivity', () => {
  it('GETs /activity with filters + bearer auth and returns the typed page', async () => {
    let url = ''; let init: any = {};
    vi.stubGlobal('fetch', vi.fn(async (u: string, i: any) => {
      url = String(u); init = i;
      return { ok: true, status: 200, json: async () => ({
        data: [{ id: 'a1', action: 'EVENT_CREATED', payload: { platformId: 'p1', eventId: 'e1' }, createdAt: '2026-07-22T00:00:00.000Z' }],
        nextCursor: 'a1',
      }) } as Response;
    }));
    const c = new CreddaClient({ apiBase: 'https://api.test' });
    const r = await c.getActivity('crd_live_k', { limit: 1, action: 'EVENT_CREATED', from: '2026-07-01' });
    expect(url).toBe('https://api.test/api/v1/activity?limit=1&action=EVENT_CREATED&from=2026-07-01');
    expect(init.headers.Authorization).toBe('Bearer crd_live_k');
    expect(r.data[0].action).toBe('EVENT_CREATED');
    expect(r.nextCursor).toBe('a1');
  });

  it('omits the query string when no options are given', async () => {
    let url = '';
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      url = String(u);
      return { ok: true, status: 200, json: async () => ({ data: [], nextCursor: null }) } as Response;
    }));
    await new CreddaClient({ apiBase: 'https://api.test' }).getActivity('k');
    expect(url).toBe('https://api.test/api/v1/activity');
  });
});

describe('listUsers (your book of subjects)', () => {
  it('GETs /users with the closed filter set + bearer auth and returns the typed page', async () => {
    let url = ''; let init: any = {};
    vi.stubGlobal('fetch', vi.fn(async (u: string, i: any) => {
      url = String(u); init = i;
      return { ok: true, status: 200, json: async () => ({
        data: [{
          externalId: 'user-42', subjectType: 'PERSON', finalScore: 72, scoreBand: 'Good',
          scoreFrozen: false, verificationDepth: 0.8, eventCount: 14, verifiedEventCount: 11,
          lastActivityAt: '2026-07-20T12:00:00.000Z', registeredAt: '2026-01-04T09:00:00.000Z',
          computedAt: '2026-07-20T12:00:05.000Z',
        }],
        count: 1,
        nextCursor: 'user-42',
      }) } as Response;
    }));
    const c = new CreddaClient({ apiBase: 'https://api.test' });
    const r = await c.listUsers('crd_live_k', { band: 'Good', minVerifiedEvents: 5, sort: 'score', order: 'desc', limit: 25 });
    expect(url).toBe('https://api.test/api/v1/users?band=Good&minVerifiedEvents=5&sort=score&order=desc&limit=25');
    expect(init.headers.Authorization).toBe('Bearer crd_live_k');
    expect(r.data[0].externalId).toBe('user-42');
    expect(r.data[0].verifiedEventCount).toBe(11);
    expect(r.nextCursor).toBe('user-42');
  });

  it('omits the query string when no filters are given', async () => {
    let url = '';
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      url = String(u);
      return { ok: true, status: 200, json: async () => ({ data: [], count: 0, nextCursor: null }) } as Response;
    }));
    await new CreddaClient({ apiBase: 'https://api.test' }).listUsers('k');
    expect(url).toBe('https://api.test/api/v1/users');
  });

  it('serialises the boolean/date filters, including the false cases', async () => {
    let url = '';
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      url = String(u);
      return { ok: true, status: 200, json: async () => ({ data: [], count: 0, nextCursor: null }) } as Response;
    }));
    await new CreddaClient({ apiBase: 'https://api.test' }).listUsers('k', {
      hasScore: false, scoreFrozen: false, subjectType: 'ORGANIZATION',
      registeredSince: '2026-01-01', registeredBefore: '2026-07-01',
    });
    // `false` must reach the wire — it is a filter value, not an absent one.
    expect(url).toContain('hasScore=false');
    expect(url).toContain('scoreFrozen=false');
    expect(url).toContain('subjectType=ORGANIZATION');
    expect(url).toContain('registeredSince=2026-01-01');
    expect(url).toContain('registeredBefore=2026-07-01');
  });

  it('accepts a null score for a subject that has not been scored yet', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({
        data: [{
          externalId: 'brand-new', subjectType: 'PERSON', finalScore: null, scoreBand: null,
          scoreFrozen: false, verificationDepth: null, eventCount: 1, verifiedEventCount: 0,
          lastActivityAt: '2026-07-24T12:00:00.000Z', registeredAt: '2026-07-24T12:00:00.000Z',
          computedAt: null,
        }],
        count: 1, nextCursor: null,
      }),
    } as Response)));
    const r = await new CreddaClient({ apiBase: 'https://api.test' }).listUsers('k');
    expect(r.data[0].finalScore).toBeNull();
    expect(r.data[0].scoreBand).toBeNull();
  });
});

describe('getBookSummary (size a segment without paging it)', () => {
  it('GETs /users/summary with the same closed filter set', async () => {
    let url = ''; let init: any = {};
    vi.stubGlobal('fetch', vi.fn(async (u: string, i: any) => {
      url = String(u); init = i;
      return { ok: true, status: 200, json: async () => ({
        formulaVersion: '5.3', matched: 1284, scored: 1190, unscored: 94,
        central: { median: 61.4, mean: 58.77 },
        bandDistribution: [{ band: 'Excellent', minScore: 80, count: 214, share: 17.98 }],
      }) } as Response;
    }));
    const c = new CreddaClient({ apiBase: 'https://api.test' });
    const r = await c.getBookSummary('crd_live_k', { hasVerifiedEvents: true, subjectType: 'ORGANIZATION' });
    expect(url).toBe('https://api.test/api/v1/users/summary?subjectType=ORGANIZATION&hasVerifiedEvents=true');
    expect(init.headers.Authorization).toBe('Bearer crd_live_k');
    expect(r.matched).toBe(1284);
    expect(r.central!.median).toBe(61.4);
  });

  it('omits the query string when no filters are given', async () => {
    let url = '';
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      url = String(u);
      return { ok: true, status: 200, json: async () => ({ formulaVersion: '5.3', matched: 0, scored: 0, unscored: 0, central: { median: null, mean: null }, bandDistribution: [] }) } as Response;
    }));
    await new CreddaClient({ apiBase: 'https://api.test' }).getBookSummary('k');
    expect(url).toBe('https://api.test/api/v1/users/summary');
  });

  it('surfaces a null central tendency rather than coercing it to 0', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({
        formulaVersion: '5.3', matched: 3, scored: 0, unscored: 3,
        central: { median: null, mean: null },
        bandDistribution: [{ band: 'Excellent', minScore: 80, count: 0, share: null }],
      }),
    } as Response)));
    const r = await new CreddaClient({ apiBase: 'https://api.test' }).getBookSummary('k');
    expect(r.central!.median).toBeNull();
    expect(r.bandDistribution![0].share).toBeNull();
  });
});

describe('exportEvents', () => {
  it('GETs /events/export with range + cursor and returns the typed page', async () => {
    let url = ''; let init: any = {};
    vi.stubGlobal('fetch', vi.fn(async (u: string, i: any) => {
      url = String(u); init = i;
      return { ok: true, status: 200, json: async () => ({
        data: [{
          id: 'e1', userId: 'u-42', eventType: 'CONTRACT_FULFILLED', stakeLevel: 'MEDIUM',
          isVerified: true, autoImported: false, transactionValue: 250, dueDate: null,
          completedAt: null, daysLate: null, createdAt: '2026-07-22T00:00:00.000Z', metadata: {},
        }],
        nextCursor: 'e1',
      }) } as Response;
    }));
    const c = new CreddaClient({ apiBase: 'https://api.test' });
    const r = await c.exportEvents('crd_live_k', { from: '2026-07-01', to: '2026-07-22', cursor: 'e0' });
    expect(url).toBe('https://api.test/api/v1/events/export?cursor=e0&from=2026-07-01&to=2026-07-22');
    expect(init.headers.Authorization).toBe('Bearer crd_live_k');
    expect(r.data[0].userId).toBe('u-42');
    expect(r.data[0].autoImported).toBe(false);
    expect(r.nextCursor).toBe('e1');
  });

  it('throws CreddaError on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: 'x', code: 'EXPORT_RANGE_INVALID' }) } as Response)));
    await expect(new CreddaClient({ apiBase: 'https://api.test' }).exportEvents('k', { from: 'bad' })).rejects.toBeInstanceOf(CreddaError);
  });
});

describe('getScores', () => {
  it('POSTs the id batch with bearer auth and returns the typed payload (order + not_found preserved)', async () => {
    let init: any = {}; let url = '';
    vi.stubGlobal('fetch', vi.fn(async (u: string, i: any) => {
      url = String(u); init = i;
      return { ok: true, status: 200, json: async () => ({
        scores: [
          { userId: 'u1', finalScore: 82, scoreBand: 'Excellent', scoreFrozen: false },
          { userId: 'u2', error: 'not_found' },
        ],
        count: 2, formulaVersion: '3.0',
      }) } as Response;
    }));
    const c = new CreddaClient({ apiBase: 'https://api.test' });
    const r = await c.getScores(['u1', 'u2'], 'crd_live_k');
    expect(url).toBe('https://api.test/api/v1/users/scores');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer crd_live_k');
    expect(JSON.parse(init.body).userIds).toEqual(['u1', 'u2']);
    expect(r.count).toBe(2);
    const first = r.scores[0];
    expect('finalScore' in first && first.finalScore).toBe(82);
    expect('error' in r.scores[1] && r.scores[1].error).toBe('not_found');
  });

  it('throws CreddaError on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: 'x', code: 'BAD_REQUEST' }) } as Response)));
    await expect(new CreddaClient({ apiBase: 'https://api.test' }).getScores(['u'], 'k')).rejects.toBeInstanceOf(CreddaError);
  });
});

describe('projectScore', () => {
  it('POSTs the hypothetical events with bearer auth and returns the typed projection', async () => {
    let init: any = {}; let url = '';
    vi.stubGlobal('fetch', vi.fn(async (u: string, i: any) => {
      url = String(u); init = i;
      return { ok: true, status: 200, json: async () => ({
        userId: 'u1', delta: 2.5,
        current: { finalScore: 70, scoreBand: 'Good' },
        projected: { finalScore: 72.5, scoreBand: 'Good' },
        bandChanged: false, formulaVersion: '3.0',
      }) } as Response;
    }));
    const c = new CreddaClient({ apiBase: 'https://api.test' });
    const r = await c.projectScore('u1', [{ eventType: 'CONTRACT_FULFILLED', daysLate: 0 }], 'crd_live_k');
    expect(url).toBe('https://api.test/api/v1/users/u1/score/project');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer crd_live_k');
    expect(JSON.parse(init.body).events[0].eventType).toBe('CONTRACT_FULFILLED');
    expect(r.delta).toBe(2.5);
    expect(r.projected.finalScore).toBe(72.5);
    expect(r.bandChanged).toBe(false);
  });

  it('url-encodes the user id', async () => {
    let url = '';
    vi.stubGlobal('fetch', vi.fn(async (u: string) => { url = String(u); return { ok: true, status: 200, json: async () => ({}) } as Response; }));
    await new CreddaClient({ apiBase: 'https://api.test' }).projectScore('a/b', [{ eventType: 'REVIEW_VERIFIED' }], 'k');
    expect(url).toBe('https://api.test/api/v1/users/a%2Fb/score/project');
  });

  it('throws CreddaError on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: 'x', code: 'BAD_REQUEST' }) } as Response)));
    await expect(new CreddaClient({ apiBase: 'https://api.test' }).projectScore('u', [{ eventType: 'REVIEW_VERIFIED' }], 'k')).rejects.toBeInstanceOf(CreddaError);
  });
});

describe('reportEvent', () => {
  it('POSTs with body, bearer auth, and an optional idempotency key', async () => {
    let init: any = {}; let url = '';
    vi.stubGlobal('fetch', vi.fn(async (u: string, i: any) => {
      url = String(u); init = i;
      return { ok: true, status: 201, json: async () => ({ event: { id: 'e1' }, userId: 'u1' }) } as Response;
    }));
    const c = new CreddaClient({ apiBase: 'https://api.test' });
    const r = await c.reportEvent({ userId: 'u1', eventType: 'REVIEW_VERIFIED' }, 'crd_live_k', { idempotencyKey: 'op-1' });
    expect(url).toBe('https://api.test/api/v1/events');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer crd_live_k');
    expect(init.headers['Idempotency-Key']).toBe('op-1');
    expect(JSON.parse(init.body).userId).toBe('u1');
    expect(r.event.id).toBe('e1');
  });

  it('throws CreddaError on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ error: 'x', code: 'SCOPE_INSUFFICIENT' }) } as Response)));
    await expect(new CreddaClient({ apiBase: 'https://api.test' }).reportEvent({ userId: 'u', eventType: 'REVIEW_VERIFIED' }, 'k')).rejects.toBeInstanceOf(CreddaError);
  });
});

describe('share token lifecycle', () => {
  it('mints via POST and returns the embed snippet', async () => {
    let url = ''; let init: any = {};
    vi.stubGlobal('fetch', vi.fn(async (u: string, i: any) => {
      url = String(u); init = i;
      return { ok: true, status: 201, json: async () => ({ token: 'crd_share_x', verifyUrl: 'https://v', embedSnippet: '<div>', widgetSrc: 'https://w' }) } as Response;
    }));
    const r = await new CreddaClient({ apiBase: 'https://api.test' }).mintShareToken('u1', 'k');
    expect(url).toBe('https://api.test/api/v1/users/u1/share-token');
    expect(init.method).toBe('POST');
    expect(r.token).toBe('crd_share_x');
  });

  it('revokes via DELETE without parsing a 204 body', async () => {
    let method = '';
    vi.stubGlobal('fetch', vi.fn(async (_u: string, i: any) => {
      method = i.method;
      return { ok: true, status: 204, json: async () => { throw new Error('no body'); } } as unknown as Response;
    }));
    await new CreddaClient({ apiBase: 'https://api.test' }).revokeShareToken('u1', 'k');
    expect(method).toBe('DELETE');
  });

  it('throws CreddaError when revoke fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ error: 'nope' }) } as Response)));
    await expect(new CreddaClient({ apiBase: 'https://api.test' }).revokeShareToken('u', 'k')).rejects.toBeInstanceOf(CreddaError);
  });
});

describe('resolveDispute', () => {
  it('PATCHes the outcome with bearer auth', async () => {
    let url = ''; let init: any = {};
    vi.stubGlobal('fetch', vi.fn(async (u: string, i: any) => {
      url = String(u); init = i;
      return { ok: true, status: 200, json: async () => ({ dispute: { id: 'd1', status: 'RESOLVED_FOR_USER' } }) } as Response;
    }));
    const r = await new CreddaClient({ apiBase: 'https://api.test' }).resolveDispute('d1', 'FOR_USER', 'k');
    expect(url).toBe('https://api.test/api/v1/disputes/d1/resolve');
    expect(init.method).toBe('PATCH');
    expect(init.headers.Authorization).toBe('Bearer k');
    expect(JSON.parse(init.body).outcome).toBe('FOR_USER');
    expect((r.dispute as { id: string }).id).toBe('d1');
  });

  it('throws CreddaError on conflict (already resolved)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 409, json: async () => ({ error: 'already resolved', code: 'CONFLICT' }) } as Response)));
    await expect(new CreddaClient({ apiBase: 'https://api.test' }).resolveDispute('d1', 'AGAINST_USER', 'k')).rejects.toBeInstanceOf(CreddaError);
  });
});

describe('webhook management', () => {
  it('creates a webhook and returns the one-time secret', async () => {
    let url = ''; let init: any = {};
    vi.stubGlobal('fetch', vi.fn(async (u: string, i: any) => {
      url = String(u); init = i;
      return { ok: true, status: 201, json: async () => ({ webhook: { id: 'wh1' }, secret: 'whsec_x' }) } as Response;
    }));
    const r = await new CreddaClient({ apiBase: 'https://api.test' }).createWebhook({ url: 'https://h', events: ['dispute.resolved'] }, 'k');
    expect(url).toBe('https://api.test/api/v1/webhooks');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body).events).toEqual(['dispute.resolved']);
    expect(r.secret).toBe('whsec_x');
  });

  it('lists webhooks and deletes via DELETE', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 'wh1' }] }) } as Response)));
    const list = await new CreddaClient({ apiBase: 'https://api.test' }).listWebhooks('k');
    expect(list.data[0].id).toBe('wh1');

    let method = '';
    vi.stubGlobal('fetch', vi.fn(async (_u: string, i: any) => { method = i.method; return { ok: true, status: 204, json: async () => { throw new Error('no body'); } } as unknown as Response; }));
    await new CreddaClient({ apiBase: 'https://api.test' }).deleteWebhook('wh1', 'k');
    expect(method).toBe('DELETE');
  });

  it('updates (PATCH), tests (POST /test), and reads deliveries (GET)', async () => {
    let url = ''; let method = '';
    vi.stubGlobal('fetch', vi.fn(async (u: string, i: any) => { url = String(u); method = i.method; return { ok: true, status: 200, json: async () => ({ webhook: { id: 'wh1', isActive: false } }) } as Response; }));
    const upd = await new CreddaClient({ apiBase: 'https://api.test' }).updateWebhook('wh1', { isActive: false }, 'k');
    expect(method).toBe('PATCH'); expect(url).toBe('https://api.test/api/v1/webhooks/wh1');
    expect(upd.webhook.isActive).toBe(false);

    vi.stubGlobal('fetch', vi.fn(async (u: string, i: any) => { url = String(u); method = i.method; return { ok: true, status: 200, json: async () => ({ delivered: true, statusCode: 200, error: null, durationMs: 42 }) } as Response; }));
    const t = await new CreddaClient({ apiBase: 'https://api.test' }).testWebhook('wh1', 'k');
    expect(method).toBe('POST'); expect(url).toBe('https://api.test/api/v1/webhooks/wh1/test'); expect(t.delivered).toBe(true);

    vi.stubGlobal('fetch', vi.fn(async (u: string) => { url = String(u); return { ok: true, status: 200, json: async () => ({ data: [{ id: 'dlv1', success: true }] }) } as Response; }));
    const d = await new CreddaClient({ apiBase: 'https://api.test' }).getWebhookDeliveries('wh1', 'k', 10);
    expect(url).toBe('https://api.test/api/v1/webhooks/wh1/deliveries?limit=10'); expect(d.data[0].id).toBe('dlv1');
  });

  it('reads recent events across all endpoints, filtered by event type', async () => {
    let url = '';
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      url = String(u);
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 'evt_example_score.updated', type: 'score.updated', isExample: true, delivery: null }], nextCursor: null, source: 'examples' }) } as Response;
    }));
    const r = await new CreddaClient({ apiBase: 'https://api.test' }).getRecentWebhookEvents('k', {
      limit: 5,
      eventType: ['score.updated', 'score.band_changed'],
    });
    expect(url).toBe('https://api.test/api/v1/webhooks/deliveries?limit=5&eventType=score.updated%2Cscore.band_changed');
    // The catalog fallback must be self-identifying, never mistaken for a real delivery.
    expect(r.source).toBe('examples');
    expect(r.data[0].isExample).toBe(true);
    expect(r.data[0].delivery).toBeNull();
  });
});

describe('score monitors', () => {
  it('creates a monitor (POST /monitors) with the externalId + conditions', async () => {
    let url = ''; let init: any = {};
    vi.stubGlobal('fetch', vi.fn(async (u: string, i: any) => {
      url = String(u); init = i;
      return { ok: true, status: 201, json: async () => ({ monitor: { id: 'mon1', userId: 'u1', belowScore: 40, aboveScore: null, onBandChange: false, isActive: true } }) } as Response;
    }));
    const r = await new CreddaClient({ apiBase: 'https://api.test' }).createMonitor({ userId: 'u1', belowScore: 40 }, 'k');
    expect(url).toBe('https://api.test/api/v1/monitors');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer k');
    expect(JSON.parse(init.body)).toEqual({ userId: 'u1', belowScore: 40 });
    expect(r.monitor.id).toBe('mon1');
  });

  it('lists monitors with cursor pagination and fetches one', async () => {
    let url = '';
    vi.stubGlobal('fetch', vi.fn(async (u: string) => { url = String(u); return { ok: true, status: 200, json: async () => ({ data: [{ id: 'mon1' }], nextCursor: null }) } as Response; }));
    const list = await new CreddaClient({ apiBase: 'https://api.test' }).listMonitors('k', { limit: 10, cursor: 'mon0' });
    expect(url).toBe('https://api.test/api/v1/monitors?limit=10&cursor=mon0');
    expect(list.data[0].id).toBe('mon1');
    expect(list.nextCursor).toBeNull();

    vi.stubGlobal('fetch', vi.fn(async (u: string) => { url = String(u); return { ok: true, status: 200, json: async () => ({ monitor: { id: 'mon1' } }) } as Response; }));
    const one = await new CreddaClient({ apiBase: 'https://api.test' }).getMonitor('mon1', 'k');
    expect(url).toBe('https://api.test/api/v1/monitors/mon1');
    expect(one.monitor.id).toBe('mon1');
  });

  it('updates (PATCH, null clears a threshold) and deletes (DELETE)', async () => {
    let url = ''; let init: any = {};
    vi.stubGlobal('fetch', vi.fn(async (u: string, i: any) => { url = String(u); init = i; return { ok: true, status: 200, json: async () => ({ monitor: { id: 'mon1', belowScore: null, onBandChange: true } }) } as Response; }));
    const upd = await new CreddaClient({ apiBase: 'https://api.test' }).updateMonitor('mon1', { belowScore: null, onBandChange: true }, 'k');
    expect(init.method).toBe('PATCH');
    expect(url).toBe('https://api.test/api/v1/monitors/mon1');
    expect(JSON.parse(init.body)).toEqual({ belowScore: null, onBandChange: true });
    expect(upd.monitor.onBandChange).toBe(true);

    let method = '';
    vi.stubGlobal('fetch', vi.fn(async (_u: string, i: any) => { method = i.method; return { ok: true, status: 204, json: async () => { throw new Error('no body'); } } as unknown as Response; }));
    await new CreddaClient({ apiBase: 'https://api.test' }).deleteMonitor('mon1', 'k');
    expect(method).toBe('DELETE');
  });
});

describe('bulk screenings', () => {
  it('submits a screening (POST /screenings) with the id roster', async () => {
    let url = ''; let init: any = {};
    vi.stubGlobal('fetch', vi.fn(async (u: string, i: any) => {
      url = String(u); init = i;
      return { ok: true, status: 202, json: async () => ({ screening: { id: 'scr1', status: 'COMPLETED', totalCount: 2, foundCount: 1 } }) } as Response;
    }));
    const r = await new CreddaClient({ apiBase: 'https://api.test' }).createScreening(['u1', 'u2'], 'k');
    expect(url).toBe('https://api.test/api/v1/screenings');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer k');
    expect(JSON.parse(init.body)).toEqual({ userIds: ['u1', 'u2'] });
    expect(r.screening.id).toBe('scr1');
    expect(r.screening.status).toBe('COMPLETED');
  });

  it('lists screenings with cursor pagination and fetches one', async () => {
    let url = '';
    vi.stubGlobal('fetch', vi.fn(async (u: string) => { url = String(u); return { ok: true, status: 200, json: async () => ({ data: [{ id: 'scr1', status: 'RUNNING' }], nextCursor: null }) } as Response; }));
    const list = await new CreddaClient({ apiBase: 'https://api.test' }).listScreenings('k', { limit: 10, cursor: 'scr0' });
    expect(url).toBe('https://api.test/api/v1/screenings?limit=10&cursor=scr0');
    expect(list.data[0].id).toBe('scr1');
    expect(list.nextCursor).toBeNull();

    vi.stubGlobal('fetch', vi.fn(async (u: string) => { url = String(u); return { ok: true, status: 200, json: async () => ({ screening: { id: 'scr1', status: 'QUEUED' } }) } as Response; }));
    const one = await new CreddaClient({ apiBase: 'https://api.test' }).getScreening('scr1', 'k');
    expect(url).toBe('https://api.test/api/v1/screenings/scr1');
    expect(one.screening.status).toBe('QUEUED');
  });

  it('fetches results when COMPLETED and surfaces the 409 while pending', async () => {
    let url = '';
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      url = String(u);
      return { ok: true, status: 200, json: async () => ({ screening: { id: 'scr1', status: 'COMPLETED' }, results: [{ externalId: 'u1', found: true, score: 72, band: 'Good' }, { externalId: 'ghost', found: false }], count: 2 }) } as Response;
    }));
    const res = await new CreddaClient({ apiBase: 'https://api.test' }).getScreeningResults('scr1', 'k');
    expect(url).toBe('https://api.test/api/v1/screenings/scr1/results');
    expect(res.count).toBe(2);
    expect(res.results[0]).toMatchObject({ externalId: 'u1', found: true, score: 72 });
    expect(res.results[1]).toEqual({ externalId: 'ghost', found: false });

    stub(409, { error: 'Screening is still RUNNING', code: 'SCREENING_NOT_COMPLETED' });
    await expect(
      new CreddaClient({ apiBase: 'https://api.test' }).getScreeningResults('scr1', 'k'),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('data ingress — field-mapping ingest', () => {
  const mapping = {
    userId: 'worker.id',
    eventType: { path: 'status', values: { done: 'CONTRACT_FULFILLED' } },
    transactionValue: { path: 'amount_cents', transform: 'cents_to_units' as const },
    verifiedBy: 'client.email',
    isVerified: { const: true },
  };

  it("posts records in the caller's own shape alongside an inline mapping", async () => {
    let url = ''; let init: any = {};
    vi.stubGlobal('fetch', vi.fn(async (u: string, i: any) => {
      url = String(u); init = i;
      return { ok: true, status: 200, json: async () => ({ total: 1, created: 1, duplicate: 0, failed: 0, results: [{ index: 0, userId: 'w_1', status: 'created', eventId: 'evt_1' }] }) } as Response;
    }));
    const r = await new CreddaClient({ apiBase: BASE }).ingest(
      { mapping, records: [{ worker: { id: 'w_1' }, status: 'done', amount_cents: 12500, client: { email: 'ops@acme.test' } }] },
      'k',
    );
    expect(url).toBe('https://api.test/api/v1/ingest');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer k');
    expect(JSON.parse(init.body).mapping.userId).toBe('worker.id');
    expect(r.created).toBe(1);
    expect(r.results[0]).toMatchObject({ index: 0, status: 'created', eventId: 'evt_1' });
  });

  it('surfaces per-record failures and isVerified-downgrade warnings', async () => {
    stub(200, {
      total: 2, created: 1, duplicate: 0, failed: 1,
      results: [
        { index: 0, userId: 'w_1', status: 'created', eventId: 'evt_1', warnings: ['isVerified downgraded to false: no counterparty evidence.'] },
        { index: 1, status: 'failed', error: 'eventType: Required' },
      ],
    });
    const r = await new CreddaClient({ apiBase: BASE }).ingest({ mappingId: 'map_1', records: [{}, {}] }, 'k');
    expect(r.failed).toBe(1);
    expect(r.results[0].warnings?.[0]).toMatch(/isVerified downgraded/);
    expect(r.results[1]).toMatchObject({ index: 1, status: 'failed' });
  });

  it('creates, lists, fetches and deletes stored mappings', async () => {
    let url = ''; let init: any = {};
    vi.stubGlobal('fetch', vi.fn(async (u: string, i: any) => {
      url = String(u); init = i;
      return { ok: true, status: 201, json: async () => ({ mapping: { id: 'map_1', name: 'orders', description: null, mapping, createdAt: 'x', updatedAt: 'x' } }) } as Response;
    }));
    const created = await new CreddaClient({ apiBase: BASE }).createMapping({ name: 'orders', mapping }, 'k');
    expect(url).toBe('https://api.test/api/v1/ingest/mappings');
    expect(init.method).toBe('POST');
    expect(created.mapping.id).toBe('map_1');

    stub(200, { data: [{ id: 'map_1', name: 'orders' }], nextCursor: null }, (u) => { url = u; });
    const list = await new CreddaClient({ apiBase: BASE }).listMappings('k', { limit: 5 });
    expect(url).toBe('https://api.test/api/v1/ingest/mappings?limit=5');
    expect(list.data[0].name).toBe('orders');

    stub(200, { mapping: { id: 'map_1', name: 'orders' } }, (u) => { url = u; });
    await new CreddaClient({ apiBase: BASE }).getMapping('map_1', 'k');
    expect(url).toBe('https://api.test/api/v1/ingest/mappings/map_1');

    let method = '';
    vi.stubGlobal('fetch', vi.fn(async (u: string, i: any) => { url = String(u); method = i.method; return { ok: true, status: 204, json: async () => { throw new Error('no body'); } } as unknown as Response; }));
    await new CreddaClient({ apiBase: BASE }).deleteMapping('map_1', 'k');
    expect(method).toBe('DELETE');
    expect(url).toBe('https://api.test/api/v1/ingest/mappings/map_1');
  });
});

describe('data ingress — historical CSV import', () => {
  it('submits a CSV backfill and reads back status + counts', async () => {
    let url = ''; let init: any = {};
    vi.stubGlobal('fetch', vi.fn(async (u: string, i: any) => {
      url = String(u); init = i;
      return { ok: true, status: 202, json: async () => ({ import: { id: 'imp_1', status: 'COMPLETED', totalRows: 3, createdCount: 2, skippedCount: 0, failedCount: 1 } }) } as Response;
    }));
    const r = await new CreddaClient({ apiBase: BASE }).createImport(
      { csv: 'worker_id,outcome\nw_1,delivered\n', mappingId: 'map_1' },
      'k',
    );
    expect(url).toBe('https://api.test/api/v1/imports');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body).mappingId).toBe('map_1');
    expect(r.import).toMatchObject({ id: 'imp_1', status: 'COMPLETED', createdCount: 2, failedCount: 1 });

    stub(200, { data: [{ id: 'imp_1', status: 'RUNNING' }], nextCursor: 'imp_0' }, (u) => { url = u; });
    const list = await new CreddaClient({ apiBase: BASE }).listImports('k', { limit: 2, cursor: 'imp_9' });
    expect(url).toBe('https://api.test/api/v1/imports?limit=2&cursor=imp_9');
    expect(list.nextCursor).toBe('imp_0');

    stub(200, { import: { id: 'imp_1', status: 'QUEUED' } }, (u) => { url = u; });
    const one = await new CreddaClient({ apiBase: BASE }).getImport('imp_1', 'k');
    expect(url).toBe('https://api.test/api/v1/imports/imp_1');
    expect(one.import.status).toBe('QUEUED');
  });

  it('fetches per-row errors so a corrected file can be re-uploaded', async () => {
    let url = '';
    stub(200, {
      import: { id: 'imp_1', status: 'COMPLETED', failedCount: 1 },
      errors: [{ row: 3, error: 'eventType: no mapping for source value "unknown"' }],
      errorCount: 1,
      warnings: [{ row: 2, warning: 'isVerified downgraded to false: no counterparty evidence.', userId: 'w_2' }],
      warningCount: 1,
      truncated: false,
    }, (u) => { url = u; });
    const r = await new CreddaClient({ apiBase: BASE }).getImportErrors('imp_1', 'k', { limit: 50, offset: 0 });
    expect(url).toBe('https://api.test/api/v1/imports/imp_1/errors?limit=50&offset=0');
    expect(r.errors[0].row).toBe(3);
    expect(r.warnings[0].warning).toMatch(/downgraded/);
    expect(r.truncated).toBe(false);
  });

  it('surfaces an honest 503 when the import queue is unavailable', async () => {
    stub(503, { error: 'Import queue unavailable', code: 'IMPORT_QUEUE_UNAVAILABLE' });
    await expect(
      new CreddaClient({ apiBase: BASE }).createImport({ csv: 'a\n1\n', mappingId: 'm' }, 'k'),
    ).rejects.toMatchObject({ status: 503 });
  });
});

/**
 * Records every fetch call so a test can assert on the LAST one (url, method,
 * headers, body) — the new surfaces care about auth presence/absence, not just
 * the path.
 */
function recordingStub(status: number, body: unknown) {
  const calls: Array<{ url: string; init: any }> = [];
  vi.stubGlobal('fetch', vi.fn(async (u: string, i: any) => {
    calls.push({ url: String(u), init: i ?? {} });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  }));
  return calls;
}

const CONFIRMATION = {
  id: 'cnf_1',
  subjectExternalId: 'worker_7',
  eventType: 'CONTRACT_FULFILLED',
  stakeLevel: 'MEDIUM',
  transactionValue: 1200,
  dueDate: '2026-07-20T00:00:00.000Z',
  completedAt: '2026-07-19T00:00:00.000Z',
  counterpartyRef: 'client_42',
  counterpartyName: 'Acme Ltd',
  description: 'Kitchen refit, delivered 19 July',
  returnUrl: 'https://acme.example/thanks',
  status: 'PENDING',
  expiresAt: '2026-08-06T00:00:00.000Z',
  resultingEventId: null,
  decidedAt: null,
  createdAt: '2026-07-23T00:00:00.000Z',
};

describe('confirmation requests — keyed half', () => {
  it('creates a request, sends the idempotency key, and returns the one-time token + all three delivery URLs', async () => {
    const calls = recordingStub(201, {
      confirmation: CONFIRMATION,
      confirmationToken: 'raw_token_abc',
      confirmUrl: `${BASE}/confirm/cnf_1?token=raw_token_abc`,
      previewUrl: `${BASE}/api/v1/confirmations/cnf_1/preview?token=raw_token_abc`,
      respondUrl: `${BASE}/api/v1/confirmations/cnf_1/respond`,
    });

    const r = await new CreddaClient({ apiBase: BASE }).createConfirmationRequest(
      {
        userId: 'worker_7',
        eventType: 'CONTRACT_FULFILLED',
        counterpartyRef: 'client_42',
        counterpartyName: 'Acme Ltd',
        description: 'Kitchen refit, delivered 19 July',
        returnUrl: 'https://acme.example/thanks',
        expiresInDays: 14,
      },
      'crd_live_k',
      { idempotencyKey: 'job-991-confirm' },
    );

    const { url, init } = calls[0];
    expect(url).toBe(`${BASE}/api/v1/confirmations`);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer crd_live_k');
    expect(init.headers['Idempotency-Key']).toBe('job-991-confirm');
    expect(JSON.parse(init.body)).toMatchObject({
      userId: 'worker_7',
      counterpartyRef: 'client_42',
      returnUrl: 'https://acme.example/thanks',
      expiresInDays: 14,
    });
    // The token is shown ONCE, and the hosted page is the zero-frontend path.
    expect(r.confirmationToken).toBe('raw_token_abc');
    expect(r.confirmUrl).toContain('/confirm/cnf_1');
    expect(r.previewUrl).toContain('/preview?token=');
    expect(r.respondUrl).toContain('/respond');
    // Creating a request writes NO event.
    expect(r.confirmation.resultingEventId).toBeNull();
    expect(r.confirmation.status).toBe('PENDING');
  });

  it('lists with a status filter + cursor, and reads one back', async () => {
    let calls = recordingStub(200, { data: [CONFIRMATION], nextCursor: 'cnf_0' });
    const list = await new CreddaClient({ apiBase: BASE }).listConfirmations('k', {
      status: 'PENDING', limit: 10, cursor: 'cnf_9',
    });
    expect(calls[0].url).toBe(`${BASE}/api/v1/confirmations?status=PENDING&limit=10&cursor=cnf_9`);
    expect(list.nextCursor).toBe('cnf_0');
    expect(list.data[0].counterpartyRef).toBe('client_42');

    calls = recordingStub(200, { confirmation: CONFIRMATION });
    const one = await new CreddaClient({ apiBase: BASE }).getConfirmation('cnf_1', 'k');
    expect(calls[0].url).toBe(`${BASE}/api/v1/confirmations/cnf_1`);
    expect(calls[0].init.headers.Authorization).toBe('Bearer k');
    expect(one.confirmation.id).toBe('cnf_1');
  });

  it('cancels a pending request, and surfaces 409 CONFIRMATION_NOT_PENDING once decided', async () => {
    const calls = recordingStub(200, {
      confirmation: { ...CONFIRMATION, status: 'CANCELLED', decidedAt: '2026-07-24T00:00:00.000Z' },
    });
    const r = await new CreddaClient({ apiBase: BASE }).cancelConfirmation('cnf_1', 'k');
    expect(calls[0].url).toBe(`${BASE}/api/v1/confirmations/cnf_1/cancel`);
    expect(calls[0].init.method).toBe('POST');
    expect(r.confirmation.status).toBe('CANCELLED');

    stub(409, { error: 'already confirmed', code: 'CONFIRMATION_NOT_PENDING' });
    await expect(
      new CreddaClient({ apiBase: BASE }).cancelConfirmation('cnf_1', 'k'),
    ).rejects.toMatchObject({ status: 409, code: 'CONFIRMATION_NOT_PENDING' });
  });

  it('bulk-creates a batch, carries the idempotency key, and returns partial-success results', async () => {
    const calls = recordingStub(200, {
      total: 2,
      created: 1,
      failed: 1,
      results: [
        { index: 0, ok: true, userId: 'worker_7', id: 'cnf_1', status: 'PENDING', confirmationToken: 'raw_1', confirmUrl: `${BASE}/confirm/cnf_1?token=raw_1` },
        { index: 1, ok: false, userId: 'worker_8', error: 'cannot confirm your own outcome', code: 'CONFIRMATION_SELF' },
      ],
    });
    const r = await new CreddaClient({ apiBase: BASE }).createConfirmationBatch(
      [
        { userId: 'worker_7', eventType: 'CONTRACT_FULFILLED', counterpartyRef: 'client_42' },
        { userId: 'worker_8', eventType: 'CONTRACT_FULFILLED', counterpartyRef: 'worker_8' },
      ],
      'crd_live_k',
      { idempotencyKey: 'book-warm-1' },
    );
    const { url, init } = calls[0];
    expect(url).toBe(`${BASE}/api/v1/confirmations/batch`);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer crd_live_k');
    expect(init.headers['Idempotency-Key']).toBe('book-warm-1');
    expect(JSON.parse(init.body).requests).toHaveLength(2);
    expect(r.created).toBe(1);
    expect(r.failed).toBe(1);
    // An ok item carries its one-time token; a failed one carries a code.
    expect(r.results[0].confirmationToken).toBe('raw_1');
    expect(r.results[1].code).toBe('CONFIRMATION_SELF');
  });
});

describe('confirmation requests — the KEYLESS counterparty half', () => {
  it('previews with only the token — no Authorization header is sent', async () => {
    const calls = recordingStub(200, {
      confirmation: {
        id: 'cnf_1',
        platform: 'Acme Marketplace',
        status: 'PENDING',
        eventType: 'CONTRACT_FULFILLED',
        stakeLevel: 'MEDIUM',
        transactionValue: 1200,
        dueDate: null,
        completedAt: null,
        counterpartyName: 'Acme Ltd',
        description: 'Kitchen refit, delivered 19 July',
        expiresAt: '2026-08-06T00:00:00.000Z',
      },
    });

    // No API key is passed at all — the counterparty holds a token, not a key.
    const r = await new CreddaClient({ apiBase: BASE }).previewConfirmation('cnf_1', 'raw token/abc');
    expect(calls[0].url).toBe(`${BASE}/api/v1/confirmations/cnf_1/preview?token=raw%20token%2Fabc`);
    expect(calls[0].init.headers).toBeUndefined();
    // PII-free: the raw subject id and the matching key are never disclosed.
    expect(r.confirmation).not.toHaveProperty('subjectExternalId');
    expect(r.confirmation).not.toHaveProperty('counterpartyRef');
    expect(r.confirmation.platform).toBe('Acme Marketplace');
  });

  it('responds with the raw token and NO Authorization header, returning the written event id', async () => {
    const calls = recordingStub(200, {
      status: 'CONFIRMED',
      confirmation: { ...CONFIRMATION, status: 'CONFIRMED', resultingEventId: 'ev_9' },
      eventId: 'ev_9',
    });

    const r = await new CreddaClient({ apiBase: BASE }).respondToConfirmation('cnf_1', 'raw_token_abc', 'confirm');
    expect(calls[0].url).toBe(`${BASE}/api/v1/confirmations/cnf_1/respond`);
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers['Content-Type']).toBe('application/json');
    // THE point of the keyless path: an API key is never required or sent.
    expect(calls[0].init.headers.Authorization).toBeUndefined();
    expect(JSON.parse(calls[0].init.body)).toEqual({ token: 'raw_token_abc', decision: 'confirm' });
    expect(r.status).toBe('CONFIRMED');
    expect(r.eventId).toBe('ev_9');
  });

  it('declines without writing anything', async () => {
    const calls = recordingStub(200, {
      status: 'DECLINED',
      confirmation: { ...CONFIRMATION, status: 'DECLINED' },
    });
    const r = await new CreddaClient({ apiBase: BASE }).respondToConfirmation('cnf_1', 'tok', 'decline');
    expect(JSON.parse(calls[0].init.body).decision).toBe('decline');
    expect(r.eventId).toBeUndefined();
    expect(r.confirmation.resultingEventId).toBeNull();
  });

  it('never retries a respond — the token is single-use, so a repeat can only 409', async () => {
    let attempts = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      attempts++;
      return { ok: false, status: 503, json: async () => ({ error: 'blip' }) } as Response;
    }));
    const client = new CreddaClient({ apiBase: BASE, retries: 3, retryBaseMs: 1 });
    await expect(client.respondToConfirmation('cnf_1', 'tok', 'confirm')).rejects.toBeInstanceOf(CreddaError);
    expect(attempts).toBe(1);
  });

  it('surfaces an invalid token as 401 CONFIRMATION_TOKEN_INVALID', async () => {
    stub(401, { error: 'Invalid confirmation token', code: 'CONFIRMATION_TOKEN_INVALID' });
    await expect(
      new CreddaClient({ apiBase: BASE }).respondToConfirmation('cnf_1', 'wrong', 'confirm'),
    ).rejects.toMatchObject({ status: 401, code: 'CONFIRMATION_TOKEN_INVALID' });
  });
});

const REFERENCE = {
  id: 'ref_1',
  subjectExternalId: 'worker_7',
  category: 'employment',
  label: 'Senior Engineer',
  issuer: 'Northwind Labs',
  jurisdiction: null,
  reference: null,
  counterpartyRef: 'past_manager_9',
  counterpartyName: 'Sam',
  description: 'Confirm Alex worked as a Senior Engineer.',
  returnUrl: 'https://acme.example/thanks',
  status: 'PENDING',
  expiresAt: '2026-08-07T00:00:00.000Z',
  resultingEventId: null,
  decidedAt: null,
  createdAt: '2026-07-24T00:00:00.000Z',
};

describe('reference requests — keyed half', () => {
  it('creates a request, sends the idempotency key, and returns the one-time token + all three delivery URLs', async () => {
    const calls = recordingStub(201, {
      reference: REFERENCE,
      referenceToken: 'raw_ref_token',
      referenceUrl: `${BASE}/reference/ref_1?token=raw_ref_token`,
      previewUrl: `${BASE}/api/v1/references/ref_1/preview?token=raw_ref_token`,
      respondUrl: `${BASE}/api/v1/references/ref_1/respond`,
    });

    const r = await new CreddaClient({ apiBase: BASE }).createReferenceRequest(
      {
        userId: 'worker_7',
        category: 'employment',
        label: 'Senior Engineer',
        counterpartyRef: 'past_manager_9',
        counterpartyName: 'Sam',
        description: 'Confirm Alex worked as a Senior Engineer.',
        expiresInDays: 14,
      },
      'crd_live_k',
      { idempotencyKey: 'job-991-ref' },
    );

    const { url, init } = calls[0];
    expect(url).toBe(`${BASE}/api/v1/references`);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer crd_live_k');
    expect(init.headers['Idempotency-Key']).toBe('job-991-ref');
    expect(JSON.parse(init.body)).toMatchObject({
      userId: 'worker_7',
      category: 'employment',
      counterpartyRef: 'past_manager_9',
    });
    expect(r.referenceToken).toBe('raw_ref_token');
    expect(r.referenceUrl).toContain('/reference/ref_1');
    expect(r.previewUrl).toContain('/preview?token=');
    expect(r.respondUrl).toContain('/respond');
    // Creating a request records NO qualification.
    expect(r.reference.resultingEventId).toBeNull();
    expect(r.reference.status).toBe('PENDING');
  });

  it('lists with a status filter + cursor, and reads one back', async () => {
    let calls = recordingStub(200, { data: [REFERENCE], nextCursor: 'ref_0' });
    const list = await new CreddaClient({ apiBase: BASE }).listReferences('k', {
      status: 'PENDING', limit: 10, cursor: 'ref_9',
    });
    expect(calls[0].url).toBe(`${BASE}/api/v1/references?status=PENDING&limit=10&cursor=ref_9`);
    expect(list.nextCursor).toBe('ref_0');
    expect(list.data[0].counterpartyRef).toBe('past_manager_9');

    calls = recordingStub(200, { reference: REFERENCE });
    const one = await new CreddaClient({ apiBase: BASE }).getReference('ref_1', 'k');
    expect(calls[0].url).toBe(`${BASE}/api/v1/references/ref_1`);
    expect(calls[0].init.headers.Authorization).toBe('Bearer k');
    expect(one.reference.id).toBe('ref_1');
  });

  it('cancels a pending request, and surfaces 409 REFERENCE_NOT_PENDING once decided', async () => {
    const calls = recordingStub(200, {
      reference: { ...REFERENCE, status: 'CANCELLED', decidedAt: '2026-07-24T00:00:00.000Z' },
    });
    const r = await new CreddaClient({ apiBase: BASE }).cancelReference('ref_1', 'k');
    expect(calls[0].url).toBe(`${BASE}/api/v1/references/ref_1/cancel`);
    expect(calls[0].init.method).toBe('POST');
    expect(r.reference.status).toBe('CANCELLED');

    stub(409, { error: 'already confirmed', code: 'REFERENCE_NOT_PENDING' });
    await expect(
      new CreddaClient({ apiBase: BASE }).cancelReference('ref_1', 'k'),
    ).rejects.toMatchObject({ status: 409, code: 'REFERENCE_NOT_PENDING' });
  });
});

describe('reference requests — the KEYLESS counterparty half', () => {
  it('previews with only the token — no Authorization header is sent', async () => {
    const calls = recordingStub(200, {
      reference: {
        id: 'ref_1',
        platform: 'Acme Talent',
        status: 'PENDING',
        category: 'employment',
        label: 'Senior Engineer',
        issuer: 'Northwind Labs',
        jurisdiction: null,
        reference: null,
        counterpartyName: 'Sam',
        description: 'Confirm Alex worked as a Senior Engineer.',
        expiresAt: '2026-08-07T00:00:00.000Z',
      },
    });

    const r = await new CreddaClient({ apiBase: BASE }).previewReference('ref_1', 'raw token/abc');
    expect(calls[0].url).toBe(`${BASE}/api/v1/references/ref_1/preview?token=raw%20token%2Fabc`);
    expect(calls[0].init.headers).toBeUndefined();
    // PII-free: the raw subject id and the matching key are never disclosed.
    expect(r.reference).not.toHaveProperty('subjectExternalId');
    expect(r.reference).not.toHaveProperty('counterpartyRef');
    expect(r.reference.platform).toBe('Acme Talent');
  });

  it('responds with the raw token and NO Authorization header, returning the recorded event id', async () => {
    const calls = recordingStub(200, {
      status: 'CONFIRMED',
      reference: { ...REFERENCE, status: 'CONFIRMED', resultingEventId: 'ev_q' },
      eventId: 'ev_q',
    });

    const r = await new CreddaClient({ apiBase: BASE }).respondToReference('ref_1', 'raw_ref_token', 'confirm');
    expect(calls[0].url).toBe(`${BASE}/api/v1/references/ref_1/respond`);
    expect(calls[0].init.method).toBe('POST');
    // THE point of the keyless path: an API key is never required or sent.
    expect(calls[0].init.headers.Authorization).toBeUndefined();
    expect(JSON.parse(calls[0].init.body)).toEqual({ token: 'raw_ref_token', decision: 'confirm' });
    expect(r.status).toBe('CONFIRMED');
    expect(r.eventId).toBe('ev_q');
  });

  it('declines without recording anything', async () => {
    const calls = recordingStub(200, {
      status: 'DECLINED',
      reference: { ...REFERENCE, status: 'DECLINED' },
    });
    const r = await new CreddaClient({ apiBase: BASE }).respondToReference('ref_1', 'tok', 'decline');
    expect(JSON.parse(calls[0].init.body).decision).toBe('decline');
    expect(r.eventId).toBeUndefined();
    expect(r.reference.resultingEventId).toBeNull();
  });

  it('surfaces an invalid token as 401 REFERENCE_TOKEN_INVALID', async () => {
    stub(401, { error: 'Invalid reference token', code: 'REFERENCE_TOKEN_INVALID' });
    await expect(
      new CreddaClient({ apiBase: BASE }).respondToReference('ref_1', 'wrong', 'confirm'),
    ).rejects.toMatchObject({ status: 401, code: 'REFERENCE_TOKEN_INVALID' });
  });
});

describe('career export', () => {
  const RESUME = {
    $schema: 'https://jsonresume.org/schema',
    basics: { name: 'A. Worker' },
    work: [{ name: 'Acme', credda: { verified: true } }],
    education: [],
    skills: [],
    certificates: [],
    meta: { credda: { reliability: { score: 72 } } },
  };

  it('GETs the keyed /users/:id/career-export with an Authorization header', async () => {
    const calls = recordingStub(200, RESUME);
    const r = await new CreddaClient({ apiBase: BASE }).getCareerExport('ext-1', 'k');
    expect(calls[0].url).toBe(`${BASE}/api/v1/users/ext-1/career-export`);
    expect(calls[0].init.headers.Authorization).toBe('Bearer k');
    expect((r.work[0] as any).credda.verified).toBe(true);
  });

  it('GETs the PUBLIC /verify/:token/career-export with NO Authorization header', async () => {
    const calls = recordingStub(200, RESUME);
    const r = await new CreddaClient({ apiBase: BASE }).getPublicCareerExport('raw token/abc');
    expect(calls[0].url).toBe(`${BASE}/api/v1/verify/raw%20token%2Fabc/career-export`);
    // The token IS the consent — a public route must never carry a platform key.
    expect(calls[0].init.headers).toBeUndefined();
    expect(r.$schema).toMatch(/jsonresume/);
  });

  it('throws CreddaError on a non-2xx response', async () => {
    stub(404, { error: 'not found' });
    await expect(new CreddaClient({ apiBase: BASE }).getPublicCareerExport('t')).rejects.toBeInstanceOf(CreddaError);
  });
});

describe('getOutcomeTemplates', () => {
  const CATALOG = {
    version: '1.0',
    note: 'Guidance only.',
    industries: [{ industry: 'trades', label: 'Trades & construction' }],
    templates: [{ industry: 'trades', label: 'Trades & construction', templates: [] }],
    disclosures: ['Nothing here scores anyone.'],
  };

  it('GETs the PUBLIC /outcome-templates with NO Authorization header', async () => {
    const calls = recordingStub(200, CATALOG);
    const r = await new CreddaClient({ apiBase: BASE }).getOutcomeTemplates();
    expect(calls[0].url).toBe(`${BASE}/api/v1/outcome-templates`);
    expect(calls[0].init.headers).toBeUndefined();
    expect(r.version).toBe('1.0');
    expect(r.industries[0].industry).toBe('trades');
  });

  it('passes an industry filter as a query param, still keyless', async () => {
    const calls = recordingStub(200, CATALOG);
    await new CreddaClient({ apiBase: BASE }).getOutcomeTemplates('trades');
    expect(calls[0].url).toBe(`${BASE}/api/v1/outcome-templates?industry=trades`);
    expect(calls[0].init.headers).toBeUndefined();
  });

  it('throws CreddaError on a non-2xx response', async () => {
    stub(500, { error: 'boom' });
    await expect(new CreddaClient({ apiBase: BASE }).getOutcomeTemplates()).rejects.toBeInstanceOf(CreddaError);
  });
});

describe('threshold policies', () => {
  const POLICY = {
    id: 'pol_1',
    name: 'Watch the 60 line',
    appliesToAll: false,
    metric: 'score',
    direction: 'down',
    threshold: 60,
    component: null,
    band: null,
    isActive: true,
    lastTriggeredAt: null,
    createdAt: '2026-07-23T00:00:00.000Z',
    updatedAt: '2026-07-23T00:00:00.000Z',
    userId: 'worker_7',
  };

  it('creates a policy at /policies (NOT /threshold-policies)', async () => {
    const calls = recordingStub(201, { policy: POLICY });
    const r = await new CreddaClient({ apiBase: BASE }).createPolicy(
      { name: 'Watch the 60 line', userId: 'worker_7', metric: 'score', direction: 'down', threshold: 60 },
      'k',
    );
    expect(calls[0].url).toBe(`${BASE}/api/v1/policies`);
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers.Authorization).toBe('Bearer k');
    expect(JSON.parse(calls[0].init.body)).toMatchObject({ metric: 'score', threshold: 60 });
    expect(r.policy.id).toBe('pol_1');
  });

  it('supports an appliesToAll band policy', async () => {
    const calls = recordingStub(201, {
      policy: { ...POLICY, appliesToAll: true, userId: null, metric: 'band', direction: 'enter', threshold: null, band: 'High Risk' },
    });
    const r = await new CreddaClient({ apiBase: BASE }).createPolicy(
      { name: 'Any subject entering High Risk', appliesToAll: true, metric: 'band', direction: 'enter', band: 'High Risk' },
      'k',
    );
    expect(JSON.parse(calls[0].init.body).appliesToAll).toBe(true);
    expect(r.policy.userId).toBeNull();
  });

  it('lists, reads, patches and deletes', async () => {
    let calls = recordingStub(200, { data: [POLICY], nextCursor: null });
    const list = await new CreddaClient({ apiBase: BASE }).listPolicies('k', { limit: 5, cursor: 'pol_9' });
    expect(calls[0].url).toBe(`${BASE}/api/v1/policies?limit=5&cursor=pol_9`);
    expect(list.nextCursor).toBeNull();

    calls = recordingStub(200, { policy: POLICY });
    await new CreddaClient({ apiBase: BASE }).getPolicy('pol_1', 'k');
    expect(calls[0].url).toBe(`${BASE}/api/v1/policies/pol_1`);

    calls = recordingStub(200, { policy: { ...POLICY, threshold: 55, isActive: false } });
    const patched = await new CreddaClient({ apiBase: BASE }).updatePolicy('pol_1', { threshold: 55, isActive: false }, 'k');
    expect(calls[0].init.method).toBe('PATCH');
    expect(JSON.parse(calls[0].init.body)).toEqual({ threshold: 55, isActive: false });
    expect(patched.policy.threshold).toBe(55);

    calls = recordingStub(204, {});
    await new CreddaClient({ apiBase: BASE }).deletePolicy('pol_1', 'k');
    expect(calls[0].init.method).toBe('DELETE');
    expect(calls[0].url).toBe(`${BASE}/api/v1/policies/pol_1`);
  });

  it('clears a condition field by patching it to null', async () => {
    const calls = recordingStub(200, { policy: { ...POLICY, threshold: null } });
    await new CreddaClient({ apiBase: BASE }).updatePolicy('pol_1', { threshold: null }, 'k');
    expect(JSON.parse(calls[0].init.body)).toEqual({ threshold: null });
  });
});

describe('Open Badges 3.0 achievement definitions (public)', () => {
  it('fetches the closed catalog with no API key', async () => {
    const calls = recordingStub(200, {
      specification: { name: 'Open Badges', version: '3.0' },
      note: 'The closed set this issuer will sign.',
      achievementIds: ['first-delivery'],
      achievements: [{
        id: `${BASE}/api/v1/open-badges/achievements/first-delivery`,
        type: ['Achievement'],
        name: 'First Delivery',
        description: 'One confirmed delivery on the ledger.',
        achievementType: 'Badge',
        criteria: { id: 'x', narrative: 'One fulfilled commitment.' },
        creator: { id: 'did:web:api.credda.io', type: ['Profile'], name: 'Credda' },
      }],
    });
    const r = await new CreddaClient({ apiBase: BASE }).getOpenBadgeAchievements();
    expect(calls[0].url).toBe(`${BASE}/api/v1/open-badges/achievements`);
    expect(calls[0].init.headers).toBeUndefined();
    expect(r.achievementIds).toEqual(['first-delivery']);
    // A Credda badge records that something happened; it certifies no skill.
    expect(r.achievements[0].achievementType).toBe('Badge');
  });

  it('fetches one definition by id and 404s for anything off the allowlist', async () => {
    const calls = recordingStub(200, {
      id: 'first-delivery', type: ['Achievement'], name: 'First Delivery',
      description: 'd', achievementType: 'Badge',
      criteria: { id: 'x', narrative: 'n' },
      creator: { id: 'did:web:api.credda.io', type: ['Profile'], name: 'Credda' },
    });
    await new CreddaClient({ apiBase: BASE }).getOpenBadgeAchievement('first delivery');
    expect(calls[0].url).toBe(`${BASE}/api/v1/open-badges/achievements/first%20delivery`);

    stub(404, { error: 'Unknown achievement "nope"', code: 'NOT_FOUND' });
    await expect(
      new CreddaClient({ apiBase: BASE }).getOpenBadgeAchievement('nope'),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('Verified Profile (qualifications)', () => {
  it('reads the measure, keeping an empty category null rather than 0', async () => {
    const calls = recordingStub(200, {
      userId: 'worker_7',
      profileVersion: '1.0',
      categories: {
        education: { claimed: 1, verified: 1, verificationDepth: 1 },
        skill: { claimed: 2, verified: 0, verificationDepth: 0 },
        certification: { claimed: 0, verified: 0, verificationDepth: null },
        employment: { claimed: 1, verified: 1, verificationDepth: 1 },
      },
      totals: { claimed: 4, verified: 3, selfAttested: 1 },
      verificationDepth: 0.75,
      note: 'verification of claims, not an assessment of the person',
      disclosures: ['…'],
    });
    const r = await new CreddaClient({ apiBase: BASE }).getVerifiedProfile('worker 7', 'k');
    expect(calls[0].url).toBe(`${BASE}/api/v1/users/worker%207/verified-profile`);
    expect(calls[0].init.headers.Authorization).toBe('Bearer k');
    expect(r.verificationDepth).toBe(0.75);
    expect(r.categories.certification.verificationDepth).toBeNull();
    expect(r.disclosures.length).toBeGreaterThan(0);
  });

  it('records a claim WITH a third-party witness — verified', async () => {
    const calls = recordingStub(201, {
      userId: 'worker_7', eventId: 'ev_1', category: 'certification',
      eventType: 'CERTIFICATION_VERIFIED', isVerified: true, verificationNote: null,
      note: 'Recorded on the ledger. A qualification claim never affects the Credda Reliability Score.',
    });
    const r = await new CreddaClient({ apiBase: BASE }).recordQualification(
      'worker_7',
      { category: 'certification', label: 'AWS Solutions Architect', issuer: 'AWS', verifiedBy: 'aws-training' },
      'k',
    );
    expect(calls[0].url).toBe(`${BASE}/api/v1/users/worker_7/qualifications`);
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(calls[0].init.body).verifiedBy).toBe('aws-training');
    expect(r.isVerified).toBe(true);
    expect(r.verificationNote).toBeNull();
  });

  it('records a claim with NO witness — still recorded, but self-attested with a reason', async () => {
    recordingStub(201, {
      userId: 'worker_7', eventId: 'ev_2', category: 'skill',
      eventType: 'SKILL_VERIFIED', isVerified: false,
      verificationNote: 'no third-party witness — recorded as a self-attested claim',
      note: 'Recorded on the ledger. A qualification claim never affects the Credda Reliability Score.',
    });
    const r = await new CreddaClient({ apiBase: BASE }).recordQualification(
      'worker_7', { category: 'skill', label: 'TypeScript' }, 'k',
    );
    expect(r.isVerified).toBe(false);
    expect(r.verificationNote).toMatch(/no third-party witness/);
  });

  it('bulk-imports a claimed record — wraps claims and posts to the import path', async () => {
    const calls = recordingStub(200, {
      userId: 'worker_7', created: 2, failed: 0, total: 2, maxClaims: 100,
      items: [
        { index: 0, ok: true, category: 'education', eventId: 'ev_1', eventType: 'EDUCATION_VERIFIED', isVerified: false, verificationNote: 'no third-party witness — recorded as a self-attested claim' },
        { index: 1, ok: true, category: 'employment', eventId: 'ev_2', eventType: 'EMPLOYMENT_VERIFIED', isVerified: false, verificationNote: 'no third-party witness — recorded as a self-attested claim' },
      ],
      verifiedProfile: { userId: 'worker_7', profileVersion: '1.0', categories: {}, totals: { claimed: 2, verified: 0, selfAttested: 2 }, verificationDepth: 0, note: 'verification of claims, not an assessment of the person', disclosures: ['…'] },
      note: 'Every imported claim is recorded self-attested (isVerified:false) unless a genuine third-party witness was named per claim.',
    });
    const r = await new CreddaClient({ apiBase: BASE }).importQualifications(
      'worker_7',
      [
        { category: 'education', label: 'BSc Computer Science', issuer: 'State University' },
        { category: 'employment', label: 'Software Engineer', issuer: 'Some Company' },
      ],
      'k',
    );
    expect(calls[0].url).toBe(`${BASE}/api/v1/users/worker_7/qualifications/import`);
    expect(calls[0].init.method).toBe('POST');
    // The method wraps the array in { claims }.
    expect(JSON.parse(calls[0].init.body).claims).toHaveLength(2);
    expect(r.created).toBe(2);
    // Self-import with no witnesses → every claim self-attested.
    expect(r.items.every((i) => i.isVerified === false)).toBe(true);
  });
});

describe('Professional Record', () => {
  const RECORD = {
    professionalRecordVersion: '1.0',
    note: 'A worker-owned summary of a verified work record',
    reliability: { score: 72, band: 'Good', confidence: 0.8 },
    verifiedExperience: { verifiedOutcomes: 18, totalOutcomes: 24, verificationDepth: 0.75, verifiedPlatforms: 2 },
    tenure: {
      firstRecordedAt: '2025-01-04T00:00:00.000Z',
      firstVerifiedAt: '2025-02-01T00:00:00.000Z',
      lastRecordedAt: '2026-07-01T00:00:00.000Z',
      trackRecordDays: 543,
      trackRecordMonths: 17.8,
    },
    status: { scoreFrozen: false },
    provenance: { formulaVersion: '5.3', computedAt: '2026-07-23T00:00:00.000Z' },
    disclosures: ['It is not a hiring, promotion, or employment recommendation…'],
  };

  it('reads a subject record with the platform key', async () => {
    const calls = recordingStub(200, { userId: 'worker_7', ...RECORD });
    const r = await new CreddaClient({ apiBase: BASE }).getProfessionalRecord('worker 7', 'k');
    expect(calls[0].url).toBe(`${BASE}/api/v1/users/worker%207/professional-record`);
    expect(calls[0].init.headers.Authorization).toBe('Bearer k');
    expect(r.verifiedExperience.verificationDepth).toBe(0.75);
    expect(r.disclosures.length).toBeGreaterThan(0);
  });

  it('reports an empty record as null depth, not 0', async () => {
    recordingStub(200, {
      userId: 'new_1', ...RECORD,
      verifiedExperience: { verifiedOutcomes: 0, totalOutcomes: 0, verificationDepth: null, verifiedPlatforms: 0 },
      tenure: { ...RECORD.tenure, firstRecordedAt: null, lastRecordedAt: null, trackRecordDays: null, trackRecordMonths: null },
    });
    const r = await new CreddaClient({ apiBase: BASE }).getProfessionalRecord('new_1', 'k');
    expect(r.verifiedExperience.verificationDepth).toBeNull();
    expect(r.tenure.trackRecordDays).toBeNull();
  });

  it('mints a signed credential with the LinkedIn deep link', async () => {
    const calls = recordingStub(201, {
      format: 'jwt_vc_json',
      credentialVc: 'eyJ.a.b',
      credentialType: 'CreddaProfessionalRecordCredential',
      issuer: 'did:web:api.credda.io',
      kid: 'did:web:api.credda.io#key-1',
      scope: 'professional',
      professionalRecordVersion: '1.0',
      claims: { credentialKind: 'professional-record', reliabilityScore: 72 },
      issuedAt: '2026-07-23T00:00:00.000Z',
      expiresAt: '2026-07-24T00:00:00.000Z',
      linkedin: {
        addToProfileUrl: 'https://www.linkedin.com/profile/add?startTask=CERTIFICATION_NAME',
        certUrl: `${BASE}/api/v1/verify/tok_1`,
        certId: 'tok_1',
        note: 'LinkedIn does not import verifiable-credential claims.',
      },
      didDocument: '/.well-known/did.json',
      trustRegistry: '/.well-known/credda-trust-registry.json',
      statusList: `${BASE}/api/v1/status/revocation`,
    });
    const r = await new CreddaClient({ apiBase: BASE }).mintProfessionalRecordCredential('worker_7', 'k', { ttlSeconds: 3600 });
    expect(calls[0].url).toBe(`${BASE}/api/v1/users/worker_7/professional-record/credential`);
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(calls[0].init.body)).toEqual({ ttlSeconds: 3600 });
    expect(r.credentialType).toBe('CreddaProfessionalRecordCredential');
    expect(r.linkedin.certUrl).toContain('/verify/tok_1');
    expect(r.statusList).toContain('/status/revocation');
  });

  it('refuses a test-mode subject', async () => {
    stub(403, { error: 'Professional record credential issuance is not available in test mode', code: 'TEST_MODE_NOT_ALLOWED' });
    await expect(
      new CreddaClient({ apiBase: BASE }).mintProfessionalRecordCredential('t_1', 'crd_test_k'),
    ).rejects.toMatchObject({ status: 403, code: 'TEST_MODE_NOT_ALLOWED' });
  });

  it('reads the PUBLIC record behind a share token at full scope, with no key', async () => {
    const calls = recordingStub(200, {
      token: 'tok_1',
      issuer: 'did:web:api.credda.io',
      scoreFrozen: false,
      computedAt: '2026-07-23T00:00:00.000Z',
      scope: 'full',
      finalScore: 72,
      scoreBand: 'Good',
      confidence: 0.8,
      verifiedPlatforms: 2,
      totalEvents: 24,
      formulaVersion: '5.3',
      professionalRecord: RECORD,
      credential: 'eyJ.a.b',
    });
    const r = await new CreddaClient({ apiBase: BASE }).getPublicProfessionalRecord('tok 1');
    // scope=full is required — the API serves the block at no other scope.
    expect(calls[0].url).toBe(`${BASE}/api/v1/verify/tok%201?scope=full&professional=1`);
    expect(calls[0].init.headers).toBeUndefined();
    expect(r.professionalRecord?.reliability.band).toBe('Good');
  });

  it('reports a fail-safe null record rather than inventing one', async () => {
    recordingStub(200, {
      token: 'tok_1', issuer: 'did:web:api.credda.io', scoreFrozen: false,
      computedAt: null, scope: 'full', finalScore: 20, scoreBand: 'Unproven',
      confidence: 0, verifiedPlatforms: 0, totalEvents: 0, formulaVersion: '5.3',
      professionalRecord: null,
    });
    const r = await new CreddaClient({ apiBase: BASE }).getPublicProfessionalRecord('tok_1');
    expect(r.professionalRecord).toBeNull();
  });
});

describe('worker reliability report', () => {
  const REPORT = {
    reliabilityReportVersion: '1.0',
    note: 'A consolidated, read-only dossier…',
    reliability: { score: 72, band: 'Good', confidence: 0.8, formulaVersion: '5.3', reasonCodesVersion: '1.0' },
    metrics: { completionRate: 0.95, onTimeRate: 0.9, consistency: 0.8, recency: 0.93, disputeRate: 0 },
    verifiedExperience: {
      verifiedOutcomes: 34, totalOutcomes: 40, verificationDepth: 0.85, verifiedPlatforms: 3,
      tenure: { firstRecordedAt: '2025-01-15T00:00:00.000Z', firstVerifiedAt: '2025-02-01T00:00:00.000Z', lastRecordedAt: '2026-07-10T00:00:00.000Z', trackRecordDays: 541, trackRecordMonths: 17.8 },
    },
    topFactors: [
      { code: 'ESTABLISHED_VERIFIED_HISTORY', factor: 'evidence', direction: 'supporting', title: 'Established verified history', description: '…', contribution: 0.4, rank: 1 },
    ],
    recentOutcomes: [
      { eventType: 'CONTRACT_FULFILLED', stake: 'HIGH', verified: true, source: 'verified', occurredAt: '2026-07-10T00:00:00.000Z' },
      { eventType: 'TRANSACTION_COMPLETED', stake: 'LOW', verified: false, source: 'self_reported', occurredAt: '2026-07-01T00:00:00.000Z' },
    ],
    benchmark: null,
    status: { scoreFrozen: false },
    provenance: { formulaVersion: '5.3', computedAt: '2026-07-10T00:00:00.000Z' },
    disclosures: ['It is not a background check and it is not a consumer report under the FCRA…'],
    advisory: 'This report aggregates values the deterministic reliability score already produced…',
  };

  it('reads the consolidated report with the platform key', async () => {
    const calls = recordingStub(200, { userId: 'worker_7', ...REPORT });
    const r = await new CreddaClient({ apiBase: BASE }).getReliabilityReport('worker 7', 'k');
    expect(calls[0].url).toBe(`${BASE}/api/v1/users/worker%207/reliability-report`);
    expect(calls[0].init.headers.Authorization).toBe('Bearer k');
    expect(r.reliability.band).toBe('Good');
    expect(r.metrics.completionRate).toBe(0.95);
    // self-reported vs verified is unmissable
    const self = r.recentOutcomes.find((o) => o.source === 'self_reported');
    expect(self?.verified).toBe(false);
  });

  it('passes recent + benchmark query params through', async () => {
    const calls = recordingStub(200, { userId: 'worker_7', ...REPORT });
    await new CreddaClient({ apiBase: BASE }).getReliabilityReport('worker_7', 'k', { recent: 5, benchmark: true });
    expect(calls[0].url).toBe(`${BASE}/api/v1/users/worker_7/reliability-report?recent=5&benchmark=1`);
  });

  it('reads the PUBLIC report behind a share token with NO key', async () => {
    const calls = recordingStub(200, { token: 'tok_1', issuer: 'credda.io', reliabilityReport: REPORT });
    const r = await new CreddaClient({ apiBase: BASE }).getPublicReliabilityReport('tok 1');
    expect(calls[0].url).toBe(`${BASE}/api/v1/verify/tok%201/reliability-report`);
    // keyless — the token is the capability, not an API key
    expect(calls[0].init.headers).toBeUndefined();
    expect(r.reliabilityReport?.reliability.band).toBe('Good');
  });

  it('reports a fail-safe null report rather than inventing one', async () => {
    recordingStub(200, { token: 'tok_1', issuer: 'credda.io', reliabilityReport: null });
    const r = await new CreddaClient({ apiBase: BASE }).getPublicReliabilityReport('tok_1');
    expect(r.reliabilityReport).toBeNull();
  });
});

describe('sandbox seed + reset', () => {
  const SEED = {
    seeded: true,
    livemode: false,
    seedVersion: 1,
    subjectsCreated: 5,
    subjectsSkipped: 0,
    eventsWritten: 40,
    subjects: [
      {
        userId: 'sbx_reliable_courier',
        label: 'Reliable courier',
        record: 'Twelve counterparty-confirmed deliveries.',
        tryNext: 'GET /api/v1/users/sbx_reliable_courier/score/explain',
        totalEvents: 12,
        eventsWritten: 12,
        alreadySeeded: false,
        finalScore: 81,
        scoreBand: 'Excellent',
        confidence: 1,
      },
    ],
    note: 'Synthetic sandbox data.',
    nextSteps: ['GET /api/v1/users/sbx_reliable_courier/score'],
  };

  it('seeds with a keyed POST to /test/seed', async () => {
    const calls = recordingStub(201, SEED);
    const r = await new CreddaClient({ apiBase: BASE }).seedSandbox('crd_test_k');
    expect(calls[0].url).toBe(`${BASE}/api/v1/test/seed`);
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers.Authorization).toBe('Bearer crd_test_k');
    expect(r.livemode).toBe(false);
    expect(r.subjects[0].userId.startsWith('sbx_')).toBe(true);
  });

  it('resets with a keyed DELETE to /test/data and returns the counts', async () => {
    const calls = recordingStub(200, {
      reset: true,
      deleted: { users: 5, events: 40, screenings: 0, imports: 0, ingestMappings: 0, confirmations: 0 },
      note: 'Test data only.',
    });
    const r = await new CreddaClient({ apiBase: BASE }).resetSandbox('crd_test_k');
    expect(calls[0].url).toBe(`${BASE}/api/v1/test/data`);
    expect(calls[0].init.method).toBe('DELETE');
    expect(r.deleted.events).toBe(40);
  });

  it('surfaces the live-key refusal as a CreddaError, not a silent no-op', async () => {
    recordingStub(403, { error: 'Sandbox seeding requires a test-mode key', code: 'TEST_MODE_ONLY' });
    await expect(new CreddaClient({ apiBase: BASE }).seedSandbox('crd_live_k')).rejects.toBeInstanceOf(CreddaError);
  });
});

describe('analytics + usage-meter reads', () => {
  it('getEventAnalytics passes a trailing days window and hits /analytics/events', async () => {
    let seen = '';
    stub(200, { totals: { total: 0, verified: 0, verifiedShare: null }, daily: [], byType: [] }, (u) => (seen = u));
    const client = new CreddaClient({ apiBase: BASE });
    await client.getEventAnalytics('k', 14);
    expect(seen).toBe(`${BASE}/api/v1/analytics/events?days=14`);
  });

  it('getScoreAnalytics passes an explicit from/to range', async () => {
    let seen = '';
    stub(200, { formulaVersion: '5.3', scoredSubjects: 0, central: { median: null, mean: null }, bandDistribution: [], movement: { up: 0, down: 0, unchanged: 0, subjectsMoved: 0, subjectsRecomputed: 0 } }, (u) => (seen = u));
    const client = new CreddaClient({ apiBase: BASE });
    await client.getScoreAnalytics('k', { from: '2026-07-01', to: '2026-07-31' });
    expect(seen).toBe(`${BASE}/api/v1/analytics/scores?from=2026-07-01&to=2026-07-31`);
  });

  it('getUsageMeters hits /usage/meters with the window', async () => {
    let seen = '';
    stub(200, { platform: { id: 'p', name: 'n', tier: 'GROWTH' }, window: { days: 7 }, from: '2026-07-01', to: '2026-07-07', meters: [] }, (u) => (seen = u));
    const client = new CreddaClient({ apiBase: BASE });
    await client.getUsageMeters('k', 7);
    expect(seen).toBe(`${BASE}/api/v1/usage/meters?days=7`);
  });
});
