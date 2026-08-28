import { useCreddaClient } from '../components/CreddaProvider.js';
import { useEventStream } from './useEventStream.js';
import type { UseEventStreamOptions, UseEventStreamResult } from './useEventStream.js';
import type { ValidationEvent } from '../lib/types.js';

export type UseValidationEventsOptions = UseEventStreamOptions;
export type UseValidationEventsResult = UseEventStreamResult<ValidationEvent>;

/** The live timeline of one validation run. Same shape and same rules as the investigation stream. */
export function useValidationEvents(
  id: string | null | undefined,
  options: UseValidationEventsOptions = {},
): UseValidationEventsResult {
  const client = useCreddaClient();
  return useEventStream<ValidationEvent>(
    id,
    (since, signal, reconnect) => client.streamValidation(id as string, { since, signal, reconnect }),
    options,
  );
}
