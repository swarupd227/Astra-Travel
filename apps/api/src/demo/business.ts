/**
 * The business of the sample data: selling accounts and their set-up, card programmes with eligibility feeds, and
 * the quotes, policies, changes, cancellations, referrals and billing batches that make the screens look used.
 */
import { FeedProcessor } from '@astra/card';
import { createLogger, systemContext, withTx } from '@astra/platform';
import { ApiError, type Actor, type Client, type Json } from './client';
import {
  FIRST_NAMES,
  ISSUERS,
  LAST_NAMES,
  SALE_STATES,
  SANCTIONED,
  SELLERS,
  TRIP_DESTINATIONS,
  type SampleAccount,
} from './content';
import { seeded, type Random } from './random';
import { addDays, PEOPLE, today, type Log, type StatePlan } from './setup';

export interface Size {
  policies: number;
  openQuotes: number;
  cardholdersPerProgramme: number;
  concurrency: number;
}

interface Seller extends SampleAccount {
  id: string;
  sellsIn: string[];
}

async function accountList(c: Client): Promise<Json[]> {
  return (await c.call(PEOPLE.accounts, 'GET', '/v1/accounts?limit=200')).items as Json[];
}

async function register(c: Client, code: string, name: string, kind: string): Promise<string> {
  const found = (await accountList(c)).find((a) => a.code === code);
  if (found) return found.id;
  const created = await c.call(PEOPLE.accounts, 'POST', '/v1/accounts', { code, name, kind });
  return created.id as string;
}

/** The rest of the checklist, ending with a test policy in the account's sandbox, and then going live. */
async function goLive(
  c: Client,
  id: string,
  account: SampleAccount,
  sellsIn: string[],
  plans: StatePlan[],
): Promise<void> {
  await c.call(PEOPLE.analyst, 'PUT', `/v1/accounts/${id}/collected-variables`, {
    notCollected: [],
    reason: 'The sample booking path collects every rating variable.',
  });
  await c.call(PEOPLE.accounts, 'POST', `/v1/accounts/${id}/sandbox`, undefined, { allow: [409] });
  const sandbox = await c.call(PEOPLE.accounts, 'GET', `/v1/accounts/${id}/sandbox`);
  if (!sandbox.policies) {
    const state = sellsIn[0]!;
    const bought = today();
    const quote = await c.call(PEOPLE.accounts, 'POST', '/v1/quotes', {
      accountId: sandbox.accountId,
      planCode: plans.find((p) => p.state === state && p.tier === 'essential')!.code,
      state,
      travellers: [
        {
          firstName: 'Sandbox',
          lastName: `Check ${account.code}`,
          dateOfBirth: '1984-04-12',
          costPerTraveller: '1800',
        },
      ],
      trip: {
        purchaseDate: bought,
        initialDepositDate: bought,
        departureDate: addDays(bought, 30),
        returnDate: addDays(bought, 37),
        destinations: [{ country: 'MX', region: 'Canada and Mexico' }],
      },
    });
    await c.call(PEOPLE.accounts, 'POST', `/v1/quotes/${quote.id}/bind`, {
      ableToTravel: true,
      acknowledgement: {
        disclosureVersion: quote.disclosure?.version,
        acknowledgedBy: 'Sandbox Check',
      },
      payment: { reference: `SBX-${quote.id.slice(0, 13)}`, amount: quote.premium.total },
      purchaser: { name: 'Sandbox Check' },
    });
  }
  await c.call(PEOPLE.accounts, 'POST', `/v1/accounts/${id}/go-live`, {
    note: 'Checklist complete and the sandbox test passed.',
  });
}

