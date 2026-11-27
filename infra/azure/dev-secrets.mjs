/* global process, console, Buffer */
/* eslint-disable no-console */
// Creates the secrets of a development environment once, in var/azure/<environment>.secrets.json (ignored by git and
// by the image build). Running it again keeps what is there and adds only what is missing. Nothing is printed but names.
//   node infra/azure/dev-secrets.mjs dev
import { generateKeyPairSync, randomBytes, randomInt } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const environment = process.argv[2] ?? 'dev';
if (!/^[a-z]+$/.test(environment)) throw new Error('Give an environment name, such as dev.');
const folder = resolve(import.meta.dirname, '../../var/azure');
const file = resolve(folder, `${environment}.secrets.json`);

const LOWER = 'abcdefghijkmnpqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';

/** Letters and digits only, so it needs no escaping in a connection string, with at least one of each kind. */
function password(length = 32) {
  const all = LOWER + UPPER + DIGITS;
  for (;;) {
    const value = Array.from({ length }, () => all[randomInt(all.length)]).join('');
    if ([LOWER, UPPER, DIGITS].every((set) => [...value].some((c) => set.includes(c))))
      return value;
  }
}

const secrets = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
const added = [];
function add(name, value) {
  if (secrets[name]) return;
  secrets[name] = value();
  added.push(name);
}

for (const name of [
  'database-admin-password',
  'database-owner-password',
  'database-app-password',
  'channel-signing-secret',
  'workbench-client-secret',
  'workbench-session-secret',
  'billing-signing-secret',
  'keycloak-db-password',
  'keycloak-admin-password',
])
  add(name, () => password());
// Typed by people at the sign-in page.
add('staff-user-password', () => password(20));
add('admin-user-password', () => password(24));
add('secrets-kek', () => randomBytes(32).toString('base64'));
if (!secrets['agent-token-private-key'] || !secrets['agent-token-public-key']) {
  const keys = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  secrets['agent-token-private-key'] = Buffer.from(keys.privateKey).toString('base64');
  secrets['agent-token-public-key'] = Buffer.from(keys.publicKey).toString('base64');
  added.push('agent-token-private-key', 'agent-token-public-key');
}

mkdirSync(folder, { recursive: true });
writeFileSync(file, `${JSON.stringify(secrets, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
console.log(added.length ? `Added: ${added.join(', ')}.` : 'All secrets already exist.');
