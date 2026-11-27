# Compiles the template and every environment's parameter file. The values set here are stand-ins that only let the
# files compile; nothing is deployed.
$ErrorActionPreference = 'Stop'
Set-Location (Resolve-Path "$PSScriptRoot/../..")
foreach ($n in 'OIDC_ISSUER', 'OIDC_AUDIENCE', 'OIDC_GROUP_ROLE_MAP', 'WORKBENCH_CLIENT_ID', 'API_PUBLIC_URL', 'WORKBENCH_PUBLIC_URL', 'MAIL_FROM', 'DATABASE_ADMIN_PASSWORD',
  'DATABASE_URL', 'DATABASE_OWNER_URL', 'DATABASE_OWNER_PASSWORD', 'DATABASE_APP_PASSWORD', 'SECRETS_KEK', 'CHANNEL_SIGNING_SECRET', 'AGENT_TOKEN_PUBLIC_KEY', 'AGENT_TOKEN_PRIVATE_KEY', 'ANTHROPIC_API_KEY', 'WORKBENCH_CLIENT_SECRET',
  'WORKBENCH_SESSION_SECRET', 'SMTP_URL', 'BILLING_SIGNING_SECRET', 'KEYCLOAK_DB_PASSWORD', 'KEYCLOAK_ADMIN_PASSWORD', 'STAFF_USER_PASSWORD',
  'ADMIN_USER_PASSWORD') {
  Set-Item "env:ASTRA_$n" 'compile-only'
}
$failed = $false
$out = az bicep build --file infra/azure/main.bicep --stdout 2>&1
if ($LASTEXITCODE -ne 0) { $failed = $true }
$out | Where-Object { "$_" -match 'Warning|Error' } | ForEach-Object { "$_".Substring(0, [Math]::Min(300, "$_".Length)) }
"main.bicep exit $LASTEXITCODE"
foreach ($e in 'dev', 'test', 'sandbox', 'uat', 'staging', 'prod') {
  $o = az bicep build-params --file "infra/azure/env/$e.bicepparam" --stdout 2>&1
  "$e.bicepparam exit $LASTEXITCODE"
  if ($LASTEXITCODE -ne 0) { $failed = $true; $o | Select-Object -First 8 }
}
node infra/azure/keycloak/make-realm.mjs --check
if ($LASTEXITCODE -ne 0) { $failed = $true }
if ($failed) { exit 1 }
