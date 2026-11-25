import { randomUUID } from 'node:crypto';
import type { Problem } from '@astra/contracts';
import { signChannelToken } from '@astra/contracts/channel-token';
import { ApiProblem } from './api-problem';
import { env } from './env';

/**
 * What the hosted journey's server does for a traveller (docs/adr/0015): read the journey's public configuration,
 * and call the API with a short channel token for the journey's own account. The token is minted here, never sent
 * to the browser, and can only quote, change options, read policies and documents, and bind.
 */

export interface JourneyConfig {
  slug: string;
  accountId: string;
  accountName: string;
  branding: { displayName: string; logoUrl: string | null; primaryColor: string; textOnPrimary: string };
  headline: string;
  plans: { code: string; name: string; state: string }[];
  payment: 'test' | 'unavailable';
}

const PERMISSIONS = ['quotes:create', 'quotes:read', 'quotes:reselect', 'policies:read', 'documents:read'];

export async function journeyConfig(slug: string): Promise<JourneyConfig | null> {
  if (!/^[a-z0-9][a-z0-9-]{2,39}$/.test(slug)) return null;
  try {
    const res = await fetch(new URL(`/v1/journeys/${slug}`, env().API_BASE_URL), { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    return (await res.json()) as JourneyConfig;
  } catch {
    return null;
  }
}

export function journeyAvailable(): boolean {
  return !!env().CHANNEL_SIGNING_SECRET;
}

export async function journeyApi<T>(cfg: Pick<JourneyConfig, 'accountId' | 'slug'>, path: string, req: { method?: 'GET' | 'POST' | 'PUT'; body?: unknown; idempotencyKey?: string; raw?: boolean } = {}): Promise<T> {
  const secret = env().CHANNEL_SIGNING_SECRET;
  if (!secret) throw new Error('The hosted journey is not configured: CHANNEL_SIGNING_SECRET is not set.');
  const { token } = signChannelToken(secret, { scope: 'journey', accountId: cfg.accountId, sub: cfg.slug, permissions: PERMISSIONS }, 15 * 60);
  const correlationId = randomUUID();
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: req.raw ? '*/*' : 'application/json', 'x-correlation-id': correlationId };
  if (req.body !== undefined) headers['content-type'] = 'application/json';
  if (req.idempotencyKey) headers['idempotency-key'] = req.idempotencyKey;
  let res: Response;
  try {
    res = await fetch(new URL(path, env().API_BASE_URL), { method: req.method ?? 'GET', headers, body: req.body !== undefined ? JSON.stringify(req.body) : undefined, cache: 'no-store', signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new ApiProblem({ type: 'urn:astra:error:service_unavailable', title: 'The service is not reachable', status: 503, code: 'service_unavailable', correlationId });
  }
  if (req.raw) {
    if (!res.ok) throw new ApiProblem({ type: 'urn:astra:error:not_found', title: 'Not found', status: res.status, code: 'not_found', correlationId });
    return res as unknown as T;
  }
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const problem = json as Problem | null;
    throw new ApiProblem(problem?.code ? problem : { type: 'urn:astra:error:internal_error', title: `The service answered HTTP ${res.status}`, status: res.status, code: 'internal_error', correlationId });
  }
  return json as T;
}