async function sellers(c: Client, log: Log, rnd: Random, plans: StatePlan[]): Promise<Seller[]> {
  const out: Seller[] = [];
  for (const [index, account] of SELLERS.entries()) {
    const states = SALE_STATES.map(([s]) => s);
    // A stable choice of states per account, so a second run agrees with the first.
    const sellsIn = states.filter((_, i) => (i + index) % states.length < account.states);
    const existing = (await accountList(c)).find((a) => a.code === account.code);
    if (existing && existing.status === 'active') {
      out.push({ ...account, id: existing.id, sellsIn });
      continue;
    }
    const id = await register(c, account.code, account.name, account.kind);
    // Two accounts are left part-way through onboarding, to show the checklist.
    const finished = index < SELLERS.length - 2;
    await c.call(PEOPLE.accounts, 'PUT', `/v1/accounts/${id}/profile`, {
      contractReference: `SMP-${2026}-${String(index + 1).padStart(4, '0')}`,
      contractSignedOn: addDays('2025-09-01', index * 6),
      states: sellsIn,
      plans: plans.filter((p) => sellsIn.includes(p.state)).map((p) => p.code),
      integrationMethod: account.integration,
      ...(finished
        ? {
            rateBasis: { basis: 'per_policy' },
            settlement: {
              description: 'Monthly statement; premium remitted net of commission (sample terms).',
              paymentDays: rnd.pick([15, 30, 45]),
            },
          }
        : {}),
    });
    for (const [i, state] of sellsIn.entries()) {
      // A few licences run out soon, to raise their alerts.
      const soon = i === 0 && index % 5 === 0;
      await c.call(
        PEOPLE.compliance,
        'POST',
        `/v1/accounts/${id}/licences`,
        {
          kind: index % 3 === 0 ? 'producer_licence' : 'retailer_registration',
          state,
          number: `SMP-${state}-${String(index + 1).padStart(3, '0')}${i}`,
          holder: account.name,
          validFrom: '2025-01-01',
          expiresOn: soon ? addDays(today(), rnd.int(18, 55)) : addDays(today(), rnd.int(200, 700)),
        },
        { allow: [409] },
      );
    }
    const change = await c.call(
      PEOPLE.accounts,
      'POST',
      `/v1/accounts/${id}/segment-changes`,
      { segment: account.segment, effectiveFrom: '2026-01-01', reason: 'Per the sample contract.' },
      { allow: [409] },
    );
    // The last account's segment is left waiting for an underwriter.
    if (change.id && index < SELLERS.length - 1) {
      await c.call(PEOPLE.uw1, 'POST', `/v1/segment-changes/${change.id}/decision`, {
        decision: 'approve',
        note: 'Matches the sample list and contract.',
      });
    }
    const document =
      index % 4 === 0
        ? {
            kind: 'tiered',
            tiers: [
              { upTo: 25000, percent: 22 },
              { upTo: null, percent: 28 },
            ],
          }
        : { kind: 'flat', percent: 18 + (index % 6) * 2 };
    const rule = await c.call(
      PEOPLE.finance,
      'POST',
      '/v1/commission-rules',
      { accountId: id, effectiveFrom: '2026-01-01', document },
      { allow: [409] },
    );
    if (rule.id) {
      await c.call(
        PEOPLE.compliance,
        'POST',
        `/v1/commission-rules/${rule.id}/approve`,
        { note: 'Matches the sample contract.' },
        { allow: [409] },
      );
    }
    if (finished) await goLive(c, id, account, sellsIn, plans);
    out.push({ ...account, id, sellsIn });
    log(`account ${account.code}: set up`);
  }
  return out;
}

// ---------------- Card-linked cover ----------------

async function processFeeds(c: Client, processor: FeedProcessor): Promise<void> {
  for (;;) {
    const id = await processor.claimNext();
    if (!id) return;
    await processor.process(id);
  }
}

async function feedSettled(
  c: Client,
  processor: FeedProcessor,
  programmeId: string,
  feedId: string,
): Promise<Json> {
  const until = Date.now() + 20 * 60_000;
  for (;;) {
    await processFeeds(c, processor);
    const feed = await c.call(
      PEOPLE.card,
      'GET',
      `/v1/card-programmes/${programmeId}/feeds/${feedId}`,
    );
    if (!['received', 'processing', 'validating', 'waiting'].includes(feed.status)) return feed;
    if (Date.now() > until) throw new Error(`Feed ${feedId} is still ${feed.status}`);
    // The worker may have claimed it first.
    await new Promise((done) => setTimeout(done, 3_000));
  }
}

