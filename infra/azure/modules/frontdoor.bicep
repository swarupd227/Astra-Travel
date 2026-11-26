// Azure Front Door with the web application firewall: the only public way in. It reaches the container apps over a
// private link, which must be approved once on the container apps environment after the first deployment.
param name string
param location string
param environmentId string
param apiHost string
param workbenchHost string
@allowed(['Detection', 'Prevention'])
param wafMode string
param tags object

resource profile 'Microsoft.Cdn/profiles@2024-02-01' = {
  name: '${name}-fd'
  location: 'global'
  tags: tags
  sku: { name: 'Premium_AzureFrontDoor' }
}

var sites = [
  { key: 'api', host: apiHost, probe: '/health/ready' }
  { key: 'workbench', host: workbenchHost, probe: '/signed-out' }
]

resource endpoints 'Microsoft.Cdn/profiles/afdEndpoints@2024-02-01' = [
  for site in sites: {
    parent: profile
    name: '${name}-${site.key}'
    location: 'global'
    properties: { enabledState: 'Enabled' }
  }
]

resource originGroups 'Microsoft.Cdn/profiles/originGroups@2024-02-01' = [
  for site in sites: {
    parent: profile
    name: site.key
    properties: {
      loadBalancingSettings: { sampleSize: 4, successfulSamplesRequired: 3 }
      healthProbeSettings: {
        probePath: site.probe
        probeProtocol: 'Https'
        probeRequestType: 'GET'
        probeIntervalInSeconds: 30
      }
    }
  }
]

resource origins 'Microsoft.Cdn/profiles/originGroups/origins@2024-02-01' = [
  for (site, i) in sites: {
    parent: originGroups[i]
    name: site.key
    properties: {
      hostName: site.host
      originHostHeader: site.host
      httpsPort: 443
      priority: 1
      weight: 1000
      enforceCertificateNameCheck: true
      sharedPrivateLinkResource: {
        privateLink: { id: environmentId }
        groupId: 'managedEnvironments'
        privateLinkLocation: location
        requestMessage: 'Front Door to ${site.key}'
      }
    }
  }
]

resource routes 'Microsoft.Cdn/profiles/afdEndpoints/routes@2024-02-01' = [
  for (site, i) in sites: {
    parent: endpoints[i]
    name: site.key
    properties: {
      originGroup: { id: originGroups[i].id }
      supportedProtocols: ['Http', 'Https']
      patternsToMatch: ['/*']
      forwardingProtocol: 'HttpsOnly'
      httpsRedirect: 'Enabled'
      linkToDefaultDomain: 'Enabled'
    }
    dependsOn: [origins[i]]
  }
]

resource waf 'Microsoft.Network/FrontDoorWebApplicationFirewallPolicies@2024-02-01' = {
  name: '${replace(name, '-', '')}waf'
  location: 'global'
  tags: tags
  sku: { name: 'Premium_AzureFrontDoor' }
  properties: {
    policySettings: { enabledState: 'Enabled', mode: wafMode }
    managedRules: {
      managedRuleSets: [
        { ruleSetType: 'Microsoft_DefaultRuleSet', ruleSetVersion: '2.1', ruleSetAction: 'Block' }
        { ruleSetType: 'Microsoft_BotManagerRuleSet', ruleSetVersion: '1.1' }
      ]
    }
  }
}

resource security 'Microsoft.Cdn/profiles/securityPolicies@2024-02-01' = {
  parent: profile
  name: 'waf'
  properties: {
    parameters: {
      type: 'WebApplicationFirewall'
      wafPolicy: { id: waf.id }
      associations: [
        {
          domains: [for i in range(0, length(sites)): { id: endpoints[i].id }]
          patternsToMatch: ['/*']
        }
      ]
    }
  }
}

output apiEndpoint string = endpoints[0].properties.hostName
output workbenchEndpoint string = endpoints[1].properties.hostName
