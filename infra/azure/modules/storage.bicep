// The file share the API and worker keep documents and feed files in (FILE_STORE_DIR), reachable only privately.
// The platform stores files on a file system; immutable Blob Storage (specification section 13) is not yet
// implemented in the application, so it is not created here.
param location string
param name string
@allowed(['Standard_LRS', 'Standard_ZRS', 'Standard_GZRS'])
param redundancy string
param shareQuotaGb int
param endpointSubnetId string
param dnsZoneId string
param tags object

resource account 'Microsoft.Storage/storageAccounts@2024-01-01' = {
  name: take('${toLower(replace(name, '-', ''))}st${uniqueString(resourceGroup().id)}', 24)
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: { name: redundancy }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    publicNetworkAccess: 'Disabled'
    networkAcls: { defaultAction: 'Deny', bypass: 'AzureServices' }
  }
}

resource files 'Microsoft.Storage/storageAccounts/fileServices@2024-01-01' = {
  parent: account
  name: 'default'
  properties: {
    shareDeleteRetentionPolicy: { enabled: true, days: 30 }
  }
}

resource share 'Microsoft.Storage/storageAccounts/fileServices/shares@2024-01-01' = {
  parent: files
  name: 'astra-files'
  properties: { shareQuota: shareQuotaGb, enabledProtocols: 'SMB' }
}

module endpoint 'private-endpoint.bicep' = {
  name: '${name}-file-endpoint'
  params: {
    location: location
    name: '${name}-file'
    subnetId: endpointSubnetId
    serviceId: account.id
    groupId: 'file'
    dnsZoneId: dnsZoneId
    tags: tags
  }
}

output accountName string = account.name
output shareName string = share.name
