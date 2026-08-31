/**
 * The transport: a typed fetch, a retry policy and a query-string builder.
 *
 * Kept from the pre-1.0 package because none of it was ever about reliability
 * scores. What changed is the error body it parses (`./errors.ts`) and the fact
 * that there is one credential model rather than two: every route under `/api`
 * sits behind one bearer gate (`apps/api/src/auth.ts`), and there is no public,
 * key-less route on this API at all.
 */

import { CreddaError, isRetryableStatus, toCreddaError } from './errors.js';
import type { IdempotencyKey } from './idempotency.js';

/**
 * The header the engine reads on `POST /api/investigations`
 * (`IDEMPOTENCY_HEADER` in `apps/api/src/routes/investigations.ts`). It is the
 * only request header this client sends besides `Authorization` and
 * `Content-Type`.
 */
export const IDEMPOTENCY_HEADER = 'Idempotency-Key';

export interface CreddaConfig {
  /** e.g. `https://credda.internal` or `http://localhost:8080`. No default: see below. */
  baseUrl: string;
  /**
   * The bearer key. Required unless the deployment runs `CREDDA_AUTH=disabled`,
   * in which case the gate is open and `/api/organization` still refuses to
   * guess which organisation you meant.
   */
  apiKey?: string | undefined;
  /**
   * Opt-in retries for transient failures (network errors, 502/503/504 --
   * `isRetryableStatus` is the list, and 503 is on it). `retries`
   * is the number of RE-attempts; 0 is the default. Backoff is
   * `retryBaseMs * 2^n`, capped by `maxRetryDelayMs`.
   *
   * GETs, and the one write that carries an idempotency key.
   * `createInvestigationOnce` sends an `Idempotency-Key`, under which the
   * engine returns the run the first attempt created rather than opening — and
   * billing for — a second, so a repeat of it is exactly-once at the server.
   * `createInvestigation` sends no key and is never retried: without the header
   * the route behaves as it always did, one run per request.
   * `cancelInvestigation` IS idempotent at the server, but a repeat that
   * crosses a worker's heartbeat answers a different status than the attempt it
   * replaced, and a retry policy that swallowed that would hand back
   * "cancelled" for a call that was told "requested".
   */
  retries?: number | undefined;
  retryBaseMs?: number | undefined;
  maxRetryDelayMs?: number | undefined;
  /** Swappable for tests and for runtimes that supply their own fetch. */
  fetch?: typeof fetch | undefined;
}

/** Values a query parameter may take. `undefined` means "do not send it". */
export type QueryValue = string | number | boolean | undefined;

/**
 * Builds `?a=1&b=2`, omitting anything undefined and returning '' when nothing
 * survives, so a defaulted call sends a bare path and the server applies its
 * own defaults rather than this client asserting them.
 */
export function queryString(params: Record<string, QueryValue>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    qs.set(key, String(value));
  }
  const text = qs.toString();
  return text.length > 0 ? `?${text}` : '';
}

export interface RequestOptions {
  /** Aborts the request. Passed straight to `fetch`. */
  signal?: AbortSignal | undefined;
}

