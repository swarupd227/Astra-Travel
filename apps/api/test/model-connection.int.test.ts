/**
 * The model connection settings: who may use them, that the key is stored encrypted and never returned, and the
 * connection test. The model service is a local stand-in that checks the key it is sent; no live call is made.
 * Every key here is invented.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { savedModelKey } from '@astra/agents';
import type { ModelConnection, ModelConnectionTest } from '@astra/contracts';
import { SecretBox, systemContext, withTx } from '@astra/platform';
import { bearer, createTestApp, resetDatabase, type TestContext } from './helpers';

const GOOD_KEY = 'test-key-accepted-0000000000-AB12';
const SECOND_KEY = 'test-key-accepted-1111111111-CD34';
const BAD_KEY = 'test-key-rejected-2222222222-EF56';
const URL_ = '/v1/settings/model-connection';

let ctx: TestContext;
let stub: Server;
let stubUrl: string;
const received: { key: string; model: string }[] = [];

beforeAll(async () => {
  stub = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      // The SDK sends an API key as a bearer credential.
      const key = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
      const { model } = JSON.parse(body) as { model: string };
      received.push({ key, model });
      const accepted = key === GOOD_KEY || key === SECOND_KEY;
      res.writeHead(accepted ? 200 : 401, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          accepted
            ? {
                id: 'msg_stub',
                type: 'message',
                role: 'assistant',
                model,
                content: [{ type: 'text', text: 'OK' }],
                stop_reason: 'end_turn',
                stop_sequence: null,
                usage: { input_tokens: 8, output_tokens: 1 },
              }
            : {
                type: 'error',
                error: { type: 'authentication_error', message: 'invalid x-api-key' },
              },
        ),
      );
    });
  });
  await new Promise<void>((done) => stub.listen(0, '127.0.0.1', done));
  stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  await resetDatabase();
  ctx = await createTestApp();
  ctx.setModelServiceUrl(stubUrl);
});

afterAll(async () => {
  await ctx?.close();
  await new Promise((done) => stub.close(done));
});

/** The tables are closed to everything but platform-wide requests. */
const readAsPlatform = <T extends object = Record<string, unknown>>(sql: string) =>
  withTx(ctx.pool, systemContext('test'), (tx) => tx.query<T>(sql));

const admin = async () =>
  bearer(await ctx.idp.token({ roles: ['platform_admin'], name: 'Alex Admin', sub: 'admin-1' }));

