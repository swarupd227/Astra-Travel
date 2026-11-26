// The key vault holds every secret. It has no public network access; secrets are written through the management
// plane at deployment, and the applications read them with their managed identity.
param location string
param name string
param endpointSubnetId string
param dnsZoneId string
param readerPrincipalId string
param protectFromPurge bool
@secure()
param secrets object
param tags object

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: take(replace('${name}-kv-${uniqueString(resourceGroup().id)}', '_', '-'), 24)
  location: location
  tags: tags
  properties: {
    sku: { family: 'A', name: 'standard' }
    tenantId: subscription().tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    enablePurgeProtection: protectFromPurge ? true : null
    publicNetworkAccess: 'Disabled'
    networkAcls: { defaultAction: 'Deny', bypass: 'AzureServices' }
  }
}

resource secretValues 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = [
  for item in items(secrets): {
    parent: vault
    name: item.key
    properties: { value: item.value }
  }
]

// Key Vault Secrets User.
resource reader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, readerPrincipalId, 'secrets-user')
  scope: vault
  properties: {
    principalId: readerPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
  }
}

module endpoint 'private-endpoint.bicep' = {
  name: '${name}-kv-endpoint'
  params: {
    location: location
    name: '${name}-kv'
    subnetId: endpointSubnetId
    serviceId: vault.id
    groupId: 'vault'
    dnsZoneId: dnsZoneId
    tags: tags
  }
}

output vaultUri string = vault.properties.vaultUri
