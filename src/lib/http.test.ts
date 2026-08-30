import { describe, expect, it, vi } from 'vitest';
import { CreddaError } from './errors.js';
import { Transport, queryString } from './http.js';

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

const envelope = (code: string, message: string) => ({ error: { code, message } });

describe('queryString', () => {
  it('omits undefined so the server applies its own defaults', () => {
    expect(queryString({ limit: undefined, offset: undefined })).toBe('');
  });

  it('serialises what is present, and only that', () => {
    expect(queryString({ state: 'REPRODUCED', limit: 10, offset: undefined })).toBe('?state=REPRODUCED&limit=10');
  });

  it('sends false rather than dropping it', () => {
    // `includeDebug=false` is a real value the route parses; dropping it would
    // be indistinguishable, but only by accident of the server's default.
    expect(queryString({ includeDebug: false })).toBe('?includeDebug=false');
  });

  it('escapes values', () => {
    expect(queryString({ investigation: 'inv 1&2' })).toBe('?investigation=inv+1%262');
  });
});

describe('Transport construction', () => {
  it('refuses to invent a base URL', () => {
    // Credda runs against a customer's own deployment. A built-in hostname
    // would send a bearer key somewhere nobody named.
    expect(() => new Transport({ baseUrl: '' })).toThrow(/baseUrl is required/);
    expect(() => new Transport({ baseUrl: undefined as unknown as string })).toThrow(/baseUrl is required/);
  });

  it('strips trailing slashes so paths never double up', () => {
    expect(new Transport({ baseUrl: 'https://engine.example.com///' }).url('/api/health')).toBe(
      'https://engine.example.com/api/health',
    );
  });

  /* This was one test titled "refuses when there is no fetch to use" whose
   * only assertion was `.not.toThrow()`. The title named the refusal and the
   * assertion pinned the opposite, so whichever a reader believed, the file
   * proved the other -- and the refusal itself, the line that stops a bearer
   * key being handed to `undefined`, was never executed by anything. Two
   * tests, each saying what it asserts. */
  it('falls back to the global fetch when the config leaves it undefined', () => {
    expect(() => new Transport({ baseUrl: 'http://x', fetch: undefined })).not.toThrow();
  });

  it('refuses when there is no fetch to fall back to either', () => {
    const global = globalThis.fetch;
    try {
      (globalThis as { fetch?: unknown }).fetch = undefined;
      expect(() => new Transport({ baseUrl: 'http://x' })).toThrow(/no fetch available/);
      expect(() => new Transport({ baseUrl: 'http://x', fetch: undefined })).toThrow(
        /no fetch available/,
      );
    } finally {
      globalThis.fetch = global;
    }
  });
});

describe('Transport headers', () => {
  it('sends the bearer key on every request', () => {
    const transport = new Transport({ baseUrl: 'http://x', apiKey: 'crd_key' });
    expect(transport.headers()).toEqual({ Authorization: 'Bearer crd_key' });
    expect(transport.headers({ Accept: 'text/event-stream' })).toEqual({
      Authorization: 'Bearer crd_key',
      Accept: 'text/event-stream',
    });
  });

  it('sends no Authorization at all when no key is configured', () => {
    // A deployment on CREDDA_AUTH=disabled has no key to send, and an empty
    // bearer would be refused by the gate rather than treated as absent.
    expect(new Transport({ baseUrl: 'http://x' }).headers()).toEqual({});
  });
});

