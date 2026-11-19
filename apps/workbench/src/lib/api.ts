import { randomUUID } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import type { Me, Permission, Problem } from '@astra/contracts';
import { ApiProblem } from './api-problem';
import { env } from './env';
import { SESSION_COOKIE, unsealSession } from './session';

export { ApiProblem };

export interface ApiRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | undefined | null>;
  idempotencyKey?: string;
}

export const getSession = cache(async () =>
  unsealSession((await cookies()).get(SESSION_COOKIE)?.value),
);

/** Calls the platform API on the server with the signed-in user's access token. */
export async function api<T>(path: string, req: ApiRequest = {}): Promise<T> {
  const session = await getSession();
  if (!session) redirect('/api/auth/login');

  const url = new URL(path, env().API_BASE_URL);
  for (const [k, v] of Object.entries(req.query ?? {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const headers: Record<string, string> = {
    authorization: `Bearer ${session.accessToken}`,
    accept: 'application/json',
    'x-correlation-id': randomUUID(),
  };
  if (req.body !== undefined) headers['content-type'] = 'application/json';
  if (req.idempotencyKey) headers['idempotency-key'] = req.idempotencyKey;

  let res: Response;
  try {
    res = await fetch(url, {
      method: req.method ?? 'GET',
      headers,
      body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ApiProblem({
      type: 'urn:astra:error:service_unavailable',
      title: 'The platform API is not reachable',
      status: 503,
      code: 'service_unavailable',
      correlationId: headers['x-correlation-id']!,
    });
  }

  if (res.status === 204) return undefined as T;
  const json: unknown = await res.json().catch(() => null);
  if (res.status === 401) redirect('/api/auth/login');
  if (!res.ok) {
    const problem = json as Problem | null;
    throw new ApiProblem(
      problem?.code
        ? problem
        : {
            type: 'urn:astra:error:internal_error',
            title: `The API answered HTTP ${res.status}`,
            status: res.status,
            code: 'internal_error',
            correlationId: res.headers.get('x-correlation-id') ?? '',
          },
    );
  }
  return json as T;
}

/** The signed-in principal, fetched once per request. Null if the user has no Astra role. */
export const getMe = cache(async (): Promise<Me | null> => {
  try {
    return await api<Me>('/v1/me');
  } catch (err) {
    if (err instanceof ApiProblem && err.problem.code === 'forbidden') return null;
    throw err;
  }
});

export async function can(permission: Permission): Promise<boolean> {
  const me = await getMe();
  return !!me?.permissions.includes(permission);
}
