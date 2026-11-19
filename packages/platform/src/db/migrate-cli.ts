import { resolve } from 'node:path';
import { migrate } from '../migrate';

const useTestDb = process.argv.includes('--test');
const url = useTestDb ? process.env.TEST_DATABASE_OWNER_URL : process.env.DATABASE_OWNER_URL;
if (!url) {
  console.error(
    `${useTestDb ? 'TEST_DATABASE_OWNER_URL' : 'DATABASE_OWNER_URL'} is not set. Run node scripts/init-env.mjs.`,
  );
  process.exit(1);
}

const dir = process.env.MIGRATIONS_DIR ?? resolve(import.meta.dirname, '../../../../db/migrations');
const result = await migrate(url, dir, (m) => console.log(m));
console.log(
  `Migrations complete: ${result.applied.length} applied, ${result.alreadyApplied} already applied.`,
);
