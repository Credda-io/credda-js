/**
 * A typed client over the Credda engine API.
 *
 * One method per route in `apps/api/src/routes/`, and no method that is not one.
 * The surface is almost entirely read: the engine is driven by the worker and
 * the CLI, and the only write this API accepts is opening an investigation
 * (`POST /api/investigations`), which is a row in `CREATED` — the run itself
 * starts elsewhere.
 *
 * Authentication is one bearer key on every `/api` route
 * (`apps/api/src/auth.ts`). The key identifies an ORGANISATION, not a person,
 * and every read below is scoped to it in SQL rather than by a filter a handler
 * remembers to apply. There is no public or key-less route on this API, so
 * there is nothing here that is safe to run in an untrusted browser.
 */

import { Transport, queryString } from './http.js';
import type { CreddaConfig, RequestOptions } from './http.js';
import { streamSse } from './stream.js';
import type { StreamOptions } from './stream.js';
import type {
  ApiKeyPage,
  EvidencePage,
  EvidenceType,
  FindingPage,
  Health,
  InvestigationDetail,
  InvestigationEvent,
  InvestigationEventPage,
  InvestigationListPage,
  InvestigationState,
  LatestResolution,
  LearningKind,
  LearningPage,
  OrganizationMemberPage,
  OrganizationOverview,
  RepositoryListPage,
  Resolution,
  ResolutionConfidenceClass,
  ResolutionListPage,
  ValidationCheckPage,
  ValidationDetail,
  ValidationEvent,
  ValidationEventPage,
  ValidationEvidencePage,
  ValidationListPage,
  ValidationOutcome,
  ValidationState,
} from './types.js';

/** Every list route takes these. The server's own defaults are 50 and 0. */
export interface PageQuery extends RequestOptions {
  /** 1–100. Above 100 the server refuses with `VALIDATION_FAILED`. */
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface ListInvestigationsQuery extends PageQuery {
  state?: InvestigationState | undefined;
}

export interface ListEventsQuery extends RequestOptions {
  /** Exclusive cursor: events after this sequence. */
  since?: number | undefined;
  limit?: number | undefined;
  /**
   * Include `debug`-severity events. Off by default on the server, and off the
   * live stream unconditionally — the stream filters debug events with no way
   * to ask for them.
   */
  includeDebug?: boolean | undefined;
}

export interface ListEvidenceQuery extends PageQuery {
  type?: EvidenceType | undefined;
}

export interface ListLearningsQuery extends PageQuery {
  kind?: LearningKind | undefined;
}

export interface ListValidationsQuery extends PageQuery {
  /** A repository id. An unknown one is a 404, never an empty page. */
  repository?: string | undefined;
  state?: ValidationState | undefined;
  outcome?: ValidationOutcome | undefined;
}

export interface ListResolutionsQuery extends PageQuery {
  investigation?: string | undefined;
  /**
   * The `signal` query parameter of the route, named `signalId` here so it
   * cannot be confused with the `AbortSignal` every query on this client takes.
   * An unknown one is a 404, never an empty page.
   */
  signalId?: string | undefined;
  confidence?: ResolutionConfidenceClass | undefined;
}

/** The body of `POST /api/investigations`. Every field is one `createBody` accepts. */
export interface CreateInvestigationInput {
  repositoryId: string;
  /** 1–500 characters. */
  issueTitle: string;
  /** Up to 100,000 characters. The whole request body is capped at 256KB. */
  issueBody: string;
  /** 1–500 characters. The reporter's own reference, e.g. an issue URL. */
  issueRef?: string | undefined;
}

export class CreddaClient {
  private readonly transport: Transport;

  constructor(config: CreddaConfig) {
    this.transport = new Transport(config);
  }

  // ── Investigations ─────────────────────────────────────────────────────────

  listInvestigations(query: ListInvestigationsQuery = {}): Promise<InvestigationListPage> {
    const { state, limit, offset, ...options } = query;
    return this.transport.get(`/api/investigations${queryString({ state, limit, offset })}`, options);
  }

  /**
   * Opens an investigation into a reported failure.
   *
   * The row is created in `CREATED` and this call returns as soon as it exists;
   * the API does not run the engine. What advances it is the worker, and what a
   * caller watches it with is {@link streamInvestigation}.
   *
   * Never retried, whatever `retries` is set to: there is no idempotency key on
   * this route, so a repeat opens a second investigation into the same report.
   */
  createInvestigation(
    input: CreateInvestigationInput,
    options: RequestOptions = {},
  ): Promise<InvestigationDetail> {
    return this.transport.post('/api/investigations', input, options);
  }

