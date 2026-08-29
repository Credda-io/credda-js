import { describe, expect, it, vi } from 'vitest';
import { CreddaClient } from './client.js';

/**
 * A fetch double that records every call and answers with a fixed JSON body.
 * The assertions below are about the request this client composes: the path,
 * the method, and which query parameters travel. The response shapes are the
 * ones `apps/api/src/serialize.ts` writes.
 */
function stub(body: unknown = {}, status = 200, headers: Record<string, string> = {}) {
  return vi.fn(async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    }),
  );
}

function clientWith(fetchImpl: unknown): CreddaClient {
  return new CreddaClient({ baseUrl: 'https://engine.example.com', apiKey: 'crd_k', fetch: fetchImpl as never });
}

const urlOf = (fetchImpl: { mock: { calls: unknown[][] } }): string => String(fetchImpl.mock.calls[0]![0]);
const initOf = (fetchImpl: { mock: { calls: unknown[][] } }): RequestInit =>
  (fetchImpl.mock.calls[0]![1] ?? {}) as RequestInit;

describe('investigations', () => {
  it('lists them, unfiltered by default', async () => {
    const fetchImpl = stub({ investigations: [], total: 0 });
    await clientWith(fetchImpl).listInvestigations();
    expect(urlOf(fetchImpl)).toBe('https://engine.example.com/api/investigations');
  });

  it('passes the state filter and the page window', async () => {
    const fetchImpl = stub({ investigations: [], total: 0 });
    await clientWith(fetchImpl).listInvestigations({ state: 'REPRODUCED', limit: 10, offset: 20 });
    expect(urlOf(fetchImpl)).toBe(
      'https://engine.example.com/api/investigations?state=REPRODUCED&limit=10&offset=20',
    );
  });

  /*
   * `repository` and `outcome` are filters the route has always accepted and
   * this method could not express. An `outcome` passed anyway fell into the
   * rest element and was handed to `fetch` as a request option, so the caller
   * got an unfiltered page and no error at all.
   */
  it('passes the repository and outcome filters the route accepts', async () => {
    const fetchImpl = stub({ investigations: [], total: 0 });
    await clientWith(fetchImpl).listInvestigations({
      repository: 'repo_1',
      outcome: 'REPRODUCED_AND_DIAGNOSED',
    });
    expect(urlOf(fetchImpl)).toBe(
      'https://engine.example.com/api/investigations?repository=repo_1&outcome=REPRODUCED_AND_DIAGNOSED',
    );
  });

  it('can filter the queue by a terminal outcome the fix stage produces', async () => {
    const fetchImpl = stub({ investigations: [], total: 0 });
    await clientWith(fetchImpl).listInvestigations({ outcome: 'VERIFIED' });
    expect(urlOf(fetchImpl)).toBe('https://engine.example.com/api/investigations?outcome=VERIFIED');
  });

  /*
   * The queue is the only place that answers "every investigation this signal
   * caused, including the ones that resolved nothing". Walking `/api/resolutions`
   * by signal shows only the runs that produced a record, which is exactly the
   * population this product must not report on selectively.
   */
  it('passes the signal filter, renamed away from AbortSignal as on resolutions', async () => {
    const fetchImpl = stub({ investigations: [], total: 0 });
    await clientWith(fetchImpl).listInvestigations({ signalId: 'sig_1' });
    expect(urlOf(fetchImpl)).toBe('https://engine.example.com/api/investigations?signal=sig_1');
  });

  it('returns the list page whole, so `total` is not mistaken for the page length', async () => {
    const page = { investigations: [{ id: 'inv_1' }], total: 91 };
    const result = await clientWith(stub(page)).listInvestigations({ limit: 1 });
    expect(result.total).toBe(91);
    expect(result.investigations).toHaveLength(1);
  });

  it('opens one with a POST carrying exactly the fields createBody accepts', async () => {
    const fetchImpl = stub({ investigation: { id: 'inv_1', state: 'CREATED' } }, 201);
    await clientWith(fetchImpl).createInvestigation({
      repositoryId: 'repo_1',
      issueTitle: 'Checkout 500s on expired coupon',
      issueBody: 'Steps: …',
      issueRef: 'https://github.com/acme/web/issues/4',
    });
    expect(urlOf(fetchImpl)).toBe('https://engine.example.com/api/investigations');
    const init = initOf(fetchImpl);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      repositoryId: 'repo_1',
      issueTitle: 'Checkout 500s on expired coupon',
      issueBody: 'Steps: …',
      issueRef: 'https://github.com/acme/web/issues/4',
    });
  });

  it('reads one by id, escaping it into the path', async () => {
    const fetchImpl = stub({ investigation: {}, hypotheses: [], patches: [], verifications: [] });
    await clientWith(fetchImpl).getInvestigation('inv/1');
    expect(urlOf(fetchImpl)).toBe('https://engine.example.com/api/investigations/inv%2F1');
  });

  it('pages the timeline and can ask for debug events', async () => {
    const fetchImpl = stub({ events: [], latestSequence: 0, nextSince: 0, hasMore: false });
    await clientWith(fetchImpl).listInvestigationEvents('inv_1', { since: 40, limit: 100, includeDebug: true });
    expect(urlOf(fetchImpl)).toBe(
      'https://engine.example.com/api/investigations/inv_1/events?since=40&limit=100&includeDebug=true',
    );
  });

  it('filters evidence by type', async () => {
    const fetchImpl = stub({ evidence: [], total: 0 });
    await clientWith(fetchImpl).listInvestigationEvidence('inv_1', { type: 'REPRODUCTION' });
    expect(urlOf(fetchImpl)).toBe(
      'https://engine.example.com/api/investigations/inv_1/evidence?type=REPRODUCTION',
    );
  });

  it('streams the timeline off the SSE route', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const stream = clientWith(fetchImpl).streamInvestigation('inv_1', { since: 2 });
    await stream.next();
    expect(urlOf(fetchImpl)).toBe('https://engine.example.com/api/investigations/inv_1/stream?since=2');
  });
});

