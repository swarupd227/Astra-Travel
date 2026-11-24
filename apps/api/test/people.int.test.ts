/** Display names for recorded subjects: recorded from the signed-in token, shown on staff screens. */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { bearer, createTestApp, insertAccount, resetDatabase, type TestContext } from './helpers';

let t: TestContext;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => t.close());
beforeEach(async () => resetDatabase());

it('records names as people use the API and resolves them for staff', async () => {
  const casey = await t.idp.token({
    roles: ['compliance_officer'],
    sub: 'subj-casey',
    name: 'Casey Compliance',
  });
  expect(
    (await t.app.inject({ method: 'GET', url: '/v1/me', headers: bearer(casey) })).statusCode,
  ).toBe(200);
  // A new name in the token replaces the old one.
  const renamed = await t.idp.token({
    roles: ['compliance_officer'],
    sub: 'subj-casey',
    name: 'Casey C. Compliance',
  });
  await t.app.inject({ method: 'GET', url: '/v1/me', headers: bearer(renamed) });

  const res = await t.app.inject({
    method: 'GET',
    url: '/v1/people?subject=subj-casey&subject=system:refdata-loader&subject=never-seen',
    headers: bearer(renamed),
  });
  expect(res.statusCode, res.body).toBe(200);
  expect(res.json().items).toEqual([
    { subject: 'subj-casey', name: 'Casey C. Compliance', kind: 'user' },
    { subject: 'system:refdata-loader', name: 'System (refdata-loader)', kind: 'system' },
    { subject: 'never-seen', name: 'Unknown person', kind: 'unknown' },
  ]);
});

it('is for staff only', async () => {
  const account = await insertAccount(t.pool, 'PEOPLE-A');
  const partner = await t.idp.token({
    roles: ['partner_developer'],
    accountId: account,
    sub: 'svc-a',
  });
  expect(
    (await t.app.inject({ method: 'GET', url: '/v1/people?subject=x', headers: bearer(partner) }))
      .statusCode,
  ).toBe(403);
});
