# install.ps1 -- runnable entry point that installs Autoprompt for one client or all.
#
# Behavior-faithful twin of install.sh. THIN ORCHESTRATOR over the dot-sourced library
# (lib/install-lib.ps1): it reads the skill payload, strips its source frontmatter, and
# drives the library's public pipeline per client --
#
#   Test-Precheck -> Install-Idempotent -> (codex only) Edit-CodexAgentsConfig
#                 -> Write-Receipt -> Verify-Install
#
# RECEIPT MODEL (load-bearing, same as the .sh): the library writes ONE receipt per
# CONFIG-ROOT and accumulates created files/edits into $script:AutopromptReceiptFiles /
# $script:AutopromptReceiptEdits. Several clients can share a root ($HOME for most; the
# XDG base for opencode/kilo), so `all` accumulates every client under a root then writes
# that root's receipt ONCE -- a per-client receipt would overwrite its predecessor and
# strand files from uninstall. An incremental single-client install pre-seeds the
# accumulators from any existing receipt so prior clients survive in the rewrite.
#
# Test isolation: HOME / XDG_CONFIG_HOME (and CODEX_HOME) are honored if set; nothing
# hardcodes the real home. Exit 0 iff nothing attempted FAILED.

[CmdletBinding()]
param([Parameter(Position = 0)][string]$Target)

$ErrorActionPreference = 'Continue'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Lib = Join-Path $ScriptDir 'lib/install-lib.ps1'
$RepoRoot = (Resolve-Path (Join-Path $ScriptDir '../..')).Path

if (-not (Test-Path -LiteralPath $Lib -PathType Leaf)) {
    [Console]::Error.WriteLine("Autoprompt install: library not found at $Lib -- is the repo intact?")
    exit 1
}
. $Lib

$ClientsAll = @(
    'claude','codex','opencode','kilo','vscode','prime','omp','deepseek','reasonix'
)
$script:ResultRows = @()
$script:AnyFail = 0
$script:IsRecoveryRetained = $false
$LegacyCodexRecoveryName = '.autoprompt-legacy-codex-recovery.clixml'

function Get-InstallExitCode {
    if ($script:IsRecoveryRetained) { return 77 }
    return $script:AnyFail
}

function Write-Usage {
    [Console]::Error.WriteLine("Usage: install.ps1 <client>|all")
    [Console]::Error.WriteLine("  clients: $($ClientsAll -join ' ')")
}

function Get-HomeDir {
    if ($env:HOME) { return $env:HOME }
    if ($env:USERPROFILE) { return $env:USERPROFILE }
    return [Environment]::GetFolderPath('UserProfile')
}

function Get-Nonce {
    return "CL-$(Get-Date -Format 'yyyyMMddHHmmss')-$PID-$(Get-Random)$(Get-Random)"
}

function Get-PayloadFile {
    param([string]$Client)
    switch ($Client) {
        'claude'   { return (Join-Path $RepoRoot 'agents/claude/SKILL.md') }
        'codex'    { return (Join-Path $RepoRoot 'agents/codex/SKILL.md') }
        'opencode' { return (Join-Path $RepoRoot 'agents/opencode/SKILL.md') }
        'kilo'     { return (Join-Path $RepoRoot 'agents/kilo/SKILL.md') }
        'vscode'   { return (Join-Path $RepoRoot 'agents/vscode/SKILL.md') }
        'omp'      { return (Join-Path $RepoRoot 'agents/omp/SKILL.md') }
        'deepseek' { return (Join-Path $RepoRoot 'agents/deepseek/SKILL.md') }
        'reasonix' { return (Join-Path $RepoRoot 'agents/reasonix/SKILL.md') }
        default    { return $null }
    }
}

# Get-PayloadBody: the skill body with its leading --- frontmatter STRIPPED (Format-Skill
# refuses a body that still carries a fence, code 6). Read as UTF-8 so glyphs survive.
function Get-PayloadBody {
    param([string]$File)
    $text = [System.IO.File]::ReadAllText($File, [System.Text.UTF8Encoding]::new($false))
    $marker = "---`n"
    $norm = $text -replace "`r`n", "`n"
    $parts = $norm -split [regex]::Escape($marker)
    if ($parts.Count -ge 3) { return ($parts[2..($parts.Count - 1)] -join $marker) }
    return $norm
}

# Get-PayloadField: read the name/description scalars used by the shipped manifests.
# Claude uses a folded description block; Codex uses an inline quoted description.
function Get-PayloadField {
    param([string]$File, [string]$Key)
    $norm = ([System.IO.File]::ReadAllText($File, [System.Text.UTF8Encoding]::new($false))) -replace "`r`n", "`n"
    $lines = (($norm -split "---`n")[1]) -split "`n"
    for ($index = 0; $index -lt $lines.Count; $index++) {
        if ($lines[$index] -notmatch "^$([regex]::Escape($Key)):\s*(.*)$") { continue }

        $val = $Matches[1].Trim()
        if ($val -in @('>', '|')) {
            $parts = @()
            for ($blockIndex = $index + 1; $blockIndex -lt $lines.Count; $blockIndex++) {
                if ($lines[$blockIndex] -notmatch '^  (.*)$') { break }
                $parts += $Matches[1]
            }
            return $(if ($val -eq '>') { $parts -join ' ' } else { $parts -join "`n" })
        }
        if ($val.StartsWith("'") -and $val.EndsWith("'") -and $val.Length -ge 2) {
            return ($val.Substring(1, $val.Length - 2) -replace "''", "'")
        }
        if ($val.StartsWith('"') -and $val.EndsWith('"') -and $val.Length -ge 2) {
            return $val.Substring(1, $val.Length - 2)
        }
        return $val
    }
    return ''
}

function Get-ConfigRoot {
    param([string]$Client)
    return (Get-AutopromptConfigRoot -Name $Client)
}

function Install-PrimeLifecycle {
    $helper = Join-Path $ScriptDir 'prime-lifecycle.cjs'
    $primeCommand = Get-Command $AutopromptClientBin['prime'] `
        -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $primeCli = if ($primeCommand) { [string]$primeCommand.Source } else { '' }
    if (-not (Get-Command node -ErrorAction SilentlyContinue) -or
        -not (Test-Path -LiteralPath $helper -PathType Leaf) -or
        [string]::IsNullOrEmpty($primeCli)) {
        [Console]::Error.WriteLine(
            'Autoprompt install (prime): node or the Prime lifecycle helper is missing.'
        )
        $script:ResultRows += 'RESULT=FAIL client=prime stage=runtime'
        $script:AnyFail = 1
        return
    }
    $output = @(& node $helper install --repo-root $RepoRoot --prime-cli $primeCli)
    $code = $LASTEXITCODE
    if ($code -ne 0 -or $output.Count -eq 0) {
        [Console]::Error.WriteLine(
            "Autoprompt install (prime): failed (code $code)."
        )
        $script:ResultRows += 'RESULT=FAIL client=prime stage=lifecycle'
        $script:AnyFail = 1
        return
    }
    try {
        $result = $output[-1] | ConvertFrom-Json
        $destination = [string]$result.health.packageRoot
        if ([string]::IsNullOrEmpty($destination)) { throw 'missing package root' }
        [Console]::Error.WriteLine(
            "Autoprompt install (prime): PASS -- landed $destination (48 files, rlmMaxDepth=4)."
        )
        $script:ResultRows += "RESULT=PASS client=prime dest=$destination format=prime-package detail=files=48"
    } catch {
        [Console]::Error.WriteLine(
            "Autoprompt install (prime): invalid lifecycle result: $($_.Exception.Message)"
        )
        $script:ResultRows += 'RESULT=FAIL client=prime stage=lifecycle-output'
        $script:AnyFail = 1
    }
}

function Get-CodexHome {
    return (Get-AutopromptConfigRoot -Name 'codex')
}

function Get-CodexProfileFile {
    return (Get-AutopromptProfileFile -Name 'codex')
}

function Get-CodexAgentsDir {
    return (Get-AutopromptNativeAgentsRoot -Name 'codex')
}

# Get-OpencodeConfigDir: the OpenCode configuration directory ($XDG_CONFIG_HOME/
# opencode by default). The activation profile and native subagents live here; the
# user's ordinary opencode.json inside it is never read or edited.
function Get-OpencodeConfigDir {
    return (Split-Path -Parent (Get-AutopromptProfileFile -Name 'opencode'))
}

function Get-OpencodeAgentsDir {
    return (Get-AutopromptNativeAgentsRoot -Name 'opencode')
}

function Get-OpencodeProfileFile {
    return (Get-AutopromptProfileFile -Name 'opencode')
}

function Get-KiloConfigDir {
    return (Split-Path -Parent (Get-AutopromptProfileFile -Name 'kilo'))
}

function Get-KiloAgentsDir {
    return (Get-AutopromptNativeAgentsRoot -Name 'kilo')
}

function Get-KiloProfileFile {
    return (Get-AutopromptProfileFile -Name 'kilo')
}

function Test-KiloActivation {
    $sourceDir = Join-Path (Get-ExtrasSkillDir -Client 'kilo') 'agents'
    $sourceAgents = @(Get-OpencodeAgentFiles -SourceDir $sourceDir)
    if ($sourceAgents.Count -eq 0) {
        [Console]::Error.WriteLine('client=kilo verify=fail reason=agent-payload-empty')
        return 1
    }
    $targetDir = Get-KiloAgentsDir
    foreach ($sourceAgent in $sourceAgents) {
        $landed = Join-Path $targetDir $sourceAgent.Name
        if (-not (Test-Path -LiteralPath $landed -PathType Leaf) -or
            (Get-IdemSha256 -Path $sourceAgent.FullName) -ne (Get-IdemSha256 -Path $landed)) {
            [Console]::Error.WriteLine("client=kilo verify=fail reason=agent-mismatch agent=$($sourceAgent.Name)")
            return 1
        }
    }
    if (-not (Test-KiloProfilePolicy -Path (Get-KiloProfileFile))) {
        [Console]::Error.WriteLine('client=kilo verify=fail reason=profile-invalid')
        return 1
    }
    return 0
}

function Install-KiloActivation {
    $skillDir = Get-ExtrasSkillDir -Client 'kilo'
    $sourceDir = Join-Path $skillDir 'agents'
    if ((Test-KiloAgentPayload -SourceDir $sourceDir) -ne 0) {
        [Console]::Error.WriteLine("Autoprompt install (kilo): required activation payload missing under $skillDir.")
        return 95
    }
    $sourceProfile = Join-Path $skillDir 'autoprompt.kilo.json'
    if (-not (Test-KiloProfilePolicy -Path $sourceProfile)) {
        [Console]::Error.WriteLine("Autoprompt install (kilo): activation profile is invalid under $skillDir.")
        return 95
    }
    $journalStart = $script:AutopromptManagedUndoJournal.Count
    try {
        $mappings = @()
        foreach ($sourceAgent in @(Get-OpencodeAgentFiles -SourceDir $sourceDir)) {
            $landed = Join-Path (Get-KiloAgentsDir) $sourceAgent.Name
            $mappings += @{ Source = $sourceAgent.FullName; Target = $landed }
        }
        $mappings += @{ Source = $sourceProfile; Target = (Get-KiloProfileFile) }
        $managedCode = Install-IdemManagedFiles `
            -ConfigRoot (Get-ConfigRoot -Client 'kilo') `
            -Mappings $mappings `
            -RefuseUnownedTarget
        if ($managedCode -ne 0) {
            throw "native registration failed: code=$managedCode"
        }
        if ((Test-KiloActivation) -ne 0) {
            throw 'post-install activation verification failed'
        }
    } catch {
        Invoke-ManagedRollback -FromIndex $journalStart -Context '(kilo)' | Out-Null
        [Console]::Error.WriteLine(
            "Autoprompt install (kilo): activation landing or verification failed: $($_.Exception.Message)"
        )
        return 96
    }
    return 0
}

