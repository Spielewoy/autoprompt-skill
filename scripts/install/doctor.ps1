# doctor.ps1 -- read-only provider and installation status matrix.
# Status matrix for every client in the closed provider registry.
# Behavior-faithful twin of doctor.sh. Read-only diagnostics over lib/install-lib.ps1.
#
# For each client: detected? (Detect-Client) installed? (receipt presence under the
# client's config-root) verifies? (Verify-Install). Writes NOTHING, edits NOTHING.
# Usage: doctor.ps1   (no arguments). HOME / XDG_CONFIG_HOME honored if set.

[CmdletBinding()]
param(
    [Parameter(Position = 0)][string]$Target,
    [switch]$Strict
)

$ErrorActionPreference = 'Continue'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Lib = Join-Path $ScriptDir 'lib/install-lib.ps1'
$RepoRoot = (Resolve-Path (Join-Path $ScriptDir '../..')).Path
if (-not (Test-Path -LiteralPath $Lib -PathType Leaf)) {
    [Console]::Error.WriteLine("Autoprompt doctor: library not found at $Lib -- is the repo intact?")
    exit 1
}
. $Lib

$ClientsAll = @('claude','codex','opencode','kilo','vscode','prime')

function Get-HomeDir {
    if ($env:HOME) { return $env:HOME }
    if ($env:USERPROFILE) { return $env:USERPROFILE }
    return [Environment]::GetFolderPath('UserProfile')
}

function Get-ConfigRoot {
    param([string]$Client)
    return (Get-AutopromptConfigRoot -Name $Client)
}

# Get-OpencodeActivationStatus: completeness of the activation-only OpenCode extras
# beyond the hash-bound payload -- the profile beside the user's opencode.json and
# the full native subagent set at the global agents load path.
function Get-OpencodeActivationStatus {
    param([string]$Base, [string]$Skill)
    $profile = Join-Path $Base 'autoprompt.opencode.json'
    if (-not (Test-Path -LiteralPath $profile -PathType Leaf)) {
        return 'missing:autoprompt.opencode.json'
    }
    if (-not (Test-OpencodeProfilePolicy -Path $profile)) {
        return 'invalid:profile-policy'
    }

    $sourceDir = Join-Path $Skill 'agents'
    $nativeDir = Join-Path $Base 'agents'
    $expected = @(Get-ChildItem -LiteralPath $sourceDir -Filter 'ap-*.md' `
        -File -ErrorAction SilentlyContinue | Sort-Object Name)
    $actual = @(Get-ChildItem -LiteralPath $nativeDir -Filter 'ap-*.md' `
        -File -ErrorAction SilentlyContinue | Sort-Object Name)
    if ($expected.Count -ne 25 -or $actual.Count -ne 25) {
        return 'invalid:opencode-native-count'
    }
    for ($index = 0; $index -lt $expected.Count; $index++) {
        if ($expected[$index].Name -cne $actual[$index].Name) {
            return 'invalid:opencode-native-names'
        }
    }

    if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
        return 'invalid:opencode-native-frontmatter'
    }
    $validationScript = @'
import pathlib
import re
import sys
import yaml

directory = pathlib.Path(sys.argv[1])
files = sorted(directory.glob('ap-*.md'))
if len(files) != 25:
    raise ValueError('unexpected agent count')