  getInvestigation(id: string, options: RequestOptions = {}): Promise<InvestigationDetail> {
    return this.transport.get(`/api/investigations/${encodeURIComponent(id)}`, options);
  }

  /** The timeline, paged. `nextSince` is the cursor to pass back in. */
  listInvestigationEvents(
    id: string,
    query: ListEventsQuery = {},
  ): Promise<InvestigationEventPage> {
    const { since, limit, includeDebug, ...options } = query;
    return this.transport.get(
      `/api/investigations/${encodeURIComponent(id)}/events${queryString({ since, limit, includeDebug })}`,
      options,
    );
  }

  listInvestigationEvidence(id: string, query: ListEvidenceQuery = {}): Promise<EvidencePage> {
    const { type, limit, offset, ...options } = query;
    return this.transport.get(
      `/api/investigations/${encodeURIComponent(id)}/evidence${queryString({ type, limit, offset })}`,
      options,
    );
  }

  /**
   * The live timeline as Server-Sent Events. `debug` events never arrive here.
   *
   * ```ts
   * for await (const event of credda.streamInvestigation(id, { since })) {
   *   console.log(event.sequence, event.type, event.summary);
   * }
   * ```
   */
  streamInvestigation(id: string, options: StreamOptions = {}): AsyncGenerator<InvestigationEvent> {
    return streamSse<InvestigationEvent>(
      this.transport,
      `/api/investigations/${encodeURIComponent(id)}/stream`,
      options,
    );
  }

  // ── Repositories ───────────────────────────────────────────────────────────

  listRepositories(query: PageQuery = {}): Promise<RepositoryListPage> {
    const { limit, offset, ...options } = query;
    return this.transport.get(`/api/repositories${queryString({ limit, offset })}`, options);
  }

  /**
   * What Credda has learned about one repository. A repository with nothing
   * learned yet answers with an empty list, not a 404: "we know nothing" is a
   * real answer.
   */
  listLearnings(repositoryId: string, query: ListLearningsQuery = {}): Promise<LearningPage> {
    const { kind, limit, offset, ...options } = query;
    return this.transport.get(
      `/api/repositories/${encodeURIComponent(repositoryId)}/learnings${queryString({ kind, limit, offset })}`,
      options,
    );
  }

  // ── Resolutions ────────────────────────────────────────────────────────────

  /**
   * Resolution records: what a run established about one report, and what it did
   * not.
   *
   * `confidence: 'NOT_ESTABLISHED'` is the query that keeps this product honest
   * with itself — every record where nothing was verified.
   */
  listResolutions(query: ListResolutionsQuery = {}): Promise<ResolutionListPage> {
    const { investigation, signalId, confidence, limit, offset, ...options } = query;
    return this.transport.get(
      `/api/resolutions${queryString({ investigation, signal: signalId, confidence, limit, offset })}`,
      options,
    );
  }

  /**
   * The newest record for one investigation.
   *
   * `{ resolution: null }` means the investigation exists and has produced no
   * record yet. It is not a 404 and must not be rendered as a missing page.
   */
  latestResolution(investigationId: string, options: RequestOptions = {}): Promise<LatestResolution> {
    return this.transport.get(
      `/api/resolutions/latest${queryString({ investigation: investigationId })}`,
      options,
    );
  }

  async getResolution(id: string, options: RequestOptions = {}): Promise<Resolution> {
    const body = await this.transport.get<{ resolution: Resolution }>(
      `/api/resolutions/${encodeURIComponent(id)}`,
      options,
    );
    return body.resolution;
  }

  // ── Validations ────────────────────────────────────────────────────────────

  listValidations(query: ListValidationsQuery = {}): Promise<ValidationListPage> {
    const { repository, state, outcome, limit, offset, ...options } = query;
    return this.transport.get(
      `/api/validations${queryString({ repository, state, outcome, limit, offset })}`,
      options,
    );
  }

  getValidation(id: string, options: RequestOptions = {}): Promise<ValidationDetail> {
    return this.transport.get(`/api/validations/${encodeURIComponent(id)}`, options);
  }

