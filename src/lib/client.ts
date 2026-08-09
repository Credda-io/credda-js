/**
 * Credda API client.
 *
 * Two access models, matching the API:
 *   • Public  — resolveToken(shareToken) hits GET /api/v1/verify/:token. No key.
 *               Safe to run in a browser. This is what trust badges use.
 *   • Platform — getScore()/getExplain()/… send a platform API key as a Bearer
 *               token. These are for SERVER-SIDE / trusted use only — never ship
 *               a `crd_live_…` key to a browser bundle. Use resolveToken there.
 */

import {
  verifyTrustCredential,
  verifyVerifiableCredential,
  type VerifiedCredential,
  type VerifiedVc,
} from './credential.js';

export interface CreddaConfig {
  apiBase?: string;
  /**
   * Opt-in automatic retries for TRANSIENT failures (network errors, 429,
   * 502/503/504). Applied to GETs always, and to POSTs ONLY when the request
   * carries an Idempotency-Key — a non-idempotent write is never retried, so
   * enabling this can't double-report an event. `retries` is the number of
   * RE-attempts (0 = off, the default); backoff is `retryBaseMs * 2^n` (base
   * 300ms) capped at 5s.
   */
  retries?: number;
  retryBaseMs?: number;
  /**
   * Ceiling on any single backoff wait, including one the server asked for via
   * `Retry-After` (default 5s). A monthly-quota 429 can carry a `Retry-After`
   * of days; without a cap an opt-in retry would silently hang the call.
   */
  maxRetryDelayMs?: number;
}

const DEFAULT_BASE = 'https://api.credda.io';
const API_PREFIX = '/api/v1';

/** Transient failures worth retrying: rate limit + upstream/gateway blips. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

/**
 * Parse a `Retry-After` header into milliseconds. Pure — unit tested.
 *
 * The API sends whole seconds on every 429; HTTP also permits an HTTP-date, so
 * both are accepted. Returns null when absent/unparseable (the caller then
 * falls back to exponential backoff), and never returns a negative delay.
 */
export function parseRetryAfterMs(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, at - now);
}

/**
 * Read one header off a response. Defensive on purpose: `fetch` always supplies
 * `headers`, but hand-rolled test doubles and some polyfills don't, and a
 * TypeError while BUILDING an error would hide the real failure.
 */
function header(res: Response, name: string): string | null {
  try {
    return res.headers?.get?.(name) ?? null;
  } catch {
    return null;
  }
}

/**
 * Turn a non-2xx response into a `CreddaError`, preserving everything an
 * integrator needs to debug it later: the API's `code`, its `requestId` (the
 * one thing support asks for), any structured `details`, and `Retry-After`.
 */
async function toCreddaError(res: Response, path: string): Promise<CreddaError> {
  let detail = '';
  let code: string | undefined;
  let details: unknown;
  let bodyRequestId: string | undefined;
  try {
    const body = (await res.json()) as {
      error?: string; message?: string; code?: string; details?: unknown; requestId?: string;
    };
    detail = body.error ?? body.message ?? '';
    code = body.code;
    details = body.details;
    bodyRequestId = body.requestId;
  } catch {
    /* non-JSON error body */
  }
  return new CreddaError(res.status, detail || `request failed (${res.status})`, path, {
    code,
    details,
    // The header is authoritative (it is present even on a non-JSON failure);
    // the body echoes the same id.
    requestId: header(res, 'x-request-id') ?? bodyRequestId,
    retryAfterMs: parseRetryAfterMs(header(res, 'retry-after')),
  });
}

export class CreddaClient {
  private readonly base: string;
  private readonly retries: number;
  private readonly retryBaseMs: number;
  private readonly maxDelayMs: number;

  constructor(config: CreddaConfig = {}) {
    this.base = (config.apiBase ?? DEFAULT_BASE).replace(/\/+$/, '');
    this.retries = Math.max(0, Math.floor(config.retries ?? 0));
    this.retryBaseMs = config.retryBaseMs ?? 300;
    this.maxDelayMs = Math.max(0, config.maxRetryDelayMs ?? 5_000);
  }

  /**
   * Run `attempt` with the configured retry policy. Only used for requests
   * that are safe to repeat (GETs, idempotency-keyed POSTs). Retries on
   * network errors and retryable HTTP statuses; rethrows everything else.
   */
  private async withRetries<T>(retryable: boolean, attempt: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    const tries = retryable ? this.retries + 1 : 1;
    for (let i = 0; i < tries; i++) {
      if (i > 0) {
        // Honour the server's own `Retry-After` when it sent one — it knows
        // exactly when the window resets, and backing off for less than it
        // asked just earns another 429. Fall back to exponential backoff
        // otherwise. Capped either way so a long quota reset can't hang a call.
        const serverAsked =
          lastError instanceof CreddaError ? lastError.retryAfterMs : null;
        const backoff = this.retryBaseMs * 2 ** (i - 1);
        const delay = Math.min(this.maxDelayMs, serverAsked ?? backoff);
        await new Promise((r) => setTimeout(r, delay));
      }
      try {
        return await attempt();
      } catch (err) {
        lastError = err;
        const transient = !(err instanceof CreddaError) || isRetryableStatus(err.status);
        if (!transient) throw err;
      }
    }
    throw lastError;
  }