# Test-OpencodeActivation: every shipped ap-*.md sits byte-exact (hash-equal) at the
# native global agents load path, and the activation profile parses with the guarded
# knobs (subagent_depth=4, share=disabled, task limited to the ap-* cast).
function Test-OpencodeActivation {
    $sourceDir = Join-Path (Get-ExtrasSkillDir -Client 'opencode') 'agents'
    $sourceAgents = @(Get-OpencodeAgentFiles -SourceDir $sourceDir)
    if ($sourceAgents.Count -ne 25) {
        [Console]::Error.WriteLine("client=opencode verify=fail reason=agent-count found=$($sourceAgents.Count) expected=25")
        return 1
    }
    $targetDir = Get-OpencodeAgentsDir
    foreach ($sourceAgent in $sourceAgents) {
        $landed = Join-Path $targetDir $sourceAgent.Name
        if (-not (Test-Path -LiteralPath $landed -PathType Leaf) -or
            (Get-IdemSha256 -Path $sourceAgent.FullName) -ne (Get-IdemSha256 -Path $landed)) {
            [Console]::Error.WriteLine("client=opencode verify=fail reason=agent-mismatch agent=$($sourceAgent.Name)")
            return 1
        }
    }
    if (-not (Test-OpencodeProfilePolicy -Path (Get-OpencodeProfileFile))) {
        [Console]::Error.WriteLine('client=opencode verify=fail reason=profile-invalid')
        return 1
    }
    return 0
}

# Install-OpencodeActivation: land the native markdown subagents at OpenCode's
# global agents load path (the only native markdown discovery point) and the
# activation-only profile beside the user's untouched opencode.json. Every landed
# byte is receipt-owned. Codes: 95 source payload missing, 96 copy failed,
# 97 post-install activation verify failed.
function Invoke-ManagedRollback {
    param([int]$FromIndex = 0, [string]$Context = 'install')
    if (Undo-IdemManagedChanges -FromIndex $FromIndex) { return $true }
    [Console]::Error.WriteLine("Autoprompt $Context rollback incomplete; fix the reported path and retry the operation.")
    return $false
}

function Invoke-FinalManagedRollback {
    param([string]$Context)
    if (Invoke-ManagedRollback -Context $Context) { return $true }
    $script:IsRecoveryRetained = $true
    return $false
}

function Install-OpencodeActivationFiles {
    param(
        [string]$Root,
        [System.IO.FileInfo[]]$SourceAgents,
        [string]$TargetDir,
        [string]$ProfileStage,
        [string]$Profile
    )
    if (-not (Write-OpencodeProfilePolicy -Path $ProfileStage)) {
        throw 'profile generation failed'
    }
    foreach ($sourceAgent in $SourceAgents) {
        $landed = Join-Path $TargetDir $sourceAgent.Name
        $managedCode = Install-IdemManagedFile -ConfigRoot $Root `
            -Source $sourceAgent.FullName -Target $landed `
            -RefuseUnownedTarget
        if ($managedCode -ne 0) {
            throw "native registration failed: $landed code=$managedCode"
        }
    }
    $managedCode = Install-IdemManagedFile -ConfigRoot $Root `
        -Source $ProfileStage -Target $Profile -RefuseUnownedTarget
    if ($managedCode -ne 0) {
        throw "profile registration failed: $Profile code=$managedCode"
    }
    if ((Test-OpencodeActivation) -ne 0) {
        throw 'post-install activation verification failed'
    }
}

function Install-OpencodeActivation {
    $skillDir = Get-ExtrasSkillDir -Client 'opencode'
    $sourceDir = Join-Path $skillDir 'agents'
    if ((Test-OpencodeAgentPayload -SourceDir $sourceDir) -ne 0) {
        [Console]::Error.WriteLine("Autoprompt install (opencode): required activation payload missing under $skillDir.")
        return 95
    }
    $journalStart = $script:AutopromptManagedUndoJournal.Count
    $profileStage = Join-Path ([System.IO.Path]::GetTempPath()) `
        ("clopencode_" + [guid]::NewGuid().ToString('N'))
    try {
        Install-OpencodeActivationFiles `
            -Root (Get-ConfigRoot -Client 'opencode') `
            -SourceAgents @(Get-OpencodeAgentFiles -SourceDir $sourceDir) `
            -TargetDir (Get-OpencodeAgentsDir) -ProfileStage $profileStage `
            -Profile (Get-OpencodeProfileFile)
    } catch {
        Invoke-ManagedRollback -FromIndex $journalStart `
            -Context '(opencode)' | Out-Null
        [Console]::Error.WriteLine(
            "Autoprompt install (opencode): activation landing or verification failed: $($_.Exception.Message)"
        )
        return 96
    } finally {
        Remove-Item -LiteralPath $profileStage -Force `
            -ErrorAction SilentlyContinue
    }
    return 0
}

# Remove-StaleOpencodeAgents: remove only receipt-owned ap-*.md from the global
# OpenCode agents dir when the shipped payload no longer carries that persona.
# Unowned files (including unowned ap-*) are never touched.
function Remove-StaleOpencodeAgents {
    $root = Get-ConfigRoot -Client 'opencode'
    $sourceDir = Join-Path $RepoRoot 'agents/opencode/agents'
    $privateDir = Join-Path (Get-ExtrasSkillDir -Client 'opencode') 'agents'
    $nativeDir = Get-OpencodeAgentsDir
    $canonicalPrivateDir = Get-NormalizedPath -Path $privateDir
    $canonicalNativeDir = Get-NormalizedPath -Path $nativeDir

    foreach ($file in @($script:AutopromptReceiptFiles)) {
        $canonicalFile = Get-NormalizedPath -Path $file
        $parent = if ($canonicalFile) { Split-Path -Parent $canonicalFile } else { '' }
        $leaf = if ($canonicalFile) { Split-Path -Leaf $canonicalFile } else { '' }
        $isOwnedAgent = ($parent -ieq $canonicalPrivateDir -or $parent -ieq $canonicalNativeDir) -and
            $leaf -like 'ap-*.md'
        if (-not $isOwnedAgent -or (Test-Path -LiteralPath (Join-Path $sourceDir $leaf) -PathType Leaf)) {
            continue
        }
        if (-not (Remove-IdemManagedFile -ConfigRoot $root -Path $file)) {
            [Console]::Error.WriteLine("Autoprompt install (opencode): could not prune receipt-owned stale subagent $file.")
            return 94
        }
    }
    return 0
}

function Remove-StaleKiloAgents {
    $root = Get-ConfigRoot -Client 'kilo'
    $sourceDir = Join-Path $RepoRoot 'agents/kilo/agents'
    $privateDir = Join-Path (Get-ExtrasSkillDir -Client 'kilo') 'agents'
    $nativeDir = Get-KiloAgentsDir
    $canonicalPrivateDir = Get-NormalizedPath -Path $privateDir
    $canonicalNativeDir = Get-NormalizedPath -Path $nativeDir

    foreach ($file in @($script:AutopromptReceiptFiles)) {
        $canonicalFile = Get-NormalizedPath -Path $file
        $parent = if ($canonicalFile) { Split-Path -Parent $canonicalFile } else { '' }
        $leaf = if ($canonicalFile) { Split-Path -Leaf $canonicalFile } else { '' }
        $isOwnedAgent = ($parent -ieq $canonicalPrivateDir -or
            $parent -ieq $canonicalNativeDir) -and $leaf -like 'ap-*.md'
        if (-not $isOwnedAgent -or
            (Test-Path -LiteralPath (Join-Path $sourceDir $leaf) -PathType Leaf)) {
            continue
        }
        if (-not (Remove-IdemManagedFile -ConfigRoot $root -Path $file)) {
            [Console]::Error.WriteLine("Autoprompt install (kilo): could not prune receipt-owned stale subagent $file.")
            return 94
        }
    }
    return 0
}


function New-CodexAgentStage {
    param([string]$StageAgents, [string]$StageProfile)
    $sourceAgents = Join-Path $RepoRoot 'agents/claude/agents'
    $castingTool = Join-Path $RepoRoot 'agents/codex/workflow/codex-agent-casting.js'
    $profileTool = Join-Path $RepoRoot 'agents/codex/workflow/codex-agent-profile.js'
    & node $castingTool --export-inheritance --source-agents $sourceAgents `
        --agents-dir $StageAgents --selector off | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "agent export failed with code $LASTEXITCODE"
    }
    & node $profileTool --write --agents-dir $StageAgents `
        --profile $StageProfile | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "profile export failed with code $LASTEXITCODE"
    }
    & node $castingTool --resolve --agents-dir $StageAgents `
        --selector off | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "agent verification failed with code $LASTEXITCODE"
    }
    & node $profileTool --verify --agents-dir $StageAgents `
        --profile $StageProfile | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "profile verification failed with code $LASTEXITCODE"
    }
}

