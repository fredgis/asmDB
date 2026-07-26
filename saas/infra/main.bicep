param location string = resourceGroup().location
param tag string = 'latest'
param deployApim bool = true
param publisherEmail string = 'admin@asmdb.dev'
param publisherName string = 'asmdb'

// Custom gateway hostname, e.g. 'www.asmdb.cloud'. Must already resolve by
// CNAME to the gateway before deployment.
param customDomain string = ''

// The certificate for that hostname, as a base64 PFX, plus its password.
// Supplied by deploy.ps1 from the ACME store — never written down here and
// never committed. Empty leaves any existing hostname configuration alone.
@secure()
param customDomainPfx string = ''
@secure()
param customDomainPfxPassword string = ''

// The control-plane image only exists after `az acr build` has run, and that
// build needs the registry this template creates. So the first pass deploys the
// app against a public placeholder and the second pass swaps in the real image.
// Both passes run the same template, which keeps the deployment idempotent.
param controlPlaneImage string = 'mcr.microsoft.com/k8se/quickstart:latest'

var suffix = take(uniqueString(resourceGroup().id), 8)
var registryName = 'asmdbacr${suffix}'
var storageAccountName = 'asmdbst${suffix}'
var fileStorageAccountName = take('asmdbfs${uniqueString(resourceGroup().id)}', 24)
var logsName = 'asmdb-logs'
var identityName = 'asmdb-mi'
var environmentName = 'asmdb-env'
var instanceStorageName = 'asmdb-data'
var controlPlaneName = 'asmdb-cp'
var vnetName = 'asmdb-vnet'
var apimName = 'asmdb-apim'
var apimPublicIpName = 'asmdb-apim-pip'
var apimPublicIpDnsLabel = 'asmdb-apim-${suffix}'
var apimNsgName = 'asmdb-apim-nsg'
var storageBlobPrivateDnsZoneName = 'privatelink.blob.core.windows.net'
var filePrivateDnsZoneName = 'privatelink.file.core.windows.net'
var acrPrivateDnsZoneName = 'privatelink.azurecr.io'

var acrPullRoleDefinitionId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
var contributorRoleDefinitionId = 'b24988ac-6180-42a0-ab88-20f7382dd24c'
var storageBlobDataContributorRoleDefinitionId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

resource logs 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: logsName
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: registryName
  location: location
  sku: {
    name: 'Premium'
  }
  properties: {
    adminUserEnabled: false
    // Keep public network access enabled because images are built by `az acr build`
    // (ACR Tasks) from outside this VNet. Fully private builds require the
    // dedicated-agent-pool fix: an ACR Tasks dedicated agent pool inside the VNet.
    // Runtime pulls use the private endpoint and private DNS below.
    publicNetworkAccess: 'Enabled'
  }
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: identityName
  location: location
}

