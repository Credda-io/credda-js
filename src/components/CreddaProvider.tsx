import React, { createContext, useContext, useMemo } from 'react';
import { CreddaClient } from '../lib/client.js';
import type { CreddaConfig } from '../lib/http.js';

interface CreddaContextValue {
  client: CreddaClient;
}

const CreddaContext = createContext<CreddaContextValue | null>(null);

export interface CreddaProviderProps extends CreddaConfig {
  children: React.ReactNode;
}

/**
 * Supplies one {@link CreddaClient} to the hooks below.
 *
 * The client carries a bearer key that reads every investigation, patch,
 * finding and resolution in an organisation. `api_keys` has no scopes column,
 * so there is no narrower credential to hand a browser. Mount this in an
 * internal dashboard behind your own login, or in a page whose key is injected
 * server-side — not in a public bundle.
 */
export function CreddaProvider({ children, ...config }: CreddaProviderProps): React.ReactElement {
  // Keyed on the two values that decide which server and which organisation
  // this client speaks to; a config object rebuilt every render must not
  // rebuild the client and restart every subscription under it.
  const client = useMemo(
    () => new CreddaClient(config),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [config.baseUrl, config.apiKey],
  );
  return <CreddaContext.Provider value={{ client }}>{children}</CreddaContext.Provider>;
}

export function useCreddaClient(): CreddaClient {
  const ctx = useContext(CreddaContext);
  if (!ctx) {
    throw new Error('useCreddaClient must be used inside <CreddaProvider>');
  }
  return ctx.client;
}
