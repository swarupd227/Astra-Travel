// The virtual network: one subnet for the container apps, one for private endpoints, and the private DNS zones that
// make each data service resolve to its private address.
param location string
param name string
param addressPrefix string
param tags object

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: '${name}-vnet'
  location: location
  tags: tags
  properties: {
    addressSpace: { addressPrefixes: [addressPrefix] }
    subnets: [
      {
        name: 'apps'
        properties: {
          addressPrefix: cidrSubnet(addressPrefix, 23, 0)
          delegations: [{ name: 'containerapps', properties: { serviceName: 'Microsoft.App/environments' } }]
        }
      }
      {
        name: 'private-endpoints'
        properties: {
          addressPrefix: cidrSubnet(addressPrefix, 24, 4)
          privateEndpointNetworkPolicies: 'Enabled'
        }
      }
    ]
  }
}

var zoneNames = [
  'privatelink.postgres.database.azure.com'
  'privatelink.file.${environment().suffixes.storage}'
  'privatelink.vaultcore.azure.net'
]

resource zones 'Microsoft.Network/privateDnsZones@2024-06-01' = [
  for zone in zoneNames: {
    name: zone
    location: 'global'
    tags: tags
  }
]

resource links 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = [
  for (zone, i) in zoneNames: {
    parent: zones[i]
    name: '${name}-link'
    location: 'global'
    properties: {
      registrationEnabled: false
      virtualNetwork: { id: vnet.id }
    }
  }
]

output appsSubnetId string = vnet.properties.subnets[0].id
output endpointSubnetId string = vnet.properties.subnets[1].id
output postgresZoneId string = zones[0].id
output fileZoneId string = zones[1].id
output vaultZoneId string = zones[2].id
