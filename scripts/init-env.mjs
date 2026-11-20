/* global process, console, Buffer */
// Creates .env from .env.example with freshly generated local-only secrets.
// Usage:
//   node scripts/init-env.mjs            create .env if it does not exist
//   node scripts/init-env.mjs --update   add variables that are new in .env.example; keep existing values
//   node scripts/init-env.mjs --force    regenerate everything (rotates every local secret)
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const target = resolve(root, '.env');
const force = process.argv.includes('--force');
const update = process.argv.includes('--update');

if (existsSync(target) && !force && !update) {
  console.log(
    '.env already exists; pass --update to add new variables or --force to regenerate everything.',
  );
  process.exit(0);
}

const existing = new Map();
if (update && existsSync(target)) {
  for (const line of readFileSync(target, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) existing.set(m[1], m[2]);
  }
}

// Ed25519 key pair for agent run tokens, generated once and shared by both variables.
let agentKeys;
function agentKey(part) {
  agentKeys ??= generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return Buffer.from(part === 'private' ? agentKeys.privateKey : agentKeys.publicKey).toString(
    'base64',
  );
}

const template = readFileSync(resolve(root, '.env.example'), 'utf8');
const values = new Map();
const added = [];
const lines = template.split(/\r?\n/).map((line) => {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (!match) return line;
  const [, key, raw] = match;
  let value;
  if (existing.has(key)) {
    value = existing.get(key);
  } else {
    value = raw;
    if (raw === '__GENERATE__') value = randomBytes(24).toString('base64url');
    if (raw === '__GENERATE_BASE64_32__') value = randomBytes(32).toString('base64');
    if (raw === '__GENERATE_ED25519_PRIVATE__') value = agentKey('private');
    if (raw === '__GENERATE_ED25519_PUBLIC__') value = agentKey('public');
    // Expand ${VAR} references to values defined earlier in the file.
    value = value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, ref) => values.get(ref) ?? '');
    if (update) added.push(key);
  }
  values.set(key, value);
  return `${key}=${value}`;
});

// Keep any variables the developer added that the template does not know about.
for (const [key, value] of existing) {
  if (!values.has(key)) lines.push(`${key}=${value}`);
}

writeFileSync(target, lines.join('\n'), { encoding: 'utf8', mode: 0o600 });
console.log(
  update
    ? `Updated .env; added ${added.length ? added.join(', ') : 'nothing new'}.`
    : 'Created .env with generated local secrets.',
);
