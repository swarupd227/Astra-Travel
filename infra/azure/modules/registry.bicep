// The container registry. Anonymous and admin sign-in are off: the pipeline pushes with its own identity and the
// applications pull with theirs.
param location string
param name string
param pullPrincipalId string
@allowed(['Basic', 'Standard', 'Premium'])
param sku string = 'Standard'
param tags object

resource registry 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' = {
  name: take('${toLower(replace(name, '-', ''))}acr${uniqueString(resourceGroup().id)}', 50)
  location: location
  tags: tags
  sku: { name: sku }
  properties: {
    adminUserEnabled: false
    anonymousPullEnabled: false
  }
}

// AcrPull.
resource pull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, pullPrincipalId, 'acr-pull')
  scope: registry
  properties: {
    principalId: pullPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
  }
}

output loginServer string = registry.properties.loginServer
output name string = registry.name
