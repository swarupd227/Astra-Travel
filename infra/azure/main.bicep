// Astra Travel on Azure: one template for every environment (E13-F01-S01), differing only by parameters, so that
// environments are identical and rebuildable. Deployed to a resource group. Design: docs/adr/0022.
targetScope = 'resourceGroup'

@allowed(['dev', 'test', 'sandbox', 'uat', 'staging', 'prod'])
param environmentName string
param location string = resourceGroup().location
@description('Address space of the environment’s virtual network (a /20).')
param addressPrefix string

@description('Deploy the applications. False for the first pass, before images exist.')
param deployApps bool = true
@description('The image tag to run, set by the pipeline to the commit.')
param imageTag string = 'latest'

param oidcIssuer string
param oidcAudience string
param oidcGroupRoleMap string
param workbenchClientId string
param apiPublicUrl string
param workbenchPublicUrl string
param mailFrom string

param databaseSkuName string
@allowed(['Burstable', 'GeneralPurpose', 'MemoryOptimized'])
param databaseSkuTier string
param databaseStorageGb int
param zoneRedundant bool
param geoRedundantBackup bool
param backupRetentionDays int
@description('For the standby region only: the primary database server’s resource id.')
param primaryDatabaseId string = ''
@allowed(['Standard_LRS', 'Standard_ZRS', 'Standard_GZRS'])
param storageRedundancy string
param fileShareGb int
param minReplicas int
param maxReplicas int
param logRetentionDays int
@allowed(['Detection', 'Prevention'])
param wafMode string

@secure()
@description('Password of the database administrator.')
param databaseAdminPassword string
@secure()
@description('Secrets written to the key vault, by name: database-url, database-owner-url, database-admin-password, database-owner-password, database-app-password, secrets-kek, channel-signing-secret, agent-token-public-key, agent-token-private-key, anthropic-api-key, workbench-client-secret, workbench-session-secret, smtp-url, billing-signing-secret.')
param secrets object

var name = 'astra-${environmentName}'
var tags = { application: 'astra-travel', environment: environmentName }

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${name}-apps'
  location: location
  tags: tags
}

module network 'modules/network.bicep' = {
  name: 'network'
  params: { location: location, name: name, addressPrefix: addressPrefix, tags: tags }
}

module monitoring 'modules/monitoring.bicep' = {
  name: 'monitoring'
  params: { location: location, name: name, retentionDays: logRetentionDays, tags: tags }
}

module vault 'modules/keyvault.bicep' = {
  name: 'keyvault'
  params: {
    location: location
    name: name
    endpointSubnetId: network.outputs.endpointSubnetId
    dnsZoneId: network.outputs.vaultZoneId
    readerPrincipalId: identity.properties.principalId
    protectFromPurge: environmentName == 'prod' || environmentName == 'staging'
    secrets: secrets
    tags: tags
  }
}

module database 'modules/postgres.bicep' = {
  name: 'database'
  params: {
    location: location
    name: name
    skuName: databaseSkuName
    skuTier: databaseSkuTier
    storageGb: databaseStorageGb
    zoneRedundant: zoneRedundant
    geoRedundantBackup: geoRedundantBackup
    backupRetentionDays: backupRetentionDays
    administratorPassword: databaseAdminPassword
    sourceServerId: primaryDatabaseId
    endpointSubnetId: network.outputs.endpointSubnetId
    dnsZoneId: network.outputs.postgresZoneId
    tags: tags
  }
}

module storage 'modules/storage.bicep' = {
  name: 'storage'
  params: {
    location: location
    name: name
    redundancy: storageRedundancy
    shareQuotaGb: fileShareGb
    endpointSubnetId: network.outputs.endpointSubnetId
    dnsZoneId: network.outputs.fileZoneId
    tags: tags
  }
}

module registry 'modules/registry.bicep' = {
  name: 'registry'
  params: { location: location, name: name, pullPrincipalId: identity.properties.principalId, tags: tags }
}

module apps 'modules/apps.bicep' = if (deployApps) {
  name: 'apps'
  params: {
    location: location
    name: name
    appsSubnetId: network.outputs.appsSubnetId
    workspaceName: monitoring.outputs.workspaceName
    identityId: identity.id
    registryServer: registry.outputs.loginServer
    imageTag: imageTag
    vaultUri: vault.outputs.vaultUri
    storageAccountName: storage.outputs.accountName
    shareName: storage.outputs.shareName
    zoneRedundant: zoneRedundant
    minReplicas: minReplicas
    maxReplicas: maxReplicas
    oidcIssuer: oidcIssuer
    oidcAudience: oidcAudience
    oidcGroupRoleMap: oidcGroupRoleMap
    workbenchClientId: workbenchClientId
    apiPublicUrl: apiPublicUrl
    workbenchPublicUrl: workbenchPublicUrl
    mailFrom: mailFrom
    databaseHost: database.outputs.fqdn
    tags: tags
  }
}

module frontDoor 'modules/frontdoor.bicep' = if (deployApps) {
  name: 'frontdoor'
  params: {
    name: name
    location: location
    environmentId: apps!.outputs.environmentId
    apiHost: apps!.outputs.apiHost
    workbenchHost: apps!.outputs.workbenchHost
    wafMode: wafMode
    tags: tags
  }
}

output registryName string = registry.outputs.name
output databaseServerName string = database.outputs.serverName
output databaseServerId string = database.outputs.serverId
output databaseHost string = database.outputs.fqdn
output migrateJobName string = deployApps ? apps!.outputs.migrateJobName : ''
output bootstrapJobName string = deployApps ? apps!.outputs.bootstrapJobName : ''
output apiEndpoint string = deployApps ? frontDoor!.outputs.apiEndpoint : ''
output workbenchEndpoint string = deployApps ? frontDoor!.outputs.workbenchEndpoint : ''
