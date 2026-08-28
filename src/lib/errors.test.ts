import { describe, expect, it } from 'vitest';
import { CreddaError, header, isRetryableStatus, toCreddaError } from './errors.js';

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

  it('does not list 429: nothing in the engine API rate limits', () => {
    expect(isRetryableStatus(429)).toBe(false);
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
