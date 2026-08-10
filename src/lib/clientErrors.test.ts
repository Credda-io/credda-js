/**
 * Error-surface tests for CreddaClient: what an integrator actually gets back
 * when a call fails, and how the opt-in retry policy reacts to the server's
 * own back-off instructions. No network: fetch is stubbed.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { CreddaClient, CreddaError, parseRetryAfterMs } from './client.js';

const BASE = 'https://api.test';
afterEach(() => vi.unstubAllGlobals());

/** A response double WITH headers, like the real thing. */
function res(status: number, body: unknown, headers: Record<string, string> = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n: string) => lower[n.toLowerCase()] ?? null },
    json: async () => body,
  } as unknown as Response;
}

function stubOnce(r: Response) {
  vi.stubGlobal('fetch', vi.fn(async () => r));
}

describe('CreddaError carries what support asks for', () => {
  it('captures the request id from the X-Request-Id header', async () => {
    stubOnce(res(404, { error: 'Not found', code: 'USER_NOT_FOUND', requestId: 'rq-1' }, { 'X-Request-Id': 'rq-1' }));
    const err = await new CreddaClient({ apiBase: BASE }).getScore('u1', 'k').catch((e) => e as CreddaError);
    expect(err).toBeInstanceOf(CreddaError);
    expect(err.requestId).toBe('rq-1');
    expect(err.code).toBe('USER_NOT_FOUND');
    expect(err.status).toBe(404);
    // Surfaced in the message too, so it lands in a plain console.error.
    expect(err.message).toContain('rq-1');
  });

  it('is case-insensitive about the header (proxies rewrite casing)', async () => {
    stubOnce(res(500, { error: 'boom' }, { 'x-request-id': 'rq-2' }));
    const err = await new CreddaClient({ apiBase: BASE }).getScore('u', 'k').catch((e) => e as CreddaError);
    expect(err.requestId).toBe('rq-2');
  });

  it('falls back to the id in the body when the header is missing', async () => {
    stubOnce(res(403, { error: 'nope', code: 'SCOPE_INSUFFICIENT', requestId: 'rq-3' }));
    const err = await new CreddaClient({ apiBase: BASE }).getScore('u', 'k').catch((e) => e as CreddaError);
    expect(err.requestId).toBe('rq-3');
  });

  it('still yields a usable error when the body is not JSON at all', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 502,
      headers: { get: (n: string) => (n.toLowerCase() === 'x-request-id' ? 'rq-4' : null) },
      json: async () => { throw new Error('not json'); },
    } as unknown as Response)));
    const err = await new CreddaClient({ apiBase: BASE }).getScore('u', 'k').catch((e) => e as CreddaError);
    expect(err.status).toBe(502);
    expect(err.requestId).toBe('rq-4'); // the header survives a broken body
    expect(err.message).toContain('502');
  });

  it('does not blow up on a response double with no headers at all', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ error: 'x' }) } as Response)));
    const err = await new CreddaClient({ apiBase: BASE }).getScore('u', 'k').catch((e) => e as CreddaError);
    expect(err).toBeInstanceOf(CreddaError);
    expect(err.requestId).toBeUndefined();
  });

  it('exposes structured validation details', async () => {
    const details = [{ path: 'eventType', message: 'Invalid enum value', code: 'invalid_enum_value' }];
    stubOnce(res(400, { error: 'eventType: Invalid enum value', code: 'VALIDATION_ERROR', details, requestId: 'rq-5' }, { 'X-Request-Id': 'rq-5' }));
    const err = await new CreddaClient({ apiBase: BASE })
      .reportEvent({ userId: 'u', eventType: 'NOPE' as never }, 'k')
      .catch((e) => e as CreddaError);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.details).toEqual(details);
  });
});

describe('parseRetryAfterMs', () => {
  const now = Date.parse('2026-07-22T12:00:00.000Z');

  it('parses whole seconds (what the API always sends)', () => {
    expect(parseRetryAfterMs('30', now)).toBe(30_000);
    expect(parseRetryAfterMs(' 5 ', now)).toBe(5_000);
    expect(parseRetryAfterMs('0', now)).toBe(0);
  });

  it('parses an HTTP-date, which the spec also permits', () => {
    expect(parseRetryAfterMs('Wed, 22 Jul 2026 12:00:20 GMT', now)).toBe(20_000);
  });

  it('never returns a negative delay for a date already past', () => {
    expect(parseRetryAfterMs('Wed, 22 Jul 2026 11:00:00 GMT', now)).toBe(0);
  });

  it('returns null when absent or unparseable, so backoff takes over', () => {
    expect(parseRetryAfterMs(null, now)).toBeNull();
    expect(parseRetryAfterMs(undefined, now)).toBeNull();
    expect(parseRetryAfterMs('', now)).toBeNull();
    expect(parseRetryAfterMs('soon', now)).toBeNull();
  });
});

