// A job that loads the invented sample data set into a development environment (docs/operations/sample-data.md). It
// is not part of main.bicep, so no other environment can get it by accident, and it runs only when started by hand.
targetScope = 'resourceGroup'

@allowed(['dev'])
param environmentName string = 'dev'
param location string = resourceGroup().location
@description('The tag of the API image to run.')
param imageTag string
param policies int = 3000
param openQuotes int = 500
param cardholdersPerProgramme int = 40000
param concurrency int = 6

var name = 'astra-${environmentName}'
var suffix = uniqueString(resourceGroup().id)

resource environment 'Microsoft.App/managedEnvironments@2025-01-01' existing = {
  name: '${name}-env'
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: '${name}-apps'
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: take('${toLower(replace(name, '-', ''))}acr${suffix}', 50)
}

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: take(replace('${name}-kv-${suffix}', '_', '-'), 24)
}

var secretNames = ['database-url', 'secrets-kek']

resource job 'Microsoft.App/jobs@2025-01-01' = {
  name: '${name}-sample-data'
  location: location
  tags: { application: 'astra-travel', environment: environmentName }
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identity.id}': {} } }
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 14400
      replicaRetryLimit: 0
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      registries: [{ server: registry.properties.loginServer, identity: identity.id }]
      secrets: [
        for s in secretNames: { name: s, keyVaultUrl: '${vault.properties.vaultUri}secrets/${s}', identity: identity.id }
      ]
    }
    template: {
      volumes: [{ name: 'files', storageType: 'AzureFile', storageName: 'files' }]
      containers: [
        {
          name: 'sample-data'
          image: '${registry.properties.loginServer}/astra-api:${imageTag}'
          command: ['node', 'dist/demo/seed.js']
          resources: { cpu: json('1.0'), memory: '2Gi' }
          volumeMounts: [{ volumeName: 'files', mountPath: '/data' }]
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'ASTRA_SAMPLE_DATA', value: 'load' }
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'SECRETS_KEK_ID', value: 'kv-1' }
            { name: 'SECRETS_KEK', secretRef: 'secrets-kek' }
            { name: 'FILE_STORE_DIR', value: '/data' }
            { name: 'SAMPLE_POLICIES', value: string(policies) }
            { name: 'SAMPLE_OPEN_QUOTES', value: string(openQuotes) }
            { name: 'SAMPLE_CARDHOLDERS', value: string(cardholdersPerProgramme) }
            { name: 'SAMPLE_CONCURRENCY', value: string(concurrency) }
          ]
        }
      ]
    }
  }
}

output jobName string = job.name
