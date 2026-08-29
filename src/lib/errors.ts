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
  | 'PAYLOAD_TOO_LARGE'
  | 'UNAVAILABLE'
  | 'TOO_MANY_STREAMS'
  | 'INTERNAL_ERROR';

export class CreddaError extends Error {
  readonly code: string | undefined;
  readonly requestId: string | undefined;

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
  }
}

/**
 * Transient failures worth a second attempt.
 *
 * 429 is deliberately absent: nothing in `apps/api` rate limits, so no route
 * can answer with one and listing it would describe a server that does not
 * exist. 503 is present and is the one to be careful with — `/api/health`
 * answers 503 when a readiness check failed, which is an answer rather than a
 * blip, so `getHealth` does not route through the retry policy at all.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
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
  return new CreddaError(res.status, message || `request failed (${res.status})`, path, {
    code,
    requestId: header(res, 'x-request-id') ?? undefined,
  });
}