export class Transport {
  readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly retries: number;
  private readonly retryBaseMs: number;
  private readonly maxDelayMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: CreddaConfig) {
    if (typeof config.baseUrl !== 'string' || config.baseUrl.trim() === '') {
      // No default base URL, deliberately. Credda runs against a customer's own
      // deployment; a built-in hostname would be this package guessing where a
      // company's engine lives, and a wrong guess sends a bearer key there.
      throw new TypeError('credda: baseUrl is required');
    }
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.retries = Math.max(0, Math.floor(config.retries ?? 0));
    this.retryBaseMs = config.retryBaseMs ?? 300;
    this.maxDelayMs = Math.max(0, config.maxRetryDelayMs ?? 5_000);
    this.fetchImpl = config.fetch ?? globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') {
      throw new TypeError('credda: no fetch available; pass one via config.fetch');
    }
  }

  /** The headers every request carries. Public so the stream reader can reuse them. */
  headers(extra: Record<string, string> = {}): Record<string, string> {
    return this.apiKey === undefined ? { ...extra } : { Authorization: `Bearer ${this.apiKey}`, ...extra };
  }

  url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  raw(path: string, init: RequestInit = {}): Promise<Response> {
    return this.fetchImpl(this.url(path), init);
  }

  private async withRetries<T>(attempt: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let i = 0; i <= this.retries; i++) {
      if (i > 0) {
        const delay = Math.min(this.maxDelayMs, this.retryBaseMs * 2 ** (i - 1));
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      try {
        return await attempt();
      } catch (error) {
        lastError = error;
        // An AbortError is the caller's own decision and is never retried.
        if (error instanceof Error && error.name === 'AbortError') throw error;
        const transient = !(error instanceof CreddaError) || isRetryableStatus(error.status);
        if (!transient) throw error;
      }
    }
    throw lastError;
  }

  async get<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.withRetries(async () => {
      const res = await this.raw(path, {
        headers: this.headers(),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      if (!res.ok) throw await toCreddaError(res, path);
      return (await res.json()) as T;
    });
  }

  /**
   * A GET whose non-2xx status is an answer rather than a failure.
   *
   * Exactly one route needs this: `/api/health` answers 503 with a full
   * readiness report when a check failed, and throwing there would discard the
   * report the caller asked for. It also means health is never retried, which
   * is correct — a degraded database does not become ready by asking twice.
   */
  async getAllowing<T>(path: string, allowStatus: number, options: RequestOptions = {}): Promise<T> {
    const res = await this.raw(path, {
      headers: this.headers(),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!res.ok && res.status !== allowStatus) throw await toCreddaError(res, path);
    return (await res.json()) as T;
  }

  /** A GET returning text. `/api/metrics` serves Prometheus exposition, not JSON. */
  async getText(path: string, options: RequestOptions = {}): Promise<string> {
    return this.withRetries(async () => {
      const res = await this.raw(path, {
        headers: this.headers(),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      if (!res.ok) throw await toCreddaError(res, path);
      return res.text();
    });
  }

  /** Never retried. See `CreddaConfig.retries`. */
  async post<T>(path: string, body: unknown, options: RequestOptions = {}): Promise<T> {
    const { body: parsed } = await this.sendPost<T>(path, body, undefined, options);
    return parsed;
  }

  /**
   * A POST the retry policy is allowed to repeat, because it carries a key the
   * server deduplicates against.
   *
   * The key is a REQUIRED parameter of the only retrying write on this
   * transport, which is the whole point of it being a separate method: there is
   * no argument to omit and no flag to forget, so "retried" and "has a key"
   * cannot come apart. {@link post} has no key parameter and no retries.
   *
   * The status is returned with the body because the create route answers 201
   * when it made a run and 200 when it is handing back one it already made, and
   * that distinction is the caller's, not this transport's, to collapse.
   */
  async postIdempotent<T>(
    path: string,
    body: unknown,
    key: IdempotencyKey,
    options: RequestOptions = {},
  ): Promise<{ status: number; body: T }> {
    return this.withRetries(() => this.sendPost<T>(path, body, key, options));
  }

  private async sendPost<T>(
    path: string,
    body: unknown,
    key: IdempotencyKey | undefined,
    options: RequestOptions,
  ): Promise<{ status: number; body: T }> {
    const res = await this.raw(path, {
      method: 'POST',
      headers: this.headers({
        'Content-Type': 'application/json',
        ...(key === undefined ? {} : { [IDEMPOTENCY_HEADER]: key }),
      }),
      body: JSON.stringify(body),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!res.ok) throw await toCreddaError(res, path);
    return { status: res.status, body: (await res.json()) as T };
  }
}
