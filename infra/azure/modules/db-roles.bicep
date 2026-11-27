// The job that creates the database roles. It is deployed with the foundations so that it can run before any
// application starts, and it is safe to run again.
param location string
param name string
param environmentId string
param identityId string
param vaultUri string
param databaseHost string
param databaseAdminLogin string = 'astraadmin'
@description('Whether the job also prepares the Keycloak database.')
param prepareKeycloakDatabase bool
param tags object

var secretNames = concat(
  ['database-admin-password', 'database-owner-password', 'database-app-password'],
  prepareKeycloakDatabase ? ['keycloak-db-password'] : []
)

resource bootstrap 'Microsoft.App/jobs@2025-01-01' = {
  name: '${name}-db-roles'
  location: location
  tags: tags
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identityId}': {} } }
  properties: {
    environmentId: environmentId
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 600
      replicaRetryLimit: 0
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      secrets: map(secretNames, s => { name: s, keyVaultUrl: '${vaultUri}secrets/${s}', identity: identityId })
    }
    template: {
      containers: [
        {
          name: 'roles'
          image: 'docker.io/library/postgres:17-alpine'
          command: ['sh', '-c', 'printf "%s" "$ROLES_SQL" | psql -v ON_ERROR_STOP=1 -v owner_password="$OWNER_PASSWORD" -v app_password="$APP_PASSWORD" \${KEYCLOAK_PASSWORD:+-v keycloak_password="$KEYCLOAK_PASSWORD"}']
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          env: concat([
            { name: 'ROLES_SQL', value: loadTextContent('../sql/roles.sql') }
            { name: 'PGHOST', value: databaseHost }
            { name: 'PGUSER', value: databaseAdminLogin }
            { name: 'PGDATABASE', value: 'postgres' }
            { name: 'PGSSLMODE', value: 'require' }
            { name: 'PGPASSWORD', secretRef: 'database-admin-password' }
            { name: 'OWNER_PASSWORD', secretRef: 'database-owner-password' }
            { name: 'APP_PASSWORD', secretRef: 'database-app-password' }
          ], prepareKeycloakDatabase ? [{ name: 'KEYCLOAK_PASSWORD', secretRef: 'keycloak-db-password' }] : [])
        }
      ]
    }
  }
}

output jobName string = bootstrap.name
