/**
 * The engine's closed vocabularies, as values rather than as types alone.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * `types.ts` declares `InvestigationState`, `InvestigationOutcome`,
 * `ValidationState`, `ValidationOutcome` and the rest as string-literal unions.
 * They were hand-transcribed from `core`'s `packages/shared`, and a union is
 * erased at runtime, so NOTHING could notice when the engine gained a member:
 * that is how `READY_FOR_REVIEW` and `REPORT_REFUTED` were arriving over the
 * wire as values `InvestigationState` said could not exist. A typed client that
 * silently omits a state the engine can return types away a real value.
 *
 * `route-surface.json` now carries the engine's own `vocabularies` block --
 * generated in `core` by `scripts/generate-route-surface.ts` out of the same
 * `as const` arrays the API validates against -- so the drift is detectable.
 * Detecting it needs one thing a union cannot give: the members as a value the
 * suite can compare. That is what the arrays below are.
 *
 * ---------------------------------------------------------------------------
 * THE TWO HALVES, AND WHICH GATE CATCHES WHICH
 * ---------------------------------------------------------------------------
 *   - Array vs. ENGINE: `surface.test.ts` compares every array here to the
 *     vocabulary block in `route-surface.json`, in order. `npm test` is red
 *     when the engine's set moves and this file does not.
 *   - Array vs. UNION: `satisfies` rejects a member here that the union does
 *     not have, and {@link Exhaustive} rejects a union member missing from
 *     here, naming it. `npm run typecheck` is red either way.
 *
 * Both halves are needed and neither is redundant: the first cannot see the
 * unions and the second cannot see the engine. Together the union in
 * `types.ts` can no longer disagree with the engine without a gate failing.
 *
 * THIS FILE IS NOT EXPORTED from `index.ts` or `headless.ts`. It is the
 * client's own record of the engine's vocabularies, not a second public API
 * surface to keep in step with the README.
 */
import type {
  CheckStatus,
  EvidenceType,
  FindingSeverity,
  FindingStatus,
  InvestigationOutcome,
  InvestigationState,
  LearningKind,
  ResolutionConfidenceClass,
  ValidationOutcome,
  ValidationState,
} from './types.js';

/**
 * `true` when `Listed` covers every member of `Union`; otherwise the members it
 * misses, so the compile error names them rather than saying `false`.
 */
type Exhaustive<Union extends string, Listed extends Union> = [Exclude<Union, Listed>] extends [never]
  ? true
  : Exclude<Union, Listed>;

/** `GET /api/investigations` — `state`. */
export const INVESTIGATION_STATES = [
  'CREATED',
  'PREPARING_ENVIRONMENT',
  'ANALYZING_REPOSITORY',
  'UNDERSTANDING_ISSUE',
  'INVESTIGATING',
  'ATTEMPTING_REPRODUCTION',
  'REPRODUCED',
  'DIAGNOSING',
  'ROOT_CAUSE_IDENTIFIED',
  'REPRODUCED_AND_DIAGNOSED',
  'REPRODUCED_NOT_DIAGNOSED',
  'CONTRADICTS_SPECIFICATION',
  'ISSUE_ALREADY_RESOLVED',
  'REPORT_REFUTED',
  'NO_CHANGE_REQUIRED',
  'NO_RUNNABLE_CHECK',
  'REPRODUCTION_FAILED',
  'INSUFFICIENT_EVIDENCE',
  'GENERATING_PATCH',
  'TESTING_PATCH',
  'VERIFYING',
  'VERIFIED',
  'READY_FOR_REVIEW',
  'VERIFICATION_FAILED',
  'PATCH_REJECTED',
  'NEEDS_HUMAN_INPUT',
  'CANCELLED',
  'FAILED',
] as const satisfies readonly InvestigationState[];
const _investigationStates: Exhaustive<InvestigationState, (typeof INVESTIGATION_STATES)[number]> = true;

