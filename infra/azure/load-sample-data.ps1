# Loads the invented sample data set into the development environment: builds the API image from a commit, creates the
# job and starts it. The job adds and never deletes; running it again carries on or tops up.
#   ./infra/azure/load-sample-data.ps1 -Subscription '<name or id>' [-Policies 3000]
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $Subscription,
  [string] $ResourceGroup = 'rg-astra-travel-dev',
  [string] $ImageTag,
  [switch] $SkipBuild,
  [int] $Policies = 3000,
  [int] $OpenQuotes = 500,
  [int] $CardholdersPerProgramme = 40000
)
$ErrorActionPreference = 'Stop'
Set-Location (Resolve-Path "$PSScriptRoot/../..")
$env:PYTHONIOENCODING = 'utf-8'

function Invoke-Az {
  $out = & az @args --subscription $Subscription
  if ($LASTEXITCODE -ne 0) { throw "az $($args[0..2] -join ' ') failed" }
  $out
}

if (-not $ImageTag) { $ImageTag = (git rev-parse --short=12 HEAD).Trim() }

if (-not $SkipBuild) {
  $registry = Invoke-Az acr list -g $ResourceGroup --query '[0].name' -o tsv --only-show-errors
  $export = Join-Path ([IO.Path]::GetTempPath()) "astra-sample-$ImageTag"
  if (Test-Path $export) { Remove-Item $export -Recurse -Force }
  New-Item -ItemType Directory $export | Out-Null
  try {
    git archive --format=tar -o "$export.tar" $ImageTag
    if ($LASTEXITCODE -ne 0) { throw "Commit $ImageTag could not be exported." }
    tar -xf "$export.tar" -C $export
    if ($LASTEXITCODE -ne 0) { throw 'The export could not be unpacked.' }
    Write-Host "Building astra-api:$ImageTag ..."
    Invoke-Az acr build -r $registry -f "$export/infra/docker/Dockerfile" --target api -t "astra-api:$ImageTag" --no-logs $export -o none --only-show-errors
  } finally {
    Remove-Item $export, "$export.tar" -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Write-Host 'Creating the job ...'
$job = Invoke-Az deployment group create -g $ResourceGroup -n "sample-data-$(Get-Date -Format 'yyyyMMddHHmmss')" `
  --template-file infra/azure/sample-data.bicep --parameters "imageTag=$ImageTag" "policies=$Policies" "openQuotes=$OpenQuotes" "cardholdersPerProgramme=$CardholdersPerProgramme" `
  --query properties.outputs.jobName.value -o tsv --only-show-errors
$run = Invoke-Az containerapp job start -g $ResourceGroup -n $job --query name -o tsv --only-show-errors
Write-Host "Job $job started ($run)"
foreach ($i in 1..480) {
  Start-Sleep -Seconds 30
  $status = Invoke-Az containerapp job execution show -g $ResourceGroup -n $job --job-execution-name $run --query properties.status -o tsv --only-show-errors
  if ($status -in 'Succeeded', 'Failed', 'Degraded') { break }
}
if ($status -ne 'Succeeded') { throw "The load ended as $status. See the job's logs in the environment's Log Analytics workspace." }
Write-Host 'Sample data loaded.'
