param location string = resourceGroup().location
param tag string = 'latest'

// The control-plane image only exists after `az acr build` has run, and that
// build needs the registry this template creates. So the first pass deploys the
// app against a public placeholder and the second pass swaps in the real image.
// Both passes run the same template, which keeps the deployment idempotent.
param controlPlaneImage string = 'mcr.microsoft.com/k8se/quickstart:latest'

var suffix = take(uniqueString(resourceGroup().id), 8)
var registryName = 'asmdbacr${suffix}'
var storageAccountName = 'asmdbst${suffix}'
var logsName = 'asmdb-logs'
var identityName = 'asmdb-mi'
var environmentName = 'asmdb-env'
var controlPlaneName = 'asmdb-cp'

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
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
  }
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: identityName
  location: location
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
    // The public endpoint stays reachable because the Container Apps
    // environment has no VNet integration in this deployment — with it
    // disabled and no private endpoint, nothing can reach the account at all.
    // The production move is a private endpoint plus a VNet-integrated
    // environment, not a flag flip.
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      defaultAction: 'Allow'
      bypass: 'AzureServices'
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
    contributorAssignment
    storageBlobDataContributorAssignment
  ]
}

output registryName string = registry.name
output registryLoginServer string = registry.properties.loginServer
output controlPlaneFqdn string = controlPlane.properties.configuration.ingress.fqdn
output identityClientId string = identity.properties.clientId
output environmentName string = environment.name
output storageAccountName string = storage.name
