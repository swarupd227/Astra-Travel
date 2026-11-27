// The container apps environment, the API, worker and workbench, and the job that applies database migrations.
// Every secret is read from the key vault with the applications' managed identity.
param location string
param name string
param environmentId string
@description('The name of the file share storage registered on the environment.')
param environmentStorageName string
param identityId string
param registryServer string
param imageTag string
param vaultUri string
param minReplicas int
@description('The fewest API copies; defaults to minReplicas.')
param apiMinReplicas int
param maxReplicas int
@description('Processor cores and memory of each API, worker and workbench copy.')
param serviceCpu string
param serviceMemory string
@description('Whether a model API key and a mail server are supplied as secrets. The model key can also be set in the app.')
param hasAnthropicKey bool
param hasSmtp bool
@description('Identity provider: the issuer, the API audience and the group to role map as JSON (may be empty).')
param oidcIssuer string
param oidcAudience string
param oidcGroupRoleMap string
param workbenchClientId string
@description('The public addresses people and partners use.')
param apiPublicUrl string
param workbenchPublicUrl string
param mailFrom string
param tags object

var identity = { type: 'UserAssigned', userAssignedIdentities: { '${identityId}': {} } }
var registries = [{ server: registryServer, identity: identityId }]
var optionalSecrets = concat(
  hasAnthropicKey ? ['anthropic-api-key'] : [],
  hasSmtp ? ['smtp-url'] : []
)
var secretFrom = map(
  concat([
    'database-url'
    'database-owner-url'
    'secrets-kek'
    'channel-signing-secret'
    'agent-token-public-key'
    'agent-token-private-key'
    'workbench-client-secret'
    'workbench-session-secret'
    'billing-signing-secret'
  ], optionalSecrets),
  s => { name: s, keyVaultUrl: '${vaultUri}secrets/${s}', identity: identityId }
)
var volumes = [{ name: 'files', storageType: 'AzureFile', storageName: environmentStorageName }]
var mounts = [{ volumeName: 'files', mountPath: '/data' }]
var common = [
  { name: 'NODE_ENV', value: 'production' }
  { name: 'LOG_LEVEL', value: 'info' }
]
func secretsNamed(all array, wanted array) array => filter(all, s => contains(wanted, s.name))

resource api 'Microsoft.App/containerApps@2025-01-01' = {
  name: '${name}-api'
  location: location
  tags: tags
  identity: identity
  properties: {
    environmentId: environmentId
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      registries: registries
      secrets: secretsNamed(secretFrom, ['database-url', 'secrets-kek', 'channel-signing-secret', 'agent-token-public-key'])
      ingress: { external: true, targetPort: 4000, transport: 'auto', allowInsecure: false }
    }
    template: {
      volumes: volumes
      containers: [
        {
          name: 'api'
          image: '${registryServer}/astra-api:${imageTag}'
          resources: { cpu: json(serviceCpu), memory: serviceMemory }
          volumeMounts: mounts
          env: concat(common, [
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'SECRETS_KEK_ID', value: 'kv-1' }
            { name: 'SECRETS_KEK', secretRef: 'secrets-kek' }
            { name: 'CHANNEL_SIGNING_SECRET', secretRef: 'channel-signing-secret' }
            { name: 'AGENT_TOKEN_PUBLIC_KEY', secretRef: 'agent-token-public-key' }
            { name: 'OIDC_ISSUER', value: oidcIssuer }
            { name: 'OIDC_AUDIENCE', value: oidcAudience }
            { name: 'OIDC_GROUP_ROLE_MAP', value: oidcGroupRoleMap }
            { name: 'CORS_ORIGINS', value: workbenchPublicUrl }
            { name: 'PUBLIC_API_URL', value: apiPublicUrl }
            { name: 'FILE_STORE_DIR', value: '/data' }
          ])
          probes: [
            { type: 'Liveness', httpGet: { path: '/health/live', port: 4000 }, periodSeconds: 15 }
            { type: 'Readiness', httpGet: { path: '/health/ready', port: 4000 }, periodSeconds: 10 }
            { type: 'Startup', httpGet: { path: '/health/live', port: 4000 }, periodSeconds: 10, failureThreshold: 10 }
          ]
        }
      ]
      scale: {
        minReplicas: apiMinReplicas
        maxReplicas: maxReplicas
        rules: [{ name: 'requests', http: { metadata: { concurrentRequests: '50' } } }]
      }
    }
  }
}