function Install-CodexAgentStage {
    param(
        [string]$Root, [string]$StageAgents, [string]$StageProfile,
        [string]$AgentsDir, [string]$Profile
    )
    $generated = @(Get-ChildItem -LiteralPath $StageAgents `
        -Filter 'ap-*.toml' -File) + @(
        Get-Item -LiteralPath (Join-Path $StageAgents '.autoprompt-casting.json')
    )
    foreach ($file in $generated) {
        $target = Join-Path $AgentsDir $file.Name
        $managedCode = Install-IdemManagedFile -ConfigRoot $Root `
            -Source $file.FullName -Target $target -RefuseUnownedTarget
        if ($managedCode -ne 0) {
            throw "managed registration failed: $target code=$managedCode"
        }
    }
    $managedCode = Install-IdemManagedFile -ConfigRoot $Root `
        -Source $StageProfile -Target $Profile -RefuseUnownedTarget
    if ($managedCode -ne 0) {
        throw "managed registration failed: $Profile code=$managedCode"
    }
}

function Install-CodexAgents {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        [Console]::Error.WriteLine('Autoprompt install (codex): node is required to export and bind custom agents.')
        return 90
    }
    $stage = Join-Path ([System.IO.Path]::GetTempPath()) `
        ("clcodex_" + [guid]::NewGuid().ToString('N'))
    $stageAgents = Join-Path $stage 'skills/autoprompt/agents-runtime'
    $stageProfile = Join-Path $stage 'autoprompt.config.toml'
    $hadCodexAgentsDir = Test-Path Env:CODEX_AGENTS_DIR
    $previousCodexAgentsDir = $env:CODEX_AGENTS_DIR
    $journalStart = $script:AutopromptManagedUndoJournal.Count
    try {
        $env:CODEX_AGENTS_DIR = $stageAgents
        New-CodexAgentStage -StageAgents $stageAgents -StageProfile $stageProfile
        Install-CodexAgentStage -Root (Get-CodexHome) `
            -StageAgents $stageAgents -StageProfile $stageProfile `
            -AgentsDir (Get-CodexAgentsDir) -Profile (Get-CodexProfileFile)
    } catch {
        Invoke-ManagedRollback -FromIndex $journalStart -Context '(codex)' | Out-Null
        [Console]::Error.WriteLine("Autoprompt install (codex): private agent export failed: $($_.Exception.Message)")
        return 91
    } finally {
        if ($hadCodexAgentsDir) {
            $env:CODEX_AGENTS_DIR = $previousCodexAgentsDir
        } else {
            Remove-Item Env:CODEX_AGENTS_DIR -ErrorAction SilentlyContinue
        }
        Remove-Item -LiteralPath $stage -Recurse -Force `
            -ErrorAction SilentlyContinue
    }
    return 0
}

# Get-ExtrasSrcDir: the repo CLI dir whose GATES/PLAYBOOKS/MODES/frameworks/workflow/
# agents feed Install-Extras. Only claude + codex + opencode ship the runtime set;
# every other client stays single-file (SKILL.md only). Empty => no extras.
function Get-ExtrasSrcDir {
    param([string]$Client)
    switch ($Client) {
        'claude'   { return (Join-Path $RepoRoot 'agents/claude') }
        'codex'    { return (Join-Path $RepoRoot 'agents/codex') }
        'opencode' { return (Join-Path $RepoRoot 'agents/opencode') }
        'kilo'     { return (Join-Path $RepoRoot 'agents/kilo') }
        'vscode'   { return (Join-Path $RepoRoot 'agents/vscode') }
        'omp'      { return (Join-Path $RepoRoot 'agents/omp') }
        'deepseek' { return (Join-Path $RepoRoot 'agents/deepseek') }
        'reasonix' { return (Join-Path $RepoRoot 'agents/reasonix') }
        default    { return '' }
    }
}

# Get-ExtrasSkillDir: the directory SKILL.md lands in for a client that ships extras.
function Get-ExtrasSkillDir {
    param([string]$Client)
    return (Get-AutopromptRuntimeRoot -Name $Client)
}

# Get-ExtrasAgentsDir: the NATIVE agents load path for a client that ships personas
# (claude only - ~/.claude/agents, where Claude Code natively registers custom
# agents). Empty for codex (its cast stays profile-private).
function Get-ExtrasAgentsDir {
    param([string]$Client)
    if ($Client -notin @('claude', 'vscode', 'omp')) { return '' }
    return (Get-AutopromptNativeAgentsRoot -Name $Client)
}

function Test-DeepseekActivation {
    $source = Join-Path (Get-ExtrasSkillDir -Client 'deepseek') 'agent-preset'
    $target = Join-Path (Get-ConfigRoot -Client 'deepseek') `
        '.agent-presets/autoprompt'
    foreach ($file in @('agent.cordis.yml', 'preset.yml')) {
        $sourceFile = Join-Path $source $file
        $targetFile = Join-Path $target $file
        if (-not (Test-Path -LiteralPath $sourceFile -PathType Leaf) -or
            -not (Test-Path -LiteralPath $targetFile -PathType Leaf) -or
            (Get-IdemSha256 -Path $sourceFile) -ne
            (Get-IdemSha256 -Path $targetFile)) {
            [Console]::Error.WriteLine(
                "client=deepseek verify=fail reason=preset-mismatch file=$file"
            )
            return 1
        }
    }
    return 0
}

function Install-DeepseekActivation {
    $root = Get-ConfigRoot -Client 'deepseek'
    $source = Join-Path (Get-ExtrasSkillDir -Client 'deepseek') 'agent-preset'
    $target = Join-Path $root '.agent-presets/autoprompt'
    $mappings = @('agent.cordis.yml', 'preset.yml') | ForEach-Object {
        @{
            Source = Join-Path $source $_
            Target = Join-Path $target $_
        }
    }
    $journalStart = $script:AutopromptManagedUndoJournal.Count
    $managedCode = Install-IdemManagedFiles -ConfigRoot $root `
        -Mappings $mappings -RefuseUnownedTarget
    if ($managedCode -eq 0 -and (Test-DeepseekActivation) -eq 0) {
        return 0
    }
    Invoke-ManagedRollback -FromIndex $journalStart `
        -Context '(deepseek)' | Out-Null
    [Console]::Error.WriteLine(
        "Autoprompt install (deepseek): native preset landing failed: code=$managedCode"
    )
    return 98
}

function Get-HarnessProviderConfigFile {
    param([string]$Provider)
    $root = Get-ConfigRoot -Client $Provider
    if ($Provider -eq 'omp') { return (Join-Path $root 'config.yml') }
    if ($Provider -eq 'reasonix') { return (Join-Path $root 'config.toml') }
    return ''
}

function Get-HarnessProviderConfigKey {
    param([string]$Provider)
    if ($Provider -eq 'omp') { return 'task.maxRecursionDepth' }
    if ($Provider -eq 'reasonix') { return 'agent.max_subagent_depth' }
    return ''
}

function Test-HarnessProviderDepth {
    param([string]$Provider)
    $helper = Join-Path $RepoRoot 'scripts/harness-provider-config.cjs'
    $file = Get-HarnessProviderConfigFile -Provider $Provider
    if ([string]::IsNullOrEmpty($file) -or
        -not (Test-Path -LiteralPath $helper -PathType Leaf) -or
        -not (Get-Command node -ErrorAction SilentlyContinue)) {
        return $false
    }
    & node $helper inspect --provider $Provider --file $file `
        --minimum 4 *> $null
    return $LASTEXITCODE -eq 0
}

function Install-HarnessProviderDepth {
    param([string]$Provider)
    $root = Get-ConfigRoot -Client $Provider
    $file = Get-HarnessProviderConfigFile -Provider $Provider
    $key = Get-HarnessProviderConfigKey -Provider $Provider
    $helper = Join-Path $RepoRoot 'scripts/harness-provider-config.cjs'
    if ([string]::IsNullOrEmpty($file) -or [string]::IsNullOrEmpty($key) -or
        -not (Test-Path -LiteralPath $helper -PathType Leaf) -or
        -not (Get-Command node -ErrorAction SilentlyContinue)) {
        return 98
    }
    $stage = Join-Path ([System.IO.Path]::GetTempPath()) `
        ("autoprompt-harness-config_" + [guid]::NewGuid().ToString('N'))
    $desired = Join-Path $stage 'desired'
    $original = Join-Path $stage 'original'
    try {
        New-Item -ItemType Directory -Path $stage -Force -ErrorAction Stop | Out-Null
        $output = @(& node $helper plan --provider $Provider --file $file `
            --desired $desired --original $original --minimum 4 2>&1)
        if ($LASTEXITCODE -ne 0) {
            [Console]::Error.WriteLine(($output -join [Environment]::NewLine))
            return 98
        }
        $record = $output -join ' '
        if ($record -like 'status=noop*') {
            return $(if (Test-HarnessProviderDepth -Provider $Provider) { 0 } else { 98 })
        }
        $priorMatch = [regex]::Match($record, '(?:^| )prior=(\S+)')
        if ($record -notlike 'status=applied*' -or -not $priorMatch.Success) {
            return 98
        }
        $prior = $priorMatch.Groups[1].Value
        $existing = @($script:AutopromptReceiptEdits | Where-Object {
            (Test-IdemPathEqual -Left $_.File -Right $file) -and
            $_.Key -ceq $key
        })
        if ($existing.Count -gt 1) { return 98 }
        if ($existing.Count -eq 1) {
            $prior = [string]$existing[0].PriorValue
        }
        $backup = "$file$AutopromptConfigEditBackupSuffix"
        if ($existing.Count -eq 1 -and $prior -cne 'absent-file' -and
            -not (Test-Path -LiteralPath $backup -PathType Leaf)) {
            return 98
        }
        $mappings = @()
        if (-not (Test-Path -LiteralPath $backup -PathType Leaf) -and
            (Test-Path -LiteralPath $original -PathType Leaf)) {
            $mappings += @{
                Source = $original; Target = $backup; TrackManaged = $false
            }
        }
        $mappings += @{
            Source = $desired; Target = $file; TrackManaged = $false
            AllowUnownedTarget = $true
        }
        $managedCode = Install-IdemManagedFiles -ConfigRoot $root `
            -Mappings $mappings -RefuseUnownedTarget
        if ($managedCode -ne 0) { return $managedCode }
        if ($existing.Count -eq 0) {
            $script:AutopromptReceiptEdits += @{
                File = $file; Key = $key; Value = '4'; PriorValue = $prior
            }
        }
        if (Test-Path -LiteralPath $backup -PathType Leaf) {
            $script:AutopromptConfigEditLastBackup = $backup
        }
        return $(if (Test-HarnessProviderDepth -Provider $Provider) { 0 } else { 98 })
    } catch {
        [Console]::Error.WriteLine(
            "Autoprompt install ($Provider): recursion configuration failed: " +
            $_.Exception.Message
        )
        return 98
    } finally {
        Remove-Item -LiteralPath $stage -Recurse -Force `
            -ErrorAction SilentlyContinue
    }
}

function Get-ReasonixPrivateProfiles {
    $source = Join-Path (Get-ExtrasSkillDir -Client 'reasonix') 'skills'
    return @(Get-ChildItem -LiteralPath $source -Filter 'SKILL.md' `
        -File -Recurse -ErrorAction SilentlyContinue | Where-Object {
            $_.Directory.Name -like 'ap-*'
        })
}

function Test-ReasonixActivation {
    $profiles = @(Get-ReasonixPrivateProfiles)
    if ($profiles.Count -ne 25) {
        [Console]::Error.WriteLine(
            "client=reasonix verify=fail reason=profile-count " +
            "found=$($profiles.Count) expected=25"
        )
        return 1
    }
    $targetRoot = Join-Path (Get-ConfigRoot -Client 'reasonix') 'skills'
    foreach ($profile in $profiles) {
        $target = Join-Path (Join-Path $targetRoot $profile.Directory.Name) `
            'SKILL.md'
        if (-not (Test-Path -LiteralPath $target -PathType Leaf) -or
            (Get-IdemSha256 -Path $profile.FullName) -ne
            (Get-IdemSha256 -Path $target)) {
            [Console]::Error.WriteLine(
                "client=reasonix verify=fail reason=profile-mismatch " +
                "profile=$($profile.Directory.Name)"
            )
            return 1
        }
    }
    return 0
}

function Install-ReasonixActivation {
    $root = Get-ConfigRoot -Client 'reasonix'
    $profiles = @(Get-ReasonixPrivateProfiles)
    if ($profiles.Count -ne 25) {
        [Console]::Error.WriteLine(
            "Autoprompt install (reasonix): expected 25 native profiles, " +
            "found $($profiles.Count)."
        )
        return 98
    }
    $targetRoot = Join-Path $root 'skills'
    $mappings = @($profiles | ForEach-Object {
        @{
            Source = $_.FullName
            Target = Join-Path (Join-Path $targetRoot $_.Directory.Name) `
                'SKILL.md'
        }
    })
    $journalStart = $script:AutopromptManagedUndoJournal.Count
    $managedCode = Install-IdemManagedFiles -ConfigRoot $root `
        -Mappings $mappings -RefuseUnownedTarget
    if ($managedCode -eq 0 -and (Test-ReasonixActivation) -eq 0 -and
        (Install-HarnessProviderDepth -Provider 'reasonix') -eq 0) {
        return 0
    }
    Invoke-ManagedRollback -FromIndex $journalStart `
        -Context '(reasonix)' | Out-Null
    [Console]::Error.WriteLine(
        "Autoprompt install (reasonix): native profile landing failed: code=$managedCode"
    )
    return 98
}