/** `GET /api/investigations` — `outcome`. */
export const INVESTIGATION_OUTCOMES = [
  'REPRODUCED_AND_DIAGNOSED',
  'REPRODUCED_NOT_DIAGNOSED',
  'CONTRADICTS_SPECIFICATION',
  'NO_CHANGE_REQUIRED',
  'NO_RUNNABLE_CHECK',
  'INCONCLUSIVE',
  'VERIFIED',
  'PARTIALLY_VERIFIED',
  'PATCH_REJECTED',
  'CANCELLED',
  'ERRORED',
] as const satisfies readonly InvestigationOutcome[];
const _investigationOutcomes: Exhaustive<InvestigationOutcome, (typeof INVESTIGATION_OUTCOMES)[number]> = true;

/** `GET /api/validations` — `state`. */
export const VALIDATION_STATES = [
  'CREATED',
  'ANALYZING_CHANGE',
  'UNDERSTANDING_INTENT',
  'PLANNING',
  'PREPARING_ENVIRONMENT',
  'RUNNING',
  'CONFIRMING_FINDINGS',
  'INVESTIGATING_FINDING',
  'COMPLETED',
  'CANCELLED',
  'FAILED',
] as const satisfies readonly ValidationState[];
const _validationStates: Exhaustive<ValidationState, (typeof VALIDATION_STATES)[number]> = true;

/** `GET /api/validations` — `outcome`. */
export const VALIDATION_OUTCOMES = [
  'VERIFIED',
  'FAILED',
  'BLOCKED',
  'INCONCLUSIVE',
  'NO_CHANGE_REQUIRED',
  'CANCELLED',
  'ERRORED',
] as const satisfies readonly ValidationOutcome[];
const _validationOutcomes: Exhaustive<ValidationOutcome, (typeof VALIDATION_OUTCOMES)[number]> = true;

/** `GET /api/investigations/{id}/evidence` and `.../validations/{id}/evidence` — `type`. */
export const EVIDENCE_TYPES = [
  'TEST_RESULT',
  'REPRODUCTION',
  'STACK_TRACE',
  'LOG',
  'COMMAND_OUTPUT',
  'HTTP_RESPONSE',
  'BROWSER_OBSERVATION',
  'SCREENSHOT',
  'CODE_REFERENCE',
  'GIT_HISTORY',
  'BUILD_RESULT',
  'TYPECHECK_RESULT',
  'LINT_RESULT',
  'PERFORMANCE_RESULT',
  'VERIFICATION',
  'VALUE_OBSERVATION',
  'SPECIFICATION',
  'VULNERABILITY',
] as const satisfies readonly EvidenceType[];
const _evidenceTypes: Exhaustive<EvidenceType, (typeof EVIDENCE_TYPES)[number]> = true;

/** `GET /api/repositories/{id}/learnings` — `kind`. */
export const LEARNING_KINDS = [
  'REPRODUCTION_RECIPE',
  'FRAGILE_SITE',
  'REJECTED_APPROACH',
  'NON_DEFECT',
  'CONVENTION',
] as const satisfies readonly LearningKind[];
const _learningKinds: Exhaustive<LearningKind, (typeof LEARNING_KINDS)[number]> = true;

/** `GET /api/resolutions` — `confidence`. Ordinal; never a percentage (ADR 0012). */
export const RESOLUTION_CONFIDENCE_CLASSES = [
  'ESTABLISHED',
  'PARTIALLY_ESTABLISHED',
  'NOT_ESTABLISHED',
] as const satisfies readonly ResolutionConfidenceClass[];
const _resolutionConfidenceClasses: Exhaustive<
  ResolutionConfidenceClass,
  (typeof RESOLUTION_CONFIDENCE_CLASSES)[number]
> = true;

/** `GET /api/validations/{id}/checks` — `status`. */
export const CHECK_STATUSES = [
  'PENDING',
  'RUNNING',
  'PASSED',
  'FAILED',
  'PRE_EXISTING_FAILURE',
  'BLOCKED',
  'SKIPPED',
] as const satisfies readonly CheckStatus[];
const _checkStatuses: Exhaustive<CheckStatus, (typeof CHECK_STATUSES)[number]> = true;

