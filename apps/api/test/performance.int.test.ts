/**
 * Increment 18: latency and throughput checks against the specification's targets (section 14), through the API in
 * process, so network time is excluded. Run only when asked, on an otherwise idle machine:
 *
 *   PERF=true npx vitest run --project integration apps/api/test/performance.int.test.ts
 *
 * The numbers describe the machine and the data they were measured on. The test plan has two rated benefits, not the
 * ten of the target, and the quotes use six travellers. Everything is synthetic. This is not a load test of a
 * deployed environment.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, resetDatabase, type TestContext } from './helpers';
import { publishedStack, send, type Stack } from './fixtures';

const enabled = process.env.PERF === 'true';

describe.skipIf(!enabled)('performance against the non-functional targets', () => {
  let t: TestContext;
  let st: Stack;
  let run = 0;

  beforeAll(async () => {
    t = await createTestApp({ RATE_LIMIT_PER_MINUTE: 1_000_000 });
    await resetDatabase();
    st = await publishedStack(t);
  }, 600_000);
  afterAll(async () => t?.close());

  /** Six travellers who are not already covered: a name and date of birth of their own each time. */
  const party = () => {
    run += 1;
    return Array.from({ length: 6 }, (_, i) => ({
      firstName: `Perf${run}x${i}`,
      lastName: `Load${run}`,
      dateOfBirth: `19${60 + (i % 35)}-0${1 + (run % 9)}-1${i}`,
      costPerTraveller: '4200',
    }));
  };
  const quote = () =>
    send(
      t,
      'POST',
      '/v1/quotes',
      st.tokens.partner,
      st.quoteBody({ travellers: party(), selection: ['trip_interruption'] }),
    );

  const percentile = (times: number[], p: number) =>
    [...times].sort((a, b) => a - b)[Math.ceil(times.length * p) - 1]!;
  const report = (name: string, times: number[], target: number) =>
    console.warn(
      `PERF ${name}: n=${times.length} median=${percentile(times, 0.5).toFixed(0)}ms p95=${percentile(times, 0.95).toFixed(0)}ms max=${Math.max(...times).toFixed(0)}ms target(p95)=${target}ms`,
    );
  const timed = async <T>(fn: () => Promise<T>): Promise<[number, T]> => {
    const started = performance.now();
    const out = await fn();
    return [performance.now() - started, out];
  };

  it('quotes six travellers: 95% within 500 ms', async () => {
    for (let i = 0; i < 5; i++) await quote(); // warm-up
    const times: number[] = [];
    for (let i = 0; i < 100; i++) {
      const [ms, res] = await timed(quote);
      expect(res.statusCode, res.body).toBe(201);
      times.push(ms);
    }
    report('quote (6 travellers)', times, 500);
    expect(percentile(times, 0.95)).toBeLessThan(500);
  }, 600_000);

  it('binds and issues: 95% within 1 second, with documents ready within 30 seconds', async () => {
    const binds: number[] = [];
    const ready: number[] = [];
    for (let i = 0; i < 30; i++) {
      const q = (await quote()).json();
      const started = performance.now();
      const [ms, res] = await timed(() =>
        send(
          t,
          'POST',
          `/v1/quotes/${q.id}/bind`,
          st.tokens.partner,
          {
            ableToTravel: true,
            acknowledgement: {
              disclosureVersion: st.disclosureVersion,
              acknowledgedBy: 'Pat Sample',
            },
            payment: { reference: `PERF-${Date.now()}-${i}`, amount: q.premium.total },
            purchaser: { name: 'Pat Sample', email: 'pat@example.com' },
          },
          { 'idempotency-key': `perf-${Date.now()}-${i}` },
        ),
      );
      expect(res.statusCode, res.body).toBe(201);
      binds.push(ms);
      const docs = await send(
        t,
        'GET',
        `/v1/policies/${res.json().id}/documents`,
        st.tokens.partner,
      );
      expect(
        docs.json().items.filter((d: { status: string }) => d.status === 'issued').length,
      ).toBeGreaterThan(0);
      ready.push(performance.now() - started);
    }
    report('bind and issue', binds, 1000);
    report('documents ready after bind', ready, 30_000);
    expect(percentile(binds, 0.95)).toBeLessThan(1000);
    expect(Math.max(...ready)).toBeLessThan(30_000);
  }, 600_000);

  it('finds a policy within 2 seconds', async () => {
    const times: number[] = [];
    for (const q of ['Load1', 'ATP-', 'europe', st.dates.departure]) {
      for (let i = 0; i < 5; i++) {
        const [ms, res] = await timed(() =>
          send(t, 'GET', `/v1/search?q=${encodeURIComponent(q)}`, st.tokens.uw1),
        );
        expect(res.statusCode, res.body).toBe(200);
        times.push(ms);
      }
    }
    report('policy search', times, 2000);
    expect(percentile(times, 0.95)).toBeLessThan(2000);
  }, 300_000);

  it('holds up under concurrent quoting, and reports the rate reached', async () => {
    const seconds = 30;
    const workers = 10;
    const times: number[] = [];
    let failures = 0;
    const until = performance.now() + seconds * 1000;
    await Promise.all(
      Array.from({ length: workers }, async () => {
        while (performance.now() < until) {
          const [ms, res] = await timed(quote);
          if (res.statusCode === 201) times.push(ms);
          else failures += 1;
        }
      }),
    );
    console.warn(
      `PERF concurrent quoting: ${workers} at once for ${seconds}s, ${times.length} quotes (${(times.length / seconds).toFixed(1)}/s), ${failures} failed`,
    );
    report('quote under concurrency', times, 500);
    // No target is set for the peak rate (to be sized in discovery); only that nothing fails.
    expect(failures).toBe(0);
  }, 300_000);
});
