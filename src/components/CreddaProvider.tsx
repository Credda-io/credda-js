import React, { createContext, useContext, useMemo } from 'react';
import { CreddaClient, CreddaConfig } from '../lib/client.js';

interface CreddaContextValue {
  client: CreddaClient;
}

const CreddaContext = createContext<CreddaContextValue | null>(null);

export interface CreddaProviderProps extends CreddaConfig {
  children: React.ReactNode;
}

export function CreddaProvider({ children, ...config }: CreddaProviderProps) {
  const client = useMemo(() => new CreddaClient(config), [config.apiBase]);
  return (
    <CreddaContext.Provider value={{ client }}>
      {children}
    </CreddaContext.Provider>
  );
}

export function useCreddaClient(): CreddaClient {
  const ctx = useContext(CreddaContext);
  if (!ctx) {
    throw new Error('useCreddaClient must be used inside <CreddaProvider>');
  }
  return ctx.client;
}
