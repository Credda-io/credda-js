/**
 * `@credda/js` — the typed client and React hooks for the Credda engine API.
 *
 * A customer labels a defect or vulnerability; Credda reproduces it, diagnoses
 * the cause, and — see the README's status table for what the API serves
 * today — writes the patch and the test that proves it. Delivering that as a
 * pull request is opt-in and off by default. This package reads that engine.
 *
 * Everything in `@credda/js/headless` is re-exported here, plus the provider
 * and hooks, which need React.
 */

export * from './headless.js';

export { CreddaProvider, useCreddaClient } from './components/CreddaProvider.js';
export type { CreddaProviderProps } from './components/CreddaProvider.js';

export { useInvestigations } from './hooks/useInvestigations.js';
export type { UseInvestigationsResult } from './hooks/useInvestigations.js';

export { useInvestigation } from './hooks/useInvestigation.js';
export type { UseInvestigationResult } from './hooks/useInvestigation.js';

export { useInvestigationEvents } from './hooks/useInvestigationEvents.js';
export type {
  UseInvestigationEventsOptions,
  UseInvestigationEventsResult,
} from './hooks/useInvestigationEvents.js';

export { useResolution } from './hooks/useResolution.js';
export type { UseResolutionResult } from './hooks/useResolution.js';

export { useValidation } from './hooks/useValidation.js';
export type { UseValidationResult } from './hooks/useValidation.js';

export { useValidationEvents } from './hooks/useValidationEvents.js';
export type {
  UseValidationEventsOptions,
  UseValidationEventsResult,
} from './hooks/useValidationEvents.js';
