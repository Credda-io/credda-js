/**
 * The wire types of the Credda engine API.
 *
 * Every interface here is a transcription of one function in
 * `apps/api/src/serialize.ts`, field for field, and every string union is a
 * transcription of one `as const` array in `packages/shared` or
 * `packages/memory`. Nothing is added. A field a serializer does not write does
 * not appear here, because a typed client that promises a field the server
 * never sends is a lie the compiler helps tell.
 *
 * {@link InvestigationCreation} is the one exception and says so: it is
 * assembled by this client out of a response BODY and its status line, because
 * the create route distinguishes 201 from 200 and writes nothing in the body
 * that tells them apart.
 */

import type { IdempotencyKey } from './idempotency.js';

// ─── Vocabularies ────────────────────────────────────────────────────────────

/**
 * `packages/shared/src/states.ts` — INVESTIGATION_STATES.
 *
 * This union said, until 2026-08-29, that the patch-path states were absent
 * because they were absent from that array, and promised to gain members when
 * that array did. The array gained them on 2026-08-27, when ADR 0019 put the
 * Fix and Verify stages back on the investigation path, and this union did not
 * follow. `apps/api/src/serialize.ts` writes `state` straight through as a
 * string, so a run that reaches `READY_FOR_REVIEW` has been arriving as a value
 * this type says cannot exist — and `listInvestigations` would not let a caller
 * filter for one.
 *
 * `REPORT_REFUTED` (ADR 0020) was missing for the same reason and is here too.
 */
export type InvestigationState =
  | 'CREATED'
  | 'PREPARING_ENVIRONMENT'
  | 'ANALYZING_REPOSITORY'
  | 'UNDERSTANDING_ISSUE'
  | 'INVESTIGATING'
  | 'ATTEMPTING_REPRODUCTION'
  | 'REPRODUCED'
  | 'DIAGNOSING'
  | 'ROOT_CAUSE_IDENTIFIED'
  | 'REPRODUCED_AND_DIAGNOSED'
  | 'REPRODUCED_NOT_DIAGNOSED'
  | 'CONTRADICTS_SPECIFICATION'
  | 'ISSUE_ALREADY_RESOLVED'
  | 'REPORT_REFUTED'
  | 'NO_CHANGE_REQUIRED'
  | 'NO_RUNNABLE_CHECK'
  | 'REPRODUCTION_FAILED'
  | 'INSUFFICIENT_EVIDENCE'
  | 'GENERATING_PATCH'
  | 'TESTING_PATCH'
  | 'VERIFYING'
  | 'VERIFIED'
  | 'READY_FOR_REVIEW'
  | 'VERIFICATION_FAILED'
  | 'PATCH_REJECTED'
  | 'NEEDS_HUMAN_INPUT'
  | 'CANCELLED'
  | 'FAILED';

/**
 * `packages/shared/src/states.ts` — OUTCOMES. Same note as
 * {@link InvestigationState}.
 *
 * `VERIFIED`, `PARTIALLY_VERIFIED` and `PATCH_REJECTED` are the three the fix
 * stage produces. None of them says the change was merged: Credda proposes, and
 * a human is the merge authority. `PARTIALLY_VERIFIED` is the weaker claim of
 * the first two — fewer checks stood behind the change, not that the change is
 * wrong — and `outcomeForState` in `core` returns it when no verdict is given,
 * because an unknown verdict must never round up.
 */
export type InvestigationOutcome =
  | 'REPRODUCED_AND_DIAGNOSED'
  | 'REPRODUCED_NOT_DIAGNOSED'
  | 'CONTRADICTS_SPECIFICATION'
  | 'NO_CHANGE_REQUIRED'
  | 'NO_RUNNABLE_CHECK'
  | 'INCONCLUSIVE'
  | 'VERIFIED'
  | 'PARTIALLY_VERIFIED'
  | 'PATCH_REJECTED'
  | 'CANCELLED'
  | 'ERRORED';

