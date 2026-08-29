/**
 * Headless entry point: the typed client and its types, with no React in the
 * module graph. Import this from a CLI, a server, a worker or a Lambda.
 *
 * `@credda/js` (the root entry) is this plus the provider and hooks, and needs
 * React installed.
 */

export { CreddaClient } from './lib/client.js';
export type {
  CancelInvestigationInput,
  CreateInvestigationInput,
  ListEventsQuery,
  ListEvidenceQuery,
  ListInvestigationsQuery,
  ListLearningsQuery,
  ListResolutionsQuery,
  ListValidationsQuery,
  PageQuery,
} from './lib/client.js';

export { Transport, queryString } from './lib/http.js';
export type { CreddaConfig, QueryValue, RequestOptions } from './lib/http.js';

export { CreddaError, isRetryableStatus } from './lib/errors.js';
export type { CreddaErrorCode, CreddaErrorContext } from './lib/errors.js';

/**
 * The SSE reader. Exported because a caller outside React streams a run the
 * same way the hooks do, and because `SseDecoder` is worth having on its own.
 */
export { SseDecoder, streamSse } from './lib/stream.js';
export type { SseFrame, StreamOptions } from './lib/stream.js';

export type * from './lib/types.js';
