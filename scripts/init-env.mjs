/* global process, console */
// Creates .env from .env.example with freshly generated local-only secrets.
// Usage: node scripts/init-env.mjs [--force]
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const target = resolve(root, '.env');
if (existsSync(target) && !process.argv.includes('--force')) {
  console.log('.env already exists; pass --force to regenerate (this rotates every local secret).');
  process.exit(0);
}

const template = readFileSync(resolve(root, '.env.example'), 'utf8');
const values = new Map();
const lines = template.split(/\r?\n/).map((line) => {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (!match) return line;
  const [, key, raw] = match;
  let value = raw;
  if (raw === '__GENERATE__') value = randomBytes(24).toString('base64url');
  if (raw === '__GENERATE_BASE64_32__') value = randomBytes(32).toString('base64');
  // Expand ${VAR} references to values defined earlier in the file.
  value = value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, ref) => values.get(ref) ?? '');
  values.set(key, value);
  return `${key}=${value}`;
});

writeFileSync(target, lines.join('\n'), { encoding: 'utf8', mode: 0o600 });
console.log('Created .env with generated local secrets.');
