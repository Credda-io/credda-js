/**
 * A typed client over the Credda engine API.
 *
 * One method per route in `apps/api/src/routes/`, and no method that is not one.
 * The surface is almost entirely read: the engine is driven by the worker and
 * the CLI, and the API accepts exactly two writes. `POST /api/investigations`
 * opens one, which is a row in `CREATED` — the run itself starts elsewhere. And
 * `POST /api/investigations/{id}/cancel` stops one, and says whether it
 * actually stopped it or only asked; see {@link CreddaClient.cancelInvestigation}.
 *
 * Every query and body this client sends names only keys the engine's schemas
 * declare. That is now load-bearing rather than tidy: those schemas are
 * `.strict()`, so an undeclared key is a 400 `VALIDATION_FAILED` naming it,
 * where it was once accepted and ignored.
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
  Cancellation,
  EvidencePage,
  EvidenceType,
  FindingPage,
  FindingSeverity,
  FindingStatus,
  Health,
  InvestigationDetail,
  InvestigationEvent,
  InvestigationEventPage,
  InvestigationListPage,
  InvestigationOutcome,
  InvestigationState,
  LatestResolution,
  LearningKind,
  LearningPage,
  OrganizationMemberPage,
  OrganizationOverview,
  Repository,
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
  /** A repository id. An unknown one is a 404, never an empty page. */
  repository?: string | undefined;
  state?: InvestigationState | undefined;
  /**
   * A terminal outcome. One token, never a list: `listQuery` in
   * `apps/api/src/routes/investigations.ts` is a single `z.enum` against an
   * `= ?` predicate, and a run that has not reached a terminal outcome has NULL
   * and so matches no value at all. Ask `state` for what is still in flight.
   */
  outcome?: InvestigationOutcome | undefined;
  /**
   * The signal that raised the run, named `signalId` here for the reason
   * {@link ListResolutionsQuery.signalId} gives: `signal` would sit next to the
   * `AbortSignal` every query on this client takes. An unknown one is a 404,
   * never an empty page.
   *
   * A run nothing raised has no signal and matches no value that can be sent,
   * the same shape `outcome` has. It is the only way to ask for every
   * investigation one signal caused, including the ones that resolved nothing
   * -- walking `/api/resolutions` shows only the runs that produced a record.
   */
  signalId?: string | undefined;
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

/**
 * `severity` and `status` narrow with AND, one token each -- the route takes a
 * single `z.enum` for both. Both columns are NOT NULL, so every finding answers
 * both and there is no absent-value token.
 */
export interface ListFindingsQuery extends PageQuery {
  severity?: FindingSeverity | undefined;
  status?: FindingStatus | undefined;
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

/** The body of `POST /api/investigations/{id}/cancel`. */
export interface CancelInvestigationInput extends RequestOptions {
  /**
   * Recorded against the run, not required: `cancelBody` makes it optional
   * because a cancel with nothing said is still a cancel. 1–500 characters when
   * given; an empty string is a 400.
   */
  reason?: string | undefined;
}

export class CreddaClient {
  private readonly transport: Transport;

  constructor(config: CreddaConfig) {
    this.transport = new Transport(config);
  }

  // ── Investigations ─────────────────────────────────────────────────────────

  /**
   * The investigation queue.
   *
   * `repository` and `outcome` were absent from this method's query until
   * 2026-08-29 while the route accepted both, so the two filters a caller most
   * wants on a queue -- whose repository, and how did it end -- could not be
   * expressed at all. They were also unrecoverable by accident: an `outcome`
   * key passed anyway fell into the rest element below and was handed to
   * `fetch` as a request option, where it was ignored in silence rather than
   * refused. The sibling queues (`listValidations`, `listResolutions`) carried
   * their full sets throughout; this one did not.
   */
  listInvestigations(query: ListInvestigationsQuery = {}): Promise<InvestigationListPage> {
    const { repository, state, outcome, signalId, limit, offset, ...options } = query;
    return this.transport.get(
      `/api/investigations${queryString({ repository, state, outcome, signal: signalId, limit, offset })}`,
      options,
    );
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

  /**
   * Stops a run — or records that it has been asked to stop, and says which.
   *
   * The one call on this client where the return value must be narrowed before
   * anything is shown to a person. A cancel that reports success over a
   * container still cloning a repository, still running a test suite and still
   * spending a model budget has told an operator something false about their
   * own machine and their own bill, so this returns the route's own
   * distinction rather than a boolean:
   *
   * ```ts
   * const result = await credda.cancelInvestigation(id, { reason: 'wrong repo' });
   * if (result.status === 'CANCELLATION_REQUESTED') {
   *   // A worker is still inside the run. It stops on its next heartbeat and
   *   // writes its own terminal state; watch the stream for it.
   *   for await (const event of credda.streamInvestigation(id)) { ... }
   * } else {
   *   // result.state is 'CANCELLED'. Nothing is running.
   * }
   * ```
   *
   * Throws a {@link CreddaError} for the two refusals, both 409: code
   * `ALREADY_FINISHED` when the run reached a terminal state — there is nothing
   * to stop and nothing to undo — and `NOT_CANCELLABLE` when it is executing
   * outside the job queue, which is what `credda run` does. The API cannot
   * reach that process and will not pretend it did.
   *
   * Repeating the call is safe: an already-cancelled run answers 200
   * `ALREADY_CANCELLED` rather than an error. It is still not retried
   * automatically, because {@link Transport.post} retries nothing.
   */
  cancelInvestigation(id: string, input: CancelInvestigationInput = {}): Promise<Cancellation> {
    const { reason, ...options } = input;
    return this.transport.post(
      `/api/investigations/${encodeURIComponent(id)}/cancel`,
      reason === undefined ? {} : { reason },
      options,
    );
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
   * One repository by id.
   *
   * Every investigation and validation this client returns carries a
   * `repositoryId`, and resolving one used to mean paging {@link
   * listRepositories} until the id turned up -- a scan whose cost grows with
   * the organisation and which no filter shortens. Unwrapped from the route's
   * `{ repository }` envelope, as {@link getResolution} is.
   */
  async getRepository(id: string, options: RequestOptions = {}): Promise<Repository> {
    const body = await this.transport.get<{ repository: Repository }>(
      `/api/repositories/${encodeURIComponent(id)}`,
      options,
    );
    return body.repository;
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

  /** Triage without pulling every row: `severity` and `status` narrow with AND. */
  listFindings(id: string, query: ListFindingsQuery = {}): Promise<FindingPage> {
    const { severity, status, limit, offset, ...options } = query;
    return this.transport.get(
      `/api/validations/${encodeURIComponent(id)}/findings${queryString({ severity, status, limit, offset })}`,
      options,
    );
  }

  /** `type` is the same filter `listInvestigationEvidence` takes, over the same rows. */
  listValidationEvidence(
    id: string,
    query: ListEvidenceQuery = {},
  ): Promise<ValidationEvidencePage> {
    const { type, limit, offset, ...options } = query;
    return this.transport.get(
      `/api/validations/${encodeURIComponent(id)}/evidence${queryString({ type, limit, offset })}`,
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
