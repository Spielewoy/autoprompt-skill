Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

function Stop-Activation {
    param([string]$Message)
    [Console]::Error.WriteLine("grok activation error: $Message")
    exit 1
}

# The activation profile is Autoprompt's own harness contract, not Grok Build
# configuration: the dispatcher reads it, so every pinned line must be present
# and unmodified before a run starts.
function Test-ActivationProfile {
    param([string[]]$Lines)

    $required = @(
        'runtime = "grok-build-adapter-v1"',
        'max_depth = 4',
        'dispatch = "sealed-headless-reentry"',
        'mcp_server = "autoprompt"',
        'native_subagent_spawn = "denied"'
    )
    $normalized = @($Lines | ForEach-Object { $_.TrimEnd("`r") })
    foreach ($line in $required) {
        if (@($normalized | Where-Object { $_ -ceq $line }).Count -ne 1) { return $false }
    }
    foreach ($line in $normalized) {
        if ($line -match '^\s*$' -or $line.StartsWith('#')) { continue }
        if ($line -match '^\[[a-z_.]+\]$') { continue }
        if ($line -match '^[a-z_]+ = ') { continue }
        return $false
    }
    return $true
}

# The one registration Autoprompt needs inside Grok Build: an stdio MCP server
# named autoprompt whose command is the installed sealed dispatch server.
function Test-McpRegistration {
    param([string[]]$Lines, [string]$ServerPath)

    $inSection = $false
    $hasCommand = $false
    $hasArgument = $false
    foreach ($raw in $Lines) {
        $line = $raw.TrimEnd("`r")
        if ($line -ceq '[mcp_servers.autoprompt]') { $inSection = $true; continue }
        if ($line -match '^\[') { $inSection = $false; continue }
        if (-not $inSection) { continue }
        if ($line -match '^command = ') { $hasCommand = $true }
        if ($line.Contains($ServerPath)) { $hasArgument = $true }
    }
    return ($hasCommand -and $hasArgument)
}

# The activation capability. Grok Build serves user-scoped MCP servers to every
# session, so the dispatch tool alone cannot prove a run was started here. This
# token is minted per launch, lives only in this process tree, and is what the
# dispatcher requires before it will admit a depth-0 conductor.
function New-ActivationToken {
    $bytes = [byte[]]::new(16)
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    return ('ap' + -join ($bytes | ForEach-Object { $_.ToString('x2') }))
}

function Test-SupportedVersion {
    param([string]$Version)
    if ($Version -notmatch '^(\d+)\.(\d+)\.(\d+)$') { return $false }
    return ([int]$Matches[1] -ge 1)
}

$forwardArguments = @($args)
$checkOnly = $false
if ($forwardArguments.Count -gt 0 -and $forwardArguments[0] -ceq '--check') {
    $checkOnly = $true
    if ($forwardArguments.Count -gt 1) {
        Stop-Activation '--check does not accept Grok Build arguments'
    }
    $forwardArguments = @()
}

$homeDirectory = if ($env:HOME) {
    $env:HOME
} elseif ($env:USERPROFILE) {
    $env:USERPROFILE
} else {
    [Environment]::GetFolderPath('UserProfile')
}
$configRoot = if ($env:GROK_HOME) { $env:GROK_HOME } else { Join-Path $homeDirectory '.grok' }
$runtimeRoot = Join-Path $configRoot 'skills/autoprompt'
$profilePath = Join-Path $configRoot 'autoprompt.grok.toml'
$configPath = Join-Path $configRoot 'config.toml'
$dispatchServer = Join-Path $runtimeRoot 'workflow/grok-dispatch-server.js'

if (-not (Test-Path -LiteralPath $profilePath -PathType Leaf)) {
    Stop-Activation "activation profile not found: $profilePath"
}
if (-not (Test-Path -LiteralPath $dispatchServer -PathType Leaf)) {
    Stop-Activation "sealed dispatch server not found: $dispatchServer"
}
if (-not (Test-Path -LiteralPath (Join-Path $runtimeRoot 'agents') -PathType Container)) {
    Stop-Activation "persona definitions not found under $runtimeRoot/agents"
}
if (-not (Test-ActivationProfile -Lines @(Get-Content -LiteralPath $profilePath))) {
    Stop-Activation "activation profile is unsafe: $profilePath"
}
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    Stop-Activation "Grok Build configuration not found: $configPath"
}
if (-not (Test-McpRegistration -Lines @(Get-Content -LiteralPath $configPath) -ServerPath $dispatchServer)) {
    Stop-Activation "config.toml does not register the autoprompt dispatch server: $configPath"
}

$nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
if ($null -eq $nodeCommand) {
    Stop-Activation 'node is required to run the sealed dispatcher'
}

$grokCommand = Get-Command grok -CommandType Application,ExternalScript -ErrorAction SilentlyContinue |
    Select-Object -First 1
if ($null -eq $grokCommand) {
    Stop-Activation 'grok executable not found on PATH'
}
$grokPath = $grokCommand.Source

$versionOutput = @(& $grokPath --version 2>$null)
if ($LASTEXITCODE -ne 0) {
    Stop-Activation 'could not read the Grok Build version'
}
$versionText = $versionOutput -join "`n"
if ($versionText -notmatch '(\d+\.\d+\.\d+)') {
    Stop-Activation 'could not parse the Grok Build version'
}
$version = $Matches[1]
if (-not (Test-SupportedVersion -Version $version)) {
    Stop-Activation "Grok Build $version is older than required 1.0.0"
}

# Scoped to this wrapper process and the Grok Build session it starts. The
# dispatcher reads them to resolve the installed runtime, to prove activation, and
# to seal depth 0. Model and effort are run-wide: every process hop reapplies them,
# so they are validated once here and then travel with the run.
$env:AUTOPROMPT_GROK_RUNTIME_ROOT = $runtimeRoot
$env:AUTOPROMPT_GROK_BIN = $grokPath
$env:AUTOPROMPT_GROK_DEPTH = '0'
$env:AUTOPROMPT_GROK_ACTIVATION = New-ActivationToken
$env:GROK_DISABLE_AUTOUPDATER = '1'
Remove-Item Env:AUTOPROMPT_GROK_PERSONA -ErrorAction SilentlyContinue
Remove-Item Env:AUTOPROMPT_GROK_BINDING -ErrorAction SilentlyContinue
Remove-Item Env:AUTOPROMPT_GROK_NONCE -ErrorAction SilentlyContinue

if ($env:AUTOPROMPT_GROK_MODEL -and
    $env:AUTOPROMPT_GROK_MODEL -notmatch '^[A-Za-z0-9][A-Za-z0-9._:/-]*$') {
    Stop-Activation 'AUTOPROMPT_GROK_MODEL is not a safe model identifier'
}
if ($env:AUTOPROMPT_GROK_EFFORT -and
    $env:AUTOPROMPT_GROK_EFFORT -cnotin @('low', 'medium', 'high', 'xhigh')) {
    Stop-Activation 'AUTOPROMPT_GROK_EFFORT must be low, medium, high, or xhigh'
}

if ($checkOnly) {
    [Console]::Out.WriteLine("grok activation policy: ok profile=$profilePath runtime=$runtimeRoot version=$version activation=minted")
    exit 0
}

& $grokPath @forwardArguments
exit $LASTEXITCODE
