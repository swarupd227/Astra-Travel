// Loads the public reference datasets as draft versions: US states, the District of Columbia and the
// five inhabited territories (USPS Publication 28, data/reference/us_states.csv) and ISO 3166-1 countries
// (from the i18n-iso-countries package). Drafts take effect only when a person approves them in the
// workbench (Reference data), as with any other version.
//
//   node --env-file=.env --import tsx scripts/load-public-refdata.ts [effective-from=today]
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import countries from 'i18n-iso-countries';
import type { RefdataDataset } from '@astra/contracts';
import { AppError, createPool, systemContext, withTx } from '@astra/platform';
import { coerceRow, loadVersion, parseCsv } from '@astra/studio';

const require = createRequire(import.meta.url);
const effectiveFrom = process.argv[2] ?? new Date().toISOString().slice(0, 10);
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

const isoVersion = (require('i18n-iso-countries/package.json') as { version: string }).version;
countries.registerLocale(require('i18n-iso-countries/langs/en.json'));

const states = parseCsv(
  readFileSync(resolve(import.meta.dirname, '../data/reference/us_states.csv'), 'utf8'),
).map((r) => coerceRow('us_states', r));
// XK (Kosovo) is a user-assigned code, not part of ISO 3166-1; it is added by Assurant if needed.
const countryEntries = Object.entries(countries.getAlpha2Codes())
  .filter(([alpha2]) => alpha2 !== 'XK')
  .map(([alpha2, alpha3]) => ({
    code: alpha2,
    alpha3,
    numeric: countries.alpha2ToNumeric(alpha2)!,
    name: countries.getName(alpha2, 'en')!,
  }));

const loads: { dataset: RefdataDataset; source: string; entries: Record<string, unknown>[] }[] = [
  {
    dataset: 'us_states',
    source: 'USPS Publication 28, Appendix B (states, DC and the five inhabited territories)',
    entries: states,
  },
  {
    dataset: 'countries',
    source: `ISO 3166-1, from i18n-iso-countries ${isoVersion} (English short names)`,
    entries: countryEntries,
  },
];

const pool = createPool(url, { max: 1, applicationName: 'astra-refdata-loader' });
const ctx = systemContext('refdata-loader');
try {
  for (const l of loads) {
    try {
      const v = await withTx(pool, ctx, async (tx) => {
        const same = await tx.query<{ version: number; status: string }>(
          `SELECT v.version, v.status FROM refdata.versions v
            WHERE v.dataset = $1 AND v.status IN ('draft', 'approved') ORDER BY v.version DESC LIMIT 1`,
          [l.dataset],
        );
        if (same.rows[0]?.status === 'draft')
          return { skipped: `version ${same.rows[0].version} is already waiting for approval` };
        return loadVersion(tx, ctx, l.dataset, {
          effectiveFrom,
          source: l.source,
          entries: l.entries,
        });
      });
      if ('skipped' in v) console.log(`${l.dataset}: skipped, ${v.skipped}`);
      else
        console.log(
          `${l.dataset}: version ${v.version} loaded as a draft (${v.entry_count} entries, effective ${v.effective_from})`,
        );
    } catch (err) {
      if (err instanceof AppError)
        console.log(`${l.dataset}: not loaded: ${err.detail ?? err.message}`);
      else throw err;
    }
  }
  console.log(
    'Approve the drafts in the workbench (Reference data). The approver must be someone other than the loader.',
  );
} finally {
  await pool.end();
}
