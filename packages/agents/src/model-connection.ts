import Anthropic from '@anthropic-ai/sdk';
import type { ModelConnectionTest, ModelTestOutcome } from '@astra/contracts';
import { systemContext, withTx, type Pool, type SecretBox } from '@astra/platform';
import {
  AnthropicGateway,
  type ModelGateway,
  type ModelRequest,
  type ModelResult,
} from './gateway';

/**
 * The model API key an administrator saved in the application, and the test of it. The key is held encrypted;
 * only the worker (to call the model) and the connection test open it.
 */

export const credentialAad = (id: string) => `model-credential:${id}`;

/** The saved key in clear, or null when none is saved. Never log or return what this gives. */
export async function savedModelKey(
  pool: Pool,
  secrets: SecretBox,
): Promise<{ id: string; apiKey: string } | null> {
  const row = await withTx(pool, systemContext('model-gateway'), async (tx) => {
    const { rows } = await tx.query<{ id: string; ciphertext: string; key_id: string }>(
      `SELECT id, ciphertext, key_id FROM platform.model_credentials WHERE removed_at IS NULL`,
    );
    return rows[0];
  });
  if (!row) return null;
  return { id: row.id, apiKey: secrets.open(row.ciphertext, row.key_id, credentialAad(row.id)) };
}

/**
 * The gateway the worker uses: the key saved in the application, read before each call so a change takes
 * effect at once; without one, the credentials in the environment (ANTHROPIC_API_KEY).
 */
export class ConfiguredModelGateway implements ModelGateway {
  private cached: { apiKey: string | null; gateway: ModelGateway } | undefined;

  constructor(
    private readonly key: () => Promise<string | null>,
    private readonly create: (apiKey: string | null) => ModelGateway = (apiKey) =>
      new AnthropicGateway(
        apiKey
          ? // An explicit key only: no token from the environment travels with it.
            new Anthropic({ apiKey, authToken: null, maxRetries: 2, timeout: 120_000 })
          : undefined,
      ),
  ) {}

  async complete(request: ModelRequest): Promise<ModelResult> {
    const apiKey = await this.key();
    if (!this.cached || this.cached.apiKey !== apiKey) {
      this.cached = { apiKey, gateway: this.create(apiKey) };
    }
    return this.cached.gateway.complete(request);
  }
}

type Failure = { outcome: ModelTestOutcome; message: string };

/** Most specific first: connection errors are also API errors. */
function failureOf(err: unknown, model: string): Failure {
  if (err instanceof Anthropic.APIConnectionError) {
    return {
      outcome: 'unreachable',
      message:
        'The model service could not be reached from the platform. Check outbound network access.',
    };
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return {
      outcome: 'invalid_key',
      message: 'The key was rejected. Check that it was copied in full and has not been revoked.',
    };
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return { outcome: 'no_access', message: `The key may not use ${model}.` };
  }
  if (err instanceof Anthropic.NotFoundError) {
    return { outcome: 'model_unavailable', message: `${model} is not available to this key.` };
  }
  if (err instanceof Anthropic.RateLimitError) {
    return {
      outcome: 'rate_limited',
      message:
        'The key was accepted, but the account is at its rate or spend limit. Try again later.',
    };
  }
  if (err instanceof Anthropic.BadRequestError) {
    return { outcome: 'rejected', message: `The request was refused: ${err.message}` };
  }
  if (err instanceof Anthropic.APIError) {
    return {
      outcome: 'service_error',
      message: `The model service answered with an error${err.status ? ` (${err.status})` : ''}.`,
    };
  }
  throw err;
}

/**
 * Proves a key can do what the agents need: one very small request to each model they use, shaped like the
 * agents' own requests. It costs a fraction of a cent.
 */
export async function testModelConnection(options: {
  apiKey: string;
  source: ModelConnectionTest['source'];
  models: string[];
  /** Tests point this at a stand-in service. */
  baseUrl?: string;
}): Promise<ModelConnectionTest> {
  const client = new Anthropic({
    apiKey: options.apiKey,
    authToken: null,
    ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
    maxRetries: 0,
    timeout: 30_000,
  });
  const started = Date.now();
  const models: ModelConnectionTest['models'] = [];
  let failure: Failure | undefined;
  for (const model of options.models) {
    try {
      await client.beta.messages.create({
        model,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'Reply with the word OK.' }],
        output_config: { effort: 'low' },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      });
      models.push({ model, ok: true });
    } catch (err) {
      const found = failureOf(err, model);
      // The service's own words may be passed on; the key never is.
      failure ??= {
        ...found,
        message: found.message.split(options.apiKey).join('[key]').slice(0, 500),
      };
      models.push({ model, ok: false });
      // A bad key or no connection fails every model alike.
      if (found.outcome === 'invalid_key' || found.outcome === 'unreachable') break;
    }
  }
  return {
    ok: !failure,
    source: options.source,
    outcome: failure?.outcome ?? 'connected',
    message:
      failure?.message ??
      `Connected. ${models.length === 1 ? `${models[0]!.model} answered.` : 'Every model answered.'}`,
    models,
    latencyMs: Date.now() - started,
    testedAt: new Date().toISOString(),
  };
}
