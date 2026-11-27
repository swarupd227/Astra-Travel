/* global process, console, URL */
/* eslint-disable no-console */
// Writes the realm for a development environment in Azure from the local realm, so the two cannot drift apart.
//   node infra/azure/keycloak/make-realm.mjs            writes realm-astra.json beside this file
//   node infra/azure/keycloak/make-realm.mjs --check    fails if the file is out of date
// No secret is written: Keycloak substitutes ${...} from its environment when it imports the realm.
import { readFileSync, writeFileSync } from 'node:fs';

const source = new URL('../../docker/keycloak/realm-astra.json', import.meta.url);
const target = new URL('./realm-astra.json', import.meta.url);

const realm = JSON.parse(readFileSync(source, 'utf8'));

realm.displayName = 'Astra Travel';
realm.sslRequired = 'all';

// Only the workbench signs in. The local sandbox, claims and billing clients are not created: nothing external is
// connected to a development environment, and an unused credential on a public address is only a risk.
realm.clients = realm.clients.filter((c) => ['astra-api', 'astra-workbench'].includes(c.clientId));
const workbench = realm.clients.find((c) => c.clientId === 'astra-workbench');
workbench.rootUrl = '${WORKBENCH_BASE_URL}';
workbench.redirectUris = ['${WORKBENCH_BASE_URL}/api/auth/callback'];
workbench.webOrigins = ['${WORKBENCH_BASE_URL}'];
workbench.attributes['post.logout.redirect.uris'] = '${WORKBENCH_BASE_URL}/signed-out';

// The synthetic staff users. The platform administrator has a password of their own.
realm.users = realm.users.filter((u) => !u.serviceAccountClientId);
for (const user of realm.users) {
  const variable = user.username === 'platform.admin' ? 'ADMIN_USER_PASSWORD' : 'STAFF_PASSWORD';
  user.credentials = [{ type: 'password', value: '${' + variable + '}', temporary: false }];
}

const text = `${JSON.stringify(realm, null, 2)}\n`;
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8').replace(/\r\n/g, '\n') !== text) {
    console.error('infra/azure/keycloak/realm-astra.json is out of date: run make-realm.mjs');
    process.exit(1);
  }
  console.log('The Azure realm is up to date.');
} else {
  writeFileSync(target, text);
  console.log(`Wrote ${realm.users.length} users and ${realm.clients.length} clients.`);
}