/** `packages/shared/src/evidence.ts` — EVIDENCE_TYPES. */
export type EvidenceType =
  | 'TEST_RESULT'
  | 'REPRODUCTION'
  | 'STACK_TRACE'
  | 'LOG'
  | 'COMMAND_OUTPUT'
  | 'HTTP_RESPONSE'
  | 'BROWSER_OBSERVATION'
  | 'SCREENSHOT'
  | 'CODE_REFERENCE'
  | 'GIT_HISTORY'
  | 'BUILD_RESULT'
  | 'TYPECHECK_RESULT'
  | 'LINT_RESULT'
  | 'PERFORMANCE_RESULT'
  | 'VERIFICATION'
  | 'VALUE_OBSERVATION'
  | 'SPECIFICATION'
  | 'VULNERABILITY';

/** `packages/shared/src/evidence.ts` — EVIDENCE_STRENGTHS. Ordinal, never a percentage. */
export type EvidenceStrength = 'STRONG' | 'MODERATE' | 'WEAK';

/** `packages/shared/src/evidence.ts` — EVIDENCE_PHASES. */
export type EvidencePhase = 'BEFORE_PATCH' | 'AFTER_PATCH' | 'INDEPENDENT';

/** `packages/shared/src/events.ts` — EVENT_SEVERITIES. `debug` is filtered off the stream. */
export type EventSeverity = 'debug' | 'info' | 'warn' | 'error';

/** `packages/shared/src/evidence.ts` — VERIFICATION_VERDICTS. */
export type VerificationVerdict =
  | 'VERIFIED'
  | 'PARTIALLY_VERIFIED'
  | 'UNVERIFIED'
  | 'INCONCLUSIVE'
  | 'REJECTED';

/** `packages/db/src/types.ts` — HYPOTHESIS_STATUSES. */
export type HypothesisStatus = 'PROPOSED' | 'SUPPORTED' | 'REFUTED' | 'CONFIRMED';

/** `packages/db/src/types.ts` — PATCH_STATUSES. */
export type PatchStatus = 'DRAFT' | 'APPLIED' | 'REVERTED' | 'VERIFIED' | 'REJECTED';

/** `packages/shared/src/validation.ts` — VALIDATION_STATES. */
export type ValidationState =
  | 'CREATED'
  | 'ANALYZING_CHANGE'
  | 'UNDERSTANDING_INTENT'
  | 'PLANNING'
  | 'PREPARING_ENVIRONMENT'
  | 'RUNNING'
  | 'CONFIRMING_FINDINGS'
  | 'INVESTIGATING_FINDING'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'FAILED';

/** `packages/shared/src/validation.ts` — VALIDATION_OUTCOMES. */
export type ValidationOutcome =
  | 'VERIFIED'
  | 'FAILED'
  | 'BLOCKED'
  | 'INCONCLUSIVE'
  | 'NO_CHANGE_REQUIRED'
  | 'CANCELLED'
  | 'ERRORED';

/** `packages/db/src/repositories/validations.ts` — VALIDATION_SOURCE_TYPES. */
export type ValidationSourceType =
  | 'PULL_REQUEST'
  | 'BRANCH'
  | 'COMMIT'
  | 'DIFF'
  | 'ISSUE'
  | 'WORKING_TREE';

/** `packages/db/src/repositories/validations.ts` — VALIDATION_TRIGGER_KINDS. */
export type ValidationTriggerKind = 'WEBHOOK' | 'MANUAL' | 'SCHEDULED' | 'CLI';

/** `packages/shared/src/validation.ts` — CHECK_CATEGORIES. */
export type CheckCategory =
  | 'FUNCTIONAL'
  | 'REGRESSION'
  | 'API'
  | 'BROWSER'
  | 'AUTH'
  | 'DATABASE'
  | 'BUILD'
  | 'TYPE'
  | 'INTEGRATION'
  | 'PERFORMANCE'
  | 'ACCESSIBILITY'
  | 'COMPATIBILITY'
  | 'INVARIANT';

/** `packages/shared/src/validation.ts` — CHECK_METHODS. */
export type CheckMethod =
  | 'EXISTING_TEST_SUITE'
  | 'GENERATED_TEST'
  | 'REPRODUCE_REPORTED_DEFECT'
  | 'BUILD'
  | 'TYPECHECK'
  | 'LINT'
  | 'COMMAND'
  | 'HTTP_REQUEST'
  | 'BROWSER_INTERACTION'
  | 'DATABASE_QUERY';