function feedFile(code: string, sequence: number, asOf: string, records: string[]): Buffer {
  return Buffer.from(
    [
      `H|ASTRA-ELIG|1|${code}|${sequence}|FULL|${asOf}`,
      ...records,
      `T|${records.length}|${records.length}|0|0`,
      '',
    ].join('\n'),
  );
}

async function cardProgrammes(c: Client, log: Log, rnd: Random, size: Size): Promise<void> {
  const processor = new FeedProcessor(c.pool, c.files, createLogger('sample-feeds', 'fatal'));
  let n = 0;
  for (const issuer of ISSUERS) {
    const accountId = await register(c, issuer.code, issuer.name, issuer.kind);
    for (const [code, name, product] of issuer.products) {
      n += 1;
      const held = ((await c.call(PEOPLE.card, 'GET', '/v1/card-programmes')).items as Json[]).find(
        (p) => p.code === code,
      );
      if (held && held.status === 'live' && held.accountsOnFile > 0) continue;
      const states = SALE_STATES.map(([s]) => s);
      let programme = held;
      if (!programme) {
        const master = await c.call(PEOPLE.card, 'POST', '/v1/master-policies', {
          accountId,
          policyNumber: `MP-SMP-${String(n).padStart(3, '0')}`,
          underwriter: n % 2 ? 'VSC' : 'ABIC',
          states,
          effectiveFrom: '2025-01-01',
        });
        programme = await c.call(PEOPLE.card, 'POST', '/v1/card-programmes', {
          masterPolicyId: master.id,
          code,
          name,
          cardProduct: product,
          states,
          effectiveFrom: '2025-01-01',
          paymentCondition:
            n % 3 === 0 ? { rule: 'none' } : { rule: 'partial', minimumPercent: 50 },
          eligibilityRule: 'purchase_date',
          maxRejectPercent: 5,
        });
      }
      const upload = (mode: 'test' | 'live', body: Buffer) =>
        c.call(
          PEOPLE.card,
          'POST',
          `/v1/card-programmes/${programme!.id}/feeds?mode=${mode}&fileName=${code}-${mode}.txt`,
          body,
          { contentType: 'application/octet-stream' },
        );
      if (programme.status !== 'live') {
        const test = await upload(
          'test',
          feedFile(code, 1, '2026-01-01', [`D|tok_${n}_test|STD|A|2025-01-01|`]),
        );
        await feedSettled(c, processor, programme.id, test.id);
        await c.call(PEOPLE.card, 'POST', `/v1/card-programmes/${programme.id}/go-live`, {
          reason: 'Sample test feed passed.',
        });
      }
      const members = Math.round(size.cardholdersPerProgramme * (1 - (n - 1) * 0.12));
      const records = Array.from({ length: members }, (_, i) => {
        const opened = addDays('2021-01-01', (i * 7 + n * 13) % 1800);
        return `D|tok_${n}_${String(i).padStart(7, '0')}|${i % 9 === 0 ? 'PLUS' : 'STD'}|A|${opened}|`;
      });
      const live = await upload('live', feedFile(code, 1, addDays(today(), -1), records));
      const done = await feedSettled(c, processor, programme.id, live.id);
      log(`card programme ${code}: ${done.status}, ${members} cardholders`);
      const rule = await c.call(
        PEOPLE.finance,
        'POST',
        '/v1/programme-premium-rules',
        { programmeId: programme.id, effectiveFrom: '2026-01-01', rate: `0.${35 + n * 5}00` },
        { allow: [409] },
      );
      if (rule.id) {
        await c.call(
          PEOPLE.compliance,
          'POST',
          `/v1/programme-premium-rules/${rule.id}/approve`,
          { note: 'Matches the sample agreement.' },
          { allow: [409] },
        );
      }
      for (let i = 0; i < 25; i++) {
        await c.call(
          PEOPLE.service,
          'POST',
          `/v1/card-programmes/${programme.id}/eligibility-checks`,
          {
            accountRef: `tok_${n}_${String(rnd.int(0, members + 200)).padStart(7, '0')}`,
            date: addDays(today(), -rnd.int(0, 60)),
          },
        );
      }
    }
  }
}