describe('repositories', () => {
  it('lists them', async () => {
    const fetchImpl = stub({ repositories: [], total: 0 });
    await clientWith(fetchImpl).listRepositories({ limit: 5 });
    expect(urlOf(fetchImpl)).toBe('https://engine.example.com/api/repositories?limit=5');
  });

  it('reads one by id and unwraps it, rather than paging the list to find it', async () => {
    const repository = { id: 'repo_1', name: 'acme/api', source: 'https://github.com/acme/api.git' };
    const fetchImpl = stub({ repository });
    const result = await clientWith(fetchImpl).getRepository('repo_1');
    expect(urlOf(fetchImpl)).toBe('https://engine.example.com/api/repositories/repo_1');
    expect(result).toEqual(repository);
  });

  it('reads what has been learned about one, filtered by kind', async () => {
    const fetchImpl = stub({ learnings: [], total: 0 });
    await clientWith(fetchImpl).listLearnings('repo_1', { kind: 'FRAGILE_SITE' });
    expect(urlOf(fetchImpl)).toBe('https://engine.example.com/api/repositories/repo_1/learnings?kind=FRAGILE_SITE');
  });

  it('treats an empty learnings list as an answer, not an absence', async () => {
    const page = await clientWith(stub({ learnings: [], total: 0 })).listLearnings('repo_1');
    expect(page.learnings).toEqual([]);
    expect(page.total).toBe(0);
  });
});