names = set()
permission_keys = {
    'read', 'edit', 'glob', 'grep', 'bash', 'task', 'webfetch', 'websearch', 'skill'
}
for file in files:
    name = file.stem
    if not re.fullmatch(r'ap-[a-z0-9-]+', name) or name in names:
        raise ValueError('invalid or duplicate agent name')
    names.add(name)
    text = file.read_text(encoding='utf-8')
    match = re.match(r'^---\r?\n([\s\S]*?)\r?\n---\r?\n', text)
    if match is None:
        raise ValueError('missing frontmatter')
    frontmatter = yaml.safe_load(match.group(1))
    if not isinstance(frontmatter, dict) or set(frontmatter) != {
        'description', 'mode', 'permission'
    }:
        raise ValueError('invalid frontmatter keys')
    if not isinstance(frontmatter['description'], str) or not frontmatter['description']:
        raise ValueError('invalid description')
    if frontmatter['mode'] != 'subagent':
        raise ValueError('invalid mode')
    permission = frontmatter['permission']
    if not isinstance(permission, dict) or set(permission) != permission_keys:
        raise ValueError('invalid permission keys')
    if permission['skill'] != 'deny':
        raise ValueError('skill must be denied')
    for key, value in permission.items():
        if key == 'task' and isinstance(value, dict):
            if value != {'*': 'deny', 'ap-*': 'allow'}:
                raise ValueError('invalid task allowlist')
        elif value not in {'allow', 'deny'}:
            raise ValueError('invalid permission value')
'@
    $null = & python -c $validationScript $nativeDir 2>&1
    if ($LASTEXITCODE -ne 0) {
        return 'invalid:opencode-native-frontmatter'
    }
    foreach ($sourceAgent in $expected) {
        $landed = Join-Path $nativeDir $sourceAgent.Name
        if ((Get-IdemSha256 -Path $sourceAgent.FullName) -cne
            (Get-IdemSha256 -Path $landed)) {
            return 'invalid:opencode-native-hash'
        }
    }
    return 'complete'
}

function Get-ClaudeNativeStatus {
    param([string]$Skill)
    $sourceDir = Join-Path $Skill 'agents'
    $nativeDir = Get-AutopromptNativeAgentsRoot -Name 'claude'
    $validator = Join-Path $Skill 'workflow/agent-definitions-cli.js'
    $expected = @(Get-ChildItem -LiteralPath $sourceDir -Filter 'ap-*.md' `
        -File -ErrorAction SilentlyContinue)
    $actual = @(Get-ChildItem -LiteralPath $nativeDir -Filter 'ap-*.md' `
        -File -ErrorAction SilentlyContinue)
    if ($expected.Count -ne 25 -or $actual.Count -ne $expected.Count) {
        return 'invalid:claude-native-count'
    }
    if (-not (Test-Path -LiteralPath $validator -PathType Leaf) -or
        -not (Get-Command node -ErrorAction SilentlyContinue)) {
        return 'invalid:claude-native-frontmatter'
    }
    $validationScript = @'
const fs = require('node:fs')
const path = require('node:path')
const { parseAgentDefinition } = require(process.argv[1])
const directory = process.argv[2]
const files = fs.readdirSync(directory).filter(name => /^ap-.*\.md$/.test(name)).sort()
if (files.length !== 25) throw new Error('unexpected agent count')
const names = new Set()
for (const file of files) {
  const [name] = parseAgentDefinition(path.join(directory, file))
  if (name !== path.basename(file, '.md')) throw new Error('agent name does not match filename')
  if (names.has(name)) throw new Error('duplicate agent name')
  names.add(name)
}
'@
    $null = & node -e $validationScript $validator $nativeDir 2>&1
    if ($LASTEXITCODE -ne 0) {
        return 'invalid:claude-native-frontmatter'
    }
    foreach ($sourceAgent in $expected) {
        $landed = Join-Path $nativeDir $sourceAgent.Name
        if (-not (Test-Path -LiteralPath $landed -PathType Leaf) -or
            (Get-IdemSha256 -Path $sourceAgent.FullName) -cne
            (Get-IdemSha256 -Path $landed)) {
            return 'invalid:claude-native-hash'
        }
    }
    return 'complete'
}

