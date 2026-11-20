import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AgentTokenSigner, AgentTokenVerifier } from './agent-token';
import { AG10 } from './catalogue/ag-10-operations-copilot';
import { gradeCase, scoreResults, type CaseResult } from './evaluation';
import { costUsd, usageOf, type BetaMessage } from './gateway';
import { configHash } from './manifest';
import { TOOL_CATALOGUE, toolInputSchema } from './tools';

function keys() {
  const k = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return {
    priv: Buffer.from(k.privateKey).toString('base64'),
    pub: Buffer.from(k.publicKey).toString('base64'),
  };
}

describe('agent run tokens', () => {
  const claims = {
    agentId: 'AG-10',
    agentName: 'Operations Copilot',
    runId: '7d1f6c2a-3b4e-4f5a-8b6c-9d0e1f2a3b09',
    onBehalfOf: 'user-1',
    onBehalfOfName: 'Alex Admin',
    permissions: ['accounts:read'],
    accountScope: '*' as const,
  };

  it('round-trips the run identity, permissions and scope', async () => {
    const k = keys();
    const signer = await AgentTokenSigner.fromPrivateKey(k.priv);
    const verifier = await AgentTokenVerifier.fromPublicKey(k.pub, 'astra-api');
    expect(await verifier.verify(await signer.sign(claims, 'astra-api'))).toEqual(claims);
  });

  it('rejects tokens from another key or for another audience', async () => {
    const a = keys();
    const b = keys();
    const token = await (await AgentTokenSigner.fromPrivateKey(a.priv)).sign(claims, 'astra-api');
    await expect(
      (await AgentTokenVerifier.fromPublicKey(b.pub, 'astra-api')).verify(token),
    ).rejects.toThrow();
    const other = await (await AgentTokenSigner.fromPrivateKey(a.priv)).sign(claims, 'other-api');
    await expect(
      (await AgentTokenVerifier.fromPublicKey(a.pub, 'astra-api')).verify(other),
    ).rejects.toThrow();
  });
});

describe('cost', () => {
  it('prices Claude Opus 5.5 at list price including cache tokens', () => {
    expect(
      costUsd('claude-opus-5-5', {
        input: 1_000_000,
        output: 100_000,
        cacheRead: 1_000_000,
        cacheWrite: 0,
      }),
    ).toBeCloseTo(4 + 2 + 0.2);
  });

  it('prices each fallback iteration by the model that served it, and flags unknown models', () => {
    const message = {
      model: 'claude-opus-4-8',
      usage: {
        input_tokens: 2000,
        output_tokens: 200,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        iterations: [
          {
            type: 'message',
            model: 'claude-opus-5-5',
            input_tokens: 1000,
            output_tokens: 100,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          {
            type: 'fallback_message',
            model: 'claude-opus-4-8',
            input_tokens: 1000,
            output_tokens: 100,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        ],
      },
    } as unknown as BetaMessage;
    const u = usageOf(message);
    expect(u.models).toEqual(['claude-opus-5-5', 'claude-opus-4-8']);
    expect(u.costUsd).toBeCloseTo((1000 * 4 + 100 * 20 + 1000 * 5 + 100 * 25) / 1e6);
    expect(u.estimated).toBe(false);
    expect(
      usageOf({
        model: 'claude-future-9',
        usage: { input_tokens: 1, output_tokens: 1 },
      } as unknown as BetaMessage).estimated,
    ).toBe(true);
  });
});

describe('manifests and tools', () => {
  it('gives a stable hash that changes when behaviour changes', () => {
    expect(configHash(AG10)).toBe(configHash({ ...AG10 }));
    expect(configHash({ ...AG10, systemPrompt: `${AG10.systemPrompt} ` })).not.toBe(
      configHash(AG10),
    );
    expect(configHash({ ...AG10, model: 'claude-sonnet-5-5' })).not.toBe(configHash(AG10));
  });

  it('only uses read tools for the L0 agent and keeps tool schemas closed', () => {
    for (const name of AG10.tools) {
      const t = TOOL_CATALOGUE[name]!;
      expect(t.risk).toBe('read');
      expect(AG10.dataAccess).toContain(t.permission);
      expect(toolInputSchema(t)).toMatchObject({ type: 'object', additionalProperties: false });
    }
  });

  it('proposes a warrant within the agent’s registered tools and access', () => {
    for (const t of AG10.proposedWarrant.tools) expect(AG10.tools).toContain(t.name);
    for (const p of AG10.proposedWarrant.dataAccess) expect(AG10.dataAccess).toContain(p);
  });
});

describe('evaluation grading', () => {
  const c = {
    id: 'x',
    description: '',
    question: '',
    critical: true,
    expect: { toolsCalled: ['list_accounts'], answerNotMatches: ['secret'] },
  };

  it('passes only when every expectation holds and the run completed', () => {
    expect(
      gradeCase(c, { status: 'completed', stopReason: 'end_turn', answer: 'Two accounts.' }, [
        'list_accounts',
      ]),
    ).toEqual([]);
    expect(
      gradeCase(c, { status: 'completed', stopReason: 'end_turn', answer: 'the secret' }, []),
    ).toHaveLength(2);
    expect(
      gradeCase(c, { status: 'stopped', stopReason: 'agent_paused', answer: null }, [
        'list_accounts',
      ]),
    ).toHaveLength(1);
  });

  it('fails the evaluation when any critical case fails, whatever the score', () => {
    const r = (passed: boolean, critical: boolean) => ({ passed, critical }) as CaseResult;
    expect(scoreResults([r(true, false), r(true, false), r(false, true)], 0.5)).toEqual({
      score: 0.667,
      passed: false,
    });
    expect(scoreResults([r(true, true), r(true, false), r(false, false)], 0.6)).toEqual({
      score: 0.667,
      passed: true,
    });
  });
});
