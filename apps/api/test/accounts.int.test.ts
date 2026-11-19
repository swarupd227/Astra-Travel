/** Accounts, idempotency (E14-F01-S01), audit and outbox written atomically (E13-F02-S01). */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bearer, createTestApp, resetDatabase, type TestContext } from './helpers';

let t: TestContext;
let admin: string;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => t.close());
beforeEach(async () => {
  await resetDatabase();
  admin = await t.idp.token({ roles: ['platform_admin'], sub: 'admin-1', name: 'Alex Admin' });
});

const create = (key: string | undefined, payload: object) =>
  t.app.inject({
    method: 'POST',
    url: '/v1/accounts',
    headers: { ...bearer(admin), ...(key ? { 'idempotency-key': key } : {}) },
    payload,
  });

describe('POST /v1/accounts', () => {
  it('requires an Idempotency-Key', async () => {
    const res = await create(undefined, {
      code: 'SKYAIR',
      name: 'Sky Air',
      kind: 'travel_account',
    });
    expect(res.statusCode).toBe(428);
    expect(res.json().code).toBe('idempotency_key_required');
  });

  it('returns field-level validation errors', async () => {
    const res = await create('key-validation-1', { code: 'x', name: '', kind: 'shop' });
    expect(res.statusCode).toBe(400);
    const fields = res
      .json()
      .errors.map((e: { field: string }) => e.field)
      .sort();
    expect(fields).toEqual(['code', 'kind', 'name']);
    for (const e of res.json().errors) expect(e.code && e.message).toBeTruthy();
  });

  it('creates the account, its audit record and its event in one transaction', async () => {
    const res = await create('key-create-1', {
      code: 'SKYAIR',
      name: 'Sky Air (synthetic)',
      kind: 'travel_account',
    });
    expect(res.statusCode, res.body).toBe(201);
    const account = res.json();
    expect(account).toMatchObject({ code: 'SKYAIR', status: 'onboarding', kind: 'travel_account' });
    expect(res.headers.location).toBe(`/v1/accounts/${account.id}`);

    const audit = await t.app.inject({
      method: 'GET',
      url: `/v1/audit?resourceId=${account.id}`,
      headers: bearer(admin),
    });
    const entry = audit.json().items[0];
    expect(entry).toMatchObject({
      action: 'account.registered',
      actorId: 'admin-1',
      actorName: 'Alex Admin',
      accountId: account.id,
    });
    expect(entry.correlationId).toBe(res.headers['x-correlation-id']);

    const events = await t.app.inject({
      method: 'GET',
      url: `/v1/events?type=AccountRegistered&accountId=${account.id}`,
      headers: bearer(admin),
    });
    const event = events.json().items[0];
    expect(event).toMatchObject({
      type: 'AccountRegistered',
      version: 1,
      source: 'astra.platform.accounts',
      accountId: account.id,
    });
    expect(event.correlationId).toBe(res.headers['x-correlation-id']);
  });

  it('replays the original response for a repeated key and never creates a duplicate', async () => {
    const payload = { code: 'REPLAY', name: 'Replay Air', kind: 'travel_account' };
    const first = await create('key-replay-1', payload);
    const again = await Promise.all([
      create('key-replay-1', payload),
      create('key-replay-1', payload),
    ]);
    for (const r of again) {
      expect(r.statusCode).toBe(201);
      expect(r.json()).toEqual(first.json());
      expect(r.headers['idempotent-replayed']).toBe('true');
    }
    const list = await t.app.inject({
      method: 'GET',
      url: '/v1/accounts?q=REPLAY',
      headers: bearer(admin),
    });
    expect(list.json().items).toHaveLength(1);
  });

  it('rejects a key reused with a different body', async () => {
    await create('key-reuse-1', { code: 'FIRST', name: 'First', kind: 'bank' });
    const res = await create('key-reuse-1', { code: 'SECOND', name: 'Second', kind: 'bank' });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('idempotency_key_reused');
  });

  it('reports a duplicate code as a conflict on the code field, and leaves the key usable', async () => {
    await create('key-dup-1', { code: 'DUP', name: 'Dup One', kind: 'bank' });
    const res = await create('key-dup-2', { code: 'DUP', name: 'Dup Two', kind: 'bank' });
    expect(res.statusCode).toBe(409);
    expect(res.json().errors[0].field).toBe('code');
    const retry = await create('key-dup-2', { code: 'DUP2', name: 'Dup Two', kind: 'bank' });
    expect(retry.statusCode).toBe(201);
  });
});

describe('account status', () => {
  it('blocks going live without onboarding and audits allowed changes with the reason', async () => {
    const { id } = (
      await create('key-status-1', { code: 'STATUS', name: 'Status Air', kind: 'travel_account' })
    ).json();
    const live = await t.app.inject({
      method: 'POST',
      url: `/v1/accounts/${id}/status`,
      headers: bearer(admin),
      payload: { status: 'active', reason: 'Go live' },
    });
    expect(live.statusCode).toBe(409);
    expect(live.json().detail).toMatch(/onboarding checklist/);

    const close = await t.app.inject({
      method: 'POST',
      url: `/v1/accounts/${id}/status`,
      headers: bearer(admin),
      payload: { status: 'closed', reason: 'Contract not signed' },
    });
    expect(close.statusCode).toBe(200);
    expect(close.json().status).toBe('closed');
    const audit = await t.app.inject({
      method: 'GET',
      url: `/v1/audit?action=account.status_changed&resourceId=${id}`,
      headers: bearer(admin),
    });
    expect(audit.json().items[0]).toMatchObject({
      reason: 'Contract not signed',
      data: { from: 'onboarding', to: 'closed' },
    });
  });

  it('returns not found for unknown accounts', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/v1/accounts/00000000-0000-4000-8000-000000000000',
      headers: bearer(admin),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('not_found');
  });
});
