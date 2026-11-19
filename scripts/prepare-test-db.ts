// Applies migrations to the integration-test database (astra_test).
import { resolve } from 'node:path';
import { migrate } from '../packages/platform/src/migrate';

const url = process.env.TEST_DATABASE_OWNER_URL;
if (!url) {
  console.error('TEST_DATABASE_OWNER_URL is not set. Run node scripts/init-env.mjs.');
  process.exit(1);
}
const result = await migrate(url, resolve(import.meta.dirname, '../db/migrations'));
console.log(`Test database ready (${result.applied.length} migrations applied).`);