function Test-VscodeActivation {
    $source = Join-Path (Get-ExtrasSkillDir -Client 'vscode') 'agents'
    $target = Get-ExtrasAgentsDir -Client 'vscode'
    $personas = @(Get-ChildItem -LiteralPath $source `
        -Filter 'ap-*.agent.md' -File -ErrorAction SilentlyContinue)
    if ($personas.Count -ne 25) {
        [Console]::Error.WriteLine(
            "client=vscode verify=fail reason=agent-count " +
            "found=$($personas.Count) expected=25"
        )
        return 1
    }
    foreach ($persona in $personas) {
        $landed = Join-Path $target $persona.Name
        if (-not (Test-Path -LiteralPath $landed -PathType Leaf) -or
            (Get-IdemSha256 -Path $persona.FullName) -ne
            (Get-IdemSha256 -Path $landed)) {
            [Console]::Error.WriteLine(
                "client=vscode verify=fail reason=agent-mismatch " +
                "agent=$($persona.Name)"
            )
            return 1
        }
    }
    $helper = Get-VscodeSettingsHelper
    $settings = Get-VscodeSettingsFile
    $output = @(& node $helper inspect --file $settings 2>&1)
    if ($LASTEXITCODE -ne 0) {
        [Console]::Error.WriteLine(
            "client=vscode verify=fail reason=activation-missing " +
            "detail=$(($output -join '-') -replace '\s+', '-')"
        )
        return 1
    }
    return 0
}

function Install-VscodeActivation {
    $root = Get-ConfigRoot -Client 'vscode'
    $settings = Get-VscodeSettingsFile
    $backup = "$settings$AutopromptConfigEditBackupSuffix"
    $helper = Get-VscodeSettingsHelper
    if (-not (Test-Path -LiteralPath $helper -PathType Leaf) -or
        -not (Get-Command node -ErrorAction SilentlyContinue)) {
        [Console]::Error.WriteLine(
            'client=vscode error=activation-missing ' +
            'reason=settings-helper-unavailable'
        )
        return 98
    }
    $source = Join-Path (Get-ExtrasSkillDir -Client 'vscode') 'agents'
    $personas = @(Get-ChildItem -LiteralPath $source `
        -Filter 'ap-*.agent.md' -File -ErrorAction SilentlyContinue)
    if ($personas.Count -ne 25) {
        [Console]::Error.WriteLine(
            "client=vscode error=activation-missing " +
            "reason=agent-count found=$($personas.Count) expected=25"
        )
        return 98
    }

    $stage = Join-Path ([System.IO.Path]::GetTempPath()) `
        ('autoprompt-vscode_' + [guid]::NewGuid().ToString('N'))
    $desired = Join-Path $stage 'settings.json'
    $original = Join-Path $stage 'settings.original.json'
    $journalStart = $script:AutopromptManagedUndoJournal.Count
    try {
        New-Item -ItemType Directory -Path $stage -ErrorAction Stop |
            Out-Null
        $output = @(& node $helper stage --file $settings `
            --output $desired --original $original 2>&1)
        if ($LASTEXITCODE -ne 0) {
            throw "settings-stage-failed detail=$(($output -join '-') -replace '\s+', '-')"
        }
        $record = $output -join ' '
        $mappings = @()
        foreach ($persona in $personas) {
            $mappings += @{
                Source = $persona.FullName
                Target = Join-Path (Get-ExtrasAgentsDir -Client 'vscode') `
                    $persona.Name
            }
        }
        if ($record -like 'status=applied*') {
            $priorMatch = [regex]::Match($record, '(?:^| )prior=(\S+)')
            if (-not $priorMatch.Success -or
                $priorMatch.Groups[1].Value -notin @('absent', 'false')) {
                throw 'settings-stage-invalid-prior'
            }
            if (Test-Path -LiteralPath $original -PathType Leaf) {
                $mappings += @{
                    Source = $original
                    Target = $backup
                    TrackManaged = $false
                }
            }
            $mappings += @{
                Source = $desired
                Target = $settings
                TrackManaged = $false
                AllowUnownedTarget = $true
            }
        } elseif ($record -notlike 'status=noop*') {
            throw 'settings-stage-invalid-result'
        }
        $managedCode = Install-IdemManagedFiles -ConfigRoot $root `
            -Mappings $mappings -RefuseUnownedTarget
        if ($managedCode -ne 0) {
            throw "activation-batch-failed code=$managedCode"
        }
        if ($record -like 'status=applied*') {
            $prior = if ($priorMatch.Groups[1].Value -eq 'absent') {
                $null
            } else {
                'false'
            }
            $existing = @($script:AutopromptReceiptEdits | Where-Object {
                (Test-IdemPathEqual -Left $_.File -Right $settings) -and
                $_.Key -ceq $AutopromptVscodeActivationKey
            })
            if ($existing.Count -gt 1) {
                throw 'duplicate-settings-receipt-edit'
            }
            if ($existing.Count -eq 0) {
                $script:AutopromptReceiptEdits += @{
                    File = $settings
                    Key = $AutopromptVscodeActivationKey
                    Value = 'true'
                    PriorValue = $prior
                }
            }
            if (Test-Path -LiteralPath $backup -PathType Leaf) {
                $script:AutopromptConfigEditLastBackup = $backup
            }
        }
        if ((Test-VscodeActivation) -ne 0) {
            throw 'post-install activation verification failed'
        }
    } catch {
        Invoke-ManagedRollback -FromIndex $journalStart `
            -Context '(vscode)' | Out-Null
        [Console]::Error.WriteLine(
            "client=vscode error=activation-missing detail=" +
            ($_.Exception.Message -replace '\s+', '-')
        )
        return 98
    } finally {
        Remove-Item -LiteralPath $stage -Recurse -Force `
            -ErrorAction SilentlyContinue
    }
    return 0
}

function Get-NormalizedPath {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return '' }
    try { return [System.IO.Path]::GetFullPath($Path).TrimEnd([char]92, [char]47) }
    catch { return '' }
}

# Invoke-LegacyActivationMigration: remove only historical global Codex ap-* files
# and Codex config edits owned by this root's prior receipt. Claude personas are
# native registrations again: the current install re-lands them in place and
# Remove-StaleClaudePersonas owns receipt-scoped stale cleanup, so there is no
# claude migration branch. Any unowned role survives.
function Read-LegacyActivationReceipt {
    param([string]$Client, [string]$Root, [string]$ReceiptPath)
    try {
        return Read-UninstallReceipt -ConfigRoot $Root
    } catch {
        [Console]::Error.WriteLine(
            "Autoprompt install ($Client): could not read existing receipt at " +
            "$ReceiptPath. Repair or remove it before retrying."
        )
        return 72
    }
}

function Get-LegacyCodexOwnershipState {
    param([string]$Root)
    if (-not (Test-IdemPathEqual -Left $Root -Right (Get-ConfigRoot -Client 'codex'))) {
        return $null
    }
    $helper = Join-Path $RepoRoot 'scripts/install/legacy-compat.cjs'
    $files = @(& node $helper files codex $Root 2>$null)
    if ($LASTEXITCODE -ne 0 -or $files.Count -eq 0) { return $null }
    return @{
        Legacy = $true
        Files = @($files)
        CreatedDirectories = @()
        Edits = @()
        Backup = 'none'
    }
}

function Restore-LegacyCodexEdits {
    param([hashtable]$Receipt)
    if (@($Receipt.Edits).Count -eq 0) { return 0 }
    $restoreCode = Restore-UninstallConfigEdits `
        -Edits ([hashtable[]]$Receipt.Edits)
    if ($restoreCode -ne 0) { return $restoreCode }
    $script:AutopromptReceiptEdits = @()
    $script:AutopromptConfigEditLastBackup = 'none'
    return 0
}

function Remove-LegacyCodexRoles {
    $expectedParent = Get-NormalizedPath -Path `
        (Join-Path (Get-CodexHome) 'agents')
    if ([string]::IsNullOrEmpty($expectedParent)) { return 0 }
    $kept = @()
    foreach ($file in @($script:AutopromptReceiptFiles)) {
        $canonicalFile = Get-NormalizedPath -Path $file
        $parent = if ($canonicalFile) { Split-Path -Parent $canonicalFile } else { '' }
        $leaf = if ($canonicalFile) { Split-Path -Leaf $canonicalFile } else { '' }
        if ($parent -ine $expectedParent -or $leaf -notlike 'ap-*.toml') {
            $kept += $file
            continue
        }
        if (-not (Test-Path -LiteralPath $file)) { continue }
        try { Remove-Item -LiteralPath $file -Force -ErrorAction Stop }
        catch {
            [Console]::Error.WriteLine(
                "Autoprompt install (codex): could not migrate receipt-owned legacy role $file."
            )
            return 93
        }
    }
    $script:AutopromptReceiptFiles = $kept
    return 0
}

function Remove-LegacyCodexSkillPayload {
    param([string]$Root)
    $skillRoot = Join-Path $Root 'skills/autoprompt'
    if (-not (Test-Path -LiteralPath $skillRoot -PathType Container)) { return 0 }
    $legacyFiles = @($script:AutopromptReceiptFiles)
    foreach ($file in $legacyFiles) {
        if (-not (Test-IdemPathUnderRoot -Path $file -Root $skillRoot)) {
            continue
        }
        if (-not (Remove-IdemManagedFile -ConfigRoot $Root -Path $file)) {
            [Console]::Error.WriteLine(
                "Autoprompt install (codex): could not migrate older skill file $file."
            )
            return 93
        }
    }
    return 0
}

function Invoke-LegacyActivationMigration {
    param([string]$Client, [string]$Root)
    if ($Client -ne 'codex') { return 0 }
    $receiptPath = Join-Path $Root $AutopromptReceiptName
    if (Test-Path -LiteralPath $receiptPath -PathType Leaf) {
        $receipt = Read-LegacyActivationReceipt -Client $Client -Root $Root `
            -ReceiptPath $receiptPath
        if ($receipt -is [int]) { return [int]$receipt }
        if ($receipt -isnot [hashtable]) { return 72 }
        $restoreCode = Restore-LegacyCodexEdits -Receipt $receipt
        if ($restoreCode -ne 0) { return $restoreCode }
        return Remove-LegacyCodexRoles
    } elseif (-not $script:AutopromptLegacyCodexMigration) {
        return 0
    }
    return Remove-LegacyCodexSkillPayload -Root $Root
}

# Remove-StaleClaudePersonas: remove receipt-owned ap-*.md personas that no longer
# exist in the source - under BOTH the skill-private payload agents dir and the
# native ~/.claude/agents load path. Unowned files are never matched.
function Remove-StaleClaudePersonas {
    $root = Get-ConfigRoot -Client 'claude'
    $payloadAgentsDir = Join-Path (Get-ExtrasSkillDir -Client 'claude') 'agents'
    $nativeAgentsDir = Get-ExtrasAgentsDir -Client 'claude'
    $canonicalPayloadDir = Get-NormalizedPath -Path $payloadAgentsDir
    $canonicalNativeDir = Get-NormalizedPath -Path $nativeAgentsDir
    $sourceDir = Join-Path $RepoRoot 'agents/claude/agents'

    foreach ($file in @($script:AutopromptReceiptFiles)) {
        $canonicalFile = Get-NormalizedPath -Path $file
        $parent = if ($canonicalFile) {
            Split-Path -Parent $canonicalFile
        } else {
            ''
        }
        $leaf = if ($canonicalFile) {
            Split-Path -Leaf $canonicalFile
        } else {
            ''
        }
        $isOwnedPersona = (
            $parent -ieq $canonicalPayloadDir -or
            $parent -ieq $canonicalNativeDir
        ) -and $leaf -like 'ap-*.md'
        if (-not $isOwnedPersona -or
            (Test-Path -LiteralPath (Join-Path $sourceDir $leaf) -PathType Leaf)) {
            continue
        }
        if (-not (Remove-IdemManagedFile -ConfigRoot $root -Path $file)) {
            [Console]::Error.WriteLine(
                "Autoprompt install (claude): could not prune receipt-owned stale persona $file."
            )
            return 94
        }
    }
    return 0
}

# Invoke-LibRecord: run a library function, capturing its [Console]::Out RECORD (the
# library writes records via [Console]::Out.WriteLine, not the return pipeline) while
# letting its stderr reach the operator. Returns @{ Code; Record }.
function Invoke-LibRecord {
    param([scriptblock]$Call)
    $sw = New-Object System.IO.StringWriter
    $orig = [Console]::Out
    [Console]::SetOut($sw)
    try { $code = & $Call } finally { [Console]::SetOut($orig) }
    return @{ Code = [int]$code; Record = $sw.ToString().Trim() }
}

function Set-LandingFailure {
    param([string]$Client, [string]$Stage, [string]$Message = '')
    if (-not [string]::IsNullOrEmpty($Message)) {
        [Console]::Error.WriteLine($Message)
    }
    $script:ResultRows += "RESULT=FAIL client=$Client stage=$Stage"
    $script:AnyFail = 1
}

function Get-LandingPayload {
    param([string]$Client)
    $file = Get-PayloadFile -Client $Client
    if ([string]::IsNullOrEmpty($file) -or
        -not (Test-Path -LiteralPath $file -PathType Leaf)) {
        Set-LandingFailure -Client $Client -Stage 'payload' `
            -Message "Autoprompt install ($Client): payload not found at $file"
        return $null
    }
    $name = Get-PayloadField -File $file -Key 'name'
    $description = Get-PayloadField -File $file -Key 'description'
    $body = Get-PayloadBody -File $file
    if ($Client -eq 'vscode') {
        if ($body.StartsWith("`n")) { $body = $body.Substring(1) }
        $body = $body.TrimEnd([char]13, [char]10)
    }
    if ([string]::IsNullOrEmpty($name) -or [string]::IsNullOrEmpty($body)) {
        Set-LandingFailure -Client $Client -Stage 'payload' `
            -Message "Autoprompt install ($Client): could not read name/body from $file"
        return $null
    }
    if ($Client -in @('opencode', 'kilo')) {
        $sourceAgents = Join-Path $RepoRoot "agents/$Client/agents"
        $profileName = if ($Client -eq 'kilo') {
            'autoprompt.kilo.json'
        } else {
            'autoprompt.opencode.json'
        }
        $sourceProfile = Join-Path $RepoRoot "agents/$Client/$profileName"
        $payloadCode = if ($Client -eq 'kilo') {
            Test-KiloAgentPayload -SourceDir $sourceAgents
        } else {
            Test-OpencodeAgentPayload -SourceDir $sourceAgents
        }
        if ($payloadCode -ne 0) {
            Set-LandingFailure -Client $Client -Stage 'payload' -Message `
                "Autoprompt install ($Client): current payload contains no native subagents."
            return $null
        }
        $profileValid = if ($Client -eq 'kilo') {
            Test-KiloProfilePolicy -Path $sourceProfile
        } else {
            Test-OpencodeProfilePolicy -Path $sourceProfile
        }
        if (-not $profileValid) {
            Set-LandingFailure -Client $Client -Stage 'payload' -Message `
                "Autoprompt install ($Client): activation profile is invalid."
            return $null
        }
    }
    return @{ Name = $name; Description = $description; Body = $body }
}

function Invoke-LandingMigration {
    param([string]$Client, [string]$Root)
    $migrationCode = Invoke-LegacyActivationMigration -Client $Client -Root $Root
    if ($migrationCode -ne 0) {
        Set-LandingFailure -Client $Client -Stage 'migration' -Message `
            "Autoprompt install ($Client): receipt-owned legacy activation migration failed."
        return 1
    }
    if ($Client -ne 'claude' -or (Remove-StaleClaudePersonas) -eq 0) {
        return 0
    }
    Set-LandingFailure -Client $Client -Stage 'migration' -Message `
        "Autoprompt install ($Client): stale private persona migration failed."
    return 1
}

function Install-LandingPayload {
    param([string]$Client, [string]$Root, [hashtable]$Payload)
    $idem = Invoke-LibRecord -Call {
        Install-Idempotent -ConfigRoot $Root -Name $Client `
            -SkillName $Payload.Name -Description $Payload.Description `
            -Body $Payload.Body
    }
    if ($idem.Code -ne 0) {
        Set-LandingFailure -Client $Client -Stage 'install' -Message `
            "Autoprompt install ($Client): install failed (code $($idem.Code))."
        return 1
    }
    $idemRecord = $idem.Record
    $extrasSrc = Get-ExtrasSrcDir -Client $Client
    if (-not [string]::IsNullOrEmpty($extrasSrc)) {
        $agentsDest = if ($Client -eq 'vscode') {
            ''
        } else {
            Get-ExtrasAgentsDir -Client $Client
        }
        $extras = Invoke-LibRecord -Call {
            Install-Extras -Name $Client -SrcDir $extrasSrc `
                -SkillDest (Get-ExtrasSkillDir -Client $Client) `
                -AgentsDest $agentsDest `
                -ConfigRoot $Root
        }
        if ($extras.Code -ne 0) {
            Set-LandingFailure -Client $Client -Stage 'extras' -Message `
                "Autoprompt install ($Client): runtime extras copy failed (see message above)."
            return 1
        }
    }
    return @{ IdemRecord = $idemRecord }
}