describe('resolutions', () => {
  it('lists them and renames the signal filter away from AbortSignal', async () => {
    const fetchImpl = stub({ resolutions: [], total: 0 });
    await clientWith(fetchImpl).listResolutions({ signalId: 'sig_1', confidence: 'NOT_ESTABLISHED' });
    expect(urlOf(fetchImpl)).toBe(
      'https://engine.example.com/api/resolutions?signal=sig_1&confidence=NOT_ESTABLISHED',
    );
  });

  it('asks for the latest by investigation, which the route requires', async () => {
    const fetchImpl = stub({ resolution: null });
    await clientWith(fetchImpl).latestResolution('inv_1');
    expect(urlOf(fetchImpl)).toBe('https://engine.example.com/api/resolutions/latest?investigation=inv_1');
  });

  it('returns null for an investigation that has resolved nothing yet', async () => {
    // Not an error and not a 404: the investigation exists and has produced no
    // record. A caller must be able to tell that from a wrong id.
    const body = await clientWith(stub({ resolution: null })).latestResolution('inv_1');
    expect(body.resolution).toBeNull();
  });

  it('unwraps a record read by id', async () => {
    const resolution = { id: 'res_1', confidence: { class: 'PARTIALLY_ESTABLISHED', notEstablished: ['no fix'] } };
    const fetchImpl = stub({ resolution });
    const result = await clientWith(fetchImpl).getResolution('res_1');
    expect(urlOf(fetchImpl)).toBe('https://engine.example.com/api/resolutions/res_1');
    expect(result).toEqual(resolution);
  });
});

describe('validations', () => {
  it('lists them with every filter the route accepts', async () => {
    const fetchImpl = stub({ validations: [], total: 0 });
    await clientWith(fetchImpl).listValidations({ repository: 'repo_1', state: 'RUNNING', outcome: 'FAILED' });
    expect(urlOf(fetchImpl)).toBe(
      'https://engine.example.com/api/validations?repository=repo_1&state=RUNNING&outcome=FAILED',
    );
  });

  it('narrows findings by severity and status, so triage need not pull every row', async () => {
    const fetchImpl = stub({ findings: [], total: 0 });
    await clientWith(fetchImpl).listFindings('val_1', { severity: 'HIGH', status: 'OPEN' });
    expect(urlOf(fetchImpl)).toBe(
      'https://engine.example.com/api/validations/val_1/findings?severity=HIGH&status=OPEN',
    );
  });

  it('filters validation evidence by type, the same filter the investigation route takes', async () => {
    const fetchImpl = stub({ evidence: [], total: 0 });
    await clientWith(fetchImpl).listValidationEvidence('val_1', { type: 'TEST_RESULT' });
    expect(urlOf(fetchImpl)).toBe(
      'https://engine.example.com/api/validations/val_1/evidence?type=TEST_RESULT',
    );
  });

  it('reads one', async () => {
    const fetchImpl = stub({ validation: {}, environment: {}, changeImpact: {}, checkCount: 0 });
    await clientWith(fetchImpl).getValidation('val_1');
    expect(urlOf(fetchImpl)).toBe('https://engine.example.com/api/validations/val_1');
  });

  it('reads the plan, the findings, the evidence and the timeline', async () => {
    const paths: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      paths.push(url);
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const client = clientWith(fetchImpl);
    await client.listValidationChecks('val_1', { limit: 100 });
    await client.listFindings('val_1');
    await client.listValidationEvidence('val_1');
    await client.listValidationEvents('val_1', { since: 9, limit: 500 });
    expect(paths).toEqual([
      'https://engine.example.com/api/validations/val_1/checks?limit=100',
      'https://engine.example.com/api/validations/val_1/findings',
      'https://engine.example.com/api/validations/val_1/evidence',
      'https://engine.example.com/api/validations/val_1/events?since=9&limit=500',
    ]);
  });

  it('streams a run off its SSE route', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    await clientWith(fetchImpl).streamValidation('val_1').next();
    expect(urlOf(fetchImpl)).toBe('https://engine.example.com/api/validations/val_1/stream?since=0');
  });
});

