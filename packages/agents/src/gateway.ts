import Anthropic from '@anthropic-ai/sdk';

/**
 * Model gateway (E15-F02-S02). One interface for every agent; the model is chosen per agent version.
 * Locally it calls the Claude API; in Azure the same interface is backed by Claude in Microsoft Foundry.
 * Every call returns the model that actually served it and its token usage, priced at list price.
 */

export type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
export type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
export type BetaTool = Anthropic.Beta.Messages.BetaTool;
export type BetaToolUseBlock = Anthropic.Beta.Messages.BetaToolUseBlock;
export type BetaToolResultBlockParam = Anthropic.Beta.Messages.BetaToolResultBlockParam;

export interface ModelRequest {
  model: string;
  system: string;
  tools: BetaTool[];
  messages: BetaMessageParam[];
  maxTokens: number;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  /** Models that served this call (more than one when a refusal fallback ran). */
  models: string[];
  /** True when a model had no list price and was priced conservatively. */
  estimated: boolean;
}

export interface ModelResult {
  message: BetaMessage;
  usage: ModelUsage;
}

export interface ModelGateway {
  complete(request: ModelRequest): Promise<ModelResult>;
}

/** US dollars per million tokens, Claude API list prices (November 2026). */
interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const PRICES: Record<string, Price> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

/** Highest configured price: used for a model missing from the table, so budgets never under-count. */
const CONSERVATIVE: Price = Object.values(PRICES).reduce((a, b) => ({
  input: Math.max(a.input, b.input),
  output: Math.max(a.output, b.output),
  cacheRead: Math.max(a.cacheRead, b.cacheRead),
  cacheWrite: Math.max(a.cacheWrite, b.cacheWrite),
}));

export function isPriced(model: string): boolean {
  return model in PRICES;
}

export function priceOf(model: string): Price {
  return PRICES[model] ?? CONSERVATIVE;
}

export function costUsd(
  model: string,
  t: { input: number; output: number; cacheRead: number; cacheWrite: number },
): number {
  const p = priceOf(model);
  return (
    (t.input * p.input +
      t.output * p.output +
      t.cacheRead * p.cacheRead +
      t.cacheWrite * p.cacheWrite) /
    1e6
  );
}

export function usageOf(message: BetaMessage): ModelUsage {
  const u = message.usage;
  const totals = {
    input: u.input_tokens,
    output: u.output_tokens,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
  };
  const iterations = (u as { iterations?: Array<Record<string, unknown>> | null }).iterations ?? [];
  const priced = iterations.filter((it) => typeof it.model === 'string');
  if (priced.length > 0) {
    let cost = 0;
    const models = new Set<string>();
    for (const it of priced) {
      const model = it.model as string;
      models.add(model);
      cost += costUsd(model, {
        input: Number(it.input_tokens ?? 0),
        output: Number(it.output_tokens ?? 0),
        cacheRead: Number(it.cache_read_input_tokens ?? 0),
        cacheWrite: Number(it.cache_creation_input_tokens ?? 0),
      });
    }
    return {
      inputTokens: totals.input,
      outputTokens: totals.output,
      cacheReadTokens: totals.cacheRead,
      cacheWriteTokens: totals.cacheWrite,
      costUsd: cost,
      models: [...models],
      estimated: [...models].some((m) => !isPriced(m)),
    };
  }
  return {
    inputTokens: totals.input,
    outputTokens: totals.output,
    cacheReadTokens: totals.cacheRead,
    cacheWriteTokens: totals.cacheWrite,
    costUsd: costUsd(message.model, totals),
    models: [message.model],
    estimated: !isPriced(message.model),
  };
}

export class AnthropicGateway implements ModelGateway {
  private readonly client: Anthropic;

  constructor(client?: Anthropic) {
    // Credentials come from the environment (ANTHROPIC_API_KEY or an `ant auth login` profile).
    this.client = client ?? new Anthropic({ maxRetries: 2, timeout: 120_000 });
  }

  async complete(req: ModelRequest): Promise<ModelResult> {
    const message = await this.client.beta.messages.create({
      model: req.model,
      max_tokens: req.maxTokens,
      // The system prompt and tool list are stable per agent version: cache them.
      system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
      tools: req.tools,
      messages: req.messages,
      output_config: { effort: req.effort },
      // On a policy refusal the API re-runs the turn on a fallback model; the served model is recorded.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    return { message, usage: usageOf(message) };
  }
}