function Install-LandingActivation {
    param([string]$Client)
    if ($Client -eq 'codex' -and (Install-CodexAgents) -ne 0) {
        Set-LandingFailure -Client $Client -Stage 'agents'
        return 1
    }
    if ($Client -eq 'vscode') {
        if ((Install-VscodeActivation) -eq 0) { return 0 }
        Set-LandingFailure -Client $Client -Stage 'activation-missing' `
            -Message 'Autoprompt install (vscode): activation-missing; settings were not changed.'
        return 1
    }
    if ($Client -eq 'omp') {
        if ((Install-HarnessProviderDepth -Provider 'omp') -eq 0) { return 0 }
        Set-LandingFailure -Client $Client -Stage 'activation-missing' `
            -Message 'Autoprompt install (omp): required task recursion depth could not be configured.'
        return 1
    }
    if ($Client -eq 'deepseek') {
        if ((Install-DeepseekActivation) -eq 0) { return 0 }
        Set-LandingFailure -Client $Client -Stage 'agents'
        return 1
    }
    if ($Client -eq 'reasonix') {
        if ((Install-ReasonixActivation) -eq 0) { return 0 }
        Set-LandingFailure -Client $Client -Stage 'agents'
        return 1
    }
    if ($Client -notin @('opencode', 'kilo')) { return 0 }
    $pruneCode = if ($Client -eq 'kilo') {
        Remove-StaleKiloAgents
    } else {
        Remove-StaleOpencodeAgents
    }
    if ($pruneCode -ne 0) {
        Set-LandingFailure -Client $Client -Stage 'migration' -Message `
            "Autoprompt install ($Client): stale receipt-owned subagent migration failed."
        return 1
    }
    $activationCode = if ($Client -eq 'kilo') {
        Install-KiloActivation
    } else {
        Install-OpencodeActivation
    }
    if ($activationCode -ne 0) {
        Set-LandingFailure -Client $Client -Stage 'agents' -Message `
            "Autoprompt install ($Client): native subagent/activation-profile landing failed."
        return 1
    }
    return 0
}

function Install-Landing {
    param([string]$Client)
    $root = Get-ConfigRoot -Client $Client
    $payload = Get-LandingPayload -Client $Client
    if ($null -eq $payload) { return }
    $precheck = Invoke-LibRecord -Call { Test-Precheck -Name $Client }
    if ($precheck.Code -ne 0) {
        Set-LandingFailure -Client $Client -Stage 'precheck' -Message `
            "Autoprompt install ($Client): precheck failed (see message above)."
        return
    }
    $migrationCode = Invoke-LandingMigration -Client $Client -Root $root
    if ($migrationCode -ne 0) { return }
    $landing = Install-LandingPayload -Client $Client -Root $root -Payload $payload
    if ($landing -isnot [hashtable]) { return }
    if ((Install-LandingActivation -Client $Client) -ne 0) { return }
    $verify = Invoke-LibRecord -Call { Verify-Install -Name $Client }
    if ($verify.Code -ne 0) {
        Set-LandingFailure -Client $Client -Stage 'verify' -Message `
            "Autoprompt install ($Client): post-install verify failed (see above)."
        return
    }
    if ($Client -ceq 'omp') {
        $script:AutopromptReceiptOmpManaged = $true
    }
    if ($Client -ceq 'omp' -and $env:PI_CODING_AGENT_DIR -and
        -not (Test-AutopromptInstallRootOverridePresent) -and
        [string]::IsNullOrEmpty((Get-AutopromptOmpProfile))) {
        $script:AutopromptReceiptOmpDetachedRoot =
            Get-AutopromptOmpDefaultAgentRoot
    }
    $landed = ($verify.Record -replace '^client=\S+ verify=pass dest=', '') `
        -replace ' format=\S+$', ''
    $format = $verify.Record -replace '^.* format=', ''
    $script:ResultRows += "RESULT=PASS client=$Client dest=$landed format=$format signal=verify=pass detail=$($landing.IdemRecord)"
}

function Get-ResolvedInstallTarget {
    param([string]$Client)
    $resolved = Invoke-LibRecord -Call {
        Resolve-Destination -Name $Client
    }
    if ($resolved.Code -ne 0) {
        throw "could not resolve the $Client install target"
    }
    return (Get-CopyDestination -Record $resolved.Record).Landed
}

function New-TargetPreflightException {
    param([string]$Message, [int]$Code)
    $exception = New-Object System.InvalidOperationException $Message
    $exception.Data['TargetPreflightCode'] = $Code
    return $exception
}

function Get-RuntimeInventory {
    param([string]$Client)
    $tool = Join-Path $RepoRoot 'scripts/runtime-payload.cjs'
    if (-not (Test-Path -LiteralPath $tool -PathType Leaf) -or
        -not (Get-Command node -ErrorAction SilentlyContinue)) {
        throw (New-TargetPreflightException `
            -Message "runtime inventory tool unavailable for $Client" `
            -Code 82)
    }
    $relativeFiles = @(& node $tool --inventory $Client)
    if ($LASTEXITCODE -ne 0) {
        throw (New-TargetPreflightException `
            -Message "runtime inventory validation failed for $Client" `
            -Code 82)
    }
    return $relativeFiles
}

function Get-ExtrasInstallTargetPlan {
    param([string]$Client)
    if ([string]::IsNullOrEmpty((Get-ExtrasSrcDir -Client $Client))) {
        return @()
    }
    $skillDestination = Get-ExtrasSkillDir -Client $Client
    return @(Get-RuntimeInventory -Client $Client | Where-Object {
        $Client -ne 'vscode' -or $_ -cne 'SKILL.md'
    } | ForEach-Object {
        $nativeRelative = $_ -replace '/', [IO.Path]::DirectorySeparatorChar
        Join-Path $skillDestination $nativeRelative
    })
}

function Get-RuntimeAgentNames {
    param([string]$Client)
    return @(Get-RuntimeInventory -Client $Client |
        Where-Object { $_ -clike 'agents/ap-*.md' } |
        ForEach-Object { Split-Path -Leaf $_ })
}

function Get-ClaudeNativeTargetPlan {
    $destination = Get-ExtrasAgentsDir -Client 'claude'
    return @(Get-RuntimeAgentNames -Client 'claude' | ForEach-Object {
        Join-Path $destination $_
    })
}

function Get-CodexActivationTargetPlan {
    $agentsDirectory = Get-CodexAgentsDir
    $targets = @(Get-RuntimeAgentNames -Client 'claude' | ForEach-Object {
        Join-Path $agentsDirectory ([IO.Path]::ChangeExtension($_, '.toml'))
    })
    $targets += Join-Path $agentsDirectory '.autoprompt-casting.json'
    $targets += Get-CodexProfileFile
    return $targets
}

function Get-OpencodeActivationTargetPlan {
    $agentsDirectory = Get-OpencodeAgentsDir
    $targets = @(Get-RuntimeInventory -Client 'opencode' |
        Where-Object { $_ -clike 'agents/ap-*.md' } | ForEach-Object {
            Join-Path $agentsDirectory (Split-Path -Leaf $_)
        })
    $targets += Get-OpencodeProfileFile
    return $targets
}

function Get-KiloActivationTargetPlan {
    $agentsDirectory = Get-KiloAgentsDir
    $targets = @(Get-RuntimeInventory -Client 'kilo' |
        Where-Object { $_ -clike 'agents/ap-*.md' } | ForEach-Object {
            Join-Path $agentsDirectory (Split-Path -Leaf $_)
        })
    $targets += Get-KiloProfileFile
    return $targets
}

function Get-VscodeActivationTargetPlan {
    $agentsDirectory = Get-ExtrasAgentsDir -Client 'vscode'
    return @(Get-RuntimeInventory -Client 'vscode' |
        Where-Object { $_ -clike 'agents/ap-*.agent.md' } |
        ForEach-Object { Join-Path $agentsDirectory (Split-Path -Leaf $_) })
}

function Get-OmpActivationTargetPlan {
    $agentsDirectory = Get-ExtrasAgentsDir -Client 'omp'
    return @(Get-RuntimeInventory -Client 'omp' |
        Where-Object { $_ -clike 'agents/ap-*.md' } |
        ForEach-Object { Join-Path $agentsDirectory (Split-Path -Leaf $_) })
}

function Get-DeepseekActivationTargetPlan {
    $directory = Join-Path (Get-ConfigRoot -Client 'deepseek') `
        '.agent-presets/autoprompt'
    return @(
        Join-Path $directory 'agent.cordis.yml'
        Join-Path $directory 'preset.yml'
    )
}