resource apimNsg 'Microsoft.Network/networkSecurityGroups@2023-09-01' = {
  name: apimNsgName
  location: location
  properties: {
    securityRules: [
      {
        name: 'Allow-ApiManagement-ManagementEndpoint-Inbound'
        properties: {
          priority: 100
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourcePortRange: '*'
          destinationPortRange: '3443'
          sourceAddressPrefix: 'ApiManagement'
          destinationAddressPrefix: 'VirtualNetwork'
        }
      }
      {
        name: 'Allow-Internet-Https-Inbound'
        properties: {
          priority: 110
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourcePortRange: '*'
          destinationPortRange: '443'
          sourceAddressPrefix: 'Internet'
          destinationAddressPrefix: 'VirtualNetwork'
        }
      }
      {
        name: 'Allow-AzureLoadBalancer-Inbound'
        properties: {
          priority: 120
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourcePortRange: '*'
          destinationPortRange: '6390'
          sourceAddressPrefix: 'AzureLoadBalancer'
          destinationAddressPrefix: 'VirtualNetwork'
        }
      }
      {
        name: 'Allow-Storage-Outbound'
        properties: {
          priority: 100
          direction: 'Outbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourcePortRange: '*'
          destinationPortRange: '443'
          sourceAddressPrefix: 'VirtualNetwork'
          destinationAddressPrefix: 'Storage'
        }
      }
      {
        name: 'Allow-SQL-Outbound'
        properties: {
          priority: 110
          direction: 'Outbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourcePortRange: '*'
          destinationPortRange: '1433'
          sourceAddressPrefix: 'VirtualNetwork'
          destinationAddressPrefix: 'SQL'
        }
      }
      {
        name: 'Allow-KeyVault-Outbound'
        properties: {
          priority: 120
          direction: 'Outbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourcePortRange: '*'
          destinationPortRange: '443'
          sourceAddressPrefix: 'VirtualNetwork'
          destinationAddressPrefix: 'AzureKeyVault'
        }
      }
      {
        name: 'Allow-AzureMonitor-Outbound'
        properties: {
          priority: 130
          direction: 'Outbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourcePortRange: '*'
          destinationPortRanges: [
            '443'
            '1886'
          ]
          sourceAddressPrefix: 'VirtualNetwork'
          destinationAddressPrefix: 'AzureMonitor'
        }
      }
    ]
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2023-09-01' = {
  name: vnetName
  location: location
  properties: {
    addressSpace: {
      addressPrefixes: [
        '10.20.0.0/16'
      ]
    }
    subnets: [
      {
        name: 'snet-aca'
        properties: {
          addressPrefix: '10.20.0.0/23'
          delegations: [
            {
              name: 'Microsoft.App.environments'
              properties: {
                serviceName: 'Microsoft.App/environments'
              }
            }
          ]
        }
      }
      {
        name: 'snet-apim'
        properties: {
          addressPrefix: '10.20.4.0/24'
          networkSecurityGroup: {
            id: apimNsg.id
          }
        }
      }
      {
        name: 'snet-pe'
        properties: {
          addressPrefix: '10.20.5.0/24'
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
    ]
  }
}

resource acaSubnet 'Microsoft.Network/virtualNetworks/subnets@2023-09-01' existing = {
  parent: vnet
  name: 'snet-aca'
}

resource apimSubnet 'Microsoft.Network/virtualNetworks/subnets@2023-09-01' existing = {
  parent: vnet
  name: 'snet-apim'
}

resource privateEndpointSubnet 'Microsoft.Network/virtualNetworks/subnets@2023-09-01' existing = {
  parent: vnet
  name: 'snet-pe'
}

resource environment 'Microsoft.App/managedEnvironments@2023-05-01' = {
  name: environmentName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
    vnetConfiguration: {
      infrastructureSubnetId: acaSubnet.id
      internal: true
    }
  }
}

resource acaPrivateDnsDeployment 'Microsoft.Resources/deployments@2022-09-01' = {
  name: 'asmdb-aca-private-dns'
  properties: {
    mode: 'Incremental'
    parameters: {
      defaultDomain: {
        value: environment.properties.defaultDomain
      }
      staticIp: {
        value: environment.properties.staticIp
      }
      vnetId: {
        value: vnet.id
      }
      vnetName: {
        value: vnet.name
      }
    }
    template: {
      '$schema': 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#'
      contentVersion: '1.0.0.0'
      parameters: {
        defaultDomain: {
          type: 'string'
        }
        staticIp: {
          type: 'string'
        }
        vnetId: {
          type: 'string'
        }
        vnetName: {
          type: 'string'
        }
      }
      resources: [
        {
          type: 'Microsoft.Network/privateDnsZones'
          apiVersion: '2020-06-01'
          name: '[parameters(\'defaultDomain\')]'
          location: 'global'
        }
        {
          type: 'Microsoft.Network/privateDnsZones/virtualNetworkLinks'
          apiVersion: '2020-06-01'
          name: '[concat(parameters(\'defaultDomain\'), \'/\', parameters(\'vnetName\'), \'-link\')]'
          location: 'global'
          dependsOn: [
            '[resourceId(\'Microsoft.Network/privateDnsZones\', parameters(\'defaultDomain\'))]'
          ]
          properties: {
            registrationEnabled: false
            virtualNetwork: {
              id: '[parameters(\'vnetId\')]'
            }
          }
        }
        {
          type: 'Microsoft.Network/privateDnsZones/A'
          apiVersion: '2020-06-01'
          name: '[concat(parameters(\'defaultDomain\'), \'/*\')]'
          dependsOn: [
            '[resourceId(\'Microsoft.Network/privateDnsZones\', parameters(\'defaultDomain\'))]'
          ]
          properties: {
            ttl: 300
            aRecords: [
              {
                ipv4Address: '[parameters(\'staticIp\')]'
              }
            ]
          }
        }
      ]
    }
  }
}

resource storage 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: storageAccountName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    // Shared keys are off: the control plane authenticates with its managed
    // identity, so there is no secret to leak or rotate.
    allowSharedKeyAccess: false
    publicNetworkAccess: 'Disabled'
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'None'
    }
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-01-01' = {
  parent: storage
  name: 'default'
}

