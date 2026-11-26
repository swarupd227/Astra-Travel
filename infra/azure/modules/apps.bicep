// The container apps environment, the API, worker and workbench, and the job that applies database migrations.
// Every secret is read from the key vault with the applications' managed identity.
param location string
param name string
param appsSubnetId string
param workspaceName string
param identityId string
param registryServer string
param imageTag string
param vaultUri string
param storageAccountName string
param shareName string
param zoneRedundant bool
param minReplicas int
param maxReplicas int
@description('Identity provider (Microsoft Entra ID): the v2.0 issuer, the API audience and the group to role map as JSON.')
param oidcIssuer string
param oidcAudience string
param oidcGroupRoleMap string
param workbenchClientId string
@description('The public addresses people and partners use.')
param apiPublicUrl string
param workbenchPublicUrl string
param mailFrom string
param databaseHost string
param databaseAdminLogin string = 'astraadmin'
param tags object

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: workspaceName
}

resource storage 'Microsoft.Storage/storageAccounts@2024-01-01' existing = {
  name: storageAccountName
}

// A preview version: it is the one that can switch public network access off.
resource env 'Microsoft.App/managedEnvironments@2025-02-02-preview' = {
  name: '${name}-env'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: workspace.properties.customerId
        sharedKey: workspace.listKeys().primarySharedKey
      }
    }
    vnetConfiguration: { infrastructureSubnetId: appsSubnetId, internal: false }
    // Only Front Door reaches the apps, over its private link.
    publicNetworkAccess: 'Disabled'
    zoneRedundant: zoneRedundant
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
  }
}

resource envStorage 'Microsoft.App/managedEnvironments/storages@2025-01-01' = {
  parent: env
  name: 'files'
  properties: {
    azureFile: {
      accountName: storageAccountName
      accountKey: storage.listKeys().keys[0].value
      shareName: shareName
      accessMode: 'ReadWrite'
    }
  }
}

var identity = { type: 'UserAssigned', userAssignedIdentities: { '${identityId}': {} } }
var registries = [{ server: registryServer, identity: identityId }]
var secretFrom = map(
  [
    'database-url'
    'database-owner-url'
    'database-admin-password'
    'database-owner-password'
    'database-app-password'
    'secrets-kek'
    'channel-signing-secret'
    'agent-token-public-key'
    'agent-token-private-key'
    'anthropic-api-key'
    'workbench-client-secret'
    'workbench-session-secret'
    'smtp-url'
    'billing-signing-secret'
  ],
  s => { name: s, keyVaultUrl: '${vaultUri}secrets/${s}', identity: identityId }
)
var volumes = [{ name: 'files', storageType: 'AzureFile', storageName: envStorage.name }]
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
    environmentId: env.id
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
          resources: { cpu: json('1.0'), memory: '2Gi' }
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
            { type: 'Startup', httpGet: { path: '/health/live', port: 4000 }, periodSeconds: 5, failureThreshold: 30 }
          ]
        }
      ]
      scale: {
        minReplicas: minReplicas
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
    environmentId: env.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      registries: registries
      secrets: secretsNamed(secretFrom, ['database-url', 'secrets-kek', 'agent-token-private-key', 'anthropic-api-key', 'smtp-url', 'billing-signing-secret'])
    }
    template: {
      volumes: volumes
      containers: [
        {
          name: 'worker'
          image: '${registryServer}/astra-worker:${imageTag}'
          resources: { cpu: json('1.0'), memory: '2Gi' }
          volumeMounts: mounts
          env: concat(common, [
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'SECRETS_KEK_ID', value: 'kv-1' }
            { name: 'SECRETS_KEK', secretRef: 'secrets-kek' }
            { name: 'AGENT_TOKEN_PRIVATE_KEY', secretRef: 'agent-token-private-key' }
            { name: 'ANTHROPIC_API_KEY', secretRef: 'anthropic-api-key' }
            { name: 'API_BASE_URL', value: 'https://${api.properties.configuration.ingress.fqdn}' }
            { name: 'OIDC_AUDIENCE', value: oidcAudience }
            { name: 'FILE_STORE_DIR', value: '/data' }
            { name: 'SMTP_URL', secretRef: 'smtp-url' }
            { name: 'MAIL_FROM', value: mailFrom }
            { name: 'BILLING_DROP_DIR', value: '/data/billing-outbox' }
          ])
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
    environmentId: env.id
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
          resources: { cpu: json('1.0'), memory: '2Gi' }
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
    environmentId: env.id
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

// Creates the database roles; run once per environment before the first migration.
resource bootstrap 'Microsoft.App/jobs@2025-01-01' = {
  name: '${name}-db-roles'
  location: location
  tags: tags
  identity: identity
  properties: {
    environmentId: env.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 600
      replicaRetryLimit: 0
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      secrets: secretsNamed(secretFrom, ['database-admin-password', 'database-owner-password', 'database-app-password'])
    }
    template: {
      containers: [
        {
          name: 'roles'
          image: 'docker.io/library/postgres:17-alpine'
          command: ['sh', '-c', 'printf "%s" "$ROLES_SQL" | psql -v ON_ERROR_STOP=1 -v owner_password="$OWNER_PASSWORD" -v app_password="$APP_PASSWORD"']
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          env: [
            { name: 'ROLES_SQL', value: loadTextContent('../sql/roles.sql') }
            { name: 'PGHOST', value: databaseHost }
            { name: 'PGUSER', value: databaseAdminLogin }
            { name: 'PGDATABASE', value: 'postgres' }
            { name: 'PGSSLMODE', value: 'require' }
            { name: 'PGPASSWORD', secretRef: 'database-admin-password' }
            { name: 'OWNER_PASSWORD', secretRef: 'database-owner-password' }
            { name: 'APP_PASSWORD', secretRef: 'database-app-password' }
          ]
        }
      ]
    }
  }
}

output bootstrapJobName string = bootstrap.name
output environmentId string = env.id
output apiHost string = api.properties.configuration.ingress.fqdn
output workbenchHost string = workbench.properties.configuration.ingress.fqdn
output migrateJobName string = migrate.name