/** `GET /api/validations/{id}/findings` — `severity`. */
export const FINDING_SEVERITIES = ['HIGH', 'MEDIUM', 'LOW'] as const satisfies readonly FindingSeverity[];
const _findingSeverities: Exhaustive<FindingSeverity, (typeof FINDING_SEVERITIES)[number]> = true;

/** `GET /api/validations/{id}/findings` — `status`. */
export const FINDING_STATUSES = [
  'OPEN',
  'DISMISSED',
  'ENVIRONMENT_RELATED',
  'RESOLVED',
] as const satisfies readonly FindingStatus[];
const _findingStatuses: Exhaustive<FindingStatus, (typeof FINDING_STATUSES)[number]> = true;

/*
 * The exhaustiveness witnesses above are compile-time assertions. They are
 * referenced here so that a config gaining `noUnusedLocals` reports a real
 * problem rather than deleting the guards.
 */
export const UNION_COVERAGE_WITNESSES = [
  _investigationStates,
  _investigationOutcomes,
  _validationStates,
  _validationOutcomes,
  _evidenceTypes,
  _learningKinds,
  _resolutionConfidenceClasses,
  _checkStatuses,
  _findingSeverities,
  _findingStatuses,
] as const;

/**
 * `"METHOD /path"` then query parameter, to the array above that must equal the
 * engine's vocabulary for it.
 *
 * Every parameter the artifact declares is either here or in
 * {@link UNTYPED_FILTERS} with a reason. A filter the engine gains fails
 * `surface.test.ts` by name rather than arriving unnoticed.
 */
export const FILTER_VOCABULARIES: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  'GET /api/investigations': { state: INVESTIGATION_STATES, outcome: INVESTIGATION_OUTCOMES },
  'GET /api/investigations/{id}/evidence': { type: EVIDENCE_TYPES },
  'GET /api/repositories/{id}/learnings': { kind: LEARNING_KINDS },
  'GET /api/resolutions': { confidence: RESOLUTION_CONFIDENCE_CLASSES },
  'GET /api/validations': { state: VALIDATION_STATES, outcome: VALIDATION_OUTCOMES },
  'GET /api/validations/{id}/checks': { status: CHECK_STATUSES },
  'GET /api/validations/{id}/findings': { severity: FINDING_SEVERITIES, status: FINDING_STATUSES },
  'GET /api/validations/{id}/evidence': { type: EVIDENCE_TYPES },
};

/**
 * The filters the engine declares a vocabulary for that this client
 * deliberately does not carry as a union, each with the reason. An entry is a
 * decision, not a gap: deleting one does not "fix" anything, it fails the suite
 * until the filter is either typed or given a reason again.
 */
export const UNTYPED_FILTERS: Readonly<Record<string, string>> = {
  hasSignal:
    'NOT REACHABLE FROM THIS CLIENT AT ALL, which is a different fact from the one this entry ' +
    'used to state. `ListInvestigationsQuery` and `ListResolutionsQuery` carry `signalId` -- WHICH ' +
    'signal raised the run -- and no field for `hasSignal`, which asks WHETHER one did. So there ' +
    'is no union to write and nothing to serialise: the filter is absent, not untyped. ' +
    '`@credda/mcp-server` does take it as a boolean on both routes and `credda-go` states its own ' +
    'absence in `api.go`; this client was the one saying it had a filter it does not have. ' +
    'Recorded rather than built: adding the field is a capability decision, not a wording fix.',
  includeDebug:
    'The wire vocabulary is ["true","false","1","0"] because a query string carries strings. The ' +
    'client does take this one: `ListEventsQuery.includeDebug` is a TypeScript boolean and ' +
    '`queryString` serialises it, which is the same fact in the type a caller already has, and a ' +
    'union of the four spellings would be a worse type than the one the language already has.',
};
