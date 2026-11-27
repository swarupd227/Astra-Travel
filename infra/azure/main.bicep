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

@description('frontdoor: Front Door with the web application firewall is the only way in. direct: the apps are reached over HTTPS on their own addresses, without a firewall (development only).')
@allowed(['frontdoor', 'direct'])
param edge string = 'frontdoor'
@description('external: Microsoft Entra ID, given by the oidc parameters. keycloak: run Keycloak in the environment (development only).')
@allowed(['external', 'keycloak'])
param identityProvider string = 'external'

@description('Leave empty with identityProvider keycloak.')
param oidcIssuer string = ''
param oidcAudience string = 'astra-api'
param oidcGroupRoleMap string = ''
param workbenchClientId string = 'astra-workbench'
@description('Leave empty with edge direct to use the container apps own addresses.')
param apiPublicUrl string = ''
param workbenchPublicUrl string = ''
param mailFrom string = ''

@allowed(['Basic', 'Standard', 'Premium'])
param registrySku string = 'Standard'
param serviceCpu string = '1.0'
param serviceMemory string = '2Gi'

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
param apiMinReplicas int = minReplicas
param logRetentionDays int
@allowed(['Detection', 'Prevention'])
param wafMode string

@secure()
@description('Password of the database administrator.')
param databaseAdminPassword string
@secure()
@description('Secrets written to the key vault, by name (anthropic-api-key and smtp-url are optional; keycloak-db-password, keycloak-admin-password, staff-user-password and admin-user-password only with Keycloak): database-url, database-owner-url, database-admin-password, database-owner-password, database-app-password, secrets-kek, channel-signing-secret, agent-token-public-key, agent-token-private-key, anthropic-api-key, workbench-client-secret, workbench-session-secret, smtp-url, billing-signing-secret.')
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
    createKeycloakDatabase: identityProvider == 'keycloak'
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
  params: { location: location, name: name, pullPrincipalId: identity.properties.principalId, sku: registrySku, tags: tags }
}

module appEnvironment 'modules/environment.bicep' = {
  name: 'environment'
  params: {
    location: location
    name: name
    appsSubnetId: network.outputs.appsSubnetId
    workspaceName: monitoring.outputs.workspaceName
    storageAccountName: storage.outputs.accountName
    shareName: storage.outputs.shareName
    zoneRedundant: zoneRedundant
    publicNetworkAccess: edge == 'frontdoor' ? 'Disabled' : 'Enabled'
    tags: tags
  }
}

var domain = appEnvironment.outputs.defaultDomain
var apiUrl = empty(apiPublicUrl) ? 'https://${name}-api.${domain}' : apiPublicUrl
var workbenchUrl = empty(workbenchPublicUrl) ? 'https://${name}-workbench.${domain}' : workbenchPublicUrl
var keycloakUrl = 'https://${name}-keycloak.${domain}'
var issuer = identityProvider == 'keycloak' ? '${keycloakUrl}/realms/astra' : oidcIssuer

module keycloak 'modules/keycloak.bicep' = if (deployApps && identityProvider == 'keycloak') {
  name: 'keycloak'
  params: {
    location: location
    name: name
    environmentId: appEnvironment.outputs.id
    identityId: identity.id
    registryServer: registry.outputs.loginServer
    imageTag: imageTag
    vaultUri: vault.outputs.vaultUri
    databaseHost: database.outputs.fqdn
    publicUrl: keycloakUrl
    workbenchPublicUrl: workbenchUrl
    tags: tags
  }
}

// With the foundations, not the applications: it runs before anything connects to the database.
module databaseRoles 'modules/db-roles.bicep' = {
  name: 'database-roles'
  params: {
    location: location
    name: name
    environmentId: appEnvironment.outputs.id
    identityId: identity.id
    vaultUri: vault.outputs.vaultUri
    databaseHost: database.outputs.fqdn
    prepareKeycloakDatabase: identityProvider == 'keycloak'
    tags: tags
  }
}

module apps 'modules/apps.bicep' = if (deployApps) {
  name: 'apps'
  params: {
    location: location
    name: name
    environmentId: appEnvironment.outputs.id
    environmentStorageName: appEnvironment.outputs.storageName
    identityId: identity.id
    registryServer: registry.outputs.loginServer
    imageTag: imageTag
    vaultUri: vault.outputs.vaultUri
    minReplicas: minReplicas
    apiMinReplicas: apiMinReplicas
    maxReplicas: maxReplicas
    serviceCpu: serviceCpu
    serviceMemory: serviceMemory
    hasAnthropicKey: contains(secrets, 'anthropic-api-key')
    hasSmtp: contains(secrets, 'smtp-url')
    oidcIssuer: issuer
    oidcAudience: oidcAudience
    oidcGroupRoleMap: oidcGroupRoleMap
    workbenchClientId: workbenchClientId
    apiPublicUrl: apiUrl
    workbenchPublicUrl: workbenchUrl
    mailFrom: mailFrom
    tags: tags
  }
}

module frontDoor 'modules/frontdoor.bicep' = if (deployApps && edge == 'frontdoor') {
  name: 'frontdoor'
  params: {
    name: name
    location: location
    environmentId: appEnvironment.outputs.id
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
output issuer string = issuer
output migrateJobName string = deployApps ? apps!.outputs.migrateJobName : ''
output bootstrapJobName string = databaseRoles.outputs.jobName
output apiEndpoint string = edge == 'direct' ? replace(apiUrl, 'https://', '') : deployApps ? frontDoor!.outputs.apiEndpoint : ''
output workbenchEndpoint string = edge == 'direct' ? replace(workbenchUrl, 'https://', '') : deployApps ? frontDoor!.outputs.workbenchEndpoint : ''
output keycloakEndpoint string = identityProvider == 'keycloak' ? replace(keycloakUrl, 'https://', '') : ''