function Get-KiloActivationStatus {
    param([string]$Base, [string]$Skill)
    $profile = Join-Path $Base 'autoprompt.kilo.json'
    if (-not (Test-Path -LiteralPath $profile -PathType Leaf)) {
        return 'missing:autoprompt.kilo.json'
    }
    if (-not (Test-KiloProfilePolicy -Path $profile)) {
        return 'invalid:profile-policy'
    }
    $sourceDir = Join-Path $Skill 'agents'
    $sourceAgents = @(Get-OpencodeAgentFiles -SourceDir $sourceDir)
    if ($sourceAgents.Count -ne 25) { return 'missing:agents' }
    $agentsDir = Join-Path $Base 'agents'
    foreach ($sourceAgent in $sourceAgents) {
        $landed = Join-Path $agentsDir $sourceAgent.Name
        if (-not (Test-Path -LiteralPath $landed -PathType Leaf) -or
            (Get-IdemSha256 -Path $sourceAgent.FullName) -ne
            (Get-IdemSha256 -Path $landed)) {
            return 'invalid:agent-mismatch'
        }
    }
    return 'complete'
}

function Get-VscodeActivationStatus {
    param([string]$Skill)
    $sourceAgents = @(Get-ChildItem -LiteralPath (Join-Path $Skill 'agents') `
        -Filter 'ap-*.agent.md' -File -ErrorAction SilentlyContinue)
    if ($sourceAgents.Count -ne 25) { return 'missing:agents' }
    $agentsDir = Get-AutopromptNativeAgentsRoot -Name 'vscode'
    foreach ($sourceAgent in $sourceAgents) {
        $landed = Join-Path $agentsDir $sourceAgent.Name
        if (-not (Test-Path -LiteralPath $landed -PathType Leaf) -or
            (Get-IdemSha256 -Path $sourceAgent.FullName) -ne
            (Get-IdemSha256 -Path $landed)) {
            return 'invalid:agent-mismatch'
        }
    }
    $helper = Get-VscodeSettingsHelper
    if (-not (Test-Path -LiteralPath $helper -PathType Leaf) -or
        -not (Get-Command node -ErrorAction SilentlyContinue)) {
        return 'activation-missing:settings-helper-unavailable'
    }
    $output = @(& node $helper inspect --file (Get-VscodeSettingsFile) 2>&1)
    if ($LASTEXITCODE -ne 0) {
        $record = $output -join ' '
        $reason = if ($record -match 'reason=(\S+)') {
            $Matches[1]
        } else {
            'settings-invalid'
        }
        return "activation-missing:$reason"
    }
    return 'complete'
}

# Get-ExtrasStatus verifies the exact hash-bound runtime inventory through the
# same manifest tool used by install and deployment. Single-file clients return na.
function Get-ExtrasStatus {
    param([string]$Client)
    $opencodeBase = $null
    switch ($Client) {
        'claude' { $skill = Get-AutopromptRuntimeRoot -Name 'claude' }
        'codex' {
            $codexHome = Get-AutopromptConfigRoot -Name 'codex'
            $skill = Get-AutopromptRuntimeRoot -Name 'codex'
        }
        'opencode' {
            $opencodeBase = Split-Path -Parent `
                (Get-AutopromptProfileFile -Name 'opencode')
            $skill = Get-AutopromptRuntimeRoot -Name 'opencode'
        }
        'kilo' {
            $kiloBase = Split-Path -Parent `
                (Get-AutopromptProfileFile -Name 'kilo')
            $skill = Get-AutopromptRuntimeRoot -Name 'kilo'
        }
        'vscode' { $skill = Get-AutopromptRuntimeRoot -Name 'vscode' }
        default { return 'na' }
    }
    $tool = Join-Path $ScriptDir '../runtime-payload.cjs'
    if (-not (Test-Path -LiteralPath $tool -PathType Leaf) -or -not (Get-Command node -ErrorAction SilentlyContinue)) {
        return 'invalid:runtime-tool-unavailable'
    }
    $output = & node $tool --verify $Client --destination $skill 2>&1
    if ($LASTEXITCODE -eq 0) {
        if ($Client -eq 'codex' -and -not (Test-Path -LiteralPath (Join-Path $codexHome 'autoprompt.config.toml') -PathType Leaf)) {
            return 'missing:autoprompt.config.toml'
        }
        if ($Client -eq 'claude') {
            return (Get-ClaudeNativeStatus -Skill $skill)
        }
        if ($Client -eq 'opencode') {
            return (Get-OpencodeActivationStatus -Base $opencodeBase -Skill $skill)
        }
        if ($Client -eq 'kilo') {
            return (Get-KiloActivationStatus -Base $kiloBase -Skill $skill)
        }
        if ($Client -eq 'vscode') {
            return (Get-VscodeActivationStatus -Skill $skill)
        }
        return 'complete'
    }
    $reason = (($output -join ' ') -replace '^runtime-payload:\s*', '') -replace '\s+', '-'
    return "invalid:$reason"
}

function Test-ClientReceiptInstalled {
    param([string]$Client, [string]$Root)
    $receiptPath = Join-Path $Root $AutopromptReceiptName
    if (-not (Test-Path -LiteralPath $receiptPath -PathType Leaf)) {
        return $false
    }
    $receipt = Read-UninstallReceipt -ConfigRoot $Root
    if ($receipt -isnot [hashtable]) { return $false }
    $resolved = Invoke-LibCapture -Call { Resolve-Destination -Name $Client }
    if ($resolved.Code -ne 0) { return $false }
    $landed = (Get-CopyDestination -Record $resolved.Record).Landed
    foreach ($file in @($receipt.Files)) {
        if (Test-IdemPathEqual -Left $file -Right $landed) { return $true }
    }
    return $false
}

# Invoke-LibCapture: run a library function capturing BOTH its [Console]::Out RECORD and
# its [Console]::Error text, returning @{ Code; Record; Err }. Used read-only here.
function Invoke-LibCapture {
    param([scriptblock]$Call)
    $swOut = New-Object System.IO.StringWriter
    $swErr = New-Object System.IO.StringWriter
    $origOut = [Console]::Out; $origErr = [Console]::Error
    [Console]::SetOut($swOut); [Console]::SetError($swErr)
    try { $code = & $Call } finally { [Console]::SetOut($origOut); [Console]::SetError($origErr) }
    return @{ Code = [int]$code; Record = $swOut.ToString().Trim(); Err = $swErr.ToString().Trim() }
}

function Get-ClientStatus {
    param([string]$Client)
    if ($Client -ceq 'prime') {
        $root = Get-ConfigRoot -Client 'prime'
        $det = Invoke-LibCapture -Call { Detect-Client -Name 'prime' }
        $detected = if ($det.Code -eq 0) { 'yes' } else { 'no' }
        $version = if ($det.Code -eq 0) {
            $det.Record -replace '^.*version=', ''
        } else { '-' }
        $installed = if (Test-Path -LiteralPath (
            Join-Path $root '.autoprompt-prime-install.json'
        ) -PathType Leaf) { 'yes' } else { 'no' }
        $verifies = 'no'
        $reason = '-'
        $extras = 'invalid:prime-lifecycle'
        $helper = Join-Path $ScriptDir 'prime-lifecycle.cjs'
        $primeCommand = if ($detected -ceq 'yes') {
            Get-Command $AutopromptClientBin['prime'] -CommandType Application `
                -ErrorAction SilentlyContinue | Select-Object -First 1
        } else { $null }
        $primeCli = if ($primeCommand) { [string]$primeCommand.Source } else { '' }
        if (-not (Get-Command node -ErrorAction SilentlyContinue) -or
            -not (Test-Path -LiteralPath $helper -PathType Leaf) -or
            ($detected -ceq 'yes' -and [string]::IsNullOrEmpty($primeCli))) {
            $reason = 'runtime-unavailable'
        } else {
            $arguments = @($helper, 'doctor', '--repo-root', $RepoRoot)
            if ($detected -ceq 'yes') { $arguments += @('--prime-cli', $primeCli) }
            $output = @(& node @arguments 2>&1)
            $code = $LASTEXITCODE
            if ($code -eq 0) {
                $verifies = 'yes'
                $extras = 'complete'
            } else {
                $match = [regex]::Match(($output -join "`n"), '"reason":"([^"]+)"')
                if ($match.Success) { $reason = $match.Groups[1].Value }
                else { $reason = 'prime-lifecycle-invalid' }
            }
        }
        if ($detected -ceq 'yes' -and $version -cne '0.7.2') {
            $verifies = 'no'
            $reason = 'version-mismatch'
            $extras = 'invalid:version-mismatch'
        }
        return @{
            Detected = $detected; Installed = $installed; Verifies = $verifies
            Version = $version; Reason = $reason; Extras = $extras
            Mode = '-'; Support = 'supported'
        }
    }
    $root = Get-ConfigRoot -Client $Client
    $support = Get-ProviderStatus -Name $Client

    $det = Invoke-LibCapture -Call { Detect-Client -Name $Client }
    $detected = 'no'; $version = '-'
    if ($det.Code -eq 0) {
        $detected = 'yes'
        $version = ($det.Record -replace '^.*version=', '')
    }

    $installed = 'no'
    if (Test-ClientReceiptInstalled -Client $Client -Root $root) {
        $installed = 'yes'
    }

    if ($support -in @('blocked', 'retired', 'unverified')) {
        return @{
            Detected = $detected
            Installed = $installed
            Verifies = 'no'
            Version = $version
            Reason = (Get-ProviderBlockReason -Name $Client)
            Extras = $support
            Mode = '-'
            Support = $support
        }
    }

    $vk = Invoke-LibCapture -Call { Verify-Install -Name $Client }
    $verifies = 'no'; $reason = '-'
    if ($vk.Code -eq 0) {
        $verifies = 'yes'
    } else {
        $m = [regex]::Match($vk.Err, 'reason=(\S+)')
        if ($m.Success) { $reason = $m.Groups[1].Value }
    }

    $mode = '-'
    return @{ Detected = $detected; Installed = $installed; Verifies = $verifies; Version = $version; Reason = $reason; Extras = (Get-ExtrasStatus -Client $Client); Mode = $mode; Support = $support }
}

