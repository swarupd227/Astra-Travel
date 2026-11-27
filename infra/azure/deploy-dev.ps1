# Deploys the development environment from this machine with the Azure CLI (sign in with `az login` first).
# Safe to run again: it updates what exists. The secrets are created once in var/azure and are never printed.
#   ./infra/azure/deploy-dev.ps1 -Subscription '<name or id>'
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $Subscription,
  [string] $ResourceGroup = 'rg-astra-travel-dev',
  [string] $Location = 'eastus2',
  # Skip the image builds and deploy the tag given by -ImageTag, which must already be in the registry.
  [switch] $SkipBuild,
  [string] $ImageTag,
  # Create the foundations and the database roles only; no images or applications.
  [switch] $FoundationsOnly
)
$ErrorActionPreference = 'Stop'
Set-Location (Resolve-Path "$PSScriptRoot/../..")
$env:PYTHONIOENCODING = 'utf-8'

function Invoke-Az {
  $out = & az @args --subscription $Subscription
  if ($LASTEXITCODE -ne 0) { throw "az $($args[0..2] -join ' ') failed" }
  $out
}

if (-not $ImageTag -and -not $FoundationsOnly) {
  $ImageTag = (git rev-parse --short=12 HEAD).Trim()
  if (git status --porcelain) { throw 'Commit first: images are tagged with the commit they were built from.' }
}

node infra/azure/dev-secrets.mjs dev
if ($LASTEXITCODE -ne 0) { throw 'The secrets could not be prepared.' }
$secrets = Get-Content var/azure/dev.secrets.json -Raw | ConvertFrom-Json -AsHashtable
foreach ($name in $secrets.Keys) { Set-Item "env:ASTRA_$($name.ToUpper().Replace('-', '_'))" $secrets[$name] }
$env:ASTRA_IMAGE_TAG = $ImageTag

function Set-DatabaseUrls([string] $hostName) {
  $env:ASTRA_DATABASE_URL = "postgres://astra_app:$($secrets['database-app-password'])@${hostName}:5432/astra?sslmode=require"
  $env:ASTRA_DATABASE_OWNER_URL = "postgres://astra_owner:$($secrets['database-owner-password'])@${hostName}:5432/astra?sslmode=require"
}

function Publish-Template([string] $phase, [bool] $apps) {
  $env:ASTRA_DEPLOY_APPS = "$apps".ToLower()
  $name = "$phase-$(Get-Date -Format 'yyyyMMddHHmmss')"
  Write-Host "Deploying ($phase) ..."
  $json = Invoke-Az deployment group create -g $ResourceGroup -n $name --parameters infra/azure/env/dev.bicepparam --query properties.outputs -o json --only-show-errors
  $json | Out-String | ConvertFrom-Json
}

function Invoke-Job([string] $job) {
  $run = Invoke-Az containerapp job start -g $ResourceGroup -n $job --query name -o tsv --only-show-errors
  Write-Host "Job $job started ($run)"
  foreach ($i in 1..90) {
    $status = Invoke-Az containerapp job execution show -g $ResourceGroup -n $job --job-execution-name $run --query properties.status -o tsv --only-show-errors
    if ($status -in 'Succeeded', 'Failed', 'Degraded') { break }
    Start-Sleep -Seconds 10
  }
  if ($status -ne 'Succeeded') { throw "Job $job ended as $status. See its logs in the environment's Log Analytics workspace." }
  Write-Host "Job $job succeeded"
}

Invoke-Az group create -n $ResourceGroup -l $Location --tags application=astra-travel environment=dev -o none

# 1. Foundations. The database host is not known until the server exists.
Set-DatabaseUrls 'pending.invalid'
$base = Publish-Template 'foundations' $false
Set-DatabaseUrls $base.databaseHost.value
$registry = $base.registryName.value
$issuer = $base.issuer.value
Write-Host "Registry $registry, sign-in $issuer"

# 2. Database roles.
Invoke-Job $base.bootstrapJobName.value
if ($FoundationsOnly) { Write-Host 'Foundations are ready.'; return }

# 3. Images, built in the registry from a clean export of the commit: only committed files are uploaded, and the Azure
# CLI does not have to walk the local dependency folders.
if (-not $SkipBuild) {
  $export = Join-Path ([IO.Path]::GetTempPath()) "astra-build-$ImageTag"
  if (Test-Path $export) { Remove-Item $export -Recurse -Force }
  New-Item -ItemType Directory $export | Out-Null
  try {
    git archive --format=tar -o "$export.tar" $ImageTag
    if ($LASTEXITCODE -ne 0) { throw "Commit $ImageTag could not be exported." }
    tar -xf "$export.tar" -C $export
    if ($LASTEXITCODE -ne 0) { throw 'The export could not be unpacked.' }
    foreach ($target in 'api', 'worker', 'workbench') {
      Write-Host "Building astra-${target}:$ImageTag ..."
      $extra = if ($target -eq 'workbench') { @('--build-arg', "OIDC_ISSUER=$issuer") } else { @() }
      Invoke-Az acr build -r $registry -f "$export/infra/docker/Dockerfile" --target $target -t "astra-${target}:$ImageTag" @extra --no-logs $export -o none
    }
    Write-Host "Building astra-keycloak:$ImageTag ..."
    Invoke-Az acr build -r $registry -f "$export/infra/azure/keycloak/Dockerfile" -t "astra-keycloak:$ImageTag" --no-logs "$export/infra/azure/keycloak" -o none
  } finally {
    Remove-Item $export, "$export.tar" -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# 4. Applications (with the final database addresses in the vault), then migrations.
$out = Publish-Template 'applications' $true
Invoke-Job $out.migrateJobName.value

# 5. Wait until each public address answers.
function Wait-Url([string] $url) {
  foreach ($i in 1..60) {
    try { Invoke-WebRequest $url -TimeoutSec 20 | Out-Null; Write-Host "OK $url"; return } catch { Start-Sleep -Seconds 10 }
  }
  throw "No answer from $url"
}
Wait-Url "$issuer/.well-known/openid-configuration"
Wait-Url "https://$($out.apiEndpoint.value)/health/ready"
Wait-Url "https://$($out.workbenchEndpoint.value)/signed-out"

Write-Host ''
Write-Host "Workbench : https://$($out.workbenchEndpoint.value)"
Write-Host "API       : https://$($out.apiEndpoint.value)"
Write-Host "Sign-in   : $issuer"
Write-Host 'User names and passwords: var/azure/dev.secrets.json (admin-user-password is for platform.admin).'
