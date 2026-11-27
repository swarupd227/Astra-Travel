// The container apps environment and the file share mounted into it. It is separate from the applications so that its
// default domain is known before the images are built: without Front Door the public addresses come from it.
param location string
param name string
param appsSubnetId string
param workspaceName string
param storageAccountName string
param shareName string
param zoneRedundant bool
@description('Disabled: only Front Door reaches the apps, over its private link. Enabled: the apps are reached directly over HTTPS.')
@allowed(['Enabled', 'Disabled'])
param publicNetworkAccess string
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
    publicNetworkAccess: publicNetworkAccess
    zoneRedundant: zoneRedundant
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
  }
}

resource files 'Microsoft.App/managedEnvironments/storages@2025-01-01' = {
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

output id string = env.id
output defaultDomain string = env.properties.defaultDomain
output storageName string = files.name