// ---------------- Quotes and policies ----------------

interface Draft {
  seller: Seller;
  actor: Actor;
  body: Record<string, unknown>;
  lead: string;
  email: string | null;
}

function draft(
  rnd: Random,
  all: Seller[],
  plans: StatePlan[],
  index: number,
  special: 'none' | 'high_cost' | 'sanctions',
): Draft {
  const seller = rnd.weighted(all, (s) => s.weight);
  const state = rnd.pick(seller.sellsIn);
  const tier = rnd.chance(seller.segment === 'RETAIL_LUXURY' ? 0.8 : 0.4)
    ? 'preferred'
    : 'essential';
  const plan = plans.find((p) => p.state === state && p.tier === tier)!;
  // More sales in recent weeks than five months ago.
  const purchaseDate = rnd.chance(0.06)
    ? today()
    : addDays(today(), -rnd.int(1, 14) - Math.floor(136 * rnd.next() ** 1.6));
  // A policy bound now covers a trip still to come, however long ago the purchase date it carries.
  const planned = addDays(purchaseDate, rnd.int(6, 170));
  const earliest = addDays(today(), rnd.int(2, 150));
  const departureDate = planned > earliest ? planned : earliest;
  const cruise = seller.segment.includes('CRUISE');
  const length = rnd.chance(0.06) ? rnd.int(22, 70) : cruise ? rnd.int(6, 15) : rnd.int(3, 14);
  const [country, region] = rnd.weighted(TRIP_DESTINATIONS, (d) => d[2]);
  const count = rnd.weighted([1, 2, 3, 4, 5], (k) => [38, 42, 8, 9, 3][k - 1]!);
  const family = rnd.pick(LAST_NAMES);
  const typical =
    (cruise ? 3200 : country === 'US' ? 1100 : 2600) * (tier === 'preferred' ? 1.5 : 1);
  const travellers = Array.from({ length: count }, (_, i) => {
    const age = i < 2 ? rnd.int(24, 79) : rnd.int(3, 22);
    const firstName =
      special === 'sanctions' && i === 0 ? SANCTIONED.firstName : rnd.pick(FIRST_NAMES);
    const lastName =
      special === 'sanctions' && i === 0
        ? SANCTIONED.lastName
        : count > 1 && rnd.chance(0.8)
          ? family
          : rnd.pick(LAST_NAMES);
    const cost =
      special === 'high_cost' && i === 0
        ? rnd.int(12500, 19000)
        : Math.min(11500, Math.round((typical * (0.5 + rnd.next() * 1.4)) / 25) * 25);
    return {
      firstName,
      lastName,
      dateOfBirth:
        special === 'sanctions' && i === 0
          ? SANCTIONED.dateOfBirth
          : addDays(purchaseDate, -(age * 365 + rnd.int(10, 350))),
      costPerTraveller: String(cost),
    };
  });
  const optional =
    tier === 'preferred'
      ? ['baggage_loss', 'emergency_medical']
      : ['trip_interruption', 'baggage_loss', 'emergency_medical', 'missed_connection'];
  const partner = seller.integration !== 'files' && rnd.chance(0.85);
  const lead = `${travellers[0]!.firstName} ${travellers[0]!.lastName}`;
  return {
    seller,
    actor: partner
      ? {
          role: 'partner_developer',
          sub: `sample-svc-${seller.code.toLowerCase()}`,
          name: `${seller.name} integration`,
          accountId: seller.id,
        }
      : PEOPLE.service,
    body: {
      accountId: seller.id,
      planCode: plan.code,
      state,
      travellers,
      trip: {
        purchaseDate,
        // The pre-existing condition waiver depends on buying soon after the first deposit, judged again at bind.
        // A sale loaded with an earlier purchase date therefore has its deposit well before that window.
        initialDepositDate: addDays(
          purchaseDate,
          purchaseDate === today() ? -rnd.int(0, 8) : -rnd.int(30, 75),
        ),
        departureDate,
        returnDate: addDays(departureDate, length - 1),
        destinations: [{ country, region }],
      },
      selection: optional.filter(() => rnd.chance(0.35)),
    },
    lead,
    // A few have an email address: with no mail server their delivery fails and reaches the work queue.
    email: index % 160 === 7 ? `traveller${index}@example.com` : null,
  };
}