resource instancesContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' = {
  parent: blobService
  name: 'instances'
  properties: {
    publicAccess: 'None'
  }
}

resource fileStorage 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: fileStorageAccountName
  location: location
  sku: {
    name: 'Premium_LRS'
  }
  kind: 'FileStorage'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    publicNetworkAccess: 'Disabled'
    // NFS is not an HTTPS protocol. Azure Files NFS requires this to be false;
    // changing it to true makes Azure reject the NFS share/mount.
    supportsHttpsTrafficOnly: false
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'AzureServices'
    }
  }
}

resource fileService 'Microsoft.Storage/storageAccounts/fileServices@2023-01-01' = {
  parent: fileStorage
  name: 'default'
}

resource fileShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-01-01' = {
  parent: fileService
  name: 'instances'
  properties: {
    enabledProtocols: 'NFS'
    rootSquash: 'NoRootSquash'
    shareQuota: 100
  }
}

resource storageBlobPrivateDnsZone 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: storageBlobPrivateDnsZoneName
  location: 'global'
}

resource storageBlobPrivateDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: storageBlobPrivateDnsZone
  name: '${vnet.name}-link'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnet.id
    }
  }
}

resource storageBlobPrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-09-01' = {
  name: 'pe-${storage.name}-blob'
  location: location
  properties: {
    subnet: {
      id: privateEndpointSubnet.id
    }
    privateLinkServiceConnections: [
      {
        name: '${storage.name}-blob'
        properties: {
          privateLinkServiceId: storage.id
          groupIds: [
            'blob'
          ]
        }
      }
    ]
  }
}

resource storageBlobPrivateDnsZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-09-01' = {
  parent: storageBlobPrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'blob'
        properties: {
          privateDnsZoneId: storageBlobPrivateDnsZone.id
        }
      }
    ]
  }
}

resource filePrivateDnsZone 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: filePrivateDnsZoneName
  location: 'global'
}

resource filePrivateDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: filePrivateDnsZone
  name: '${vnet.name}-link'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnet.id
    }
  }
}

resource filePrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-09-01' = {
  name: 'pe-${fileStorage.name}-file'
  location: location
  properties: {
    subnet: {
      id: privateEndpointSubnet.id
    }
    privateLinkServiceConnections: [
      {
        name: '${fileStorage.name}-file'
        properties: {
          privateLinkServiceId: fileStorage.id
          groupIds: [
            'file'
          ]
        }
      }
    ]
  }
}

resource filePrivateDnsZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-09-01' = {
  parent: filePrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'file'
        properties: {
          privateDnsZoneId: filePrivateDnsZone.id
        }
      }
    ]
  }
}

resource acrPrivateDnsZone 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: acrPrivateDnsZoneName
  location: 'global'
}

resource acrPrivateDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: acrPrivateDnsZone
  name: '${vnet.name}-link'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnet.id
    }
  }
}

resource acrPrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-09-01' = {
  name: 'pe-${registry.name}-registry'
  location: location
  properties: {
    subnet: {
      id: privateEndpointSubnet.id
    }
    privateLinkServiceConnections: [
      {
        name: '${registry.name}-registry'
        properties: {
          privateLinkServiceId: registry.id
          groupIds: [
            'registry'
          ]
        }
      }
    ]
  }
}

resource acrPrivateDnsZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-09-01' = {
  parent: acrPrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'registry'
        properties: {
          privateDnsZoneId: acrPrivateDnsZone.id
        }
      }
    ]
  }
}

resource acrPullAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, identity.id, acrPullRoleDefinitionId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleDefinitionId)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource contributorAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, identity.id, contributorRoleDefinitionId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', contributorRoleDefinitionId)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource storageBlobDataContributorAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, identity.id, storageBlobDataContributorRoleDefinitionId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataContributorRoleDefinitionId)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource instanceStorage 'Microsoft.App/managedEnvironments/storages@2025-01-01' = {
  parent: environment
  name: instanceStorageName
  properties: {
    nfsAzureFile: {
      server: '${fileStorage.name}.file.core.windows.net'
      shareName: '/${fileStorage.name}/${fileShare.name}'
      accessMode: 'ReadWrite'
    }
  }
  dependsOn: [
    filePrivateDnsZoneGroup
  ]
}