  private async get<T>(path: string, apiKey?: string): Promise<T> {
    return this.withRetries(true, async () => {
      const res = await fetch(`${this.base}${API_PREFIX}${path}`, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      });
      if (!res.ok) throw await toCreddaError(res, path);
      return res.json() as Promise<T>;
    });
  }

  private async post<T>(
    path: string,
    body: unknown,
    apiKey: string,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    // POSTs retry only when idempotency-keyed — repeating any other write
    // could double-report.
    const retryable = Boolean(extraHeaders && 'Idempotency-Key' in extraHeaders);
    return this.withRetries(retryable, async () => {
      const res = await fetch(`${this.base}${API_PREFIX}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, ...extraHeaders },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw await toCreddaError(res, path);
      return res.json() as Promise<T>;
    });
  }

  /**
   * POST to an endpoint that is deliberately KEYLESS — the caller's capability
   * is a one-time token carried in the body, not a platform API key. Today that
   * is only the confirmation-response endpoint: the counterparty confirming an
   * outcome is not a Credda customer and holds no key.
   *
   * Never retried. These endpoints are single-use by design, so repeating one
   * cannot succeed — it would only turn a delivered-but-slow response into a
   * confusing 409.
   */
  private async postPublic<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.base}${API_PREFIX}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await toCreddaError(res, path);
    return res.json() as Promise<T>;
  }

  /** GET a path relative to the API root (not the /api/v1 prefix) — for /.well-known/* discovery docs. */
  private async getWellKnown<T>(path: string): Promise<T> {
    const res = await fetch(`${this.base}${path}`);
    if (!res.ok) throw await toCreddaError(res, path);
    return res.json() as Promise<T>;
  }

  private async patch<T>(path: string, body: unknown, apiKey: string): Promise<T> {
    const res = await fetch(`${this.base}${API_PREFIX}${path}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await toCreddaError(res, path);
    return res.json() as Promise<T>;
  }

  private async del(path: string, apiKey: string): Promise<void> {
    const res = await fetch(`${this.base}${API_PREFIX}${path}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw await toCreddaError(res, path);
  }

  // ── Public (no key) ─────────────────────────────────────────────────────────

  /** Resolve a public share token to a minimal, PII-free trust payload. */
  resolveToken(token: string): Promise<TrustPayload> {
    return this.get<TrustPayload>(`/verify/${encodeURIComponent(token)}`);
  }

  /**
   * Fetch the portable, self-verifying trust export for a share token: current
   * public score + score history + a signed W3C credential + a revocation pointer.
   * Verify the embedded credential offline with `verifyVerifiableCredential`.
   */
  getTrustExport(token: string): Promise<TrustExport> {
    return this.get<TrustExport>(`/verify/${encodeURIComponent(token)}/export`);
  }

  /**
   * The counterparty-confirmed DELIVERY RECEIPTS behind a share token, plus a
   * signed W3C credential of that record (`CreddaDeliveryReceiptCredential`, and
   * `CreddaAgentDeliveryCredential` when the subject is an agent). Public — the
   * token is the capability, so an agent can present one string mid-negotiation
   * and the counterparty verifies the credential offline with
   * `verifyVerifiableCredential`.
   *
   * `confirmedDeliveries` counts ONLY outcomes a DISTINCT counterparty attested:
   * an agent's own operator can never confirm its work. This is a delivery
   * record — not a safety, alignment or capability rating, and never a
   * recommendation.
   */
  getDeliveryReceipts(token: string): Promise<DeliveryReceiptsPayload> {
    return this.get<DeliveryReceiptsPayload>(`/verify/${encodeURIComponent(token)}/delivery-receipts`);
  }

  /**
   * The developer plan catalog — the tiers (Starter / Growth / Enterprise), their
   * default key scopes, per-minute rate limits, and feature matrix. This is the
   * same data the API enforces and the pricing page renders, so it never drifts.
   * Public (no key). Each tier carries its official monthly price
   * (`priceUsdMonthly`); self-serve checkout is not live yet.
   */
  getPlans(): Promise<PlanCatalog> {
    return this.get<PlanCatalog>('/plans');
  }

  /**
   * The outbound webhook event catalog — every event type the API can send, the
   * common delivery envelope, an example payload per event, and how to verify a
   * delivery signature. Public (no key). Webhooks are advisory: no event can
   * change anyone's score.
   */
  getWebhookEvents(): Promise<WebhookEventCatalog> {
    return this.get<WebhookEventCatalog>('/webhooks/events');
  }

  /**
   * The industry outcome-template catalog — for each real-world industry, the
   * concrete outcomes that matter, the ingest event type to report each one as,
   * a suggested stake, and (the load-bearing part) WHO the third-party witness
   * is. Public (no key), same shape as `/plans` and `/webhooks/events`. Pass an
   * `industry` slug to filter to one set. Guidance only: nothing here scores,
   * writes, or ranks anyone — a template never sets `isVerified`, only a genuine
   * witness confirming the outcome does.
   */
  getOutcomeTemplates(industry?: string): Promise<OutcomeTemplatesCatalog> {
    const q = industry ? `?industry=${encodeURIComponent(industry)}` : '';
    return this.get<OutcomeTemplatesCatalog>(`/outcome-templates${q}`);
  }

  /**
   * The machine-readable error catalog — every stable `code` the API can
   * return, with what it means, what to do about it, and whether a retry can
   * help. Derived server-side from the same catalog the errors are built from,
   * so it can never document a code that doesn't exist (or miss one that does).
   * Public (no key).
   */
  getErrorCatalog(): Promise<ErrorCatalog> {
    return this.get<ErrorCatalog>('/errors');
  }

  /**
   * The API version contract and the dated changelog. Public (no key).
   *
   * `versioning` says exactly what "v1 is additive-only" guarantees — what can
   * appear without notice (new endpoints, response fields, optional inputs,
   * enum values, error codes, webhook event types) and what would require a new
   * major version. `deprecations` is empty while nothing is deprecated; a
   * deprecated endpoint additionally answers with `Deprecation` (RFC 9745) and
   * `Sunset` (RFC 8594) headers. `entries` are newest-first.
   */
  getChangelog(): Promise<ApiChangelog> {
    return this.get<ApiChangelog>('/changelog');
  }

  /**
   * Self-describing enums — every closed value set on the wire (`eventType`,
   * `stakeLevel`, `scoreBand`, `disputeStatus`, `platformTier`) with a human
   * description per value plus the facts that matter (stake weights, band
   * floors, platform trust multipliers). Derived from the constants the API
   * enforces, so you can build a picker or a validator without hard-coding the
   * lists. Public (no key).
   */
  getEnums(): Promise<EnumCatalog> {
    return this.get<EnumCatalog>('/enums');
  }

  /**
   * The adverse-action reason-code catalog — the stable, versioned meaning of
   * every reason code the scoring explanation can attribute to a record, each
   * with a consumer-facing description, a `factor` and a `direction`
   * (`adverse` / `supporting`). Built for B2B2C partners that must issue an
   * ECOA / Regulation B statement of specific reasons: read a subject's ranked
   * codes from `getScoreExplain(...)` (`reasonCodes`) and draw the notice from
   * the adverse ones. Public (no key). Credda supplies the attribution only —
   * it is not a creditor and issues no decision or notice.
   */
  getReasonCodes(): Promise<ReasonCodeCatalog> {
    return this.get<ReasonCodeCatalog>('/reason-codes');
  }

  /**
   * The benchmark catalog — the legitimate, ledger-derived cohort dimensions
   * (`all`, `subjectType`, `verificationDepthBand`, `activityVolumeBand`,
   * `tenureBand`), the statistics returned, and the k-anonymity floor. Public
   * (no key). A benchmark is a distribution fact — where a score falls relative
   * to a population — never a rating, ranking, or verdict on a subject.
   */
  getBenchmarks(): Promise<BenchmarkCatalog> {
    return this.get<BenchmarkCatalog>('/benchmarks');
  }

  /**
   * Aggregate score distribution for a cohort (median/mean/p25/p75/p90 + band
   * histogram). Omit `cohort` to get every cohort value on the dimension. Any
   * cohort below the k-anonymity floor comes back `available:false` with no
   * numbers. Read-only; scans the population (keyed, `scores:read`). A test key
   * benchmarks only the test population.
   */
  getBenchmarkDistribution(
    apiKey: string,
    query: { dimension?: string; cohort?: string } = {},
  ): Promise<BenchmarkDistributionPayload> {
    const qs = new URLSearchParams();
    if (query.dimension) qs.set('dimension', query.dimension);
    if (query.cohort) qs.set('cohort', query.cohort);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return this.get<BenchmarkDistributionPayload>(`/benchmarks/distribution${suffix}`, apiKey);
  }

  /**
   * Where a single subject sits within a cohort — their percentile rank plus the
   * cohort's aggregate distribution. `available:false` (`insufficient_data`)
   * when the cohort is below the k-anonymity floor, or (`no_score`) when the
   * subject has no computed score yet. The REAL comparison, distinct from the
   * deprecated `Score.percentile` (100 − score). A percentile is not a verdict.
   */
  getUserBenchmark(
    userId: string,
    apiKey: string,
    query: { dimension?: string } = {},
  ): Promise<UserBenchmarkPayload> {
    const qs = new URLSearchParams();
    if (query.dimension) qs.set('dimension', query.dimension);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return this.get<UserBenchmarkPayload>(
      `/users/${encodeURIComponent(userId)}/benchmark${suffix}`,
      apiKey,
    );
  }

  /**
   * Verify a Verifiable Trust Credential OFFLINE against this issuer's JWKS.
   * Resolves with the attested facts, or rejects if signature/expiry/issuer is
   * invalid. Once the JWKS is cached, no network call to Credda is made.
   */
  verifyCredential(credential: string): Promise<VerifiedCredential> {
    return verifyTrustCredential(credential, { apiBase: this.base });
  }

  /**
   * Verify a W3C Verifiable Credential (VC-JWT) offline. Resolves the issuer's
   * did:web DID document (with a JWKS fallback to this client's apiBase).
   */
  verifyVerifiableCredential(vcJwt: string): Promise<VerifiedVc> {
    return verifyVerifiableCredential(vcJwt, { apiBase: this.base });
  }

  /**
   * Fetch Credda's `did:web` DID document — issuer identity, verification keys,
   * and service endpoints (incl. the trust registry). Public discovery doc, no key.
   */
  getDidDocument(): Promise<DidDocument> {
    return this.getWellKnown<DidDocument>('/.well-known/did.json');
  }

  /**
   * Fetch the trust registry: Credda's own issuer entry plus any federated
   * issuers it recognizes (Trust Fabric v3 federation). Public discovery doc, no key.
   */
  getTrustRegistry(): Promise<TrustRegistry> {
    return this.getWellKnown<TrustRegistry>('/.well-known/credda-trust-registry.json');
  }

  /**
   * Fetch the OID4VCI Credential Issuer Metadata — the credential
   * configurations Credda can issue into a wallet, and the protocol endpoints
   * that do it. Public discovery doc, no key.
   *
   * This is the only wallet-flow call the SDK wraps on purpose: the token /
   * nonce / credential exchange belongs to the WALLET, which speaks OID4VCI
   * natively and does not need a Credda client to do it. Minting the offer
   * that starts the flow is a keyed server call — see `createCredentialOffer`.
   */
  getCredentialIssuerMetadata(): Promise<CredentialIssuerMetadata> {
    return this.getWellKnown<CredentialIssuerMetadata>('/.well-known/openid-credential-issuer');
  }

  /**
   * The closed set of Open Badges 3.0 achievements the Credda issuer key will
   * sign, served unauthenticated from the issuing host. Every signed
   * credential's `achievement.id` resolves here, so a verifier reads the
   * criteria from the ISSUER rather than trusting the narrative embedded in the
   * document it is checking. Public (no key), read-only.
   */
  getOpenBadgeAchievements(): Promise<OpenBadgeAchievementsPayload> {
    return this.get<OpenBadgeAchievementsPayload>('/open-badges/achievements');
  }

  /**
   * One Open Badges 3.0 achievement definition by id. 404 for anything not on
   * the allowlist — an achievement Credda will not sign has no definition to
   * resolve. Public (no key).
   */
  getOpenBadgeAchievement(badgeId: string): Promise<OpenBadgeAchievement> {
    return this.get<OpenBadgeAchievement>(`/open-badges/achievements/${encodeURIComponent(badgeId)}`);
  }

  /**
   * The subject's PROFESSIONAL RECORD behind a public share token — the
   * résumé-shaped summary of their verified work record, alongside the usual
   * public trust payload. Public (no key): the token is the subject's own
   * consent to present it.
   *
   * Requests `scope=full` because the API serves the record block ONLY at full
   * disclosure — a `band`/`minimal` embed must never carry it. The block is
   * fail-safe `null` if it cannot be derived.
   *
   * It describes a record the subject chose to present. It is NOT a hiring
   * verdict, a background check, or a consumer report.
   */
  getPublicProfessionalRecord(token: string): Promise<PublicProfessionalRecordPayload> {
    return this.get<PublicProfessionalRecordPayload>(
      `/verify/${encodeURIComponent(token)}?scope=full&professional=1`,
    );
  }

  // ── Platform (server-side, API key) ─────────────────────────────────────────

  /** Latest computed score for a user. Requires a platform API key. */
  getScore(userId: string, apiKey: string): Promise<ScorePayload> {
    return this.get<ScorePayload>(`/users/${encodeURIComponent(userId)}/score`, apiKey);
  }

  /**
   * Batch score read: latest score + band for up to 100 users in one call, so a
   * platform scoring many counterparties doesn't fan out N requests. Read-only.
   * Unknown ids come back as `{ userId, error: 'not_found' }` — a partial batch
   * still succeeds. Results are in request order.
   */
  getScores(userIds: string[], apiKey: string): Promise<BatchScoresPayload> {
    return this.post<BatchScoresPayload>('/users/scores', { userIds }, apiKey);
  }

  /**
   * List YOUR OWN book of subjects — every subject the calling platform has
   * reported at least one event for — with each one's current score + band,
   * verification depth, your event counts, last-activity and subject type.
   * Cursor-paginated. Strictly scoped to your own subjects (never another
   * platform's), with test/live isolation; read-only under `scores:read`.
   *
   * Filter with a closed set (`scoreMin`/`scoreMax`, `band`, `hasScore`,
   * `scoreFrozen`, `subjectType`, `activeSince`, `registeredSince`/
   * `registeredBefore`, `hasVerifiedEvents`, `minVerifiedEvents`) and sort by
   * `score` (default) / `registered` / `externalId`. `event`/last-activity
   * counts are scoped to YOUR events. For a whole-book CSV export, add
   * `format=csv` — a raw-fetch use case (this method returns parsed JSON).
   *
   * A subject whose score has not been computed yet comes back with
   * `finalScore: null` / `scoreBand: null` — never a placeholder number.
   */
  listUsers(apiKey: string, query: ListUsersQuery = {}): Promise<ListUsersPayload> {
    const qs = bookFilterParams(query);
    if (query.sort) qs.set('sort', query.sort);
    if (query.order) qs.set('order', query.order);
    if (query.limit != null) qs.set('limit', String(query.limit));
    if (query.cursor) qs.set('cursor', query.cursor);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return this.get<ListUsersPayload>(`/users${suffix}`, apiKey);
  }

  /**
   * Size and shape a segment of your book WITHOUT paging it: how many subjects
   * match, how many are scored, their band mix and median/mean. Takes the same
   * closed filter set as `listUsers`, and is built from the identical
   * tenant-scoped query — so it can never count a subject the listing would not
   * show you. Read-only under `scores:read`.
   *
   * `central.median` / `central.mean` are `null` when nothing in the segment is
   * scored (a 0 would read as a real, catastrophic score), and an oversized
   * population returns the exact `matched` count with null aggregates plus an
   * `aggregationSkipped` reason rather than a partial one presented as whole.
   */
  getBookSummary(apiKey: string, query: BookFilterQuery = {}): Promise<BookSummaryPayload> {
    const qs = bookFilterParams(query);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return this.get<BookSummaryPayload>(`/users/summary${suffix}`, apiKey);
  }

  /** Plain-language breakdown of a user's score. */
  getScoreExplain(userId: string, apiKey: string): Promise<ScoreExplainPayload> {
    return this.get<ScoreExplainPayload>(
      `/users/${encodeURIComponent(userId)}/score/explain`,
      apiKey,
    );
  }

  /**
   * Evidence-based trust explanation: a deterministic summary + strengths +
   * risks, every claim derived from ledger facts. Deliberately contains NO
   * verdict — Credda explains evidence; the caller decides against their own
   * bar. Pass `{ narrative: true }` to also request an advisory AI retelling
   * of the same facts (present only when the API's AI subsystem is enabled).
   */
  getTrustSummary(userId: string, apiKey: string, opts?: { narrative?: boolean }): Promise<TrustSummaryPayload> {
    const qs = opts?.narrative ? '?narrative=1' : '';
    return this.get<TrustSummaryPayload>(
      `/users/${encodeURIComponent(userId)}/trust-summary${qs}`,
      apiKey,
    );
  }

  /**
   * Reliability at dispatch — the compact record read to make before assigning a
   * shift: score/band/confidence, verified-evidence counts, `noShowRate`, the
   * on-time component, recency and the top ranked drivers, in a sub-1KB payload.
   *
   * Read-only: it projects the score the engine already computed and counts over
   * the append-only ledger — it never computes or writes a score, and a subject
   * that has never been scored reads `null` rather than triggering a computation.
   *
   * **Evidence, not a verdict.** No field says call / don't-call or fit / unfit;
   * you apply your own criteria and own the decision. If you use this read to
   * SELECT workers, FCRA (or a local equivalent) may attach to that decision —
   * scope it with your counsel.
   */
  getDispatchReliability(userId: string, apiKey: string): Promise<DispatchReliabilityPayload> {
    return this.get<DispatchReliabilityPayload>(
      `/users/${encodeURIComponent(userId)}/reliability?context=dispatch`,
      apiKey,
    );
  }

  /**
   * Verified Earnings — an attestation of income ALREADY RECORDED on the ledger:
   * monthly buckets with per-platform breakdown plus stability metrics (median /
   * mean monthly, volatility, months with earnings, longest consecutive run,
   * trailing-12m total).
   *
   * Only counterparty/platform-VERIFIED outcomes are attested; unverified value
   * comes back separately as `unverifiedReported` and is never blended in.
   * `currency` is always null — amounts are platform-reported units.
   *
   * This attests recorded outcomes. It is NOT an income verification for a
   * credit decision, NOT a consumer report, and it makes no representation of
   * completeness. Nothing is projected. See `disclosures` on every response.
   */
  getEarnings(userId: string, apiKey: string, query: EarningsQuery = {}): Promise<VerifiedEarnings> {
    return this.get<VerifiedEarnings>(
      `/users/${encodeURIComponent(userId)}/earnings${earningsQs(query)}`,
      apiKey,
    );
  }

  /** The same attestation reduced to the handful of figures a lender reads. */
  getEarningsSummary(userId: string, apiKey: string, query: EarningsQuery = {}): Promise<EarningsSummary> {
    return this.get<EarningsSummary>(
      `/users/${encodeURIComponent(userId)}/earnings/summary${earningsQs(query)}`,
      apiKey,
    );
  }

  /**
   * Mint a signed Verified Earnings Credential (W3C VC-JWT, type
   * `CreddaEarningsCredential`) so the subject can prove the recorded income
   * offline. Carries a StatusList2021 `credentialStatus` like every Credda VC.
   * Verify it with `verifyVerifiableCredential()`. Refuses test-mode users.
   */
  mintEarningsCredential(
    userId: string,
    apiKey: string,
    options: EarningsQuery & { ttlSeconds?: number } = {},
  ): Promise<EarningsCredentialResult> {
    return this.post<EarningsCredentialResult>(
      `/users/${encodeURIComponent(userId)}/earnings/credential`,
      options,
      apiKey,
    );
  }

  /**
   * Factor-level explanation of the user's last score change (diff of the two
   * latest snapshots): which factors moved, whether each helped, and the top
   * driver. `{ available: false }` until at least two computations exist.
   */
  getScoreDelta(userId: string, apiKey: string): Promise<ScoreDeltaPayload> {
    return this.get<ScoreDeltaPayload>(
      `/users/${encodeURIComponent(userId)}/score/delta`,
      apiKey,
    );
  }

  /**
   * The score reframed as named, independently 0–100-scored components
   * (Reliability, Timeliness, Trustworthiness, Verification Confidence,
   * Consistency, Momentum) — "a modular score, not one number". Pure
   * relabeling of the same data `getScoreExplain` exposes; cannot regress
   * `finalScore`. `{ available: false }` until a score has been computed.
   */
  getScoreComponents(userId: string, apiKey: string): Promise<ScoreComponentsPayload> {
    return this.get<ScoreComponentsPayload>(
      `/users/${encodeURIComponent(userId)}/score/components`,
      apiKey,
    );
  }

  /** Historical score snapshots (optionally windowed, cursor-paginated). */
  getScoreHistory(
    userId: string,
    apiKey: string,
    query: { from?: string; to?: string; limit?: number; cursor?: string } = {},
  ): Promise<ScoreHistoryPayload> {
    const qs = new URLSearchParams();
    if (query.from) qs.set('from', query.from);
    if (query.to) qs.set('to', query.to);
    if (query.limit != null) qs.set('limit', String(query.limit));
    if (query.cursor) qs.set('cursor', query.cursor);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return this.get<ScoreHistoryPayload>(
      `/users/${encodeURIComponent(userId)}/score/history${suffix}`,
      apiKey,
    );
  }

  /**
   * Unified, chronological feed of events + score changes for a user — a merge
   * view over the Event ledger and score-snapshot history, newest-first and
   * cursor-paginated. Read-only; writes nothing.
   */
  getTimeline(
    userId: string,
    apiKey: string,
    query: { limit?: number; cursor?: string } = {},
  ): Promise<TimelinePayload> {
    const qs = new URLSearchParams();
    if (query.limit != null) qs.set('limit', String(query.limit));
    if (query.cursor) qs.set('cursor', query.cursor);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return this.get<TimelinePayload>(
      `/users/${encodeURIComponent(userId)}/timeline${suffix}`,
      apiKey,
    );
  }

  /**
   * Read-only what-if projection: what a user's score WOULD become if the given
   * hypothetical events landed on the ledger. Never writes a snapshot or mutates
   * the ledger — forward-looking and advisory. Requires a platform API key.
   */
  projectScore(
    userId: string,
    events: ProjectionEventInput[],
    apiKey: string,
  ): Promise<ScoreProjectionPayload> {
    return this.post<ScoreProjectionPayload>(
      `/users/${encodeURIComponent(userId)}/score/project`,
      { events },
      apiKey,
    );
  }

  /** Platforms contributing to a user's score. */
  getPlatforms(userId: string, apiKey: string): Promise<PlatformsPayload> {
    return this.get<PlatformsPayload>(
      `/users/${encodeURIComponent(userId)}/platforms`,
      apiKey,
    );
  }

  /**
   * Deterministic, ADVISORY anti-gaming risk signals for a user. Never affects
   * the score. Requires a platform API key.
   */
  getRisk(userId: string, apiKey: string): Promise<RiskPayload> {
    return this.get<RiskPayload>(`/users/${encodeURIComponent(userId)}/risk`, apiKey);
  }

  /**
   * This platform's own API usage (per day, by status class) vs. its tier rate
   * limit and monthly quota. Requires a key.
   *
   * Pass a number (trailing window in days, default 7, server max 400) — the
   * original signature — or `{ from, to }` (inclusive ISO dates, `YYYY-MM-DD`)
   * for an explicit statement range; the two are mutually exclusive
   * server-side. Completed days beyond the live 90-day counter retention are
   * served from durable daily rollups; ranges are clamped to the server's
   * history window (default 400 days). CSV export (`?format=csv`) is a
   * raw-fetch use case — this method returns parsed JSON.
   */
  getUsage(
    apiKey: string,
    window?: number | { days?: number; from?: string; to?: string },
  ): Promise<UsagePayload> {
    const qs = new URLSearchParams();
    if (typeof window === 'number') qs.set('days', String(window));
    else if (window) {
      if (window.days != null) qs.set('days', String(window.days));
      if (window.from != null) qs.set('from', window.from);
      if (window.to != null) qs.set('to', window.to);
    }
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return this.get<UsagePayload>(`/usage${suffix}`, apiKey);
  }

  /**
   * Your usage as metered-billing meters (Stripe Billing Meters shape): per
   * dimension (total / status class / route pattern) request totals over the
   * window. Same window controls as {@link getUsage}. Requires the `usage`
   * scope. Returns parsed JSON; the CSV export (`?format=csv`) is a raw-fetch
   * use case.
   */
  getUsageMeters(
    apiKey: string,
    window?: number | { days?: number; from?: string; to?: string },
  ): Promise<UsageMetersPayload> {
    const qs = new URLSearchParams();
    if (typeof window === 'number') qs.set('days', String(window));
    else if (window) {
      if (window.days != null) qs.set('days', String(window.days));
      if (window.from != null) qs.set('from', window.from);
      if (window.to != null) qs.set('to', window.to);
    }
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return this.get<UsageMetersPayload>(`/usage/meters${suffix}`, apiKey);
  }

  /**
   * Event analytics over YOUR OWN ledger: volume by day (gaps filled) + by type
   * + the verified AND counterparty-confirmed shares, over a trailing `days`
   * window (default 30, max 365) or an explicit `from`/`to` range. Aggregate-only
   * — no subject identifiers. Requires `scores:read`; test/live isolated.
   */
  getEventAnalytics(
    apiKey: string,
    window?: number | { days?: number; from?: string; to?: string },
  ): Promise<EventAnalyticsPayload> {
    return this.get<EventAnalyticsPayload>(`/analytics/events${analyticsQuery(window)}`, apiKey);
  }

  /**
   * Score analytics over YOUR subjects: band distribution, median/mean of
   * current scores, and how many scores moved over the window. Same window
   * controls as {@link getEventAnalytics}. Aggregate-only; requires
   * `scores:read`; test/live isolated. Read-only — never moves a score.
   */
  getScoreAnalytics(
    apiKey: string,
    window?: number | { days?: number; from?: string; to?: string },
  ): Promise<ScoreAnalyticsPayload> {
    return this.get<ScoreAnalyticsPayload>(`/analytics/scores${analyticsQuery(window)}`, apiKey);
  }

  /**
   * Quota transparency — how many calls you have left this month and when it
   * resets, without pulling the full per-day usage breakdown. Read-only: this
   * call never counts against your quota. Mirrors the exact numbers the
   * enforcement path uses, so you can self-throttle before ever seeing a 429.
   * `unlimited: true` means the tier has no monthly quota configured.
   */
  getQuota(apiKey: string): Promise<QuotaPayload> {
    return this.get<QuotaPayload>('/usage/quota', apiKey);
  }

  /**
   * Résumé / document advisory — "who confirms it, and how does it affect the
   * score?" Given the STRUCTURED claims a résumé or work-history document
   * describes, it advises per claim who the third-party witness is, whether it
   * counts as verified as submitted, and (read-only) how adding the claims moves
   * the score (as-submitted vs. if-all-confirmed). WRITES NOTHING — no event, no
   * score, no verification; a claim is verified only when its witness confirms.
   */
  analyzeDocument(
    userId: string,
    claims: DocumentClaimInput[],
    apiKey: string,
  ): Promise<DocumentAdvicePayload> {
    return this.post<DocumentAdvicePayload>(
      `/users/${encodeURIComponent(userId)}/documents/analyze`,
      { claims },
      apiKey,
    );
  }

  /**
   * Your platform's own activity log — the self-serve audit trail of what your
   * keys and config did (events reported, webhooks/monitors changed, share
   * tokens minted, keys issued). Cursor-paginated, newest-first; optional
   * `action` filter and `from`/`to` ISO time bounds. Strictly scoped to your
   * own rows. Uses the `usage` read scope (observability, like getUsage).
   */
  getActivity(
    apiKey: string,
    query: { limit?: number; cursor?: string; action?: string; from?: string; to?: string } = {},
  ): Promise<ActivityPayload> {
    const qs = new URLSearchParams();
    if (query.limit != null) qs.set('limit', String(query.limit));
    if (query.cursor) qs.set('cursor', query.cursor);
    if (query.action) qs.set('action', query.action);
    if (query.from) qs.set('from', query.from);
    if (query.to) qs.set('to', query.to);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return this.get<ActivityPayload>(`/activity${suffix}`, apiKey);
  }

  /**
   * Export the events your platform itself reported (data portability),
   * oldest-first (ledger order), cursor-paginated. `from`/`to` (ISO) bound the
   * event's recorded `createdAt`. Requires `events:read` (or coarse `read`).
   * This method returns parsed JSON pages; the CSV stream
   * (`GET /api/v1/events/export?format=csv`) is a raw-fetch use case.
   */
  exportEvents(
    apiKey: string,
    query: { limit?: number; cursor?: string; from?: string; to?: string } = {},
  ): Promise<EventExportPayload> {
    const qs = new URLSearchParams();
    if (query.limit != null) qs.set('limit', String(query.limit));
    if (query.cursor) qs.set('cursor', query.cursor);
    if (query.from) qs.set('from', query.from);
    if (query.to) qs.set('to', query.to);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return this.get<EventExportPayload>(`/events/export${suffix}`, apiKey);
  }

  /**
   * Ingest an outcome event into the append-only ledger. Requires a platform key
   * with `write` (or `events:write`) scope. Pass `opts.idempotencyKey` (a stable
   * per-operation string) to make retries exactly-once — strongly recommended.
   */
  reportEvent(
    input: ReportEventInput,
    apiKey: string,
    opts: { idempotencyKey?: string } = {},
  ): Promise<ReportEventResult> {
    const headers = opts.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : undefined;
    return this.post<ReportEventResult>('/events', input, apiKey, headers);
  }

  /**
   * Report up to 100 events in one call — for streaming many users' activity at
   * once instead of a request per event. Partial success: the result lists each
   * item's outcome. Give an item an `idempotencyKey` so a retried batch is
   * exactly-once. Requires a platform key with `events` write scope.
   */
  reportEvents(events: BatchEventInput[], apiKey: string): Promise<BatchEventsResult> {
    return this.post<BatchEventsResult>('/events/batch', { events }, apiKey);
  }

  /**
   * Mint (or rotate) a public share token for a user — the capability that powers
   * trust badges, the verify page, and the portable export. Returns an embed
   * snippet. Requires a platform key with `write` (or `scores:write`) scope.
   */
  mintShareToken(userId: string, apiKey: string): Promise<ShareTokenResult> {
    return this.post<ShareTokenResult>(`/users/${encodeURIComponent(userId)}/share-token`, {}, apiKey);
  }

  /**
   * Register (or update) an AGENT subject — a non-human scored subject. Writes
   * no events and touches no score: an agent's record runs the identical
   * deterministic formula as a person's.
   *
   * By default the calling platform is declared as the agent's OPERATOR, which
   * means events you report for it are recorded but never counted as verified
   * evidence — only a distinct counterparty can confirm a delivery. Pass
   * `operatedByReportingPlatform: false` (and name the operator) when you are a
   * marketplace reporting on someone else's agent.
   *
   * Requires a platform key with `write` (or `events:write`) scope.
   */
  registerAgent(input: RegisterAgentInput, apiKey: string): Promise<AgentSubject> {
    return this.post<AgentSubject>('/agents', input, apiKey);
  }

  /**
   * Inspect an agent subject: its declared facts (claims, never evidence), its
   * current deterministic score, and its delivery record split by whether a
   * distinct counterparty confirmed each delivery. Requires `scores:read`.
   */
  getAgent(userId: string, apiKey: string): Promise<AgentDetail> {
    return this.get<AgentDetail>(`/agents/${encodeURIComponent(userId)}`, apiKey);
  }

  /**
   * Mint an OID4VCI Credential Offer so this user can collect their Credda
   * credential into any OID4VCI-capable wallet. Render `credentialOfferUri` as
   * a QR code (or hand it over as a link) and the wallet does the rest.
   *
   * `scope` bounds what the credential CONTAINS; for the SD-JWT VC
   * configurations the holder additionally chooses which of those claims to
   * reveal at presentation time. The pre-authorized code inside the offer is
   * single-use and short-lived. Requires a platform key with `scores` scope.
   */
  createCredentialOffer(
    userId: string,
    apiKey: string,
    opts: { credentialConfigurationIds?: string[]; scope?: 'minimal' | 'band' | 'full' } = {},
  ): Promise<CredentialOfferResult> {
    return this.post<CredentialOfferResult>(
      `/users/${encodeURIComponent(userId)}/credential-offer`,
      opts,
      apiKey,
    );
  }

  /** Revoke a user's share token, immediately invalidating every embed using it. */
  revokeShareToken(userId: string, apiKey: string): Promise<void> {
    return this.del(`/users/${encodeURIComponent(userId)}/share-token`, apiKey);
  }

  /**
   * Resolve a dispute the calling platform owns. `FOR_USER` clears it (severity 0),
   * `AGAINST_USER` upholds it. Triggers a score recompute + a `dispute.resolved`
   * webhook. Requires a platform key with `write` (or `disputes:write`) scope.
   */
  resolveDispute(disputeId: string, outcome: DisputeOutcome, apiKey: string): Promise<DisputeResult> {
    return this.patch<DisputeResult>(`/disputes/${encodeURIComponent(disputeId)}/resolve`, { outcome }, apiKey);
  }

  // ── Webhook management (server-side, API key) ───────────────────────────────
  // (To VERIFY received webhooks, use verifyWebhookSignature/constructWebhookEvent.)

  /**
   * Subscribe an HTTPS endpoint to trust events. The signing secret is returned
   * ONCE — store it to verify deliveries. Requires `write` (or `webhooks:write`).
   */
  createWebhook(input: CreateWebhookInput, apiKey: string): Promise<CreateWebhookResult> {
    return this.post<CreateWebhookResult>('/webhooks', input, apiKey);
  }

  /** List this platform's webhooks (secrets are never returned). */
  listWebhooks(apiKey: string): Promise<{ data: WebhookConfig[] }> {
    return this.get<{ data: WebhookConfig[] }>('/webhooks', apiKey);
  }

  /** Delete a webhook subscription. */
  deleteWebhook(id: string, apiKey: string): Promise<void> {
    return this.del(`/webhooks/${encodeURIComponent(id)}`, apiKey);
  }

  /** Update a webhook (url / events / description / isActive). Re-enabling resets its failure health. */
  updateWebhook(id: string, patch: UpdateWebhookInput, apiKey: string): Promise<{ webhook: WebhookConfig }> {
    return this.patch<{ webhook: WebhookConfig }>(`/webhooks/${encodeURIComponent(id)}`, patch, apiKey);
  }

  /** Send a synthetic signed delivery to confirm connectivity + signature verification. */
  testWebhook(id: string, apiKey: string): Promise<WebhookTestResult> {
    return this.post<WebhookTestResult>(`/webhooks/${encodeURIComponent(id)}/test`, {}, apiKey);
  }

  /** Recent delivery attempts for a webhook (debugging), cursor-paginated. */
  /**
   * Replay a past delivery: the stored event body is re-sent, signed with the
   * current secret and a fresh transport timestamp. Same event id — consumers
   * dedup on it, so this behaves like a duplicate delivery, not a new event.
   */
  replayWebhookDelivery(
    id: string,
    deliveryId: string,
    apiKey: string,
  ): Promise<{ status: 'replayed'; success: boolean; statusCode: number | null; error: string | null }> {
    return this.post(
      `/webhooks/${encodeURIComponent(id)}/deliveries/${encodeURIComponent(deliveryId)}/replay`,
      {},
      apiKey,
    );
  }

  getWebhookDeliveries(
    id: string,
    apiKey: string,
    limit?: number,
    cursor?: string,
  ): Promise<{ data: WebhookDelivery[]; nextCursor: string | null }> {
    const qs = new URLSearchParams();
    if (limit != null) qs.set('limit', String(limit));
    if (cursor) qs.set('cursor', cursor);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return this.get<{ data: WebhookDelivery[]; nextCursor: string | null }>(
      `/webhooks/${encodeURIComponent(id)}/deliveries${suffix}`,
      apiKey,
    );
  }

  /**
   * Recent outbound events across ALL of your webhook endpoints — the
   * "perform-list" sample-data source automation platforms (Zapier, Make, n8n)
   * need to show users a trigger's output BEFORE any event has fired.
   *
   * Each item is the delivery envelope exactly as sent, so a field mapping
   * built against a sample keeps working on real deliveries. When you have no
   * retained deliveries yet, representative payloads from the event catalog are
   * returned instead with `isExample: true` and `source: 'examples'` — never
   * present those as something that actually happened.
   */
  getRecentWebhookEvents(
    apiKey: string,
    query: { limit?: number; cursor?: string; eventType?: WebhookSubscriptionEvent | WebhookSubscriptionEvent[] } = {},
  ): Promise<RecentWebhookEventsPayload> {
    const qs = new URLSearchParams();
    if (query.limit != null) qs.set('limit', String(query.limit));
    if (query.cursor) qs.set('cursor', query.cursor);
    if (query.eventType) {
      qs.set('eventType', Array.isArray(query.eventType) ? query.eventType.join(',') : query.eventType);
    }
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return this.get<RecentWebhookEventsPayload>(`/webhooks/deliveries${suffix}`, apiKey);
  }

  // ── Score monitors (continuous monitoring, server-side, API key) ────────────
  // Edge-triggered threshold/band watches that deliver `monitor.triggered`
  // through your subscribed webhooks. Notification config only — a monitor
  // never affects a score. Uses the `webhooks` scope.

  /**
   * Create a monitor on one of your users. At least one condition is required:
   * `belowScore` (downward crossing — also fires on a FIRST score already below
   * the threshold), `aboveScore` (upward crossing only), or `onBandChange`.
   */
  createMonitor(input: CreateMonitorInput, apiKey: string): Promise<{ monitor: ScoreMonitor }> {
    return this.post<{ monitor: ScoreMonitor }>('/monitors', input, apiKey);
  }

  /** List this platform's monitors, cursor-paginated. */
  listMonitors(
    apiKey: string,
    query: { limit?: number; cursor?: string } = {},
  ): Promise<MonitorListPayload> {
    const qs = new URLSearchParams();
    if (query.limit != null) qs.set('limit', String(query.limit));
    if (query.cursor) qs.set('cursor', query.cursor);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return this.get<MonitorListPayload>(`/monitors${suffix}`, apiKey);
  }

  /** Fetch one monitor. */
  getMonitor(id: string, apiKey: string): Promise<{ monitor: ScoreMonitor }> {
    return this.get<{ monitor: ScoreMonitor }>(`/monitors/${encodeURIComponent(id)}`, apiKey);
  }

  /**
   * Update a monitor's thresholds / onBandChange / isActive. Pass null to clear
   * a threshold; the updated monitor must keep at least one condition.
   */
  updateMonitor(id: string, patch: UpdateMonitorInput, apiKey: string): Promise<{ monitor: ScoreMonitor }> {
    return this.patch<{ monitor: ScoreMonitor }>(`/monitors/${encodeURIComponent(id)}`, patch, apiKey);
  }

  /** Delete a monitor (hard delete — it is config, not ledger data). */
  deleteMonitor(id: string, apiKey: string): Promise<void> {
    return this.del(`/monitors/${encodeURIComponent(id)}`, apiKey);
  }

  // ── Bulk screenings (async batch score reads, server-side, API key) ─────────
  // Roster-scale batch reads: up to 10,000 ids per job (vs. getScores' 100).
  // STRICTLY READ-ONLY — a screening never writes events, snapshots, or
  // anything score-side. Uses the `scores` scope, same as getScores.

  /**
   * Submit an async bulk screening. Ids are deduped server-side; each resolves
   * through the same lookup as `getScores`. Jobs of ≤100 deduped ids are
   * processed inline — the returned job is usually already COMPLETED; larger
   * jobs are queued: poll `getScreening(id)` until COMPLETED, then fetch
   * `getScreeningResults(id)`.
   */
  createScreening(userIds: string[], apiKey: string): Promise<{ screening: ScreeningJob }> {
    return this.post<{ screening: ScreeningJob }>('/screenings', { userIds }, apiKey);
  }

  /** List this platform's screening jobs (status + summary only), cursor-paginated. */
  listScreenings(
    apiKey: string,
    query: { limit?: number; cursor?: string } = {},
  ): Promise<ScreeningListPayload> {
    const qs = new URLSearchParams();
    if (query.limit != null) qs.set('limit', String(query.limit));
    if (query.cursor) qs.set('cursor', query.cursor);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return this.get<ScreeningListPayload>(`/screenings${suffix}`, apiKey);
  }

  /** Fetch one screening job's status + summary (no results payload). */
  getScreening(id: string, apiKey: string): Promise<{ screening: ScreeningJob }> {
    return this.get<{ screening: ScreeningJob }>(`/screenings/${encodeURIComponent(id)}`, apiKey);
  }

  /**
   * Fetch the full per-user results of a COMPLETED screening. 409
   * (SCREENING_NOT_COMPLETED) while the job is still queued/running or if it
   * failed. CSV export (`?format=csv`) is a raw-fetch use case — this method
   * returns parsed JSON.
   */
  getScreeningResults(id: string, apiKey: string): Promise<ScreeningResultsPayload> {
    return this.get<ScreeningResultsPayload>(`/screenings/${encodeURIComponent(id)}/results`, apiKey);
  }

  // ── Data ingress: field-mapping ingest + historical CSV import ─────────────
  // Send YOUR payload shape (no client-side transformation) or backfill a CSV.
  // Both write through the SAME append-only path as reportEvent — idempotency,
  // velocity guard, audit trail, asynchronous score recomputation — and neither
  // contains any scoring logic. Uses the `events` scope, same as reportEvent.
  //
  // ⚠️ A mapping is DECLARATIVE DATA, never code: a rule may read a dot-path,
  // supply a constant, look a value up in your own table, or apply one of a
  // fixed transform whitelist. There is no expression language, by design.
  //
  // ⚠️ `isVerified` defaults to false. It is only honoured for a record whose
  // mapping also resolves `verifiedBy` (the third party who witnessed the
  // outcome); otherwise the record still ingests, downgraded, with a warning.

  /**
   * Ingest records in your own shape via a field mapping.
   * `POST /api/v1/ingest`. Up to 100 records per call; partial success — a bad
   * record fails individually with its index and reason.
   */
  ingest(input: IngestInput, apiKey: string): Promise<IngestPayload> {
    return this.post<IngestPayload>('/ingest', input as unknown as Record<string, unknown>, apiKey);
  }

  /** Save a reusable named mapping. `POST /api/v1/ingest/mappings`. */
  createMapping(input: CreateMappingInput, apiKey: string): Promise<{ mapping: StoredMapping }> {
    return this.post<{ mapping: StoredMapping }>('/ingest/mappings', input as unknown as Record<string, unknown>, apiKey);
  }

  /** List your stored mappings, cursor-paginated. `GET /api/v1/ingest/mappings`. */
  listMappings(apiKey: string, query: { limit?: number; cursor?: string } = {}): Promise<MappingListPayload> {
    return this.get<MappingListPayload>(`/ingest/mappings${queryString(query)}`, apiKey);
  }

  /** Fetch one stored mapping. `GET /api/v1/ingest/mappings/{id}`. */
  getMapping(id: string, apiKey: string): Promise<{ mapping: StoredMapping }> {
    return this.get<{ mapping: StoredMapping }>(`/ingest/mappings/${encodeURIComponent(id)}`, apiKey);
  }

  /** Delete a stored mapping (config, not ledger data — ingested events stay). */
  deleteMapping(id: string, apiKey: string): Promise<void> {
    return this.del(`/ingest/mappings/${encodeURIComponent(id)}`, apiKey);
  }

  /**
   * Backfill historical outcomes from a CSV. `POST /api/v1/imports`.
   * Mapping paths are COLUMN NAMES. Files of ≤100 rows are processed inline
   * (the returned job usually already reads COMPLETED); larger files are
   * queued — poll `getImport(id)`, then `getImportErrors(id)` to fix and
   * re-upload (idempotency keys make that safe). Imported events keep their
   * REAL dates, so scores recompute over true history.
   */
  createImport(input: CreateImportInput, apiKey: string): Promise<{ import: ImportJob }> {
    return this.post<{ import: ImportJob }>('/imports', input as unknown as Record<string, unknown>, apiKey);
  }

  /** List your CSV imports, cursor-paginated. `GET /api/v1/imports`. */
  listImports(apiKey: string, query: { limit?: number; cursor?: string } = {}): Promise<ImportListPayload> {
    return this.get<ImportListPayload>(`/imports${queryString(query)}`, apiKey);
  }

  /** Fetch one import's status + counts. `GET /api/v1/imports/{id}`. */
  getImport(id: string, apiKey: string): Promise<{ import: ImportJob }> {
    return this.get<{ import: ImportJob }>(`/imports/${encodeURIComponent(id)}`, apiKey);
  }

  /** Per-row failures and warnings. `GET /api/v1/imports/{id}/errors`. */
  getImportErrors(
    id: string,
    apiKey: string,
    query: { limit?: number; offset?: number } = {},
  ): Promise<ImportErrorsPayload> {
    return this.get<ImportErrorsPayload>(`/imports/${encodeURIComponent(id)}/errors${queryString(query)}`, apiKey);
  }

  // ── Confirmation requests (the counterparty-confirmation primitive) ────────
  //
  // `reportEvent` lets you ASSERT `isVerified: true`. This is the strong form:
  // you PROPOSE an outcome, get a one-time token, deliver it to the named
  // counterparty over YOUR OWN channel, and the event is written — verified —
  // only when that distinct party confirms. The confirmation is the third-party
  // witness the score's invariant requires. See docs/CONFIRMATIONS.md.
  //
  // ⚠️ The auth is deliberately ASYMMETRIC. create/list/get/cancel are keyed
  // (the existing `events` scope — no new scope resource). `previewConfirmation`
  // and `respondToConfirmation` take NO API key: the counterparty holds a token,
  // not a Credda account. Credda never learns their address — you own delivery.

  /**
   * Propose an outcome for counterparty confirmation.
   * `POST /api/v1/confirmations`. Writes NO event and touches NO score.
   *
   * Returns the request plus `confirmationToken` — shown ONCE, deliver it to the
   * counterparty yourself — and three ways to get them to a decision:
   * `confirmUrl` (Credda's hosted page: zero frontend for you to build),
   * `previewUrl` / `respondUrl` (build your own UI on them). Set `returnUrl` to
   * send them back to you after they decide; it is strictly validated
   * server-side, so an invalid one is a 400 rather than a stored redirect.
   *
   * Pass `opts.idempotencyKey` so a retried create can't mint a second token for
   * the same proposal. Requires `events:write`.
   */
  createConfirmationRequest(
    input: CreateConfirmationInput,
    apiKey: string,
    opts: { idempotencyKey?: string } = {},
  ): Promise<ConfirmationCreateResult> {
    const headers = opts.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : undefined;
    return this.post<ConfirmationCreateResult>(
      '/confirmations',
      input as unknown as Record<string, unknown>,
      apiKey,
      headers,
    );
  }

  /**
   * The ACTIVATION ENGINE — bulk-create up to 100 confirmation requests in one
   * call. `POST /api/v1/confirmations/batch`. Turn your BOOK of historical
   * relationships (past jobs, placements, engagements, projects — for a
   * professional in ANY field) into pending counterparty asks, warming a cold
   * ledger. Each item is exactly a `createConfirmationRequest` body and flows
   * through the SAME create path, so `isVerified` is still earned only on confirm
   * — a batch item writes NOTHING to the ledger until its named counterparty
   * confirms.
   *
   * Partial success: `results` lists each item's outcome by `index` — an ok item
   * carries its one-time `confirmationToken` + hosted `confirmUrl` (deliver it
   * over your own channel); a failed one carries `error` + `code` (e.g.
   * `CONFIRMATION_SELF`). An over-cap batch is a 400. Pass `opts.idempotencyKey`
   * so a retried batch replays instead of creating duplicates. Requires
   * `events:write`.
   */
  createConfirmationBatch(
    requests: CreateConfirmationInput[],
    apiKey: string,
    opts: { idempotencyKey?: string } = {},
  ): Promise<ConfirmationBatchResult> {
    const headers = opts.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : undefined;
    return this.post<ConfirmationBatchResult>(
      '/confirmations/batch',
      { requests } as unknown as Record<string, unknown>,
      apiKey,
      headers,
    );
  }

  /**
   * The ACTIVATION ENGINE at book scale — `POST /api/v1/activation/campaigns`.
   * Submit your whole historical roster/timesheets (up to 500 rows) in ONE call.
   * Each row becomes an UNCONFIRMED confirmation request — a proposed outcome plus
   * a one-time token — fanned out to its named counterparty, then
   * `getActivationCampaign(id)` reports the funnel as those tokens are acted on.
   *
   * INVARIANT: a campaign writes NOTHING to the ledger. Every row flows through the
   * SAME create path a single confirmation uses, so `isVerified` is still earned
   * only on a genuine counterparty confirm — never here. Partial success: each
   * `results` entry carries a one-time token + hosted `confirmUrl` (ok rows) or an
   * `error` + `code` (failed rows); in-batch duplicate `rowKey`s are dropped into
   * `duplicates`. If NOT ONE row could be created the call is 400
   * `ACTIVATION_NO_VALID_ROWS`. Give each row a `rowKey` (your own stable roster
   * id) to make the campaign idempotent per row; pass `opts.idempotencyKey` to make
   * a retried whole submission exactly-once. Requires `events:write`.
   */
  createActivationCampaign(
    input: CreateActivationCampaignInput,
    apiKey: string,
    opts: { idempotencyKey?: string } = {},
  ): Promise<ActivationCampaignResult> {
    const headers = opts.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : undefined;
    return this.post<ActivationCampaignResult>(
      '/activation/campaigns',
      input as unknown as Record<string, unknown>,
      apiKey,
      headers,
    );
  }

  /**
   * The campaign funnel — `GET /api/v1/activation/campaigns/{id}`. Derived LIVE
   * from the campaign's confirmation requests, so it always reflects the current
   * state as counterparties act on their tokens: `submitted` → `confirmed` /
   * `declined` / `pending` (+ `expired` / `cancelled`), with a factual
   * `confirmationRate`. Scoped to your platform + key mode. Requires `events:write`.
   */
  getActivationCampaign(id: string, apiKey: string): Promise<ActivationCampaignFunnelPayload> {
    return this.get<ActivationCampaignFunnelPayload>(
      `/activation/campaigns/${encodeURIComponent(id)}`,
      apiKey,
    );
  }

  /**
   * List your confirmation requests, newest first, cursor-paginated. Filter by
   * `status` (`PENDING` / `CONFIRMED` / `DECLINED` / `EXPIRED` / `CANCELLED`).
   * `GET /api/v1/confirmations`.
   */
  listConfirmations(
    apiKey: string,
    query: { status?: ConfirmationStatus; limit?: number; cursor?: string } = {},
  ): Promise<ConfirmationListPayload> {
    return this.get<ConfirmationListPayload>(`/confirmations${queryString(query)}`, apiKey);
  }

  /** Fetch one of your confirmation requests. `GET /api/v1/confirmations/{id}`. */
  getConfirmation(id: string, apiKey: string): Promise<{ confirmation: ConfirmationRequest }> {
    return this.get<{ confirmation: ConfirmationRequest }>(
      `/confirmations/${encodeURIComponent(id)}`,
      apiKey,
    );
  }

  /**
   * Cancel a still-pending request. `POST /api/v1/confirmations/{id}/cancel`.
   * A request that is already decided or expired returns 409
   * `CONFIRMATION_NOT_PENDING` — a decision is never rewritten.
   */
  cancelConfirmation(id: string, apiKey: string): Promise<{ confirmation: ConfirmationRequest }> {
    return this.post<{ confirmation: ConfirmationRequest }>(
      `/confirmations/${encodeURIComponent(id)}/cancel`,
      {},
      apiKey,
    );
  }

  /**
   * What the counterparty is being asked to confirm — token-gated, **NO API
   * key**. `GET /api/v1/confirmations/{id}/preview?token=…`.
   *
   * Returns a PII-free subset: never the raw subject id and never the
   * `counterpartyRef` matching key, so this is safe to render in a page the
   * counterparty opens. Read-only.
   */
  previewConfirmation(id: string, token: string): Promise<{ confirmation: ConfirmationPreview }> {
    return this.get<{ confirmation: ConfirmationPreview }>(
      `/confirmations/${encodeURIComponent(id)}/preview?token=${encodeURIComponent(token)}`,
    );
  }

  /**
   * The counterparty's decision, presented with the raw token — **NO API key**.
   * `POST /api/v1/confirmations/{id}/respond`.
   *
   * `confirm` writes the proposed event with `isVerified: true` (earned: a
   * distinct token-holder acted) and returns its `eventId`. `decline` writes
   * NOTHING — a decline is not evidence of a negative outcome. Single-use: the
   * token is spent either way.
   */
  respondToConfirmation(
    id: string,
    token: string,
    decision: ConfirmationDecision,
  ): Promise<ConfirmationRespondResult> {
    return this.postPublic<ConfirmationRespondResult>(
      `/confirmations/${encodeURIComponent(id)}/respond`,
      { token, decision },
    );
  }

  // ── Reference / employment-verification requests ──────────────────────────
  //
  // The qualifications-half sibling of confirmation requests. A résumé claim
  // (past employment, education, certification, skill) reported via
  // recordQualification with no witness lands SELF-ATTESTED; a reference is how
  // you ASK the named third party who was actually there to confirm it, turning
  // it VERIFIED. On confirm the qualification is recorded through the same witness
  // valve every qualification ingress uses — so isVerified is earned in one place,
  // never asserted — and a qualification NEVER moves the reliability score.
  //
  // ⚠️ Same ASYMMETRIC auth as confirmations. create/list/get/cancel are keyed
  // (the existing `events` scope — no new scope resource). `previewReference` and
  // `respondToReference` take NO API key: the counterparty holds a token, not a
  // Credda account. Credda never learns their address — you own delivery.

  /**
   * Propose a résumé claim for a reference to confirm.
   * `POST /api/v1/references`. Records NO qualification and touches NO score.
   *
   * Returns the request plus `referenceToken` — shown ONCE, deliver it to the
   * counterparty yourself — and three ways to get them to a decision:
   * `referenceUrl` (Credda's hosted page: zero frontend to build),
   * `previewUrl` / `respondUrl` (build your own UI). Set `returnUrl` to send them
   * back after they decide; it is strictly validated server-side.
   *
   * `counterpartyRef` must differ from `userId` (a person cannot be their own
   * reference → 400 REFERENCE_SELF). Pass `opts.idempotencyKey` so a retried
   * create can't mint a second token. Requires `events:write`.
   */
  createReferenceRequest(
    input: CreateReferenceInput,
    apiKey: string,
    opts: { idempotencyKey?: string } = {},
  ): Promise<ReferenceCreateResult> {
    const headers = opts.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : undefined;
    return this.post<ReferenceCreateResult>(
      '/references',
      input as unknown as Record<string, unknown>,
      apiKey,
      headers,
    );
  }

  /**
   * List your reference requests, newest first, cursor-paginated. Filter by
   * `status` (`PENDING` / `CONFIRMED` / `DECLINED` / `EXPIRED` / `CANCELLED`).
   * `GET /api/v1/references`.
   */
  listReferences(
    apiKey: string,
    query: { status?: ReferenceRequestStatus; limit?: number; cursor?: string } = {},
  ): Promise<ReferenceListPayload> {
    return this.get<ReferenceListPayload>(`/references${queryString(query)}`, apiKey);
  }

  /** Fetch one of your reference requests. `GET /api/v1/references/{id}`. */
  getReference(id: string, apiKey: string): Promise<{ reference: ReferenceRequest }> {
    return this.get<{ reference: ReferenceRequest }>(
      `/references/${encodeURIComponent(id)}`,
      apiKey,
    );
  }

  /**
   * Cancel a still-pending request. `POST /api/v1/references/{id}/cancel`.
   * A request that is already decided or expired returns 409
   * `REFERENCE_NOT_PENDING` — a decision is never rewritten.
   */
  cancelReference(id: string, apiKey: string): Promise<{ reference: ReferenceRequest }> {
    return this.post<{ reference: ReferenceRequest }>(
      `/references/${encodeURIComponent(id)}/cancel`,
      {},
      apiKey,
    );
  }

  /**
   * What the counterparty is being asked to confirm — token-gated, **NO API
   * key**. `GET /api/v1/references/{id}/preview?token=…`.
   *
   * Returns a PII-free subset: never the raw subject id and never the
   * `counterpartyRef` matching key. Read-only.
   */
  previewReference(id: string, token: string): Promise<{ reference: ReferencePreview }> {
    return this.get<{ reference: ReferencePreview }>(
      `/references/${encodeURIComponent(id)}/preview?token=${encodeURIComponent(token)}`,
    );
  }

  /**
   * The counterparty's decision, presented with the raw token — **NO API key**.
   * `POST /api/v1/references/{id}/respond`.
   *
   * `confirm` records the qualification with `isVerified: true` (earned: a
   * distinct third party who was there confirmed the claim) and returns its
   * `eventId`. `decline` records NOTHING — a decline is not evidence against the
   * claim. Single-use: the token is spent either way. A qualification never moves
   * the reliability score.
   */
  respondToReference(
    id: string,
    token: string,
    decision: ReferenceDecision,
  ): Promise<ReferenceRespondResult> {
    return this.postPublic<ReferenceRespondResult>(
      `/references/${encodeURIComponent(id)}/respond`,
      { token, decision },
    );
  }

  // ── Threshold policies (declarative "tell me when this line is crossed") ───
  // A policy watches ONE condition on one subject (`userId`) or on all of your
  // subjects (`appliesToAll`) and delivers `policy.threshold_crossed` through
  // your webhooks, edge-triggered, with the deterministic evidence attached.
  // Notification config, so it uses the existing `webhooks` scope — and, like a
  // monitor, a policy never reads into, blocks, or changes a score computation.

  /**
   * Create a threshold policy. `POST /api/v1/policies`. Set exactly one of
   * `userId` or `appliesToAll: true`, and supply the condition the `metric`
   * requires (`direction` is `up`/`down` for crossings, `enter`/`leave` for a
   * band; omit it on a band policy to fire on any band change).
   */
  createPolicy(input: CreatePolicyInput, apiKey: string): Promise<{ policy: ThresholdPolicy }> {
    return this.post<{ policy: ThresholdPolicy }>(
      '/policies',
      input as unknown as Record<string, unknown>,
      apiKey,
    );
  }

  /** List this platform's policies, cursor-paginated. `GET /api/v1/policies`. */
  listPolicies(
    apiKey: string,
    query: { limit?: number; cursor?: string } = {},
  ): Promise<ThresholdPolicyListPayload> {
    return this.get<ThresholdPolicyListPayload>(`/policies${queryString(query)}`, apiKey);
  }

  /** Fetch one policy. `GET /api/v1/policies/{id}`. */
  getPolicy(id: string, apiKey: string): Promise<{ policy: ThresholdPolicy }> {
    return this.get<{ policy: ThresholdPolicy }>(`/policies/${encodeURIComponent(id)}`, apiKey);
  }

  /**
   * Retune a policy (name / direction / threshold / component / band /
   * isActive). `PATCH /api/v1/policies/{id}`. The `metric` is IMMUTABLE — to
   * change what is watched, delete and recreate. Pass `null` to clear a
   * nullable condition field; the merged result is re-validated with the same
   * validator create uses, so an update can't leave a shape create would reject.
   */
  updatePolicy(
    id: string,
    patch: UpdatePolicyInput,
    apiKey: string,
  ): Promise<{ policy: ThresholdPolicy }> {
    return this.patch<{ policy: ThresholdPolicy }>(`/policies/${encodeURIComponent(id)}`, patch, apiKey);
  }

  /** Delete a policy (hard delete — it is config, not ledger data). */
  deletePolicy(id: string, apiKey: string): Promise<void> {
    return this.del(`/policies/${encodeURIComponent(id)}`, apiKey);
  }

  // ── Verified Profile (qualifications) ──────────────────────────────────────
  //
  // A SECOND deterministic measure over the same ledger: how much of a person's
  // CLAIMED record (education, skills, certifications, employment) is
  // independently third-party verified.
  //
  // ⚠️ THE BRIGHT LINE: this can never move the Reliability Score. Qualification
  // events are structurally excluded from the score formula. It counts WHETHER a
  // claim is verified, never how prestigious it is — no school, employer, degree
  // or credential is ranked or weighted, deliberately.

  /**
   * The subject's verified-profile measure: per-category claimed vs verified
   * counts, and the share of the whole claimed record that is independently
   * verified. `GET /api/v1/users/{id}/verified-profile`.
   *
   * `verificationDepth` is `null` — not 0 — when nothing is claimed. This
   * describes what is verified; it is not an assessment of the person.
   */
  getVerifiedProfile(userId: string, apiKey: string): Promise<VerifiedProfilePayload> {
    return this.get<VerifiedProfilePayload>(
      `/users/${encodeURIComponent(userId)}/verified-profile`,
      apiKey,
    );
  }

  /**
   * Record a qualification claim. `POST /api/v1/users/{id}/qualifications`.
   *
   * The claim is ALWAYS recorded. Whether it counts as VERIFIED is decided by
   * the witness rule, never by you: supply `verifiedBy` naming the genuine third
   * party that confirmed it. Absent (or naming the subject themselves) the claim
   * still lands on the ledger but as self-attested, with `verificationNote`
   * saying why — it does not raise verification depth.
   *
   * `issuer`/`label` are carried for display and are never read by the measure.
   * Writes nothing score-side and never enqueues a recompute.
   *
   * Pass `claimRef` to give the claim a stable identity so syncing it twice
   * (self-attested at creation, verified at confirmation) counts ONCE, and
   * `{ claimRef, retract: true }` to withdraw a claim the subject deleted.
   */
  recordQualification(
    userId: string,
    input: RecordQualificationInput,
    apiKey: string,
  ): Promise<RecordQualificationResult> {
    return this.post<RecordQualificationResult>(
      `/users/${encodeURIComponent(userId)}/qualifications`,
      input as unknown as Record<string, unknown>,
      apiKey,
    );
  }

  /**
   * Bulk-import a claimed professional record — the onboarding accelerator.
   * `POST /api/v1/users/{id}/qualifications/import`.
   *
   * Seed education, employment, skills and certifications in one call instead of
   * one `recordQualification` per line. Structured input only (no résumé parsing).
   * Every claim flows through the same single-claim writer, so `isVerified` is
   * decided by the witness rule per claim, never hardcoded: import your own
   * history with no `verifiedBy` and every claim lands self-attested, which
   * LOWERS verification depth until each is independently confirmed. Up to 100
   * claims per call (more is a 400). Partial-success — each item carries its own
   * `ok`/`error`. Writes nothing score-side.
   */
  importQualifications(
    userId: string,
    claims: QualificationImportItemInput[],
    apiKey: string,
  ): Promise<QualificationImportResponse> {
    return this.post<QualificationImportResponse>(
      `/users/${encodeURIComponent(userId)}/qualifications/import`,
      { claims } as unknown as Record<string, unknown>,
      apiKey,
    );
  }

  // ── Professional Record ────────────────────────────────────────────────────
  //
  // A worker-OWNED, résumé-shaped summary of a VERIFIED work record: reliability
  // band, verified-outcome counts, verification depth, tenure. Pure derivation
  // over the ledger the score already reads — no new scoring logic, nothing here
  // can move a score.
  //
  // ⚠️ It describes the record the subject chose to present. It is NOT a hiring,
  // promotion or employment recommendation, NOT a background check, and NOT a
  // consumer report. Selling a score into an employment DECISION is a standing
  // refusal — the disclosures travel on every payload for that reason.

  /**
   * The subject's professional record. `GET /api/v1/users/{id}/professional-record`.
   * Only third-party-verified outcomes count as verified experience; tenure is
   * the OBSERVED span of the record and a missing figure is `null`, never a
   * default. Nothing is extrapolated.
   */
  getProfessionalRecord(userId: string, apiKey: string): Promise<ProfessionalRecordPayload> {
    return this.get<ProfessionalRecordPayload>(
      `/users/${encodeURIComponent(userId)}/professional-record`,
      apiKey,
    );
  }

  /**
   * The subject's whole verified professional record — reliability + verified
   * experience + tenure + itemised qualifications — as an OPEN JSON Resume
   * document (jsonresume.org), so it drops into an ATS/HRIS or résumé tool
   * without a bespoke Credda integration. Every item is flagged verified vs
   * self-reported (a per-item `credda` extension) and verified items anchor to
   * the subject's public proof URL. A `meta.credda` block carries the reliability
   * summary, verification depth and disclosures. Requires a platform API key.
   *
   * It describes a record — never a hiring verdict, a background check, or a
   * consumer report.
   */
  getCareerExport(userId: string, apiKey: string): Promise<CareerExportDocument> {
    return this.get<CareerExportDocument>(
      `/users/${encodeURIComponent(userId)}/career-export`,
      apiKey,
    );
  }

  /**
   * The subject's career export behind a public share token — the same JSON
   * Resume document, consented via the token. Public (no key): the token is the
   * subject's own consent to present it. Verified items anchor to this same
   * public proof URL.
   */
  getPublicCareerExport(token: string): Promise<CareerExportDocument> {
    return this.get<CareerExportDocument>(
      `/verify/${encodeURIComponent(token)}/career-export`,
    );
  }

  // ── Worker Reliability Report ──────────────────────────────────────────────
  //
  // One consolidated read a staffing agency or employer weighs before placing or
  // hiring a worker — an AGGREGATION of what the engine already computed
  // (reliability, metrics, verified experience + tenure, ranked drivers, recent
  // outcomes, an optional coarse benchmark). It computes no new score.
  //
  // ⚠️ It is EVIDENCE a reader weighs against their own criteria — NOT a hire /
  // place / rank / approve verdict, a background check, or a consumer report. The
  // disclosures travel on every payload.

  /**
   * The consolidated reliability report for a subject.
   * `GET /api/v1/users/{id}/reliability-report`. Requires a platform API key.
   *
   * `recent` (1–50, default 10) bounds the outcomes list; `benchmark` attaches
   * the coarse quartile-grain comparison. Every recent outcome is flagged
   * `verified` vs `self_reported`; self-reported activity is never presented as
   * verified.
   */
  getReliabilityReport(
    userId: string,
    apiKey: string,
    opts: { recent?: number; benchmark?: boolean } = {},
  ): Promise<ReliabilityReportPayload> {
    const q = new URLSearchParams();
    if (opts.recent !== undefined) q.set('recent', String(opts.recent));
    if (opts.benchmark) q.set('benchmark', '1');
    const qs = q.toString();
    return this.get<ReliabilityReportPayload>(
      `/users/${encodeURIComponent(userId)}/reliability-report${qs ? `?${qs}` : ''}`,
      apiKey,
    );
  }

  /**
   * The reliability report behind a public share token — the worker's own
   * consent to hand their dossier to a prospective employer.
   * `GET /api/v1/verify/{token}/reliability-report`. Public (NO key): the token
   * is the capability. `reliabilityReport` is `null` if it cannot be derived.
   */
  getPublicReliabilityReport(
    token: string,
    opts: { recent?: number; benchmark?: boolean } = {},
  ): Promise<PublicReliabilityReportPayload> {
    const q = new URLSearchParams();
    if (opts.recent !== undefined) q.set('recent', String(opts.recent));
    if (opts.benchmark) q.set('benchmark', '1');
    const qs = q.toString();
    return this.get<PublicReliabilityReportPayload>(
      `/verify/${encodeURIComponent(token)}/reliability-report${qs ? `?${qs}` : ''}`,
    );
  }

  /**
   * Mint a signed Professional Record Credential (W3C VC-JWT, type
   * `CreddaProfessionalRecordCredential`) so the subject can PROVE their
   * verified record without the verifier calling Credda. Same Ed25519 issuer
   * key / did:web / StatusList2021 revocation as every other Credda VC — verify
   * it with `verifyVerifiableCredential()`.
   *
   * Also returns an "Add to LinkedIn" certification deep link. LinkedIn does not
   * ingest verifiable credentials: the link opens its certification form,
   * pre-filled, whose "Show credential" URL resolves to the subject's PUBLIC
   * verify proof. The signed credential is what carries the claims.
   *
   * Reuses the subject's EXISTING share token, so issuing never rotates a token
   * or kills a badge they already published. Refuses test-mode subjects.
   */
  mintProfessionalRecordCredential(
    userId: string,
    apiKey: string,
    options: { ttlSeconds?: number } = {},
  ): Promise<ProfessionalRecordCredentialResult> {
    return this.post<ProfessionalRecordCredentialResult>(
      `/users/${encodeURIComponent(userId)}/professional-record/credential`,
      options,
      apiKey,
    );
  }

  // ── Sandbox (crd_test_ keys only) ──────────────────────────────────────────
  //
  // Both calls REQUIRE a sandbox key and are refused for a live key with
  // `403 TEST_MODE_ONLY` before anything happens. Sandbox data runs the
  // identical deterministic formula, is invisible to live keys, and can never
  // become portable trust (no share tokens, credentials, exports or verify
  // pages).

  /**
   * Seed the sandbox with synthetic subjects so your first score read returns
   * something legible instead of `404 User not found`.
   * `POST /api/v1/test/seed`.
   *
   * Idempotent: a subject that already has events is left untouched
   * (`alreadySeeded: true`) rather than doubled — the ledger is append-only, so
   * re-seeding would otherwise silently change a score. Call
   * {@link resetSandbox} to start over.
   *
   * Every seeded id starts with `sbx_` and every seeded event carries
   * `metadata.synthetic: true`. Each subject is described by the SHAPE of its
   * record, never a promised band — the number depends on your own platform
   * trust tier, exactly as it would in production.
   */
  seedSandbox(apiKey: string): Promise<SandboxSeedResult> {
    return this.post<SandboxSeedResult>('/test/seed', {}, apiKey);
  }

  /**
   * Wipe the sandbox: this platform's test events, test users, test screenings,
   * test imports, test ingest mappings and test confirmation requests.
   * `DELETE /api/v1/test/data`.
   *
   * This is the ONLY deletion path in the product, and it exists only because
   * every row it touches is test data by construction. Live data is append-only
   * and has no deletion path, for anyone.
   */
  async resetSandbox(apiKey: string): Promise<SandboxResetResult> {
    const res = await fetch(`${this.base}${API_PREFIX}/test/data`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw await toCreddaError(res, '/test/data');
    return res.json() as Promise<SandboxResetResult>;
  }
}

/** Build a `?a=1&b=2` suffix, omitting undefined values. */
function queryString(query: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v != null) qs.set(k, String(v));
  return qs.toString() ? `?${qs.toString()}` : '';
}

/**
 * Serialise the closed book filter set. Shared by `listUsers` and
 * `getBookSummary` so the two surfaces can never disagree about the filter
 * vocabulary — the same reason the server parses both with one function.
 */
function bookFilterParams(query: BookFilterQuery): URLSearchParams {
  const qs = new URLSearchParams();
  if (query.scoreMin != null) qs.set('scoreMin', String(query.scoreMin));
  if (query.scoreMax != null) qs.set('scoreMax', String(query.scoreMax));
  if (query.band) qs.set('band', query.band);
  if (query.hasScore != null) qs.set('hasScore', String(query.hasScore));
  if (query.scoreFrozen != null) qs.set('scoreFrozen', String(query.scoreFrozen));
  if (query.subjectType) qs.set('subjectType', query.subjectType);
  if (query.activeSince) qs.set('activeSince', query.activeSince);
  if (query.registeredSince) qs.set('registeredSince', query.registeredSince);
  if (query.registeredBefore) qs.set('registeredBefore', query.registeredBefore);
  if (query.hasVerifiedEvents != null) qs.set('hasVerifiedEvents', String(query.hasVerifiedEvents));
  if (query.minVerifiedEvents != null) qs.set('minVerifiedEvents', String(query.minVerifiedEvents));
  return qs;
}

/** Build the `?days=` or `?from=&to=` suffix shared by the analytics reads. */
function analyticsQuery(window?: number | { days?: number; from?: string; to?: string }): string {
  if (typeof window === 'number') return queryString({ days: window });
  if (!window) return '';
  return queryString({ days: window.days, from: window.from, to: window.to });
}

export interface CreddaErrorContext {
  /** The API's stable machine code (see GET /api/v1/errors). */
  code?: string;
  /** Structured context — e.g. per-field problems on a VALIDATION_ERROR. */
  details?: unknown;
  /** Correlation id from `X-Request-Id`. Log it; support asks for it first. */
  requestId?: string;
  /** `Retry-After` in ms, when the server sent one (429s always do). */
  retryAfterMs?: number | null;
}

/**
 * A non-2xx response.
 *
 * Beyond the status and message it carries the API's own `code`, any structured
 * `details`, and — the reason this matters for support — the **`requestId`**.
 * Log `err.requestId` and a Credda engineer can find the exact request in our
 * logs; without it, debugging starts with "describe what happened".
 */
export class CreddaError extends Error {
  readonly code?: string;
  readonly details?: unknown;
  readonly requestId?: string;
  readonly retryAfterMs?: number | null;

  constructor(
    public readonly status: number,
    message: string,
    public readonly path: string,
    context: CreddaErrorContext = {},
  ) {
    super(
      context.requestId
        ? `credda: ${message} (requestId: ${context.requestId})`
        : `credda: ${message}`,
    );
    this.name = 'CreddaError';
    this.code = context.code;
    this.details = context.details;
    this.requestId = context.requestId;
    this.retryAfterMs = context.retryAfterMs ?? null;
  }
}

// ─── Verified Earnings ────────────────────────────────────────────────────────

/** Window selector for the earnings endpoints. `from` overrides `months`. */
export interface EarningsQuery {
  months?: number;
  from?: string;
  to?: string;
}

function earningsQs(q: EarningsQuery): string {
  const qs = new URLSearchParams();
  if (q.months != null) qs.set('months', String(q.months));
  if (q.from) qs.set('from', q.from);
  if (q.to) qs.set('to', q.to);
  return qs.toString() ? `?${qs.toString()}` : '';
}

export interface EarningsPlatformTotal {
  platform:   string;
  gross:      number;
  eventCount: number;
}

export interface EarningsPeriod {
  /** UTC calendar month, `YYYY-MM`. Months with no earnings are present with 0. */
  month:             string;
  grossVerified:     number;
  eventCount:        number;
  platformBreakdown: EarningsPlatformTotal[];
}

export interface EarningsWindow {
  from:   string;
  to:     string;
  months: number;
}

/** GET /api/v1/users/:id/earnings — the full attestation. */
export interface VerifiedEarnings {
  userId?:         string;
  earningsVersion: string;
  /** Always null — the ledger records no currency; amounts are platform-reported units. */
  currency:        null;
  note:            string;
  window:          EarningsWindow;
  periods:         EarningsPeriod[];
  attested: {
    grossVerified:     number;
    eventCount:        number;
    trailing12mTotal:  number;
    platformCount:     number;
    platformBreakdown: EarningsPlatformTotal[];
  };
  stability: {
    monthsWithEarnings:       number;
    medianMonthly:            number;
    meanMonthly:              number;
    /** Volatility. Null when there is no income to vary — never coerced to 0. */
    coefficientOfVariation:   number | null;
    longestConsecutiveMonths: number;
  };
  /** Reported but NOT attested — never blended into any attested figure. */
  unverifiedReported: { gross: number; eventCount: number };
  excluded: { disputedEvents: number; disputedValue: number; valuelessEvents: number };
  coverage: { verifiedShare: number | null; selfReportedShare: number | null };
  /** What this attestation is not. Always present. */
  disclosures: string[];
}

/** GET /api/v1/users/:id/earnings/summary — the compact lender-facing view. */
export interface EarningsSummary {
  userId?:                  string;
  earningsVersion:          string;
  currency:                 null;
  note:                     string;
  window:                   EarningsWindow;
  trailing12mVerifiedTotal: number;
  medianMonthly:            number;
  monthsWithEarnings:       number;
  volatility:               number | null;
  verifiedShare:            number | null;
  selfReportedShare:        number | null;
  platformCount:            number;
  longestConsecutiveMonths: number;
  disclosures:              string[];
}

/** POST /api/v1/users/:id/earnings/credential — a signed, revocable earnings VC. */
export interface EarningsCredentialResult {
  format:          'jwt_vc_json';
  credentialVc:    string;
  credentialType:  'CreddaEarningsCredential';
  issuer:          string;
  kid:             string;
  scope:           string;
  earningsVersion: string;
  claims:          Record<string, unknown>;
  issuedAt:        string;
  expiresAt:       string;
  didDocument:     string;
  trustRegistry:   string;
  statusList:      string;
}

// ─── Response types (match the live API) ───────────────────────────────────────

/** One developer tier from GET /api/v1/plans. */
export interface Plan {
  id:               string;   // STARTER | GROWTH | ENTERPRISE
  name:             string;
  tagline:          string;
  scopes:           string[];
  rateLimitPerMin:  number;
  /** Cap on active continuous score monitors for this tier. */
  monitorLimit:     number;
  /** Official monthly price in USD (display-only until self-serve checkout is live). */
  priceUsdMonthly:  number;
  support:          string;
  features:         string[]; // feature keys included in this tier
}

/** A feature row (label + group) for building a comparison table. */
export interface PlanFeature {
  key:   string;
  group: string;
  label: string;
}

/** Public payload from GET /api/v1/plans — the tier catalog, with official prices. */
export interface PlanCatalog {
  pricing:  string;        // 'official'
  note:     string;
  features: PlanFeature[];
  plans:    Plan[];
}

/** One documented outbound event from GET /api/v1/webhooks/events. */
export interface WebhookEventDoc {
  type:        string;   // one of the WebhookEventType values (score.*, dispute.resolved, monitor.triggered, usage.quota_warning)
  description: string;
  /** A representative `data` payload (the delivery envelope wraps this). */
  example:     Record<string, unknown>;
}

/** Public payload from GET /api/v1/webhooks/events — the event catalog. */
export interface WebhookEventCatalog {
  envelope:   Record<string, string>;
  signing:    string;
  advisory:   string;
  events:     WebhookEventDoc[];
  eventTypes: string[];
}

/** One dated change from GET /api/v1/changelog. */
export interface ChangelogEntry {
  id:         string;
  /** ISO date (YYYY-MM-DD). The release date — the API deploys on merge. */
  date:       string;
  category:   'added' | 'changed' | 'deprecated' | 'fixed' | 'security';
  summary:    string;
  /** OpenAPI-style paths the change touched. */
  endpoints?: string[];
  reference?: string;
}

/** A scheduled removal from GET /api/v1/changelog. Empty while nothing is deprecated. */
export interface DeprecationNotice {
  path:         string;
  methods?:     string[];
  announcedAt:  string;
  /** The RFC 8594 `Sunset` date, as an ISO timestamp. */
  sunsetAt:     string;
  replacement:  string;
  infoUrl?:     string;
}

/** GET /api/v1/changelog — the version contract plus every dated change. */
export interface ApiChangelog {
  apiVersion:   string;   // 'v1'
  note:         string;
  versioning: {
    version:            string;
    scheme:             string;
    guarantee:          string;
    additive:           string[];
    breaking:           string[];
    behaviourVersions:  string;
    componentVersions:  Record<string, string>;
    nextMajorVersion:   string;
    deprecation: {
      minimumNoticeDays:   number;
      announcement:        string;
      headers:             string;
      behaviourUnchanged:  string;
      activeCount:         number;
    };
  };
  deprecations: DeprecationNotice[];
  categories:   string[];
  latestChange: string | null;
  count:        number;
  entries:      ChangelogEntry[];
}

/** One documented error code from GET /api/v1/errors. */
export interface ErrorCodeDoc {
  code:        string;
  httpStatus:  number;
  title:       string;
  description: string;
  whatToDo:    string;
  /** True only when repeating the identical request can succeed later. */
  retryable:   boolean;
}

/** GET /api/v1/errors — the machine-readable error catalog. */
export interface ErrorCatalog {
  envelope:      Record<string, string>;
  retryGuidance: string;
  tracing:       string;
  codes:         ErrorCodeDoc[];
}

/** One value of a documented enum, plus its enum-specific facts. */
export interface EnumValueDoc {
  value:       string;
  description: string;
  [key: string]: unknown;
}

/** One documented enum from GET /api/v1/enums. */
export interface EnumDoc {
  name:        string;
  description: string;
  /** Where this enum appears on the wire. */
  usedIn:      string[];
  values:      EnumValueDoc[];
}

/** GET /api/v1/enums — every closed value set the API accepts or returns. */
export interface EnumCatalog {
  note:  string;
  enums: EnumDoc[];
}

/** One documented reason code from GET /api/v1/reason-codes. */
export interface ReasonCodeDoc {
  code:        string;
  factor:      string;   // completion | timeliness | disputes | verification | evidence | recency | integrity
  direction:   'adverse' | 'supporting';
  title:       string;
  description: string;
}

/** GET /api/v1/reason-codes — the adverse-action reason-code catalog. */
export interface ReasonCodeCatalog {
  reasonCodesVersion: string;
  formulaVersion:     string;
  note:               string;
  method:             string;
  keyFactorLimit:     number;
  keyFactorGuidance:  string;
  disclosures:        string[];
  codes:              ReasonCodeDoc[];
}

/**
 * One ranked reason-code instance as returned inside a subject's
 * `getScoreExplain(...)` response under `reasonCodes.adverseActionReasons` /
 * `reasonCodes.supportingFactors`.
 */
export interface ReasonCodeInstance {
  code:         string;
  factor:       string;
  direction:    'adverse' | 'supporting';
  title:        string;
  description:  string;
  /** Importance-weighted contribution (0..1); the ranking key. */
  contribution: number;
  /** 1-based rank within its direction group. */
  rank:         number;
  evidence:     Record<string, number>;
}

/** The `reasonCodes` object additively attached to GET /score/explain. */
export interface ReasonCodeResult {
  formulaVersion:       string;
  reasonCodesVersion:   string;
  /** The score attributed; null when the subject has no computed score. */
  finalScore:           number | null;
  method:               string;
  keyFactorLimit:       number;
  adverseActionReasons: ReasonCodeInstance[];
  supportingFactors:    ReasonCodeInstance[];
  disclosures:          string[];
  advisory:             string;
}

/** Public payload from GET /api/v1/verify/:token. Contains no platform user id. */
export interface TrustPayload {
  token:             string;
  /**
   * Current canonical score, or **null when no score has been computed yet**
   * — never a placeholder. A `50` fallback used to stand in here; the engine
   * never produces it for an unscored subject (v5.3 anchors a new record near
   * 20, "Unproven") and it bands as "Fair".
   */
  finalScore:        number | null;
  /** Band for `finalScore`; null when there is no score to band. */
  scoreBand:         string | null;
  confidence:        number;
  verifiedPlatforms: number;
  totalEvents:       number;
  scoreFrozen:       boolean;
  formulaVersion:    string;
  computedAt:        string | null;
  issuer:            string;
  /** Signed, offline-verifiable Verifiable Trust Credential (EdDSA JWT). */
  credential?:       string;
  credentialKid?:    string;
  credentialExp?:    string;
  jwksUri?:          string;
}

// ─── Agent subjects + delivery receipts ───────────────────────────────────────

/** Caller-declared facts about an agent. Claims, never evidence, never scored. */
export interface AgentDeclaration {
  operatorName?: string;
  operatorHomepage?: string;
  operatorDid?: string;
  modelFamily?: string;
  description?: string;
  registeredByPlatformId?: string;
  registeredAt?: string;
  /** True when the declared operator is an identifiable Credda platform. */
  operatorIsRegisteredPlatform: boolean;
}

export interface RegisterAgentInput {
  /** The agent's external id on your platform. */
  userId: string;
  /** Do YOU operate this agent? Defaults to true (the conservative reading). */
  operatedByReportingPlatform?: boolean;
  /** Required when `operatedByReportingPlatform` is false: name the operator. */
  operator?: { name?: string; homepage?: string; did?: string };
  modelFamily?: string;
  description?: string;
}

export interface AgentSubject {
  userId: string;
  subjectType: 'agent';
  agent: AgentDeclaration;
  createdAt: string;
  /** Plain-language statement of the self-dealing rule you just opted into. */
  selfDealingRule?: string;
}

/**
 * A tally of delivery outcomes already in the append-only ledger, split by
 * whether an independent counterparty was on the other side.
 */
export interface DeliveryRecord {
  deliveries: number;
  /** Deliveries a DISTINCT counterparty confirmed — the only ones that are evidence. */
  confirmedDeliveries: number;
  unconfirmedDeliveries: number;
  /** Recorded by the agent's own declared operator — never confirmed evidence. */
  selfAttestedDeliveries: number;
  failures: number;
  disputes: number;
  /** Null when nothing is confirmed yet — an absent rate is not a perfect one. */
  onTimeConfirmedDeliveries: number | null;
  onTimeRate: number | null;
  firstRecordedAt: string | null;
  lastRecordedAt: string | null;
}

/** What a delivery record is, and — stated in the payload itself — what it is not. */
export interface DeliveryRecordDisclaimer {
  isA: string;
  isNot: string[];
  selfDealingRule: string;
}

export interface AgentDetail {
  userId: string;
  subjectType: 'agent';
  agent: AgentDeclaration;
  createdAt: string;
  score: {
    finalScore: number;
    scoreBand: string;
    confidence: number;
    formulaVersion: string;
    computedAt: string;
  } | null;
  deliveryRecord: DeliveryRecord | null;
  disclaimer: DeliveryRecordDisclaimer | null;
}

export interface DeliveryReceiptsPayload {
  token: string;
  subjectType: 'person' | 'agent';
  agent: AgentDeclaration | null;
  deliveryRecord: DeliveryRecord;
  score: {
    /** Null when the subject has no computed score — never a placeholder. */
    finalScore: number | null;
    /** Band for `finalScore`; null when there is no score to band. */
    scoreBand: string | null;
    confidence: number;
    formulaVersion: string;
    computedAt: string | null;
    scoreFrozen: boolean;
  };
  disclaimer: DeliveryRecordDisclaimer;
  /** Signed W3C Verifiable Credential (VC-JWT) of the record above. */
  credentialVc: string;
  format: string;
  issuer: string;
  kid: string;
  scope: string;
  issuedAt: string;
  expiresAt: string;
  didDocument: string;
  trustRegistry: string;
}

/** did:web DID document from GET /.well-known/did.json (Trust Fabric v3). */
export interface DidDocument {
  '@context': string[];
  id: string;
  verificationMethod: Array<{ id: string; type: string; controller: string; publicKeyJwk: Record<string, unknown> }>;
  assertionMethod: string[];
  authentication: string[];
  service: Array<{ id: string; type: string; serviceEndpoint: string }>;
}

/** A single issuer entry in the trust registry (self or federated). */
export interface RegistryIssuer {
  name: string;
  did: string;
  status: string;
  credentialTypes: string[];
  didDocument: string;
  jwksUri: string;
}

/** Trust registry from GET /.well-known/credda-trust-registry.json — Credda's own issuer plus any federated ones. */
export interface TrustRegistry {
  version: string;
  issuers: RegistryIssuer[];
}

/**
 * OID4VCI Credential Issuer Metadata from
 * GET /.well-known/openid-credential-issuer.
 *
 * Typed loosely on purpose: the configuration objects are format-specific and
 * the spec explicitly tells clients to ignore members they do not recognize, so
 * a narrow type here would go stale the moment the issuer adds a format.
 */
export interface CredentialIssuerMetadata {
  credential_issuer: string;
  credential_endpoint: string;
  nonce_endpoint?: string;
  authorization_servers?: string[];
  credential_configurations_supported: Record<string, Record<string, unknown>>;
  display?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

/** Result of POST /api/v1/users/:id/credential-offer. */
export interface CredentialOfferResult {
  credentialOffer: {
    credential_issuer: string;
    credential_configuration_ids: string[];
    grants: Record<string, Record<string, unknown>>;
  };
  /** `openid-credential-offer://?credential_offer=…` — render as a QR code or a link. */
  credentialOfferUri: string;
  /** Lifetime of the single-use pre-authorized code, in seconds. */
  expiresIn: number;
  scope: 'minimal' | 'band' | 'full';
  credentialIssuer: string;
  issuerMetadata: string;
}

/** Portable trust export bundle from GET /api/v1/verify/:token/export. */
export interface TrustExport {
  format: 'credda-trust-export/1';
  exportedAt: string;
  subject: { token: string };
  score: {
    /** Null when the subject has no computed score — never a placeholder. */
    finalScore: number | null;
    /** Band for `finalScore`; null when there is no score to band. */
    scoreBand: string | null;
    confidence: number;
    formulaVersion: string;
    computedAt: string | null;
    scoreFrozen: boolean;
  };
  activity: { verifiedPlatforms: number; totalEvents: number };
  history: Array<{ finalScore: number; scoreBand: string; computedAt: string }>;
  /** Signed W3C VC-JWT (offline-verifiable). Pass `credential.vc` to verifyVerifiableCredential. */
  credential: { format: 'jwt_vc_json'; vc: string; issuer: string };
  revocation: { statusListCredential: string };
  howToVerify: string;
}

export interface ScoreBreakdown {
  cr:                      number;
  otr:                     number;
  dr:                      number;
  vd:                      number;
  platformTrustMultiplier: number;
  consistencyFactor:       number;
  momentumFactor:          number;
}

/** Payload from GET /api/v1/users/:id/score. */
export interface ScorePayload {
  userId:         string;
  /**
   * Current canonical score, or **null when no score has been computed yet**
   * — never a placeholder. A `50` fallback used to stand in here; the engine
   * never produces it for an unscored subject (v5.3 anchors a new record near
   * 20, "Unproven") and it bands as "Fair".
   */
  finalScore:     number | null;
  /** Band for `finalScore`; null when there is no score to band. */
  scoreBand:      string | null;
  confidence:     number;
  /**
   * Null when there is no snapshot to break down. A zeroed breakdown read as a
   * PERFECT record (dr 0 = no disputes, multipliers 1 = ideal) for a subject
   * with no computed evidence at all.
   */
  breakdown:      ScoreBreakdown | null;
  formulaVersion: string | null;
  velocityFlag:   boolean;
  computedAt:     string | null;
  scoreFrozen?:   boolean;
  frozenAt?:      string | null;
}

/** Payload from GET /api/v1/users/:id/trust-summary. Explains; never decides. */
/** One ranked driver behind the score on the dispatch read. */
export interface DispatchFactor {
  code: string;
  direction: 'adverse' | 'supporting';
  title: string;
  contribution: number;
}

/**
 * Payload from `GET /api/v1/users/:id/reliability?context=dispatch`.
 *
 * Every nullable field is null because the data genuinely does not exist (an
 * unscored subject, an empty ledger) — never a placeholder zero.
 */
export interface DispatchReliabilityPayload {
  userId: string;
  context: string;
  dispatchReliabilityVersion: string;
  score: number | null;
  band: string | null;
  confidence: number | null;
  scoreFrozen: boolean;
  formulaVersion: string | null;
  computedAt: string | null;
  evidence: { totalOutcomes: number; verifiedOutcomes: number };
  /** Breach-type share of the outcome record ∈ [0,1]; null with no outcomes. */
  noShowRate: number | null;
  onTimeRate: number | null;
  daysSinceLastEvent: number | null;
  topFactors: DispatchFactor[];
  note: string;
  disclosures: string[];
}

export interface TrustSummaryPayload {
  userId: string;
  available: boolean;
  summary: string;
  strengths?: string[];
  risks?: string[];
  evidence?: {
    finalScore: number;
    scoreBand: string;
    confidenceLevel: 'high' | 'moderate' | 'low' | 'none';
    completionRate: number;
    onTimeRate: number;
    verifiedEvents: number;
    totalEvents: number;
    distinctPlatforms: number;
  };
  /** Standing note that this is evidence, not a recommendation. */
  advisory?: string;
  formulaVersion?: string;
  computedAt?: string;
  ai?: { enabled: boolean; narrative: string | null };
}

/** One entry in a batch score read: a summary, or a not-found marker. */
export type BatchScoreEntry =
  // A found subject with no computed score reports null, never a placeholder.
  | { userId: string; finalScore: number | null; scoreBand: string | null; scoreFrozen: boolean }
  | { userId: string; error: 'not_found' };

/** Payload from POST /api/v1/users/scores. */
export interface BatchScoresPayload {
  scores:         BatchScoreEntry[];
  count:          number;
  formulaVersion: string;
}

/**
 * The filter vocabulary shared by `GET /api/v1/users` and
 * `GET /api/v1/users/summary`. A CLOSED set on purpose — there is deliberately
 * no free-form query language, because the closed set is what lets the server
 * guarantee tenant scoping for every combination.
 */
export interface BookFilterQuery {
  scoreMin?:          number;
  scoreMax?:          number;
  band?:              string;
  /**
   * true = only subjects whose score has been computed; false = only those
   * still awaiting a first score. Cannot be combined with
   * `scoreMin`/`scoreMax`/`band` (an unscored subject has no score to compare).
   */
  hasScore?:          boolean;
  /** true = only subjects whose score is frozen by a velocity flag. */
  scoreFrozen?:       boolean;
  subjectType?:       'PERSON' | 'AGENT' | 'ORGANIZATION';
  /** ISO instant — only subjects with ≥1 of YOUR events at/after it. */
  activeSince?:       string;
  /** ISO instant — only subjects first seen in the ledger at/after it (inclusive). */
  registeredSince?:   string;
  /** ISO instant — only subjects first seen in the ledger BEFORE it (exclusive). */
  registeredBefore?:  string;
  hasVerifiedEvents?: boolean;
  minVerifiedEvents?: number;
}

/** Query for GET /api/v1/users (list your subjects). Closed filter set. */
export interface ListUsersQuery extends BookFilterQuery {
  sort?:              'score' | 'lastActivity' | 'registered' | 'externalId';
  order?:             'asc' | 'desc';
  limit?:             number;
  cursor?:            string;
}

/** One subject in your book (GET /api/v1/users) — operational fields only. */
export interface SubjectSummary {
  externalId:         string;
  subjectType:        string;
  /**
   * Current canonical score, or **null when no score has been computed yet** —
   * never a placeholder. Filter these in or out with `hasScore`.
   */
  finalScore:         number | null;
  /** Band for `finalScore`; null when there is no score to band. */
  scoreBand:          string | null;
  scoreFrozen:        boolean;
  verificationDepth:  number | null;
  /** Count of YOUR events for this subject (not a cross-platform total). */
  eventCount:         number;
  verifiedEventCount: number;
  lastActivityAt:     string | null;
  registeredAt:       string;
  computedAt:         string | null;
}

/** Payload from GET /api/v1/users — a cursor-paginated page of your subjects. */
export interface ListUsersPayload {
  data:       SubjectSummary[];
  count:      number;
  nextCursor: string | null;
}

/** One band bucket in a segment summary. */
export interface BookSummaryBand {
  band:     string;
  minScore: number;
  count:    number;
  /** Percentage of the SCORED population; null when that population is empty. */
  share:    number | null;
}

/**
 * Payload from GET /api/v1/users/summary — counts and score shape for a segment
 * of your book, defined by the same closed filter set as `listUsers`.
 *
 * Nothing is faked: `central` members are null when nothing in the segment is
 * scored, and if the population exceeded the server's fold cap the exact
 * `matched` count is still returned while the aggregates come back null with
 * `aggregationSkipped` stating why.
 */
export interface BookSummaryPayload {
  formulaVersion:    string;
  /** Exact number of YOUR subjects matching the filters. Always present. */
  matched:           number;
  scored:            number | null;
  unscored:          number | null;
  central:           { median: number | null; mean: number | null } | null;
  bandDistribution:  BookSummaryBand[] | null;
  aggregationSkipped?: { reason: 'population_too_large'; maxSubjects: number };
}

export interface ScoreExplainFactor {
  name:         string;
  value:        number;
  weight:       string;
  contribution: number;
  description:  string;
}

/** Payload from GET /api/v1/users/:id/score/explain. */
export interface ScoreExplainPayload {
  summary:  string;
  factors:  ScoreExplainFactor[];
  /** Deterministic adverse-action reason codes for the record (ECOA / Reg B).
   *  A partner draws its statement of specific reasons from
   *  `reasonCodes.adverseActionReasons`. See getReasonCodes() for the catalog. */
  reasonCodes?: ReasonCodeResult;
  platformTrust?: { explanation: string; appliedTier: string; multiplier: number };
  consistency?:   { factor: number; description: string };
  momentum?:      { factor: number; direction: string; description: string };
  confidence:     { eventsRecorded: number; eventsNeededForFull: number; level: string };
  /** Present ONLY for an unverified record whose live position is set by the
   *  recency-weighted provisional band. A counterparty-verified record is
   *  anchored by its verified outcomes (which carry no date) and does NOT decay
   *  with inactivity, so it returns `null` here — this is never a claim that a
   *  verified score "softens with time". */
  recencyWarning?: string | null;
  computedAt?:     string;
}

export interface ScoreHistoryPayload {
  data:  Array<Record<string, unknown>>;
  count: number;
  /** Pass as `cursor` to fetch the next page; `null`/absent once exhausted. */
  nextCursor?: string | null;
}

/** One factor's movement between two score computations. */
export interface FactorDelta {
  factor:   'CR' | 'OTR' | 'DR' | 'VD';
  before:   number;
  after:    number;
  delta:    number;
  improved: boolean;
}

/** Payload from GET /api/v1/users/:id/score/delta. */
export interface ScoreDeltaPayload {
  userId:          string;
  available:       boolean;
  from?:           { finalScore: number; computedAt: string };
  to?:             { finalScore: number; computedAt: string };
  scoreDelta?:     number;
  direction?:      'up' | 'down' | 'unchanged';
  confidenceDelta?: number;
  momentumDelta?:  number;
  factors?:        FactorDelta[];
  topDriver?:      FactorDelta | null;
  formulaVersion?: string;
}

/** One named, independently 0–100-scored component of a user's score. */
export interface ScoreComponent {
  key:         'reliability' | 'timeliness' | 'trustworthiness' | 'verification' | 'consistency' | 'momentum';
  label:       string;
  score:       number;
  weight:      number | null;
  description: string;
}

/** Payload from GET /api/v1/users/:id/score/components. */
export interface ScoreComponentsPayload {
  userId:          string;
  available:       boolean;
  finalScore?:     number;
  scoreBand?:      string;
  components:      ScoreComponent[];
  computedAt?:     string;
  formulaVersion?: string;
}

/** The public benchmark catalog — cohort dimensions + the k-anonymity guarantee. */
export interface BenchmarkCatalog {
  benchmarkVersion: string;
  formulaVersion:   string;
  note:             string;
  kAnonymity:       { minimumCohortSize: number; guarantee: string };
  dimensions:       Array<{ dimension: string; description: string; justification: string; values: Array<{ value: string; description: string }> }>;
  statistics:       string[];
  subjectComparison:{ description: string; coarseLabels: string[] };
  disclosures:      string[];
  deterministic:    boolean;
}

/** Aggregate order statistics over a cohort (only present when available). */
export interface BenchmarkStatistics {
  median: number;
  mean:   number;
  p25:    number;
  p75:    number;
  p90:    number;
}

/** One cohort's distribution — either available with numbers, or suppressed. */
export type BenchmarkCohort =
  | {
      available: true;
      dimension: string;
      cohort: string;
      cohortSize: number;
      statistics: BenchmarkStatistics;
      bandDistribution: Array<{ band: string; minScore: number; count: number }>;
    }
  | {
      available: false;
      dimension: string;
      cohort: string;
      reason: 'insufficient_data';
      minimumCohortSize: number;
    };

/** GET /benchmarks/distribution — one cohort (with `cohort`) or a whole dimension. */
export type BenchmarkDistributionPayload =
  | ({ benchmarkVersion: string; formulaVersion: string } & BenchmarkCohort)
  | {
      benchmarkVersion: string;
      formulaVersion: string;
      dimension: string;
      populationSize: number;
      cohorts: BenchmarkCohort[];
    };

/** GET /users/:id/benchmark — where the subject sits within its cohort. */
export type UserBenchmarkPayload =
  | {
      userId: string;
      available: true;
      dimension: string;
      cohort: string;
      cohortSize: number;
      finalScore: number;
      percentile: number;
      comparison: 'top_decile' | 'top_quartile' | 'above_median' | 'below_median';
      distribution: BenchmarkStatistics;
      bandDistribution: Array<{ band: string; minScore: number; count: number }>;
      formulaVersion: string;
    }
  | { userId: string; dimension: string; available: false; reason: 'insufficient_data' | 'no_score'; minimumCohortSize?: number; cohort?: string };

/** One entry in a user's timeline: either a ledger event or a score change. */
export type TimelineItem =
  | {
      type: 'event';
      id: string;
      occurredAt: string;
      eventType: string;
      platformName: string;
      isVerified: boolean;
      stakeLevel: string;
      daysLate: number | null;
      dispute: { status: string; resolvedAt: string | null } | null;
    }
  | {
      type: 'score_change';
      id: string;
      occurredAt: string;
      finalScore: number;
      scoreBand: string;
      scoreDelta: number | null;
      direction: 'up' | 'down' | 'unchanged' | null;
      topDriver: FactorDelta | null;
    };

/** Payload from GET /api/v1/users/:id/timeline. */
export interface TimelinePayload {
  data:       TimelineItem[];
  count:      number;
  nextCursor: string | null;
}

/**
 * Event types the read-only what-if projection accepts — the FULL vocabulary,
 * a superset of `IngestEventType`. A projection writes nothing, so the dispute
 * outcomes the API produces itself are modellable too, and so is
 * `CONTRACT_BREACHED` (the strongest negative signal in the formula).
 */
export type ProjectionEventType =
  | IngestEventType
  | 'DISPUTE_FILED'
  | 'DISPUTE_RESOLVED_AGAINST_USER';

/** One hypothetical prospective event for `projectScore`. Only `eventType` is required. */
export interface ProjectionEventInput {
  /** Kept assignable from any string so a newer server value never fails to typecheck. */
  eventType:         ProjectionEventType | (string & {});
  stakeLevel?:       'HIGH' | 'MEDIUM' | 'LOW';
  platformTier?:     'ENTERPRISE' | 'GROWTH' | 'STARTER' | 'SELF_REPORTED';
  isVerified?:       boolean;
  daysLate?:         number;
  transactionValue?: number | null;
}

/** Payload from POST /api/v1/users/:id/score/project. */
export interface ScoreProjectionPayload {
  userId:         string;
  delta:          number;
  current:        { finalScore: number; scoreBand: string };
  projected:      { finalScore: number; scoreBand: string };
  bandChanged:    boolean;
  formulaVersion: string;
}

/** Payload from GET /api/v1/usage/quota. */
export interface QuotaPayload {
  platform:          { id: string; name: string; tier: string };
  rateLimitPerMin:   number;
  unlimited:         boolean;
  cap:               number | null;
  used:              number;
  remaining:         number | null;
  usedRatio:         number | null;
  resetAt:           string;
  secondsUntilReset: number;
}

/** One structured claim for `analyzeDocument`. Only `eventType` is required. */
export interface DocumentClaimInput {
  /** An ingestable event type; kept assignable from any string for forward-compat. */
  eventType:         ProjectionEventType | (string & {});
  label?:            string;
  stakeLevel?:       'HIGH' | 'MEDIUM' | 'LOW';
  transactionValue?: number | null;
  daysLate?:         number;
  /** Who can confirm this. Its PRESENCE decides whether the claim can count as verified. */
  counterpartyRef?:  string;
}

/** Per-claim advice from POST /api/v1/users/:id/documents/analyze. */
export interface DocumentClaimAdvice {
  eventType:      string;
  label:          string | null;
  polarity:       'positive' | 'negative' | 'neutral';
  witness:        string;
  hasWitness:     boolean;
  willBeVerified: boolean;
  recommendation: string;
  advice:         string;
}

/** Payload from POST /api/v1/users/:id/documents/analyze. Writes nothing. */
export interface DocumentAdvicePayload {
  userId: string;
  claims: DocumentClaimAdvice[];
  projection: {
    current:       { finalScore: number; scoreBand: string };
    asSubmitted:   { finalScore: number; scoreBand: string };
    ifAllVerified: { finalScore: number; scoreBand: string };
  };
  witnessGuide:   Record<string, { witness: string; polarity: string }>;
  summary:        string;
  formulaVersion: string;
  note:           string;
}

export interface ContributingPlatform {
  platformName:       string;
  trustTier:          string;
  eventCount:         number;
  verifiedEventCount: number;
  countsTowardVD:     boolean;
}

export interface PlatformsPayload {
  platforms: ContributingPlatform[];
}

/** Event types accepted by POST /api/v1/events. */
export type IngestEventType =
  | 'TRANSACTION_COMPLETED' | 'CONTRACT_FULFILLED' | 'REVIEW_VERIFIED'
  | 'DISPUTE_RESOLVED_FOR_USER' | 'TRANSACTION_CANCELLED' | 'CONTRACT_CANCELLED'
  | 'CONTRACT_BREACHED' | 'TRANSACTION_DISPUTED';

/** Body for reportEvent / POST /api/v1/events. */
export interface ReportEventInput {
  userId:            string;
  eventType:         IngestEventType;
  dueDate?:          string;
  completedAt?:      string;
  stakeLevel?:       'HIGH' | 'MEDIUM' | 'LOW';
  isVerified?:       boolean;
  transactionValue?: number;
  metadata?:         Record<string, unknown>;
}

/** One event in a batch (reportEvents / POST /events/batch). */
export interface BatchEventInput extends ReportEventInput {
  /** Per-item idempotency key (8–255 chars) — a replay is a no-op returning the original event id. */
  idempotencyKey?: string;
}

/** Result of reportEvents — partial success, one entry per input event. */
export interface BatchEventsResult {
  total:     number;
  created:   number;
  duplicate: number;
  failed:    number;
  results: Array<{
    index:    number;
    userId:   string;
    status:   'created' | 'duplicate' | 'failed';
    eventId?: string;
    error?:   string;
  }>;
}

/** Event a webhook can subscribe to. Mirrors WEBHOOK_EVENT_TYPES in the API. */
export type WebhookSubscriptionEvent =
  | 'score.updated'
  | 'score.band_changed'
  | 'dispute.resolved'
  | 'monitor.triggered'
  | 'policy.threshold_crossed'
  | 'usage.quota_warning'
  | 'import.completed'
  | 'screening.completed'
  | 'confirmation.awaiting_response'
  | 'confirmation.expiring_soon';

// ─── Score monitors ────────────────────────────────────────────────────────────

/** A score monitor (continuous monitoring). `userId` is your externalId. */
export interface ScoreMonitor {
  id: string;
  userId: string;
  /** Fires when the score crosses DOWN through this threshold. */
  belowScore: number | null;
  /** Fires when the score crosses UP through this threshold. */
  aboveScore: number | null;
  /** Fires whenever the score band label changes. */
  onBandChange: boolean;
  isActive: boolean;
  lastTriggeredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Body for createMonitor — at least one condition is required. */
export interface CreateMonitorInput {
  /** The platform's external user id. */
  userId: string;
  belowScore?: number;
  aboveScore?: number;
  onBandChange?: boolean;
}

/** Patch for updateMonitor. null clears a threshold; ≥1 condition must remain. */
export interface UpdateMonitorInput {
  belowScore?: number | null;
  aboveScore?: number | null;
  onBandChange?: boolean;
  isActive?: boolean;
}

/** Cursor-paginated payload from GET /api/v1/monitors. */
export interface MonitorListPayload {
  data: ScoreMonitor[];
  nextCursor: string | null;
}

// ─── Bulk screenings (async batch score reads) ────────────────────────────────

export type ScreeningStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';

/** One screening job's status + summary (results are fetched separately). */
export interface ScreeningJob {
  id: string;
  status: ScreeningStatus;
  /** Deduped ids submitted. */
  totalCount: number;
  /** Ids that resolved to a known user. Null until processed. */
  foundCount: number | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

/**
 * One screened user. Score fields are present only when `found` — and are
 * **null when the subject exists but has no computed score**. `found` answers
 * "does this subject exist"; `score` answers "has it been scored". A `50`
 * placeholder used to conflate the two.
 */
export interface ScreeningResultItem {
  externalId: string;
  found: boolean;
  score?: number | null;
  band?: string | null;
  confidence?: number;
  computedAt?: string;
}

/** Cursor-paginated payload from GET /api/v1/screenings. */
export interface ScreeningListPayload {
  data: ScreeningJob[];
  nextCursor: string | null;
}

/** Payload from GET /api/v1/screenings/:id/results. */
export interface ScreeningResultsPayload {
  screening: ScreeningJob;
  results: ScreeningResultItem[];
  count: number;
}

// ─── Data ingress: field mapping + historical CSV import ─────────────────────

/** The fixed transform whitelist. No caller-supplied code, by design. */
export type IngestTransform = 'cents_to_units' | 'iso_date' | 'lowercase' | 'trim' | 'boolean';

/** One field rule: a dot-path, or an object form. Declarative data, never code. */
export type IngestFieldRule =
  | string
  | {
      /** Dot-path into the record; numeric segments index arrays. */
      path?: string;
      /** A constant, used instead of reading the record. */
      const?: unknown;
      /** `{ sourceValue: creddaValue }`, applied AFTER any transforms. */
      values?: Record<string, unknown>;
      /** Fallback when the path is missing, or `values` has no entry. */
      default?: unknown;
      /** One transform, or an ordered list applied left-to-right. */
      transform?: IngestTransform | IngestTransform[];
    };

/**
 * How to reach Credda's event fields from YOUR record shape.
 * `verifiedBy` is not an event field — it is the counterparty/witness
 * identifier that licenses `isVerified: true`. Without it a record still
 * ingests, with `isVerified: false` and a warning.
 */
export interface IngestMapping {
  userId?: IngestFieldRule;
  eventType?: IngestFieldRule;
  dueDate?: IngestFieldRule;
  completedAt?: IngestFieldRule;
  stakeLevel?: IngestFieldRule;
  isVerified?: IngestFieldRule;
  transactionValue?: IngestFieldRule;
  metadata?: IngestFieldRule;
  idempotencyKey?: IngestFieldRule;
  verifiedBy?: IngestFieldRule;
}

export interface IngestInput {
  /** An inline mapping. Mutually exclusive with `mappingId`. */
  mapping?: IngestMapping;
  /** A stored mapping's id. Mutually exclusive with `mapping`. */
  mappingId?: string;
  /** Your records, verbatim (max 100 per call). */
  records: unknown[];
}

/** One record's outcome. Records fail INDIVIDUALLY. */
export interface IngestResultItem {
  index: number;
  userId?: string;
  status: 'created' | 'duplicate' | 'failed';
  eventId?: string;
  error?: string;
  /** Non-fatal notes — most commonly an `isVerified` downgrade. */
  warnings?: string[];
}

export interface IngestPayload {
  total: number;
  created: number;
  duplicate: number;
  failed: number;
  results: IngestResultItem[];
}

export interface CreateMappingInput {
  name: string;
  description?: string;
  mapping: IngestMapping;
}

export interface StoredMapping {
  id: string;
  name: string;
  description: string | null;
  mapping: IngestMapping;
  createdAt: string;
  updatedAt: string;
}

export interface MappingListPayload {
  data: StoredMapping[];
  nextCursor: string | null;
}

export interface CreateImportInput {
  /** The CSV file contents. Mapping paths are COLUMN NAMES. */
  csv: string;
  mapping?: IngestMapping;
  mappingId?: string;
}

export type ImportStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';

export interface ImportJob {
  id: string;
  status: ImportStatus;
  /** Data rows in the file (never truncated — an over-cap file is refused). */
  totalRows: number;
  createdCount: number;
  /** Rows already present under their idempotency key (a safe re-upload). */
  skippedCount: number;
  /** Authoritative even when the stored error list is capped. */
  failedCount: number;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ImportListPayload {
  data: ImportJob[];
  nextCursor: string | null;
}

/** One rejected row. `row` is 1-based over DATA rows (header excluded). */
export interface ImportRowError {
  row: number;
  error: string;
  userId?: string;
}

export interface ImportRowWarning {
  row: number;
  warning: string;
  userId?: string;
}

export interface ImportErrorsPayload {
  import: ImportJob;
  errors: ImportRowError[];
  errorCount: number;
  warnings: ImportRowWarning[];
  warningCount: number;
  /** True when more rows failed than the stored list retains. */
  truncated: boolean;
}

export interface CreateWebhookInput {
  url: string;
  events: WebhookSubscriptionEvent[];
  description?: string;
}

/** Public webhook projection (never includes the signing secret). */
export interface WebhookConfig {
  id: string;
  url: string;
  events: WebhookSubscriptionEvent[];
  description: string | null;
  isActive: boolean;
  failureCount: number;
  deliveredCount: number;
  lastStatus: number | null;
  lastError: string | null;
  lastDeliveryAt: string | null;
  disabledAt: string | null;
  createdAt: string;
}

export interface CreateWebhookResult {
  webhook: WebhookConfig;
  /** Signing secret — shown ONCE. Store it to verify deliveries. */
  secret: string;
}

export interface UpdateWebhookInput {
  url?: string;
  events?: WebhookSubscriptionEvent[];
  description?: string | null;
  isActive?: boolean;
}

export interface WebhookTestResult {
  delivered: boolean;
  statusCode: number | null;
  error: string | null;
  durationMs: number | null;
}

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  eventId: string;
  eventType: string;
  /** 1-based attempt number — retries with backoff log one row per attempt. */
  attempt?: number;
  success: boolean;
  statusCode: number | null;
  error: string | null;
  durationMs: number | null;
  createdAt: string;
}

/** The delivery attempt that carried an event. Null for catalog examples. */
export interface RecentWebhookEventDelivery {
  id: string;
  webhookId: string;
  attempt: number;
  success: boolean;
  statusCode: number | null;
  deliveredAt: string;
}

/**
 * One item from `GET /api/v1/webhooks/deliveries`: the delivery envelope as
 * sent, plus provenance.
 */
export interface RecentWebhookEvent {
  /** Event id — stable across retries and replays. Dedupe on this. */
  id: string;
  type: WebhookSubscriptionEvent;
  livemode: boolean;
  createdAt: string;
  data: unknown;
  /** true = a catalog example, NOT a delivery that occurred. */
  isExample: boolean;
  delivery: RecentWebhookEventDelivery | null;
}

export interface RecentWebhookEventsPayload {
  data: RecentWebhookEvent[];
  nextCursor: string | null;
  /** `examples` means nothing has been delivered yet and the catalog was used. */
  source: 'deliveries' | 'examples';
}

export type DisputeOutcome = 'FOR_USER' | 'AGAINST_USER';

/** Result of PATCH /api/v1/disputes/:id/resolve. */
export interface DisputeResult {
  dispute: Record<string, unknown>;
}

/** Result of minting a share token (POST /api/v1/users/:id/share-token). */
export interface ShareTokenResult {
  token:        string;
  verifyUrl:    string;
  embedSnippet: string;
  widgetSrc:    string;
}

export interface ReportEventResult {
  event:  Record<string, unknown>;
  userId: string;
  dispute?: Record<string, unknown>;
}

/** Payload from GET /api/v1/users/:id/risk — advisory only, never affects the score. */
export interface RiskPayload {
  riskLevel:  string;
  riskScore:  number;
  signals:    Array<{ code?: string; severity?: string; detail?: string } & Record<string, unknown>>;
  advisory:   boolean;
  computedAt: string;
  /** Optional advisory AI narration; null unless the AI subsystem is enabled. */
  aiSummary?: unknown;
}

/** One row of the platform's own activity log (GET /api/v1/activity). */
export interface ActivityEntry {
  id: string;
  /** Audit action, e.g. EVENT_CREATED, WEBHOOK_UPDATED, SHARE_TOKEN_MINTED. */
  action: string;
  /** The action's recorded detail, as written — always includes your platformId. */
  payload: Record<string, unknown>;
  createdAt: string;
}

/** Cursor-paginated payload from GET /api/v1/activity (newest first). */
export interface ActivityPayload {
  data: ActivityEntry[];
  nextCursor: string | null;
}

/** One exported event (GET /api/v1/events/export) — your own recorded fields. */
export interface ExportedEvent {
  id: string;
  /** Your own external user id. */
  userId: string;
  eventType: string;
  stakeLevel: string;
  isVerified: boolean;
  /** Convenience view of `metadata.autoImported === true`. */
  autoImported: boolean;
  transactionValue: number | null;
  dueDate: string | null;
  completedAt: string | null;
  daysLate: number | null;
  createdAt: string;
  metadata: Record<string, unknown>;
}

/** Cursor-paginated payload from GET /api/v1/events/export (oldest first). */
export interface EventExportPayload {
  data: ExportedEvent[];
  nextCursor: string | null;
}

export interface UsageDay {
  date:        string;
  total:       number;
  ok:          number;
  clientError: number;
  serverError: number;
}

/** Payload from GET /api/v1/usage — the calling platform's own consumption. */
export interface UsagePayload {
  platform:        { id: string; name: string; tier: string };
  rateLimitPerMin: number;
  quota:           { cap: number | null; used: number; remaining: number | null; resetAt: string };
  /** Trailing window (`{days}`) or explicit range (`{from,to,…}`, ISO dates, clamped to retention). */
  window:
    | { days: number }
    | { from: string; to: string; requestedFrom: string; requestedTo: string; truncated: boolean; retentionDays: number };
  days:            UsageDay[];
  totals:          Omit<UsageDay, 'date'>;
  /** Busiest endpoints over the window (route patterns), descending. */
  endpoints?:      Array<{ endpoint: string; total: number }>;
}

// ─── Usage meters (Stripe Billing Meters shape) ───────────────────────────────

export interface UsageMeterRow {
  meter: string;
  dimension: 'total' | 'status_class' | 'endpoint';
  value: string;
  quantity: number;
}

export interface UsageMetersPayload {
  platform: { id: string; name: string; tier: string };
  window: UsagePayload['window'];
  from: string;
  to: string;
  meters: UsageMeterRow[];
}

// ─── Platform analytics ───────────────────────────────────────────────────────

/** Trailing (`{days}`) or explicit-range analytics window echoed by the server. */
export type AnalyticsWindow =
  | { days: number; from: string; to: string }
  | { from: string; to: string; requestedFrom: string; requestedTo: string; truncated: boolean; maxDays: number };

/**
 * `verified` counts the raw `isVerified` flag — on a directly-reported event that
 * is the reporting platform's OWN assertion. `confirmed` counts only events a
 * DISTINCT counterparty wrote by acting on a one-time confirmation token, so it
 * is the third-party evidence density of an integration. `confirmed` is always a
 * subset of `verified`. Shares are null when the bucket has no events — never a
 * placeholder 0.
 */
export interface EventAnalyticsBucket {
  total: number;
  verified: number;
  confirmed: number;
  verifiedShare: number | null;
  confirmedShare: number | null;
}

export interface EventAnalyticsPayload {
  window: AnalyticsWindow;
  totals: EventAnalyticsBucket;
  daily: Array<EventAnalyticsBucket & { date: string }>;
  byType: Array<EventAnalyticsBucket & { eventType: string }>;
}

export interface ScoreAnalyticsPayload {
  formulaVersion: string;
  window: AnalyticsWindow;
  scoredSubjects: number;
  central: { median: number | null; mean: number | null };
  bandDistribution: Array<{ band: string; minScore: number; count: number; share: number | null }>;
  movement: { up: number; down: number; unchanged: number; subjectsMoved: number; subjectsRecomputed: number };
}

// ─── Sandbox ──────────────────────────────────────────────────────────────────

/** One seeded sandbox subject, with the score the real formula just gave it. */
export interface SandboxSeedSubject {
  /** Your caller-visible external id. Always starts with `sbx_`. */
  userId: string;
  label: string;
  /** What the record LOOKS like. Deliberately never a promised band. */
  record: string;
  /** The single most interesting call to make against this subject. */
  tryNext: string;
  totalEvents: number;
  eventsWritten: number;
  /** True when this subject already held events and was left untouched. */
  alreadySeeded: boolean;
  finalScore: number | null;
  scoreBand: string | null;
  confidence: number | null;
}

/** Payload from POST /api/v1/test/seed. */
export interface SandboxSeedResult {
  seeded: boolean;
  /** Always false — this is sandbox data. */
  livemode: boolean;
  seedVersion: number;
  subjectsCreated: number;
  /** Subjects that already held events and were left untouched. */
  subjectsSkipped: number;
  eventsWritten: number;
  subjects: SandboxSeedSubject[];
  note: string;
  nextSteps: string[];
}

/** Payload from DELETE /api/v1/test/data. */
export interface SandboxResetResult {
  reset: boolean;
  deleted: {
    users: number;
    events: number;
    screenings: number;
    imports: number;
    ingestMappings: number;
    confirmations: number;
  };
  note: string;
}

// ─── Confirmation requests ────────────────────────────────────────────────────

/**
 * Lifecycle of a confirmation request. Created `PENDING`; the counterparty's
 * action (or time) moves it to exactly one terminal state. Only `CONFIRMED`
 * ever produces a ledger event.
 */
export type ConfirmationStatus = 'PENDING' | 'CONFIRMED' | 'DECLINED' | 'EXPIRED' | 'CANCELLED';

/** What the counterparty can do with their token. */
export type ConfirmationDecision = 'confirm' | 'decline';

/**
 * Body for `createConfirmationRequest`. `eventType` is one of the SAME types a
 * platform may report directly (`IngestEventType`) — a counterparty can confirm
 * a positive outcome or a negative one with equal validity.
 */
export interface CreateConfirmationInput {
  /** Your own external id for the subject of the proposed outcome. */
  userId:            string;
  eventType:         IngestEventType;
  stakeLevel?:       'HIGH' | 'MEDIUM' | 'LOW';
  transactionValue?: number;
  dueDate?:          string;
  completedAt?:      string;
  metadata?:         Record<string, unknown>;
  /**
   * Your opaque matching key for the counterparty (an id, a reference — not
   * necessarily an address). It must not name the subject: a subject cannot be
   * its own independent witness (400 `CONFIRMATION_SELF`).
   */
  counterpartyRef:   string;
  /** Human name shown to the counterparty on the preview / hosted page. */
  counterpartyName?: string;
  /** Human description of what they are being asked to confirm. */
  description?:      string;
  /** Where the HOSTED page returns them after they decide. Strictly validated. */
  returnUrl?:        string;
  /** 1–90 days; clamped server-side. */
  expiresInDays?:    number;
}

/** A confirmation request, as its OWNING platform sees it. */
export interface ConfirmationRequest {
  id:                string;
  subjectExternalId: string;
  eventType:         string;
  stakeLevel:        string;
  transactionValue:  number | null;
  dueDate:           string | null;
  completedAt:       string | null;
  counterpartyRef:   string;
  counterpartyName:  string | null;
  description:       string | null;
  /** The claim identity supplied at create time; passed to the writer on confirm. Null when none. */
  claimRef:          string | null;
  /** Post-decision redirect configured for the hosted page (null when unset). */
  returnUrl:         string | null;
  status:            ConfirmationStatus;
  expiresAt:         string;
  /** The ledger event a CONFIRMED request produced. Null in every other state. */
  resultingEventId:  string | null;
  decidedAt:         string | null;
  createdAt:         string;
}

/** Result of `createConfirmationRequest`. The token is returned ONCE. */
export interface ConfirmationCreateResult {
  confirmation:      ConfirmationRequest;
  /** Raw one-time token — deliver it to the counterparty over your own channel. */
  confirmationToken: string;
  /** Credda's hosted confirmation page — the zero-frontend path. */
  confirmUrl:        string;
  /** The API preview, for platforms building their own confirmation UI. */
  previewUrl:        string;
  /** Where that UI POSTs the decision. */
  respondUrl:        string;
}

/**
 * Result of `createConfirmationBatch` — partial success, one entry per input
 * request. An ok item carries its one-time token + hosted confirmUrl; a failed
 * one carries the reason + code. Nothing is written to the ledger by any item.
 */
export interface ConfirmationBatchResult {
  total:   number;
  created: number;
  failed:  number;
  results: Array<{
    index:              number;
    ok:                 boolean;
    userId:             string;
    /** ok items: the created request id. */
    id?:                string;
    /** ok items: PENDING. */
    status?:            ConfirmationStatus;
    /** ok items: the one-time token — shown ONCE, deliver it to the counterparty. */
    confirmationToken?: string;
    /** ok items: the hosted "Confirm with Credda" page for this request. */
    confirmUrl?:        string;
    /** failed items: human reason. */
    error?:             string;
    /** failed items: error code, e.g. CONFIRMATION_SELF. */
    code?:              string;
  }>;
}

/** Cursor-paginated payload from `listConfirmations`. */
export interface ConfirmationListPayload {
  data:       ConfirmationRequest[];
  nextCursor: string | null;
}

/**
 * One roster row for `createActivationCampaign` — exactly a `CreateConfirmationInput`
 * plus an optional `rowKey` (your own stable id for the roster line, e.g. a shift
 * id, which makes the campaign idempotent per row).
 */
export interface ActivationRow extends CreateConfirmationInput {
  rowKey?: string;
}

/** Body for `createActivationCampaign`. */
export interface CreateActivationCampaignInput {
  /** Optional human label ("March 2026 roster import"). Display only; never scored. */
  name?: string;
  /** Up to 500 roster rows. */
  rows: ActivationRow[];
}

/**
 * Result of `createActivationCampaign` — partial success. Each `results` entry is
 * one row's outcome: an ok row carries its one-time token + hosted confirmUrl; a
 * failed one carries the reason + code. Nothing is written to the ledger by any
 * row. `duplicates` lists rows dropped as in-batch repeats of an earlier rowKey.
 */
export interface ActivationCampaignResult {
  campaign: {
    id:             string;
    name:           string | null;
    submittedCount: number;
    createdAt:      string;
  };
  created:    number;
  failed:     number;
  duplicates: Array<{ index: number; rowKey: string }>;
  results: Array<{
    index:              number;
    ok:                 boolean;
    userId:             string;
    id?:                string;
    status?:            ConfirmationStatus;
    rowKey?:            string;
    confirmationToken?: string;
    confirmUrl?:        string;
    error?:             string;
    code?:              string;
  }>;
}

/** The funnel a campaign reports — factual counts, never a score or judgement. */
export interface ActivationFunnel {
  submitted:        number;
  pending:          number;
  confirmed:        number;
  declined:         number;
  expired:          number;
  cancelled:        number;
  /** confirmed / submitted (0 when nothing submitted). */
  confirmationRate: number;
}

/** Payload from `getActivationCampaign`. */
export interface ActivationCampaignFunnelPayload {
  campaign: {
    id:             string;
    name:           string | null;
    submittedCount: number;
    createdAt:      string;
  };
  funnel: ActivationFunnel;
}

/**
 * The PII-free subset the COUNTERPARTY sees. Deliberately omits the raw subject
 * id and the `counterpartyRef` matching key; carries no score.
 */
export interface ConfirmationPreview {
  id:               string;
  /** Name of the platform that asked for the confirmation. */
  platform:         string;
  status:           ConfirmationStatus;
  eventType:        string;
  stakeLevel:       string;
  transactionValue: number | null;
  dueDate:          string | null;
  completedAt:      string | null;
  counterpartyName: string | null;
  description:      string | null;
  expiresAt:        string;
}

/** Result of `respondToConfirmation`. `eventId` is present only on a confirm. */
export interface ConfirmationRespondResult {
  status:       ConfirmationStatus;
  confirmation: ConfirmationRequest;
  eventId?:     string;
}

// ─── Reference requests ───────────────────────────────────────────────────────

/**
 * Lifecycle of a reference request. Created `PENDING`; the counterparty's action
 * (or time) moves it to exactly one terminal state. Only `CONFIRMED` records a
 * qualification (verified). A qualification never moves the reliability score.
 */
export type ReferenceRequestStatus = 'PENDING' | 'CONFIRMED' | 'DECLINED' | 'EXPIRED' | 'CANCELLED';

/** What the counterparty can do with their token. */
export type ReferenceDecision = 'confirm' | 'decline';

/** The qualification categories a reference can attest. */
export type ReferenceCategory = 'employment' | 'education' | 'certification' | 'skill';

/**
 * Body for `createReferenceRequest`. `label`/`issuer`/`jurisdiction`/`reference`
 * are display-only and are never scored or ranked (no prestige weighting).
 */
export interface CreateReferenceInput {
  /** Your own external id for the subject of the claim. */
  userId:            string;
  category:          ReferenceCategory;
  /** Free-text claim label (e.g. "Senior Engineer", "BSc Computer Science"). */
  label?:            string;
  /** Free-text employer/institution/issuer. Never scored or ranked. */
  issuer?:           string;
  /** Where the credential applies (e.g. US-TX, GB). A property of the credential. */
  jurisdiction?:     string;
  /** The issuing body's own identifier for the credential. Display only. */
  reference?:        string;
  /**
   * Your opaque matching key for the confirming third party (a past employer,
   * manager, client, colleague, or issuing body). It must not name the subject: a
   * person cannot be their own reference (400 `REFERENCE_SELF`).
   */
  counterpartyRef:   string;
  /** Human name shown to the counterparty on the preview / hosted page. */
  counterpartyName?: string;
  /** Human description of the claim they are being asked to confirm. */
  description?:      string;
  /**
   * The stable identity of the CLAIM this reference is about, passed through to
   * the writer on confirm. Send the SAME value you send to
   * `recordQualification` for that claim and the two resolve to ONE claim
   * (verified wins), so a claim you synced self-attested and then had a
   * reference confirm is one entry, not two. Caller-supplied only; omit and the
   * confirmed claim stands alone. Never shown on the public preview.
   */
  claimRef?:         string;
  /** Where the HOSTED page returns them after they decide. Strictly validated. */
  returnUrl?:        string;
  /** 1–90 days; clamped server-side. */
  expiresInDays?:    number;
}

/** A reference request, as its OWNING platform sees it. */
export interface ReferenceRequest {
  id:                string;
  subjectExternalId: string;
  category:          string;
  label:             string | null;
  issuer:            string | null;
  jurisdiction:      string | null;
  reference:         string | null;
  counterpartyRef:   string;
  counterpartyName:  string | null;
  description:       string | null;
  /** Post-decision redirect configured for the hosted page (null when unset). */
  returnUrl:         string | null;
  status:            ReferenceRequestStatus;
  expiresAt:         string;
  /** The qualification event a CONFIRMED request produced. Null otherwise. */
  resultingEventId:  string | null;
  decidedAt:         string | null;
  createdAt:         string;
}

/** Result of `createReferenceRequest`. The token is returned ONCE. */
export interface ReferenceCreateResult {
  reference:      ReferenceRequest;
  /** Raw one-time token — deliver it to the counterparty over your own channel. */
  referenceToken: string;
  /** Credda's hosted reference page — the zero-frontend path. */
  referenceUrl:   string;
  /** The API preview, for platforms building their own reference UI. */
  previewUrl:     string;
  /** Where that UI POSTs the decision. */
  respondUrl:     string;
}

/** Cursor-paginated payload from `listReferences`. */
export interface ReferenceListPayload {
  data:       ReferenceRequest[];
  nextCursor: string | null;
}

/**
 * The PII-free subset the COUNTERPARTY sees. Deliberately omits the raw subject
 * id and the `counterpartyRef` matching key; carries no score.
 */
export interface ReferencePreview {
  id:               string;
  /** Name of the platform that asked for the reference. */
  platform:         string;
  status:           ReferenceRequestStatus;
  category:         string;
  label:            string | null;
  issuer:           string | null;
  jurisdiction:     string | null;
  reference:        string | null;
  counterpartyName: string | null;
  description:      string | null;
  expiresAt:        string;
}

/** Result of `respondToReference`. `eventId` is present only on a confirm. */
export interface ReferenceRespondResult {
  status:    ReferenceRequestStatus;
  reference: ReferenceRequest;
  eventId?:  string;
}

// ─── Threshold policies ───────────────────────────────────────────────────────

/** What a policy watches. */
export type PolicyMetric = 'score' | 'component' | 'band' | 'verified_events';

/** `up`/`down` for a numeric crossing; `enter`/`leave` for a band transition. */
export type PolicyDirection = 'up' | 'down' | 'enter' | 'leave';

/** The six named score components a `component` policy can watch. */
export type PolicyComponentKey =
  | 'reliability'
  | 'timeliness'
  | 'trustworthiness'
  | 'verification'
  | 'consistency'
  | 'momentum';

export interface ThresholdPolicy {
  id:              string;
  name:            string;
  appliesToAll:    boolean;
  metric:          PolicyMetric;
  direction:       PolicyDirection | null;
  threshold:       number | null;
  component:       PolicyComponentKey | null;
  band:            string | null;
  isActive:        boolean;
  lastTriggeredAt: string | null;
  createdAt:       string;
  updatedAt:       string;
  /** Your own external id for a subject-scoped policy; null when appliesToAll. */
  userId:          string | null;
}

/** Body for `createPolicy`. Set exactly one of `userId` / `appliesToAll`. */
export interface CreatePolicyInput {
  name:          string;
  userId?:       string;
  appliesToAll?: boolean;
  metric:        PolicyMetric;
  direction?:    PolicyDirection;
  threshold?:    number;
  component?:    PolicyComponentKey;
  band?:         string;
}

/** Patch for `updatePolicy`. `metric` is immutable and deliberately absent. */
export interface UpdatePolicyInput {
  name?:      string;
  direction?: PolicyDirection | null;
  threshold?: number | null;
  component?: PolicyComponentKey | null;
  band?:      string | null;
  isActive?:  boolean;
}

/** Cursor-paginated payload from `listPolicies`. */
export interface ThresholdPolicyListPayload {
  data:       ThresholdPolicy[];
  nextCursor: string | null;
}

// ─── Open Badges 3.0 ──────────────────────────────────────────────────────────

/** One Open Badges 3.0 Achievement definition, as the issuer publishes it. */
export interface OpenBadgeAchievement {
  id:              string;
  type:            string[];
  name:            string;
  description:     string;
  achievementType: string;
  criteria:        { id: string; narrative: string };
  creator:         { id: string; type: string[]; name: string };
}

/** GET /api/v1/open-badges/achievements — the closed, signable set. */
export interface OpenBadgeAchievementsPayload {
  specification:  Record<string, unknown>;
  note:           string;
  achievementIds: string[];
  achievements:   OpenBadgeAchievement[];
}

// ─── Verified Profile (qualifications) ────────────────────────────────────────

/** The four record categories a verified profile is built from. */
export type QualificationCategory = 'education' | 'skill' | 'certification' | 'employment';

export interface QualificationBreakdown {
  claimed:  number;
  verified: number;
  /** verified ÷ claimed. Null — never 0 — when nothing is claimed here. */
  verificationDepth: number | null;
}

/** GET /api/v1/users/:id/verified-profile. */
export interface VerifiedProfilePayload {
  userId:         string;
  profileVersion: string;
  categories:     Record<QualificationCategory, QualificationBreakdown>;
  totals:         { claimed: number; verified: number; selfAttested: number };
  /**
   * Share of the WHOLE claimed record that is independently verified. Equal
   * weight per claim — no prestige, no ranking. Null when nothing is claimed.
   */
  verificationDepth: number | null;
  /**
   * Compact headline over the same depth + counts: a coarse, versioned state
   * plus the raw counts. Additive; never a scoring input. `coverage` is how many
   * record categories carry at least one verified claim (descriptive breadth).
   */
  recordVerification: {
    state:             'no_record' | 'self_reported' | 'partially_verified' | 'fully_verified';
    verificationDepth: number | null;
    verified:          number;
    claimed:           number;
    coverage:          number;
  };
  /**
   * Counterparty-density summary: how many DISTINCT third parties have confirmed
   * a claim (and how many are employers). A plain distinct-count over verified
   * claims — bias-invariant to issuer identity, never a scoring input.
   */
  verifiedIssuers: {
    distinctVerifiedIssuers:   number;
    distinctVerifiedEmployers: number;
  };
  note:              string;
  /** What this measure is not. Always present. */
  disclosures:       string[];
}

/** Body for `recordQualification`. */
export interface RecordQualificationInput {
  category:    QualificationCategory;
  /** Free-text claim label. Carried for display; never read by the measure. */
  label?:      string;
  /** Free-text institution/employer. Carried for display; NEVER ranked. */
  issuer?:     string;
  /** Where the credential applies (e.g. `US-TX`). A property of the credential, never of the person; never ranked. */
  jurisdiction?: string;
  /** The issuing body's own number for the credential. Display only; Credda does not resolve it. */
  reference?:  string;
  /** The third-party witness. Required for the claim to count as verified. */
  verifiedBy?: string;
  /**
   * Stable, caller-chosen identity for THIS claim (1–200 chars). Claims sharing
   * `(category, claimRef)` resolve to ONE claim, so syncing the same claim twice
   * — self-attested when the user enters it, verified when a counterparty
   * confirms it — counts once (verified wins). Omit and one call is one claim,
   * exactly as before.
   */
  claimRef?:   string;
  /**
   * Record a RETRACTION MARKER for `(category, claimRef)` instead of a claim:
   * the claim is then withdrawn from the measure and the itemised record.
   * REQUIRES `claimRef` (400 without it), and any `verifiedBy` sent alongside is
   * IGNORED — a retraction is never verified. The ledger stays append-only:
   * nothing is deleted, the marker is one more event. A claim a witness already
   * confirmed is permanent record and a later retraction does not un-verify it.
   *
   * Not accepted by `importQualifications`, which is creation-only.
   */
  retract?:    boolean;
}

/**
 * One item of `importQualifications`. The single-claim body MINUS `retract`:
 * bulk import is creation-only and refuses an item carrying `retract` with a 400
 * rather than silently recording a claim you meant to withdraw. `claimRef` IS
 * accepted, so an imported claim can be confirmed by a later sync.
 */
export type QualificationImportItemInput = Omit<RecordQualificationInput, 'retract'>;

/** POST /api/v1/users/:id/qualifications. */
export interface RecordQualificationResult {
  userId:     string;
  eventId:    string;
  category:   QualificationCategory;
  eventType:  string;
  isVerified: boolean;
  /** The claim identity as stored. Null when none was supplied. */
  claimRef:   string | null;
  /** True when this call recorded a RETRACTION MARKER rather than a claim. */
  retracted:  boolean;
  /** Why the claim was recorded as self-attested. Null when verified. */
  verificationNote: string | null;
  note:             string;
}

/** One item's outcome in a bulk `importQualifications` response. */
export interface QualificationImportItemResult {
  index:      number;
  ok:         boolean;
  category:   QualificationCategory;
  eventId?:   string;
  eventType?: string;
  /** Decided by the witness rule per claim, never hardcoded. Present on success. */
  isVerified?: boolean;
  jurisdiction?: string | null;
  reference?:    string | null;
  /** The claim identity as stored, for a later confirmation-time sync. */
  claimRef?:     string | null;
  verificationNote?: string | null;
  /** Present only when this row failed; the rest of the batch still applied. */
  error?:     string;
}

/** POST /api/v1/users/:id/qualifications/import. */
export interface QualificationImportResponse {
  userId:   string;
  created:  number;
  failed:   number;
  total:    number;
  maxClaims: number;
  items:    QualificationImportItemResult[];
  /** The verified-profile snapshot after the import. */
  verifiedProfile: VerifiedProfilePayload;
  note:     string;
}

// ─── Professional Record ──────────────────────────────────────────────────────

export interface ProfessionalRecordTenure {
  firstRecordedAt:   string | null;
  firstVerifiedAt:   string | null;
  lastRecordedAt:    string | null;
  /** Whole days first→last recorded outcome. Null when the span is unknown. */
  trackRecordDays:   number | null;
  trackRecordMonths: number | null;
}

/** The derived summary itself (also the shape embedded in the public verify payload). */
export interface ProfessionalRecord {
  professionalRecordVersion: string;
  note:        string;
  /** `score`/`band` are null when nothing has been scored yet — never a placeholder. */
  reliability: { score: number | null; band: string | null; confidence: number };
  verifiedExperience: {
    verifiedOutcomes:  number;
    totalOutcomes:     number;
    /** verified ÷ total. Null — the honest answer, not 0 — with no record yet. */
    verificationDepth: number | null;
    verifiedPlatforms: number;
  };
  tenure:      ProfessionalRecordTenure;
  status:      { scoreFrozen: boolean };
  provenance:  { formulaVersion: string; computedAt: string | null };
  /** Including that this is not a hiring decision or a consumer report. */
  disclosures: string[];
}

/** GET /api/v1/users/:id/professional-record. */
export interface ProfessionalRecordPayload extends ProfessionalRecord {
  userId: string;
}

/**
 * A JSON Resume document (jsonresume.org) emitted by `getCareerExport` /
 * `getPublicCareerExport`. The standard résumé sections plus a `meta.credda`
 * block (reliability summary, verification depth, tenure, disclosures); every
 * work/education/skills/certificates item carries a `credda` extension flagging
 * `verified` vs self-reported and a per-item `proof` URL. Typed openly because
 * it is a standard résumé document, not a Credda-shaped payload.
 */
export interface CareerExportDocument {
  $schema: string;
  basics: Record<string, unknown>;
  work: Record<string, unknown>[];
  education: Record<string, unknown>[];
  skills: Record<string, unknown>[];
  certificates: Record<string, unknown>[];
  meta: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * The industry outcome-template catalog returned by `getOutcomeTemplates`.
 * Public, versioned, machine-readable guidance — same family as the plan and
 * webhook-event catalogs. Typed openly because it is a documentation surface,
 * not a Credda-shaped record; nothing in it can move a score.
 */
export interface OutcomeTemplatesCatalog {
  version: string;
  note: string;
  industries: { industry: string; label: string }[];
  templates: Record<string, unknown>[];
  disclosures: string[];
  [key: string]: unknown;
}

/**
 * GET /api/v1/verify/:token?scope=full&professional=1 — the public trust payload
 * with the professional-record block attached (`null` if it can't be derived).
 */
export interface PublicProfessionalRecordPayload extends TrustPayload {
  scope:              string;
  credentialScope?:   string;
  professionalRecord: ProfessionalRecord | null;
}

/** POST /api/v1/users/:id/professional-record/credential. */
export interface ProfessionalRecordCredentialResult {
  format:         'jwt_vc_json';
  credentialVc:   string;
  credentialType: 'CreddaProfessionalRecordCredential';
  issuer:         string;
  kid:            string;
  scope:          string;
  professionalRecordVersion: string;
  claims:         Record<string, unknown>;
  issuedAt:       string;
  expiresAt:      string;
  /**
   * The "Add to LinkedIn" certification deep link. LinkedIn stores only the
   * name, organization, dates, credential id and `certUrl` — it does not import
   * credential claims, and `note` says so.
   */
  linkedin: { addToProfileUrl: string; certUrl: string; certId: string; note: string };
  didDocument:    string;
  trustRegistry:  string;
  statusList:     string;
}

// ── Worker Reliability Report ─────────────────────────────────────────────────

/** One recent outcome in the report — flagged verified vs self-reported. */
export interface ReliabilityReportOutcome {
  eventType:  string;
  stake:      string;
  verified:   boolean;
  source:     'verified' | 'self_reported';
  occurredAt: string;
}

/** A ranked driver of the score (a relabelled reason code). */
export interface ReliabilityReportFactor {
  code:         string;
  factor:       string;
  direction:    'adverse' | 'supporting';
  title:        string;
  description:  string;
  contribution: number;
  rank:         number;
}

/**
 * The consolidated decision-support dossier from `getReliabilityReport` /
 * `getPublicReliabilityReport`. An AGGREGATION of already-computed values — it
 * carries no new score. `recency` is null when the record has no dated activity.
 *
 * It is EVIDENCE a reader weighs against their own criteria — NOT a hire, place,
 * rank, or approve verdict, a background check, or a consumer report. The
 * disclosures travel on every payload.
 */
export interface ReliabilityReport {
  reliabilityReportVersion: string;
  note: string;
  reliability: {
    /** Null when nothing has been scored yet — never a placeholder number. */
    score:              number | null;
    /** Band for `score`; null when there is no score to band. */
    band:               string | null;
    confidence:         number;
    formulaVersion:     string;
    reasonCodesVersion: string;
  };
  metrics: {
    completionRate: number;
    onTimeRate:     number;
    consistency:    number;
    recency:        number | null;
    disputeRate:    number;
  };
  verifiedExperience: ProfessionalRecord['verifiedExperience'] & { tenure: ProfessionalRecordTenure };
  topFactors:     ReliabilityReportFactor[];
  recentOutcomes: ReliabilityReportOutcome[];
  benchmark:      { cohort: string; comparison: string } | null;
  status:         { scoreFrozen: boolean };
  provenance:     { formulaVersion: string; computedAt: string | null };
  disclosures:    string[];
  advisory:       string;
}

/** `GET /api/v1/users/:id/reliability-report`. */
export interface ReliabilityReportPayload extends ReliabilityReport {
  userId: string;
}

/** `GET /api/v1/verify/:token/reliability-report` — `reliabilityReport` is null on a race. */
export interface PublicReliabilityReportPayload {
  token:             string;
  issuer:            string;
  reliabilityReport: ReliabilityReport | null;
}
