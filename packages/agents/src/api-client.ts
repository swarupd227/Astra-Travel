import { outboundFetch } from '@astra/platform';

/** A failure answered by the platform API, passed back to the model as a tool error. */
export class ToolCallError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string | null,
  ) {
    super(message);
    this.name = 'ToolCallError';
  }
}

/**
 * Calls the platform REST API with the run's agent token. Agents reach data only this way, so the same
 * permission checks, row-level security, validation and audit apply as for people (E15-F02-S01).
 */
export class AgentApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly correlationId: string,
    private readonly fetchImpl?: typeof fetch,
  ) {}

  async get<T>(
    path: string,
    query: Record<string, string | number | undefined | null> = {},
  ): Promise<T> {
    const url = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    const res = await outboundFetch(
      url.toString(),
      {
        method: 'GET',
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: 'application/json',
          'x-correlation-id': this.correlationId,
        },
      },
      {
        integration: 'platform-api',
        idempotent: true,
        policy: { timeoutMs: 15_000 },
        fetchImpl: this.fetchImpl,
      },
    );
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const p = body as { detail?: string; title?: string; code?: string } | null;
      throw new ToolCallError(
        p?.detail ?? p?.title ?? `HTTP ${res.status}`,
        res.status,
        p?.code ?? null,
      );
    }
    return body as T;
  }

  /** Posts JSON. Used only by tools that submit proposals; a person applies anything an agent proposes. */
  async post<T>(path: string, body: unknown): Promise<T> {
    const url = new URL(path, this.baseUrl);
    const res = await outboundFetch(
      url.toString(),
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: 'application/json',
          'content-type': 'application/json',
          'x-correlation-id': this.correlationId,
        },
        body: JSON.stringify(body),
      },
      {
        integration: 'platform-api',
        idempotent: false,
        policy: { timeoutMs: 30_000 },
        fetchImpl: this.fetchImpl,
      },
    );
    const parsed: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const p = parsed as { detail?: string; title?: string; code?: string; errors?: { field?: string; message?: string }[] } | null;
      const lines = (p?.errors ?? []).slice(0, 30).map((e) => `- ${e.field ?? ''}: ${e.message ?? ''}`);
      throw new ToolCallError(
        [p?.detail ?? p?.title ?? `HTTP ${res.status}`, ...lines].join('\n'),
        res.status,
        p?.code ?? null,
      );
    }
    return parsed as T;
  }
}