resource controlPlane 'Microsoft.App/containerApps@2023-05-01' = {
  name: controlPlaneName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        // 'external' is relative to the environment, and this environment is
        // already internal (no public load balancer). true therefore means
        // "reachable on the environment's private load balancer at its static
        // VNet IP" — which is what APIM needs — and still not reachable from
        // the internet. false would restrict it to other apps inside the
        // environment, on an address APIM cannot route to.
        external: true
        targetPort: 8080
        transport: 'auto'
      }
      registries: [
        {
          server: registry.properties.loginServer
          identity: identity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'controlplane'
          image: controlPlaneImage
          env: [
            {
              name: 'AZURE_SUBSCRIPTION_ID'
              value: subscription().subscriptionId
            }
            {
              name: 'AZURE_CLIENT_ID'
              value: identity.properties.clientId
            }
            {
              name: 'ASMDB_RESOURCE_GROUP'
              value: resourceGroup().name
            }
            {
              name: 'ASMDB_ENVIRONMENT'
              value: environment.name
            }
            {
              name: 'ASMDB_IMAGE'
              value: '${registry.properties.loginServer}/asmdb-instance:${tag}'
            }
            {
              name: 'ASMDB_LOCATION'
              value: location
            }
            {
              name: 'ASMDB_STORAGE_ACCOUNT'
              value: storage.name
            }
            {
              name: 'ASMDB_ENV_STORAGE'
              value: instanceStorage.name
            }
          ]
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
    }
  }
  dependsOn: [
    acrPullAssignment
    acrPrivateDnsZoneGroup
    contributorAssignment
    instanceStorage
    storageBlobPrivateDnsZoneGroup
    storageBlobDataContributorAssignment
  ]
}

resource apimPublicIp 'Microsoft.Network/publicIPAddresses@2023-09-01' = if (deployApim) {
  name: apimPublicIpName
  location: location
  sku: {
    name: 'Standard'
  }
  properties: {
    publicIPAllocationMethod: 'Static'
    dnsSettings: {
      domainNameLabel: apimPublicIpDnsLabel
    }
  }
}

resource apim 'Microsoft.ApiManagement/service@2024-05-01' = if (deployApim) {
  name: apimName
  location: location
  sku: {
    name: 'Developer'
    capacity: 1
  }
  properties: union(
    {
      publisherEmail: publisherEmail
      publisherName: publisherName
      publicIpAddressId: apimPublicIp.id
      virtualNetworkType: 'External'
      virtualNetworkConfiguration: {
        subnetResourceId: apimSubnet.id
      }
    },
    // The custom hostname is only managed when a certificate is supplied.
    // Managed certificates cannot be used here: Azure refuses new managed
    // certificate requests with ManagedCertificateConfigurationTemporaryDisabled,
    // and in any case they validate over CNAME, which a zone apex cannot have.
    // So the certificate is brought in — Let's Encrypt, renewed every 90 days,
    // procedure in docs/SAAS.md. When no certificate is passed this object is
    // empty and ARM leaves any existing hostname configuration untouched, which
    // is what keeps a routine redeploy from tearing the domain down.
    (empty(customDomain) || empty(customDomainPfx)) ? {} : {
      hostnameConfigurations: [
        {
          type: 'Proxy'
          hostName: customDomain
          encodedCertificate: customDomainPfx
          certificatePassword: customDomainPfxPassword
          defaultSslBinding: true
          negotiateClientCertificate: false
        }
      ]
    }
  )
}

resource apimApi 'Microsoft.ApiManagement/service/apis@2024-05-01' = if (deployApim) {
  parent: apim
  name: 'asmdb'
  properties: {
    displayName: 'asmdb'
    apiType: 'http'
    path: ''
    protocols: [
      'https'
    ]
    serviceUrl: 'https://${controlPlane.properties.configuration.ingress.fqdn}'
    subscriptionRequired: false
  }
}

resource apimGetOperation 'Microsoft.ApiManagement/service/apis/operations@2024-05-01' = if (deployApim) {
  parent: apimApi
  name: 'catch-all-get'
  properties: {
    displayName: 'GET catch-all'
    method: 'GET'
    urlTemplate: '/*'
    responses: []
    templateParameters: []
  }
}

resource apimPostOperation 'Microsoft.ApiManagement/service/apis/operations@2024-05-01' = if (deployApim) {
  parent: apimApi
  name: 'catch-all-post'
  properties: {
    displayName: 'POST catch-all'
    method: 'POST'
    urlTemplate: '/*'
    responses: []
    templateParameters: []
  }
}

