[CmdletBinding()]
param(
    [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'

function Require-Command {
    param([Parameter(Mandatory = $true)][string]$Name, [Parameter(Mandatory = $true)][string]$InstallUrl)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "$Name is required. Install it from $InstallUrl"
    }
}

Require-Command -Name 'node' -InstallUrl 'https://nodejs.org/en/download'
Require-Command -Name 'npm' -InstallUrl 'https://nodejs.org/en/download'
Require-Command -Name 'python' -InstallUrl 'https://www.python.org/downloads/'

$nodeMajor = [int](& node -p "Number(process.versions.node.split('.')[0])")
if ($nodeMajor -lt 20) {
    throw "Node.js 20 or newer is required. Found $(& node --version)."
}

& python -c "import sys, yaml; assert sys.version_info >= (3, 11)"
if ($LASTEXITCODE -ne 0) {
    throw 'Python 3.11 or newer with PyYAML is required. Run: python -m pip install PyYAML'
}

$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$bundled = @(Get-ChildItem -LiteralPath $scriptDirectory -Filter 'autoprompt-skill-*.tgz' -File)
if ($bundled.Count -gt 1) {
    throw 'The release kit contains more than one npm archive.'
}

$package = if ($bundled.Count -eq 1) { $bundled[0].FullName } else { 'autoprompt-skill' }
Write-Host "Installing Autoprompt skill from $package"
& npm install --global --ignore-scripts --no-audit --no-fund $package
if ($LASTEXITCODE -ne 0) {
    throw "npm install failed with exit code $LASTEXITCODE."
}

$autoprompt = Get-Command 'autoprompt' -ErrorAction SilentlyContinue
if (-not $autoprompt) {
    Write-Host 'Installed successfully. Open a new terminal, then run: autoprompt'
    exit 0
}

Write-Host "Installed Autoprompt skill $(& autoprompt version)."
if (-not $NoLaunch -and [Environment]::UserInteractive) {
    & autoprompt
    exit $LASTEXITCODE
}

Write-Host 'Run autoprompt to open the provider installer.'