function Get-ReasonixActivationTargetPlan {
    $root = Get-ConfigRoot -Client 'reasonix'
    return @(Get-RuntimeInventory -Client 'reasonix' |
        Where-Object { $_ -clike 'skills/ap-*/SKILL.md' } |
        ForEach-Object {
            Join-Path $root ($_ -replace '/', [IO.Path]::DirectorySeparatorChar)
        })
}

function Get-ClientInstallTargetPlan {
    param([string]$Client)
    $targets = @(Get-ResolvedInstallTarget -Client $Client)
    $targets += @(Get-ExtrasInstallTargetPlan -Client $Client)
    switch ($Client) {
        'claude' { $targets += @(Get-ClaudeNativeTargetPlan) }
        'codex' { $targets += @(Get-CodexActivationTargetPlan) }
        'opencode' { $targets += @(Get-OpencodeActivationTargetPlan) }
        'kilo' { $targets += @(Get-KiloActivationTargetPlan) }
        'vscode' { $targets += @(Get-VscodeActivationTargetPlan) }
        'omp' { $targets += @(Get-OmpActivationTargetPlan) }
        'deepseek' { $targets += @(Get-DeepseekActivationTargetPlan) }
        'reasonix' { $targets += @(Get-ReasonixActivationTargetPlan) }
    }
    return $targets
}

function Get-ClientsForRoot {
    param([string]$Root, [string[]]$Clients)
    return @($Clients | Where-Object {
        Test-IdemPathEqual -Left (Get-ConfigRoot -Client $_) -Right $Root
    })
}

function Get-RootInstallTargetEntries {
    param([string]$Root, [string[]]$Clients)
    foreach ($client in @(Get-ClientsForRoot -Root $Root -Clients $Clients)) {
        foreach ($target in @(Get-ClientInstallTargetPlan -Client $client)) {
            [pscustomobject]@{ Client = $client; Target = $target }
        }
    }
}

function Get-RootInstallTargetPlan {
    param([string]$Root, [string[]]$Clients)
    return @(Get-RootInstallTargetEntries -Root $Root -Clients $Clients |
        ForEach-Object { $_.Target })
}

function Test-RootInstallTargetEntries {
    param([string]$Root, [object[]]$Entries)
    $identities = New-Object 'System.Collections.Generic.HashSet[string]' `
        (Get-IdemPathComparer)
    $ownedPaths = New-Object 'System.Collections.Generic.HashSet[string]' `
        (Get-IdemPathComparer)
    foreach ($ownedPath in @($script:AutopromptReceiptFiles)) {
        $ownedIdentity = Get-IdemNormalizedPath -Path $ownedPath
        if (-not [string]::IsNullOrEmpty($ownedIdentity)) {
            [void]$ownedPaths.Add($ownedIdentity)
        }
    }
    foreach ($entry in $Entries) {
        $identity = Get-IdemNormalizedPath -Path $entry.Target
        if ([string]::IsNullOrEmpty($identity) -or
            -not (Test-AutopromptManagedInstallPathAllowed `
                -Path $identity -Root $Root) -or
            -not $identities.Add($identity)) {
            return @{ Code = 44; Client = ''; Target = '' }
        }
        $targetItem = Get-Item -LiteralPath $identity -Force `
            -ErrorAction SilentlyContinue
        if ($null -ne $targetItem -and (
            $targetItem -isnot [System.IO.FileInfo] -or
            $targetItem.Attributes.HasFlag(
                [System.IO.FileAttributes]::ReparsePoint
            ) -or -not $ownedPaths.Contains($identity))) {
            return @{ Code = 43; Client = $entry.Client; Target = $identity }
        }
    }
    return @{ Code = 0; Client = ''; Target = '' }
}

function Test-RootInstallTargetPlan {
    param([string]$Root, [string[]]$Targets)
    $entries = @($Targets | ForEach-Object {
        [pscustomobject]@{ Client = ''; Target = $_ }
    })
    return (Test-RootInstallTargetEntries -Root $Root -Entries $entries).Code
}

function Read-RootReceiptState {
    param([string]$Root)
    $receiptPath = Join-Path $Root $AutopromptReceiptName
    if (-not (Test-Path -LiteralPath $receiptPath -PathType Leaf)) {
        return $null
    }
    try {
        $receipt = Read-UninstallReceipt -ConfigRoot $Root
    } catch {
        throw "could not read existing receipt at $receiptPath"
    }
    if ($receipt -is [int]) {
        throw "existing receipt at $receiptPath is invalid (code $receipt)"
    }
    if ($receipt -isnot [hashtable]) {
        throw "existing receipt at $receiptPath has an invalid result"
    }
    return $receipt
}

function Set-RootReceiptAccumulators {
    param([AllowNull()][hashtable]$Receipt)
    $files = if ($null -eq $Receipt) { @() } else {
        @($Receipt.Files | Where-Object { -not [string]::IsNullOrEmpty($_) })
    }
    $directories = if ($null -eq $Receipt) { @() } else {
        @($Receipt.CreatedDirectories | Where-Object {
            -not [string]::IsNullOrEmpty($_)
        })
    }
    $edits = if ($null -eq $Receipt) { @() } else { @($Receipt.Edits) }
    $backup = if ($null -eq $Receipt -or
        [string]::IsNullOrEmpty($Receipt.Backup)) { 'none' } else {
        $Receipt.Backup
    }
    $script:AutopromptReceiptFiles = @($files)
    $script:AutopromptReceiptCreatedDirectories = @($directories)
    $script:AutopromptReceiptEdits = @($edits)
    $script:AutopromptReceiptOmpManaged = $null -ne $Receipt -and
        [bool]$Receipt.OmpManaged
    $script:AutopromptReceiptHasOmpManaged = $null -ne $Receipt -and
        [bool]$Receipt.HasOmpManaged
    $script:AutopromptReceiptOmpDetachedRoot = if ($null -eq $Receipt) {
        ''
    } else {
        [string]$Receipt.OmpDetachedRoot
    }
    $script:AutopromptConfigEditLastBackup = $backup
    $script:AutopromptManagedUndoJournal = @()
    $script:AutopromptRootReceiptState = $Receipt
    $legacy = $null -ne $Receipt -and $Receipt.ContainsKey('Legacy') -and
        [bool]$Receipt.Legacy
    $script:AutopromptLegacyCodexMigration = $legacy
    return @{ Files = $files; Edits = $edits; Legacy = $legacy }
}

function Initialize-RootOwnershipState {
    param([string]$Root)
    $receipt = Read-RootReceiptState -Root $Root
    if ($null -eq $receipt) {
        $receipt = Get-LegacyCodexOwnershipState -Root $Root
    }
    return Set-RootReceiptAccumulators -Receipt $receipt
}

function Test-RootReceiptOwnsSelfContainedOmp {
    param([string]$Root, [string[]]$LocalAgentFiles)
    $config = Join-Path $Root 'config.yml'
    foreach ($edit in @($script:AutopromptReceiptEdits)) {
        if ($edit.Key -ceq 'task.maxRecursionDepth' -and
            (Test-IdemPathEqual -Left $edit.File -Right $config)) {
            return $true
        }
    }
    foreach ($file in @($LocalAgentFiles)) {
        $source = Join-Path (Join-Path $RepoRoot 'agents/omp/agents') `
            (Split-Path -Leaf $file)
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { continue }
        try {
            $recordedHash = Get-IdemManifestHash -ConfigRoot $Root -Key $file
        } catch {
            continue
        }
        $sourceHash = Get-IdemSha256 -Path $source
        if ($sourceHash -is [string] -and $recordedHash -ceq $sourceHash) {
            return $true
        }
    }
    return $false
}

function Test-RootOmpDetachedLayoutCompatible {
    param([string]$Root, [string[]]$Clients)
    if (@(Get-ClientsForRoot -Root $Root -Clients $Clients) -notcontains 'omp') {
        return $true
    }

    $usesDetachedRoot = $env:PI_CODING_AGENT_DIR -and
        -not (Test-AutopromptInstallRootOverridePresent) -and
        [string]::IsNullOrEmpty((Get-AutopromptOmpProfile))
    $currentDetachedRoot = if ($usesDetachedRoot) {
        Get-AutopromptOmpDefaultAgentRoot
    } else {
        ''
    }
    if ([string]::IsNullOrEmpty($script:AutopromptReceiptOmpDetachedRoot)) {
        if ([string]::IsNullOrEmpty($currentDetachedRoot)) { return $true }
        if ($script:AutopromptReceiptOmpManaged) {
            $ownsSelfContainedOmp = $true
        } elseif ($script:AutopromptReceiptHasOmpManaged) {
            return $true
        } else {
            $ownsSelfContainedOmp = $false
        }
        $localAgents = Join-Path $Root 'agents'
        $localAgentFiles = @($script:AutopromptReceiptFiles | Where-Object {
            (Split-Path -Leaf $_) -clike 'ap-*.md' -and
            (Test-IdemPathEqual -Left (Split-Path -Parent $_) `
                -Right $localAgents)
        })
        if (-not $ownsSelfContainedOmp -and $localAgentFiles.Count -gt 0) {
            $ownsSelfContainedOmp = Test-RootReceiptOwnsSelfContainedOmp `
                -Root $Root -LocalAgentFiles $localAgentFiles
        }
        if (-not $ownsSelfContainedOmp) {
            return $true
        }
        [Console]::Error.WriteLine(
            'error=omp-detached-root-layout-transition ' +
            'recorded=<self-contained> ' +
            "current=$currentDetachedRoot action=uninstall-first"
        )
        return $false
    }
    if (-not [string]::IsNullOrEmpty($currentDetachedRoot) -and
        (Test-IdemPathEqual -Left $script:AutopromptReceiptOmpDetachedRoot `
            -Right $currentDetachedRoot)) {
        return $true
    }

    $current = if ([string]::IsNullOrEmpty($currentDetachedRoot)) {
        '<self-contained>'
    } else {
        $currentDetachedRoot
    }
    [Console]::Error.WriteLine(
        'error=omp-detached-root-layout-transition ' +
        "recorded=$script:AutopromptReceiptOmpDetachedRoot " +
        "current=$current action=uninstall-first"
    )
    return $false
}

