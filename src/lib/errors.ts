/**
 * The error taxonomy, kept from the pre-1.0 transport because it is about HTTP
 * and not about any particular product. What changed is the body it parses:
 * the engine API answers a failure with `{ error: { code, message } }` from
 * `apps/api/src/errors.ts`, not with a bare `error` string.
 */

export interface CreddaErrorContext {
  /** The API's own machine-readable code, e.g. `NOT_FOUND`, `VALIDATION_FAILED`. */
  code?: string | undefined;
  /** The `X-Request-Id` the server echoed. The one thing support asks for. */
  requestId?: string | undefined;
  /** Parsed from `Retry-After`, in milliseconds. See `CreddaError.retryAfterMs`. */
  retryAfterMs?: number | undefined;
}

/**
 * Every code the engine API can put in `error.code` today, read off
 * `apps/api/src/errors.ts`, `auth.ts`, `organization.ts`, `stream.ts` and
 * `routes/investigations.ts`, and cross-checked against `ERROR_CODES` in
 * `apps/api/src/openapi.ts`, which that repository's own test proves is the
 * REACHABLE set rather than the declared one.
 *
 * `UNAVAILABLE` is the one member below that no response can actually carry: it
 * is the default second argument of `unavailable()` and every call site passes
 * its own code over it. Kept because removing an exported member of a published
 * union breaks a build for no gain, and flagged here so it is not read as a
 * status somebody should branch on.
 *
 * A string union rather than an enum, and `CreddaError.code` is typed
 * `string | undefined` rather than this: a server ahead of this package can
 * introduce a code, and a client that refuses to carry an unknown one would
 * turn a new failure mode into an unreadable error.
 */
export type CreddaErrorCode =
  | 'INVALID_REQUEST'
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'NOT_FOUND'
  | 'NO_ORGANIZATION'
  /** 409, cancel route only: the run reached a terminal state. Nothing to stop. */
  | 'ALREADY_FINISHED'
  /** 409, cancel route only: the run is executing outside the job queue. */
  | 'NOT_CANCELLABLE'
  /**
   * 409, create route only: the `Idempotency-Key` on the request already stands
   * for a DIFFERENT body. Neither run is disclosed — the earlier one would
   * answer a question this caller never asked, and a new one is the duplicate
   * the key was sent to prevent. Mint a new key for a new report; see
   * `idempotentCreate`.
   */
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNAVAILABLE'
  | 'TOO_MANY_STREAMS'
  | 'INTERNAL_ERROR';

export class CreddaError extends Error {
  readonly code: string | undefined;
  readonly requestId: string | undefined;
  /**
   * `Retry-After` in milliseconds, or undefined when the response carried none.
   *
   * The 1.0 notes said this field was dropped "because nothing in this API
   * sends either". That is true of the engine and was never the whole path: a
   * bearer-gated deployment sits behind the customer's own ingress, and it is
   * that hop -- not the engine -- which answers 429 and sets this header. The
   * Go client has read it since its rewrite (`errors.go`, `parseRetryAfter`),
   * so the two clients disagreed about the same wire.
   */
  readonly retryAfterMs: number | undefined;

  constructor(
    readonly status: number,
    message: string,
    readonly path: string,
    context: CreddaErrorContext = {},
  ) {
    super(
      context.requestId
        ? `credda: ${message} (requestId: ${context.requestId})`
        : `credda: ${message}`,
    );
    this.name = 'CreddaError';
    this.code = context.code;
    this.requestId = context.requestId;
    this.retryAfterMs = context.retryAfterMs;
  }
}

/**
 * Transient failures worth a second attempt.
 *
 * 429 USED TO BE ABSENT, on the reasoning that nothing in `apps/api` rate
 * limits, so no route can answer with one. The premise is right and the
 * conclusion did not follow, because this list already held the
 * counter-example: the engine does not send 502 or 504 either. Those are what a
 * gateway in front of it sends — this package's own error test calls 502 "what
 * a proxy 502 page is". Credda runs against a customer's own deployment, behind
 * the customer's own ingress, and that hop is the thing that rate limits.
 * Excluding the one proxy status meaning "come back shortly" while retrying the
 * two meaning "something upstream broke" was the list disagreeing with itself.
 *
 * It also disagreed with the Go client, which has listed 429/502/503/504 since
 * its rewrite (`retryable` in client.go). Two clients over one API answering
 * differently is the drift both surface tests exist to prevent, and nothing in
 * either repository argued for the difference.
 *
 * 503 is the one to be careful with — `/api/health` answers 503 when a
 * readiness check failed, which is an answer rather than a blip, so `getHealth`
 * does not route through the retry policy at all.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

/**
 * `Retry-After` as milliseconds: 0 when absent, unparseable, or already past.
 *
 * Both forms RFC 9110 permits are accepted, because a proxy may send either:
 * delta-seconds (`Retry-After: 30`) and an HTTP-date (`Retry-After: Wed, 21 Oct
 * 2026 07:28:00 GMT`). Mirrors `parseRetryAfter` in the Go client, down to
 * never returning a negative.
 *
 * Digits only for the delta form. `parseInt` would read `30s` as 30, and a
 * header this client cannot parse should be ignored rather than guessed at.
 *
 * `now` is a parameter so the date form can be tested without freezing a clock.
 */
export function parseRetryAfter(raw: string | null, now: number = Date.now()): number {
  const text = raw?.trim() ?? '';
  if (text === '') return 0;
  if (/^[0-9]+$/.test(text)) return Number(text) * 1_000;
  const at = Date.parse(text);
  if (Number.isNaN(at)) return 0;
  return Math.max(0, at - now);
}

/** Read one header defensively: a TypeError while BUILDING an error hides the real failure. */
export function header(res: Response, name: string): string | null {
  try {
    return res.headers?.get?.(name) ?? null;
  } catch {
    return null;
  }
}

/** Turn a non-2xx response into a `CreddaError`, preserving code and request id. */
export async function toCreddaError(res: Response, path: string): Promise<CreddaError> {
  let message = '';
  let code: string | undefined;
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    message = body.error?.message ?? '';
    code = body.error?.code;
  } catch {
    /* non-JSON error body (a proxy's 502 page, say) */
  }
  const retryAfterMs = parseRetryAfter(header(res, 'retry-after'));
  return new CreddaError(res.status, message || `request failed (${res.status})`, path, {
    code,
    requestId: header(res, 'x-request-id') ?? undefined,
    ...(retryAfterMs > 0 ? { retryAfterMs } : {}),
  });
}
