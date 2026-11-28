import { cache } from 'react';
import type { AgentSummary } from '@astra/contracts';
import { api } from './api';

/** The registered agents, read once per request however many parts of the page ask. */
export const getAgents = cache(async (): Promise<AgentSummary[] | null> => {
  try {
    return (await api<{ items: AgentSummary[] }>('/v1/agents')).items;
  } catch (error) {
    // Redirects (an expired session) must reach Next.js.
    if (error && typeof error === 'object' && 'digest' in error) throw error;
    return null;
  }
});
