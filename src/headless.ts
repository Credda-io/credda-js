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

export { IDEMPOTENCY_HEADER, Transport, queryString } from './lib/http.js';
export type { CreddaConfig, QueryValue, RequestOptions } from './lib/http.js';

/**
 * Idempotent creates. `idempotentCreate` pairs a report with a key and is the
 * only thing `createInvestigationOnce` accepts; the key is minted for you there
 * unless you pass one you already recorded.
 */
export { IdempotentCreate, idempotencyKey, idempotentCreate, newIdempotencyKey } from './lib/idempotency.js';
export type { IdempotencyKey } from './lib/idempotency.js';

export { CreddaError, isRetryableStatus } from './lib/errors.js';
export type { CreddaErrorCode, CreddaErrorContext } from './lib/errors.js';

/**
 * The SSE reader. Exported because a caller outside React streams a run the
 * same way the hooks do, and because `SseDecoder` is worth having on its own.
 */
export { SseDecoder, streamSse } from './lib/stream.js';
export type { SseFrame, StreamOptions } from './lib/stream.js';

export type * from './lib/types.js';