  /** The plan, in sequence order. `baseStatus` is what separates cause from coincidence. */
  listValidationChecks(id: string, query: PageQuery = {}): Promise<ValidationCheckPage> {
    const { limit, offset, ...options } = query;
    return this.transport.get(
      `/api/validations/${encodeURIComponent(id)}/checks${queryString({ limit, offset })}`,
      options,
    );
  }

  listFindings(id: string, query: PageQuery = {}): Promise<FindingPage> {
    const { limit, offset, ...options } = query;
    return this.transport.get(
      `/api/validations/${encodeURIComponent(id)}/findings${queryString({ limit, offset })}`,
      options,
    );
  }

  listValidationEvidence(id: string, query: PageQuery = {}): Promise<ValidationEvidencePage> {
    const { limit, offset, ...options } = query;
    return this.transport.get(
      `/api/validations/${encodeURIComponent(id)}/evidence${queryString({ limit, offset })}`,
      options,
    );
  }

  /** `limit` is capped at 500 here, not 100: see `MAX_EVENT_LIMIT` on the route. */
  listValidationEvents(id: string, query: ListEventsQuery = {}): Promise<ValidationEventPage> {
    const { since, limit, includeDebug, ...options } = query;
    return this.transport.get(
      `/api/validations/${encodeURIComponent(id)}/events${queryString({ since, limit, includeDebug })}`,
      options,
    );
  }

  streamValidation(id: string, options: StreamOptions = {}): AsyncGenerator<ValidationEvent> {
    return streamSse<ValidationEvent>(
      this.transport,
      `/api/validations/${encodeURIComponent(id)}/stream`,
      options,
    );
  }

  // ── Organization ───────────────────────────────────────────────────────────

  /**
   * The organisation this key speaks for, and what it holds.
   *
   * On a deployment running `CREDDA_AUTH=disabled` the request names no
   * organisation, and this answers 404 `NO_ORGANIZATION` rather than picking
   * one. That is deliberate: guessing would hand another tenant's workspace to
   * whoever asked.
   */
  getOrganization(options: RequestOptions = {}): Promise<OrganizationOverview> {
    return this.transport.get('/api/organization', options);
  }

  listMembers(query: PageQuery = {}): Promise<OrganizationMemberPage> {
    const { limit, offset, ...options } = query;
    return this.transport.get(`/api/organization/members${queryString({ limit, offset })}`, options);
  }

  /**
   * The keys that can reach this organisation, revoked ones included — "this key
   * was revoked on the 3rd" is the answer an operator came for.
   *
   * There is no create and no revoke here because the API has neither. Keys are
   * minted out of band by the operator today.
   */
  listApiKeys(query: PageQuery = {}): Promise<ApiKeyPage> {
    const { limit, offset, ...options } = query;
    return this.transport.get(`/api/organization/keys${queryString({ limit, offset })}`, options);
  }

  // ── Operations ─────────────────────────────────────────────────────────────

  /**
   * Readiness. Each check is established by performing it — a query is run, the
   * schema version is compared, a probe file is written to the evidence store.
   *
   * Returns the report on a degraded deployment too, where the server answers
   * **503** with this same body. Branch on `status`, not on whether this threw.
   */
  getHealth(options: RequestOptions = {}): Promise<Health> {
    return this.transport.getAllowing<Health>('/api/health', 503, options);
  }

  /**
   * Liveness: 204 with an empty body, and the one route outside the auth gate.
   * It answers only "is this process serving", and deliberately says nothing
   * else — no schema version, no counts, no configuration.
   *
   * Resolves true on 204 and false on any other status or a network error. It
   * never throws: a liveness probe that raises is a probe that has to be
   * wrapped at every call site.
   */
  async isLive(options: RequestOptions = {}): Promise<boolean> {
    try {
      const res = await this.transport.raw('/livez', {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      return res.status === 204;
    } catch {
      return false;
    }
  }

  /**
   * Prometheus exposition for the API process, as text.
   *
   * Scraping this alone gives HTTP-shaped metrics and little else: the
   * investigation, reproduction and model-usage counters increment in the
   * worker, which is a different process with its own registry. Scrape both.
   */
  getMetrics(options: RequestOptions = {}): Promise<string> {
    return this.transport.getText('/api/metrics', options);
  }
}