resource apimPutOperation 'Microsoft.ApiManagement/service/apis/operations@2024-05-01' = if (deployApim) {
  parent: apimApi
  name: 'catch-all-put'
  properties: {
    displayName: 'PUT catch-all'
    method: 'PUT'
    urlTemplate: '/*'
    responses: []
    templateParameters: []
  }
}

resource apimDeleteOperation 'Microsoft.ApiManagement/service/apis/operations@2024-05-01' = if (deployApim) {
  parent: apimApi
  name: 'catch-all-delete'
  properties: {
    displayName: 'DELETE catch-all'
    method: 'DELETE'
    urlTemplate: '/*'
    responses: []
    templateParameters: []
  }
}

resource apimApiPolicy 'Microsoft.ApiManagement/service/apis/policies@2024-05-01' = if (deployApim) {
  parent: apimApi
  name: 'policy'
  properties: {
    format: 'xml'
    value: '<policies><inbound><base /><set-backend-service base-url="https://${controlPlane.properties.configuration.ingress.fqdn}" /><!-- Container Apps ingress routes by Host header. Without this override the gateway forwards its own hostname, the environment does not recognise it, and every request comes back as a bare 404 with no body. --><set-header name="Host" exists-action="override"><value>${controlPlane.properties.configuration.ingress.fqdn}</value></set-header></inbound><backend><forward-request /></backend><outbound><base /></outbound><on-error><base /></on-error></policies>'
  }
  dependsOn: [
    apimGetOperation
    apimPostOperation
    apimPutOperation
    apimDeleteOperation
  ]
}

resource apimInstanceApi 'Microsoft.ApiManagement/service/apis@2024-05-01' = if (deployApim) {
  parent: apim
  name: 'asmdb-instances'
  properties: {
    displayName: 'asmdb instances'
    apiType: 'http'
    path: 'db'
    protocols: [
      'https'
    ]
    subscriptionRequired: false
  }
}

resource apimInstanceGetOperation 'Microsoft.ApiManagement/service/apis/operations@2024-05-01' = if (deployApim) {
  parent: apimInstanceApi
  name: 'instance-catch-all-get'
  properties: {
    displayName: 'GET instance catch-all'
    method: 'GET'
    urlTemplate: '/{instance}/*'
    templateParameters: [
      {
        name: 'instance'
        type: 'string'
        required: true
        values: []
      }
    ]
    responses: []
  }
}

resource apimInstancePostOperation 'Microsoft.ApiManagement/service/apis/operations@2024-05-01' = if (deployApim) {
  parent: apimInstanceApi
  name: 'instance-catch-all-post'
  properties: {
    displayName: 'POST instance catch-all'
    method: 'POST'
    urlTemplate: '/{instance}/*'
    templateParameters: [
      {
        name: 'instance'
        type: 'string'
        required: true
        values: []
      }
    ]
    responses: []
  }
}

resource apimInstancePutOperation 'Microsoft.ApiManagement/service/apis/operations@2024-05-01' = if (deployApim) {
  parent: apimInstanceApi
  name: 'instance-catch-all-put'
  properties: {
    displayName: 'PUT instance catch-all'
    method: 'PUT'
    urlTemplate: '/{instance}/*'
    templateParameters: [
      {
        name: 'instance'
        type: 'string'
        required: true
        values: []
      }
    ]
    responses: []
  }
}

resource apimInstancePatchOperation 'Microsoft.ApiManagement/service/apis/operations@2024-05-01' = if (deployApim) {
  parent: apimInstanceApi
  name: 'instance-catch-all-patch'
  properties: {
    displayName: 'PATCH instance catch-all'
    method: 'PATCH'
    urlTemplate: '/{instance}/*'
    templateParameters: [
      {
        name: 'instance'
        type: 'string'
        required: true
        values: []
      }
    ]
    responses: []
  }
}

resource apimInstanceDeleteOperation 'Microsoft.ApiManagement/service/apis/operations@2024-05-01' = if (deployApim) {
  parent: apimInstanceApi
  name: 'instance-catch-all-delete'
  properties: {
    displayName: 'DELETE instance catch-all'
    method: 'DELETE'
    urlTemplate: '/{instance}/*'
    templateParameters: [
      {
        name: 'instance'
        type: 'string'
        required: true
        values: []
      }
    ]
    responses: []
  }
}