/** `packages/shared/src/validation.ts` — CHECK_STATUSES. */
export type CheckStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'PASSED'
  | 'FAILED'
  | 'PRE_EXISTING_FAILURE'
  | 'BLOCKED'
  | 'SKIPPED';

/**
 * The base re-run result (`packages/db/src/repositories/validations.ts`).
 * `null` means the base commit has not been consulted yet — never "it passed".
 */
export type BaseCheckStatus = 'PASSED' | 'FAILED' | 'BLOCKED';

/** `packages/shared/src/validation.ts` — REQUIREMENT_SOURCES. */
export type RequirementSource =
  | 'EXPLICIT_REQUIREMENT'
  | 'INFERRED_REQUIREMENT'
  | 'EXISTING_BEHAVIOR'
  | 'INVARIANT';

/** `packages/shared/src/validation.ts` — ENVIRONMENT_STATUSES. */
export type EnvironmentStatus = 'NOT_PREPARED' | 'READY' | 'FAILED';

/** `packages/shared/src/validation.ts` — ENVIRONMENT_FAILURE_KINDS. */
export type EnvironmentFailureKind =
  | 'DETECTION_FAILED'
  | 'RUNTIME_UNSUPPORTED'
  | 'DEPENDENCY_INSTALL_FAILED'
  | 'BUILD_FAILED'
  | 'SERVICE_START_FAILED'
  | 'DATABASE_UNAVAILABLE'
  | 'MISSING_ENVIRONMENT_VARIABLE'
  | 'AUTH_CONFIGURATION_MISSING'
  | 'BROWSER_START_FAILED'
  | 'PORT_CONFLICT'
  | 'EXTERNAL_DEPENDENCY_UNAVAILABLE';

/** `packages/shared/src/validation.ts` — FINDING_SEVERITIES / _CONFIDENCE / _STATUSES. */
export type FindingSeverity = 'HIGH' | 'MEDIUM' | 'LOW';
export type FindingConfidence = 'CONFIRMED' | 'LIKELY' | 'INCONCLUSIVE';
export type FindingStatus = 'OPEN' | 'DISMISSED' | 'ENVIRONMENT_RELATED' | 'RESOLVED';

/** `packages/shared/src/resolution.ts` — REPRODUCTION_STATUSES. */
export type ReproductionStatus = 'REPRODUCED' | 'NOT_REPRODUCED' | 'NOT_ATTEMPTED';

/** `packages/shared/src/resolution.ts` — REGRESSION_PROTECTION_STATUSES. */
export type RegressionProtectionStatus = 'PROVEN' | 'NOT_PROVEN' | 'ABSENT';

/**
 * `packages/shared/src/resolution.ts` — RESOLUTION_CONFIDENCE_CLASSES.
 *
 * An ordinal class. There is no number anywhere on a resolution's confidence,
 * deliberately (ADR 0012), so there is nothing here for a renderer to turn into
 * a percentage.
 */
export type ResolutionConfidenceClass =
  | 'ESTABLISHED'
  | 'PARTIALLY_ESTABLISHED'
  | 'NOT_ESTABLISHED';

/** `packages/memory/src/repository-memory.ts` — LEARNING_KINDS. */
export type LearningKind =
  | 'REPRODUCTION_RECIPE'
  | 'FRAGILE_SITE'
  | 'REJECTED_APPROACH'
  | 'NON_DEFECT'
  | 'CONVENTION';

// ─── Investigations ──────────────────────────────────────────────────────────

/** `toInvestigationSummary`. A list row. */
export interface InvestigationSummary {
  id: string;
  repositoryId: string;
  /**
   * Null only when the repository row is gone; never a stand-in label. Passed
   * through `toWireSource`, so a local checkout never puts a host path here.
   *
   * On the queue row for the reason it is on {@link ValidationSummary}: without
   * it, "which repository is this" costs one detail request per row, on exactly
   * the screen that renders every row at once.
   */
  repositorySource: string | null;
  issueRef: string | null;
  issueTitle: string;
  state: InvestigationState;
  outcome: InvestigationOutcome | null;
  providerId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  /** Null unless the run both started and finished. Never negative, never a guess. */
  durationMs: number | null;
  eventCount: number;
  evidenceCount: number;
}

