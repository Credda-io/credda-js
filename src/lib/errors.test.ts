import { describe, expect, it } from 'vitest';
import { CreddaError, header, isRetryableStatus, parseRetryAfter, toCreddaError } from './errors.js';

/** A Response with a JSON body and headers, without needing a server. */
function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

describe('toCreddaError', () => {
  it('reads code and message out of the engine error envelope', async () => {
    const error = await toCreddaError(
      jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'No such investigation: inv_1' } }),
      '/api/investigations/inv_1',
    );
    expect(error).toBeInstanceOf(CreddaError);
    expect(error.status).toBe(404);
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toBe('credda: No such investigation: inv_1');
    expect(error.path).toBe('/api/investigations/inv_1');
  });

  it('carries the X-Request-Id header into the message, which is what support asks for', async () => {
    const error = await toCreddaError(
      jsonResponse(500, { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, {
        'X-Request-Id': 'req_abc',
      }),
      '/api/validations',
    );
    expect(error.requestId).toBe('req_abc');
    expect(error.message).toContain('(requestId: req_abc)');
  });

  it('survives a non-JSON body, which is what a proxy 502 page is', async () => {
    const error = await toCreddaError(new Response('<html>bad gateway</html>', { status: 502 }), '/api/health');
    expect(error.status).toBe(502);
    expect(error.code).toBeUndefined();
    expect(error.message).toBe('credda: request failed (502)');
  });

  it('does not mistake a legacy flat body for an envelope', async () => {
    // The pre-1.0 trust API answered `{ error: "..." }`. Reading that string as
    // an envelope would produce `[object Object]` in a message; it falls back.
    const error = await toCreddaError(jsonResponse(400, { error: 'bad thing' }), '/api/investigations');
    expect(error.message).toBe('credda: request failed (400)');
  });

  it('is an Error subclass with a stable name, so instanceof and catch-by-name both work', async () => {
    const error = await toCreddaError(jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'Invalid API key' } }), '/api');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('CreddaError');
  });
});

describe('isRetryableStatus', () => {
  it('retries the gateway blips', () => {
    expect(isRetryableStatus(502)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(504)).toBe(true);
  });

  it('lists 429, which is the ingress in front of the engine asking for a pause', () => {
    // This asserted `false` until 2026-08-31, on the grounds that nothing in
    // apps/api rate limits. True, and it never settled the question: the engine
    // does not send 502 or 504 either, and both are above. All three come from
    // the hop between the caller and the engine. The Go client has listed
    // 429/502/503/504 since its rewrite; this is the two agreeing again.
    expect(isRetryableStatus(429)).toBe(true);
  });

  it('never retries a refusal', () => {
    for (const status of [400, 401, 404, 413, 500]) {
      expect(isRetryableStatus(status)).toBe(false);
    }
  });
});

describe('header', () => {
  it('returns null rather than throwing when headers are missing', () => {
    // Hand-rolled test doubles do this, and a TypeError while BUILDING an error
    // would hide the failure that was actually being reported.
    expect(header({} as Response, 'x-request-id')).toBeNull();
  });
});

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-08-31T12:00:00.000Z');

  it('reads the delta-seconds form RFC 9110 permits', () => {
    expect(parseRetryAfter('30', now)).toBe(30_000);
    expect(parseRetryAfter('  30  ', now)).toBe(30_000);
    expect(parseRetryAfter('0', now)).toBe(0);
  });

  it('reads the HTTP-date form, which a proxy may send instead', () => {
    expect(parseRetryAfter('Mon, 31 Aug 2026 12:00:45 GMT', now)).toBe(45_000);
  });

  it('never returns a negative for a date already in the past', () => {
    expect(parseRetryAfter('Mon, 31 Aug 2026 11:59:00 GMT', now)).toBe(0);
  });

  it('ignores what it cannot parse rather than guessing at it', () => {
    // parseInt would read '30s' as 30. A header this client does not understand
    // should fall back to the exponential curve, not to half of a reading.
    for (const raw of [null, '', '   ', '30s', 'soon', '-5', '1.5']) {
      expect(parseRetryAfter(raw, now)).toBe(0);
    }
  });
});

describe('CreddaError.retryAfterMs', () => {
  it('carries a Retry-After the response sent', async () => {
    const error = await toCreddaError(
      new Response(JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'slow down' } }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '12' },
      }),
      '/api/investigations',
    );
    expect(error.status).toBe(429);
    expect(error.retryAfterMs).toBe(12_000);
  });

  it('is undefined when the response carried none, which is the engine itself', async () => {
    const error = await toCreddaError(
      new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'no' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
      '/api/investigations/inv_1',
    );
    expect(error.retryAfterMs).toBeUndefined();
  });
});
