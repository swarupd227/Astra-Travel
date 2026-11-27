// Keycloak as the identity provider of a development environment that has no Microsoft Entra ID app registrations.
// One copy, with its own database on the environment's PostgreSQL server. Not for production (docs/adr/0025).
param location string
param name string
param environmentId string
param identityId string
param registryServer string
param imageTag string
param vaultUri string
param databaseHost string
@description('The public address of this Keycloak.')
param publicUrl string
param workbenchPublicUrl string
param tags object

var secretNames = [
  'keycloak-db-password'
  'keycloak-admin-password'
  'workbench-client-secret'
  'staff-user-password'
  'admin-user-password'
]

resource keycloak 'Microsoft.App/containerApps@2025-01-01' = {
  name: '${name}-keycloak'
  location: location
  tags: tags
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identityId}': {} } }
  properties: {
    environmentId: environmentId
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      registries: [{ server: registryServer, identity: identityId }]
      secrets: [for s in secretNames: { name: s, keyVaultUrl: '${vaultUri}secrets/${s}', identity: identityId }]
      ingress: { external: true, targetPort: 8080, transport: 'auto', allowInsecure: false }
    }
    template: {
      containers: [
        {
          name: 'keycloak'
          image: '${registryServer}/astra-keycloak:${imageTag}'
          resources: { cpu: json('1.0'), memory: '2Gi' }
          env: [
            { name: 'KC_DB_URL', value: 'jdbc:postgresql://${databaseHost}:5432/keycloak?sslmode=require' }
            { name: 'KC_DB_USERNAME', value: 'keycloak' }
            { name: 'KC_DB_PASSWORD', secretRef: 'keycloak-db-password' }
            { name: 'KC_DB_POOL_MAX_SIZE', value: '10' }
            { name: 'KC_HOSTNAME', value: publicUrl }
            // The ingress ends TLS and forwards over HTTP inside the environment.
            { name: 'KC_HTTP_ENABLED', value: 'true' }
            { name: 'KC_PROXY_HEADERS', value: 'xforwarded' }
            { name: 'KC_BOOTSTRAP_ADMIN_USERNAME', value: 'admin' }
            { name: 'KC_BOOTSTRAP_ADMIN_PASSWORD', secretRef: 'keycloak-admin-password' }
            // Substituted into the realm file at first import.
            { name: 'WORKBENCH_BASE_URL', value: workbenchPublicUrl }
            { name: 'WORKBENCH_CLIENT_SECRET', secretRef: 'workbench-client-secret' }
            { name: 'STAFF_PASSWORD', secretRef: 'staff-user-password' }
            { name: 'ADMIN_USER_PASSWORD', secretRef: 'admin-user-password' }
          ]
          probes: [
            { type: 'Startup', httpGet: { path: '/health/started', port: 9000 }, initialDelaySeconds: 30, periodSeconds: 30, failureThreshold: 10 }
            { type: 'Liveness', httpGet: { path: '/health/live', port: 9000 }, periodSeconds: 30 }
            { type: 'Readiness', httpGet: { path: '/health/ready', port: 9000 }, periodSeconds: 10 }
          ]
        }
      ]
      scale: { minReplicas: 1, maxReplicas: 1 }
    }
  }
}
