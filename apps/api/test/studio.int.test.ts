/**
 * Increment 3: versioned reference data (E16-F01-S02), the filing register and the approval check
 * (E10-F01-S01/S02), and the form library with variable maps (E01-F01-S01/S02).
 *
 * Form wording below is quoted from the product specification (M1), which quotes the filed VSC form and
 * schedule; it is the only filed wording we hold. Everything else is labelled synthetic.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bearer, createTestApp, resetDatabase, type TestContext } from './helpers';
import { buildPdf } from './pdf';

let t: TestContext;
let analyst: string; // rating analyst: loads reference data and builds variable maps
let compliance: string; // compliance officer: records filings, approves what others loaded or built
let product: string; // product manager: builds variable maps
let underwriter: string; // read-only staff

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => t.close());

beforeEach(async () => {
  await resetDatabase();
  analyst = await t.idp.token({ roles: ['rating_analyst'], sub: 'analyst-1' });
  compliance = await t.idp.token({ roles: ['compliance_officer'], sub: 'compliance-1' });
  product = await t.idp.token({ roles: ['product_manager'], sub: 'product-1' });
  underwriter = await t.idp.token({ roles: ['underwriter'], sub: 'underwriter-1' });
});

let n = 0;
const send = (method: 'POST' | 'PUT' | 'DELETE', url: string, token: string, payload?: unknown) =>
  t.app.inject({
    method,
    url,
    headers: { ...bearer(token), 'idempotency-key': `studio-test-${Date.now()}-${n++}` },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
const get = (url: string, token = underwriter) =>
  t.app.inject({ method: 'GET', url, headers: bearer(token) });

const STATES = [
  { code: 'NY', name: 'New York', kind: 'state' },
  { code: 'CA', name: 'California', kind: 'state' },
  { code: 'DE', name: 'Delaware', kind: 'state' },
];

async function loadAndApprove(dataset: string, entries: unknown[], effectiveFrom = '2026-01-01') {
  const load = await send('POST', `/v1/reference-data/${dataset}/versions`, analyst, {
    effectiveFrom,
    source: 'Test fixture (synthetic)',
    entries,
  });
  expect(load.statusCode, load.body).toBe(201);
  const ok = await send(
    'POST',
    `/v1/reference-data/${dataset}/versions/${load.json().id}/decision`,
    compliance,
    {
      decision: 'approve',
      reason: 'Checked against the source.',
    },
  );
  expect(ok.statusCode, ok.body).toBe(200);
  return ok.json();
}

describe('reference data (E16-F01-S02)', () => {
  it('versions a dataset with effective dates and maker-checker approval', async () => {
    const v1 = await send('POST', '/v1/reference-data/us_states/versions', analyst, {
      effectiveFrom: '2026-01-01',
      source: 'Test fixture (synthetic)',
      entries: STATES,
    });
    expect(v1.statusCode, v1.body).toBe(201);
    expect(v1.json()).toMatchObject({ version: 1, status: 'draft', entryCount: 3 });

    // Nothing is in force until someone else approves it.
    expect((await get('/v1/reference-data/us_states/entries?asOf=2026-06-01')).statusCode).toBe(
      404,
    );
    const self = await send(
      'POST',
      `/v1/reference-data/us_states/versions/${v1.json().id}/decision`,
      analyst,
      { decision: 'approve', reason: 'My own load.' },
    );
    expect(self.statusCode).toBe(403);
    const approved = await send(
      'POST',
      `/v1/reference-data/us_states/versions/${v1.json().id}/decision`,
      compliance,
      {
        decision: 'approve',
        reason: 'Matches USPS Publication 28.',
      },
    );
    expect(approved.json()).toMatchObject({
      status: 'approved',
      decidedBy: 'compliance-1',
      effectiveTo: null,
    });

    // A new version cannot start before the one in force.
    const early = await send('POST', '/v1/reference-data/us_states/versions', analyst, {
      effectiveFrom: '2025-12-01',
      source: 'x fixture',
      entries: STATES,
    });
    expect(early.statusCode).toBe(409);

    const v2 = await send('POST', '/v1/reference-data/us_states/versions', analyst, {
      effectiveFrom: '2026-07-01',
      source: 'Test fixture (synthetic)',
      entries: [
        STATES[0],
        { code: 'CA', name: 'California (renamed for the test)', kind: 'state' },
        { code: 'TX', name: 'Texas', kind: 'state' },
      ],
    });
    const detail = await get(`/v1/reference-data/us_states/versions/${v2.json().id}`);
    expect(detail.json().diff).toEqual({
      against: { id: v1.json().id, version: 1 },
      added: ['TX'],
      removed: ['DE'],
      changed: ['CA'],
      unchanged: 1,
    });
    await send(
      'POST',
      `/v1/reference-data/us_states/versions/${v2.json().id}/decision`,
      compliance,
      { decision: 'approve', reason: 'Second version.' },
    );

    const before = await get('/v1/reference-data/us_states/entries?asOf=2026-06-30');
    expect(before.json().version.version).toBe(1);
    expect(before.json().version.effectiveTo).toBe('2026-07-01');
    expect(before.json().items.map((e: { key: string }) => e.key)).toEqual(['CA', 'DE', 'NY']);
    const after = await get('/v1/reference-data/us_states/entries?asOf=2026-07-01');
    expect(after.json().version.version).toBe(2);
    expect(after.json().items.map((e: { key: string }) => e.key)).toEqual(['CA', 'NY', 'TX']);

    const list = await get('/v1/reference-data');
    const states = list.json().items.find((d: { code: string }) => d.code === 'us_states');
    expect(states.inForce).toBeTruthy();
    const segments = list
      .json()
      .items.find((d: { code: string }) => d.code === 'business_segments');
    expect(segments).toMatchObject({ inForce: null, pending: 0 });
  });

  it('rejects a load with any invalid entry and stores nothing', async () => {
    const res = await send('POST', '/v1/reference-data/us_states/versions', analyst, {
      effectiveFrom: '2026-01-01',
      source: 'Test fixture (synthetic)',
      entries: [STATES[0], { code: 'New York', name: 'x', kind: 'state' }, STATES[0]],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().errors.map((e: { field: string }) => e.field)).toEqual([
      'entries[1].code',
      'entries[1].name',
      'entries[2].code',
    ]);
    expect((await get('/v1/reference-data/us_states/versions')).json().items).toEqual([]);
  });

  it('checks codes against the datasets they refer to', async () => {
    const early = await send(
      'POST',
      '/v1/reference-data/prohibited_destinations/versions',
      analyst,
      {
        effectiveFrom: '2026-01-01',
        source: 'Test fixture (synthetic)',
        entries: [{ country: 'ZZ', reason: 'Synthetic test entry' }],
      },
    );
    expect(early.statusCode).toBe(412);
    await loadAndApprove('countries', [
      { code: 'FR', alpha3: 'FRA', numeric: '250', name: 'France' },
      { code: 'JP', alpha3: 'JPN', numeric: '392', name: 'Japan' },
    ]);
    const bad = await send('POST', '/v1/reference-data/prohibited_destinations/versions', analyst, {
      effectiveFrom: '2026-01-01',
      source: 'Test fixture (synthetic)',
      entries: [{ country: 'ZZ', reason: 'Synthetic test entry' }],
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toContain('Unknown country code ZZ');
  });

  it('keeps approved versions unchangeable in the database itself', async () => {
    const v = await loadAndApprove('us_states', STATES);
    const client = await t.pool.connect();
    try {
      await expect(
        client.query(`UPDATE refdata.versions SET source = 'changed' WHERE id = $1`, [v.id]),
      ).rejects.toThrow(/only its end date/);
      await expect(
        client.query(`UPDATE refdata.entries SET data = '{}' WHERE version_id = $1`, [v.id]),
      ).rejects.toThrow(/cannot change/);
      await expect(
        client.query(`DELETE FROM refdata.versions WHERE id = $1`, [v.id]),
      ).rejects.toThrow(/cannot be deleted/);
    } finally {
      client.release();
    }
  });

  it('loads a version from a CSV file, with lists separated by semicolons', async () => {
    await loadAndApprove('countries', [
      { code: 'FR', alpha3: 'FRA', numeric: '250', name: 'France' },
      { code: 'DE', alpha3: 'DEU', numeric: '276', name: 'Germany' },
    ]);
    const csv =
      'code,name,scope,countries\r\nEUR,"Europe, synthetic test region",international,FR;DE\r\n';
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/reference-data/destination_regions/versions/csv?effectiveFrom=2026-02-01&source=Test%20fixture%20(synthetic)',
      headers: { ...bearer(analyst), 'content-type': 'text/csv' },
      payload: csv,
    });
    expect(res.statusCode, res.body).toBe(201);
    const entries = await get(
      `/v1/reference-data/destination_regions/versions/${res.json().id}/entries`,
    );
    expect(entries.json().items).toEqual([
      {
        key: 'EUR',
        data: {
          code: 'EUR',
          name: 'Europe, synthetic test region',
          scope: 'international',
          countries: ['FR', 'DE'],
        },
      },
    ]);
    const broken = await t.app.inject({
      method: 'POST',
      url: '/v1/reference-data/destination_regions/versions/csv?effectiveFrom=2026-03-01&source=Test%20fixture',
      headers: { ...bearer(analyst), 'content-type': 'text/csv' },
      payload: 'code,name\n"unterminated',
    });
    expect(broken.statusCode).toBe(400);
  });

  it('lets staff without refdata:manage read but not load', async () => {
    expect((await get('/v1/reference-data')).statusCode).toBe(200);
    expect(
      (
        await send('POST', '/v1/reference-data/us_states/versions', underwriter, {
          effectiveFrom: '2026-01-01',
          source: 'x fixture',
          entries: STATES,
        })
      ).statusCode,
    ).toBe(403);
  });
});

const SPEC_FORM = [
  'VSC Individual Travel Policy (excerpts quoted in the Astra Travel specification, M1)',
  'You may cancel within the [ten (10) - fifteen (15)] day review period.',
  'Trip Cancellation maximum per person [$0-$5,000,000].',
  'We do not cover travel to <<insert list of countries>>.',
  'Maximum Benefit [PER PERSON] [PER TRIP].',
].join('\n');

async function loadForm(
  body: Buffer | string,
  query: Record<string, string> = {},
  contentType = 'text/plain',
  token = compliance,
) {
  const q = new URLSearchParams({
    formNumber: 'trvl_indv_pol_cw',
    edition: '2026-05',
    title: 'Individual Travel Policy',
    kind: 'policy',
    insurer: 'VSC',
    fileName: 'trvl_indv_pol_cw.txt',
    ...query,
  });
  return t.app.inject({
    method: 'POST',
    url: `/v1/form-editions?${q}`,
    headers: { ...bearer(token), 'content-type': contentType },
    payload: typeof body === 'string' ? Buffer.from(body, 'utf8') : body,
  });
}

describe('form library (E01-F01-S01)', () => {
  it('loads a text edition, keeps the document, and lists its bracketed wording', async () => {
    const res = await loadForm(SPEC_FORM);
    expect(res.statusCode, res.body).toBe(201);
    const ed = res.json();
    expect(ed).toMatchObject({
      formNumber: 'trvl_indv_pol_cw',
      edition: '2026-05',
      kind: 'policy',
      pageCount: 1,
      filings: [],
      currentMap: null,
    });

    const doc = await get(`/v1/form-editions/${ed.id}/document`);
    expect(doc.body).toBe(SPEC_FORM);
    expect(doc.headers['x-content-sha256']).toBe(
      createHash('sha256').update(SPEC_FORM).digest('hex'),
    );

    const brackets = (await get(`/v1/form-editions/${ed.id}/brackets`)).json().items;
    expect(
      brackets.map((b: { text: string; suggestion: { type: string } | null }) => [
        b.text,
        b.suggestion?.type,
      ]),
    ).toEqual([
      ['[ten (10) - fifteen (15)]', 'time_period'],
      ['[$0-$5,000,000]', 'numeric_range'],
      ['<<insert list of countries>>', 'insert_placeholder'],
      ['[PER PERSON] [PER TRIP]', 'limit_basis'],
    ]);
  });

  it('extracts the text of a PDF edition page by page', async () => {
    const res = await loadForm(
      buildPdf(['Schedule page one [$100-$10,000]', 'Page two [cruise][tour][trip]']),
      {
        formNumber: 'trvl_sch_cw',
        edition: '2026-04',
        kind: 'schedule',
        fileName: 'trvl_sch_cw.pdf',
      },
      'application/pdf',
    );
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().pageCount).toBe(2);
    const brackets = (await get(`/v1/form-editions/${res.json().id}/brackets`)).json().items;
    expect(brackets.map((b: { page: number; text: string }) => [b.page, b.text])).toEqual([
      [1, '[$100-$10,000]'],
      [2, '[cruise][tour][trip]'],
    ]);
  });

  it('never replaces an edition and keeps earlier editions', async () => {
    expect((await loadForm(SPEC_FORM)).statusCode).toBe(201);
    const again = await loadForm(`${SPEC_FORM}\n(changed)`);
    expect(again.statusCode).toBe(409);
    expect(again.body).toContain('Editions are never replaced');
    const dup = await loadForm(SPEC_FORM, { edition: '2026-08' });
    expect(dup.statusCode).toBe(409);
    expect(dup.body).toContain('already in the library');
    expect(
      (await loadForm(`${SPEC_FORM}\nEdition 2026-08 (synthetic change)`, { edition: '2026-08' }))
        .statusCode,
    ).toBe(201);
    const list = (await get('/v1/form-editions')).json().items;
    expect(list.map((e: { edition: string }) => e.edition)).toEqual(['2026-08', '2026-05']);
  });

  it('refuses a PDF without readable text', async () => {
    const res = await loadForm(
      Buffer.from('%PDF-1.4 not really'),
      { fileName: 'x.pdf' },
      'application/pdf',
    );
    expect(res.statusCode).toBe(400);
    expect((await get('/v1/form-editions')).json().items).toEqual([]);
  });
});

describe('filing register and approval check (E10-F01-S01, E10-F01-S02, E01-F01-S01)', () => {
  it('needs approved US states before recording filings', async () => {
    const ed = (await loadForm(SPEC_FORM)).json();
    const res = await send('POST', '/v1/filings', compliance, {
      states: ['NY'],
      insurer: 'VSC',
      itemType: 'form_edition',
      itemId: ed.id,
    });
    expect(res.statusCode).toBe(412);
  });

  it('records filings by state and answers whether an edition may be used on a date', async () => {
    await loadAndApprove('us_states', STATES);
    const ed = (await loadForm(SPEC_FORM)).json();
    const created = await send('POST', '/v1/filings', compliance, {
      states: ['NY', 'CA'],
      insurer: 'VSC',
      itemType: 'form_edition',
      itemId: ed.id,
    });
    expect(created.statusCode, created.body).toBe(201);
    const [ca, ny] = created.json().items;
    expect([ca.state, ny.state]).toEqual(['CA', 'NY']);
    expect(ny.itemReference).toBe('trvl_indv_pol_cw ed. 2026-05');

    const usable = async (state: string, date: string) =>
      (await get(`/v1/form-editions/${ed.id}/usability?state=${state}&date=${date}`)).json();
    expect(await usable('NY', '2026-05-01')).toMatchObject({
      usable: false,
      reason: expect.stringContaining('has not been submitted'),
    });
    expect(await usable('TX', '2026-05-01')).toMatchObject({
      usable: false,
      reason: 'No filing is recorded for TX.',
    });

    const status = (id: string, body: Record<string, unknown>) =>
      send('POST', `/v1/filings/${id}/status`, compliance, body);
    expect(
      (
        await status(ny.id, {
          status: 'approved',
          on: '2026-02-01',
          effectiveFrom: '2026-03-01',
          reason: 'Skipping submission.',
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await status(ny.id, {
          status: 'submitted',
          on: '2026-01-10',
          reason: 'Filed through SERFF.',
        })
      ).statusCode,
    ).toBe(200);
    expect(await usable('NY', '2026-05-01')).toMatchObject({
      usable: false,
      reason: expect.stringContaining('awaiting'),
    });
    const approved = await status(ny.id, {
      status: 'approved',
      on: '2026-02-15',
      effectiveFrom: '2026-03-01',
      serffTracking: 'AMSU-134567890',
      reason: 'Approval letter received.',
    });
    expect(approved.json()).toMatchObject({
      status: 'approved',
      effectiveFrom: '2026-03-01',
      serffTracking: 'AMSU-134567890',
    });

    expect(await usable('NY', '2026-02-28')).toMatchObject({
      usable: false,
      reason: 'Approved in NY, but not in effect until 2026-03-01.',
    });
    expect(await usable('NY', '2026-03-01')).toMatchObject({
      usable: true,
      reason: 'Approved in NY from 2026-03-01 (SERFF AMSU-134567890).',
    });
    expect((await usable('CA', '2026-03-01')).usable).toBe(false);

    // A second approval for the same item, state and dates is refused by the database.
    const second = (
      await send('POST', '/v1/filings', compliance, {
        states: ['NY'],
        insurer: 'VSC',
        itemType: 'form_edition',
        itemId: ed.id,
      })
    ).json().items[0];
    await status(second.id, { status: 'submitted', on: '2026-04-01', reason: 'Refiled.' });
    const overlap = await status(second.id, {
      status: 'approved',
      on: '2026-04-10',
      effectiveFrom: '2026-05-01',
      reason: 'Overlapping approval.',
    });
    expect(overlap.statusCode).toBe(409);

    // Withdrawal ends the approval; earlier dates stay covered for policies already sold.
    await status(ny.id, {
      status: 'withdrawn',
      on: '2026-06-01',
      reason: 'Replaced by a new edition.',
    });
    expect((await usable('NY', '2026-05-31')).usable).toBe(true);
    expect(await usable('NY', '2026-06-01')).toMatchObject({
      usable: false,
      reason: 'The approval in NY was withdrawn on 2026-06-01.',
    });

    const history = (await get(`/v1/filings/${ny.id}`)).json().history;
    expect(history.map((h: { toStatus: string }) => h.toStatus)).toEqual([
      'draft',
      'submitted',
      'approved',
      'withdrawn',
    ]);
    expect((await get('/v1/filings?state=NY')).json().items).toHaveLength(2);
  });

  it('records rate manual filings by their reference', async () => {
    await loadAndApprove('us_states', STATES);
    const f = (
      await send('POST', '/v1/filings', compliance, {
        states: ['DE'],
        insurer: 'VSC',
        itemType: 'rate_manual',
        itemReference: 'RETR-SP-VU-DE-0426',
      })
    ).json().items[0];
    await send('POST', `/v1/filings/${f.id}/status`, compliance, {
      status: 'submitted',
      on: '2026-03-01',
      reason: 'Filed.',
    });
    await send('POST', `/v1/filings/${f.id}/status`, compliance, {
      status: 'disapproved',
      on: '2026-04-01',
      reason: 'Objection letter.',
    });
    const a = await get(
      '/v1/filings/approval?itemType=rate_manual&itemReference=RETR-SP-VU-DE-0426&state=DE&date=2026-05-01',
    );
    expect(a.json()).toMatchObject({
      approved: false,
      reason: 'The filing for DE was disapproved.',
    });
  });

  it('keeps filings to compliance staff', async () => {
    expect(
      (
        await send('POST', '/v1/filings', analyst, {
          states: ['NY'],
          insurer: 'VSC',
          itemType: 'rate_manual',
          itemReference: 'X1',
        })
      ).statusCode,
    ).toBe(403);
  });
});

describe('variable maps (E01-F01-S02)', () => {
  it('builds a map from the form text, approved by someone who did not build it', async () => {
    const ed = (await loadForm(SPEC_FORM)).json();
    const brackets = (await get(`/v1/form-editions/${ed.id}/brackets`)).json().items as {
      start: number;
      end: number;
      text: string;
      suggestion: { type: string; constraints: Record<string, unknown> };
    }[];
    const draft = await send('POST', `/v1/form-editions/${ed.id}/maps`, product);
    expect(draft.statusCode, draft.body).toBe(201);
    const mapId = draft.json().id;
    expect((await send('POST', `/v1/form-editions/${ed.id}/maps`, analyst)).statusCode).toBe(409);

    const keys = ['review_period', 'tc_max_per_person', 'prohibited_destinations', 'limit_basis'];
    for (const [i, b] of brackets.entries()) {
      const res = await send(
        'PUT',
        `/v1/variable-maps/${mapId}/variables/${keys[i]}`,
        i === 1 ? analyst : product,
        {
          key: keys[i],
          label: b.text,
          type: b.suggestion.type,
          constraints: b.suggestion.constraints,
          textStart: b.start,
          textEnd: b.end,
          excerpt: b.text,
        },
      );
      expect(res.statusCode, res.body).toBe(200);
    }

    // Every variable must point at real filed wording, within its type's rules.
    const wrong = await send('PUT', `/v1/variable-maps/${mapId}/variables/bad`, product, {
      key: 'bad',
      label: 'Bad',
      type: 'numeric_range',
      constraints: { min: 0, max: 10, unit: 'usd' },
      textStart: 0,
      textEnd: 5,
      excerpt: 'Hello',
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.body).toContain('does not match');
    const inverted = await send('PUT', `/v1/variable-maps/${mapId}/variables/bad`, product, {
      key: 'bad',
      label: 'Bad',
      type: 'numeric_range',
      constraints: { min: 10, max: 0, unit: 'usd' },
      textStart: brackets[1]!.start,
      textEnd: brackets[1]!.end,
      excerpt: brackets[1]!.text,
    });
    expect(inverted.statusCode).toBe(400);
    const dupSpan = await send('PUT', `/v1/variable-maps/${mapId}/variables/again`, product, {
      key: 'again',
      label: 'Again',
      type: 'numeric_range',
      constraints: { min: 0, max: 1, unit: 'usd' },
      textStart: brackets[1]!.start,
      textEnd: brackets[1]!.end,
      excerpt: brackets[1]!.text,
    });
    expect(dupSpan.statusCode).toBe(409);

    // Maker-checker: neither the creator nor any editor may approve.
    expect(
      (await send('POST', `/v1/variable-maps/${mapId}/approve`, product, { note: 'My own map.' }))
        .statusCode,
    ).toBe(403);
    expect(
      (await send('POST', `/v1/variable-maps/${mapId}/approve`, analyst, { note: 'I edited it.' }))
        .statusCode,
    ).toBe(403);
    const approved = await send('POST', `/v1/variable-maps/${mapId}/approve`, compliance, {
      note: 'Checked every variable against the form.',
    });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json()).toMatchObject({
      status: 'approved',
      approvedBy: 'compliance-1',
      version: 1,
    });
    expect(
      approved
        .json()
        .variables.map((v: { key: string; type: string; page: number }) => [v.key, v.type, v.page]),
    ).toEqual([
      ['review_period', 'time_period', 1],
      ['tc_max_per_person', 'numeric_range', 1],
      ['prohibited_destinations', 'insert_placeholder', 1],
      ['limit_basis', 'limit_basis', 1],
    ]);

    // Approved maps never change; a new draft starts from the approved one.
    expect(
      (await send('DELETE', `/v1/variable-maps/${mapId}/variables/review_period`, product))
        .statusCode,
    ).toBe(409);
    const v2 = await send('POST', `/v1/form-editions/${ed.id}/maps`, analyst);
    expect(v2.json()).toMatchObject({ version: 2, status: 'draft' });
    expect(v2.json().variables).toHaveLength(4);
    await send('DELETE', `/v1/variable-maps/${v2.json().id}/variables/limit_basis`, analyst);
    const v2ok = await send('POST', `/v1/variable-maps/${v2.json().id}/approve`, product, {
      note: 'Limit basis moves to the benefit catalogue.',
    });
    expect(v2ok.statusCode, v2ok.body).toBe(200);
    expect((await get(`/v1/variable-maps/${mapId}`)).json().status).toBe('superseded');
    expect((await get(`/v1/form-editions/${ed.id}`)).json().currentMap).toMatchObject({
      version: 2,
      variables: 3,
    });

    const marked = (await get(`/v1/form-editions/${ed.id}/brackets`))
      .json()
      .items.map((b: { mapped: boolean }) => b.mapped);
    expect(marked).toEqual([true, true, true, false]);
  });

  it('only links placeholders to datasets that exist', async () => {
    const ed = (await loadForm(SPEC_FORM)).json();
    const mapId = (await send('POST', `/v1/form-editions/${ed.id}/maps`, product)).json().id;
    const text = (await get(`/v1/form-editions/${ed.id}/text`)).json().text as string;
    const start = text.indexOf('<<insert');
    const excerpt = '<<insert list of countries>>';
    const res = await send('PUT', `/v1/variable-maps/${mapId}/variables/countries`, product, {
      key: 'countries',
      label: 'Countries',
      type: 'insert_placeholder',
      constraints: { source: 'dataset', dataset: 'not_a_dataset' },
      textStart: start,
      textEnd: start + excerpt.length,
      excerpt,
    });
    expect(res.statusCode).toBe(400);
  });
});
