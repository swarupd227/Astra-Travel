import { describe, expect, it } from 'vitest';
import type { ModelGateway, ModelRequest, ModelResult } from './gateway';
import { ConfiguredModelGateway } from './model-connection';

const request: ModelRequest = {
  model: 'claude-opus-5-5',
  system: 's',
  tools: [],
  messages: [],
  maxTokens: 16,
  effort: 'low',
};

describe('ConfiguredModelGateway', () => {
  it('follows the saved key: read before every call, a new client only when it changes', async () => {
    let saved: string | null = null;
    const created: (string | null)[] = [];
    const used: (string | null)[] = [];
    const gateway = new ConfiguredModelGateway(
      async () => saved,
      (apiKey): ModelGateway => {
        created.push(apiKey);
        return {
          complete: async () => {
            used.push(apiKey);
            return {} as ModelResult;
          },
        };
      },
    );
    await gateway.complete(request);
    saved = 'first';
    await gateway.complete(request);
    await gateway.complete(request);
    saved = 'second';
    await gateway.complete(request);
    saved = null;
    await gateway.complete(request);
    expect(used).toEqual([null, 'first', 'first', 'second', null]);
    expect(created).toEqual([null, 'first', 'second', null]);
  });
});