resource worker 'Microsoft.App/containerApps@2025-01-01' = {
  name: '${name}-worker'
  location: location
  tags: tags
  identity: identity
  properties: {
    environmentId: environmentId
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      registries: registries
      secrets: secretsNamed(secretFrom, concat(['database-url', 'secrets-kek', 'agent-token-private-key', 'billing-signing-secret'], optionalSecrets))
    }
    template: {
      volumes: volumes
      containers: [
        {
          name: 'worker'
          image: '${registryServer}/astra-worker:${imageTag}'
          resources: { cpu: json(serviceCpu), memory: serviceMemory }
          volumeMounts: mounts
          env: concat(common, [
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'SECRETS_KEK_ID', value: 'kv-1' }
            { name: 'SECRETS_KEK', secretRef: 'secrets-kek' }
            { name: 'AGENT_TOKEN_PRIVATE_KEY', secretRef: 'agent-token-private-key' }
            { name: 'API_BASE_URL', value: 'https://${api.properties.configuration.ingress.fqdn}' }
            { name: 'OIDC_AUDIENCE', value: oidcAudience }
            { name: 'FILE_STORE_DIR', value: '/data' }
            { name: 'BILLING_DROP_DIR', value: '/data/billing-outbox' }
          ], hasAnthropicKey ? [{ name: 'ANTHROPIC_API_KEY', secretRef: 'anthropic-api-key' }] : [], hasSmtp ? [
            { name: 'SMTP_URL', secretRef: 'smtp-url' }
            { name: 'MAIL_FROM', value: mailFrom }
          ] : [])
          probes: [
            { type: 'Liveness', httpGet: { path: '/health/live', port: 4100 }, periodSeconds: 15 }
            { type: 'Readiness', httpGet: { path: '/health/ready', port: 4100 }, periodSeconds: 10 }
          ]
        }
      ]
      // Background work is claimed with database locks, so more than one copy is safe.
      scale: { minReplicas: max(minReplicas, 1), maxReplicas: max(minReplicas, 2) }
    }
  }
}

resource workbench 'Microsoft.App/containerApps@2025-01-01' = {
  name: '${name}-workbench'
  location: location
  tags: tags
  identity: identity
  properties: {
    environmentId: environmentId
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      registries: registries
      secrets: secretsNamed(secretFrom, ['workbench-client-secret', 'workbench-session-secret', 'channel-signing-secret'])
      ingress: { external: true, targetPort: 3000, transport: 'auto', allowInsecure: false }
    }
    template: {
      containers: [
        {
          name: 'workbench'
          image: '${registryServer}/astra-workbench:${imageTag}'
          resources: { cpu: json(serviceCpu), memory: serviceMemory }
          env: concat(common, [
            { name: 'OIDC_ISSUER', value: oidcIssuer }
            { name: 'WORKBENCH_CLIENT_ID', value: workbenchClientId }
            { name: 'WORKBENCH_CLIENT_SECRET', secretRef: 'workbench-client-secret' }
            { name: 'WORKBENCH_SESSION_SECRET', secretRef: 'workbench-session-secret' }
            { name: 'WORKBENCH_BASE_URL', value: workbenchPublicUrl }
            { name: 'API_BASE_URL', value: 'https://${api.properties.configuration.ingress.fqdn}' }
            { name: 'CHANNEL_SIGNING_SECRET', secretRef: 'channel-signing-secret' }
          ])
          probes: [{ type: 'Readiness', tcpSocket: { port: 3000 }, periodSeconds: 10 }]
        }
      ]
      scale: { minReplicas: minReplicas, maxReplicas: maxReplicas }
    }
  }
}

resource migrate 'Microsoft.App/jobs@2025-01-01' = {
  name: '${name}-migrate'
  location: location
  tags: tags
  identity: identity
  properties: {
    environmentId: environmentId
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 1800
      replicaRetryLimit: 0
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      registries: registries
      secrets: secretsNamed(secretFrom, ['database-owner-url'])
    }
    template: {
      containers: [
        {
          name: 'migrate'
          image: '${registryServer}/astra-api:${imageTag}'
          command: ['node', 'dist/migrate.js']
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: [
            { name: 'DATABASE_OWNER_URL', secretRef: 'database-owner-url' }
            { name: 'MIGRATIONS_DIR', value: '/app/db/migrations' }
          ]
        }
      ]
    }
  }
}

output apiHost string = api.properties.configuration.ingress.fqdn
output workbenchHost string = workbench.properties.configuration.ingress.fqdn
output migrateJobName string = migrate.name