describe('organization', () => {
  it('reads the workspace overview', async () => {
    const fetchImpl = stub({ organization: { id: 'org_1' }, memberCount: 0 });
    await clientWith(fetchImpl).getOrganization();
    expect(urlOf(fetchImpl)).toBe('https://engine.example.com/api/organization');
  });

  it('surfaces NO_ORGANIZATION rather than guessing a tenant', async () => {
    const fetchImpl = stub(
      { error: { code: 'NO_ORGANIZATION', message: 'This request names no organisation.' } },
      404,
    );
    await expect(clientWith(fetchImpl).getOrganization()).rejects.toMatchObject({
      status: 404,
      code: 'NO_ORGANIZATION',
    });
  });

  it('lists members and keys', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      new Response(url.includes('keys') ? '{"keys":[],"total":0}' : '{"members":[],"total":0}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = clientWith(fetchImpl);
    await client.listMembers({ limit: 25 });
    const keys = await client.listApiKeys();
    expect(String(fetchImpl.mock.calls[0]![0])).toBe('https://engine.example.com/api/organization/members?limit=25');
    expect(String(fetchImpl.mock.calls[1]![0])).toBe('https://engine.example.com/api/organization/keys');
    expect(keys.total).toBe(0);
  });

  it('carries a revoked key through rather than filtering it out', async () => {
    // "This key was revoked on the 3rd" is the answer an operator came for.
    const page = await clientWith(
      stub({ keys: [{ id: 'k1', name: 'ci', createdAt: 't', lastUsedAt: null, revokedAt: '2026-08-03T00:00:00Z' }], total: 1 }),
    ).listApiKeys();
    expect(page.keys[0]!.revokedAt).toBe('2026-08-03T00:00:00Z');
  });
});

describe('operations', () => {
  it('returns the readiness report on a healthy deployment', async () => {
    const body = { status: 'ok', schemaVersion: 12, expectedSchemaVersion: 12, checks: [] };
    const health = await clientWith(stub(body)).getHealth();
    expect(health.status).toBe('ok');
  });

  it('returns the report on a degraded one, where the server answers 503', async () => {
    // Branch on `status`, never on whether this threw: the 503 body IS the
    // answer, and throwing it away would leave the caller with nothing to show.
    const body = {
      status: 'degraded',
      schemaVersion: 11,
      expectedSchemaVersion: 12,
      checks: [{ name: 'migrations', status: 'failed', detail: 'at version 11, this build expects 12' }],
    };
    const health = await clientWith(stub(body, 503)).getHealth();
    expect(health.status).toBe('degraded');
    expect(health.checks[0]!.name).toBe('migrations');
  });

  it('answers liveness with a boolean and never throws', async () => {
    const client = clientWith(vi.fn(async () => new Response(null, { status: 204 })));
    await expect(client.isLive()).resolves.toBe(true);

    const down = clientWith(vi.fn(async () => { throw new TypeError('fetch failed'); }));
    await expect(down.isLive()).resolves.toBe(false);

    const wrong = clientWith(vi.fn(async () => new Response(null, { status: 500 })));
    await expect(wrong.isLive()).resolves.toBe(false);
  });

  it('reads liveness off /livez, the one route outside the auth gate', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    await clientWith(fetchImpl).isLive();
    expect(urlOf(fetchImpl)).toBe('https://engine.example.com/livez');
  });

  it('returns Prometheus exposition as text', async () => {
    const exposition = '# TYPE credda_http_requests_total counter\ncredda_http_requests_total 7\n';
    const fetchImpl = vi.fn(async () => new Response(exposition, { status: 200 }));
    await expect(clientWith(fetchImpl).getMetrics()).resolves.toBe(exposition);
    expect(urlOf(fetchImpl)).toBe('https://engine.example.com/api/metrics');
  });
});

describe('credentials', () => {
  it('sends the bearer key on every route', async () => {
    const fetchImpl = stub({});
    await clientWith(fetchImpl).listInvestigations();
    expect((initOf(fetchImpl).headers as Record<string, string>)['Authorization']).toBe('Bearer crd_k');
  });

  it('sends none when the deployment runs with auth disabled', async () => {
    const fetchImpl = stub({});
    const client = new CreddaClient({ baseUrl: 'http://localhost:8080', fetch: fetchImpl as never });
    await client.listInvestigations();
    expect(initOf(fetchImpl).headers).toEqual({});
  });
});