describe('model connection settings', () => {
  it('is closed to everyone but a platform administrator', async () => {
    for (const roles of [
      ['ai_governance_lead'],
      ['ops_supervisor'],
      ['compliance_officer'],
    ] as const) {
      const headers = bearer(await ctx.idp.token({ roles: [...roles] }));
      for (const request of [
        { method: 'GET' as const, url: URL_ },
        { method: 'PUT' as const, url: `${URL_}/key`, payload: { apiKey: GOOD_KEY, reason: 'x' } },
        { method: 'POST' as const, url: `${URL_}/test`, payload: {} },
        { method: 'POST' as const, url: `${URL_}/key/removal`, payload: { reason: 'try' } },
      ]) {
        const res = await ctx.app.inject({ ...request, headers });
        expect(res.statusCode, `${roles[0]} ${request.method} ${request.url}`).toBe(403);
      }
    }
    expect(received).toHaveLength(0);
  });

  it('starts with no key and cannot test one that is not there', async () => {
    const headers = await admin();
    const res = await ctx.app.inject({ method: 'GET', url: URL_, headers });
    expect(res.statusCode).toBe(200);
    const body = res.json<ModelConnection>();
    expect(body.savedKey).toBeNull();
    expect(body.models.length).toBeGreaterThan(0);
    const test = await ctx.app.inject({
      method: 'POST',
      url: `${URL_}/test`,
      headers,
      payload: {},
    });
    expect(test.statusCode).toBe(409);
    expect(await savedModelKey(ctx.pool, ctx.secrets)).toBeNull();
  });

  it('tests an entered key without saving it, and says when it is rejected', async () => {
    const headers = await admin();
    received.length = 0;
    const good = await ctx.app.inject({
      method: 'POST',
      url: `${URL_}/test`,
      headers,
      payload: { apiKey: GOOD_KEY },
    });
    expect(good.statusCode).toBe(200);
    const passed = good.json<ModelConnectionTest>();
    expect(passed).toMatchObject({ ok: true, outcome: 'connected', source: 'entered' });
    expect(received.map((r) => r.model)).toEqual(passed.models.map((m) => m.model));
    // Only the entered key travels: nothing from the environment.
    expect(received.every((r) => r.key === GOOD_KEY)).toBe(true);

    const bad = await ctx.app.inject({
      method: 'POST',
      url: `${URL_}/test`,
      headers,
      payload: { apiKey: BAD_KEY },
    });
    expect(bad.json<ModelConnectionTest>()).toMatchObject({ ok: false, outcome: 'invalid_key' });
    expect(bad.body).not.toContain(BAD_KEY);
    expect(await savedModelKey(ctx.pool, ctx.secrets)).toBeNull();
  });

  it('saves a key encrypted, shows only its end, and gives it to the model gateway', async () => {
    const headers = await admin();
    const res = await ctx.app.inject({
      method: 'PUT',
      url: `${URL_}/key`,
      headers,
      payload: { apiKey: `  ${GOOD_KEY}  `, reason: 'First key for the pilot' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(GOOD_KEY);
    expect(res.json<ModelConnection>().savedKey).toMatchObject({
      endsWith: 'AB12',
      savedBy: 'Alex Admin',
      reason: 'First key for the pilot',
    });
    const stored = await readAsPlatform(`SELECT * FROM platform.model_credentials`);
    expect(stored.rows).toHaveLength(1);
    expect(JSON.stringify(stored.rows)).not.toContain(GOOD_KEY);
    expect((await savedModelKey(ctx.pool, ctx.secrets))?.apiKey).toBe(GOOD_KEY);
    // The wrong encryption key cannot open it.
    const other = new SecretBox({ test: Buffer.alloc(32, 7).toString('base64') }, 'test');
    await expect(savedModelKey(ctx.pool, other)).rejects.toThrow();
    const audit = await ctx.app.inject({
      method: 'GET',
      url: '/v1/audit?action=model_key.saved',
      headers,
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.body).toContain('AB12');
    expect(audit.body).not.toContain(GOOD_KEY);
  });

  it('records the test of the saved key', async () => {
    const headers = await admin();
    const res = await ctx.app.inject({ method: 'POST', url: `${URL_}/test`, headers, payload: {} });
    expect(res.json<ModelConnectionTest>()).toMatchObject({ ok: true, source: 'saved' });
    const now = await ctx.app.inject({ method: 'GET', url: URL_, headers });
    expect(now.json<ModelConnection>().lastTest).toMatchObject({
      ok: true,
      outcome: 'connected',
      testedBy: 'Alex Admin',
    });
  });

  it('erases a key that is replaced or removed', async () => {
    const headers = await admin();
    const replaced = await ctx.app.inject({
      method: 'PUT',
      url: `${URL_}/key`,
      headers,
      payload: { apiKey: SECOND_KEY, reason: 'Rotated' },
    });
    expect(replaced.json<ModelConnection>()).toMatchObject({
      savedKey: { endsWith: 'CD34' },
      lastTest: null,
    });
    expect((await savedModelKey(ctx.pool, ctx.secrets))?.apiKey).toBe(SECOND_KEY);

    const removed = await ctx.app.inject({
      method: 'POST',
      url: `${URL_}/key/removal`,
      headers,
      payload: { reason: 'Pilot ended' },
    });
    expect(removed.json<ModelConnection>().savedKey).toBeNull();
    const rows = await readAsPlatform<{ ciphertext: string | null }>(
      `SELECT ciphertext FROM platform.model_credentials`,
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.every((r) => r.ciphertext === null)).toBe(true);
    const again = await ctx.app.inject({
      method: 'POST',
      url: `${URL_}/key/removal`,
      headers,
      payload: { reason: 'Pilot ended' },
    });
    expect(again.statusCode).toBe(404);
  });

  it('refuses something that is not a key, without repeating it', async () => {
    const res = await ctx.app.inject({
      method: 'PUT',
      url: `${URL_}/key`,
      headers: await admin(),
      payload: { apiKey: 'two words and a few more here', reason: 'Wrong paste' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('two words');
  });

  it('says when the model service cannot be reached', async () => {
    ctx.setModelServiceUrl('http://127.0.0.1:9');
    const res = await ctx.app.inject({
      method: 'POST',
      url: `${URL_}/test`,
      headers: await admin(),
      payload: { apiKey: GOOD_KEY },
    });
    expect(res.json<ModelConnectionTest>()).toMatchObject({ ok: false, outcome: 'unreachable' });
    ctx.setModelServiceUrl(stubUrl);
  });
});