async function pool<T>(items: T[], width: number, work: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (next < items.length) await work(items[next++]!);
    }),
  );
}

export interface Sold {
  id: string;
  departureDate: string;
  travellers: { id: string; costPerTraveller: string }[];
}

async function counts(c: Client) {
  return withTx(c.pool, systemContext('sample-data'), async (tx) => {
    const { rows } = await tx.query<{ policies: string; quotes: string }>(
      `SELECT (SELECT count(*) FROM policies.policies p JOIN platform.accounts a ON a.id = p.account_id
                 WHERE NOT a.sandbox) AS policies,
              (SELECT count(*) FROM policies.quotes q JOIN platform.accounts a ON a.id = q.account_id
                 WHERE NOT a.sandbox) AS quotes`,
    );
    return { policies: Number(rows[0]!.policies), quotes: Number(rows[0]!.quotes) };
  });
}

async function sales(
  c: Client,
  log: Log,
  rnd: Random,
  all: Seller[],
  plans: StatePlan[],
  size: Size,
): Promise<Sold[]> {
  const before = await counts(c);
  const toBind = Math.max(0, size.policies - before.policies);
  const toLeave = Math.max(0, size.openQuotes - (before.quotes - before.policies));
  // A run that carries on draws new trips, not the ones an earlier run already sold.
  const trips = before.quotes > 100 ? seeded(20261127 + before.quotes) : rnd;
  const jobs = Array.from({ length: toBind + toLeave }, (_, i) => {
    const bind = i % Math.max(1, Math.round((toBind + toLeave) / Math.max(1, toLeave))) !== 0;
    const special = i % 40 === 3 ? 'high_cost' : i % 400 === 11 ? 'sanctions' : 'none';
    return {
      bind: bind || toLeave === 0,
      draft: draft(trips, all, plans, i + before.quotes, special),
    };
  });
  const sold: Sold[] = [];
  const refused = new Map<string, number>();
  let done = 0;
  let quoted = 0;
  await pool(jobs, size.concurrency, async ({ bind, draft: d }) => {
    try {
      const quote = await c.call(d.actor, 'POST', '/v1/quotes', d.body);
      quoted += 1;
      if (bind) {
        const policy = await c.call(d.actor, 'POST', `/v1/quotes/${quote.id}/bind`, {
          ableToTravel: true,
          acknowledgement: {
            disclosureVersion: quote.disclosure?.version,
            acknowledgedBy: d.lead,
          },
          payment: { reference: `SMP-PAY-${quote.id.slice(0, 13)}`, amount: quote.premium.total },
          purchaser: { name: d.lead, ...(d.email ? { email: d.email } : {}) },
        });
        sold.push({
          id: policy.id,
          departureDate: policy.record.trip.departureDate,
          travellers: policy.record.travellers,
        });
      }
    } catch (err) {
      if (!(err instanceof ApiError) || err.status >= 500) throw err;
      // Referred, held or ineligible cases are part of the picture; they are counted by reason.
      const reason = `${err.status} ${/"detail":"([^"]{0,90})/.exec(err.message)?.[1] ?? err.message.slice(0, 120)}`;
      refused.set(reason, (refused.get(reason) ?? 0) + 1);
    }
    done += 1;
    if (done % 100 === 0) log(`sales: ${done}/${jobs.length} (${sold.length} policies)`);
  });
  log(`sales: ${quoted} quotes, ${sold.length} policies`);
  const reasons = [...refused.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  for (const [reason, n] of reasons) log(`  not completed ${n}× ${reason}`);
  if (jobs.length > 20 && sold.length < toBind * 0.6) {
    throw new Error('Far fewer policies were bound than asked for: see the reasons above.');
  }
  return sold;
}

async function servicing(c: Client, log: Log, rnd: Random, sold: Sold[], size: Size) {
  const future = sold.filter((p) => p.departureDate > addDays(today(), 12));
  const made = new Map<string, number>();
  await pool(future, size.concurrency, async (policy) => {
    const roll = rnd.next();
    const request =
      roll < 0.07
        ? { type: 'cancel', reason: 'The traveller can no longer travel.', noLoss: true }
        : roll < 0.15
          ? {
              type: 'change_cost',
              reason: 'The traveller added to the booking.',
              costs: [
                {
                  travellerId: policy.travellers[0]!.id,
                  costPerTraveller: String(
                    Math.min(
                      11900,
                      Math.round(Number(policy.travellers[0]!.costPerTraveller) * 1.15),
                    ),
                  ),
                },
              ],
            }
          : roll < 0.19
            ? {
                type: 'change_dates',
                reason: 'The booking moved.',
                departureDate: addDays(policy.departureDate, 3),
                returnDate: addDays(policy.departureDate, 11),
              }
            : null;
    if (!request) return;
    try {
      const url = `/v1/policies/${policy.id}/servicing`;
      const preview = await c.call(PEOPLE.service, 'POST', `${url}/preview`, request);
      if (!preview.allowed) return;
      await c.call(PEOPLE.service, 'POST', url, { request, confirmAmount: preview.confirmAmount });
      made.set(request.type, (made.get(request.type) ?? 0) + 1);
    } catch (err) {
      if (!(err instanceof ApiError) || err.status >= 500) throw err;
    }
  });
  log(`servicing: ${JSON.stringify(Object.fromEntries(made))}`);
}

/** Underwriters decide about two thirds of the referrals; the rest wait in the queue. */
async function referrals(c: Client, log: Log) {
  const open = (await c.call(PEOPLE.uw1, 'GET', '/v1/referrals?status=open&limit=200'))
    .items as Json[];
  let decided = 0;
  for (const [i, r] of open.entries()) {
    if (i % 3 === 0 || open.length < 4) continue;
    const decline = i % 7 === 0;
    await c.call(
      i % 2 ? PEOPLE.uw1 : PEOPLE.uw2,
      'POST',
      `/v1/referrals/${r.id}/decision`,
      {
        decision: decline ? 'declined' : 'approved',
        reason: decline
          ? 'The trip cost cannot be verified against the booking.'
          : 'Booking confirmation supports the trip cost.',
      },
      { allow: [409] },
    );
    decided += 1;
  }
  log(`referrals: ${open.length} raised, ${decided} decided`);
}

async function billing(c: Client, log: Log) {
  let batches = 0;
  for (let i = 0; i < 12; i++) {
    const made = await c.call(PEOPLE.finance, 'POST', '/v1/billing/batches', {}, { allow: [409] });
    // A new batch is answered as itself; `batch: null` means nothing is left to send.
    if (made.batch === null || !made.id) break;
    batches += 1;
  }
  log(`billing: ${batches} batches queued for the billing system`);
}

export async function runBusiness(
  c: Client,
  log: Log,
  rnd: Random,
  plans: StatePlan[],
  size: Size,
): Promise<void> {
  const all = await sellers(c, log, rnd, plans);
  // Accounts still onboarding do not sell.
  const selling = all.slice(0, all.length - 2);
  await cardProgrammes(c, log, rnd, size);
  const sold = await sales(c, log, rnd, selling, plans, size);
  await servicing(c, log, rnd, sold, size);
  await referrals(c, log);
  await billing(c, log);
}
