// PostgreSQL with no public access, reached only through its private endpoint. In a standby region it is created as a
// read replica of the primary, to be promoted in a disaster (docs/operations/disaster-recovery.md).
param location string
param name string
param skuName string
@allowed(['Burstable', 'GeneralPurpose', 'MemoryOptimized'])
param skuTier string
param storageGb int
param zoneRedundant bool
param geoRedundantBackup bool
param backupRetentionDays int
param administratorLogin string = 'astraadmin'
@secure()
param administratorPassword string
@description('Resource id of the primary server; given only for the standby region, which then holds a replica.')
param sourceServerId string = ''
param endpointSubnetId string
param dnsZoneId string
param tags object

var isReplica = !empty(sourceServerId)

resource server 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: '${name}-pg-${uniqueString(resourceGroup().id)}'
  location: location
  tags: tags
  sku: { name: skuName, tier: skuTier }
  properties: union(
    {
      storage: { storageSizeGB: storageGb, autoGrow: 'Enabled' }
      network: { publicNetworkAccess: 'Disabled' }
    },
    isReplica
      ? {
          createMode: 'Replica'
          sourceServerResourceId: sourceServerId
        }
      : {
          createMode: 'Default'
          version: '17'
          administratorLogin: administratorLogin
          administratorLoginPassword: administratorPassword
          authConfig: { passwordAuth: 'Enabled', activeDirectoryAuth: 'Disabled' }
          highAvailability: { mode: zoneRedundant ? 'ZoneRedundant' : 'Disabled' }
          backup: {
            backupRetentionDays: backupRetentionDays
            geoRedundantBackup: geoRedundantBackup ? 'Enabled' : 'Disabled'
          }
        }
  )
}

// The extensions the migrations create.
resource extensions 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = if (!isReplica) {
  parent: server
  name: 'azure.extensions'
  properties: { value: 'PGCRYPTO,BTREE_GIST,PG_TRGM', source: 'user-override' }
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = if (!isReplica) {
  parent: server
  name: 'astra'
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
  dependsOn: [extensions]
}

module endpoint 'private-endpoint.bicep' = {
  name: '${name}-pg-endpoint'
  params: {
    location: location
    name: '${name}-pg'
    subnetId: endpointSubnetId
    serviceId: server.id
    groupId: 'postgresqlServer'
    dnsZoneId: dnsZoneId
    tags: tags
  }
}

output serverName string = server.name
output serverId string = server.id
output fqdn string = server.properties.fullyQualifiedDomainName
