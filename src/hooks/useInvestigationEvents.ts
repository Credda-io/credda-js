import { useCreddaClient } from '../components/CreddaProvider.js';
import { useEventStream } from './useEventStream.js';
import type { UseEventStreamOptions, UseEventStreamResult } from './useEventStream.js';
import type { InvestigationEvent } from '../lib/types.js';

export type UseInvestigationEventsOptions = UseEventStreamOptions;
export type UseInvestigationEventsResult = UseEventStreamResult<InvestigationEvent>;

/**
 * The live timeline of one investigation, over Server-Sent Events.
 *
 * `debug` events never arrive: the server withholds them from every stream and
 * offers no way to ask for them. They stay readable through
 * `listInvestigationEvents({ includeDebug: true })`.
 */
export function useInvestigationEvents(
  id: string | null | undefined,
  options: UseInvestigationEventsOptions = {},
): UseInvestigationEventsResult {
  const client = useCreddaClient();
  return useEventStream<InvestigationEvent>(
    id,
    (since, signal, reconnect) =>
      client.streamInvestigation(id as string, { since, signal, reconnect }),
    options,
  );
}