function Start-RootTransaction {
    param([string]$Root, [hashtable]$State, [string[]]$Targets)
    $snapshotPaths = @($State.Files) + @($Targets)
    $artifactBases = @($Targets) + @(
        (Join-Path $Root $AutopromptHashManifestName),
        (Join-Path $Root $AutopromptReceiptName)
    )
    foreach ($artifactBase in $artifactBases) {
        foreach ($suffix in @(
            '.tmp',
            '.autoprompt.tmp',
            '.autoprompt.replace.bak',
            '.autoprompt.restore.tmp',
            '.autoprompt.restore.bak'
        )) {
            $snapshotPaths += "$artifactBase$suffix"
        }
    }
    foreach ($edit in @($State.Edits)) {
        $snapshotPaths += $edit.File
        $snapshotPaths += "$($edit.File)$AutopromptConfigEditBackupSuffix"
    }
    $snapshot = New-IdemManagedSnapshot -ConfigRoot $Root -Paths $snapshotPaths
    if ($null -eq $snapshot) {
        throw "could not create root transaction state under $Root"
    }
    if ($State.Legacy) {
        $recoveryPath = Join-Path $Root $LegacyCodexRecoveryName
        if (Test-Path -LiteralPath $recoveryPath) {
            Remove-IdemManagedRecovery -Snapshot $snapshot | Out-Null
            throw "unfinished older Codex recovery already exists at $recoveryPath"
        }
        try {
            Move-Item -LiteralPath $snapshot.RecoveryPath `
                -Destination $recoveryPath -ErrorAction Stop
        } catch {
            Remove-IdemManagedRecovery -Snapshot $snapshot | Out-Null
            throw "could not preserve older Codex recovery at $recoveryPath"
        }
        $snapshot.RecoveryPath = $recoveryPath
        $snapshot.InMemoryRestoreToken = $script:AutopromptInMemoryRestoreToken
    }
    Add-IdemManagedUndo -Snapshot $snapshot
}

function Test-LegacyCodexRecoverySnapshot {
    param([object]$Snapshot, [string]$Root)
    if ($null -eq $Snapshot -or
        -not (Test-IdemPathEqual -Left ([string]$Snapshot.ConfigRoot) -Right $Root) -or
        -not [bool]$Snapshot.ConfigRootExisted -or
        @($Snapshot.ReceiptEdits).Count -ne 0 -or
        @($Snapshot.ReceiptCreatedDirectories).Count -ne 0 -or
        [string]$Snapshot.ConfigEditLastBackup -cne 'none') {
        return $false
    }
    try {
        $compat = Get-Content (Join-Path $RepoRoot 'scripts/install/legacy-codex-compat.json') `
            -Raw | ConvertFrom-Json
    } catch {
        return $false
    }
    $legacyPaths = @($compat.files | ForEach-Object {
        Join-Path (Join-Path $Root 'skills/autoprompt') ([string]$_)
    })
    $currentTargets = @(Get-ClientInstallTargetPlan -Client 'codex')
    $expectedPaths = @($legacyPaths)
    $expectedPaths += $currentTargets
    $expectedPaths += Join-Path $Root $AutopromptHashManifestName
    $expectedPaths += Join-Path $Root $AutopromptReceiptName
    $artifactBases = @($currentTargets) + @(
        (Join-Path $Root $AutopromptHashManifestName),
        (Join-Path $Root $AutopromptReceiptName)
    )
    foreach ($artifactBase in $artifactBases) {
        foreach ($suffix in @(
            '.tmp',
            '.autoprompt.tmp',
            '.autoprompt.replace.bak',
            '.autoprompt.restore.tmp',
            '.autoprompt.restore.bak'
        )) {
            $expectedPaths += "$artifactBase$suffix"
        }
    }
    $expectedPaths = @(Get-UniqueReceiptPaths -Paths $expectedPaths)
    if (@($Snapshot.Files).Count -ne $expectedPaths.Count) { return $false }
    $recordsByPath = New-Object `
        'System.Collections.Generic.Dictionary[string,object]' `
        (Get-IdemPathComparer)
    foreach ($record in @($Snapshot.Files)) {
        $recordPath = [string]$record.Path
        if ([string]::IsNullOrEmpty($recordPath) -or
            $recordsByPath.ContainsKey($recordPath)) {
            return $false
        }
        $recordsByPath.Add($recordPath, $record)
    }
    foreach ($expectedPath in $expectedPaths) {
        if (-not $recordsByPath.ContainsKey($expectedPath)) { return $false }
    }
    $legacyPathSet = New-Object 'System.Collections.Generic.HashSet[string]' `
        (Get-IdemPathComparer)
    foreach ($legacyPath in $legacyPaths) { [void]$legacyPathSet.Add($legacyPath) }
    foreach ($relativePath in @($compat.files)) {
        $expectedPath = Join-Path (Join-Path $Root 'skills/autoprompt') `
            ([string]$relativePath)
        $record = $recordsByPath[$expectedPath]
        $expectedSize = [long]$compat.sizes.PSObject.Properties[
            [string]$relativePath
        ].Value
        $expectedHash = [string]$compat.sha256.PSObject.Properties[
            [string]$relativePath
        ].Value
        if (-not [bool]$record.Exists -or
            @($record.Bytes).Count -ne $expectedSize) {
            return $false
        }
        $hasher = [Security.Cryptography.SHA256]::Create()
        try {
            $hashBytes = $hasher.ComputeHash([byte[]]$record.Bytes)
        } finally {
            $hasher.Dispose()
        }
        $hash = ([BitConverter]::ToString($hashBytes) -replace '-', '').ToLowerInvariant()
        if ($hash -cne $expectedHash) { return $false }
    }
    foreach ($currentOnlyPath in @($expectedPaths | Where-Object {
        -not $legacyPathSet.Contains([string]$_) -and
        -not (Test-IdemPathEqual -Left $_ `
            -Right (Join-Path $Root $AutopromptHashManifestName)) -and
        -not (Test-IdemPathEqual -Left $_ `
            -Right (Join-Path $Root $AutopromptReceiptName))
    })) {
        $record = $recordsByPath[$currentOnlyPath]
        if ([bool]$record.Exists) { return $false }
    }
    foreach ($absentPath in @(
        (Join-Path $Root $AutopromptHashManifestName),
        (Join-Path $Root $AutopromptReceiptName)
    )) {
        $record = $recordsByPath[$absentPath]
        if ([bool]$record.Exists) { return $false }
    }
    if (@($Snapshot.ReceiptFiles).Count -ne $legacyPaths.Count) { return $false }
    $receiptPathSet = New-Object 'System.Collections.Generic.HashSet[string]' `
        (Get-IdemPathComparer)
    foreach ($receiptPath in @($Snapshot.ReceiptFiles)) {
        if (-not $receiptPathSet.Add([string]$receiptPath)) { return $false }
    }
    foreach ($legacyPath in $legacyPaths) {
        if (-not $receiptPathSet.Contains($legacyPath)) { return $false }
    }
    $expectedDirectories = New-Object 'System.Collections.Generic.HashSet[string]' `
        (Get-IdemPathComparer)
    foreach ($expectedPath in $expectedPaths) {
        $directory = Split-Path -Parent $expectedPath
        while (-not [string]::IsNullOrEmpty($directory) -and
            -not (Test-IdemPathEqual -Left $directory -Right $Root)) {
            [void]$expectedDirectories.Add($directory)
            $parent = Split-Path -Parent $directory
            if ($parent -ceq $directory) { break }
            $directory = $parent
        }
    }
    $actualDirectories = @($Snapshot.Directories.Keys)
    if ($actualDirectories.Count -ne $expectedDirectories.Count) { return $false }
    $skillRoot = Join-Path $Root 'skills/autoprompt'
    $legacyDirectories = New-Object 'System.Collections.Generic.HashSet[string]' `
        (Get-IdemPathComparer)
    [void]$legacyDirectories.Add((Join-Path $Root 'skills'))
    [void]$legacyDirectories.Add($skillRoot)
    foreach ($relativeDirectory in @($compat.directories)) {
        [void]$legacyDirectories.Add((Join-Path $skillRoot ([string]$relativeDirectory)))
    }
    foreach ($directory in $actualDirectories) {
        if (-not $expectedDirectories.Contains([string]$directory)) { return $false }
        $value = $Snapshot.Directories[$directory]
        if ($value -isnot [bool] -or
            [bool]$value -ne $legacyDirectories.Contains([string]$directory)) {
            return $false
        }
    }
    return $true
}

function Restore-InterruptedLegacyCodexMigration {
    param([string]$Root)
    $recoveryPath = Join-Path $Root $LegacyCodexRecoveryName
    if (-not (Test-Path -LiteralPath $recoveryPath -PathType Leaf)) {
        return $true
    }
    try {
        $snapshot = Import-Clixml -LiteralPath $recoveryPath -ErrorAction Stop
    } catch {
        $snapshot = $null
    }
    if (-not (Test-LegacyCodexRecoverySnapshot -Snapshot $snapshot -Root $Root)) {
        [Console]::Error.WriteLine(
            "Autoprompt install: older Codex recovery is invalid at $recoveryPath."
        )
        return $false
    }
    $rootItem = Get-Item -LiteralPath $Root -Force -ErrorAction SilentlyContinue
    if ($null -eq $rootItem -or $rootItem -isnot [System.IO.DirectoryInfo] -or
        $rootItem.Attributes.HasFlag([System.IO.FileAttributes]::ReparsePoint)) {
        return $false
    }
    foreach ($directory in @($snapshot.Directories.Keys)) {
        $path = [string]$directory
        if (-not (Test-IdemReceiptPathUnderRoot -Path $path -Root $Root)) {
            [Console]::Error.WriteLine(
                "Autoprompt install: older Codex recovery path escapes $Root`: $path."
            )
            return $false
        }
        $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
        if ($null -ne $item -and $item.Attributes.HasFlag(
            [System.IO.FileAttributes]::ReparsePoint
        )) {
            [Console]::Error.WriteLine(
                "Autoprompt install: older Codex recovery found a reparse path at $path."
            )
            return $false
        }
    }
    foreach ($record in @($snapshot.Files)) {
        $path = [string]$record.Path
        if (-not (Test-IdemPathUnderRoot -Path $path -Root $Root)) {
            [Console]::Error.WriteLine(
                "Autoprompt install: older Codex recovery path escapes $Root`: $path."
            )
            return $false
        }
        $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
        if ($null -ne $item -and $item.Attributes.HasFlag(
            [System.IO.FileAttributes]::ReparsePoint
        )) {
            [Console]::Error.WriteLine(
                "Autoprompt install: older Codex recovery found a reparse path at $path."
            )
            return $false
        }
    }
    # Restore only the snapshot that passed validation above. Leaving the durable
    # path attached would make the shared helper import the file a second time.
    $snapshot.RecoveryPath = ''
    if (-not (Restore-IdemManagedSnapshot -Snapshot $snapshot `
            -UseInMemorySnapshot) -or
        -not (Remove-IdemRecoveryPath -Path $recoveryPath)) {
        [Console]::Error.WriteLine(
            "Autoprompt install: could not restore older Codex recovery at $recoveryPath."
        )
        return $false
    }
    [Console]::Error.WriteLine(
        "Autoprompt install: restored an interrupted older Codex upgrade under $Root."
    )
    return $true
}

function Initialize-RootAccumulators {
    param([string]$Root)
    $state = Initialize-RootOwnershipState -Root $Root
    Start-RootTransaction -Root $Root -State $state
}

function Test-RootReceiptState {
    param(
        [hashtable]$Prior,
        [string]$Backup,
        [string[]]$Files,
        [string[]]$CreatedDirectories,
        [bool]$OmpManaged,
        [string]$OmpDetachedRoot,
        [hashtable[]]$Edits
    )
    if ($null -eq $Prior -or $Prior.Backup -cne $Backup) {
        return $false
    }
    if (-not [bool]$Prior.HasOmpManaged -or
        -not [bool]$Prior.HasOmpDetachedRoot) {
        return $false
    }
    if ([bool]$Prior.OmpManaged -ne $OmpManaged) { return $false }
    if ([string]$Prior.OmpDetachedRoot -cne $OmpDetachedRoot) {
        return $false
    }
    if ((Format-ReceiptFilesArray -Files ([string[]]@($Prior.Files))) -cne
        (Format-ReceiptFilesArray -Files $Files)) {
        return $false
    }
    if ((Format-ReceiptFilesArray -Files (
        [string[]]@($Prior.CreatedDirectories)
    )) -cne (Format-ReceiptFilesArray -Files $CreatedDirectories)) {
        return $false
    }
    return (Format-ReceiptEditsArray -Edits ([hashtable[]]@($Prior.Edits))) -ceq
        (Format-ReceiptEditsArray -Edits $Edits)
}

function Get-UniqueReceiptPaths {
    param([object[]]$Paths)
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' `
        (Get-IdemPathComparer)
    $unique = @()
    foreach ($path in $Paths) {
        $identity = Get-IdemNormalizedPath -Path ([string]$path)
        if (-not [string]::IsNullOrEmpty($identity) -and $seen.Add($identity)) {
            $unique += $path
        }
    }
    return $unique
}

function Write-RootReceiptFile {
    param([string]$Root, [string[]]$Files, [string[]]$Directories)
    $receiptPath = Join-Path $Root $AutopromptReceiptName
    $isNoop = -not (Test-Path -LiteralPath "$receiptPath.tmp") -and
        -not (Test-Path -LiteralPath "$receiptPath.autoprompt.replace.bak") -and
        (Test-RootReceiptState -Prior $script:AutopromptRootReceiptState `
            -Backup $script:AutopromptConfigEditLastBackup -Files $Files `
            -CreatedDirectories $Directories `
            -OmpManaged $script:AutopromptReceiptOmpManaged `
            -OmpDetachedRoot $script:AutopromptReceiptOmpDetachedRoot `
            -Edits ([hashtable[]]$script:AutopromptReceiptEdits))
    if ($isNoop) { return $true }
    $result = Invoke-LibRecord -Call {
        Write-Receipt -ConfigRoot $Root -Nonce (Get-Nonce) `
            -Backup $script:AutopromptConfigEditLastBackup -Files $Files `
            -CreatedDirectories $Directories `
            -OmpManaged $script:AutopromptReceiptOmpManaged `
            -OmpDetachedRoot $script:AutopromptReceiptOmpDetachedRoot `
            -Edits $script:AutopromptReceiptEdits
    }
    if ($result.Code -eq 0) { return $true }
    Invoke-FinalManagedRollback -Context "receipt under $Root" | Out-Null
    [Console]::Error.WriteLine(
        "Autoprompt install: could not write the receipt under $Root (see above)."
    )
    $script:AnyFail = 1
    return $false
}

function Set-RootReceipt {
    param([string]$Root)
    $script:AutopromptRootFailureStage = 'receipt'
    $files = @(Get-UniqueReceiptPaths -Paths $script:AutopromptReceiptFiles)
    $directories = @(Get-UniqueReceiptPaths `
        -Paths $script:AutopromptReceiptCreatedDirectories)
    if (-not (Write-RootReceiptFile -Root $Root -Files $files `
        -Directories $directories)) {
        return $false
    }
    if (Complete-IdemManagedChanges) { return $true }
    $script:AutopromptRootFailureStage = 'commit'
    [Console]::Error.WriteLine(
        "Autoprompt install: could not release transaction state under $Root."
    )
    Invoke-FinalManagedRollback `
        -Context "transaction cleanup under $Root" | Out-Null
    $script:AnyFail = 1
    return $false
}

function Set-RootResultsFailed {
    param([int]$FromIndex, [string]$Stage)
    for ($index = $FromIndex; $index -lt $script:ResultRows.Count; $index++) {
        $line = $script:ResultRows[$index]
        if ($line -notlike 'RESULT=PASS*') { continue }
        $client = ($line -replace '^.* client=', '') -replace ' .*$', ''
        $script:ResultRows[$index] = "RESULT=FAIL client=$client stage=$Stage"
    }
    $script:AnyFail = 1
}

function Write-RootSuccess {
    param([int]$FromIndex)
    for ($index = $FromIndex; $index -lt $script:ResultRows.Count; $index++) {
        $line = $script:ResultRows[$index]
        if ($line -notlike 'RESULT=PASS*') { continue }
        $client = ($line -replace '^.* client=', '') -replace ' .*$', ''
        $landed = ($line -replace '^.* dest=', '') -replace ' .*$', ''
        $fmt = ($line -replace '^.* format=', '') -replace ' .*$', ''
        $detail = $line -replace '^.* detail=', ''
        [Console]::Error.WriteLine(
            "Autoprompt install ($client): PASS -- landed $landed (format $fmt, $detail)"
        )
    }
}

function Get-InstallFailureCount {
    return @(
        $script:ResultRows | Where-Object { $_ -like 'RESULT=FAIL*' }
    ).Count
}

function Set-RootInitializationFailed {
    param([string]$Root, [string[]]$Clients, [string]$Message)
    [Console]::Error.WriteLine(
        "Autoprompt install: could not begin transaction under $Root`: $Message"
    )
    foreach ($client in @(Get-ClientsForRoot -Root $Root -Clients $Clients)) {
        $script:ResultRows += "RESULT=FAIL client=$client stage=transaction"
    }
    $script:AnyFail = 1
}