describe('retries honour Retry-After', () => {
  /** Fails `failures` times with `headers`, then succeeds. Records wait times. */
  function flaky(failures: number, status: number, headers: Record<string, string>) {
    let calls = 0;
    const waits: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.stubGlobal('setTimeout', ((fn: () => void, ms?: number) => {
      waits.push(ms ?? 0);
      return realSetTimeout(fn, 0); // run immediately; we only assert the ask
    }) as unknown as typeof setTimeout);
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++;
      return calls <= failures
        ? res(status, { error: 'slow down', code: 'RATE_LIMIT_EXCEEDED' }, headers)
        : res(200, { ok: true });
    }));
    return { waits, calls: () => calls };
  }

  it('waits exactly as long as the server asked, not the backoff default', async () => {
    const f = flaky(1, 429, { 'Retry-After': '2' });
    await new CreddaClient({ apiBase: BASE, retries: 1, retryBaseMs: 300 }).getScore('u', 'k');
    expect(f.calls()).toBe(2);
    expect(f.waits[0]).toBe(2000); // NOT 300ms
  });

  it('falls back to exponential backoff when no Retry-After is sent', async () => {
    const f = flaky(2, 503, {});
    await new CreddaClient({ apiBase: BASE, retries: 2, retryBaseMs: 100 }).getScore('u', 'k');
    expect(f.waits).toEqual([100, 200]);
  });

  it('caps a huge Retry-After so a monthly quota reset cannot hang the call', async () => {
    // QUOTA_EXCEEDED can legitimately say "come back in 9 days".
    const f = flaky(1, 429, { 'Retry-After': String(9 * 24 * 3600) });
    await new CreddaClient({ apiBase: BASE, retries: 1, retryBaseMs: 100, maxRetryDelayMs: 5_000 }).getScore('u', 'k');
    expect(f.waits[0]).toBe(5_000);
  });

  it('exposes retryAfterMs on the thrown error when retries are exhausted', async () => {
    stubOnce(res(429, { error: 'quota', code: 'QUOTA_EXCEEDED' }, { 'Retry-After': '45', 'X-Request-Id': 'rq-9' }));
    const err = await new CreddaClient({ apiBase: BASE }).getScore('u', 'k').catch((e) => e as CreddaError);
    expect(err.retryAfterMs).toBe(45_000);
    expect(err.requestId).toBe('rq-9');
  });
});

describe('reference catalogs', () => {
  it('getErrorCatalog hits GET /api/v1/errors', async () => {
    let url = '';
    vi.stubGlobal('fetch', vi.fn(async (u: string) => { url = String(u); return res(200, { codes: [{ code: 'NOT_FOUND', retryable: false }] }); }));
    const cat = await new CreddaClient({ apiBase: BASE }).getErrorCatalog();
    expect(url).toBe(`${BASE}/api/v1/errors`);
    expect(cat.codes[0].code).toBe('NOT_FOUND');
  });

  it('getEnums hits GET /api/v1/enums', async () => {
    let url = '';
    vi.stubGlobal('fetch', vi.fn(async (u: string) => { url = String(u); return res(200, { note: 'n', enums: [{ name: 'eventType', values: [] }] }); }));
    const cat = await new CreddaClient({ apiBase: BASE }).getEnums();
    expect(url).toBe(`${BASE}/api/v1/enums`);
    expect(cat.enums[0].name).toBe('eventType');
  });

  it('both are public: no Authorization header is sent', async () => {
    let init: RequestInit | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_u: string, i?: RequestInit) => { init = i; return res(200, {}); }));
    await new CreddaClient({ apiBase: BASE }).getErrorCatalog();
    expect(init?.headers).toBeUndefined();
  });

  it('surface a CreddaError on a non-2xx like every other method', async () => {
    stubOnce(res(503, { error: 'down' }, { 'X-Request-Id': 'rq-x' }));
    await expect(new CreddaClient({ apiBase: BASE }).getEnums()).rejects.toBeInstanceOf(CreddaError);
  });
});
