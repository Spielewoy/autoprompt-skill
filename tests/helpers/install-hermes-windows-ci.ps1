param(
    [Parameter(Mandatory = $true)] [string] $OutputRoot
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$commit = '2237be355906fbe6065ce1815711eee52b2d646e'
$archiveSha256 = '9ba535365d459300692a4275f28f4ca716770372eac8f9296a6733669d3c9cd7'
$installerSha256 = '53a077364aa28bbd6e8d987cdec11a4552e22ff2c5137845725a1c99770f392f'
$pyprojectSha256 = '1f0d8d7e9e19c3a1cc25521a5cf56f3c885e4604d3081246cd42d9924a983174'

if (-not $IsWindows) { throw 'The official Hermes Windows installer probe requires Windows' }
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
if (Test-Path -LiteralPath $OutputRoot) {
    $item = Get-Item -LiteralPath $OutputRoot -Force
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Hermes evidence output root is linked or invalid'
    }
    if (@(Get-ChildItem -LiteralPath $OutputRoot -Force).Count -ne 0) {
        throw 'Hermes evidence output root must be empty'
    }
} else {
    New-Item -ItemType Directory -Path $OutputRoot | Out-Null
}

$archive = Join-Path $OutputRoot 'hermes-agent-0.21.1.zip'
$sourceParent = Join-Path $OutputRoot 'source'
$hermesHome = Join-Path $OutputRoot 'home'
$install = Join-Path $hermesHome 'hermes-agent'
$log = Join-Path $OutputRoot 'official-installer.log'
$url = "https://github.com/NousResearch/hermes-agent/archive/$commit.zip"
Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $archive
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant() -cne $archiveSha256) {
    throw 'Pinned Hermes source archive hash changed'
}
New-Item -ItemType Directory -Path $sourceParent | Out-Null
Expand-Archive -LiteralPath $archive -DestinationPath $sourceParent
$source = Join-Path $sourceParent "hermes-agent-$commit"
$installer = Join-Path $source 'scripts/install.ps1'
$pyproject = Join-Path $source 'pyproject.toml'
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $installer).Hash.ToLowerInvariant() -cne $installerSha256 -or
    (Get-FileHash -Algorithm SHA256 -LiteralPath $pyproject).Hash.ToLowerInvariant() -cne $pyprojectSha256) {
    throw 'Pinned Hermes installer source hash changed'
}
$projectText = Get-Content -Raw -LiteralPath $pyproject
if ($projectText -cnotmatch '(?m)^version = "0\.21\.1"$') {
    throw 'Pinned Hermes source is not version 0.21.1'
}

# The official installer clones its default branch before honouring -Commit.
# Its clone path replaces GIT_CONFIG_COUNT with its Windows atomic-write
# setting, so an inherited autocrlf policy cannot protect that first checkout.
# Start it with a clean, ordinary Git working tree at the already verified
# archive commit instead. This is intentionally not a vendor patch or a fake
# launcher: the official installer still owns venv and launcher installation.
New-Item -ItemType Directory -Force -Path $hermesHome | Out-Null
if (Test-Path -LiteralPath $install) { throw 'Pinned Hermes install root unexpectedly exists before archive checkout' }
Copy-Item -LiteralPath $source -Destination $install -Recurse -Force
$repoUrlHttps = 'https://github.com/NousResearch/hermes-agent.git'
function Invoke-PinnedHermesGit {
    param([string[]] $Arguments)
    & git -C $install -c windows.appendAtomically=false @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Pinned Hermes archive checkout failed: git $($Arguments -join ' ')" }
}
Invoke-PinnedHermesGit @('init')
Invoke-PinnedHermesGit @('config', '--local', 'core.autocrlf', 'false')
Invoke-PinnedHermesGit @('remote', 'add', 'origin', $repoUrlHttps)
Invoke-PinnedHermesGit @('fetch', '--depth', '1', 'origin', $commit)
Invoke-PinnedHermesGit @('checkout', '--force', '--detach', 'FETCH_HEAD')
$archiveHead = (& git -C $install rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $archiveHead -cne $commit) { throw 'Pinned Hermes archive checkout did not resolve the requested commit' }
$archiveStatus = (& git -C $install status --porcelain) -join "`n"
if ($LASTEXITCODE -ne 0 -or -not [string]::IsNullOrWhiteSpace($archiveStatus)) { throw 'Pinned Hermes archive checkout is not clean before the official installer' }

$pwsh = Join-Path $PSHOME 'pwsh.exe'
$installerExit = 1
& $pwsh -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $installer `
    -Commit $commit -ForceCommit -HermesHome $hermesHome -InstallDir $install `
    -SkipSetup -SkipComputerUse -NonInteractive *>&1 | Tee-Object -FilePath $log
if ($null -ne $LASTEXITCODE) { $installerExit = [int]$LASTEXITCODE }
if ($installerExit -ne 0) { throw "Pinned Hermes installer failed with exit code $installerExit" }
if (-not (Test-Path -LiteralPath $log -PathType Leaf)) { throw 'Pinned Hermes installer produced no lifecycle log' }

$publicLauncher = Join-Path $hermesHome 'bin/hermes.exe'
$venvLauncher = Join-Path $install 'venv/Scripts/hermes.exe'
$python = Join-Path $install 'venv/Scripts/python.exe'
foreach ($file in @($publicLauncher, $venvLauncher, $python)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Hermes installer omitted $file" }
    if ((Get-Item -LiteralPath $file -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "Hermes installer produced a linked executable: $file"
    }
}
$head = (& git -C $install rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $head -cne $commit) { throw 'Hermes installer checkout differs from the pinned release commit' }

$pairs = [ordered]@{
    AUTOPROMPT_HERMES_WINDOWS_SOURCE_ROOT = $source
    AUTOPROMPT_HERMES_WINDOWS_HOME = $hermesHome
    AUTOPROMPT_HERMES_WINDOWS_INSTALL_ROOT = $install
    AUTOPROMPT_HERMES_WINDOWS_CLI = $publicLauncher
    AUTOPROMPT_HERMES_WINDOWS_VENV_CLI = $venvLauncher
    AUTOPROMPT_HERMES_WINDOWS_PYTHON = $python
    AUTOPROMPT_HERMES_WINDOWS_INSTALLER_LOG = $log
}
if ($env:GITHUB_ENV) {
    foreach ($entry in $pairs.GetEnumerator()) { Add-Content -LiteralPath $env:GITHUB_ENV -Value "$($entry.Key)=$($entry.Value)" }
}
$pairs | ConvertTo-Json -Compress