resource apimInstanceHeadOperation 'Microsoft.ApiManagement/service/apis/operations@2024-05-01' = if (deployApim) {
  parent: apimInstanceApi
  name: 'instance-catch-all-head'
  properties: {
    displayName: 'HEAD instance catch-all'
    method: 'HEAD'
    urlTemplate: '/{instance}/*'
    templateParameters: [
      {
        name: 'instance'
        type: 'string'
        required: true
        values: []
      }
    ]
    responses: []
  }
}

resource apimInstanceOptionsOperation 'Microsoft.ApiManagement/service/apis/operations@2024-05-01' = if (deployApim) {
  parent: apimInstanceApi
  name: 'instance-catch-all-options'
  properties: {
    displayName: 'OPTIONS instance catch-all'
    method: 'OPTIONS'
    urlTemplate: '/{instance}/*'
    templateParameters: [
      {
        name: 'instance'
        type: 'string'
        required: true
        values: []
      }
    ]
    responses: []
  }
}

resource apimInstanceApiPolicy 'Microsoft.ApiManagement/service/apis/policies@2024-05-01' = if (deployApim) {
  parent: apimInstanceApi
  name: 'policy'
  properties: {
    format: 'xml'
    // The data-plane rewrite strips the public /db/{instance} prefix before
    // forwarding to the instance. It intentionally uses OriginalUrl and a
    // StartsWith guard so APIM path-prefix handling cannot silently corrupt the
    // backend path. First live smoke test should verify /db/<instance>/health
    // reaches /health (not /<instance>/health or a duplicated path segment).
    value: '<policies><inbound><base /><!-- Deliberately no CORS here: browsers must not call data-plane instances directly because that would put instance bearer tokens in front-end code. --><!-- Strip /db/{instance} defensively from the original gateway path; fall back to an obvious 404 path instead of slicing a path whose prefix is not present. --><set-backend-service base-url="@(&quot;https://db-&quot; + context.Request.MatchedParameters[&quot;instance&quot;] + &quot;.${environment.properties.defaultDomain}&quot;)" /><!-- Container Apps ingress routes by Host header, so it must name the instance, not the gateway. Without this every call returns a bare 404 with no body and looks like a broken database. --><set-header name="Host" exists-action="override"><value>@(&quot;db-&quot; + context.Request.MatchedParameters[&quot;instance&quot;] + &quot;.${environment.properties.defaultDomain}&quot;)</value></set-header><rewrite-uri template="@{ var prefix = &quot;/db/&quot; + context.Request.MatchedParameters[&quot;instance&quot;]; var originalPath = context.Request.OriginalUrl.Path; return originalPath.StartsWith(prefix) ? (originalPath.Length > prefix.Length ? originalPath.Substring(prefix.Length) : &quot;/&quot;) : &quot;/__apim_bad_instance_route&quot;; }" copy-unmatched-params="true" /></inbound><backend><forward-request timeout="60" /></backend><outbound><base /></outbound><on-error><base /></on-error></policies>'
  }
  dependsOn: [
    apimInstanceGetOperation
    apimInstancePostOperation
    apimInstancePutOperation
    apimInstancePatchOperation
    apimInstanceDeleteOperation
    apimInstanceHeadOperation
    apimInstanceOptionsOperation
  ]
}

output registryName string = registry.name
output registryLoginServer string = registry.properties.loginServer
output controlPlaneFqdn string = controlPlane.properties.configuration.ingress.fqdn
output identityClientId string = identity.properties.clientId
output environmentName string = environment.name
output storageAccountName string = storage.name
output fileStorageAccountName string = fileStorage.name
output instanceStorageName string = instanceStorage.name
output apimName string = deployApim ? apim!.name : ''
output apimGatewayUrl string = deployApim ? (empty(customDomain) ? apim!.properties.gatewayUrl : 'https://${customDomain}') : ''
// When APIM is skipped, this falls back to the internal Container Apps environment domain for private/VNet-local testing.
// The base a customer is handed at creation. It must be the hostname the
// customer can actually reach, so it follows the custom domain once one exists.
output instancePublicBase string = deployApim ? (empty(customDomain) ? '${apim!.properties.gatewayUrl}/db' : 'https://${customDomain}/db') : 'https://${environment.properties.defaultDomain}'
output vnetName string = vnet.name
output controlPlaneInternalFqdn string = controlPlane.properties.configuration.ingress.fqdn