/** `toInvestigation`. */
export interface Investigation {
  id: string;
  orgId: string;
  repositoryId: string;
  issueRef: string | null;
  issueTitle: string;
  issueBody: string;
  /**
   * The signal this run was opened from, when it came from one. Null for a
   * report handed to Credda directly. It is the id the reporting side knows
   * this defect by, and it is what `listResolutions({ signalId })` looks up.
   */
  signalId: string | null;
  state: InvestigationState;
  outcome: InvestigationOutcome | null;
  providerId: string | null;
  /** The engine's own bag. No field of it is an API contract. */
  budget: Record<string, unknown>;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  durationMs: number | null;
}

/** `toHypothesis`. */
export interface Hypothesis {
  id: string;
  investigationId: string;
  description: string;
  rank: number;
  status: HypothesisStatus;
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * `toPatch`.
 *
 * The type exists because the serializer does, and the investigation detail
 * carries a `patches` array on every response. Whether it is ever non-empty is
 * a matter of what the engine has run, not of what this client can express —
 * see the README's status table.
 */
export interface Patch {
  id: string;
  investigationId: string;
  attempt: number;
  unifiedDiff: string;
  filesChanged: string[];
  insertions: number;
  deletions: number;
  rationale: string;
  status: PatchStatus;
  createdAt: string;
  updatedAt: string;
}

/** `packages/shared/src/evidence.ts` — VerificationSignals, passed through verbatim. */
export interface VerificationSignals {
  reproductionBefore: 'FAIL' | 'PASS' | 'NOT_RUN';
  reproductionAfter: 'FAIL' | 'PASS' | 'NOT_RUN';
  regressionTestBefore: 'FAIL' | 'PASS' | 'NOT_RUN';
  regressionTestAfter: 'FAIL' | 'PASS' | 'NOT_RUN';
  existingTests: { passed: number; failed: number; total: number } | null;
  [key: string]: unknown;
}

/** `toVerification`. */
export interface VerificationRun {
  id: string;
  investigationId: string;
  patchId: string;
  verdict: VerificationVerdict;
  signals: VerificationSignals;
  notes: string | null;
  createdAt: string;
}

/**
 * The captured shape of a failure, passed through verbatim so that a reviewer
 * can tell a fixed failure from a mutated one. Its keys are the engine's and
 * this package does not reshape them.
 */
export interface FailureSignature {
  [key: string]: unknown;
}

/** `toEvidence`. */
export interface Evidence {
  id: string;
  investigationId: string;
  /**
   * Set when this row was produced by a validation check rather than by the
   * investigation directly. A check runs inside an investigation (ADR 0010), so
   * this list mixes both, and without these two fields a client reading an
   * investigation's evidence cannot tell which is which. Both null means the
   * investigation itself recorded the observation.
   */
  validationId: string | null;
  checkId: string | null;
  type: EvidenceType;
  phase: EvidencePhase;
  strength: EvidenceStrength;
  summary: string;
  contentRef: string | null;
  metadata: Record<string, unknown>;
  /** `FailureSignature`, passed through as the engine captured it. */
  signature: FailureSignature | null;
  createdAt: string;
}

/**
 * `toEvent`.
 *
 * `type` is `string` rather than a union of EVENT_TYPES: the engine's event
 * vocabulary is long and grows with the engine, and a client that failed to
 * type-check against a server one release ahead would be enforcing its own
 * staleness. `severity` is a union because it drives whether an event reaches
 * the stream at all.
 */
export interface InvestigationEvent {
  id: string;
  investigationId: string;
  sequence: number;
  type: string;
  severity: EventSeverity;
  /** Single line, safe to render. */
  summary: string;
  state: InvestigationState | null;
  agentRunId: string | null;
  toolCallId: string | null;
  evidenceIds: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
}

/** The body of `GET /api/investigations/:id` and of `POST /api/investigations`. */
export interface InvestigationDetail {
  investigation: Investigation;
  hypotheses: Hypothesis[];
  patches: Patch[];
  verifications: VerificationRun[];
  evidenceCount: number;
  latestSequence: number;
}

/**
 * The result of `createInvestigationOnce`: the run, and whether THIS call is
 * what opened it.
 *
 * A UNION for the reason {@link Cancellation} is one. The engine answers the
 * create route with 201 when the key was new and 200 when it is handing back
 * the run an earlier request under that key already created, and the body is
 * identical either way — so the status is the only thing that says whether a
 * model budget was just committed. A single record with a boolean would let a
 * caller read one as the other, and a shape that dropped the distinction
 * entirely would make every retried create look like a fresh run in whatever
 * the caller writes to their own ledger.
 *
 * Narrow on `status`. `CREATED` means this call opened the run. `REPLAYED`
 * means an earlier request under the same key did, nothing was created here,
 * and nothing was billed.
 *
 * The mismatch is not a member: the same key over a different body is a 409
 * `IDEMPOTENCY_KEY_REUSED` {@link CreddaError}, because it neither created nor
 * replayed anything.
 */
export type InvestigationCreation = InvestigationCreated | InvestigationReplayed;

/** This call opened the run. See {@link InvestigationCreation}. */
export interface InvestigationCreated {
  status: 'CREATED';
  /** The key this run is claimed under. Hold it: sending it again replays. */
  key: IdempotencyKey;
  investigation: InvestigationDetail;
}

/**
 * An earlier request under this key opened the run; this one created nothing.
 * See {@link InvestigationCreation}.
 */
export interface InvestigationReplayed {
  status: 'REPLAYED';
  key: IdempotencyKey;
  investigation: InvestigationDetail;
}

/**
 * The body of `POST /api/investigations/{id}/cancel`.
 *
 * A UNION, not a record with a boolean, because the route's whole point is that
 * two of its answers mean different things about the operator's machine and the
 * operator's bill, and a single shape lets a caller read one as the other.
 *
 * `apps/api/src/routes/investigations.ts` answers with what it ACHIEVED:
 *
 *   • {@link CancellationStopped} — 200 `CANCELLED` (the job was still queued
 *     and was refused its claim) or 200 `ALREADY_CANCELLED` (it was cancelled
 *     before this call). Nothing is running, and `state` is `CANCELLED`.
 *
 *   • {@link CancellationRequested} — 202 `CANCELLATION_REQUESTED`. A worker is
 *     INSIDE the run, holding a sandbox and possibly a model call. The request
 *     is durable and that worker honours it on its next heartbeat, but the run
 *     HAS NOT STOPPED and the API has written no terminal state. The run writes
 *     its own when it lets go; `listInvestigationEvents` and
 *     `streamInvestigation` are how a caller learns that it did.
 *
 * Which is why `state` is typed differently on the two branches: on the
 * requested branch it excludes `'CANCELLED'`, so `result.state === 'CANCELLED'`
 * is a true test of "stopped" and cannot be satisfied by a run still going.
 * Narrow on `status` before rendering anything.
 *
 * The two refusals are errors, not members of this union: a run that already
 * finished is 409 `ALREADY_FINISHED`, and one executing outside the job queue —
 * a `credda run` in somebody else's process — is 409 `NOT_CANCELLABLE`. Both
 * arrive as a {@link CreddaError}, which is correct: neither stopped anything.
 */
export type Cancellation = CancellationStopped | CancellationRequested;

/** Nothing is running. See {@link Cancellation}. */
export interface CancellationStopped {
  investigationId: string;
  /** Re-read from the record after the write, never assumed. */
  state: 'CANCELLED';
  /**
   * `CANCELLED` — this call stopped it. `ALREADY_CANCELLED` — it was already
   * cancelled, and repeating the request is not an error.
   */
  status: 'CANCELLED' | 'ALREADY_CANCELLED';
}

/**
 * Recorded, NOT stopped. A worker is still inside the run. See
 * {@link Cancellation}.
 */
export interface CancellationRequested {
  investigationId: string;
  /**
   * The state the run is still in. Never `'CANCELLED'`: the API does not write
   * that here, the run does, when it lets go.
   */
  state: Exclude<InvestigationState, 'CANCELLED'>;
  status: 'CANCELLATION_REQUESTED';
}

export interface InvestigationListPage {
  investigations: InvestigationSummary[];
  /** The size of the whole filtered set, so a client can tell it holds one page. */
  total: number;
}

export interface InvestigationEventPage {
  events: InvestigationEvent[];
  latestSequence: number;
  /**
   * The cursor to resume from. Taken from the page BEFORE the debug filter runs,
   * so resuming from it never skips an event that was merely filtered out.
   */
  nextSince: number;
  hasMore: boolean;
}

export interface EvidencePage {
  evidence: Evidence[];
  total: number;
}

// ─── Repositories and memory ─────────────────────────────────────────────────

/** `toRepository`. */
export interface Repository {
  id: string;
  orgId: string;
  name: string;
  /**
   * A clone URL for a remote repository. For a local checkout the server
   * reduces the host path to `local:<final segment>` (`toWireSource`), which is
   * a label and never something to clone.
   */
  source: string;
  defaultBranch: string;
  createdAt: string;
}

export interface RepositoryListPage {
  repositories: Repository[];
  total: number;
}

/**
 * `toLearning`. What Credda has learned about one repository.
 *
 * `weight` is an ordinal label derived from `observations`, not a probability.
 * `metadata` is deliberately not served.
 */
export interface Learning {
  id: string;
  kind: LearningKind;
  summary: string;
  filePath: string | null;
  symbol: string | null;
  observations: number;
  weight: string;
  investigationIds: string[];
  createdAt: string;
  lastSeenAt: string;
}

export interface LearningPage {
  learnings: Learning[];
  total: number;
}

// ─── Validations ─────────────────────────────────────────────────────────────

/** `toValidationSummary`. */
export interface ValidationSummary {
  id: string;
  repositoryId: string;
  /** Null only when the repository row is gone. Passed through `toWireSource`. */
  repositorySource: string | null;
  sourceType: ValidationSourceType;
  sourceRef: string;
  baseCommit: string | null;
  headCommit: string | null;
  state: ValidationState;
  outcome: ValidationOutcome | null;
  triggerKind: ValidationTriggerKind;
  /** On the queue row deliberately: a BLOCKED run must not read as a failed change. */
  environmentStatus: EnvironmentStatus;
  environmentFailureKind: EnvironmentFailureKind | null;
  executableFilesChanged: number | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  durationMs: number | null;
}

/** `toValidation`. */
export interface Validation {
  id: string;
  orgId: string;
  repositoryId: string;
  sourceType: ValidationSourceType;
  sourceRef: string;
  baseCommit: string | null;
  headCommit: string | null;
  state: ValidationState;
  outcome: ValidationOutcome | null;
  triggerKind: ValidationTriggerKind;
  triggeredBy: string | null;
  intentSummary: string | null;
  executableFilesChanged: number | null;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  durationMs: number | null;
}

/**
 * `toEnvironment`.
 *
 * `detail` is what was attempted, as the engine recorded it — the runtime, the
 * commands, the stderr of an install that failed. Its keys are the engine's and
 * none of them is an API contract, which is why it is typed as an open bag.
 */
export interface ValidationEnvironment {
  status: EnvironmentStatus;
  failureKind: EnvironmentFailureKind | null;
  detail: Record<string, unknown>;
}

/** `toValidationCheck`. */
export interface ValidationCheck {
  id: string;
  validationId: string;
  sequence: number;
  name: string;
  category: CheckCategory;
  method: CheckMethod;
  reason: string;
  target: string;
  expectedBehavior: string;
  requirementSource: RequirementSource;
  status: CheckStatus;
  /**
   * The base re-run. `FAILED` means the check was re-run on the base commit and
   * passed there, so this change caused it. Never omitted, and `null` means the
   * base has not been consulted rather than that it was fine.
   */
  baseStatus: BaseCheckStatus | null;
  investigationId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
  durationMs: number | null;
}

/**
 * `toFinding`.
 *
 * There is no `evidence` array here and its absence is deliberate: the findings
 * table holds no evidence references, and what a finding rests on is reachable
 * through its `checkId` against the validation's evidence.
 */
export interface Finding {
  id: string;
  validationId: string;
  checkId: string | null;
  title: string;
  severity: FindingSeverity;
  confidence: FindingConfidence;
  status: FindingStatus;
  expectedBehavior: string;
  observedBehavior: string;
  reproduction: string;
  affectedArea: string;
  likelySource: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `toValidationEvidence`. `checkId` attaches an execution to the check that cited it. */
export interface ValidationEvidence {
  id: string;
  investigationId: string;
  checkId: string | null;
  type: EvidenceType;
  phase: EvidencePhase;
  strength: EvidenceStrength;
  summary: string;
  contentRef: string | null;
  metadata: Record<string, unknown>;
  signature: FailureSignature | null;
  createdAt: string;
}

/** `toValidationEvent`. See {@link InvestigationEvent} on why `type` is a string. */
export interface ValidationEvent {
  id: string;
  validationId: string;
  checkId: string | null;
  sequence: number;
  type: string;
  severity: EventSeverity;
  summary: string;
  state: ValidationState | null;
  data: Record<string, unknown>;
  createdAt: string;
}

/** The body of `GET /api/validations/:id`. */
export interface ValidationDetail {
  validation: Validation;
  environment: ValidationEnvironment;
  /** The engine's own bag, as with `environment.detail`. */
  changeImpact: Record<string, unknown>;
  /** On the detail deliberately: a completed run with zero checks is a false success. */
  checkCount: number;
  findingCount: number;
  evidenceCount: number;
  latestSequence: number;
}

export interface ValidationListPage {
  validations: ValidationSummary[];
  total: number;
}

export interface ValidationCheckPage {
  checks: ValidationCheck[];
  total: number;
}

export interface FindingPage {
  findings: Finding[];
  total: number;
}

export interface ValidationEvidencePage {
  evidence: ValidationEvidence[];
  total: number;
}

export interface ValidationEventPage {
  events: ValidationEvent[];
  latestSequence: number;
  nextSince: number;
  hasMore: boolean;
}

// ─── Resolutions ─────────────────────────────────────────────────────────────

/**
 * `toResolutionSummary`.
 *
 * `confidenceClass` and `notEstablished` travel together and must be rendered
 * together: they are one fact written twice, and a class shown without its gaps
 * is the bare assertion the pairing exists to prevent.
 */
export interface ResolutionSummary {
  id: string;
  investigationId: string;
  /** The report's own title, quoted. Never Credda's description of the defect. */
  reported: string;
  reference: string | null;
  signalId: string | null;
  reproductionStatus: ReproductionStatus;
  /** Null when no verification run exists. Never a stand-in verdict. */
  verificationVerdict: VerificationVerdict | null;
  regressionStatus: RegressionProtectionStatus;
  confidenceClass: ResolutionConfidenceClass;
  notEstablished: string[];
  createdAt: string;
}

/**
 * `packages/shared/src/resolution.ts` — `ResolutionDeclinedReproduction`. One
 * refusal the reproduction-plan extractor raised while reading the report: a
 * snippet Credda found and could not honestly turn into a command.
 *
 * `source` says where in the report the refusal was raised, which is the one
 * thing `reason` does not carry. None of the three is a vocabulary: they are
 * free text written by the engine and by the reporter.
 */
export interface DeclinedReproduction {
  source: string;
  reason: string;
  excerpt: string;
}

/**
 * `toResolution`. The whole record.
 *
 * `rootCause`, `fix` and `verification` are null exactly when the run produced
 * no such row. The hole is then named in `confidence.notEstablished` rather
 * than filled in, and a client must render the gap rather than hide it.
 */
export interface Resolution {
  id: string;
  investigationId: string;
  bug: {
    reported: string;
    reference: string | null;
    signalId: string | null;
    affectedFiles: string[];
  };
  evidence: Array<{ id: string; type: EvidenceType; summary: string }>;
  reproduction: {
    status: ReproductionStatus;
    command: string | null;
    signature: FailureSignature | null;
    evidenceId: string | null;
    /** Null means the record predates the column — never "nothing was killed". */
    timedOutAttempts: number | null;
  };
  rootCause: {
    hypothesisId: string;
    description: string;
    supportingEvidenceIds: string[];
    anchoredFiles: string[];
  } | null;
  fix: {
    patchId: string;
    attempt: number;
    filesChanged: string[];
    insertions: number;
    deletions: number;
    rationale: string;
  } | null;
  verification: {
    verificationRunId: string;
    verdict: VerificationVerdict;
    signals: VerificationSignals;
    evidenceIds: string[];
  } | null;
  regressionProtection: {
    status: RegressionProtectionStatus;
    before: string | null;
    after: string | null;
  };
  /**
   * Why Credda could not turn parts of the report into a command.
   *
   * Null and empty are different answers, and collapsing them reports "Credda
   * declined no part of this report" about a record that was never asked: null
   * means the record predates the column and says nothing either way, empty
   * means the extractor refused nothing.
   *
   * A refusal is a fact about Credda's reach. Nothing here may be rendered as a
   * claim about whether the reported defect exists. `excerpt` is the reporter's
   * own text, quoted and never interpolated — a client that renders it must
   * escape it.
   */
  declinedReproductions: DeclinedReproduction[] | null;
  confidence: {
    class: ResolutionConfidenceClass;
    /** Empty exactly when the class is `ESTABLISHED`. */
    notEstablished: string[];
  };
  createdAt: string;
}

export interface ResolutionListPage {
  resolutions: ResolutionSummary[];
  total: number;
}

/**
 * The body of `GET /api/resolutions/latest`.
 *
 * `resolution` is null when the investigation exists and has produced no record
 * yet. That is a real answer and not a 404, which would be indistinguishable
 * from a wrong id.
 */
export interface LatestResolution {
  resolution: Resolution | null;
}

// ─── Organization ────────────────────────────────────────────────────────────

/** `toOrganization`. */
export interface Organization {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

/**
 * The body of `GET /api/organization`.
 *
 * Investigations and validations are counted separately because they are
 * different runs and one total could not be taken apart again. There is no plan,
 * seat or spend field, because the schema holds none.
 */
export interface OrganizationOverview {
  organization: Organization;
  memberCount: number;
  /** Keys that can still authenticate. Revoked ones are counted apart, below. */
  apiKeyCount: number;
  revokedApiKeyCount: number;
  repositoryCount: number;
  investigationCount: number;
  validationCount: number;
}

/** `deriveAvatar`. Derived from the member row, never fetched. */
export interface DerivedAvatar {
  [key: string]: unknown;
}

/**
 * `toOrganizationMember`.
 *
 * `role` and `roleEnforced` are a pair and must be rendered as one. `api_keys`
 * carries an org and no user, so an authenticated request identifies an
 * organisation and never a person, and nothing in the API consults `role` to
 * decide what a request may do. `roleEnforced` is `false` on every row today
 * (`ROLE_IS_ENFORCED`); showing the label without it renders an access model
 * this product does not have.
 */
export interface OrganizationMember {
  userId: string;
  email: string;
  name: string | null;
  avatar: DerivedAvatar;
  role: string;
  roleEnforced: boolean;
  joinedAt: string;
}

/**
 * `total` is the number of membership rows, which is not the same claim as the
 * number of people with access: nothing in the engine writes `users` or
 * `organization_members`, so an install where those rows were never created
 * answers with an empty list next to a working key. Render that as "no member
 * records exist", not as "you are alone in here".
 */
export interface OrganizationMemberPage {
  members: OrganizationMember[];
  total: number;
}

/**
 * `toApiKey`. There is no secret here and none was omitted: `api_keys` stores a
 * SHA-256 of the secret half and nothing else, so no field could rebuild a token.
 */
export interface ApiKey {
  id: string;
  name: string;
  createdAt: string;
  /** Coarse by design — written at most once a minute. "Still in use", not "when". */
  lastUsedAt: string | null;
  /** Non-null means the key is refused. */
  revokedAt: string | null;
}

export interface ApiKeyPage {
  keys: ApiKey[];
  total: number;
}

// ─── Health ──────────────────────────────────────────────────────────────────

/**
 * `unknown` is not a softer `failed`: it means the check could not be run at
 * all, which is still not evidence of readiness.
 */
export type ReadinessStatus = 'ok' | 'failed' | 'unknown';

export interface ReadinessCheck {
  name: string;
  status: ReadinessStatus;
  detail: string;
}

/**
 * `GET /api/health`. Readiness: every claim is established by performing it.
 *
 * The server answers 200 when ready and **503 when degraded**, with this same
 * body either way. {@link import('./client.js').CreddaClient.getHealth} returns
 * the body in both cases rather than throwing on the 503, because a degraded
 * readiness report is the answer the caller asked for.
 */
export interface Health {
  status: 'ok' | 'degraded';
  schemaVersion: number | null;
  expectedSchemaVersion: number;
  checks: ReadinessCheck[];
}