describe('Transport.get', () => {
  it('returns the parsed body and hits the composed URL', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => json(200, { ok: true }));
    const transport = new Transport({ baseUrl: 'http://x/', apiKey: 'k', fetch: fetchImpl as never });
    await expect(transport.get('/api/investigations?limit=1')).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![0]).toBe('http://x/api/investigations?limit=1');
  });

  it('turns a refusal into a CreddaError and does not retry it', async () => {
    const fetchImpl = vi.fn(async () => json(404, envelope('NOT_FOUND', 'No such investigation: inv_x')));
    const transport = new Transport({ baseUrl: 'http://x', retries: 3, retryBaseMs: 0, fetch: fetchImpl as never });
    await expect(transport.get('/api/investigations/inv_x')).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('Transport retries', () => {
  it('are off by default', async () => {
    const fetchImpl = vi.fn(async () => json(502, {}));
    const transport = new Transport({ baseUrl: 'http://x', fetch: fetchImpl as never });
    await expect(transport.get('/api/health')).rejects.toBeInstanceOf(CreddaError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('re-attempt a gateway blip up to the configured count and then give up', async () => {
    const fetchImpl = vi.fn(async () => json(504, {}));
    const transport = new Transport({ baseUrl: 'http://x', retries: 2, retryBaseMs: 0, fetch: fetchImpl as never });
    await expect(transport.get('/api/investigations')).rejects.toMatchObject({ status: 504 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('re-attempt a network error and return the eventual success', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(json(200, { total: 0 }));
    const transport = new Transport({ baseUrl: 'http://x', retries: 1, retryBaseMs: 0, fetch: fetchImpl as never });
    await expect(transport.get('/api/investigations')).resolves.toEqual({ total: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('never re-attempt an abort: that was the caller\'s own decision', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const fetchImpl = vi.fn().mockRejectedValue(abort);
    const transport = new Transport({ baseUrl: 'http://x', retries: 5, retryBaseMs: 0, fetch: fetchImpl as never });
    await expect(transport.get('/api/investigations')).rejects.toBe(abort);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('cap the backoff at maxRetryDelayMs', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(async () => json(503, {}));
      const transport = new Transport({
        baseUrl: 'http://x',
        retries: 1,
        retryBaseMs: 60_000,
        maxRetryDelayMs: 10,
        fetch: fetchImpl as never,
      });
      const promise = transport.get('/api/investigations').catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(10);
      await promise;
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Transport.post', () => {
  it('sends JSON with the content type and is never retried', async () => {
    // `post` has no idempotency-key parameter, so nothing it sends can be
    // deduplicated and a repeat of a create would open a second investigation
    // into the same report. `postIdempotent` is the retrying write.
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => json(502, {}));
    const transport = new Transport({ baseUrl: 'http://x', apiKey: 'k', retries: 5, retryBaseMs: 0, fetch: fetchImpl as never });
    await expect(transport.post('/api/investigations', { issueTitle: 'x' })).rejects.toMatchObject({ status: 502 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"issueTitle":"x"}');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer k');
  });
});

describe('Transport.postIdempotent', () => {
  it('sends the key as a header and returns the status alongside the body', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => json(201, { investigation: { id: 'inv_1' } }));
    const transport = new Transport({ baseUrl: 'http://x', apiKey: 'k', fetch: fetchImpl as never });
    const result = await transport.postIdempotent('/api/investigations', { issueTitle: 'x' }, 'key-1' as never);
    expect(result.status).toBe(201);
    expect(result.body).toEqual({ investigation: { id: 'inv_1' } });
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('key-1');
  });

  it('is retried, because the key makes a repeat exactly-once at the server', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      return call < 3 ? json(502, {}) : json(200, { investigation: { id: 'inv_1' } });
    });
    const transport = new Transport({
      baseUrl: 'http://x',
      retries: 3,
      retryBaseMs: 0,
      fetch: fetchImpl as never,
    });
    const result = await transport.postIdempotent('/api/investigations', {}, 'key-1' as never);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(result.status).toBe(200);
  });

  it('does not retry the reused-key refusal, which is an answer and not a blip', async () => {
    const fetchImpl = vi.fn(async () => json(409, envelope('IDEMPOTENCY_KEY_REUSED', 'already used')));
    const transport = new Transport({ baseUrl: 'http://x', retries: 3, retryBaseMs: 0, fetch: fetchImpl as never });
    await expect(transport.postIdempotent('/api/investigations', {}, 'key-1' as never)).rejects.toMatchObject({
      status: 409,
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('Transport.getAllowing', () => {
  it('returns the body on the allowed status instead of throwing', async () => {
    const body = { status: 'degraded', schemaVersion: 11, expectedSchemaVersion: 12, checks: [] };
    const fetchImpl = vi.fn(async () => json(503, body));
    const transport = new Transport({ baseUrl: 'http://x', fetch: fetchImpl as never });
    await expect(transport.getAllowing('/api/health', 503)).resolves.toEqual(body);
  });

  it('still throws on a status that is not the allowed one', async () => {
    const fetchImpl = vi.fn(async () => json(401, envelope('UNAUTHENTICATED', 'Bearer token required')));
    const transport = new Transport({ baseUrl: 'http://x', fetch: fetchImpl as never });
    await expect(transport.getAllowing('/api/health', 503)).rejects.toMatchObject({ status: 401 });
  });

  it('does not retry, because a degraded database does not recover by being asked twice', async () => {
    const fetchImpl = vi.fn(async () => json(500, {}));
    const transport = new Transport({ baseUrl: 'http://x', retries: 3, retryBaseMs: 0, fetch: fetchImpl as never });
    await expect(transport.getAllowing('/api/health', 503)).rejects.toMatchObject({ status: 500 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('Transport.getText', () => {
  it('returns the raw body for a route that does not serve JSON', async () => {
    const exposition = '# HELP credda_http_requests_total ...\ncredda_http_requests_total 3\n';
    const fetchImpl = vi.fn(async () => new Response(exposition, { status: 200 }));
    const transport = new Transport({ baseUrl: 'http://x', fetch: fetchImpl as never });
    await expect(transport.getText('/api/metrics')).resolves.toBe(exposition);
  });
});
