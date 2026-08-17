Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

function Stop-Activation {
    param([string]$Message)
    [Console]::Error.WriteLine("opencode activation error: $Message")
    exit 1
}

function Test-ActivationPolicy {
    param(
        [Parameter(Mandatory = $true)]$Config,
        [switch]$RequireSchema
    )

    if ($RequireSchema -and $Config.'$schema' -cne 'https://opencode.ai/config.json') {
        return $false
    }
    if ($Config.subagent_depth -ne 4 -or $Config.share -cne 'disabled') {
        return $false
    }
    if ($null -eq $Config.permission -or $null -eq $Config.permission.task) {
        return $false
    }

    $rules = @($Config.permission.task.PSObject.Properties)
    if ($rules.Count -ne 2) { return $false }
    if ($rules[0].Name -cne '*' -or [string]$rules[0].Value -cne 'deny') { return $false }
    if ($rules[1].Name -cne 'ap-*' -or [string]$rules[1].Value -cne 'allow') { return $false }
    return $true
}

function Test-SupportedVersion {
    param([string]$Version)
    if ($Version -notmatch '^(\d+)\.(\d+)\.(\d+)$') { return $false }
    $major = [int]$Matches[1]
    $minor = [int]$Matches[2]
    $patch = [int]$Matches[3]
    if ($major -ne 1) { return $major -gt 1 }
    if ($minor -ne 18) { return $minor -gt 18 }
    return $patch -ge 7
}

$forwardArguments = @($args)
$checkOnly = $false
if ($forwardArguments.Count -gt 0 -and $forwardArguments[0] -ceq '--check') {
    $checkOnly = $true
    if ($forwardArguments.Count -gt 1) {
        Stop-Activation '--check does not accept OpenCode arguments'
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
$configRoot = if ($env:XDG_CONFIG_HOME) { $env:XDG_CONFIG_HOME } else { Join-Path $homeDirectory '.config' }
$profile = Join-Path $configRoot 'opencode/autoprompt.opencode.json'
if (-not (Test-Path -LiteralPath $profile -PathType Leaf)) {
    Stop-Activation "dedicated activation profile not found: $profile"
}

try {
    $profileConfig = Get-Content -Raw -LiteralPath $profile | ConvertFrom-Json
} catch {
    Stop-Activation "dedicated activation profile is not valid JSON: $profile"
}
if (-not (Test-ActivationPolicy -Config $profileConfig -RequireSchema)) {
    Stop-Activation "dedicated activation profile is unsafe: $profile"
}

$opencodeCommand = Get-Command opencode -CommandType Application,ExternalScript -ErrorAction SilentlyContinue |
    Select-Object -First 1
if ($null -eq $opencodeCommand) {
    Stop-Activation 'opencode executable not found on PATH'
}
$opencodePath = $opencodeCommand.Source

# These values are scoped to this wrapper process and its OpenCode children.
# Inline config wins over project config. OPENCODE_PERMISSION is applied last by
# OpenCode 1.18.7+ and closes task rules added by lower-precedence sources.
$env:OPENCODE_CONFIG = $profile
$env:OPENCODE_CONFIG_CONTENT = '{"subagent_depth":4,"share":"disabled","permission":{"task":{"*":"deny","ap-*":"allow"}}}'
$env:OPENCODE_PERMISSION = '{"task":{"*":"deny","ap-*":"allow"}}'
$env:OPENCODE_DISABLE_EXTERNAL_SKILLS = '1'

$versionOutput = @(& $opencodePath --version 2>$null)
if ($LASTEXITCODE -ne 0) {
    Stop-Activation 'could not read the OpenCode version'
}
$versionText = $versionOutput -join "`n"
if ($versionText -notmatch '(\d+\.\d+\.\d+)') {
    Stop-Activation 'could not parse the OpenCode version'
}
$version = $Matches[1]
if (-not (Test-SupportedVersion -Version $version)) {
    Stop-Activation "OpenCode $version is older than required 1.18.7"
}

$resolvedOutput = @(& $opencodePath debug config --pure 2>$null)
if ($LASTEXITCODE -ne 0) {
    Stop-Activation 'could not resolve the activation configuration'
}
try {
    $resolvedConfig = ($resolvedOutput -join "`n") | ConvertFrom-Json
} catch {
    Stop-Activation 'resolved activation configuration is not valid JSON'
}
if (-not (Test-ActivationPolicy -Config $resolvedConfig)) {
    Stop-Activation 'resolved activation policy is unsafe'
}

if ($checkOnly) {
    [Console]::Out.WriteLine("opencode activation policy: ok profile=$profile version=$version")
    exit 0
}

& $opencodePath @forwardArguments
exit $LASTEXITCODE
