/* global process, console, fetch, URLSearchParams */
// Adds what is new in infra/docker/keycloak/realm-astra.json to the running local Keycloak.
// Keycloak imports the realm file only when the realm does not exist yet, so groups and clients added
// in later increments need this (or a fresh Keycloak volume). Existing resources are left unchanged.
// Synthetic users are not synced: they are only created with the realm.
//
//   node --env-file=.env scripts/keycloak-sync.mjs
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = process.env.KEYCLOAK_URL ?? 'http://localhost:8080';
const password = process.env.KEYCLOAK_ADMIN_PASSWORD;
if (!password) {
  console.error('KEYCLOAK_ADMIN_PASSWORD is not set; run with --env-file=.env');
  process.exit(1);
}

const raw = readFileSync(resolve(root, 'infra/docker/keycloak/realm-astra.json'), 'utf8');
const missing = new Set();
const text = raw.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => {
  const value = process.env[name];
  if (value === undefined) missing.add(name);
  return value ?? '';
});
if (missing.size) {
  console.error(
    `Not set in the environment: ${[...missing].join(', ')}. Run node scripts/init-env.mjs --update first.`,
  );
  process.exit(1);
}
const realm = JSON.parse(text);

const tokenRes = await fetch(`${base}/realms/master/protocol/openid-connect/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'password',
    client_id: 'admin-cli',
    username: 'admin',
    password,
  }),
});
if (!tokenRes.ok) {
  console.error(`Could not sign in to Keycloak as admin: ${tokenRes.status}`);
  process.exit(1);
}
const { access_token: token } = await tokenRes.json();

const admin = `${base}/admin/realms/${realm.realm}`;
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
async function call(method, path, body) {
  const res = await fetch(`${admin}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 || res.status === 201 ? null : res.json();
}

const added = [];
const groups = await call('GET', '/groups?briefRepresentation=true&max=1000');
const groupNames = new Set(groups.map((g) => g.name));
for (const group of realm.groups ?? []) {
  if (groupNames.has(group.name)) continue;
  await call('POST', '/groups', group);
  added.push(`group ${group.name}`);
}
for (const client of realm.clients ?? []) {
  const existing = await call('GET', `/clients?clientId=${encodeURIComponent(client.clientId)}`);
  if (existing.length) continue;
  await call('POST', '/clients', client);
  added.push(`client ${client.clientId}`);
}
console.log(
  added.length
    ? `Added: ${added.join(', ')}`
    : 'Keycloak already has everything in the realm file.',
);
