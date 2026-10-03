param([Parameter(Mandatory=$true)][string]$Output)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repository = 'Spielewoy/autoprompt-skill'
$repositoryId = 1337733621
$runId = 35670972446
$head = '190df188c5b01c576facc1ccdc9f94de48391c4a'
$artifactId = 10671041821
$digest = '68a45f7bb299c0b15cbd39cd7d2e58e994ea373b250f8649a2ad77cf8b918a82'
$headers = @{ Accept='application/vnd.github+json'; Authorization="Bearer $env:GITHUB_TOKEN"; 'X-GitHub-Api-Version'='2022-11-28' }
$api = "https://api.github.com/repos/$repository"
$run = Invoke-RestMethod -Headers $headers -Uri "$api/actions/runs/$runId"
if ($run.id -ne $runId -or $run.head_sha -ne $head -or $run.run_attempt -ne 1 -or $run.status -ne 'completed' -or $run.repository.full_name -ne $repository -or $run.head_repository.full_name -ne $repository) { throw 'CI46 run mismatch' }
$jobs = Invoke-RestMethod -Headers $headers -Uri "$api/actions/runs/$runId/jobs?per_page=100"
$job = @($jobs.jobs | Where-Object { $_.id -eq 106567111565 })
if ($job.Count -ne 1 -or @($job[0].steps | Where-Object { $_.name -eq 'Build one isolated diagnostic MSYS runtime' -and $_.conclusion -eq 'success' }).Count -ne 1) { throw 'CI46 compiler did not succeed' }
$artifact = Invoke-RestMethod -Headers $headers -Uri "$api/actions/artifacts/$artifactId"
if ($artifact.id -ne $artifactId -or $artifact.name -ne 'windows-pipe-io-trace' -or $artifact.expired -or $artifact.size_in_bytes -ne 1628566 -or $artifact.digest -ne "sha256:$digest") { throw 'CI46 artifact mismatch' }
if ($artifact.workflow_run.id -ne $runId -or $artifact.workflow_run.head_sha -ne $head -or $artifact.workflow_run.repository_id -ne $repositoryId -or $artifact.workflow_run.head_repository_id -ne $repositoryId) { throw 'CI46 producer mismatch' }
$root = Join-Path $Output 'ci46-reuse'
New-Item -ItemType Directory -Path $root -ErrorAction Stop | Out-Null
$zip = Join-Path $root 'artifact.zip'
Invoke-WebRequest -UseBasicParsing -Headers $headers -Uri "$api/actions/artifacts/$artifactId/zip" -OutFile $zip
if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $digest) { throw 'CI46 ZIP mismatch' }
$extracted = Join-Path $root 'extracted'
Expand-Archive -LiteralPath $zip -DestinationPath $extracted -ErrorAction Stop
Copy-Item -LiteralPath (Join-Path $extracted 'msys-mapping-proof/pipe-trace-inputs') -Destination (Join-Path $Output 'pipe-trace-inputs') -Recurse -ErrorAction Stop
[ordered]@{schema=1;runId=$runId;headSha=$head;artifactId=$artifactId;archiveSha256=$digest;compilerSucceeded=$true;nativeAcceptance=$false} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Output 'ci46-reuse.json') -Encoding utf8
$payload = Join-Path $extracted 'msys-pipe-trace-build/sdk/issue27-build'
if (-not (Test-Path -LiteralPath (Join-Path $payload 'stage/usr/bin/msys-2.0.dll') -PathType Leaf)) { throw 'CI46 built DLL missing' }
$payload | Set-Content -LiteralPath (Join-Path $Output 'reused-payload-path.txt') -Encoding utf8