# --- main ---
if (-not [string]::IsNullOrEmpty($Target) -and $ClientsAll -notcontains $Target) {
    [Console]::Error.WriteLine("Usage: doctor.ps1 [client] [-Strict]")
    exit 2
}
if (-not (Test-AutopromptInstallRootContract -Target $Target)) { exit 2 }

[Console]::Out.WriteLine("==== Autoprompt doctor ====")
[Console]::Out.WriteLine(("{0,-9} {1,-9} {2,-10} {3,-10} {4}" -f 'client','detected','installed','verifies','detail'))
[Console]::Out.WriteLine('---------------------------------------------------------------')
$clients = if ([string]::IsNullOrEmpty($Target)) { $ClientsAll } else { @($Target) }
$strictFailure = $false
foreach ($c in $clients) {
    $s = Get-ClientStatus -Client $c
    $detail = "version=$($s.Version) reason=$($s.Reason) extras=$($s.Extras)"
    if ($s.Support -in @('blocked', 'retired', 'unverified')) {
        $detail += " support=$($s.Support)"
    }
    [Console]::Out.WriteLine(("{0,-9} {1,-9} {2,-10} {3,-10} {4}" -f $c, $s.Detected, $s.Installed, $s.Verifies, $detail))
    if ($Strict -and ($s.Detected -cne 'yes' -or $s.Installed -cne 'yes' -or
        $s.Verifies -cne 'yes' -or $s.Extras -notin @('complete', 'na'))) {
        $strictFailure = $true
    }
}
[Console]::Out.WriteLine("============================")
if ($strictFailure) { exit 1 }
exit 0