function Set-RootTargetPreflightFailed {
    param(
        [string]$Root,
        [string[]]$Clients,
        [int]$Code,
        [string]$CollisionClient = '',
        [string]$CollisionTarget = '',
        [switch]$ShouldUseProvidedClients
    )
    [Console]::Error.WriteLine(
        "Autoprompt install: target preflight failed under $Root (code $Code)."
    )
    if ($Code -eq 43 -and
        -not [string]::IsNullOrEmpty($CollisionClient) -and
        -not [string]::IsNullOrEmpty($CollisionTarget)) {
        [Console]::Error.WriteLine(
            "client=$CollisionClient error=unowned-skill-refused " +
            "dest=$CollisionTarget"
        )
    }
    $affectedClients = if ($ShouldUseProvidedClients) { @($Clients) } else {
        @(Get-ClientsForRoot -Root $Root -Clients $Clients)
    }
    foreach ($client in $affectedClients) {
        $script:ResultRows += `
            "RESULT=FAIL client=$client stage=target-preflight code=$Code"
    }
    $script:AnyFail = 1
}

function Get-RootPreflightState {
    param([string]$Root, [string[]]$Clients)
    $ownership = Initialize-RootOwnershipState -Root $Root
    if (-not (Test-RootOmpDetachedLayoutCompatible -Root $Root `
        -Clients $Clients)) {
        return @{
            Code = 44
            CollisionClient = ''
            CollisionTarget = ''
            Ownership = $ownership
            Targets = @()
        }
    }
    $entries = @(Get-RootInstallTargetEntries -Root $Root -Clients $Clients)
    $plan = Test-RootInstallTargetEntries -Root $Root -Entries $entries
    return @{
        Code = $plan.Code
        CollisionClient = $plan.Client
        CollisionTarget = $plan.Target
        Ownership = $ownership
        Targets = @($entries | ForEach-Object { $_.Target })
    }
}

function Start-ValidatedRootTransaction {
    param([string]$Root, [string[]]$Clients)
    if (@(Get-ClientsForRoot -Root $Root -Clients $Clients) -contains 'codex') {
        if (-not (Restore-InterruptedLegacyCodexMigration -Root $Root)) {
            Set-RootInitializationFailed -Root $Root -Clients $Clients `
                -Message 'older Codex recovery could not be restored'
            return $false
        }
    }
    try {
        $state = Get-RootPreflightState -Root $Root -Clients $Clients
    } catch {
        $preflightCode = $_.Exception.Data['TargetPreflightCode']
        if ($null -ne $preflightCode) {
            Set-RootTargetPreflightFailed -Root $Root -Clients $Clients `
                -Code ([int]$preflightCode)
            return $false
        }
        Set-RootInitializationFailed -Root $Root -Clients $Clients `
            -Message $_.Exception.Message
        return $false
    }
    if ($state.Code -ne 0) {
        Set-RootTargetPreflightFailed -Root $Root -Clients $Clients `
            -Code $state.Code -CollisionClient $state.CollisionClient `
            -CollisionTarget $state.CollisionTarget
        return $false
    }
    try {
        Start-RootTransaction -Root $Root -State $state.Ownership `
            -Targets $state.Targets
        return $true
    } catch {
        Set-RootInitializationFailed -Root $Root -Clients $Clients `
            -Message $_.Exception.Message
        return $false
    }
}

function Install-RootBatch {
    param([string]$Root, [string[]]$Clients)
    $resultStart = $script:ResultRows.Count
    if (-not (Start-ValidatedRootTransaction -Root $Root -Clients $Clients)) {
        return
    }
    $failureCount = Get-InstallFailureCount
    foreach ($client in @(Get-ClientsForRoot -Root $Root -Clients $Clients)) {
        Install-Landing -Client $client
        if ((Get-InstallFailureCount) -gt $failureCount) { break }
    }
    if ((Get-InstallFailureCount) -gt $failureCount) {
        Set-RootResultsFailed -FromIndex $resultStart -Stage 'landing'
        Invoke-FinalManagedRollback -Context "root $Root" | Out-Null
        return
    }
    if (-not (Set-RootReceipt -Root $Root)) {
        Set-RootResultsFailed -FromIndex $resultStart `
            -Stage $script:AutopromptRootFailureStage
        return
    }
    Write-RootSuccess -FromIndex $resultStart
}

function Install-Batch {
    param([string[]]$Clients)
    $seenRoots = New-Object 'System.Collections.Generic.HashSet[string]' `
        (Get-IdemPathComparer)
    foreach ($client in $Clients) {
        $root = Get-IdemNormalizedPath -Path (Get-ConfigRoot -Client $client)
        if ([string]::IsNullOrEmpty($root)) {
            Set-RootTargetPreflightFailed -Root '<invalid>' `
                -Clients @($client) -Code 44 -ShouldUseProvidedClients
            continue
        }
        if (-not $seenRoots.Add($root)) { continue }
        Install-RootBatch -Root $root -Clients $Clients
        if ($script:IsRecoveryRetained) { break }
    }
}

function Write-Matrix {
    [Console]::Out.WriteLine("")
    [Console]::Out.WriteLine("==== Autoprompt install matrix ====")
    foreach ($line in $script:ResultRows) {
        $client = ($line -replace '^.* client=', '') -replace ' .*$', ''
        if ($line -like 'RESULT=PASS*') {
            $dest = ($line -replace '^.* dest=', '') -replace ' .*$', ''
            [Console]::Out.WriteLine(("  PASS  {0,-9} dest={1}" -f $client, $dest))
        } elseif ($line -like 'RESULT=FAIL*') {
            $stage = ($line -replace '^.* stage=', '') -replace ' .*$', ''
            [Console]::Out.WriteLine(("  FAIL  {0,-9} stage={1}" -f $client, $stage))
        } elseif ($line -like 'SKIP=*') {
            $reason = ($line -replace '^.* reason=', '') -replace ' .*$', ''
            [Console]::Out.WriteLine(("  SKIP  {0,-9} reason={1}" -f $client, $reason))
        }
    }
    [Console]::Out.WriteLine("====================================")
}

# --- main ---
if ([string]::IsNullOrEmpty($Target)) { Write-Usage; exit 2 }
if (-not (Test-AutopromptInstallRootContract -Target $Target)) { exit 2 }

if ($Target -eq 'all') {
    $present = @()
    foreach ($c in $ClientsAll) {
        $status = Get-ProviderStatus -Name $c
        if ($status -in @('supported', 'degraded')) {
            $det = Invoke-LibRecord -Call { Detect-Client -Name $c }
            if ($det.Code -eq 0) {
                $present += $c
            } else {
                [Console]::Error.WriteLine(
                    "Autoprompt install ($c): SKIP - CLI not detected on PATH."
                )
                $script:ResultRows += "SKIP=skip client=$c reason=not-detected"
            }
            continue
        }
        $reason = Get-ProviderBlockReason -Name $c
        [Console]::Error.WriteLine(
            "Autoprompt install ($c): SKIP - status=$status reason=$reason."
        )
        $script:ResultRows += "SKIP=skip client=$c reason=$reason"
    }
    if ($present -contains 'prime') {
        Install-PrimeLifecycle
        $present = @($present | Where-Object { $_ -cne 'prime' })
    }
    if ($present.Count -gt 0) { Install-Batch -Clients $present }
    Write-Matrix
    exit (Get-InstallExitCode)
}

$status = Get-ProviderStatus -Name $Target
if ([string]::IsNullOrEmpty($status)) {
    [Console]::Error.WriteLine("Autoprompt install: unknown client $Target.")
    Write-Usage; exit 2
}
if ($status -in @('blocked', 'retired', 'unverified')) {
    $reason = Get-ProviderBlockReason -Name $Target
    [Console]::Error.WriteLine(
        "Autoprompt install ($Target): REFUSED - status=$status reason=$reason."
    )
    $script:ResultRows += "RESULT=FAIL client=$Target stage=compatibility reason=$reason"
    Write-Matrix
    exit 3
}
$det = Invoke-LibRecord -Call { Detect-Client -Name $Target }
if ($det.Code -ne 0) {
    [Console]::Error.WriteLine("Autoprompt install ($Target): SKIP -- CLI not detected on PATH. Install it and re-run.")
    $script:ResultRows += "SKIP=skip client=$Target reason=not-detected"
    Write-Matrix; exit 0
}
if ($Target -ceq 'prime') {
    Install-PrimeLifecycle
    Write-Matrix
    exit (Get-InstallExitCode)
}
Install-Batch -Clients @($Target)
Write-Matrix
exit (Get-InstallExitCode)
