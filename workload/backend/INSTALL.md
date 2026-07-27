# asmDB workload backend installation notes

## Entra OBO client authentication

The backend is a confidential middle tier for on-behalf-of token exchange. It must authenticate to Entra in one of two modes:

1. **Preferred: managed identity federated credential.** Run the backend with a system-assigned or user-assigned managed identity and set `ASMDB_WL_USE_MANAGED_IDENTITY=true`. For a user-assigned identity, also set `ASMDB_WL_MANAGED_IDENTITY_CLIENT_ID` to the managed identity client id. Create a federated identity credential on the workload app registration that trusts this managed identity. The backend acquires a managed-identity token for `api://AzureADTokenExchange` and sends it to Entra as `client_assertion`.
2. **Fallback: client secret.** Set `ASMDB_WL_ENTRA_CLIENT_SECRET` only for local development. In Azure, if a secret fallback is unavoidable, populate the setting from a Key Vault secret reference, never from a literal secret value.

If neither mode is configured, the process fails startup configuration validation before serving requests.

### Federated credential to create on the workload app registration

Create a federated identity credential on the workload's app registration (the app whose client id is `ASMDB_WL_ENTRA_CLIENT_ID`) for the managed identity that runs the backend:

- Federated credential scenario: **Managed identity**
- Subject identifier: the backend managed identity's service principal object id
- Audience: `api://AzureADTokenExchange`
- Issuer: the issuer shown by Entra for the selected managed identity federated credential
- Name: for example, `asmdb-workload-backend-mi`

This is a manual Entra installation step: without it, Entra will reject the managed-identity token used as the OBO `client_assertion`.
