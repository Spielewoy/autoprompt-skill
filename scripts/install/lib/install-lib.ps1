# install-lib.ps1 - Shared autoprompt installer library (dot-sourced, not run).
#
# Behavior-faithful twin of install-lib.sh. Functions are APPENDED below in
# F-LIB order (DETECT, RESOLVE, FORMAT, PRECHECK, ...); each is fenced so later
# features add theirs without touching earlier blocks.
#
# Detect-record grammar (canonical line emitted by Detect-Client on the
# success/absent paths; consumed by RESOLVE/VERIFY without re-guessing):
#
#   client=<name> present=<true|false> version=<VERSION>
#
#   VERSION in {
#     SEMVER    a SemVer token, including optional prerelease/build suffixes
#     "unknown" present binary, version unparseable (probe failed/hung/no token)
#     "-"       absent client (no version by definition)
#   }
#
# Channel discipline (.ps1 port): a PowerShell function returns its ENTIRE
# uncaptured pipeline, so the RECORD is written via [Console]::Out.WriteLine
# (success/absent) and [Console]::Error.WriteLine (unknown-client) to keep it
# OFF the return pipeline; the VERDICT is the integer `return` (0 present,
# 1 absent, 2 unknown-client) as the ONLY value on the return channel. Capture
# the record in tests via [Console]::SetOut([StringWriter]) with try/finally,
# NEVER `6>&1` (which captures only the scalar int).

if ($script:AutopromptInstallLibLoaded) { return }
$script:AutopromptInstallLibLoaded = $true
$AutopromptInstallRepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path

$AutopromptClientBin = @{
    claude = 'claude'; codex = 'codex'; cursor = 'cursor-agent'; roo = 'roo';
    opencode = 'opencode'; kilo = 'kilo'; vscode = 'code';
    prime = 'prime-agent';
    omp = 'omp'; deepseek = 'dsh'; reasonix = 'reasonix';
    dcode = 'dcode'; gemini = 'gemini'; cline = 'cline'; goose = 'goose'
}
$AutopromptVersionFlag = '--version'
$AutopromptProbeTimeout = 30

# Public install compatibility is a closed nine-provider registry. Historical
# path resolvers remain below only for receipt-owned cleanup of earlier installs.
$AutopromptProviderStatus = @{
    claude = 'supported'; codex = 'supported'; opencode = 'supported';
    kilo = 'supported'; vscode = 'supported'; prime = 'supported'
    omp = 'supported'; deepseek = 'supported'; reasonix = 'supported'
}
$AutopromptProviderBlockReason = @{}

function Get-ProviderStatus {
    param([string]$Name)
    if (-not $AutopromptProviderStatus.ContainsKey($Name)) { return '' }
    return $AutopromptProviderStatus[$Name]
}

function Get-ProviderBlockReason {
    param([string]$Name)
    if (-not $AutopromptProviderBlockReason.ContainsKey($Name)) { return '' }
    return $AutopromptProviderBlockReason[$Name]
}

# AUTOPROMPT_INSTALL_ROOT is an internal, one-client config-root contract shared
# by install/doctor/repair/uninstall. It is intentionally not a synthetic HOME:
# every provider-specific path is derived beneath the exact normalized root.
$script:AutopromptInstallRootClient = ''

function Test-AutopromptInstallRootOverridePresent {
    return (Test-Path Env:AUTOPROMPT_INSTALL_ROOT)
}

function Get-AutopromptNormalizedInstallRoot {
    if (-not (Test-AutopromptInstallRootOverridePresent)) { return '' }
    $raw = [string]$env:AUTOPROMPT_INSTALL_ROOT
    if ([string]::IsNullOrWhiteSpace($raw) -or $raw -cne $raw.Trim() -or
        $raw -match '[\x00-\x1f]' -or
        @($raw -split '[\\/]' | Where-Object { $_ -ceq '..' }).Count -gt 0) {
        return ''
    }
    try {
        if (-not [System.IO.Path]::IsPathRooted($raw) -or
            $raw -match '^[A-Za-z]:[^\\/]') { return '' }
        $normalized = [System.IO.Path]::GetFullPath($raw)
        $pathRoot = [System.IO.Path]::GetPathRoot($normalized)
        if ($normalized.Length -eq $pathRoot.Length) { return '' }
        return $normalized.TrimEnd([char]92, [char]47)
    } catch {
        return ''
    }
}

function Write-AutopromptInstallRootError {
    param([string]$Target, [string]$Reason)
    [Console]::Error.WriteLine(
        "client=$Target error=invalid-install-root reason=$Reason"
    )
    [Console]::Error.WriteLine(
        'Autoprompt: AUTOPROMPT_INSTALL_ROOT must name one safe absolute ' +
        'provider config root (not all, a filesystem root, or a traversal path).'
    )
}

function Test-AutopromptInstallRootContract {
    param([AllowEmptyString()][string]$Target)
    $script:AutopromptInstallRootClient = ''
    if (-not (Test-AutopromptInstallRootOverridePresent)) { return $true }
    if ([string]::IsNullOrEmpty($Target) -or $Target -ceq 'all') {
        Write-AutopromptInstallRootError -Target $Target `
            -Reason 'explicit-client-required'
        return $false
    }
    $status = Get-ProviderStatus -Name $Target
    if ($status -notin @('supported', 'degraded')) {
        Write-AutopromptInstallRootError -Target $Target `
            -Reason 'client-not-installable'
        return $false
    }
    $raw = [string]$env:AUTOPROMPT_INSTALL_ROOT
    if ([string]::IsNullOrWhiteSpace($raw)) {
        Write-AutopromptInstallRootError -Target $Target -Reason 'empty'
        return $false
    }
    if ($raw -cne $raw.Trim() -or $raw -match '[\x00-\x1f]') {
        Write-AutopromptInstallRootError -Target $Target `
            -Reason 'invalid-characters'
        return $false
    }
    if (@($raw -split '[\\/]' | Where-Object { $_ -ceq '..' }).Count -gt 0) {
        Write-AutopromptInstallRootError -Target $Target -Reason 'traversal'
        return $false
    }
    try {
        $isAbsolute = [System.IO.Path]::IsPathRooted($raw) -and
            $raw -cnotmatch '^[A-Za-z]:[^\\/]'
    } catch {
        $isAbsolute = $false
    }
    if (-not $isAbsolute) {
        Write-AutopromptInstallRootError -Target $Target -Reason 'not-absolute'
        return $false
    }
    $normalized = Get-AutopromptNormalizedInstallRoot
    if ([string]::IsNullOrEmpty($normalized)) {
        Write-AutopromptInstallRootError -Target $Target `
            -Reason 'filesystem-root-refused'
        return $false
    }
    $item = Get-Item -LiteralPath $normalized -Force -ErrorAction SilentlyContinue
    if ($null -ne $item -and $item -isnot [System.IO.DirectoryInfo]) {
        Write-AutopromptInstallRootError -Target $Target -Reason 'not-directory'
        return $false
    }
    if ($null -ne $item -and $item.Attributes.HasFlag(
        [System.IO.FileAttributes]::ReparsePoint
    )) {
        Write-AutopromptInstallRootError -Target $Target `
            -Reason 'reparse-root-refused'
        return $false
    }
    $script:AutopromptInstallRootClient = $Target
    return $true
}

# Get-AllButLast: every element of $Items except the last, as an array; @() when
# the input has 0 or 1 elements. A guard against the PowerShell range trap where
# `$x[0..($x.Count - 2)]` becomes `$x[0..-1]` when Count is 1 - `0..-1` is the
# sequence 0,-1, which RE-SELECTS element 0 then the last element instead of
# yielding empty. The .sh port pops one element then reindexes (unset + reslice),
# so this is the behavior-faithful twin of that "drop the last element" step.
function Get-AllButLast {
    param([object[]]$Items)
    if ($null -eq $Items -or $Items.Count -le 1) { return @() }
    return @($Items[0..($Items.Count - 2)])
}

# --- F-LIB-DETECT (begin) ---
function Test-CodexProbeHome {
    param(
        [string]$Path,
        [string]$TempRoot,
        [switch]$AllowMissing
    )

    if ([string]::IsNullOrWhiteSpace($Path) -or
        [string]::IsNullOrWhiteSpace($TempRoot)) { return $false }
    try {
        $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd(
            [IO.Path]::DirectorySeparatorChar,
            [IO.Path]::AltDirectorySeparatorChar
        )
        $fullRoot = [IO.Path]::GetFullPath($TempRoot).TrimEnd(
            [IO.Path]::DirectorySeparatorChar,
            [IO.Path]::AltDirectorySeparatorChar
        )
        $parent = [IO.Directory]::GetParent($fullPath)
        $pathComparison = if ([IO.Path]::DirectorySeparatorChar -eq '\') {
            [StringComparison]::OrdinalIgnoreCase
        } else {
            [StringComparison]::Ordinal
        }
        if ($null -eq $parent -or
            -not $parent.FullName.Equals($fullRoot, $pathComparison) -or
            -not [IO.Path]::GetFileName($fullPath).StartsWith(
                'autoprompt-codex-probe-',
                [StringComparison]::Ordinal
            ) -or
            [IO.Path]::GetFileName($fullPath) -notmatch
                '^autoprompt-codex-probe-[0-9a-f]{32}$') { return $false }

        if (-not [IO.Directory]::Exists($fullPath)) { return [bool]$AllowMissing }
        $attributes = [IO.File]::GetAttributes($fullPath)
        return (($attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0)
    } catch {
        return $false
    }
}

function New-CodexProbeHome {
    try {
        $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd(
            [IO.Path]::DirectorySeparatorChar,
            [IO.Path]::AltDirectorySeparatorChar
        )
        if (-not [IO.Directory]::Exists($tempRoot)) { return $null }
        for ($attempt = 0; $attempt -lt 5; $attempt++) {
            $probeHome = [IO.Path]::Combine(
                $tempRoot,
                "autoprompt-codex-probe-$([guid]::NewGuid().ToString('N'))"
            )
            if ([IO.Directory]::Exists($probeHome) -or [IO.File]::Exists($probeHome)) {
                continue
            }
            [IO.Directory]::CreateDirectory($probeHome) | Out-Null
            if (Test-CodexProbeHome -Path $probeHome -TempRoot $tempRoot) {
                return [pscustomobject]@{ Path = $probeHome; TempRoot = $tempRoot }
            }
        }
    } catch {}
    return $null
}

function Remove-CodexProbeHome {
    param([string]$Path, [string]$TempRoot)

    if (-not [IO.Directory]::Exists($Path)) { return $true }
    if (-not (Test-CodexProbeHome -Path $Path -TempRoot $TempRoot)) { return $false }
    try {
        [IO.Directory]::Delete($Path, $true)
        return (-not [IO.Directory]::Exists($Path))
    } catch {
        return $false
    }
}

function Invoke-CodexVersionProbe {
    param([string]$Bin, [string]$Flag, [int]$TimeoutSeconds)

    $probe = New-CodexProbeHome
    if ($null -eq $probe) {
        return [pscustomobject]@{ Raw = ''; Code = 1 }
    }

    $raw = ''
    $rc = 1
    $job = $null
    try {
        $probePath = $probe.Path
        $job = Start-Job -ScriptBlock {
            $env:CODEX_HOME = $using:probePath
            $output = @(& $using:Bin $using:Flag 2>$null)
            $exitCode = $LASTEXITCODE
            if ($null -eq $exitCode) { $exitCode = 1 }
            [pscustomobject]@{ Raw = ($output -join "`n"); Code = [int]$exitCode }
        }
        if (Wait-Job $job -Timeout $TimeoutSeconds) {
            $result = Receive-Job $job | Select-Object -Last 1
            if ($null -ne $result) {
                $raw = [string]$result.Raw
                $rc = [int]$result.Code
            }
        } else {
            Stop-Job $job -ErrorAction SilentlyContinue
        }
    } catch {
        # Start-Job unavailable: keep the same direct-probe fallback, but scope
        # CODEX_HOME to the disposable directory and restore it exactly.
        $hadCodexHome = Test-Path Env:CODEX_HOME
        $priorCodexHome = $env:CODEX_HOME
        try {
            $env:CODEX_HOME = $probe.Path
            $raw = (& $Bin $Flag 2>$null) -join "`n"
            $rc = $LASTEXITCODE
        } catch {
            $raw = ''
            $rc = 1
        } finally {
            if ($hadCodexHome) { $env:CODEX_HOME = $priorCodexHome }
            else { Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue }
        }
    } finally {
        if ($null -ne $job) {
            if ($job.State -in @('Running', 'NotStarted')) {
                Stop-Job $job -ErrorAction SilentlyContinue
            }
            Remove-Job $job -Force -ErrorAction SilentlyContinue
        }
        if (-not (Remove-CodexProbeHome -Path $probe.Path -TempRoot $probe.TempRoot)) {
            $raw = ''
            $rc = 1
        }
    }

    return [pscustomobject]@{ Raw = $raw; Code = [int]$rc }
}

function Detect-Client {
    param([string]$Name)

    if (-not $AutopromptClientBin.ContainsKey($Name)) {
        # Record on the console-error stream, never the return pipeline.
        [Console]::Error.WriteLine("client=$Name present=false version=- error=unknown-client")
        return 2
    }

    $bin = $AutopromptClientBin[$Name]
    if (-not (Get-Command $bin -ErrorAction SilentlyContinue)) {
        # WHY [Console]::Out.WriteLine: keeps the record off the return pipeline
        # so `$code = Detect-Client ...` is a scalar [int], not a [record,int] array.
        [Console]::Out.WriteLine("client=$Name present=false version=-")
        return 1
    }

    $flag = $AutopromptVersionFlag
    $raw = ''
    $rc = 1
    if ($Name -ceq 'codex') {
        $probeResult = Invoke-CodexVersionProbe -Bin $bin -Flag $flag `
            -TimeoutSeconds $AutopromptProbeTimeout
        $raw = $probeResult.Raw
        $rc = $probeResult.Code
    } else {
        try {
            $job = Start-Job -ScriptBlock {
                if ($using:Name -ceq 'prime') { & $using:bin $using:flag 2>&1 }
                else { & $using:bin $using:flag 2>$null }
            }
            if (Wait-Job $job -Timeout $AutopromptProbeTimeout) {
                $raw = (Receive-Job $job) -join "`n"
                if ($job.State -eq 'Completed') { $rc = 0 }   # else: $rc stays 1 (probe failed)
                Remove-Job $job -Force
            } else {
                # Timed out. Removing a job whose child is still alive blocks until
                # the child dies, which would defeat the timeout - so remove it on a
                # detached cleanup job (child runspace, parent returns immediately).
                $cleanupId = $job.Id
                Start-Job -ScriptBlock { Remove-Job -Id $using:cleanupId -Force -EA 0 } | Out-Null
            }
        } catch {
            # Start-Job unavailable: direct-probe fallback (PS analog of no-timeout).
            # A throw or non-zero exit from the probe leaves $rc=1/$raw='' -> unknown.
            try {
                if ($Name -ceq 'prime') { $raw = (& $bin $flag 2>&1) -join "`n" }
                else { $raw = (& $bin $flag 2>$null) -join "`n" }
                $rc = $LASTEXITCODE
            } catch { $rc = 1 }
        }
    }

    $line1 = ($raw -split "`n")[0]
    $match = [regex]::Match(
        $line1,
        '[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?'
    )
    if ($rc -ne 0 -or -not $match.Success) { $version = 'unknown' } else { $version = $match.Value }

    # WHY [Console]::Out.WriteLine: record stays off the return pipeline; only the
    # scalar int verdict reaches the caller.
    [Console]::Out.WriteLine("client=$Name present=true version=$version")
    return 0
}
# --- F-LIB-DETECT (end) ---

# --- F-LIB-RESOLVE (begin) ---
# Resolve-Destination emits the EXACT Windows absolute install destination + a
# format token for a client, doing PATH MATH ONLY (no New-Item, no Test-Path
# write - that is PRECHECK/COPY territory). Record grammar (console-out, success):
#
#   client=<name> dest=<ABSOLUTE-PATH> format=<FORMAT-TOKEN>
#
#   FORMAT-TOKEN in { md-yaml, md-claude, md-codex, md-reasonix, mdc,
#                     roomodes, gemini-toml, md-rules, goose-recipe, md-agents }
#
# Channel discipline (mirrors Detect-Client): RECORD via [Console]::Out.WriteLine;
# error record via [Console]::Error.WriteLine; VERDICT via scalar `return` int
# (0 resolved, 2 unknown-client / no-such-variant, 3 no-home) as the ONLY value
# on the return pipeline. Each value is a packed spec RELKIND|RELPATH|FORMAT where
# RELKIND in {HOME,XDG,CODEX} selects the base; RELPATH uses '/' separators here and is
# rebuilt with Join-Path so the record carries Windows '\' separators.
$AutopromptClientDest = @{
    claude   = 'HOME|.claude/skills/autoprompt/SKILL.md|md-claude'
    codex    = 'CODEX|skills/autoprompt/SKILL.md|md-codex'
    cursor   = 'HOME|.cursor/skills/autoprompt/SKILL.md|md-yaml'
    roo      = 'HOME|.roomodes|roomodes'
    gemini   = 'HOME|.gemini/commands/autoprompt.toml|gemini-toml'
    cline    = 'HOME|.clinerules/autoprompt.md|md-rules'
    goose    = 'HOME|.config/goose/recipes/autoprompt.yaml|goose-recipe'
    opencode = 'XDG|opencode/skills/autoprompt/SKILL.md|md-yaml'
    kilo     = 'HOME|.kilo/skills/autoprompt/SKILL.md|md-yaml'
    vscode   = 'HOME|.copilot/skills/autoprompt/SKILL.md|md-yaml'
    omp      = 'OMP|skills/autoprompt/SKILL.md|md-claude'
    deepseek = 'DSH|skills/autoprompt/SKILL.md|md-claude'
    reasonix = 'REASONIX|skills/autoprompt/SKILL.md|md-reasonix'
}

# Per-client OPTIONAL variants (cursor secondary, goose fallback). A variant
# requested for a client with no entry here is a no-such-variant error.
$AutopromptClientVariant = @{
    'cursor:secondary' = 'HOME|.cursor/rules/autoprompt.mdc|mdc'
    'goose:fallback'   = 'HOME|AGENTS.md|md-agents'
}

# Get-ConfiguredHome: prefer explicit HOME, then fall back to USERPROFILE.
function Get-ConfiguredHome {
    if ($env:HOME) { return $env:HOME }
    return $env:USERPROFILE
}

# Resolve-Home: the configured home, or return 3 + loud no-home record if empty.
function Resolve-Home {
    param([string]$Name)
    $userHome = Get-ConfiguredHome
    if ([string]::IsNullOrEmpty($userHome)) {
        [Console]::Error.WriteLine("client=$Name dest=- format=- error=no-home")
        return $null
    }
    return $userHome
}

# Resolve-Xdg: $env:XDG_CONFIG_HOME when set, else $userHome\.config (Windows).
function Resolve-Xdg {
    param([string]$UserHome)
    if (-not [string]::IsNullOrEmpty($env:XDG_CONFIG_HOME)) { return $env:XDG_CONFIG_HOME }
    return (Join-Path $UserHome '.config')
}

function Test-AutopromptWindowsHost {
    return [Runtime.InteropServices.RuntimeInformation]::IsOSPlatform(
        [Runtime.InteropServices.OSPlatform]::Windows
    )
}

function Get-AutopromptOmpProfile {
    $raw = if (Test-Path Env:OMP_PROFILE) { $env:OMP_PROFILE } else { $env:PI_PROFILE }
    $profile = ([string]$raw).Trim()
    if ([string]::IsNullOrEmpty($profile) -or
        $profile -ceq 'default') {
        return ''
    }
    if ($profile.EndsWith('.') -or
        $profile -cnotmatch '^[a-z0-9][a-z0-9._-]{0,63}$' -or
        $profile -match '^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$') {
        throw "Invalid OMP profile `"$raw`"."
    }
    return $profile
}

function Get-AutopromptOmpDefaultAgentRoot {
    $userHome = Get-ConfiguredHome
    $configDirectory = if ($env:PI_CONFIG_DIR) { $env:PI_CONFIG_DIR } else { '.omp' }
    return (Join-Path (Join-Path $userHome $configDirectory) 'agent')
}

function Get-AutopromptOmpInstallRoot {
    $profile = Get-AutopromptOmpProfile
    if (-not [string]::IsNullOrEmpty($profile)) {
        $userHome = Get-ConfiguredHome
        $configDirectory = if ($env:PI_CONFIG_DIR) { $env:PI_CONFIG_DIR } else { '.omp' }
        return (Join-Path (Join-Path (Join-Path $userHome $configDirectory) `
            'profiles') (Join-Path $profile 'agent'))
    }
    if ($env:PI_CODING_AGENT_DIR) { return $env:PI_CODING_AGENT_DIR }
    return (Get-AutopromptOmpDefaultAgentRoot)
}

function Get-AutopromptConfigRoot {
    param([string]$Name)
    if (Test-AutopromptInstallRootOverridePresent) {
        return (Get-AutopromptNormalizedInstallRoot)
    }
    $userHome = Get-ConfiguredHome
    switch ($Name) {
        'codex' {
            if ($env:CODEX_HOME) { return $env:CODEX_HOME }
            return (Join-Path $userHome '.codex')
        }
        'opencode' { return (Resolve-Xdg -UserHome $userHome) }
        'kilo' { return (Resolve-Xdg -UserHome $userHome) }
        'vibe' {
            if ($env:VIBE_HOME) { return $env:VIBE_HOME }
            return (Join-Path $userHome '.vibe')
        }
        'prime' {
            if ($env:PRIME_AGENT_CODING_AGENT_DIR) {
                return $env:PRIME_AGENT_CODING_AGENT_DIR
            }
            return (Join-Path $userHome '.prime/agent')
        }
        'omp' {
            return (Get-AutopromptOmpInstallRoot)
        }
        'deepseek' {
            if ($env:DSH_HOME) { return $env:DSH_HOME }
            return (Join-Path $userHome '.dsh')
        }
        'reasonix' {
            if ($env:REASONIX_HOME) { return $env:REASONIX_HOME }
            if (Test-AutopromptWindowsHost) {
                $appData = if ($env:APPDATA) { $env:APPDATA } else {
                    Join-Path $userHome 'AppData/Roaming'
                }
                return (Join-Path $appData 'reasonix')
            }
            return (Join-Path $userHome '.reasonix')
        }
        default { return $userHome }
    }
}

function Get-AutopromptSkillRoot {
    param([string]$Name)
    $userHome = Get-ConfiguredHome
    if (Test-AutopromptInstallRootOverridePresent) {
        return (Join-Path (Get-AutopromptNormalizedInstallRoot) `
            'skills/autoprompt')
    }
    switch ($Name) {
        'claude' { return (Join-Path $userHome '.claude/skills/autoprompt') }
        'codex' {
            return (Join-Path (Get-AutopromptConfigRoot -Name 'codex') `
                'skills/autoprompt')
        }
        'opencode' {
            return (Join-Path (Get-AutopromptConfigRoot -Name 'opencode') `
                'opencode/skills/autoprompt')
        }
        'kilo' { return (Join-Path $userHome '.kilo/skills/autoprompt') }
        'vscode' { return (Join-Path $userHome '.copilot/skills/autoprompt') }
        { $_ -in @('omp', 'deepseek', 'reasonix') } {
            return (Join-Path (Get-AutopromptConfigRoot -Name $Name) `
                'skills/autoprompt')
        }
        default { return '' }
    }
}

function Get-AutopromptRuntimeRoot {
    param([string]$Name)
    return (Get-AutopromptSkillRoot -Name $Name)
}

function Get-AutopromptCodexPayloadGeneration {
    $manifestPath = Join-Path $AutopromptInstallRepoRoot `
        'agents/manifests/codex-runtime.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { return '' }
    try { $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json }
    catch { return '' }
    $generation = [string]$manifest.payloadGeneration
    if ($generation -cnotmatch '^codex-v[0-9]+\.[0-9]+\.[0-9]+-[a-f0-9]{16}$') {
        return ''
    }
    return $generation
}

function Get-AutopromptCodexBundleSkillRoot {
    $generation = Get-AutopromptCodexPayloadGeneration
    if ([string]::IsNullOrEmpty($generation)) { return '' }
    return (Join-Path (Get-AutopromptConfigRoot -Name 'codex') `
        (Join-Path '.autoprompt-private/bundles' `
            (Join-Path $generation 'skills/autoprompt')))
}

function Get-AutopromptCodexGeneratedAgentsRoot {
    $skillRoot = Get-AutopromptCodexBundleSkillRoot
    if ([string]::IsNullOrEmpty($skillRoot)) { return '' }
    return (Join-Path $skillRoot 'agents-runtime')
}

function Get-AutopromptNativeAgentsRoot {
    param([string]$Name)
    if (Test-AutopromptInstallRootOverridePresent) {
        if ($Name -ceq 'codex') {
            return (Get-AutopromptCodexGeneratedAgentsRoot)
        }
        return (Join-Path (Get-AutopromptNormalizedInstallRoot) 'agents')
    }
    $userHome = Get-ConfiguredHome
    switch ($Name) {
        'claude' { return (Join-Path $userHome '.claude/agents') }
        'codex' {
            return (Get-AutopromptCodexGeneratedAgentsRoot)
        }
        'opencode' {
            return (Join-Path (Get-AutopromptConfigRoot -Name 'opencode') `
                'opencode/agents')
        }
        'kilo' {
            return (Join-Path (Get-AutopromptConfigRoot -Name 'kilo') `
                'kilo/agents')
        }
        'vscode' { return (Join-Path $userHome '.copilot/agents') }
        'omp' {
            $profile = Get-AutopromptOmpProfile
            if (-not [string]::IsNullOrEmpty($profile)) {
                return (Join-Path (Get-AutopromptConfigRoot -Name 'omp') 'agents')
            }
            if ($env:PI_CODING_AGENT_DIR) {
                # OMP 17.4.0 still discovers native task agents through
                # PI_CONFIG_DIR when PI_CODING_AGENT_DIR relocates other state.
                return (Join-Path (Get-AutopromptOmpDefaultAgentRoot) 'agents')
            }
            return (Join-Path (Get-AutopromptConfigRoot -Name 'omp') 'agents')
        }
        default { return '' }
    }
}

function Get-AutopromptProfileFile {
    param([string]$Name)
    $root = Get-AutopromptConfigRoot -Name $Name
    switch ($Name) {
        'codex' { return (Join-Path $root 'autoprompt.config.toml') }
        'opencode' {
            if (Test-AutopromptInstallRootOverridePresent) {
                return (Join-Path $root 'autoprompt.opencode.json')
            }
            return (Join-Path $root 'opencode/autoprompt.opencode.json')
        }
        'kilo' {
            if (Test-AutopromptInstallRootOverridePresent) {
                return (Join-Path $root 'autoprompt.kilo.json')
            }
            return (Join-Path $root 'kilo/autoprompt.kilo.json')
        }
        default { return '' }
    }
}

# Build a Windows absolute path from a base + a '/'-separated relpath, preserving
# a trailing-slash intent (kilo modes dir) as a trailing backslash.
function Join-RelPath {
    param([string]$Base, [string]$RelPath)
    $hasTrailing = $RelPath.EndsWith('/')
    $segments = $RelPath.TrimEnd('/').Split('/')
    $path = $Base
    foreach ($seg in $segments) { $path = Join-Path $path $seg }
    if ($hasTrailing) { $path = $path + '\' }
    return $path
}

function Resolve-Destination {
    param(
        [string]$Name,
        [string]$Variant = ''
    )

    if (-not $AutopromptClientDest.ContainsKey($Name)) {
        [Console]::Error.WriteLine("client=$Name dest=- format=- error=unknown-client")
        return 2
    }

    $spec = $null
    if (-not [string]::IsNullOrEmpty($Variant)) {
        $variantKey = "${Name}:${Variant}"
        if (-not $AutopromptClientVariant.ContainsKey($variantKey)) {
            [Console]::Error.WriteLine("client=$Name dest=- format=- error=no-such-variant")
            return 2
        }
        $spec = $AutopromptClientVariant[$variantKey]
    } else {
        $spec = $AutopromptClientDest[$Name]
    }

    $parts = $spec.Split('|')
    $relKind = $parts[0]
    $relPath = $parts[1]
    $format = $parts[2]

    if (Test-AutopromptInstallRootOverridePresent) {
        $customRoot = Get-AutopromptNormalizedInstallRoot
        if ([string]::IsNullOrEmpty($customRoot) -or
            (Get-ProviderStatus -Name $Name) -notin @('supported', 'degraded')) {
            [Console]::Error.WriteLine(
                "client=$Name dest=- format=- error=invalid-install-root"
            )
            return 4
        }
        $dest = Join-Path $customRoot 'skills/autoprompt/SKILL.md'
        [Console]::Out.WriteLine("client=$Name dest=$dest format=$format")
        return 0
    }

    $userHome = Resolve-Home -Name $Name
    if ($null -eq $userHome) { return 3 }

    $base = if ($relKind -eq 'XDG') {
        Resolve-Xdg -UserHome $userHome
    } elseif ($relKind -eq 'CODEX') {
        if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $userHome '.codex' }
    } elseif ($relKind -eq 'OMP') {
        Get-AutopromptConfigRoot -Name 'omp'
    } elseif ($relKind -eq 'DSH') {
        if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $userHome '.dsh' }
    } elseif ($relKind -eq 'REASONIX') {
        Get-AutopromptConfigRoot -Name 'reasonix'
    } else {
        $userHome
    }
    $dest = Join-RelPath -Base $base -RelPath $relPath

    [Console]::Out.WriteLine("client=$Name dest=$dest format=$format")
    return 0
}
# --- F-LIB-RESOLVE (end) ---

# --- F-LIB-FORMAT (begin) ---
# Format-Skill mints the EXACT bytes to write on disk for a given FORMAT token,
# doing STRING MATH ONLY (no file reads - the caller passes the body). It is the
# single place the installed-file bytes are produced, so it is where the P0 is
# enforced: the frontmatter it emits is a FIXED literal of only name + description
# (description/globs/alwaysApply for .mdc, a description key for TOML) - there is
# structurally no code path that adds a tool-restricting key.
#
# Channel discipline (mirrors Detect/Resolve): rendered bytes via
# [Console]::Out.Write (RECORD), error record via [Console]::Error.WriteLine,
# scalar `return` int as the VERDICT and the ONLY value on the return pipeline.
#   return 0  rendered OK
#   return 2  unknown / empty format token   (error=unknown-format)
#   return 5  empty body                      (error=empty-body)
#   return 6  body already carries its own --- frontmatter fence
#             (error=body-has-frontmatter)
# (code 4 format-not-implemented is RETIRED: every token now has a real emitter.)
#
# Byte-parity invariant (F-OP-DUALPARITY): the record is built with explicit "`n"
# joins and emitted via [Console]::Out.Write (NEVER WriteLine, which appends the
# platform "`r`n" on Windows) so the bytes are '\n'-only with exactly one trailing
# newline - byte-identical to the .sh printf '%s\n' output.

# Join lines with '\n' and a single trailing '\n' (the cross-port byte contract).
function Format-JoinLines {
    param([string[]]$Lines)
    return (($Lines -join "`n") + "`n")
}

# Emit md + YAML frontmatter over the body. Codex receives an exact explicit-only
# discovery contract in addition to name + description; other md-family formats
# retain their existing provider-specific keys.
function Format-MdYaml {
    param([string]$Token, [string]$Name, [string]$Description, [string]$Body)
    if ($Token -eq 'md-codex') {
        $single = $Description -replace "'", "''"
        $descLine = "description: '$single'"
        return (Format-JoinLines @(
            '---',
            "name: $Name",
            $descLine,
            'activation: explicit-only',
            'allow-implicit-invocation: false',
            '---',
            '',
            $Body
        ))
    }

    $double = $Description -replace '\\', '\\' -replace '"', '\"'
    $descLine = "description: `"$double`""
    if ($Token -eq 'md-claude') {
        return (Format-JoinLines @(
            '---',
            "name: $Name",
            $descLine,
            'disable-model-invocation: true',
            'user-invocable: true',
            '---',
            '',
            $Body
        ))
    }
    if ($Token -eq 'md-reasonix') {
        return (Format-JoinLines @(
            '---',
            "name: $Name",
            $descLine,
            'invocation: manual',
            '---',
            '',
            $Body
        ))
    }
    return (Format-JoinLines @('---', "name: $Name", $descLine, '---', '', $Body))
}

# Emit .mdc frontmatter: description / globs (empty) / alwaysApply. 'description'
# is the .mdc signal (name is not an .mdc key). No tool-restricting key.
function Format-Mdc {
    param([string]$Description, [string]$Body)
    $double = $Description -replace '\\', '\\' -replace '"', '\"'
    return (Format-JoinLines @('---', "description: `"$double`"", 'globs:', 'alwaysApply: true', '---', '', $Body))
}

# Emit Gemini TOML: a description basic-string + a prompt multi-line string with
# a trailing {{args}} (INSTALL.md:38). The description escapes \ then "; the body
# (a multi-line basic string still interprets backslash escapes) escapes every \
# and neutralizes any literal """ so it can never close the block early.
function Format-GeminiToml {
    param([string]$Description, [string]$Body)
    $descEsc = $Description -replace '\\', '\\' -replace '"', '\"'
    $bodyEsc = $Body -replace '\\', '\\'
    $bodyEsc = $bodyEsc -replace '"""', '""\"'
    return (Format-JoinLines @("description = `"$descEsc`"", '', 'prompt = """', $bodyEsc, '', '{{args}}', '"""'))
}

# A YAML double-quoted scalar BODY (no surrounding quotes) for $s - escape \ then
# ", so a ':' or '#' in name/description stays a scalar. Mirrors Format-MdYaml.
function Format-YamlDquote {
    param([string]$Value)
    return ($Value -replace '\\', '\\' -replace '"', '\"')
}

# The LINES of a YAML literal block scalar for $Body, each non-empty line prefixed
# by $Indent spaces (a blank line stays truly empty). A literal block takes every
# line verbatim - no quoting, no escapes - so arbitrary markdown round-trips. Split
# on '\n' (the cross-port body newline); a trailing '\n' yields no spurious line.
function Format-YamlBlock {
    param([string]$Indent, [string]$Body)
    $lines = $Body -split "`n", -1
    if ($lines.Count -gt 0 -and $lines[-1] -eq '') { $lines = Get-AllButLast -Items $lines }
    $out = foreach ($line in $lines) {
        if ($line -eq '') { '' } else { "$Indent$line" }
    }
    return ($out -join "`n")
}

# Emit a Roo Code .roomodes document (YAML): a customModes list with the PRIMARY
# slug=autoprompt mode plus a retained slug=autoprompt ALIAS mode (so the old
# trigger still resolves), each carrying a quoted name + roleDefinition +
# description, and the skill body as a customInstructions literal block. NO
# `groups` key is emitted - default full tool access, the P0 (F-OP-NORESTRICT).
# Fields per the Roo Code custom-modes docs.
function Format-Roomodes {
    param([string]$Name, [string]$Description, [string]$Body)
    $nameQ = Format-YamlDquote -Value $Name
    $descQ = Format-YamlDquote -Value $Description
    $primary = @(
        'customModes:',
        '  - slug: autoprompt',
        "    name: `"$nameQ`"",
        "    roleDefinition: `"$descQ`"",
        "    description: `"$descQ`"",
        '    customInstructions: |'
    ) -join "`n"
    $alias = @(
        '  - slug: autoprompt',
        "    name: `"$nameQ`"",
        "    roleDefinition: `"$descQ`"",
        "    description: `"$descQ`"",
        '    customInstructions: |'
    ) -join "`n"
    return ($primary + "`n" + (Format-YamlBlock -Indent '      ' -Body $Body) + "`n" +
            $alias + "`n" + (Format-YamlBlock -Indent '      ' -Body $Body) + "`n")
}

# Emit a Goose recipe (YAML): version + title + quoted description + the skill body
# as an `instructions` literal block (satisfies validate_prompt_or_instructions).
# NO extensions/tool key is emitted - default tool access, the P0. Fields per the
# Goose Recipe Reference Guide.
$script:AutopromptGooseRecipeVersion = '1.0.0'
function Format-GooseRecipe {
    param([string]$Name, [string]$Description, [string]$Body)
    $titleQ = Format-YamlDquote -Value $Name
    $descQ = Format-YamlDquote -Value $Description
    $head = @(
        "version: `"$script:AutopromptGooseRecipeVersion`"",
        "title: `"$titleQ`"",
        "description: `"$descQ`"",
        'instructions: |'
    ) -join "`n"
    return ($head + "`n" + (Format-YamlBlock -Indent '  ' -Body $Body) + "`n")
}

function Format-Skill {
    param([string]$Format, [string]$Name, [string]$Description, [string]$Body)

    switch ($Format) {
        { $_ -in @('md-yaml', 'md-claude', 'md-codex', 'md-reasonix', 'mdc', 'md-rules', 'md-agents', 'gemini-toml', 'roomodes', 'goose-recipe') } { break }
        default {
            [Console]::Error.WriteLine("format=$Format error=unknown-format")
            return 2
        }
    }

    if ([string]::IsNullOrEmpty($Body)) {
        [Console]::Error.WriteLine("format=$Format error=empty-body")
        return 5
    }

    if ($Body -match "^---`n") {
        [Console]::Error.WriteLine("format=$Format error=body-has-frontmatter")
        return 6
    }

    switch ($Format) {
        { $_ -in @('md-yaml', 'md-claude', 'md-codex', 'md-reasonix', 'md-rules', 'md-agents') } {
            [Console]::Out.Write((Format-MdYaml -Token $Format -Name $Name -Description $Description -Body $Body))
        }
        'mdc' { [Console]::Out.Write((Format-Mdc -Description $Description -Body $Body)) }
        'gemini-toml' { [Console]::Out.Write((Format-GeminiToml -Description $Description -Body $Body)) }
        'roomodes' { [Console]::Out.Write((Format-Roomodes -Name $Name -Description $Description -Body $Body)) }
        'goose-recipe' { [Console]::Out.Write((Format-GooseRecipe -Name $Name -Description $Description -Body $Body)) }
    }
    return 0
}
# --- F-LIB-FORMAT (end) ---

# --- F-LIB-PRECHECK (begin) ---
# Test-Precheck proves the three install PRECONDITIONS for a client BEFORE any
# byte is written: (1) the CLI is on PATH, (2) the config dir exists+writable or
# is creatable under a writable ancestor, (3) the detected version meets a CITED
# floor (Claude/Cursor/Cline only). The first failing precondition decides the
# verdict (fail-fast: a missing binary makes the version floor moot).
#
# WHY side-effect-free: the writability probe creates+removes a temp marker in an
# already-writable dir and NEVER leaves the config dir created (the real New-Item
# is F-LIB-COPY's job), so a precheck call writes no install bytes.
#
# Channel discipline (mirrors Detect/Resolve/Format): the OK RECORD via
# [Console]::Out.WriteLine, the operator failure line + machine record via
# [Console]::Error.WriteLine, the VERDICT via scalar `return` int as the ONLY
# value on the return pipeline. Codes: 0 ok, 10 binary-missing, 11 dir-unwritable,
# 12 version-below-floor, 13 version-unknown-on-floored, plus delegated 2/3.
#
# Version floors are compatibility claims, so prerelease suffixes are significant.
$AutopromptVersionFloor = @{
    claude = '2.1.219'; cursor = '2.5'; cline = '3.58'; opencode = '1.18.7';
    kilo = '7.4.22';
    vscode = '1.133.0'; prime = '0.7.2'
    omp = '17.4.0'; deepseek = '0.1.0-rc.7'; reasonix = '1.30.0'
}
$AutopromptPrecheckMarkerPrefix = '.autoprompt-precheck'

# Compare arbitrarily long numeric identifiers without integer overflow.
function Compare-PrecheckNumericIdentifier {
    param([string]$Left, [string]$Right)
    if ($Left -cnotmatch '^[0-9]+$' -or $Right -cnotmatch '^[0-9]+$') {
        throw 'invalid numeric version identifier'
    }
    $normalizedLeft = $Left.TrimStart([char]'0')
    $normalizedRight = $Right.TrimStart([char]'0')
    if ($normalizedLeft.Length -eq 0) { $normalizedLeft = '0' }
    if ($normalizedRight.Length -eq 0) { $normalizedRight = '0' }
    if ($normalizedLeft.Length -lt $normalizedRight.Length) { return -1 }
    if ($normalizedLeft.Length -gt $normalizedRight.Length) { return 1 }
    return [Math]::Sign([string]::CompareOrdinal($normalizedLeft, $normalizedRight))
}

# Test-PrecheckVersionGe: SemVer precedence with numeric core segments and
# standard prerelease identifier ordering. Missing core segments zero-pad so
# historical two-segment floors still compare cleanly. Build metadata is ignored.
function Test-PrecheckVersionGe {
    param([string]$Found, [string]$Floor)
    if ($Found -eq 'unknown') { return $false }

    $pattern = '^(?<core>[0-9]+(?:\.[0-9]+)*)(?:-(?<pre>[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$'
    $foundMatch = [regex]::Match($Found, $pattern)
    $floorMatch = [regex]::Match($Floor, $pattern)
    if (-not $foundMatch.Success -or -not $floorMatch.Success) { return $false }
    $fseg = $foundMatch.Groups['core'].Value.Split('.')
    $lseg = $floorMatch.Groups['core'].Value.Split('.')
    $count = [math]::Max($fseg.Count, $lseg.Count)
    for ($i = 0; $i -lt $count; $i++) {
        $f = if ($i -lt $fseg.Count) { $fseg[$i] } else { '0' }
        $l = if ($i -lt $lseg.Count) { $lseg[$i] } else { '0' }
        $comparison = Compare-PrecheckNumericIdentifier -Left $f -Right $l
        if ($comparison -gt 0) { return $true }
        if ($comparison -lt 0) { return $false }
    }
    $foundPre = $foundMatch.Groups['pre'].Value
    $floorPre = $floorMatch.Groups['pre'].Value
    if ($foundPre.Length -eq 0 -and $floorPre.Length -eq 0) { return $true }
    if ($foundPre.Length -eq 0) { return $true }
    if ($floorPre.Length -eq 0) { return $false }
    $fpre = $foundPre.Split('.')
    $lpre = $floorPre.Split('.')
    $count = [math]::Min($fpre.Count, $lpre.Count)
    for ($i = 0; $i -lt $count; $i++) {
        $foundNumeric = $fpre[$i] -cmatch '^[0-9]+$'
        $floorNumeric = $lpre[$i] -cmatch '^[0-9]+$'
        if ($foundNumeric -and $floorNumeric) {
            $comparison = Compare-PrecheckNumericIdentifier `
                -Left $fpre[$i] -Right $lpre[$i]
            if ($comparison -gt 0) { return $true }
            if ($comparison -lt 0) { return $false }
        } elseif ($foundNumeric) {
            return $false
        } elseif ($floorNumeric) {
            return $true
        } else {
            $comparison = [string]::CompareOrdinal($fpre[$i], $lpre[$i])
            if ($comparison -gt 0) { return $true }
            if ($comparison -lt 0) { return $false }
        }
    }
    return $fpre.Count -ge $lpre.Count
}

# Test-PrecheckDirWritable: $true iff $Dir is writable OR creatable. Walks up to
# the nearest existing ancestor and proves writability with a REAL New-Item +
# Remove-Item of a temp marker (Test-Path cannot report writability reliably on
# Windows; a thrown UnauthorizedAccessException/IOException is the truth). The
# probe leaves nothing behind - no install dir is created here.
function Test-PrecheckDirWritable {
    param([string]$Dir)

    $probe = $Dir
    while (-not [string]::IsNullOrEmpty($probe) -and -not (Test-Path -LiteralPath $probe)) {
        $parent = Split-Path -Parent $probe
        if ($parent -eq $probe -or [string]::IsNullOrEmpty($parent)) { $probe = ''; break }
        $probe = $parent
    }
    if ([string]::IsNullOrEmpty($probe)) { return $false }
    if (-not (Test-Path -LiteralPath $probe -PathType Container)) { return $false }

    $marker = Join-Path $probe ("$AutopromptPrecheckMarkerPrefix-" + [guid]::NewGuid().ToString('N'))
    try {
        New-Item -ItemType File -Path $marker -ErrorAction Stop | Out-Null
        Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
        return $true
    } catch {
        return $false
    }
}

# Capture a single record line written by Detect-Client/Resolve-Destination via
# [Console]::Out (it lands on the console handle, not the PS pipeline). Returns
# @{ Record; Code }; the scoped SetOut is always restored in finally.
function Get-PrecheckUpstream {
    param([scriptblock]$Call)
    $origOut = [Console]::Out
    $sw = New-Object System.IO.StringWriter
    $code = $null
    try {
        [Console]::SetOut($sw)
        $code = & $Call
    } finally {
        [Console]::SetOut($origOut)
    }
    return @{ Record = $sw.ToString().Trim(); Code = [int]$code }
}

function Get-PrecheckConfigDirectory {
    param([string]$Record)
    $destination = $Record -replace '^client=\S+ dest=', '' `
        -replace ' format=\S+$', ''
    if ($destination.EndsWith('\') -or $destination.EndsWith('/')) {
        return $destination.TrimEnd('\', '/')
    }
    return Split-Path -Parent $destination
}

function Test-Precheck {
    param([string]$Name, [string]$Variant = '')

    $detect = Get-PrecheckUpstream -Call { Detect-Client -Name $Name }
    if ($detect.Code -eq 2) { return 2 }

    $bin = $AutopromptClientBin[$Name]
    if ($detect.Code -eq 1) {
        [Console]::Error.WriteLine("client=$Name precheck=fail reason=binary-missing bin=$bin error=not-on-path")
        [Console]::Error.WriteLine("Autoprompt precheck ($Name): the '$bin' CLI is not on your PATH. Install it and re-run, or add its directory to PATH.")
        return 10
    }

    $resolve = Get-PrecheckUpstream -Call { Resolve-Destination -Name $Name -Variant $Variant }
    if ($resolve.Code -eq 3) { return 3 }
    if ($resolve.Code -eq 2) { return 2 }
    $configDir = Get-PrecheckConfigDirectory -Record $resolve.Record

    if (-not (Test-PrecheckDirWritable -Dir $configDir)) {
        [Console]::Error.WriteLine("client=$Name precheck=fail reason=dir-unwritable dir=$configDir error=permission-denied")
        [Console]::Error.WriteLine("Autoprompt precheck ($Name): cannot write the config directory '$configDir' (permission denied). Fix its permissions or run as a user who can write it.")
        return 11
    }

    $version = $detect.Record -replace '^client=\S+ present=\S+ version=', ''
    if ($AutopromptVersionFloor.ContainsKey($Name)) {
        $floor = $AutopromptVersionFloor[$Name]
        if ($version -eq 'unknown') {
            [Console]::Error.WriteLine("client=$Name precheck=fail reason=version-unknown required=$floor found=unknown error=unreadable-version")
            [Console]::Error.WriteLine("Autoprompt precheck ($Name): could not read $Name's version (got 'unknown') and a minimum of $floor is required. Verify '$bin --version' works, then re-run.")
            return 13
        }
        if (-not (Test-PrecheckVersionGe -Found $version -Floor $floor)) {
            [Console]::Error.WriteLine("client=$Name precheck=fail reason=version-below-floor required=$floor found=$version error=too-old")
            [Console]::Error.WriteLine("Autoprompt precheck ($Name): $Name $version is below the required $floor. Update $Name to $floor or newer and re-run.")
            return 12
        }
    } else {
        $version = 'na'
    }

    [Console]::Out.WriteLine("client=$Name precheck=ok bin=$bin dir=$configDir version=$version")
    return 0
}
# --- F-LIB-PRECHECK (end) ---

# --- F-LIB-RECEIPT (begin) ---
# Write-Receipt records the install's black box: the single source of truth that
# makes uninstall exact and a non-owned config edit reversible. It serializes a
# JSON receipt to <ConfigRoot>\.autoprompt-install-receipt.json carrying the
# nonce, a pre-install backup path, every created file, and every config edit
# (with its priorValue, $null when the key did not exist). It is a PURE RECORDER:
# the caller has already created the files + applied the edits and passes the
# data in; Write-Receipt re-resolves/re-detects nothing.
#
# This is the behavior-faithful twin of write_receipt in install-lib.sh. The
# .ps1 port takes real typed parameters (PowerShell passes arrays/hashtables by
# value cleanly); $Edits is an array of @{ File; Key; Value; PriorValue } where
# PriorValue = $null means ABSENT (serialized as bare null), distinguished from
# '' (RESTORE empty). The SERIALIZER below is hand-rolled to match .sh byte-for-byte.
#
# Channel discipline (mirrors detect/resolve/format/precheck): the receipt BYTES
# go to the FILE (never the pipeline); the canonical one-line RECORD via
# [Console]::Out.WriteLine; errors via [Console]::Error.WriteLine; the scalar
# `return` int is the VERDICT and the ONLY value on the return pipeline. Codes:
# 0 ok, 20 no-config-root, 21 config-root-uncreatable, 22 receipt-tmp-write-failed,
# 23 receipt-rename-failed, 24 replacement-backup-cleanup-failed.
#
# Atomicity: bytes are written to <root>\<name>.tmp, then moved when absent or
# atomically replaced when present. Replacement succeeds only after its backup is
# deleted. A cleanup failure restores the old bytes and mtime when possible,
# retains the backup as actionable recovery material, and returns 24.
#
# Byte-parity (F-OP-DUALPARITY): the document is built with a FIXED key order
# (nonce, backup, files, createdDirectories, ompManaged, ompDetachedRoot,
# configEdits), a
# FIXED 2-space indent, explicit "`n"
# joins, exactly one trailing "`n", and WriteAllText with UTF8Encoding($false)
# (NO BOM) - byte-identical to the .sh printf '%s\n' output. ConvertTo-Json is
# NOT used for the WRITE (its spacing/escaping/line-endings are not byte-stable
# across PS versions); ConvertFrom-Json is allowed in the TESTS to PARSE back.
$AutopromptReceiptName = '.autoprompt-install-receipt.json'

# Format-ReceiptJsonEscape: the JSON string BODY (no surrounding quotes) for the
# input, escaping \ and " and the control chars JSON forbids raw, so the document
# round-trips through a real parser. Twin of _receipt_json_escape in .sh.
function Format-ReceiptJsonEscape {
    param([string]$Value)
    $sb = New-Object System.Text.StringBuilder
    foreach ($ch in $Value.ToCharArray()) {
        $code = [int]$ch
        switch ($ch) {
            '\' { [void]$sb.Append('\\') }
            '"' { [void]$sb.Append('\"') }
            "`n" { [void]$sb.Append('\n') }
            "`t" { [void]$sb.Append('\t') }
            "`r" { [void]$sb.Append('\r') }
            default {
                if ($code -lt 0x20) {
                    [void]$sb.Append(('\u{0:x4}' -f $code))
                } else {
                    [void]$sb.Append($ch)
                }
            }
        }
    }
    return $sb.ToString()
}

# Format-ReceiptFilesArray: the JSON array body for $Files, in order, indented 4
# spaces per element. Empty -> "[]". Twin of _receipt_files_array in .sh.
function Format-ReceiptFilesArray {
    param([string[]]$Files)
    if ($null -eq $Files -or $Files.Count -eq 0) { return '[]' }
    $lines = @('[')
    for ($i = 0; $i -lt $Files.Count; $i++) {
        $comma = if ($i -lt $Files.Count - 1) { ',' } else { '' }
        $lines += ('    "' + (Format-ReceiptJsonEscape -Value $Files[$i]) + '"' + $comma)
    }
    $lines += '  ]'
    return ($lines -join "`n")
}

# Format-ReceiptEditsArray: the JSON array body for $Edits. Each hashtable becomes
# a {file,key,value,priorValue} object; priorValue is bare null when PriorValue is
# $null. Empty -> "[]". Twin of _receipt_edits_array in .sh.
function Format-ReceiptEditsArray {
    param([hashtable[]]$Edits)
    if ($null -eq $Edits -or $Edits.Count -eq 0) { return '[]' }
    $lines = @('[')
    for ($i = 0; $i -lt $Edits.Count; $i++) {
        $edit = $Edits[$i]
        if ($null -eq $edit.PriorValue) {
            $priorJson = 'null'
        } else {
            $priorJson = '"' + (Format-ReceiptJsonEscape -Value ([string]$edit.PriorValue)) + '"'
        }
        $lines += '    {'
        $lines += ('      "file": "' + (Format-ReceiptJsonEscape -Value ([string]$edit.File)) + '",')
        $lines += ('      "key": "' + (Format-ReceiptJsonEscape -Value ([string]$edit.Key)) + '",')
        $lines += ('      "value": "' + (Format-ReceiptJsonEscape -Value ([string]$edit.Value)) + '",')
        $lines += ('      "priorValue": ' + $priorJson)
        $closer = if ($i -lt $Edits.Count - 1) { '    },' } else { '    }' }
        $lines += $closer
    }
    $lines += '  ]'
    return ($lines -join "`n")
}

function Restore-IdemReplacementTarget {
    param([string]$Target, [string]$Backup)
    try {
        $lastWriteTimeUtc = [System.IO.File]::GetLastWriteTimeUtc($Backup)
        [System.IO.File]::WriteAllBytes(
            $Target,
            [System.IO.File]::ReadAllBytes($Backup)
        )
        [System.IO.File]::SetLastWriteTimeUtc($Target, $lastWriteTimeUtc)
        return $true
    } catch {
        return $false
    }
}

function Complete-IdemReplacement {
    param(
        [string]$Target,
        [string]$Backup,
        [string]$Context,
        [switch]$RetainReplacement
    )
    try {
        Remove-Item -LiteralPath $Backup -Force -ErrorAction Stop
        return $true
    } catch {
        $isRestored = $RetainReplacement -or
            (Restore-IdemReplacementTarget -Target $Target -Backup $Backup)
        $action = if ($isRestored) {
            'fix-permissions-and-delete-backup'
        } else {
            'restore-from-backup'
        }
        [Console]::Error.WriteLine(
            "error=replacement-backup-cleanup-failed context=$Context " +
            "target=$Target backup=$Backup action=$action"
        )
        return $false
    }
}

function New-ReceiptDocument {
    param(
        [string]$Nonce,
        [string]$Backup,
        [string[]]$Files,
        [string[]]$CreatedDirectories,
        [bool]$OmpManaged,
        [string]$OmpDetachedRoot,
        [hashtable[]]$Edits,
        [AllowNull()][string]$PriorManifestSha256 = $null,
        [string[]]$FileSha256 = @()
    )
    $backupJson = if ([string]::IsNullOrEmpty($Backup)) {
        'null'
    } else {
        '"' + (Format-ReceiptJsonEscape -Value $Backup) + '"'
    }
    $detachedJson = if ([string]::IsNullOrEmpty($OmpDetachedRoot)) {
        'null'
    } else {
        '"' + (Format-ReceiptJsonEscape -Value $OmpDetachedRoot) + '"'
    }
    return '{' + "`n" +
        '  "nonce": "' + (Format-ReceiptJsonEscape -Value $Nonce) + '",' + "`n" +
        '  "priorManifestSha256": ' + $(if ([string]::IsNullOrEmpty($PriorManifestSha256)) {
            'null'
        } else { '"' + $PriorManifestSha256 + '"' }) + ',' + "`n" +
        '  "fileSha256": ' + (Format-ReceiptFilesArray -Files $FileSha256) + ',' + "`n" +
        '  "backup": ' + $backupJson + ',' + "`n" +
        '  "files": ' + (Format-ReceiptFilesArray -Files $Files) + ',' + "`n" +
        '  "createdDirectories": ' + (
            Format-ReceiptFilesArray -Files $CreatedDirectories
        ) + ',' + "`n" +
        '  "ompManaged": ' + $OmpManaged.ToString().ToLowerInvariant() + ',' + "`n" +
        '  "ompDetachedRoot": ' + $detachedJson + ',' + "`n" +
        '  "configEdits": ' + (Format-ReceiptEditsArray -Edits $Edits) + "`n" +
        '}' + "`n"
}

function Write-ReceiptDocument {
    param([string]$Path, [string]$Document)
    $temporary = "$Path.tmp"
    try {
        $encoding = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($temporary, $Document, $encoding)
    } catch {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        [Console]::Error.WriteLine("error=receipt-tmp-write-failed path=$temporary")
        return 22
    }
    try {
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
            [System.IO.File]::Move($temporary, $Path)
            return 0
        }
        $backup = "$Path.autoprompt.replace.bak"
        [System.IO.File]::Replace($temporary, $Path, $backup)
        if (Complete-IdemReplacement -Target $Path -Backup $backup `
            -Context 'receipt') { return 0 }
        return 24
    } catch {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        [Console]::Error.WriteLine("error=receipt-rename-failed path=$Path")
        return 23
    }
}

function Write-Receipt {
    param(
        [string]$ConfigRoot,
        [string]$Nonce,
        [string]$Backup = '',
        [string[]]$Files = @(),
        [string[]]$CreatedDirectories = @(),
        [bool]$OmpManaged = $false,
        [string]$OmpDetachedRoot = '',
        [hashtable[]]$Edits = @()
    )
    if ([string]::IsNullOrEmpty($ConfigRoot)) {
        [Console]::Error.WriteLine("error=no-config-root")
        return 20
    }
    if (-not (Test-Path -LiteralPath $ConfigRoot -PathType Container)) {
        try { New-Item -ItemType Directory -Path $ConfigRoot -Force `
            -ErrorAction Stop | Out-Null } catch { }
        if (-not (Test-Path -LiteralPath $ConfigRoot -PathType Container)) {
            [Console]::Error.WriteLine("error=config-root-uncreatable dir=$ConfigRoot")
            return 21
        }
    }
    $fileSha256 = @($Files | ForEach-Object {
        $hash = Get-IdemManifestHash -ConfigRoot $ConfigRoot -Key $_
        if (-not [string]::IsNullOrEmpty($hash)) { "$_=$hash" }
    })
    $document = New-ReceiptDocument -Nonce $Nonce -Backup $Backup `
        -Files $Files -CreatedDirectories $CreatedDirectories `
        -OmpManaged $OmpManaged -OmpDetachedRoot $OmpDetachedRoot -Edits $Edits `
        -PriorManifestSha256 $script:AutopromptReceiptPriorManifestSha256 `
        -FileSha256 $fileSha256
    $final = Join-Path $ConfigRoot $AutopromptReceiptName
    $writeCode = Write-ReceiptDocument -Path $final -Document $document
    if ($writeCode -ne 0) { return $writeCode }
    [Console]::Out.WriteLine(
        "receipt=$final nonce=$Nonce files=$($Files.Count) edits=$($Edits.Count)"
    )
    return 0
}
# --- F-LIB-RECEIPT (end) ---

# --- F-LIB-COPY (begin) ---
# Install-Copy is the behavior-faithful twin of install_copy in install-lib.sh:
# "the real copy" that chains Resolve-Destination -> Format-Skill -> write+record
# to turn a resolved Windows path + a format token + the skill payload into an
# ACTUAL file on disk in the client's native format. It REUSES the pure
# transformers and adds the only filesystem mutation in the lib.
#
# Signature: Install-Copy -Name <client> -SkillName <name> -Description <desc>
#                         -Body <body> [-Variant <v>]
#   -Name is the CLIENT (matches Resolve-Destination / Test-Precheck); -SkillName
#   is the frontmatter name: value (kept distinct from -Name to avoid collision).
#   -Body is passed in ALREADY STRIPPED of any source frontmatter (the file-read
#   + split belongs to the wrapper layer). Because COPY re-mints frontmatter via
#   Format-Skill (a FIXED name+description literal, no tool-key path), a source
#   body's allowed-tools is structurally DROPPED - the P0 (F-OP-NORESTRICT).
#
# Order matters: render to a no-trim in-memory buffer FIRST (the PS analog of the
# .sh system-temp stage; no install-tree mutation), then ONLY after a successful
# render New-Item the parent + atomically land (.tmp via WriteAllText then
# [IO.File]::Move). A deferred/failed format leaves NO install-tree dir, NO .tmp.
#
# Channel discipline (mirrors detect/resolve/format/receipt): the RECORD via
# [Console]::Out.WriteLine; error records via [Console]::Error.WriteLine; the
# scalar `return` int is the VERDICT and the ONLY value on the return pipeline.
# Codes: 0 ok; 2/3 delegated from resolve; 2/4/5/6 delegated from format; 30
# parent-uncreatable; 31 staging/write-failed; 32 rename-failed.
#
# Byte-parity (F-OP-DUALPARITY): Get-CopyRender captures Format-Skill's bytes with
# NO .Trim() (the render carries a load-bearing trailing "`n"); WriteAllText with
# UTF8Encoding($false) writes them verbatim (no BOM, no "`r`n" translation) -
# byte-identical to the .sh port. The trailing-slash kilo dest lands SKILL.md
# inside the dir; flat dests land at the path itself.

# Init the receipt accumulators once. When dot-sourced, $script: binds to the
# caller's scope, shared between managed mutations and the orchestrator's seal.
if ($null -eq $script:AutopromptReceiptFiles) {
    $script:AutopromptReceiptFiles = @()
}
if ($null -eq $script:AutopromptReceiptCreatedDirectories) {
    $script:AutopromptReceiptCreatedDirectories = @()
}

# Codex v2 keeps durable activation records and quarantined historical bytes below
# a non-discovery root. Provider-global skill/agent load paths must never point here.
function Get-AutopromptPrivateStateRoot {
    param([string]$Name)
    if ($Name -cne 'codex') { return '' }
    return (Join-Path (Get-AutopromptConfigRoot -Name 'codex') `
        '.autoprompt-private')
}

function Get-AutopromptProviderActivationCapabilities {
    param([string]$Name)
    if ($Name -cne 'codex') { return $null }
    return [ordered]@{
        Isolation = 'strict'
        TopologyEnforcement = 'prompt-guarded'
        PrivateSkillRoot = $true
        ProcessOwnership = $false
        EventStreaming = $false
        ToolOutputCapture = $false
        StableChildIdentity = $false
        SameContextContinuation = $false
        Cancellation = $false
        IsolatedChecking = $false
        ModelRouting = $true
    }
}
if ($null -eq $script:AutopromptReceiptOmpManaged) {
    $script:AutopromptReceiptOmpManaged = $false
}
if ($null -eq $script:AutopromptReceiptOmpDetachedRoot) {
    $script:AutopromptReceiptOmpDetachedRoot = ''
}

# Capture Format-Skill's rendered bytes EXACTLY (NO .Trim()): the render carries a
# single trailing "`n" that F-OP-DUALPARITY requires on disk; Get-PrecheckUpstream
# (.ps1:365) returns .Trim()'d output and would STRIP it - never use it here.
function Get-CopyRender {
    param([scriptblock]$Call)
    $origOut = [Console]::Out
    $sw = New-Object System.IO.StringWriter
    $code = $null
    try {
        [Console]::SetOut($sw)
        $code = & $Call
    } finally {
        [Console]::SetOut($origOut)
    }
    return @{ Rendered = $sw.ToString(); Code = [int]$code }   # NO .Trim()
}

function Get-CopyDestination {
    param([string]$Record)
    $destination = $Record -replace '^client=\S+ dest=', '' `
        -replace ' format=\S+$', ''
    $format = $Record -replace '^.* format=', ''
    $landed = if ($destination.EndsWith('\') -or
        $destination.EndsWith('/')) {
        Join-Path $destination 'SKILL.md'
    } else {
        $destination
    }
    return @{ Landed = $landed; Format = $format }
}

function Initialize-CopyParent {
    param([string]$Name, [string]$Landed)
    $parent = Split-Path -Parent $Landed
    if (Test-Path -LiteralPath $parent -PathType Container) { return 0 }
    try {
        New-Item -ItemType Directory -Path $parent -Force `
            -ErrorAction Stop | Out-Null
    } catch { }
    if (Test-Path -LiteralPath $parent -PathType Container) { return 0 }
    [Console]::Error.WriteLine(
        "client=$Name error=parent-uncreatable dir=$parent"
    )
    return 30
}

function Write-CopyPayload {
    param([string]$Name, [string]$Landed, [string]$Content)
    $temporary = "$Landed.tmp"
    try {
        $encoding = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($temporary, $Content, $encoding)
    } catch {
        [Console]::Error.WriteLine(
            "client=$Name error=copy-write-failed path=$temporary"
        )
        return 31
    }
    try {
        if (Test-Path -LiteralPath $Landed -PathType Leaf) {
            Remove-Item -LiteralPath $Landed -Force -ErrorAction Stop
        }
        [System.IO.File]::Move($temporary, $Landed)
    } catch {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        [Console]::Error.WriteLine(
            "client=$Name error=copy-rename-failed path=$Landed"
        )
        return 32
    }
    return 0
}

function Install-Copy {
    param(
        [string]$Name,
        [string]$SkillName,
        [string]$Description,
        [string]$Body,
        [string]$Variant = ''
    )
    $resolve = Get-PrecheckUpstream -Call {
        Resolve-Destination -Name $Name -Variant $Variant
    }
    if ($resolve.Code -ne 0) { return $resolve.Code }
    $destination = Get-CopyDestination -Record $resolve.Record
    $render = Get-CopyRender -Call {
        Format-Skill -Format $destination.Format -Name $SkillName `
            -Description $Description -Body $Body
    }
    if ($render.Code -ne 0) { return $render.Code }
    $parentCode = Initialize-CopyParent -Name $Name `
        -Landed $destination.Landed
    if ($parentCode -ne 0) { return $parentCode }
    $writeCode = Write-CopyPayload -Name $Name -Landed $destination.Landed `
        -Content $render.Rendered
    if ($writeCode -ne 0) { return $writeCode }
    $script:AutopromptReceiptFiles += $destination.Landed
    $bytes = (Get-Item -LiteralPath $destination.Landed).Length
    [Console]::Out.WriteLine(
        "client=$Name copy=ok dest=$($destination.Landed) " +
        "format=$($destination.Format) bytes=$bytes"
    )
    return 0
}
# --- F-LIB-COPY (end) ---

# --- F-LIB-IDEM (begin) ---
# Install-Idempotent is the behavior-faithful twin of install_idempotent in
# install-lib.sh: it makes a re-run SAFE and SILENT by deciding, BEFORE any write,
# whether the already-landed file is already correct, and writing ONLY when it
# must. It REUSES Resolve-Destination (path math), Format-Skill (the bytes via the
# COPY-private no-trim Get-CopyRender), and Install-Copy (the only filesystem
# mutation). IDEM adds the content-hash, the manifest read/write, the
# receipt-presence check, the decision table, and the records.
#
# ConfigRoot is an EXPLICIT PARAMETER (mirrors Write-Receipt's contract): the
# orchestrator passes the SAME root it passes to Write-Receipt. IDEM does ZERO
# config-root derivation, which is correct for XDG clients BY CONSTRUCTION. Empty
# ConfigRoot => code 41.
#
# Signature: Install-Idempotent -ConfigRoot <root> -Name <client> -SkillName <name>
#                               -Description <desc> -Body <body> [-Variant <v>]
#
# SHA-256 is computed over the NORMALIZED Format-Skill payload (\n-only, one
# trailing \n, no BOM): Get-IdemSha256 uses Get-FileHash then .Hash.ToLower() so it
# matches the .sh tools' lowercase hex. If that cmdlet is unavailable, the built-in
# .NET SHA256 implementation produces the same value. A failure in both paths maps
# to 42 for parity. Because the
# payload normalization is identical across ports, .ps1 and .sh hashes are
# IDENTICAL hex for the same input (F-OP-DUALPARITY).
#
# The manifest sidecar (<ConfigRoot>\.autoprompt-install-hashes.json) is
# RECEIPT-TRACKED: after a successful manifest write its absolute path is appended
# (once-guarded) to $script:AutopromptReceiptFiles so the EXISTING uninstall sweeps
# it (zero residue). The serializer is hand-rolled (explicit "`n" joins,
# WriteAllText with UTF8Encoding($false), NEVER ConvertTo-Json/WriteLine) for
# byte-parity with the .sh manifest.
#
# Decision table (first matching row wins; R1 = disk-correct never writes,
# R2 = drift wins, UPDATE requires a clean prior install). Records: NO-WRITE =>
# `already-installed v<hash>`; UPDATE => `client=<n> idem=update dest=<l>
# oldhash=<rec> newhash=<exp>`; REPAIR => `client=<n> idem=repair dest=<l>
# reason=<…> hash=<exp>`. UPDATE/REPAIR re-mint via Install-Copy so they only ever
# land expectedHash bytes - a byte change is ALWAYS announced.
#
# Return-code band (IDEM-OWNED 40-49): 0 any outcome ok; 2/3 delegated from
# resolve; 2/4/5/6 delegated from format; 30/31/32 delegated from Install-Copy on a
# re-copy; 40 manifest write failed (file IS landed); 41 ConfigRoot empty; 42 no
# sha256 tool.
#
# Channel discipline: RECORD via [Console]::Out.WriteLine, errors via
# [Console]::Error.WriteLine, scalar `return` int is the VERDICT and the ONLY value
# on the return pipeline.
$AutopromptHashManifestName = '.autoprompt-install-hashes.json'

# Get-IdemSha256: lowercase 64-hex SHA-256 of <Path>. Tries Get-FileHash first and
# the built-in .NET implementation second. Returns 42 (scalar int) only when both
# fail; the success path returns the hex string. The caller distinguishes them by
# type (a [string] hex vs an [int] 42).
function Get-IdemSha256 {
    param([string]$Path)
    try {
        return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path -ErrorAction Stop).Hash.ToLower()
    } catch {
        $stream = $null
        $algorithm = $null
        try {
            $stream = [System.IO.File]::Open(
                $Path,
                [System.IO.FileMode]::Open,
                [System.IO.FileAccess]::Read,
                [System.IO.FileShare]::Read
            )
            $algorithm = [System.Security.Cryptography.SHA256]::Create()
            $bytes = $algorithm.ComputeHash($stream)
            return ([System.BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
        } catch {
            [Console]::Error.WriteLine("error=no-sha256-tool path=$Path")
            [Console]::Error.WriteLine("Autoprompt idempotency: SHA-256 hashing failed; ensure the file is readable and re-run.")
            return 42
        } finally {
            if ($null -ne $algorithm) { $algorithm.Dispose() }
            if ($null -ne $stream) { $stream.Dispose() }
        }
    }
}

$script:AutopromptPathComparer = if (
    [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT
) {
    [System.StringComparer]::OrdinalIgnoreCase
} else {
    [System.StringComparer]::Ordinal
}
$script:AutopromptPathComparison = if (
    [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT
) {
    [System.StringComparison]::OrdinalIgnoreCase
} else {
    [System.StringComparison]::Ordinal
}

function Get-IdemPathComparer {
    return $script:AutopromptPathComparer
}

function Get-IdemPathComparison {
    return $script:AutopromptPathComparison
}

function Test-IdemPathEqual {
    param([string]$Left, [string]$Right)
    $normalizedLeft = Get-IdemNormalizedPath -Path $Left
    $normalizedRight = Get-IdemNormalizedPath -Path $Right
    if ([string]::IsNullOrEmpty($normalizedLeft) -or
        [string]::IsNullOrEmpty($normalizedRight)) {
        return $false
    }
    return $normalizedLeft.Equals($normalizedRight, (Get-IdemPathComparison))
}

function Test-IdemReceiptOwnsPath {
    param([string]$Path)
    foreach ($ownedPath in @($script:AutopromptReceiptFiles)) {
        if (Test-IdemPathEqual -Left $ownedPath -Right $Path) { return $true }
    }
    return $false
}

function Add-IdemReceiptFile {
    param([string]$Path)
    if (-not (Test-IdemReceiptOwnsPath -Path $Path)) {
        $script:AutopromptReceiptFiles += $Path
    }
}

function Remove-IdemReceiptFile {
    param([string]$Path)
    $script:AutopromptReceiptFiles = @($script:AutopromptReceiptFiles |
        Where-Object { -not (Test-IdemPathEqual -Left $_ -Right $Path) })
}

function Test-IdemReceiptOwnsCreatedDirectory {
    param([string]$Path)
    foreach ($ownedPath in @($script:AutopromptReceiptCreatedDirectories)) {
        if (Test-IdemPathEqual -Left $ownedPath -Right $Path) { return $true }
    }
    return $false
}

function Add-IdemReceiptCreatedDirectory {
    param([string]$Path)
    if (-not (Test-IdemReceiptOwnsCreatedDirectory -Path $Path)) {
        $script:AutopromptReceiptCreatedDirectories += $Path
    }
}

function Remove-IdemReceiptCreatedDirectory {
    param([string]$Path)
    $script:AutopromptReceiptCreatedDirectories = @(
        $script:AutopromptReceiptCreatedDirectories | Where-Object {
            -not (Test-IdemPathEqual -Left $_ -Right $Path)
        }
    )
}
$codexRegistryPath = Join-Path $AutopromptInstallRepoRoot `
    'scripts/install/codex-package-registry.json'
try {
    $codexRegistry = Get-Content -LiteralPath $codexRegistryPath -Raw | ConvertFrom-Json
    if ([string]$codexRegistry.compatibility.cliMinimum -cnotmatch `
        '^\d+\.\d+\.\d+$') { throw 'invalid Codex floor' }
    $AutopromptVersionFloor.codex = [string]$codexRegistry.compatibility.cliMinimum
} catch {
    $AutopromptVersionFloor.codex = 'registry-invalid'
}

function Test-IdemPortableManifestKey {
    param([string]$Key)
    if ([string]::IsNullOrWhiteSpace($Key) -or
        $Key -match '[:\x00-\x1f]' -or
        $Key -match '[\\/]$') {
        return $false
    }
    try {
        if ([System.IO.Path]::IsPathRooted($Key)) { return $false }
    } catch {
        return $false
    }
    $parts = [regex]::Split($Key, '[\\/]')
    return @($parts | Where-Object {
        [string]::IsNullOrEmpty($_) -or $_ -in @('.', '..')
    }).Count -eq 0
}

function Get-IdemManifestKeyIdentity {
    param([string]$ConfigRoot, [string]$Key)
    if ([string]::IsNullOrWhiteSpace($Key)) { return '' }
    try {
        if ([System.IO.Path]::IsPathRooted($Key)) {
            return Get-IdemNormalizedPath -Path $Key
        }
    } catch {
        return ''
    }
    $root = Get-IdemNormalizedPath -Path $ConfigRoot
    if ([string]::IsNullOrEmpty($root) -or
        -not (Test-IdemPortableManifestKey -Key $Key)) {
        return ''
    }
    $candidate = Get-IdemNormalizedPath -Path (Join-Path $root `
        ($Key -replace '/', [System.IO.Path]::DirectorySeparatorChar))
    if ([string]::IsNullOrEmpty($candidate) -or
        -not (Test-IdemPathUnderRoot -Path $candidate -Root $root)) {
        return ''
    }
    return $candidate
}

function Get-IdemManifestMatchingKeys {
    param(
        [System.Collections.IDictionary]$Entries,
        [string]$Key,
        [string]$ConfigRoot = ''
    )
    $normalizedKey = Get-IdemManifestKeyIdentity -ConfigRoot $ConfigRoot `
        -Key $Key
    if ([string]::IsNullOrEmpty($normalizedKey)) { return @() }
    $comparison = Get-IdemPathComparison
    return [string[]]@($Entries.Keys | Where-Object {
        $normalizedEntry = Get-IdemManifestKeyIdentity `
            -ConfigRoot $ConfigRoot -Key ([string]$_)
        -not [string]::IsNullOrEmpty($normalizedEntry) -and
            $normalizedEntry.Equals($normalizedKey, $comparison)
    })
}

# Get-IdemManifestHash: the recorded hex for <Key> from the manifest, or '' when
# the manifest or the filesystem-equivalent key is absent.
function Get-IdemManifestHash {
    param([string]$ConfigRoot, [string]$Key)
    $manifest = Join-Path $ConfigRoot $AutopromptHashManifestName
    if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { return '' }
    $entries = Read-IdemManifestEntries -ConfigRoot $ConfigRoot
    $matches = @(Get-IdemManifestMatchingKeys -Entries $entries -Key $Key `
        -ConfigRoot $ConfigRoot)
    if ($matches.Count -eq 0) { return '' }
    return [string]$entries[$matches[0]]
}

function ConvertFrom-ReceiptJsonEscape {
    param([string]$Escaped, [ref]$Decoded)
    $builder = New-Object System.Text.StringBuilder
    for ($index = 0; $index -lt $Escaped.Length; $index++) {
        $character = $Escaped[$index]
        $code = [int]$character
        if ($character -eq '"' -or $code -lt 0x20) { return $false }
        if ($character -ne '\') {
            [void]$builder.Append($character)
            continue
        }
        if ($index + 1 -ge $Escaped.Length) { return $false }
        $index++
        switch ($Escaped[$index]) {
            'n' { [void]$builder.Append("`n") }
            't' { [void]$builder.Append("`t") }
            'r' { [void]$builder.Append("`r") }
            '"' { [void]$builder.Append('"') }
            '\' { [void]$builder.Append('\') }
            'u' {
                if ($index + 4 -ge $Escaped.Length) { return $false }
                $unicode = $Escaped.Substring($index - 1, 6)
                if ($unicode -cnotmatch '^\\u00[0-9a-fA-F]{2}$') {
                    return $false
                }
                $unicodeCode = [Convert]::ToInt32($unicode.Substring(4), 16)
                if ($unicodeCode -eq 0) { return $false }
                [void]$builder.Append([char]$unicodeCode)
                $index += 4
            }
            default { return $false }
        }
    }
    $value = $builder.ToString()
    if ((Format-ReceiptJsonEscape -Value $value) -cne $Escaped) {
        return $false
    }
    $Decoded.Value = $value
    return $true
}

function Test-IdemSha256 {
    param([string]$Hash)
    return $Hash -cmatch '^[a-f0-9]{64}$'
}

function Read-IdemManifestDocument {
    param([string]$Path)
    $document = [System.IO.File]::ReadAllText($Path)
    if ($document.Contains("`r") -or $document.Contains([char]0) -or
        -not $document.EndsWith("`n") -or $document.EndsWith("`n`n")) {
        throw "invalid ownership manifest grammar: $Path"
    }
    $lines = @($document.Substring(0, $document.Length - 1) `
        -split "`n", -1)
    if ($lines.Count -lt 2 -or $lines[0] -cne '{' -or
        $lines[$lines.Count - 1] -cne '}') {
        throw "invalid ownership manifest grammar: $Path"
    }
    return @{ Document = $document; Lines = $lines }
}

function ConvertFrom-IdemManifestLine {
    param(
        [string]$Line,
        [bool]$ShouldHaveComma,
        [string]$Manifest,
        [System.Collections.Generic.HashSet[string]]$Spellings,
        [System.Collections.Generic.HashSet[string]]$Identities
    )
    $match = [regex]::Match(
        $Line,
        '^    "(.*)": "([a-f0-9]{64})"(,?)$'
    )
    if (-not $match.Success) {
        throw "invalid ownership manifest grammar: $Manifest"
    }
    $hasComma = $match.Groups[3].Value -ceq ','
    if ($hasComma -ne $ShouldHaveComma) {
        throw "invalid ownership manifest comma placement: $Manifest"
    }
    $key = ''
    if (-not (ConvertFrom-ReceiptJsonEscape `
        -Escaped $match.Groups[1].Value -Decoded ([ref]$key)) -or
        [string]::IsNullOrEmpty($key)) {
        throw "invalid ownership manifest key: $Manifest"
    }
    $normalizedKey = Get-IdemNormalizedPath -Path $key
    if (-not $Spellings.Add($key)) { throw "duplicate manifest key: $key" }
    if ([string]::IsNullOrEmpty($normalizedKey) -or
        -not $Identities.Add($normalizedKey)) {
        throw "duplicate filesystem-equivalent manifest key: $key"
    }
    $comma = if ($hasComma) { ',' } else { '' }
    $hash = $match.Groups[2].Value
    $escapedKey = Format-ReceiptJsonEscape -Value $key
    return @{
        Key = $key
        Hash = $hash
        Canonical = "    `"$escapedKey`": `"$hash`"$comma"
    }
}

function Read-IdemManifestEntries {
    param([string]$ConfigRoot)
    $manifest = Join-Path $ConfigRoot $AutopromptHashManifestName
    $entries = New-Object System.Collections.Specialized.OrderedDictionary `
        ([System.StringComparer]::Ordinal)
    if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) {
        return $entries
    }
    $parsed = Read-IdemManifestDocument -Path $manifest
    $spellings = New-Object 'System.Collections.Generic.HashSet[string]' `
        ([System.StringComparer]::Ordinal)
    $identities = New-Object 'System.Collections.Generic.HashSet[string]' `
        (Get-IdemPathComparer)
    $canonical = @('{')
    for ($index = 1; $index -lt $parsed.Lines.Count - 1; $index++) {
        $entry = ConvertFrom-IdemManifestLine -Line $parsed.Lines[$index] `
            -ShouldHaveComma ($index -lt $parsed.Lines.Count - 2) `
            -Manifest $manifest -Spellings $spellings -Identities $identities
        $canonical += $entry.Canonical
        $entries.Add($entry.Key, $entry.Hash)
    }
    if (((($canonical + '}') -join "`n") + "`n") -cne $parsed.Document) {
        throw "noncanonical ownership manifest: $manifest"
    }
    return $entries
}

function Test-IdemManifestEntries {
    param(
        [System.Collections.IDictionary]$Entries,
        [string]$Manifest
    )
    $identities = New-Object 'System.Collections.Generic.HashSet[string]' `
        (Get-IdemPathComparer)
    foreach ($key in $Entries.Keys) {
        $normalizedKey = Get-IdemNormalizedPath -Path ([string]$key)
        $hash = [string]$Entries[$key]
        if ([string]::IsNullOrEmpty($normalizedKey) -or
            -not $identities.Add($normalizedKey) -or
            -not (Test-IdemSha256 -Hash $hash)) {
            [Console]::Error.WriteLine(
                "error=hash-manifest-invalid-entry path=$Manifest key=$key"
            )
            return $false
        }
    }
    return $true
}

function New-IdemManifestDocument {
    param([System.Collections.IDictionary]$Entries)
    $lines = @('{')
    $index = 0
    foreach ($key in $Entries.Keys) {
        $comma = if ($index -lt $Entries.Count - 1) { ',' } else { '' }
        $escapedKey = Format-ReceiptJsonEscape -Value ([string]$key)
        $hash = [string]$Entries[$key]
        $lines += ('    "' + $escapedKey + '": "' + $hash + '"' + $comma)
        $index++
    }
    return (($lines + '}') -join "`n") + "`n"
}

function Write-IdemManifestDocument {
    param([string]$Manifest, [string]$Document)
    if ((Test-Path -LiteralPath $Manifest -PathType Leaf) -and
        [System.IO.File]::ReadAllText($Manifest) -ceq $Document) { return $true }
    $temporary = "$Manifest.tmp"
    try {
        $encoding = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($temporary, $Document, $encoding)
        if (-not (Test-Path -LiteralPath $Manifest -PathType Leaf)) {
            [System.IO.File]::Move($temporary, $Manifest)
            return $true
        }
        $backup = "$Manifest.autoprompt.replace.bak"
        [System.IO.File]::Replace($temporary, $Manifest, $backup)
        return Complete-IdemReplacement -Target $Manifest -Backup $backup `
            -Context 'hash-manifest'
    } catch {
        try {
            Remove-Item -LiteralPath $temporary -Recurse -Force `
                -ErrorAction SilentlyContinue
        } catch { } # Preserve the original write error.
        [Console]::Error.WriteLine(
            "error=hash-manifest-write-failed path=$Manifest"
        )
        return $false
    }
}

function Write-IdemManifestEntries {
    param([string]$ConfigRoot, [System.Collections.IDictionary]$Entries)
    $manifest = Join-Path $ConfigRoot $AutopromptHashManifestName
    if (-not (Test-IdemManifestEntries -Entries $Entries `
        -Manifest $manifest)) { return $false }
    $document = New-IdemManifestDocument -Entries $Entries
    return Write-IdemManifestDocument -Manifest $manifest -Document $document
}

function Set-IdemManifestHash {
    param([string]$ConfigRoot, [string]$Key, [string]$Hash)
    if ([string]::IsNullOrEmpty((Get-IdemNormalizedPath -Path $Key)) -or
        -not (Test-IdemSha256 -Hash $Hash)) {
        [Console]::Error.WriteLine(
            "error=hash-manifest-invalid-entry path=$(Join-Path $ConfigRoot $AutopromptHashManifestName) key=$Key"
        )
        return $false
    }
    try { $entries = Read-IdemManifestEntries -ConfigRoot $ConfigRoot }
    catch {
        [Console]::Error.WriteLine("error=hash-manifest-read-failed path=$(Join-Path $ConfigRoot $AutopromptHashManifestName)")
        return $false
    }
    $matches = @(Get-IdemManifestMatchingKeys -Entries $entries -Key $Key `
        -ConfigRoot $ConfigRoot)
    if ($matches.Count -gt 0) {
        $retainedKey = $matches[0]
        $isUnchanged = $matches.Count -eq 1 -and
            $entries[$retainedKey] -ceq $Hash
        if ($isUnchanged) { return $true }
        $entries[$retainedKey] = $Hash
        foreach ($duplicate in @($matches | Select-Object -Skip 1)) {
            $entries.Remove($duplicate)
        }
    } else {
        $entries.Add($Key, $Hash)
    }
    return (Write-IdemManifestEntries -ConfigRoot $ConfigRoot -Entries $entries)
}

function Set-IdemManifestHashes {
    param(
        [string]$ConfigRoot,
        [object[]]$Hashes,
        [switch]$UseIdentityIndex
    )
    $manifest = Join-Path $ConfigRoot $AutopromptHashManifestName
    try { $entries = Read-IdemManifestEntries -ConfigRoot $ConfigRoot }
    catch {
        [Console]::Error.WriteLine("error=hash-manifest-read-failed path=$manifest")
        return $false
    }
    $identityKeys = $null
    $identityHashes = $null
    $incomingHashes = $null
    $incomingKeys = $null
    $incomingOrder = @()
    if ($UseIdentityIndex) {
        $identityKeys = New-Object `
            'System.Collections.Generic.Dictionary[string,object]' `
            (Get-IdemPathComparer)
        $identityHashes = New-Object `
            'System.Collections.Generic.Dictionary[string,string]' `
            (Get-IdemPathComparer)
        $incomingHashes = New-Object `
            'System.Collections.Generic.Dictionary[string,string]' `
            (Get-IdemPathComparer)
        $incomingKeys = New-Object `
            'System.Collections.Generic.Dictionary[string,string]' `
            (Get-IdemPathComparer)
        foreach ($existingKey in $entries.Keys) {
            $existingIdentity = Get-IdemManifestKeyIdentity `
                -ConfigRoot $ConfigRoot -Key ([string]$existingKey)
            $existingHash = [string]$entries[$existingKey]
            if ([string]::IsNullOrEmpty($existingIdentity)) {
                [Console]::Error.WriteLine(
                    "error=hash-manifest-invalid-entry path=$manifest key=$existingKey"
                )
                return $false
            }
            if ($identityKeys.ContainsKey($existingIdentity)) {
                if ($identityHashes[$existingIdentity] -cne $existingHash) {
                    [Console]::Error.WriteLine(
                        "error=hash-manifest-invalid-entry path=$manifest key=$existingKey"
                    )
                    return $false
                }
                $identityKeys[$existingIdentity] = [string[]]@(
                    @($identityKeys[$existingIdentity]) + [string]$existingKey
                )
            } else {
                $identityKeys.Add(
                    $existingIdentity,
                    [string[]]@([string]$existingKey)
                )
                $identityHashes.Add($existingIdentity, $existingHash)
            }
        }
    }
    foreach ($item in $Hashes) {
        $key = [string]$item.Key
        $hash = [string]$item.Hash
        if ($UseIdentityIndex) {
            $key = ConvertTo-IdemPortableManifestKey `
                -ConfigRoot $ConfigRoot -Target $key
        }
        $keyIdentity = Get-IdemManifestKeyIdentity `
            -ConfigRoot $ConfigRoot -Key $key
        if ([string]::IsNullOrEmpty($keyIdentity) -or
            -not (Test-IdemSha256 -Hash $hash)) {
            [Console]::Error.WriteLine(
                "error=hash-manifest-invalid-entry path=$manifest key=$key"
            )
            return $false
        }
        if ($UseIdentityIndex -and
            $identityHashes.ContainsKey($keyIdentity) -and
            $identityHashes[$keyIdentity] -cne $hash) {
            [Console]::Error.WriteLine(
                "error=hash-manifest-invalid-entry path=$manifest key=$key"
            )
            return $false
        }
        if ($UseIdentityIndex -and $incomingHashes.ContainsKey($keyIdentity)) {
            if ($incomingHashes[$keyIdentity] -cne $hash) {
                [Console]::Error.WriteLine(
                    "error=hash-manifest-invalid-entry path=$manifest key=$key"
                )
                return $false
            }
            continue
        }
        if ($UseIdentityIndex) {
            $incomingHashes.Add($keyIdentity, $hash)
            $incomingKeys.Add($keyIdentity, $key)
            $incomingOrder += $keyIdentity
            continue
        }
        $matches = @(Get-IdemManifestMatchingKeys -Entries $entries -Key $key `
            -ConfigRoot $ConfigRoot)
        if ($matches.Count -gt 0) {
            $retainedKey = $matches[0]
            $entries[$retainedKey] = $hash
            foreach ($duplicate in @($matches | Select-Object -Skip 1)) {
                $entries.Remove($duplicate)
            }
        } else {
            $entries.Add($key, $hash)
        }
    }
    if ($UseIdentityIndex) {
        foreach ($keyIdentity in $incomingOrder) {
            $key = $incomingKeys[$keyIdentity]
            $hash = $incomingHashes[$keyIdentity]
            $matches = if ($identityKeys.ContainsKey($keyIdentity)) {
                [string[]]@($identityKeys[$keyIdentity])
            } else { @() }
            if ($matches.Count -eq 1 -and $matches[0] -ceq $key) {
                $entries[$key] = $hash
                continue
            }
            foreach ($match in $matches) { $entries.Remove($match) }
            $entries.Add($key, $hash)
        }
    }
    return Write-IdemManifestEntries -ConfigRoot $ConfigRoot -Entries $entries
}

function ConvertTo-IdemPortableManifestKey {
    param([string]$ConfigRoot, [string]$Target)
    $rootSpelling = $ConfigRoot.TrimEnd([char]92, [char]47)
    if ([string]::IsNullOrEmpty($rootSpelling) -or
        $Target.Length -le $rootSpelling.Length -or
        -not $Target.Substring(0, $rootSpelling.Length).Equals(
            $rootSpelling, (Get-IdemPathComparison)
        ) -or $Target[$rootSpelling.Length] -notin @([char]92, [char]47)) {
        return ''
    }
    $relativeSpelling = $Target.Substring($rootSpelling.Length + 1)
    if (-not (Test-IdemPortableManifestKey -Key $relativeSpelling)) {
        return ''
    }
    $root = Get-IdemNormalizedPath -Path $ConfigRoot
    $targetPath = Get-IdemNormalizedPath -Path $Target
    if ([string]::IsNullOrEmpty($root) -or
        [string]::IsNullOrEmpty($targetPath) -or
        -not (Test-IdemPathUnderRoot -Path $targetPath -Root $root)) {
        return ''
    }
    $prefix = $root + [System.IO.Path]::DirectorySeparatorChar
    return ($relativeSpelling -replace '\\', '/')
}

function Remove-IdemManifestHash {
    param([string]$ConfigRoot, [string]$Key)
    try { $entries = Read-IdemManifestEntries -ConfigRoot $ConfigRoot }
    catch {
        [Console]::Error.WriteLine("error=hash-manifest-read-failed path=$(Join-Path $ConfigRoot $AutopromptHashManifestName)")
        return $false
    }
    $matches = @(Get-IdemManifestMatchingKeys -Entries $entries -Key $Key `
        -ConfigRoot $ConfigRoot)
    if ($matches.Count -eq 0) { return $true }
    foreach ($match in $matches) { $entries.Remove($match) }
    return (Write-IdemManifestEntries -ConfigRoot $ConfigRoot -Entries $entries)
}

function Register-IdemManagedFile {
    param([string]$ConfigRoot, [string]$Path)
    $hash = Get-IdemSha256 -Path $Path
    if ($hash -is [int]) { return $hash }
    if (-not (Set-IdemManifestHash -ConfigRoot $ConfigRoot -Key $Path -Hash $hash)) { return 40 }
    Add-IdemReceiptFile -Path $Path
    $manifest = Join-Path $ConfigRoot $AutopromptHashManifestName
    Add-IdemReceiptFile -Path $manifest
    return 0
}

function Copy-IdemAtomic {
    param([string]$Source, [string]$Target)
    if ((Test-Path -LiteralPath $Target -PathType Leaf)) {
        $sourceHash = Get-IdemSha256 -Path $Source
        $targetHash = Get-IdemSha256 -Path $Target
        if ($sourceHash -is [int] -or $targetHash -is [int]) { return $false }
        if ($sourceHash -eq $targetHash) { return $true }
    }

    $parent = Split-Path -Parent $Target
    $temporary = "$Target.autoprompt.tmp"
    try {
        New-Item -ItemType Directory -Path $parent -Force -ErrorAction Stop | Out-Null
        [System.IO.File]::Copy($Source, $temporary, $true)
        if (Test-Path -LiteralPath $Target -PathType Leaf) {
            $backup = "$Target.autoprompt.replace.bak"
            [System.IO.File]::Replace($temporary, $Target, $backup)
            if (-not (Complete-IdemReplacement -Target $Target `
                -Backup $backup -Context 'managed-target')) {
                return $false
            }
        } else {
            [System.IO.File]::Move($temporary, $Target)
        }
    } catch {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        return $false
    }
    return $true
}

function Get-IdemSnapshotPaths {
    param([string]$ConfigRoot, [string[]]$Paths)
    $allPaths = @($Paths)
    $allPaths += Join-Path $ConfigRoot $AutopromptHashManifestName
    $allPaths += Join-Path $ConfigRoot $AutopromptReceiptName
    foreach ($edit in @($script:AutopromptReceiptEdits)) {
        if ([string]::IsNullOrEmpty($edit.File)) { continue }
        $allPaths += $edit.File
        $allPaths += "$($edit.File)$AutopromptConfigEditBackupSuffix"
    }
    if (-not [string]::IsNullOrEmpty($script:AutopromptConfigEditLastBackup) -and
        $script:AutopromptConfigEditLastBackup -ne 'none') {
        $allPaths += $script:AutopromptConfigEditLastBackup
    }
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' `
        (Get-IdemPathComparer)
    return @($allPaths | Where-Object {
        -not [string]::IsNullOrEmpty($_) -and $seen.Add([string]$_)
    })
}

function Get-IdemSnapshotDirectories {
    param([string]$ConfigRoot, [string[]]$Paths)
    $directories = New-Object 'System.Collections.Generic.Dictionary[string,bool]' `
        (Get-IdemPathComparer)
    foreach ($path in $Paths) {
        $directory = Split-Path -Parent $path
        while (-not [string]::IsNullOrEmpty($directory) -and
            -not (Test-IdemPathEqual -Left $directory -Right $ConfigRoot)) {
            if (-not $directories.ContainsKey($directory)) {
                $directories.Add(
                    $directory,
                    (Test-Path -LiteralPath $directory -PathType Container)
                )
            }
            $parent = Split-Path -Parent $directory
            if ($parent -ceq $directory) { break }
            $directory = $parent
        }
    }
    return $directories
}

function Write-IdemManagedRecovery {
    param([hashtable]$Snapshot, [string]$RecoveryPath)
    $temporary = "$RecoveryPath.tmp"
    try {
        $Snapshot | Export-Clixml -LiteralPath $temporary -Depth 12 `
            -ErrorAction Stop
        Move-Item -LiteralPath $temporary -Destination $RecoveryPath `
            -ErrorAction Stop
    } catch {
        Remove-Item -LiteralPath $temporary -Force `
            -ErrorAction SilentlyContinue
        return $false
    }
    return $true
}

function New-IdemManagedSnapshot {
    param([string]$ConfigRoot, [string[]]$Paths)
    $snapshotPaths = @(Get-IdemSnapshotPaths `
        -ConfigRoot $ConfigRoot -Paths $Paths)
    $files = @()
    foreach ($path in $snapshotPaths) {
        $exists = Test-Path -LiteralPath $path -PathType Leaf
        $files += @{
            Path = $path
            Exists = $exists
            Bytes = if ($exists) { [System.IO.File]::ReadAllBytes($path) } else { $null }
            LastWriteTimeUtc = if ($exists) {
                (Get-Item -LiteralPath $path).LastWriteTimeUtc
            } else {
                $null
            }
        }
    }
    $snapshot = @{
        ConfigRoot = $ConfigRoot
        ConfigRootExisted = Test-Path -LiteralPath $ConfigRoot `
            -PathType Container
        Files = $files
        Directories = Get-IdemSnapshotDirectories `
            -ConfigRoot $ConfigRoot -Paths $snapshotPaths
        ReceiptFiles = @($script:AutopromptReceiptFiles)
        ReceiptCreatedDirectories = @(
            $script:AutopromptReceiptCreatedDirectories
        )
        ReceiptEdits = @($script:AutopromptReceiptEdits)
        ReceiptOmpManaged = $script:AutopromptReceiptOmpManaged
        ReceiptOmpDetachedRoot = $script:AutopromptReceiptOmpDetachedRoot
        ConfigEditLastBackup = $script:AutopromptConfigEditLastBackup
    }
    $recoveryPath = Join-Path ([System.IO.Path]::GetTempPath()) `
        ("autoprompt-undo_" + [guid]::NewGuid().ToString('N'))
    if (-not (Write-IdemManagedRecovery -Snapshot $snapshot `
        -RecoveryPath $recoveryPath)) {
        return $null
    }
    $snapshot.RecoveryPath = $recoveryPath
    return $snapshot
}

function Set-IdemSnapshotFile {
    param([string]$Path, [bool]$Exists, [byte[]]$Bytes, [object]$LastWriteTimeUtc)
    $temporary = "$Path.autoprompt.restore.tmp"
    try {
        if (-not $Exists) {
            if (Test-Path -LiteralPath $Path -PathType Container) { return $false }
            if (Test-Path -LiteralPath $Path -PathType Leaf) {
                Remove-Item -LiteralPath $Path -Force -ErrorAction Stop
            }
            return (-not (Test-Path -LiteralPath $Path))
        }
        New-Item -ItemType Directory -Path (Split-Path -Parent $Path) -Force -ErrorAction Stop | Out-Null
        if (Test-Path -LiteralPath $Path -PathType Leaf) {
            $currentBytes = [System.IO.File]::ReadAllBytes($Path)
            $isExact = [System.Collections.StructuralComparisons]::
                StructuralEqualityComparer.Equals($currentBytes, $Bytes)
            if ($isExact) {
                $item = Get-Item -LiteralPath $Path
                if ($item.LastWriteTimeUtc -ne $LastWriteTimeUtc) {
                    $item.LastWriteTimeUtc = $LastWriteTimeUtc
                }
                return (Get-Item -LiteralPath $Path).LastWriteTimeUtc -eq
                    $LastWriteTimeUtc
            }
        }
        [System.IO.File]::WriteAllBytes($temporary, $Bytes)
        if (Test-Path -LiteralPath $Path -PathType Leaf) {
            $backup = "$Path.autoprompt.restore.bak"
            [System.IO.File]::Replace($temporary, $Path, $backup)
            if (-not (Complete-IdemReplacement -Target $Path `
                -Backup $backup -Context 'snapshot-restore' `
                -RetainReplacement)) {
                (Get-Item -LiteralPath $Path).LastWriteTimeUtc =
                    $LastWriteTimeUtc
                return $false
            }
        } else {
            [System.IO.File]::Move($temporary, $Path)
        }
        (Get-Item -LiteralPath $Path).LastWriteTimeUtc = $LastWriteTimeUtc
        return $true
    } catch {
        if ($Exists -and (Test-Path -LiteralPath $Path -PathType Leaf)) {
            try {
                (Get-Item -LiteralPath $Path).LastWriteTimeUtc = $LastWriteTimeUtc
            } catch { } # The false return already reports incomplete restoration.
        }
        return $false
    } finally {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
}

function Restore-IdemSnapshotDirectories {
    param([hashtable]$Snapshot)
    if (-not $Snapshot.ContainsKey('Directories')) { return $true }
    $restored = $true
    foreach ($directory in @($Snapshot.Directories.Keys | Where-Object {
        $Snapshot.Directories[$_]
    })) {
        if (Test-Path -LiteralPath $directory -PathType Container) { continue }
        try {
            New-Item -ItemType Directory -Path $directory -Force `
                -ErrorAction Stop | Out-Null
        } catch {
            $restored = $false
        }
    }
    [string[]]$created = @($Snapshot.Directories.Keys | Where-Object {
        -not $Snapshot.Directories[$_]
    })
    $deepestFirst = [System.Collections.Generic.Comparer[string]]::Create(
        [System.Comparison[string]]{
            param($left, $right)
            $lengthOrder = $right.Length.CompareTo($left.Length)
            if ($lengthOrder -ne 0) { return $lengthOrder }
            return [System.StringComparer]::Ordinal.Compare($left, $right)
        }
    )
    [Array]::Sort($created, $deepestFirst)
    foreach ($directory in $created) {
        if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
            continue
        }
        try {
            if (@([System.IO.Directory]::GetFileSystemEntries($directory)).Count -ne 0) {
                continue
            }
            [System.IO.Directory]::Delete($directory, $false)
        } catch {
            $restored = $false
        }
    }
    return $restored
}

function Restore-IdemAbsentConfigRoot {
    param([hashtable]$Snapshot)
    if (-not $Snapshot.ContainsKey('ConfigRootExisted') -or
        $Snapshot.ConfigRootExisted) {
        return $true
    }
    $root = $Snapshot.ConfigRoot
    $item = Get-Item -LiteralPath $root -Force -ErrorAction SilentlyContinue
    if ($null -eq $item) { return $true }
    if ($item -isnot [System.IO.DirectoryInfo] -or
        $item.Attributes.HasFlag([System.IO.FileAttributes]::ReparsePoint)) {
        return $false
    }
    try {
        if (@([System.IO.Directory]::GetFileSystemEntries($root)).Count -ne 0) {
            return $false
        }
        [System.IO.Directory]::Delete($root, $false)
    } catch {
        return $false
    }
    return -not (Test-Path -LiteralPath $root)
}

function Restore-IdemManagedSnapshot {
    param([hashtable]$Snapshot, [switch]$UseInMemorySnapshot)
    $recoveryPath = $Snapshot.RecoveryPath
    if (-not $UseInMemorySnapshot -and
        -not [string]::IsNullOrEmpty($recoveryPath) -and
        (Test-Path -LiteralPath $recoveryPath -PathType Leaf)) {
        try {
            $durableSnapshot = Import-Clixml -LiteralPath $recoveryPath `
                -ErrorAction Stop
            $durableSnapshot.RecoveryPath = $recoveryPath
            $Snapshot = $durableSnapshot
        } catch {
            [Console]::Error.WriteLine(
                "error=managed-recovery-unreadable path=$recoveryPath " +
                'action=restore-manually'
            )
            return $false
        }
    }
    $restored = $true
    foreach ($file in $Snapshot.Files) {
        $fileRestored = Set-IdemSnapshotFile -Path $file.Path `
            -Exists $file.Exists -Bytes $file.Bytes `
            -LastWriteTimeUtc $file.LastWriteTimeUtc
        if (-not $fileRestored) { $restored = $false }
    }
    if (-not (Restore-IdemSnapshotDirectories -Snapshot $Snapshot)) {
        $restored = $false
    }
    if (-not (Restore-IdemAbsentConfigRoot -Snapshot $Snapshot)) {
        $restored = $false
    }
    $script:AutopromptReceiptFiles = @($Snapshot.ReceiptFiles)
    if ($Snapshot.ContainsKey('ReceiptCreatedDirectories')) {
        $script:AutopromptReceiptCreatedDirectories = @(
            $Snapshot.ReceiptCreatedDirectories
        )
    }
    if ($Snapshot.ContainsKey('ReceiptEdits')) {
        $script:AutopromptReceiptEdits = @($Snapshot.ReceiptEdits)
    }
    if ($Snapshot.ContainsKey('ReceiptOmpManaged')) {
        $script:AutopromptReceiptOmpManaged =
            [bool]$Snapshot.ReceiptOmpManaged
    }
    if ($Snapshot.ContainsKey('ReceiptOmpDetachedRoot')) {
        $script:AutopromptReceiptOmpDetachedRoot =
            [string]$Snapshot.ReceiptOmpDetachedRoot
    }
    if ($Snapshot.ContainsKey('ConfigEditLastBackup')) {
        $script:AutopromptConfigEditLastBackup = $Snapshot.ConfigEditLastBackup
    }
    return $restored
}

if ($null -eq $script:AutopromptManagedUndoJournal) { $script:AutopromptManagedUndoJournal = @() }
if ($null -eq $script:AutopromptInMemoryRestoreToken) {
    $script:AutopromptInMemoryRestoreToken = New-Object object
}

function Add-IdemManagedUndo {
    param([hashtable]$Snapshot)
    $script:AutopromptManagedUndoJournal += $Snapshot
}

function Remove-IdemRecoveryPath {
    param([string]$Path)
    if ([string]::IsNullOrEmpty($Path) -or
        -not (Test-Path -LiteralPath $Path)) {
        return $true
    }
    try {
        Remove-Item -LiteralPath $Path -Force -ErrorAction Stop
    } catch {
        return $false
    }
    return -not (Test-Path -LiteralPath $Path)
}

function Remove-IdemManagedRecovery {
    param([hashtable]$Snapshot)
    return Remove-IdemRecoveryPath -Path $Snapshot.RecoveryPath
}

function Get-IdemRecoveryFailureList {
    param([hashtable[]]$Snapshots)
    $paths = foreach ($snapshot in $Snapshots) {
        if ($snapshot.ContainsKey('CommitRecoveryPath') -and
            -not [string]::IsNullOrEmpty($snapshot.CommitRecoveryPath)) {
            $snapshot.CommitRecoveryPath
        } else {
            $snapshot.RecoveryPath
        }
    }
    return (@($paths | Select-Object -Unique) -join ',')
}

function Get-IdemCommitRecoverySnapshot {
    param([hashtable]$Snapshot)
    if (-not $Snapshot.ContainsKey('CommitRecoveryPath') -or
        [string]::IsNullOrEmpty($Snapshot.CommitRecoveryPath) -or
        -not (Test-Path -LiteralPath $Snapshot.CommitRecoveryPath -PathType Leaf)) {
        return $null
    }
    try {
        $transaction = Import-Clixml -LiteralPath $Snapshot.CommitRecoveryPath `
            -ErrorAction Stop
        $match = @($transaction.Snapshots | Where-Object {
            $_.RecoveryPath -eq $Snapshot.RecoveryPath
        })
        if ($match.Count -ne 1) { return $null }
        $match[0].CommitRecoveryPath = $Snapshot.CommitRecoveryPath
        return $match[0]
    } catch {
        return $null
    }
}

function Remove-IdemCommitRecoveries {
    param([hashtable[]]$Pending, [hashtable[]]$Failed)
    $commitRecoveryPaths = @($Pending | ForEach-Object {
        if ($_.ContainsKey('CommitRecoveryPath')) { $_.CommitRecoveryPath }
    } | Where-Object { -not [string]::IsNullOrEmpty($_) } |
        Select-Object -Unique)
    foreach ($commitRecoveryPath in $commitRecoveryPaths) {
        $hasFailedSnapshot = @($Failed | Where-Object {
            $_.CommitRecoveryPath -eq $commitRecoveryPath
        }).Count -gt 0
        if ($hasFailedSnapshot) { continue }
        if (-not (Remove-IdemRecoveryPath -Path $commitRecoveryPath)) {
            $Failed = @($Pending | Where-Object {
                $_.CommitRecoveryPath -eq $commitRecoveryPath
            }) + @($Failed)
        }
    }
    return @($Failed | Select-Object -Unique)
}

function Undo-IdemManagedChanges {
    param([int]$FromIndex = 0)
    if ($FromIndex -ge $script:AutopromptManagedUndoJournal.Count) {
        return $true
    }
    $retained = @()
    if ($FromIndex -gt 0) {
        $retained = @($script:AutopromptManagedUndoJournal[0..($FromIndex - 1)])
    }
    $pending = @($script:AutopromptManagedUndoJournal[$FromIndex..(
        $script:AutopromptManagedUndoJournal.Count - 1
    )])
    $failed = @()
    for ($index = $pending.Count - 1; $index -ge 0; $index--) {
        $snapshot = $pending[$index]
        $restoreSnapshot = $snapshot
        $useInMemorySnapshot = $snapshot.ContainsKey('InMemoryRestoreToken') -and
            [object]::ReferenceEquals(
                $snapshot.InMemoryRestoreToken,
                $script:AutopromptInMemoryRestoreToken
            )
        if (-not $useInMemorySnapshot -and
            -not (Test-Path -LiteralPath $snapshot.RecoveryPath -PathType Leaf)) {
            $restoreSnapshot = Get-IdemCommitRecoverySnapshot -Snapshot $snapshot
        }
        $didRestore = $null -ne $restoreSnapshot -and
            (Restore-IdemManagedSnapshot -Snapshot $restoreSnapshot `
                -UseInMemorySnapshot:$useInMemorySnapshot)
        $didRemoveRecovery = $false
        if ($didRestore) {
            $didRemoveRecovery = Remove-IdemManagedRecovery -Snapshot $snapshot
        }
        if (-not $didRestore -or -not $didRemoveRecovery) {
            $failed = @($snapshot) + $failed
        }
    }
    $failed = @(Remove-IdemCommitRecoveries -Pending $pending -Failed $failed)
    $script:AutopromptManagedUndoJournal = @($retained) + @($failed)
    if ($failed.Count -gt 0) {
        [Console]::Error.WriteLine(
            'error=managed-rollback-retained recovery=' +
            (Get-IdemRecoveryFailureList -Snapshots $failed) +
            ' action=retry-operation'
        )
        return $false
    }
    return $true
}

function Complete-IdemManagedChanges {
    param([int]$FromIndex = 0)
    if ($FromIndex -ge $script:AutopromptManagedUndoJournal.Count) {
        return $true
    }
    $retained = @()
    if ($FromIndex -gt 0) {
        $retained = @($script:AutopromptManagedUndoJournal[0..($FromIndex - 1)])
    }
    $pending = @($script:AutopromptManagedUndoJournal[$FromIndex..(
        $script:AutopromptManagedUndoJournal.Count - 1
    )])
    $commitRecoveryPath = Join-Path ([System.IO.Path]::GetTempPath()) `
        ('autoprompt-commit_' + [guid]::NewGuid().ToString('N'))
    foreach ($snapshot in $pending) {
        $snapshot.CommitRecoveryPath = $commitRecoveryPath
    }
    $transaction = @{ Snapshots = @($pending) }
    if (-not (Write-IdemManagedRecovery -Snapshot $transaction `
        -RecoveryPath $commitRecoveryPath)) {
        [Console]::Error.WriteLine(
            "error=managed-commit-recovery-write-failed " +
            "recovery=$commitRecoveryPath action=rollback-now"
        )
        return $false
    }
    $failed = $false
    for ($index = $pending.Count - 1; $index -ge 0; $index--) {
        if (-not (Remove-IdemManagedRecovery -Snapshot $pending[$index])) {
            $failed = $true
        }
    }
    if (-not $failed -and
        (Remove-IdemRecoveryPath -Path $commitRecoveryPath)) {
        $script:AutopromptManagedUndoJournal = @($retained)
        return $true
    }
    $script:AutopromptManagedUndoJournal = @($retained) + @($pending)
    [Console]::Error.WriteLine(
        "error=managed-cleanup-retained recovery=$commitRecoveryPath " +
        'action=rollback-or-retry-cleanup'
    )
    return $false
}

function Restore-IdemMutationSnapshot {
    param([hashtable]$Snapshot, [string]$Context)
    if ((Restore-IdemManagedSnapshot -Snapshot $Snapshot) -and
        (Remove-IdemManagedRecovery -Snapshot $Snapshot)) {
        return $true
    }
    Add-IdemManagedUndo -Snapshot $Snapshot
    [Console]::Error.WriteLine(
        "error=managed-rollback-incomplete context=$Context " +
        "recovery=$($Snapshot.RecoveryPath) action=retry-operation"
    )
    return $false
}

function Test-IdemUnownedTargetCollision {
    param([string]$Target)
    $targetItem = Get-Item -LiteralPath $Target -Force `
        -ErrorAction SilentlyContinue
    if ($null -eq $targetItem) { return $false }
    return -not ($targetItem -is [System.IO.FileInfo]) -or
        $targetItem.Attributes.HasFlag(
            [System.IO.FileAttributes]::ReparsePoint
        ) -or
        -not (Test-IdemReceiptOwnsPath -Path $Target)
}

function Get-IdemManagedPendingMappings {
    param(
        [string]$ConfigRoot,
        [object[]]$Mappings,
        [switch]$RefuseUnownedTarget
    )
    $manifest = Join-Path $ConfigRoot $AutopromptHashManifestName
    $targets = New-Object 'System.Collections.Generic.HashSet[string]' `
        (Get-IdemPathComparer)
    $ownedPaths = New-Object 'System.Collections.Generic.HashSet[string]' `
        (Get-IdemPathComparer)
    foreach ($ownedPath in @($script:AutopromptReceiptFiles)) {
        $ownedIdentity = Get-IdemNormalizedPath -Path $ownedPath
        if (-not [string]::IsNullOrEmpty($ownedIdentity)) {
            [void]$ownedPaths.Add($ownedIdentity)
        }
    }
    $manifestHashes = New-Object `
        'System.Collections.Generic.Dictionary[string,string]' `
        (Get-IdemPathComparer)
    $manifestEntries = Read-IdemManifestEntries -ConfigRoot $ConfigRoot
    foreach ($key in $manifestEntries.Keys) {
        $keyIdentity = Get-IdemManifestKeyIdentity `
            -ConfigRoot $ConfigRoot -Key ([string]$key)
        if (-not [string]::IsNullOrEmpty($keyIdentity)) {
            $manifestHashes[$keyIdentity] = [string]$manifestEntries[$key]
        }
    }
    $manifestIdentity = Get-IdemNormalizedPath -Path $manifest
    $pending = @()
    foreach ($mapping in $Mappings) {
        $source = [string]$mapping.Source
        $target = [string]$mapping.Target
        $trackManaged = -not ($mapping.ContainsKey('TrackManaged') -and
            -not [bool]$mapping.TrackManaged)
        $allowUnowned = $mapping.ContainsKey('AllowUnownedTarget') -and
            [bool]$mapping.AllowUnownedTarget
        $identity = Get-IdemNormalizedPath -Path $target
        if ([string]::IsNullOrEmpty($source) -or
            -not (Test-Path -LiteralPath $source -PathType Leaf)) {
            return @{ Code = 39; Pending = @() }
        }
        if ([string]::IsNullOrEmpty($identity) -or
            -not (Test-AutopromptManagedInstallPathAllowed -Path $identity `
                -Root $ConfigRoot) -or
            -not $targets.Add($identity)) {
            return @{ Code = 44; Pending = @() }
        }
        if ($RefuseUnownedTarget) {
            $targetItem = Get-Item -LiteralPath $identity -Force `
                -ErrorAction SilentlyContinue
            if ($null -ne $targetItem -and (
                $targetItem -isnot [System.IO.FileInfo] -or
                $targetItem.Attributes.HasFlag(
                    [System.IO.FileAttributes]::ReparsePoint
                ) -or (-not $allowUnowned -and
                    -not $ownedPaths.Contains($identity)))) {
                return @{ Code = 43; Pending = @() }
            }
        }
        $sourceHash = Get-IdemSha256 -Path $source
        if ($sourceHash -is [int]) {
            return @{ Code = [int]$sourceHash; Pending = @() }
        }
        $isCurrent = (Test-Path -LiteralPath $identity -PathType Leaf) -and
            (Get-IdemSha256 -Path $identity) -eq $sourceHash
        if ($trackManaged) {
            $isCurrent = $isCurrent -and
                $manifestHashes.ContainsKey($identity) -and
                $manifestHashes[$identity] -eq $sourceHash -and
                $ownedPaths.Contains($identity) -and
                $ownedPaths.Contains($manifestIdentity)
        }
        if (-not $isCurrent) {
            $pending += @{
                Source = $source
                Target = $identity
                Hash = $sourceHash
                TrackManaged = $trackManaged
            }
        }
    }
    return @{ Code = 0; Pending = @($pending) }
}

function Install-IdemManagedFiles {
    param(
        [string]$ConfigRoot,
        [object[]]$Mappings,
        [switch]$RefuseUnownedTarget,
        [switch]$UseCodexBatchIndex,
        [scriptblock]$BeforeCodexCopy
    )
    if ([string]::IsNullOrEmpty((Get-IdemNormalizedPath -Path $ConfigRoot))) {
        return 44
    }
    $plan = Get-IdemManagedPendingMappings -ConfigRoot $ConfigRoot `
        -Mappings $Mappings -RefuseUnownedTarget:$RefuseUnownedTarget
    if ($plan.Code -ne 0) { return $plan.Code }
    $pending = @($plan.Pending)
    if ($pending.Count -eq 0) { return 0 }

    $snapshot = New-IdemManagedSnapshot -ConfigRoot $ConfigRoot `
        -Paths @($pending | ForEach-Object { $_.Target })
    if ($null -eq $snapshot) { return 39 }
    foreach ($mapping in $pending) {
        $copyCode = if ($UseCodexBatchIndex) {
            Copy-IdemCodexStableSource -Source $mapping.Source `
                -Target $mapping.Target `
                -ExpectedSourceHash $mapping.Hash `
                -BeforeCopy $BeforeCodexCopy
        } elseif (Copy-IdemAtomic -Source $mapping.Source `
            -Target $mapping.Target) {
            0
        } else {
            39
        }
        if ($copyCode -ne 0) {
            Restore-IdemMutationSnapshot -Snapshot $snapshot `
                -Context 'install-batch-copy' | Out-Null
            return $copyCode
        }
        $targetHash = Get-IdemSha256 -Path $mapping.Target
        if ($targetHash -is [int] -or $targetHash -cne $mapping.Hash) {
            Restore-IdemMutationSnapshot -Snapshot $snapshot `
                -Context 'install-batch-verify' | Out-Null
            if ($targetHash -is [int]) { return [int]$targetHash }
            return 39
        }
    }
    $tracked = @($pending | Where-Object { $_.TrackManaged })
    $hashes = @($tracked | ForEach-Object {
        @{ Key = $_.Target; Hash = $_.Hash }
    })
    if ($hashes.Count -gt 0 -and
        -not (Set-IdemManifestHashes -ConfigRoot $ConfigRoot -Hashes $hashes `
            -UseIdentityIndex:$UseCodexBatchIndex)) {
        Restore-IdemMutationSnapshot -Snapshot $snapshot `
            -Context 'install-batch-register' | Out-Null
        return 40
    }
    foreach ($directory in @($snapshot.Directories.Keys)) {
        if (-not $snapshot.Directories[$directory] -and
            (Test-Path -LiteralPath $directory -PathType Container) -and
            (Test-AutopromptManagedInstallPathAllowed -Path $directory `
                -Root $ConfigRoot)) {
            Add-IdemReceiptCreatedDirectory -Path $directory
        }
    }
    if ($UseCodexBatchIndex) {
        $receiptIdentities = New-Object `
            'System.Collections.Generic.HashSet[string]' (Get-IdemPathComparer)
        foreach ($ownedPath in @($script:AutopromptReceiptFiles)) {
            $ownedIdentity = Get-IdemNormalizedPath -Path $ownedPath
            if ([string]::IsNullOrEmpty($ownedIdentity)) {
                Restore-IdemMutationSnapshot -Snapshot $snapshot `
                    -Context 'install-batch-receipt-index' | Out-Null
                return 40
            }
            [void]$receiptIdentities.Add($ownedIdentity)
        }
        $receiptAdditions = @()
        foreach ($mapping in $tracked) {
            $targetIdentity = Get-IdemNormalizedPath -Path $mapping.Target
            if ([string]::IsNullOrEmpty($targetIdentity)) {
                Restore-IdemMutationSnapshot -Snapshot $snapshot `
                    -Context 'install-batch-receipt-index' | Out-Null
                return 40
            }
            if ($receiptIdentities.Add($targetIdentity)) {
                $receiptAdditions += $mapping.Target
            }
        }
        if ($tracked.Count -gt 0) {
            $manifestPath = Join-Path $ConfigRoot $AutopromptHashManifestName
            $manifestIdentity = Get-IdemNormalizedPath -Path $manifestPath
            if ([string]::IsNullOrEmpty($manifestIdentity)) {
                Restore-IdemMutationSnapshot -Snapshot $snapshot `
                    -Context 'install-batch-receipt-index' | Out-Null
                return 40
            }
            if ($receiptIdentities.Add($manifestIdentity)) {
                $receiptAdditions += $manifestPath
            }
        }
        $script:AutopromptReceiptFiles = @(
            $script:AutopromptReceiptFiles
        ) + @($receiptAdditions)
    } else {
        foreach ($mapping in $tracked) {
            Add-IdemReceiptFile -Path $mapping.Target
        }
        if ($tracked.Count -gt 0) {
            Add-IdemReceiptFile -Path (Join-Path $ConfigRoot $AutopromptHashManifestName)
        }
    }
    Add-IdemManagedUndo -Snapshot $snapshot
    return 0
}

function Install-IdemManagedFile {
    param(
        [string]$ConfigRoot,
        [string]$Source,
        [string]$Target,
        [switch]$RefuseUnownedTarget,
        [switch]$UseCodexStableSource,
        [scriptblock]$BeforeCodexCopy
    )
    if ($RefuseUnownedTarget -and
        (Test-IdemUnownedTargetCollision -Target $Target)) { return 43 }
    $sourceHash = Get-IdemSha256 -Path $Source
    if ($sourceHash -is [int]) { return $sourceHash }

    $manifest = Join-Path $ConfigRoot $AutopromptHashManifestName
    if ((Test-Path -LiteralPath $Target -PathType Leaf) -and
        (Get-IdemSha256 -Path $Target) -eq $sourceHash -and
        (Get-IdemManifestHash -ConfigRoot $ConfigRoot -Key $Target) -eq $sourceHash -and
        (Test-IdemReceiptOwnsPath -Path $Target) -and
        (Test-IdemReceiptOwnsPath -Path $manifest)) { return 0 }

    $snapshot = New-IdemManagedSnapshot -ConfigRoot $ConfigRoot -Paths @($Target)
    if ($null -eq $snapshot) { return 39 }
    $copyCode = if ($UseCodexStableSource) {
        Copy-IdemCodexStableSource -Source $Source -Target $Target `
            -ExpectedSourceHash $sourceHash -BeforeCopy $BeforeCodexCopy
    } elseif (Copy-IdemAtomic -Source $Source -Target $Target) {
        0
    } else {
        39
    }
    if ($copyCode -ne 0) {
        Restore-IdemMutationSnapshot -Snapshot $snapshot -Context 'install-copy' |
            Out-Null
        return $copyCode
    }
    foreach ($directory in @($snapshot.Directories.Keys)) {
        if (-not $snapshot.Directories[$directory] -and
            (Test-Path -LiteralPath $directory -PathType Container)) {
            Add-IdemReceiptCreatedDirectory -Path $directory
        }
    }
    $registerCode = Register-IdemManagedFile -ConfigRoot $ConfigRoot -Path $Target
    if ($registerCode -ne 0) {
        Restore-IdemMutationSnapshot -Snapshot $snapshot -Context 'install-register' |
            Out-Null
        return $registerCode
    }
    Add-IdemManagedUndo -Snapshot $snapshot
    return 0
}

function Remove-IdemManagedFile {
    param([string]$ConfigRoot, [string]$Path)
    $snapshot = New-IdemManagedSnapshot -ConfigRoot $ConfigRoot -Paths @($Path)
    if ($null -eq $snapshot) { return $false }
    try {
        if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Force -ErrorAction Stop }
        if (-not (Remove-IdemManifestHash -ConfigRoot $ConfigRoot -Key $Path)) { throw 'manifest delete failed' }
        Remove-IdemReceiptFile -Path $Path
    } catch {
        Restore-IdemMutationSnapshot -Snapshot $snapshot -Context 'remove-register' |
            Out-Null
        return $false
    }
    Add-IdemManagedUndo -Snapshot $snapshot
    return $true
}

function Copy-IdemCodexStableSource {
    param(
        [string]$Source,
        [string]$Target,
        [string]$ExpectedSourceHash,
        [scriptblock]$BeforeCopy
    )
    $parent = Split-Path -Parent $Target
    $temporary = "$Target.autoprompt.codex.tmp"
    try {
        New-Item -ItemType Directory -Path $parent -Force -ErrorAction Stop |
            Out-Null
        if ($null -ne $BeforeCopy) { & $BeforeCopy $Source $Target }
        [System.IO.File]::Copy($Source, $temporary, $true)
        $copiedHash = Get-IdemSha256 -Path $temporary
        $sourcePostHash = Get-IdemSha256 -Path $Source
        if ($copiedHash -is [int] -or $sourcePostHash -is [int] -or
            $copiedHash -cne $ExpectedSourceHash -or
            $sourcePostHash -cne $ExpectedSourceHash) {
            [Console]::Error.WriteLine(
                "client=codex error=SOURCE_CHANGED_DURING_COPY " +
                "file=$(Split-Path -Leaf $Source) expected=$ExpectedSourceHash " +
                "copied=$copiedHash source_post=$sourcePostHash"
            )
            Remove-Item -LiteralPath $temporary -Force `
                -ErrorAction SilentlyContinue
            return 46
        }
        if (Test-Path -LiteralPath $Target -PathType Leaf) {
            $backup = "$Target.autoprompt.replace.bak"
            [System.IO.File]::Replace($temporary, $Target, $backup)
            if (-not (Complete-IdemReplacement -Target $Target `
                -Backup $backup -Context 'codex-stable-source')) {
                return 39
            }
        } else {
            [System.IO.File]::Move($temporary, $Target)
        }
    } catch {
        Remove-Item -LiteralPath $temporary -Force `
            -ErrorAction SilentlyContinue
        return 39
    }
    return 0
}

function Invoke-IdemRetiredCodexReconciliation {
    param([string]$ConfigRoot, [string[]]$CurrentTargets)
    foreach ($file in @($script:AutopromptReceiptFiles)) {
        if ([string]::IsNullOrEmpty($file) -or
            -not (Test-UninstallProviderPath -Name 'codex' `
                -ConfigRoot $ConfigRoot -Path $file)) {
            continue
        }
        $isCurrent = @($CurrentTargets | Where-Object {
            Test-IdemPathEqual -Left $_ -Right $file
        }).Count -gt 0
        if ($isCurrent) { continue }

        $recordedHash = Get-IdemManifestHash -ConfigRoot $ConfigRoot -Key $file
        $item = Get-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
        $reason = ''
        if ($null -eq $item) {
            $reason = 'already-absent'
        } elseif ($item -isnot [System.IO.FileInfo] -or
            $item.Attributes.HasFlag([System.IO.FileAttributes]::ReparsePoint)) {
            $reason = 'linked-or-unsafe'
        } elseif ([string]::IsNullOrEmpty($recordedHash)) {
            $reason = 'unfingerprinted'
        } else {
            $liveHash = Get-IdemSha256 -Path $file
            if ($liveHash -is [int]) {
                $reason = 'hash-unreadable'
            } elseif ($liveHash -cne $recordedHash) {
                $reason = 'hash-drift'
            }
        }

        if ([string]::IsNullOrEmpty($reason) -or $reason -ceq 'already-absent') {
            if (-not (Remove-IdemManagedFile -ConfigRoot $ConfigRoot -Path $file)) {
                [Console]::Error.WriteLine(
                    "client=codex error=retired-file-prune-failed path=$file"
                )
                return 94
            }
            [Console]::Out.WriteLine(
                "client=codex update-pruned=$file reason=prior-only"
            )
            continue
        }

        if (-not (Remove-IdemManifestHash -ConfigRoot $ConfigRoot -Key $file)) {
            return 94
        }
        Remove-IdemReceiptFile -Path $file
        [Console]::Out.WriteLine(
            "client=codex update-retained=$file reason=$reason ownership=relinquished"
        )
    }
    return 0
}

function Test-IdemExactProperties {
    param([object]$Value, [string[]]$Expected)
    if ($null -eq $Value -or $Value -is [System.Array] -or
        $Value -is [string] -or $Value -is [System.ValueType]) { return $false }
    $actual = [string[]]@($Value.PSObject.Properties.Name)
    if ($actual.Count -ne $Expected.Count) { return $false }
    $actualSet = New-Object 'System.Collections.Generic.HashSet[string]' `
        ([System.StringComparer]::Ordinal)
    foreach ($name in $actual) { $actualSet.Add($name) | Out-Null }
    foreach ($name in $Expected) {
        if (-not $actualSet.Contains($name)) { return $false }
    }
    return $true
}

function Test-OpencodeProfilePolicy {
    param([string]$Path)
    try { $profile = [System.IO.File]::ReadAllText($Path) | ConvertFrom-Json }
    catch { return $false }
    if (-not (Test-IdemExactProperties -Value $profile `
        -Expected @('$schema', 'subagent_depth', 'share', 'permission'))) {
        return $false
    }
    if ($profile.'$schema' -isnot [string] -or
        $profile.'$schema' -cne 'https://opencode.ai/config.json') { return $false }
    if ($profile.subagent_depth -isnot [int] -or $profile.subagent_depth -ne 4) { return $false }
    if ($profile.share -isnot [string] -or $profile.share -cne 'disabled') { return $false }
    if (-not (Test-IdemExactProperties -Value $profile.permission -Expected @('task'))) {
        return $false
    }
    $task = $profile.permission.task
    if (-not (Test-IdemExactProperties -Value $task -Expected @('*', 'ap-*'))) { return $false }
    if ($task.'*' -isnot [string] -or $task.'ap-*' -isnot [string]) { return $false }
    return $task.'*' -ceq 'deny' -and $task.'ap-*' -ceq 'allow'
}

function Write-OpencodeProfilePolicy {
    param([string]$Path)
    $policy = [string]::Join([char]10, @(
        '{',
        '  "$schema": "https://opencode.ai/config.json",',
        '  "subagent_depth": 4,',
        '  "share": "disabled",',
        '  "permission": {',
        '    "task": {',
        '      "*": "deny",',
        '      "ap-*": "allow"',
        '    }',
        '  }',
        '}'
    )) + [char]10
    try {
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($Path, $policy, $utf8NoBom)
    } catch {
        [Console]::Error.WriteLine("error=opencode-profile-write-failed path=$Path")
        return $false
    }
    return $true
}

function Test-KiloProfilePolicy {
    param([string]$Path)
    try { $profile = [System.IO.File]::ReadAllText($Path) | ConvertFrom-Json }
    catch { return $false }
    if (-not (Test-IdemExactProperties -Value $profile `
        -Expected @('$schema', 'subagent_depth', 'share', 'permission'))) {
        return $false
    }
    if ($profile.'$schema' -isnot [string] -or
        $profile.'$schema' -cne 'https://app.kilo.ai/config.json') { return $false }
    if ($profile.subagent_depth -isnot [int] -or $profile.subagent_depth -ne 4) { return $false }
    if ($profile.share -isnot [string] -or $profile.share -cne 'disabled') { return $false }
    if (-not (Test-IdemExactProperties -Value $profile.permission -Expected @('task'))) {
        return $false
    }
    $task = $profile.permission.task
    if (-not (Test-IdemExactProperties -Value $task -Expected @('*', 'ap-*'))) { return $false }
    if ($task.'*' -isnot [string] -or $task.'ap-*' -isnot [string]) { return $false }
    return $task.'*' -ceq 'deny' -and $task.'ap-*' -ceq 'allow'
}

function Write-KiloProfilePolicy {
    param([string]$Path)
    $policy = [string]::Join([char]10, @(
        '{',
        '  "$schema": "https://app.kilo.ai/config.json",',
        '  "subagent_depth": 4,',
        '  "share": "disabled",',
        '  "permission": {',
        '    "task": {',
        '      "*": "deny",',
        '      "ap-*": "allow"',
        '    }',
        '  }',
        '}'
    )) + [char]10
    try {
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($Path, $policy, $utf8NoBom)
    } catch {
        [Console]::Error.WriteLine("error=kilo-profile-write-failed path=$Path")
        return $false
    }
    return $true
}

function Get-OpencodeAgentFiles {
    param([string]$SourceDir)
    if (-not (Test-Path -LiteralPath $SourceDir -PathType Container)) { return @() }
    $paths = [string[]]@(Get-ChildItem -LiteralPath $SourceDir -Filter 'ap-*.md' -File | ForEach-Object FullName)
    [Array]::Sort($paths, [System.StringComparer]::Ordinal)
    return @($paths | ForEach-Object { Get-Item -LiteralPath $_ })
}

function Test-OpencodeAgentPayload {
    param([string]$SourceDir)
    $count = @(Get-OpencodeAgentFiles -SourceDir $SourceDir).Count
    if ($count -ne 25) {
        [Console]::Error.WriteLine("client=opencode error=required-agent-payload-invalid count=$count expected=25 dir=$SourceDir")
        return 95
    }
    return 0
}

function Test-KiloAgentPayload {
    param([string]$SourceDir)
    if (@(Get-OpencodeAgentFiles -SourceDir $SourceDir).Count -eq 0) {
        [Console]::Error.WriteLine("client=kilo error=required-agent-payload-empty dir=$SourceDir")
        return 95
    }
    return 0
}

function Get-IdemInstallState {
    param([string]$ConfigRoot, [string]$Landed)
    $recordedHash = Get-IdemManifestHash -ConfigRoot $ConfigRoot -Key $Landed
    $receiptPresent = Test-Path -LiteralPath `
        (Join-Path $ConfigRoot $AutopromptReceiptName) -PathType Leaf
    $fileExists = Test-Path -LiteralPath $Landed -PathType Leaf
    $liveHash = ''
    if ($fileExists) {
        $liveHash = Get-IdemSha256 -Path $Landed
        if ($liveHash -is [int]) { return @{ Code = $liveHash } }
    }
    $outcome = 'repair'
    $reason = ''
    if (-not $fileExists) {
        $reason = 'missing-file'
    } elseif ($receiptPresent -and $recordedHash -ne '' -and
        $liveHash -eq $recordedHash) {
        $outcome = 'update'
    } elseif ($recordedHash -ne '' -and $liveHash -eq $recordedHash) {
        $reason = 'missing-receipt'
    } elseif ($recordedHash -eq '') {
        $reason = 'no-fingerprint'
    } else {
        $reason = 'hash-drift'
    }
    return @{ Code = 0; FileExists = $fileExists; LiveHash = $liveHash
        RecordedHash = $recordedHash; Outcome = $outcome; Reason = $reason }
}

function Write-IdemInstallRecord {
    param([string]$Name, [string]$Landed, [string]$ExpectedHash,
        [hashtable]$State)
    if ($State.FileExists -and $State.LiveHash -eq $ExpectedHash) {
        [Console]::Out.WriteLine("already-installed v$ExpectedHash")
        return
    }
    if ($State.Outcome -eq 'update') {
        [Console]::Out.WriteLine(
            "client=$Name idem=update dest=$Landed " +
            "oldhash=$($State.RecordedHash) newhash=$ExpectedHash"
        )
        return
    }
    [Console]::Out.WriteLine(
        "client=$Name idem=repair dest=$Landed " +
        "reason=$($State.Reason) hash=$ExpectedHash"
    )
}

function Install-Idempotent {
    param(
        [string]$ConfigRoot,
        [string]$Name,
        [string]$SkillName,
        [string]$Description,
        [string]$Body,
        [string]$Variant = ''
    )
    if ([string]::IsNullOrEmpty($ConfigRoot)) {
        [Console]::Error.WriteLine("error=idem-no-config-root")
        return 41
    }
    $resolve = Get-PrecheckUpstream -Call {
        Resolve-Destination -Name $Name -Variant $Variant
    }
    if ($resolve.Code -ne 0) { return $resolve.Code }
    $destination = Get-CopyDestination -Record $resolve.Record
    if (Test-IdemUnownedTargetCollision -Target $destination.Landed) {
        [Console]::Error.WriteLine(
            "client=$Name error=unowned-skill-refused " +
            "dest=$($destination.Landed)"
        )
        return 43
    }
    $render = Get-CopyRender -Call {
        Format-Skill -Format $destination.Format -Name $SkillName `
            -Description $Description -Body $Body
    }
    if ($render.Code -ne 0) { return $render.Code }
    $stage = Join-Path ([System.IO.Path]::GetTempPath()) `
        ("clidem_" + [guid]::NewGuid().ToString('N'))
    try {
        $encoding = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($stage, $render.Rendered, $encoding)
        $expectedHash = Get-IdemSha256 -Path $stage
        if ($expectedHash -is [int]) { return $expectedHash }
        $state = Get-IdemInstallState -ConfigRoot $ConfigRoot `
            -Landed $destination.Landed
        if ($state.Code -ne 0) { return $state.Code }
        $managedCode = Install-IdemManagedFile -ConfigRoot $ConfigRoot `
            -Source $stage -Target $destination.Landed -RefuseUnownedTarget
        if ($managedCode -ne 0) { return $managedCode }
        Write-IdemInstallRecord -Name $Name -Landed $destination.Landed `
            -ExpectedHash $expectedHash -State $state
        return 0
    } catch {
        [Console]::Error.WriteLine("client=$Name error=idem-stage-failed path=$stage")
        return 39
    } finally {
        Remove-Item -LiteralPath $stage -Force -ErrorAction SilentlyContinue
    }
}
# --- F-LIB-IDEM (end) ---

# --- F-LIB-CONFIGEDIT (begin) ---
# Edit-CodexAgentsConfig is the behavior-faithful twin of configedit_codex_agents
# in install-lib.sh: the SURGICAL Codex [agents] config bump into a config.toml the
# installer does NOT own. It sets/raises max_depth + max_threads to 10 across the
# four mandated cases - keys-absent-under-existing-[agents] (ADD), present-and-lower
# (RAISE), present-and-higher (LEAVE, never lower), and [agents]-absent (CREATE) -
# preserving every other key/section/comment/formatting byte-for-byte except the
# minimal target bytes. Before any write it makes a WHOLE-FILE backup (the revert
# source) and records, per CHANGED key, the prior value (or $null when absent) via
# the EXISTING Write-Receipt accumulator - it does NOT reimplement receipt logic. A
# re-run is a strict NO-OP. The edit is hand-rolled string/line work, NOT a TOML
# library (tomllib has no writer; a full re-emit would reorder/destroy siblings).
#
# Signature: Edit-CodexAgentsConfig -ConfigFile <path> [-TargetDepth 10] [-TargetThreads 10]
#
# Channel discipline (mirrors the lib): RECORD via [Console]::Out.WriteLine, errors
# via [Console]::Error.WriteLine, scalar `return` int as the VERDICT and the ONLY
# value on the return pipeline. RECORD grammar + return-code band (0, 50-54) are
# IDENTICAL to the .sh port (F-OP-DUALPARITY). The file's detected newline (CRLF vs
# LF) + BOM are preserved: untouched lines are emitted verbatim, new/inserted lines
# use the detected dominant newline so a CRLF file stays CRLF.
$AutopromptConfigEditAgentsDepth = 10
$AutopromptConfigEditAgentsThreads = 10
$AutopromptConfigEditBackupSuffix = '.autoprompt.bak'

# The whole-file backup path of the LAST applied edit (the .sh analog is
# AUTOPROMPT_CONFIGEDIT_LAST_BACKUP). The orchestrator passes this to
# Write-Receipt -Backup; 'none' when no backup was made.
$script:AutopromptConfigEditLastBackup = 'none'

# Init the EDITS accumulator once (the .sh analog is the AUTOPROMPT_RECEIPT_EDITS
# module array). $script: binds to the caller's scope when dot-sourced, shared with
# a later Write-Receipt -Edits $script:AutopromptReceiptEdits from the orchestrator.
if ($null -eq $script:AutopromptReceiptEdits) { $script:AutopromptReceiptEdits = @() }

# Get-ConfigEditFirstInt: an exact non-negative integer token, or $null when the
# complete value is not an integer (caller treats $null as "needs raise").
function Get-ConfigEditFirstInt {
    param([string]$Token)
    $match = [regex]::Match($Token, '^\s*([0-9]+)(?:\s+#.*)?\s*$')
    if (-not $match.Success) { return $null }
    try {
        return [int]::Parse(
            $match.Groups[1].Value,
            [Globalization.CultureInfo]::InvariantCulture
        )
    } catch {
        return $null
    }
}

function Get-CodexConfigInputCode {
    param([string]$ConfigFile)
    if ([string]::IsNullOrEmpty($ConfigFile)) {
        [Console]::Error.WriteLine('error=no-config-file-arg')
        return 50
    }
    if ((Test-Path -LiteralPath $ConfigFile) -and
        -not (Test-Path -LiteralPath $ConfigFile -PathType Leaf)) {
        [Console]::Error.WriteLine(
            "error=config-file-unreadable path=$ConfigFile"
        )
        return 51
    }
    return 0
}

function Get-CodexConfigTextState {
    param([string]$RawText)
    $usesCrlf = $RawText.Contains("`r`n")
    $newline = if ($usesCrlf) { "`r`n" } else { "`n" }
    $body = $RawText
    $trailingNewlines = 0
    while ($body.EndsWith("`n")) {
        $body = $body.Substring(0, $body.Length - 1)
        if ($usesCrlf -and $body.EndsWith("`r")) {
            $body = $body.Substring(0, $body.Length - 1)
        }
        $trailingNewlines++
    }
    $lines = [string[]]@()
    if ($body.Length -gt 0) {
        $lines = [string[]]@($body -split "`r`n|`n")
    }
    return @{ Newline = $newline; TrailingNewlines = $trailingNewlines
        Lines = $lines }
}

function Read-CodexConfigDocument {
    param([string]$ConfigFile)
    $fileExists = Test-Path -LiteralPath $ConfigFile -PathType Leaf
    $rawText = ''
    $bom = ''
    if ($fileExists) {
        try {
            $bytes = [System.IO.File]::ReadAllBytes($ConfigFile)
        } catch {
            return @{ Code = 51 }
        }
        $hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and
            $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
        if ($hasBom) {
            $bom = [char]0xFEFF
            $rawText = [Text.Encoding]::UTF8.GetString(
                $bytes, 3, $bytes.Length - 3
            )
        } else {
            $rawText = [Text.Encoding]::UTF8.GetString($bytes)
        }
    }
    $text = Get-CodexConfigTextState -RawText $rawText
    return @{ Code = 0; FileExists = $fileExists; Bom = $bom
        Newline = $text.Newline; TrailingNewlines = $text.TrailingNewlines
        Lines = [string[]]@($text.Lines) }
}

function Get-CodexTomlLine {
    param([string]$Line)
    $stripped = $Line.Trim()
    if ($stripped -eq '' -or $stripped.StartsWith('#')) {
        return @{ Kind = 'Ignored' }
    }
    if ($stripped -match '^\[\[(.*)\]\]$') {
        return @{ Kind = 'ArrayTable'; Name = $matches[1].Trim() }
    }
    if ($stripped -match '^\[([^\]]*)\]$') {
        return @{ Kind = 'Table'; Name = $matches[1].Trim() }
    }
    if (-not $stripped.Contains('=')) {
        return @{ Kind = 'Ignored' }
    }
    $equalsIndex = $stripped.IndexOf('=')
    return @{ Kind = 'Key'
        Key = $stripped.Substring(0, $equalsIndex).Trim()
        Value = $stripped.Substring($equalsIndex + 1).Trim()
        Indent = [regex]::Match($Line, '^[ \t]*').Value }
}

function Get-CodexAgentsStructure {
    param([string]$ConfigFile, [string[]]$Lines)
    $state = @{ Code = 0; CurrentTable = ''; HasAgents = $false
        AgentsInsertAfterIndex = -1; DepthIndex = -1; ThreadsIndex = -1
        DepthPrior = ''; ThreadsPrior = ''; DepthIndent = ''
        ThreadsIndent = '' }
    for ($index = 0; $index -lt $Lines.Count; $index++) {
        $line = Get-CodexTomlLine -Line $Lines[$index]
        if ($line.Kind -eq 'ArrayTable') {
            if ($line.Name -eq 'agents') {
                $state.Code = 52; $state.Detail = 'array-of-tables'; break
            }
            $state.CurrentTable = $line.Name
        } elseif ($line.Kind -eq 'Table') {
            if ($line.Name -eq 'agents' -and $state.HasAgents) {
                $state.Code = 52; $state.Detail = 'duplicate-header'; break
            }
            if ($line.Name -eq 'agents') {
                $state.HasAgents = $true
                $state.AgentsInsertAfterIndex = $index
            }
            $state.CurrentTable = $line.Name
        } elseif ($line.Kind -eq 'Key') {
            $isTopLevelAgents = $state.CurrentTable -eq '' -and
                ($line.Key -eq 'agents' -or $line.Key.StartsWith('agents.'))
            if ($isTopLevelAgents) {
                $state.Code = 52; $state.Detail = 'top-level-agents-key'; break
            }
            if ($state.CurrentTable -ne 'agents') { continue }
            $state.AgentsInsertAfterIndex = $index
            if ($line.Key -eq 'max_depth') {
                $state.DepthIndex = $index; $state.DepthPrior = $line.Value
                $state.DepthIndent = $line.Indent
            }
            if ($line.Key -eq 'max_threads') {
                $state.ThreadsIndex = $index; $state.ThreadsPrior = $line.Value
                $state.ThreadsIndent = $line.Indent
            }
        }
    }
    if ($state.Code -ne 0) {
        [Console]::Error.WriteLine(
            "error=malformed-toml-cannot-locate-agents-safely " +
            "path=$ConfigFile detail=$($state.Detail)"
        )
    }
    return $state
}

function New-CodexConfigKeyPlan {
    param([int]$Index, [string]$Prior, [string]$Indent, [int]$Target)
    if ($Index -lt 0) {
        return @{ Index = $Index; Prior = $null; Old = 'absent'
            Indent = $Indent; ShouldChange = $true }
    }
    $integer = Get-ConfigEditFirstInt -Token $Prior
    $old = if ($null -ne $integer) { "$integer" } else { $Prior }
    return @{ Index = $Index; Prior = $old; Old = $old; Indent = $Indent
        ShouldChange = $null -eq $integer -or $integer -lt $Target }
}

function New-CodexAgentsEditPlan {
    param([hashtable]$Structure, [int]$TargetDepth, [int]$TargetThreads)
    $depth = New-CodexConfigKeyPlan -Index $Structure.DepthIndex `
        -Prior $Structure.DepthPrior -Indent $Structure.DepthIndent `
        -Target $TargetDepth
    $threads = New-CodexConfigKeyPlan -Index $Structure.ThreadsIndex `
        -Prior $Structure.ThreadsPrior -Indent $Structure.ThreadsIndent `
        -Target $TargetThreads
    $tableState = if ($Structure.HasAgents) { 'existing' } else { 'absent' }
    return @{ Depth = $depth; Threads = $threads; TableState = $tableState }
}

function Get-CodexExistingAgentLines {
    param([string[]]$Lines, [hashtable]$Structure, [hashtable]$Plan,
        [int]$TargetDepth, [int]$TargetThreads)
    $output = @()
    for ($index = 0; $index -lt $Lines.Count; $index++) {
        if ($index -eq $Plan.Depth.Index -and $Plan.Depth.ShouldChange) {
            $output += "$($Plan.Depth.Indent)max_depth = $TargetDepth"
        } elseif ($index -eq $Plan.Threads.Index -and
            $Plan.Threads.ShouldChange) {
            $output += "$($Plan.Threads.Indent)max_threads = $TargetThreads"
        } else {
            $output += $Lines[$index]
        }
        if ($index -ne $Structure.AgentsInsertAfterIndex) { continue }
        if ($Plan.Depth.Index -lt 0 -and $Plan.Depth.ShouldChange) {
            $output += "max_depth = $TargetDepth"
        }
        if ($Plan.Threads.Index -lt 0 -and $Plan.Threads.ShouldChange) {
            $output += "max_threads = $TargetThreads"
        }
    }
    return [string[]]$output
}

function Get-CodexCreatedAgentLines {
    param([string[]]$Lines, [int]$TargetDepth, [int]$TargetThreads)
    $output = @($Lines)
    if ($Lines.Count -gt 0 -and $Lines[$Lines.Count - 1] -ne '') {
        $output += ''
    }
    $output += @(
        '[agents]', "max_depth = $TargetDepth", "max_threads = $TargetThreads"
    )
    return [string[]]$output
}

function New-CodexEditedDocument {
    param([hashtable]$Document, [hashtable]$Structure, [hashtable]$Plan,
        [int]$TargetDepth, [int]$TargetThreads)
    if ($Structure.HasAgents) {
        $lines = @(Get-CodexExistingAgentLines -Lines $Document.Lines `
            -Structure $Structure -Plan $Plan -TargetDepth $TargetDepth `
            -TargetThreads $TargetThreads)
        $tableState = if ($Structure.DepthIndex -ge 0 -and
            $Structure.ThreadsIndex -ge 0) { 'existing' } else { 'added-to' }
    } else {
        $lines = @(Get-CodexCreatedAgentLines -Lines $Document.Lines `
            -TargetDepth $TargetDepth -TargetThreads $TargetThreads)
        $tableState = 'created'
    }
    return @{ Lines = [string[]]$lines; TableState = $tableState }
}

function ConvertTo-CodexConfigContent {
    param([hashtable]$Document, [string[]]$Lines)
    $content = [string]$Document.Bom + ($Lines -join $Document.Newline)
    $trailingNewlines = if ($Document.FileExists) {
        $Document.TrailingNewlines
    } else {
        1
    }
    for ($index = 0; $index -lt $trailingNewlines; $index++) {
        $content += $Document.Newline
    }
    return $content
}

function New-CodexConfigBackup {
    param([string]$ConfigFile, [hashtable]$Document)
    if (-not $Document.FileExists -or
        (Get-Item -LiteralPath $ConfigFile).Length -eq 0) {
        return @{ Code = 0; Path = 'none' }
    }
    $backup = "$ConfigFile$AutopromptConfigEditBackupSuffix"
    try {
        [IO.File]::Copy($ConfigFile, $backup, $true)
    } catch {
        [Console]::Error.WriteLine("error=backup-write-failed path=$backup")
        return @{ Code = 53; Path = 'none' }
    }
    return @{ Code = 0; Path = $backup }
}

function Set-CodexConfigContent {
    param([string]$ConfigFile, [string]$Content)
    $temporary = "$ConfigFile.tmp"
    $encoding = New-Object Text.UTF8Encoding($false)
    try {
        [IO.File]::WriteAllText($temporary, $Content, $encoding)
        if (Test-Path -LiteralPath $ConfigFile -PathType Leaf) {
            Remove-Item -LiteralPath $ConfigFile -Force -ErrorAction Stop
        }
        [IO.File]::Move($temporary, $ConfigFile)
    } catch {
        if (Test-Path -LiteralPath $temporary -PathType Leaf) {
            Remove-Item -LiteralPath $temporary -Force `
                -ErrorAction SilentlyContinue
        }
        return $false
    }
    return $true
}

function Save-CodexConfigEdit {
    param([string]$ConfigFile, [hashtable]$Document, [string]$Content)
    $backup = New-CodexConfigBackup -ConfigFile $ConfigFile `
        -Document $Document
    if ($backup.Code -ne 0) { return $backup }
    if (-not (Set-CodexConfigContent -ConfigFile $ConfigFile `
        -Content $Content)) {
        [Console]::Error.WriteLine("error=edit-write-failed path=$ConfigFile")
        return @{ Code = 54; Path = $backup.Path }
    }
    return $backup
}

function Add-CodexConfigReceiptEdits {
    param([string]$ConfigFile, [hashtable]$Plan,
        [int]$TargetDepth, [int]$TargetThreads)
    if ($Plan.Depth.ShouldChange) {
        $script:AutopromptReceiptEdits += @{
            File = $ConfigFile; Key = 'agents.max_depth'; Value = "$TargetDepth"
            PriorValue = $Plan.Depth.Prior
        }
    }
    if ($Plan.Threads.ShouldChange) {
        $script:AutopromptReceiptEdits += @{
            File = $ConfigFile; Key = 'agents.max_threads'
            Value = "$TargetThreads"; PriorValue = $Plan.Threads.Prior
        }
    }
}

function Write-CodexConfigEditRecord {
    param([string]$ConfigFile, [hashtable]$Plan, [string]$TableState,
        [string]$Backup, [int]$TargetDepth, [int]$TargetThreads)
    $depth = if ($Plan.Depth.ShouldChange) {
        "$($Plan.Depth.Old)->$TargetDepth"
    } else { 'kept' }
    $threads = if ($Plan.Threads.ShouldChange) {
        "$($Plan.Threads.Old)->$TargetThreads"
    } else { 'kept' }
    [Console]::Out.WriteLine(
        "file=$ConfigFile configedit=applied depth=$depth threads=$threads " +
        "table=$TableState backup=$Backup"
    )
}

function Edit-CodexAgentsConfig {
    param([string]$ConfigFile, [int]$TargetDepth = 10,
        [int]$TargetThreads = 10)
    $inputCode = Get-CodexConfigInputCode -ConfigFile $ConfigFile
    if ($inputCode -ne 0) { return $inputCode }
    $document = Read-CodexConfigDocument -ConfigFile $ConfigFile
    if ($document.Code -ne 0) {
        [Console]::Error.WriteLine(
            "error=config-file-unreadable path=$ConfigFile"
        )
        return $document.Code
    }
    $structure = Get-CodexAgentsStructure -ConfigFile $ConfigFile `
        -Lines $document.Lines
    if ($structure.Code -ne 0) { return $structure.Code }
    $plan = New-CodexAgentsEditPlan -Structure $structure `
        -TargetDepth $TargetDepth -TargetThreads $TargetThreads
    if (-not $plan.Depth.ShouldChange -and
        -not $plan.Threads.ShouldChange) {
        [Console]::Out.WriteLine(
            "file=$ConfigFile configedit=noop depth=kept threads=kept " +
            "table=$($plan.TableState) backup=none"
        )
        return 0
    }
    $edited = New-CodexEditedDocument -Document $document `
        -Structure $structure -Plan $plan -TargetDepth $TargetDepth `
        -TargetThreads $TargetThreads
    $content = ConvertTo-CodexConfigContent -Document $document `
        -Lines $edited.Lines
    $save = Save-CodexConfigEdit -ConfigFile $ConfigFile `
        -Document $document -Content $content
    if ($save.Code -ne 0) { return $save.Code }
    Add-CodexConfigReceiptEdits -ConfigFile $ConfigFile -Plan $plan `
        -TargetDepth $TargetDepth -TargetThreads $TargetThreads
    $script:AutopromptConfigEditLastBackup = $save.Path
    Write-CodexConfigEditRecord -ConfigFile $ConfigFile -Plan $plan `
        -TableState $edited.TableState -Backup $save.Path `
        -TargetDepth $TargetDepth -TargetThreads $TargetThreads
    return 0
}
# --- F-LIB-CONFIGEDIT (end) ---

# --- F-LIB-VERIFY (begin) ---
# Verify-Install - behavior-faithful twin of the .sh verify_install. PASSES only
# when the resolved load-path file (1) EXISTS, (2) PARSES in the native format,
# AND (3) sits AT the load path. Any miss returns a DISTINCT named reason emitted
# by THIS function: absent(60) / unparseable(61) / wrong-path(62), plus
# parser-unavailable(65) and delegated 2/3 from resolve. For the md-codex format
# it additionally fails codex-description-too-long(63) when the landed description
# exceeds Codex's 1024-char cap (Codex silently DROPS such a skill).
# Path math + a single resolved-parent-dir listing + a REAL python parser only -
# never a filesystem search/guess, no Detect-Client, no re-render.
#
# Channel discipline (mirrors the rest of the port): the PASS RECORD goes to
# [Console]::Out.WriteLine, every FAIL record to [Console]::Error.WriteLine
# (stdout stays empty on FAIL), and the scalar int `return` is the ONLY value on
# the return pipeline. Return-code band 60-69 is VERIFY-OWNED. Byte/behavior
# parity with the .sh port (F-OP-DUALPARITY).

# Resolve a REAL python.exe that can import yaml + tomllib, returned as a single
# exe-path string (or $null when none works). $script:AutopromptVerifyPython is an
# explicit test/operator override. Otherwise probe a real PATH application before
# the standard CPython install locations. The import probe rejects Windows app
# aliases and incomplete environments. One scalar return shape avoids array unwrap.
function Resolve-VerifyPython {
    $probeArgs = @('-c', 'import yaml,tomllib;print(1)')
    if ($script:AutopromptVerifyPython) {
        $exe = $script:AutopromptVerifyPython
        if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { return $null }
        if (Test-VerifyPythonExe -Exe $exe -ProbeArgs $probeArgs) { return $exe }
        return $null
    }
    $pathCommand = Get-Command -Name 'python.exe' -CommandType Application `
        -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $pathCommand) {
        $exe = $pathCommand.Source
        if ((Test-Path -LiteralPath $exe -PathType Leaf) -and
            (Test-VerifyPythonExe -Exe $exe -ProbeArgs $probeArgs)) {
            return $exe
        }
    }
    foreach ($base in @($env:LOCALAPPDATA, "$env:ProgramFiles", "${env:ProgramFiles(x86)}")) {
        if (-not $base) { continue }
        $pythonRoot = Join-Path $base 'Programs\Python'
        $installations = Get-ChildItem -LiteralPath $pythonRoot -Directory `
            -ErrorAction SilentlyContinue
        foreach ($installation in @($installations)) {
            $exe = Join-Path $installation.FullName 'python.exe'
            if ((Test-Path -LiteralPath $exe -PathType Leaf) -and
                (Test-VerifyPythonExe -Exe $exe -ProbeArgs $probeArgs)) {
                return $exe
            }
        }
    }
    return $null
}

# True iff <exe> runs and prints exactly '1' for the import probe (both parsers
# importable). Isolated so the single call operator is exercised by one test.
function Test-VerifyPythonExe {
    param([string]$Exe, [string[]]$ProbeArgs)
    try {
        $probe = & $Exe @ProbeArgs 2>$null
        return ($LASTEXITCODE -eq 0 -and "$probe" -eq '1')
    } catch { return $false }
}

# Invoke-VerifyParser <python-script> <file> [extra-arg]: run the resolved python
# with the parse script. Returns 0 (exit 0), 61 (non-zero exit), or 65 (no parser
# tool). The SINGLE place the parser is shelled - both format arms route through it.
function Invoke-VerifyParser {
    param([string]$PyScript, [string]$File, [string]$ExtraArg = $null)
    $exe = Resolve-VerifyPython
    if ($null -eq $exe) { return 65 }
    $cmdArgs = @('-c', $PyScript, $File)
    if ($null -ne $ExtraArg) { $cmdArgs += $ExtraArg }
    try {
        & $exe @cmdArgs 2>$null | Out-Null
    } catch {
        return 61
    }
    if ($LASTEXITCODE -eq 0) { return 0 }
    return 61
}

# Test-VerifyYamlFrontmatter <file> <required-key>: split the leading ---...---
# frontmatter and run it through the REAL python+yaml. Returns 0 (mapping carrying
# the key) / 61 (parse error / not a mapping / key absent) / 65 (no parser tool).
function Test-VerifyYamlFrontmatter {
    param([string]$File, [string]$RequiredKey)
    $py = "import sys,yaml`nt=open(sys.argv[1],encoding='utf-8').read()`np=t.split('---')`nif len(p)<3: sys.exit(1)`nfm=yaml.safe_load(p[1])`nif not isinstance(fm,dict) or sys.argv[2] not in fm: sys.exit(1)`nsys.exit(0)"
    return (Invoke-VerifyParser -PyScript $py -File $File -ExtraArg $RequiredKey)
}

# Test-VerifyToml <file>: parse via REAL python+tomllib; require a `prompt` key.
# Returns 0 / 61 / 65 with the same discipline.
function Test-VerifyToml {
    param([string]$File)
    $py = "import sys,tomllib`nd=tomllib.load(open(sys.argv[1],'rb'))`nif 'prompt' not in d: sys.exit(1)`nsys.exit(0)"
    return (Invoke-VerifyParser -PyScript $py -File $File)
}

# Test-VerifyRoomodes <file>: parse the WHOLE file via REAL python+yaml; require a
# customModes list carrying the autoprompt mode (slug=autoprompt) with a
# non-empty customInstructions. Returns 0 / 61 / 65, same discipline.
function Test-VerifyRoomodes {
    param([string]$File)
    $py = "import sys,yaml`nd=yaml.safe_load(open(sys.argv[1],encoding='utf-8').read())`nif not isinstance(d,dict): sys.exit(1)`nm=d.get('customModes')`nif not isinstance(m,list): sys.exit(1)`nmode=next((x for x in m if isinstance(x,dict) and x.get('slug')=='autoprompt'),None)`nif mode is None or not mode.get('customInstructions'): sys.exit(1)`nsys.exit(0)"
    return (Invoke-VerifyParser -PyScript $py -File $File)
}

# Test-VerifyGooseRecipe <file>: parse the WHOLE file via REAL python+yaml; require
# a mapping with a non-empty `instructions` OR `prompt` (Goose's
# validate_prompt_or_instructions). Returns 0 / 61 / 65, same discipline.
function Test-VerifyGooseRecipe {
    param([string]$File)
    $py = "import sys,yaml`nd=yaml.safe_load(open(sys.argv[1],encoding='utf-8').read())`nif not isinstance(d,dict): sys.exit(1)`nif not (d.get('instructions') or d.get('prompt')): sys.exit(1)`nsys.exit(0)"
    return (Invoke-VerifyParser -PyScript $py -File $File)
}

# Codex hard-caps the frontmatter description at 1024 chars and SILENTLY DROPS a
# skill whose description exceeds it (proven live: "invalid description: exceeds
# maximum length of 1024 characters"). md-codex verify must fail loud (63) on an
# over-long description rather than PASS a file Codex will never honor.
$script:AutopromptCodexDescriptionMax = 1024

# Get-CodexDescriptionLength <file>: return the CHARACTER length of the landed
# md-codex frontmatter `description` (the value Codex measures) as an int, or -65
# (no python+yaml) / -61 (no parseable description). Parses the YAML so an
# escaped/quoted scalar is counted exactly as Codex sees it. Mirrors the .sh
# _verify_codex_description_len helper (F-OP-DUALPARITY).
function Get-CodexDescriptionLength {
    param([string]$File)
    $exe = Resolve-VerifyPython
    if ($null -eq $exe) { return -65 }
    $py = "import sys,yaml`nt=open(sys.argv[1],encoding='utf-8').read()`np=t.split('---')`nif len(p)<3: sys.exit(1)`nfm=yaml.safe_load(p[1])`nif not isinstance(fm,dict) or 'description' not in fm: sys.exit(1)`nprint(len(str(fm['description'])))`nsys.exit(0)"
    try {
        $out = & $exe @('-c', $py, $File) 2>$null
    } catch {
        return -61
    }
    if ($LASTEXITCODE -ne 0) { return -61 }
    $text = "$out".Trim()
    if (-not ($text -match '^\d+$')) { return -61 }
    return [int]$text
}

function Get-VerifyParseCode {
    param([string]$Format, [string]$Landed)
    if ($Format -eq 'mdc') {
        return Test-VerifyYamlFrontmatter -File $Landed `
            -RequiredKey 'description'
    }
    if ($Format -eq 'gemini-toml') {
        return Test-VerifyToml -File $Landed
    }
    if ($Format -eq 'roomodes') {
        return Test-VerifyRoomodes -File $Landed
    }
    if ($Format -eq 'goose-recipe') {
        return Test-VerifyGooseRecipe -File $Landed
    }
    return Test-VerifyYamlFrontmatter -File $Landed -RequiredKey 'name'
}

function Write-VerifyParseFailure {
    param([string]$Name, [string]$Format, [string]$Landed, [int]$Code)
    if ($Code -eq 65) {
        [Console]::Error.WriteLine(
            "client=$Name verify=fail reason=parser-unavailable " +
            "format=$Format error=no-parser-tool"
        )
        [Console]::Error.WriteLine(
            "Autoprompt verify ($Name): need python with yaml/tomllib to " +
            "validate the $Format format. Install python + PyYAML (and " +
            'tomllib via python>=3.11) and re-run.'
        )
        return 65
    }
    [Console]::Error.WriteLine(
        "client=$Name verify=fail reason=unparseable dest=$Landed " +
        "format=$Format error=parse-failed"
    )
    return 61
}

function Test-VerifyCodexDescription {
    param([string]$Name, [string]$Landed)
    $length = Get-CodexDescriptionLength -File $Landed
    if ($length -eq -65) {
        [Console]::Error.WriteLine(
            "client=$Name verify=fail reason=parser-unavailable " +
            'format=md-codex error=no-parser-tool'
        )
        [Console]::Error.WriteLine(
            "Autoprompt verify ($Name): need python with yaml to measure " +
            'the codex description. Install python + PyYAML and re-run.'
        )
        return 65
    }
    if ($length -eq -61) {
        [Console]::Error.WriteLine(
            "client=$Name verify=fail reason=unparseable dest=$Landed " +
            'format=md-codex error=parse-failed'
        )
        return 61
    }
    if ($length -le $script:AutopromptCodexDescriptionMax) { return 0 }
    [Console]::Error.WriteLine(
        "client=$Name verify=fail reason=codex-description-too-long " +
        "len=$length max=$($script:AutopromptCodexDescriptionMax) " +
        "dest=$Landed error=description-exceeds-codex-cap"
    )
    [Console]::Error.WriteLine(
        "Autoprompt verify ($Name): the codex SKILL.md description is " +
        "$length chars, over Codex's $($script:AutopromptCodexDescriptionMax) " +
        'cap - Codex will silently drop the skill. Shorten the description to ' +
        "$($script:AutopromptCodexDescriptionMax) chars or fewer and re-run."
    )
    return 63
}

function Verify-Install {
    param([string]$Name, [string]$Variant = '')
    $resolve = Get-PrecheckUpstream -Call {
        Resolve-Destination -Name $Name -Variant $Variant
    }
    if ($resolve.Code -ne 0) { return $resolve.Code }
    $destination = Get-CopyDestination -Record $resolve.Record
    $parent = Split-Path -Parent $destination.Landed
    if (-not (Test-Path -LiteralPath $destination.Landed -PathType Leaf)) {
        $siblings = @(Get-ChildItem -LiteralPath $parent -File -Force `
            -ErrorAction SilentlyContinue)
        if ($siblings.Count -gt 0) {
            [Console]::Error.WriteLine(
                "client=$Name verify=fail reason=wrong-path " +
                "expected=$($destination.Landed) found=$($siblings[0].FullName) " +
                'error=not-at-load-path'
            )
            return 62
        }
        [Console]::Error.WriteLine(
            "client=$Name verify=fail reason=absent " +
            "dest=$($destination.Landed) error=file-missing"
        )
        return 60
    }
    $parseCode = Get-VerifyParseCode -Format $destination.Format `
        -Landed $destination.Landed
    if ($parseCode -ne 0) {
        return Write-VerifyParseFailure -Name $Name `
            -Format $destination.Format -Landed $destination.Landed `
            -Code $parseCode
    }
    if ($destination.Format -eq 'md-codex') {
        $descriptionCode = Test-VerifyCodexDescription -Name $Name `
            -Landed $destination.Landed
        if ($descriptionCode -ne 0) { return $descriptionCode }
    }
    [Console]::Out.WriteLine(
        "client=$Name verify=pass dest=$($destination.Landed) " +
        "format=$($destination.Format)"
    )
    return 0
}
# --- F-LIB-VERIFY (end) ---

# --- F-LIB-UNINSTALL (begin) ---
# Uninstall-Client + Repair-Install are the behavior-faithful twins of
# uninstall_client / uninstall_repair in install-lib.sh: reverse an install to ZERO
# residue and repair a corrupted install back to the RECORDED bytes. They read the
# receipt Write-Receipt produced (the single source of truth) and re-resolve nothing.
#
# Uninstall-Client -ConfigRoot <root> -Name <client>: removes ONLY receipt Files[],
# restores every configEdit file BYTE-IDENTICAL to pre-install (PRIMARY: whole-file
# <file>.autoprompt.bak restore - byte-exact by construction; FALLBACK: surgical
# priorValue undo when no .bak = the create-from-empty/absent case), removes
# created-and-now-empty dirs walking UPWARD with hard stops, deletes the receipt LAST.
#
# Repair-Install -ConfigRoot <root> -Name <client> -SkillName <name>
#   -Description <desc> -Body <body> [-Variant <v>]: GATES on the recorded manifest
# hash - renders the caller payload, hashes it, compares to the recorded hash BEFORE
# any write; on mismatch REFUSES (76, file byte-unchanged); on pass re-mints via
# Install-Idempotent then POST-WRITE verifies live==recorded (73 otherwise).
#
# Channel discipline (mirrors the port): RECORD via [Console]::Out.WriteLine, errors
# via [Console]::Error.WriteLine, scalar `return` int the ONLY pipeline value. The
# .ps1 MAY ConvertFrom-Json to PARSE the receipt (never to WRITE one).
#
# Return-code band UNINSTALL-OWNED 70-79 (disjoint from prior bands): 0 ok; 70
# no-config-root; 71 no-receipt; 72 corrupt-receipt; 73 repair-restore-failed; 74
# file-remove-failed; 75 configrestore-failed; 76 repair-payload-mismatch.

function ConvertFrom-ReceiptStringMember {
    param(
        [string]$Line,
        [string]$Prefix,
        [string]$Suffix,
        [ref]$Value
    )
    if (-not $Line.StartsWith($Prefix, [StringComparison]::Ordinal) -or
        -not $Line.EndsWith($Suffix, [StringComparison]::Ordinal) -or
        $Line.Length -lt $Prefix.Length + $Suffix.Length) {
        return $false
    }
    $escapedLength = $Line.Length - $Prefix.Length - $Suffix.Length
    $escaped = $Line.Substring($Prefix.Length, $escapedLength)
    return ConvertFrom-ReceiptJsonEscape -Escaped $escaped -Decoded $Value
}

function Assert-IdemUniqueReceiptPath {
    param([string[]]$Values, [string]$Candidate)
    $candidateIdentity = Get-IdemNormalizedPath -Path $Candidate
    foreach ($value in @($Values)) {
        if ($value -ceq $Candidate) {
            throw 'duplicate receipt path spelling'
        }
        $identity = Get-IdemNormalizedPath -Path $value
        if (-not [string]::IsNullOrEmpty($candidateIdentity) -and
            -not [string]::IsNullOrEmpty($identity) -and
            $identity.Equals($candidateIdentity, (Get-IdemPathComparison))) {
            throw 'duplicate receipt path identity'
        }
    }
}

function Assert-IdemUniqueReceiptEdit {
    param([hashtable[]]$Edits, [hashtable]$Candidate)
    $candidateIdentity = Get-IdemNormalizedPath -Path $Candidate.File
    if ([string]::IsNullOrEmpty($candidateIdentity)) { return }
    foreach ($edit in @($Edits)) {
        $identity = Get-IdemNormalizedPath -Path $edit.File
        if (-not [string]::IsNullOrEmpty($identity) -and
            $identity.Equals($candidateIdentity, (Get-IdemPathComparison)) -and
            $edit.Key -ceq $Candidate.Key) {
            throw 'duplicate receipt edit identity'
        }
    }
}

function Read-ReceiptStringArray {
    param(
        [string[]]$Lines,
        [int]$Index,
        [string]$Member,
        [string]$Suffix
    )
    $prefix = "  `"$Member`": "
    if ($Lines[$Index] -ceq ($prefix + '[]' + $Suffix)) {
        return @{ Index = $Index + 1; Values = [string[]]@() }
    }
    if ($Lines[$Index] -cne ($prefix + '[')) {
        throw "invalid receipt array: $Member"
    }

    $values = @()
    $index++
    while ($index -lt $Lines.Count -and
        $Lines[$index] -cne ('  ]' + $Suffix)) {
        $match = [regex]::Match($Lines[$index], '^    "(.*)"(,?)$')
        if (-not $match.Success) {
            throw "invalid receipt array entry: $Member"
        }
        $value = ''
        if (-not (ConvertFrom-ReceiptJsonEscape `
            -Escaped $match.Groups[1].Value -Decoded ([ref]$value))) {
            throw "invalid receipt array string: $Member"
        }
        Assert-IdemUniqueReceiptPath -Values $values -Candidate $value
        $values += $value
        $hasComma = $match.Groups[2].Value -ceq ','
        $index++
        if (-not $hasComma -and
            ($index -ge $Lines.Count -or
                $Lines[$index] -cne ('  ]' + $Suffix))) {
            throw "invalid receipt array comma placement: $Member"
        }
        if ($hasComma -and $index -lt $Lines.Count -and
            $Lines[$index] -ceq ('  ]' + $Suffix)) {
            throw "invalid receipt array trailing comma: $Member"
        }
    }
    if ($values.Count -eq 0 -or $index -ge $Lines.Count) {
        throw "invalid receipt array terminator: $Member"
    }
    return @{ Index = $index + 1; Values = [string[]]$values }
}

function Read-ReceiptEdit {
    param([string[]]$Lines, [int]$Index)
    if ($Lines[$Index] -cne '    {') {
        throw 'invalid receipt edit opener'
    }
    if ($Index + 5 -ge $Lines.Count) {
        throw 'incomplete receipt edit'
    }
    $file = ''
    $key = ''
    $value = ''
    if (-not (ConvertFrom-ReceiptStringMember -Line $Lines[$Index + 1] `
        -Prefix '      "file": "' -Suffix '",' -Value ([ref]$file)) -or
        -not (ConvertFrom-ReceiptStringMember -Line $Lines[$Index + 2] `
            -Prefix '      "key": "' -Suffix '",' -Value ([ref]$key)) -or
        -not (ConvertFrom-ReceiptStringMember -Line $Lines[$Index + 3] `
            -Prefix '      "value": "' -Suffix '",' -Value ([ref]$value))) {
        throw 'invalid receipt edit string member'
    }
    $priorValue = $null
    $priorLine = $Lines[$Index + 4]
    if ($priorLine -cne '      "priorValue": null') {
        $prior = ''
        if (-not (ConvertFrom-ReceiptStringMember -Line $priorLine `
            -Prefix '      "priorValue": "' -Suffix '"' `
            -Value ([ref]$prior))) {
            throw 'invalid receipt priorValue'
        }
        $priorValue = $prior
    }
    $closer = $Lines[$Index + 5]
    if ($closer -cne '    }' -and $closer -cne '    },') {
        throw 'invalid receipt edit closer'
    }
    return @{ Index = $Index + 6; HasComma = $closer -ceq '    },'
        Edit = @{ File = $file; Key = $key; Value = $value
            PriorValue = $priorValue } }
}

function Read-ReceiptEditsArray {
    param([string[]]$Lines, [int]$Index)
    if ($Lines[$Index] -ceq '  "configEdits": []') {
        return @{ Index = $Index + 1; Edits = [hashtable[]]@() }
    }
    if ($Lines[$Index] -cne '  "configEdits": [') {
        throw 'invalid receipt edits array'
    }
    $edits = @()
    $index++
    while ($index -lt $Lines.Count -and $Lines[$index] -cne '  ]') {
        $parsed = Read-ReceiptEdit -Lines $Lines -Index $index
        Assert-IdemUniqueReceiptEdit -Edits $edits -Candidate $parsed.Edit
        $edits += $parsed.Edit
        $index = $parsed.Index
        if (-not $parsed.HasComma -and
            ($index -ge $Lines.Count -or $Lines[$index] -cne '  ]')) {
            throw 'invalid receipt edit comma placement'
        }
        if ($parsed.HasComma -and $index -lt $Lines.Count -and
            $Lines[$index] -ceq '  ]') {
            throw 'invalid receipt edit trailing comma'
        }
    }
    if ($edits.Count -eq 0 -or $index -ge $Lines.Count) {
        throw 'invalid receipt edits terminator'
    }
    return @{ Index = $index + 1; Edits = [hashtable[]]$edits }
}

function Format-UninstallReceiptDocument {
    param(
        [string]$Nonce,
        [string]$Backup,
        [bool]$IsBackupNull,
        [string[]]$Files,
        [string[]]$CreatedDirectories,
        [bool]$HasCreatedDirectories,
        [bool]$OmpManaged,
        [bool]$HasOmpManaged,
        [string]$OmpDetachedRoot,
        [bool]$HasOmpDetachedRoot,
        [hashtable[]]$Edits,
        [bool]$HasHashBinding = $false,
        [AllowNull()][string]$PriorManifestSha256 = $null,
        [string[]]$FileSha256 = @()
    )
    $backupJson = if ($IsBackupNull) {
        'null'
    } else {
        '"' + (Format-ReceiptJsonEscape -Value $Backup) + '"'
    }
    $document = '{' + "`n" +
        '  "nonce": "' + (Format-ReceiptJsonEscape -Value $Nonce) + '",' + "`n"
    if ($HasHashBinding) {
        $priorJson = if ([string]::IsNullOrEmpty($PriorManifestSha256)) {
            'null'
        } else { '"' + $PriorManifestSha256 + '"' }
        $document += '  "priorManifestSha256": ' + $priorJson + ',' + "`n" +
            '  "fileSha256": ' + (Format-ReceiptFilesArray -Files $FileSha256) + ',' + "`n"
    }
    $document += '  "backup": ' + $backupJson + ',' + "`n" +
        '  "files": ' + (Format-ReceiptFilesArray -Files $Files) + ',' + "`n"
    if ($HasCreatedDirectories) {
        $document += '  "createdDirectories": ' + (
            Format-ReceiptFilesArray -Files $CreatedDirectories
        ) + ',' + "`n"
    }
    if ($HasOmpManaged) {
        $document += '  "ompManaged": ' +
            $OmpManaged.ToString().ToLowerInvariant() + ',' + "`n"
    }
    if ($HasOmpDetachedRoot) {
        $detachedJson = if ([string]::IsNullOrEmpty($OmpDetachedRoot)) {
            'null'
        } else {
            '"' + (Format-ReceiptJsonEscape -Value $OmpDetachedRoot) + '"'
        }
        $document += '  "ompDetachedRoot": ' + $detachedJson + ',' + "`n"
    }
    return $document + '  "configEdits": ' +
        (Format-ReceiptEditsArray -Edits $Edits) + "`n" + '}' + "`n"
}

function Read-UninstallReceiptDocument {
    param([string]$Receipt)
    $document = [System.IO.File]::ReadAllText($Receipt)
    if ($document.Contains("`r") -or $document.Contains([char]0) -or
        -not $document.EndsWith("`n") -or $document.EndsWith("`n`n")) {
        throw 'invalid receipt newline contract'
    }
    $lines = @($document.Substring(0, $document.Length - 1) `
        -split "`n", -1)
    if ($lines[0] -cne '{') { throw 'invalid receipt opener' }
    return @{ Document = $document; Lines = $lines }
}

function Read-UninstallReceiptMembers {
    param([string[]]$Lines)
    $index = 1
    $nonce = ''
    if (-not (ConvertFrom-ReceiptStringMember -Line $Lines[$index] `
        -Prefix '  "nonce": "' -Suffix '",' -Value ([ref]$nonce))) {
        throw 'invalid receipt nonce'
    }
    $index++
    $hasHashBinding = $Lines[$index].StartsWith(
        '  "priorManifestSha256": ', [StringComparison]::Ordinal
    )
    $priorManifestSha256 = $null
    $fileSha256 = [string[]]@()
    if ($hasHashBinding) {
        if ($Lines[$index] -cne '  "priorManifestSha256": null,') {
            $priorManifestSha256 = ''
            if (-not (ConvertFrom-ReceiptStringMember -Line $Lines[$index] `
                -Prefix '  "priorManifestSha256": "' -Suffix '",' `
                -Value ([ref]$priorManifestSha256)) -or
                $priorManifestSha256 -notmatch '^[a-f0-9]{64}$') {
                throw 'invalid prior manifest hash'
            }
        }
        $index++
        $parsedHashes = Read-ReceiptStringArray -Lines $Lines `
            -Index $index -Member 'fileSha256' -Suffix ','
        $fileSha256 = [string[]]@($parsedHashes.Values)
        if (@($fileSha256 | Where-Object { $_ -notmatch '=[a-f0-9]{64}$' }).Count) {
            throw 'invalid receipt file hash binding'
        }
        $index = $parsedHashes.Index
    }
    $backup = ''
    $isBackupNull = $Lines[$index] -ceq '  "backup": null,'
    if (-not $isBackupNull -and
        -not (ConvertFrom-ReceiptStringMember -Line $Lines[$index] `
            -Prefix '  "backup": "' -Suffix '",' -Value ([ref]$backup))) {
        throw 'invalid receipt backup'
    }
    $index++
    $parsedFiles = Read-ReceiptStringArray -Lines $Lines `
        -Index $index -Member 'files' -Suffix ','
    $index = $parsedFiles.Index
    $hasDirectories = $Lines[$index] -ceq `
        '  "createdDirectories": [],' -or $Lines[$index] -ceq `
        '  "createdDirectories": ['
    $directories = [string[]]@()
    if ($hasDirectories) {
        $parsedDirectories = Read-ReceiptStringArray -Lines $Lines `
            -Index $index -Member 'createdDirectories' -Suffix ','
        $directories = [string[]]@($parsedDirectories.Values)
        $index = $parsedDirectories.Index
    }
    $hasOmpManaged = $Lines[$index] -ceq '  "ompManaged": true,' -or
        $Lines[$index] -ceq '  "ompManaged": false,'
    $ompManaged = $false
    if ($hasOmpManaged) {
        $ompManaged = $Lines[$index] -ceq '  "ompManaged": true,'
        $index++
    }
    $hasOmpDetachedRoot = $Lines[$index] -ceq `
        '  "ompDetachedRoot": null,' -or $Lines[$index].StartsWith(
            '  "ompDetachedRoot": "',
            [StringComparison]::Ordinal
        )
    $ompDetachedRoot = ''
    if ($hasOmpDetachedRoot) {
        if ($Lines[$index] -cne '  "ompDetachedRoot": null,' -and
            -not (ConvertFrom-ReceiptStringMember -Line $Lines[$index] `
                -Prefix '  "ompDetachedRoot": "' -Suffix '",' `
                -Value ([ref]$ompDetachedRoot))) {
            throw 'invalid receipt OMP detached root'
        }
        $index++
    }
    $parsedEdits = Read-ReceiptEditsArray -Lines $Lines -Index $index
    return @{ Nonce = $nonce; Backup = $backup
        IsBackupNull = $isBackupNull; Files = [string[]]@($parsedFiles.Values)
        CreatedDirectories = $directories; HasCreatedDirectories = $hasDirectories
        OmpManaged = $ompManaged; HasOmpManaged = $hasOmpManaged
        OmpDetachedRoot = $ompDetachedRoot
        HasOmpDetachedRoot = $hasOmpDetachedRoot
        Edits = [hashtable[]]@($parsedEdits.Edits); Index = $parsedEdits.Index
        HasHashBinding = $hasHashBinding; PriorManifestSha256 = $priorManifestSha256
        FileSha256 = $fileSha256 }
}

function Read-UninstallReceipt {
    param([string]$ConfigRoot)
    $receipt = Join-Path $ConfigRoot $AutopromptReceiptName
    if (-not (Test-Path -LiteralPath $receipt -PathType Leaf)) {
        [Console]::Error.WriteLine("error=no-receipt path=$receipt")
        [Console]::Error.WriteLine(
            "Autoprompt uninstall: no install receipt found at $receipt - " +
            'nothing to remove (re-run the installer, or remove files manually).'
        )
        return 71
    }
    try {
        $parsedDocument = Read-UninstallReceiptDocument -Receipt $receipt
        $state = Read-UninstallReceiptMembers -Lines $parsedDocument.Lines
        if ($state.Index -ne $parsedDocument.Lines.Count - 1 -or
            $parsedDocument.Lines[$state.Index] -cne '}') {
            throw 'invalid receipt terminator'
        }
        $canonical = Format-UninstallReceiptDocument -Nonce $state.Nonce `
            -Backup $state.Backup -IsBackupNull $state.IsBackupNull `
            -Files $state.Files -CreatedDirectories $state.CreatedDirectories `
            -HasCreatedDirectories $state.HasCreatedDirectories `
            -OmpManaged $state.OmpManaged `
            -HasOmpManaged $state.HasOmpManaged `
            -OmpDetachedRoot $state.OmpDetachedRoot `
            -HasOmpDetachedRoot $state.HasOmpDetachedRoot -Edits $state.Edits `
            -HasHashBinding $state.HasHashBinding `
            -PriorManifestSha256 $state.PriorManifestSha256 `
            -FileSha256 $state.FileSha256
        if ($canonical -cne $parsedDocument.Document) {
            throw 'noncanonical receipt'
        }
    } catch {
        [Console]::Error.WriteLine(
            "error=corrupt-receipt path=$receipt detail=grammar"
        )
        return 72
    }
    $state.Files = [string[]]@($state.Files | ForEach-Object {
        ConvertTo-AutopromptNativePath -Path $_
    })
    $state.CreatedDirectories = [string[]]@(
        $state.CreatedDirectories | ForEach-Object {
            ConvertTo-AutopromptNativePath -Path $_
        }
    )
    if (-not [string]::IsNullOrEmpty($state.Backup) -and
        $state.Backup -cne 'none') {
        $state.Backup = ConvertTo-AutopromptNativePath -Path $state.Backup
    }
    $state.OmpDetachedRoot = ConvertTo-AutopromptNativePath `
        -Path $state.OmpDetachedRoot
    foreach ($edit in @($state.Edits)) {
        $edit.File = ConvertTo-AutopromptNativePath -Path $edit.File
    }
    if (-not $state.HasOmpDetachedRoot) {
        $state.OmpDetachedRoot = Get-AutopromptLegacyOmpDetachedRoot `
            -ConfigRoot $ConfigRoot -Files $state.Files
    }
    if (-not $state.HasOmpManaged) {
        $state.OmpManaged = -not [string]::IsNullOrEmpty(
            $state.OmpDetachedRoot
        ) -or (Test-AutopromptLegacySelfContainedOmpAuthority `
            -ConfigRoot $ConfigRoot -Files $state.Files -Edits $state.Edits)
    }
    if (-not $state.OmpManaged -and
        -not [string]::IsNullOrEmpty($state.OmpDetachedRoot)) {
        [Console]::Error.WriteLine(
            "error=corrupt-receipt path=$receipt detail=omp-provider-state"
        )
        return 72
    }
    $needsOmpManagedMigration = -not $state.HasOmpManaged -and
        $state.OmpManaged
    $needsOmpDetachedRootMigration = -not $state.HasOmpDetachedRoot -and
        -not [string]::IsNullOrEmpty($state.OmpDetachedRoot)
    if (-not (Test-UninstallReceiptPaths -ConfigRoot $ConfigRoot `
        -Backup $state.Backup -Files $state.Files `
        -CreatedDirectories $state.CreatedDirectories `
        -OmpDetachedRoot $state.OmpDetachedRoot -Edits $state.Edits)) {
        [Console]::Error.WriteLine(
            "error=corrupt-receipt path=$receipt detail=path-outside-root"
        )
        return 72
    }
    $script:AutopromptReceiptOmpManaged = $state.OmpManaged
    $script:AutopromptReceiptOmpDetachedRoot = $state.OmpDetachedRoot
    return @{ Nonce = $state.Nonce; Backup = $state.Backup; Files = $state.Files
        CreatedDirectories = $state.CreatedDirectories
        OmpManaged = $state.OmpManaged
        HasOmpManaged = $state.HasOmpManaged
        NeedsOmpManagedMigration = $needsOmpManagedMigration
        OmpDetachedRoot = $state.OmpDetachedRoot
        HasOmpDetachedRoot = $state.HasOmpDetachedRoot
        NeedsOmpDetachedRootMigration = $needsOmpDetachedRootMigration
        Edits = $state.Edits }
}

# Get-UninstallKeyValue <file> <dotted-key>: hand-parse <file> for the raw value
# token of <dotted-key> (the agents.* keys we own), or the sentinel '__CL_ABSENT__'
# when absent. Inline comments + surrounding whitespace trimmed; a basic-string is
# unquoted. Twin of _uninstall_parse_key_value in .sh.
function Get-UninstallKeyValue {
    param([string]$File, [string]$DottedKey)
    $wantTable = $DottedKey.Substring(0, $DottedKey.LastIndexOf('.'))
    $wantKey = $DottedKey.Substring($DottedKey.LastIndexOf('.') + 1)
    if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { return '__CL_ABSENT__' }
    $curTable = ''
    foreach ($raw in [System.IO.File]::ReadAllLines($File)) {
        $stripped = $raw.Trim()
        if ($stripped -eq '' -or $stripped.StartsWith('#')) { continue }
        if ($stripped -match '^\[([^\[\]]*)\]$') { $curTable = $matches[1].Trim(); continue }
        if ($stripped.Contains('=')) {
            $eq = $stripped.IndexOf('=')
            $key = $stripped.Substring(0, $eq).Trim()
            if ($curTable -eq $wantTable -and $key -eq $wantKey) {
                $val = $stripped.Substring($eq + 1).Trim()
                $hash = $val.IndexOf('#')
                if ($hash -ge 0) { $val = $val.Substring(0, $hash).Trim() }
                if ($val.Length -ge 2 -and $val.StartsWith('"') -and $val.EndsWith('"')) {
                    $val = $val.Substring(1, $val.Length - 2)
                }
                return $val
            }
        }
    }
    return '__CL_ABSENT__'
}

# Test-UninstallPriorValues <file> <edits[]>: post-restore oracle. For each edit
# assert the recorded key equals its PriorValue (or is absent when $null). Returns
# $true on all-match, $false on the first mismatch (caller maps to 75).
function Test-UninstallPriorValues {
    param([string]$File, [hashtable[]]$Edits)
    foreach ($e in $Edits) {
        $live = Get-UninstallKeyValue -File $File -DottedKey $e.Key
        if ($null -eq $e.PriorValue) {
            if ($live -ne '__CL_ABSENT__') {
                [Console]::Error.WriteLine("error=configrestore-failed path=$File key=$($e.Key) detail=expected-absent found=$live")
                return $false
            }
        } else {
            if ($live -ne $e.PriorValue) {
                [Console]::Error.WriteLine("error=configrestore-failed path=$File key=$($e.Key) detail=expected=$($e.PriorValue) found=$live")
                return $false
            }
        }
    }
    return $true
}

# Get-UninstallStrippedLines <file> <edits[]>: the file's NON-BLANK lines with the
# recorded key lines + a bare [agents] header removed, so two files can be compared
# "modulo our edits + blanks" to detect a user's unrelated post-install edit. Twin
# of _uninstall_strip_keylines in .sh.
function Get-UninstallStrippedLines {
    param([string]$File, [hashtable[]]$Edits)
    if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { return '' }
    $wantKeys = @(); foreach ($e in $Edits) { $wantKeys += ($e.Key -replace '^.*\.', '') }
    $out = @()
    foreach ($raw in [System.IO.File]::ReadAllLines($File)) {
        $stripped = $raw.Trim()
        if ($stripped -eq '') { continue }
        if ($stripped -eq '[agents]') { continue }
        $keep = $true
        if ($stripped.Contains('=')) {
            $key = $stripped.Substring(0, $stripped.IndexOf('=')).Trim()
            if ($wantKeys -contains $key) { $keep = $false }
        }
        if ($keep) { $out += $stripped }
    }
    return ($out -join "`n")
}

# Restore-UninstallSurgicalRemove <file> <edits[]>: the no-.bak FALLBACK. Remove the
# recorded key lines + the writer's now-empty [agents] header + trailing blanks; if
# nothing meaningful remains, truncate to zero bytes (the create-from-scratch
# pre-edit "no content" state). Byte-faithful write (UTF8 no-BOM, detected newline).
function Restore-UninstallSurgicalRemove {
    param([string]$File, [hashtable[]]$Edits)
    if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { return }
    $wantKeys = @(); foreach ($e in $Edits) { $wantKeys += ($e.Key -replace '^.*\.', '') }
    $rawText = [System.IO.File]::ReadAllText($File)
    $usesCrlf = $rawText.Contains("`r`n")
    $newline = if ($usesCrlf) { "`r`n" } else { "`n" }
    $out = @()
    foreach ($raw in [System.IO.File]::ReadAllLines($File)) {
        $stripped = $raw.Trim()
        $keep = $true
        if ($stripped.Contains('=')) {
            $key = $stripped.Substring(0, $stripped.IndexOf('=')).Trim()
            if ($wantKeys -contains $key) { $keep = $false }
        }
        if ($keep) { $out += $raw }
    }
    # Drop a trailing now-empty [agents] header + any trailing blank separator.
    while ($out.Count -gt 0) {
        $last = $out[$out.Count - 1].Trim()
        if ($last -eq '[agents]' -or $last -eq '') { $out = Get-AllButLast -Items $out }
        else { break }
    }
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    if ($out.Count -eq 0) {
        [System.IO.File]::WriteAllText($File, '', $utf8NoBom)
        return
    }
    $content = ($out -join $newline) + $newline
    [System.IO.File]::WriteAllText($File, $content, $utf8NoBom)
}

# Restore-UninstallSurgicalPriors <file> <edits[]>: the diverged path - set each
# recorded key back to its PriorValue ($null => delete the line; non-null =>
# rewrite `key = prior`), preserving every other byte. Byte-faithful write.
function Restore-UninstallSurgicalPriors {
    param([string]$File, [hashtable[]]$Edits)
    $rawText = [System.IO.File]::ReadAllText($File)
    $usesCrlf = $rawText.Contains("`r`n")
    $newline = if ($usesCrlf) { "`r`n" } else { "`n" }
    $out = @()
    foreach ($raw in [System.IO.File]::ReadAllLines($File)) {
        $stripped = $raw.Trim()
        $handled = $false
        if ($stripped.Contains('=')) {
            $key = $stripped.Substring(0, $stripped.IndexOf('=')).Trim()
            foreach ($e in $Edits) {
                $wk = ($e.Key -replace '^.*\.', '')
                if ($key -eq $wk) {
                    $handled = $true
                    if ($null -ne $e.PriorValue) {
                        $indent = ([regex]::Match($raw, '^[ \t]*')).Value
                        $out += "$indent$wk = $($e.PriorValue)"
                    }
                    break
                }
            }
        }
        if (-not $handled) { $out += $raw }
    }
    $content = if ($out.Count -gt 0) { ($out -join $newline) + $newline } else { '' }
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    $tmp = "$File.cl-restore.tmp"
    try {
        [System.IO.File]::WriteAllText($tmp, $content, $utf8NoBom)
        if (Test-Path -LiteralPath $File -PathType Leaf) { Remove-Item -LiteralPath $File -Force -ErrorAction Stop }
        [System.IO.File]::Move($tmp, $File)
    } catch {
        try { if (Test-Path -LiteralPath $tmp -PathType Leaf) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue } } catch { }
        return $false
    }
    return $true
}

# Restore-UninstallConfigFile <file> <edits[]>: restore ONE edited config file.
# Config-absent skip; PRIMARY whole-file .bak restore; divergence guard -> surgical
# priors; FALLBACK surgical remove (no .bak). Post-restore priorValue oracle.
# Returns 0 / 74 / 75. Emits the per-file configrestore record on success.
function Test-UninstallConfigDiverged {
    param([string]$File, [string]$Backup, [hashtable[]]$Edits)
    foreach ($edit in $Edits) {
        $live = Get-UninstallKeyValue -File $File -DottedKey $edit.Key
        if ($live -ne $edit.Value) { return $true }
    }
    if (-not (Test-Path -LiteralPath $Backup -PathType Leaf)) {
        return $false
    }
    $liveStripped = Get-UninstallStrippedLines -File $File -Edits $Edits
    $backupStripped = Get-UninstallStrippedLines -File $Backup -Edits $Edits
    return $liveStripped -ne $backupStripped
}

function Restore-UninstallBackup {
    param([string]$File, [string]$Backup)
    $temporary = "$File.cl-restore.tmp"
    try {
        [System.IO.File]::Copy($Backup, $temporary, $true)
        if (Test-Path -LiteralPath $File -PathType Leaf) {
            Remove-Item -LiteralPath $File -Force -ErrorAction Stop
        }
        [System.IO.File]::Move($temporary, $File)
    } catch {
        Remove-Item -LiteralPath $temporary -Force `
            -ErrorAction SilentlyContinue
        [Console]::Error.WriteLine(
            "error=configrestore-failed path=$File detail=bak-restore-write"
        )
        return $false
    }
    return $true
}

function Remove-UninstallConfigBackup {
    param([string]$File, [string]$Backup)
    if (-not (Test-Path -LiteralPath $Backup -PathType Leaf)) { return $true }
    try {
        Remove-Item -LiteralPath $Backup -Force -ErrorAction Stop
    } catch {
        [Console]::Error.WriteLine(
            "error=configrestore-failed path=$File " +
            "detail=backup-remove backup=$Backup"
        )
        return $false
    }
    return $true
}

function Restore-UninstallConfigFile {
    param([string]$File, [hashtable[]]$Edits)
    $backup = "$File$AutopromptConfigEditBackupSuffix"
    if ($Edits.Count -eq 1 -and
        $Edits[0].Key -ceq $AutopromptVscodeActivationKey) {
        $prior = if ($null -eq $Edits[0].PriorValue) {
            'absent'
        } else {
            [string]$Edits[0].PriorValue
        }
        $helper = Get-VscodeSettingsHelper
        $output = @(& node $helper restore --file $File --backup $backup `
            --prior $prior 2>&1)
        if ($LASTEXITCODE -ne 0) {
            [Console]::Error.WriteLine(($output -join [Environment]::NewLine))
            return 75
        }
        [Console]::Out.WriteLine(($output -join [Environment]::NewLine))
        return 0
    }
    if ($Edits.Count -eq 1 -and $Edits[0].Key -in @(
        'task.maxRecursionDepth', 'agent.max_subagent_depth'
    )) {
        $provider = if ($Edits[0].Key -ceq 'task.maxRecursionDepth') {
            'omp'
        } else {
            'reasonix'
        }
        $prior = if ($null -eq $Edits[0].PriorValue) {
            'absent-key'
        } else {
            [string]$Edits[0].PriorValue
        }
        $helper = Join-Path $AutopromptInstallRepoRoot `
            'scripts/harness-provider-config.cjs'
        $output = @(& node $helper restore --provider $provider --file $File `
            --backup $backup --prior $prior --expected 4 2>&1)
        if ($LASTEXITCODE -ne 0) {
            [Console]::Error.WriteLine(($output -join [Environment]::NewLine))
            return 75
        }
        [Console]::Out.WriteLine(($output -join [Environment]::NewLine))
        return 0
    }
    if (-not (Test-Path -LiteralPath $File -PathType Leaf)) {
        if (-not (Remove-UninstallConfigBackup -File $File -Backup $backup)) {
            return 75
        }
        [Console]::Out.WriteLine("configrestore=$File note=config-absent")
        return 0
    }
    $hasBackup = Test-Path -LiteralPath $backup -PathType Leaf
    $isDiverged = Test-UninstallConfigDiverged -File $File `
        -Backup $backup -Edits $Edits
    if ($hasBackup -and -not $isDiverged) {
        if (-not (Restore-UninstallBackup -File $File -Backup $backup)) {
            return 75
        }
        if (-not (Remove-UninstallConfigBackup -File $File -Backup $backup)) {
            return 75
        }
        if (-not (Test-UninstallPriorValues -File $File -Edits $Edits)) {
            return 75
        }
        [Console]::Out.WriteLine(
            "configrestore=$File via=bak keys=$($Edits.Count)"
        )
        return 0
    }
    if ($hasBackup -and $isDiverged) {
        if (-not (Restore-UninstallSurgicalPriors -File $File -Edits $Edits)) {
            [Console]::Error.WriteLine(
                "error=configrestore-failed path=$File detail=surgical-write"
            )
            return 75
        }
        if (-not (Remove-UninstallConfigBackup -File $File -Backup $backup)) {
            return 75
        }
        if (-not (Test-UninstallPriorValues -File $File -Edits $Edits)) {
            return 75
        }
        [Console]::Out.WriteLine(
            "configrestore=$File via=surgical-diverged " +
            "note=user-modified-since-install keys=$($Edits.Count)"
        )
        return 0
    }
    Restore-UninstallSurgicalRemove -File $File -Edits $Edits
    if (-not (Test-UninstallPriorValues -File $File -Edits $Edits)) { return 75 }
    [Console]::Out.WriteLine(
        "configrestore=$File via=surgical keys=$($Edits.Count) table=removed"
    )
    return 0
}

# Restore-UninstallConfigEdits <edits[]>: group by file, restore EACH distinct file.
# Sets $script:UninstallRestoredEditFiles. Returns 0 or the first non-zero (74/75).
function Restore-UninstallConfigEdits {
    param([hashtable[]]$Edits)
    $script:UninstallRestoredEditFiles = 0
    if ($null -eq $Edits -or $Edits.Count -eq 0) { return 0 }
    $seen = @()
    foreach ($e in $Edits) {
        if ($seen -contains $e.File) { continue }
        $seen += $e.File
        $fileEdits = @($Edits | Where-Object { $_.File -eq $e.File })
        $rc = Restore-UninstallConfigFile -File $e.File -Edits $fileEdits
        if ($rc -ne 0) { return $rc }
        $script:UninstallRestoredEditFiles++
    }
    return 0
}

function Remove-UninstallEmptyDirs {
    param(
        [string]$ConfigRoot,
        [string[]]$CreatedDirectories,
        [string]$Name = ''
    )
    [string[]]$candidates = @($CreatedDirectories | Where-Object {
        -not [string]::IsNullOrEmpty($_) -and
        (-not $Name -or (Test-UninstallProviderPath -Name $Name `
            -ConfigRoot $ConfigRoot -Path $_))
    })
    $comparer = [System.Collections.Generic.Comparer[string]]::Create(
        [System.Comparison[string]]{
            param($left, $right)
            $leftDepth = [regex]::Matches(
                (Get-IdemNormalizedPath -Path $left), '[\\/]'
            ).Count
            $rightDepth = [regex]::Matches(
                (Get-IdemNormalizedPath -Path $right), '[\\/]'
            ).Count
            $depthOrder = $rightDepth.CompareTo($leftDepth)
            if ($depthOrder -ne 0) { return $depthOrder }
            return [System.StringComparer]::Ordinal.Compare($left, $right)
        }
    )
    [Array]::Sort($candidates, $comparer)
    foreach ($directory in $candidates) {
        if (-not (Test-IdemReceiptOwnsCreatedDirectory -Path $directory) -or
            -not (Test-Path -LiteralPath $directory -PathType Container)) {
            continue
        }
        try {
            if (@([System.IO.Directory]::GetFileSystemEntries($directory)).Count -ne 0) {
                continue
            }
            [System.IO.Directory]::Delete($directory, $false)
            Remove-IdemReceiptCreatedDirectory -Path $directory
        } catch {
            return $false
        }
    }
    return $true
}

function Test-AutopromptCustomProviderPath {
    param([string]$Name, [string]$ConfigRoot, [string]$Path)
    if (-not [string]::IsNullOrEmpty($script:AutopromptInstallRootClient) -and
        $Name -cne $script:AutopromptInstallRootClient) { return $false }
    $normalizedPath = Get-IdemNormalizedPath -Path $Path
    if ([string]::IsNullOrEmpty($normalizedPath)) { return $false }
    $skills = Join-Path $ConfigRoot 'skills'
    $skill = Join-Path $skills 'autoprompt'
    if ((Test-IdemPathEqual -Left $normalizedPath -Right $skills) -or
        (Test-IdemPathEqual -Left $normalizedPath -Right $skill) -or
        (Test-IdemPathUnderRoot -Path $normalizedPath -Root $skill)) {
        return $true
    }
    $agents = Join-Path $ConfigRoot 'agents'
    $parent = Split-Path -Parent $normalizedPath
    $leaf = Split-Path -Leaf $normalizedPath
    switch ($Name) {
        'codex' {
            return (Test-IdemPathEqual -Left $normalizedPath -Right `
                    (Join-Path $ConfigRoot 'scripts')) -or
                (Test-IdemPathEqual -Left $normalizedPath -Right `
                    (Join-Path $ConfigRoot 'scripts/local-only-safety.cjs')) -or
                (Test-IdemPathEqual -Left $normalizedPath -Right `
                    (Join-Path $ConfigRoot 'skills/contracts')) -or
                (Test-IdemPathUnderRoot -Path $normalizedPath -Root `
                    (Join-Path $ConfigRoot 'skills/contracts'))
        }
        'claude' {
            return (Test-IdemPathEqual -Left $normalizedPath -Right $agents) -or
                ((Test-IdemPathEqual -Left $parent -Right $agents) -and
                    $leaf -clike 'ap-*.md')
        }
        'opencode' {
            return (Test-IdemPathEqual -Left $normalizedPath -Right $agents) -or
                ((Test-IdemPathEqual -Left $parent -Right $agents) -and
                $leaf -clike 'ap-*.md') -or
                (Test-IdemPathEqual -Left $normalizedPath -Right `
                    (Join-Path $ConfigRoot 'autoprompt.opencode.json'))
        }
        'kilo' {
            return (Test-IdemPathEqual -Left $normalizedPath -Right $agents) -or
                ((Test-IdemPathEqual -Left $parent -Right $agents) -and
                $leaf -clike 'ap-*.md') -or
                (Test-IdemPathEqual -Left $normalizedPath -Right `
                    (Join-Path $ConfigRoot 'autoprompt.kilo.json'))
        }
        'vscode' {
            if (Test-IdemPathEqual -Left $normalizedPath -Right $agents) {
                return $true
            }
            if ((Test-IdemPathEqual -Left $parent -Right $agents) -and
                $leaf -clike 'ap-*.agent.md') { return $true }
            $settings = Get-IdemNormalizedPath -Path (Get-VscodeSettingsFile)
            return (Test-IdemPathEqual -Left $normalizedPath -Right $settings) -or
                (Test-IdemPathEqual -Left $normalizedPath `
                    -Right "$settings$AutopromptConfigEditBackupSuffix")
        }
        'omp' {
            $isOwned = $false
            $defaultAgentRoot = Get-IdemNormalizedPath `
                -Path $script:AutopromptReceiptOmpDetachedRoot
            if ([string]::IsNullOrEmpty($defaultAgentRoot) -and
                $script:AutopromptReceiptOmpManaged) {
                $isOwned = (Test-IdemPathEqual `
                    -Left $normalizedPath -Right $agents) -or
                    ((Test-IdemPathEqual -Left $parent -Right $agents) -and
                        $leaf -clike 'ap-*.md')
            } elseif (-not [string]::IsNullOrEmpty($defaultAgentRoot)) {
                $configDirectory = Split-Path -Parent $defaultAgentRoot
                $nativeAgents = Join-Path $defaultAgentRoot 'agents'
                $isDetachedPath = Test-AutopromptOmpDetachedReceiptPath `
                    -Path $normalizedPath `
                    -DefaultAgentRoot $defaultAgentRoot
                $isOwned = $isOwned -or ($isDetachedPath -and (
                    (Test-IdemPathEqual -Left $normalizedPath `
                        -Right $configDirectory) -or
                    (Test-IdemPathEqual -Left $normalizedPath `
                        -Right $defaultAgentRoot) -or
                    (Test-IdemPathEqual -Left $normalizedPath `
                        -Right $nativeAgents) -or
                    ((Test-IdemPathEqual -Left $parent -Right $nativeAgents) -and
                        $leaf -clike 'ap-*.md')))
            }
            return $isOwned -or
                (Test-IdemPathEqual -Left $normalizedPath -Right `
                    (Join-Path $ConfigRoot 'config.yml')) -or
                (Test-IdemPathEqual -Left $normalizedPath -Right `
                    ((Join-Path $ConfigRoot 'config.yml') +
                        $AutopromptConfigEditBackupSuffix))
        }
        'deepseek' {
            $presets = Join-Path $ConfigRoot '.agent-presets'
            $preset = Join-Path $presets 'autoprompt'
            return (Test-IdemPathEqual -Left $normalizedPath -Right $presets) -or
                (Test-IdemPathEqual -Left $normalizedPath -Right $preset) -or
                ((Test-IdemPathEqual -Left $parent -Right $preset) -and
                    $leaf -in @('agent.cordis.yml', 'preset.yml'))
        }
        'reasonix' {
            $config = Join-Path $ConfigRoot 'config.toml'
            if ((Test-IdemPathEqual -Left $normalizedPath -Right $config) -or
                (Test-IdemPathEqual -Left $normalizedPath -Right `
                    "$config$AutopromptConfigEditBackupSuffix")) {
                return $true
            }
            if ((Test-IdemPathEqual -Left $parent -Right $skills) -and
                $leaf -clike 'ap-*') { return $true }
            if ($leaf -cne 'SKILL.md') { return $false }
            $profile = Split-Path -Parent $normalizedPath
            return (Split-Path -Leaf $profile) -clike 'ap-*' -and
                (Test-IdemPathEqual -Left (Split-Path -Parent $profile) `
                    -Right $skills)
        }
        default { return $false }
    }
}

function Test-UninstallProviderPath {
    param([string]$Name, [string]$ConfigRoot, [string]$Path)
    $scopedNames = @(
        'claude', 'codex', 'opencode', 'kilo', 'vscode', 'vibe',
        'cursor', 'dcode', 'roo', 'gemini', 'cline', 'goose',
        'omp', 'deepseek', 'reasonix'
    )
    if ($Name -cnotin $scopedNames) { return $true }

    $normalizedPath = Get-IdemNormalizedPath -Path $Path
    if ([string]::IsNullOrEmpty($normalizedPath)) { return $false }
    if ($Name -ceq 'dcode') { return $false }
    if ((Test-AutopromptInstallRootOverridePresent) -and
        $Name -in @(
            'claude', 'opencode', 'kilo', 'vscode',
            'omp', 'deepseek', 'reasonix'
        )) {
        return Test-AutopromptCustomProviderPath -Name $Name `
            -ConfigRoot $ConfigRoot -Path $normalizedPath
    }
    if ($Name -in @('omp', 'deepseek', 'reasonix')) {
        return Test-AutopromptCustomProviderPath -Name $Name `
            -ConfigRoot $ConfigRoot -Path $normalizedPath
    }
    $parent = Split-Path -Parent $normalizedPath
    $leaf = Split-Path -Leaf $normalizedPath
    if ($Name -ceq 'claude') {
        $base = Join-Path $ConfigRoot '.claude'
        $skill = Join-Path $base 'skills/autoprompt'
        $agents = Join-Path $base 'agents'
        if ((Test-IdemPathEqual -Left $normalizedPath -Right $base) -or
            (Test-IdemPathEqual -Left $normalizedPath `
                -Right (Join-Path $base 'skills')) -or
            (Test-IdemPathEqual -Left $normalizedPath -Right $agents) -or
            (Test-IdemPathEqual -Left $normalizedPath -Right $skill) -or
            (Test-IdemPathUnderRoot -Path $normalizedPath -Root $skill)) {
            return $true
        }
        return (Test-IdemPathEqual -Left $parent -Right $agents) -and
            $leaf -clike 'ap-*.md'
    }
    if ($Name -ceq 'codex') {
        $skills = Join-Path $ConfigRoot 'skills'
        $skill = Join-Path $skills 'autoprompt'
        return (Test-IdemPathEqual -Left $normalizedPath -Right $skills) -or
            (Test-IdemPathEqual -Left $normalizedPath -Right $skill) -or
            (Test-IdemPathUnderRoot -Path $normalizedPath -Root $skill) -or
            (Test-IdemPathEqual -Left $normalizedPath `
                -Right (Join-Path $ConfigRoot 'autoprompt.config.toml')) -or
            (Test-IdemPathEqual -Left $normalizedPath `
                -Right (Join-Path $ConfigRoot 'config.toml')) -or
            (Test-IdemPathEqual -Left $normalizedPath `
                -Right ((Join-Path $ConfigRoot 'config.toml') +
                    $AutopromptConfigEditBackupSuffix)) -or
            (Test-IdemPathEqual -Left $normalizedPath `
                -Right (Join-Path $ConfigRoot 'scripts')) -or
            (Test-IdemPathEqual -Left $normalizedPath `
                -Right (Join-Path $ConfigRoot 'scripts/local-only-safety.cjs')) -or
            (Test-IdemPathEqual -Left $normalizedPath `
                -Right (Join-Path $ConfigRoot 'skills/contracts')) -or
            (Test-IdemPathUnderRoot -Path $normalizedPath -Root `
                (Join-Path $ConfigRoot 'skills/contracts'))
    }
    if ($Name -ceq 'cursor') {
        $base = Join-Path $ConfigRoot '.cursor'
        $skills = Join-Path $base 'skills'
        $skill = Join-Path $skills 'autoprompt'
        $rules = Join-Path $base 'rules'
        return (Test-IdemPathEqual -Left $normalizedPath -Right $base) -or
            (Test-IdemPathEqual -Left $normalizedPath -Right $skills) -or
            (Test-IdemPathEqual -Left $normalizedPath -Right $skill) -or
            (Test-IdemPathUnderRoot -Path $normalizedPath -Root $skill) -or
            (Test-IdemPathEqual -Left $normalizedPath -Right $rules) -or
            (Test-IdemPathEqual -Left $normalizedPath `
                -Right (Join-Path $rules 'autoprompt.mdc'))
    }
    if ($Name -ceq 'roo') {
        return (Test-IdemPathEqual -Left $normalizedPath `
            -Right (Join-Path $ConfigRoot '.roomodes'))
    }
    if ($Name -ceq 'gemini') {
        $base = Join-Path $ConfigRoot '.gemini'
        $commands = Join-Path $base 'commands'
        return (Test-IdemPathEqual -Left $normalizedPath -Right $base) -or
            (Test-IdemPathEqual -Left $normalizedPath -Right $commands) -or
            (Test-IdemPathEqual -Left $normalizedPath `
                -Right (Join-Path $commands 'autoprompt.toml'))
    }
    if ($Name -ceq 'cline') {
        $base = Join-Path $ConfigRoot '.clinerules'
        return (Test-IdemPathEqual -Left $normalizedPath -Right $base) -or
            (Test-IdemPathEqual -Left $normalizedPath `
                -Right (Join-Path $base 'autoprompt.md'))
    }
    if ($Name -ceq 'goose') {
        $base = Join-Path $ConfigRoot '.config/goose'
        $recipes = Join-Path $base 'recipes'
        return (Test-IdemPathEqual -Left $normalizedPath -Right $base) -or
            (Test-IdemPathEqual -Left $normalizedPath -Right $recipes) -or
            (Test-IdemPathEqual -Left $normalizedPath `
                -Right (Join-Path $recipes 'autoprompt.yaml')) -or
            (Test-IdemPathEqual -Left $normalizedPath `
                -Right (Join-Path $ConfigRoot 'AGENTS.md'))
    }
    if ($Name -ceq 'vibe') {
        if (Test-IdemPathEqual -Left $normalizedPath -Right $ConfigRoot) {
            return $true
        }
        $parent = Split-Path -Parent $normalizedPath
        $leaf = Split-Path -Leaf $normalizedPath
        if ((Test-IdemPathEqual -Left $parent -Right $ConfigRoot) -and
            $leaf -cin @('GATES.md', 'MODES.md', 'PLAYBOOKS.md', 'README.md',
                'agents', 'frameworks', 'prompts', 'skills')) {
            return $true
        }
        $agents = Join-Path $ConfigRoot 'agents'
        if ((Test-IdemPathEqual -Left $parent -Right $agents) -and
            ($leaf -ceq 'autoprompt.toml' -or $leaf -clike 'ap-*.toml')) {
            return $true
        }
        $prompts = Join-Path $ConfigRoot 'prompts'
        if ((Test-IdemPathEqual -Left $parent -Right $prompts) -and
            ($leaf -ceq 'autoprompt.md' -or $leaf -clike 'ap-*.md')) {
            return $true
        }
        $frameworks = Join-Path $ConfigRoot 'frameworks'
        if ((Test-IdemPathEqual -Left $normalizedPath -Right $frameworks) -or
            ((Test-IdemPathEqual -Left $parent -Right $frameworks) -and
                $leaf -clike '*.md')) {
            return $true
        }
        $skills = Join-Path $ConfigRoot 'skills'
        $skill = Join-Path $skills 'autoprompt'
        return (Test-IdemPathEqual -Left $normalizedPath -Right $skills) -or
            (Test-IdemPathEqual -Left $normalizedPath -Right $skill) -or
            (Test-IdemPathUnderRoot -Path $normalizedPath -Root $skill)
    }
    if ($Name -ceq 'vscode') {
        $homeDir = if ($env:HOME) { $env:HOME } else { $env:USERPROFILE }
        $copilot = Join-Path $homeDir '.copilot'
        $skill = Join-Path $copilot 'skills/autoprompt'
        if ((Test-IdemPathEqual -Left $normalizedPath -Right $copilot) -or
            (Test-IdemPathEqual -Left $normalizedPath `
                -Right (Join-Path $copilot 'skills')) -or
            (Test-IdemPathEqual -Left $normalizedPath `
                -Right (Join-Path $copilot 'agents')) -or
            (Test-IdemPathEqual -Left $normalizedPath -Right $skill) -or
            (Test-IdemPathUnderRoot -Path $normalizedPath -Root $skill)) {
            return $true
        }
        $agents = Join-Path $copilot 'agents'
        if ((Test-IdemPathEqual -Left (Split-Path -Parent $normalizedPath) `
            -Right $agents) -and
            (Split-Path -Leaf $normalizedPath) -clike 'ap-*.agent.md') {
            return $true
        }
        $settings = Get-IdemNormalizedPath -Path (Get-VscodeSettingsFile)
        if ((Test-IdemPathEqual -Left $normalizedPath -Right $settings) -or
            (Test-IdemPathEqual -Left $normalizedPath `
                -Right "$settings$AutopromptConfigEditBackupSuffix")) {
            return $true
        }
        $settingsParent = Split-Path -Parent $settings
        return (Test-IdemPathEqual -Left $normalizedPath -Right $settingsParent) -or
            (Test-IdemPathEqual -Left $normalizedPath `
                -Right (Split-Path -Parent $settingsParent))
    }
    $providerRoot = Join-Path $ConfigRoot $Name
    $homeDir = Get-ConfiguredHome
    $skillRoot = if ($Name -ceq 'kilo' -and
        -not [string]::IsNullOrEmpty($homeDir)) {
        Join-Path $homeDir '.kilo/skills/autoprompt'
    } else {
        Join-Path $providerRoot 'skills/autoprompt'
    }
    if ((Test-IdemPathEqual -Left $normalizedPath -Right $skillRoot) -or
        (Test-IdemPathUnderRoot -Path $normalizedPath -Root $skillRoot)) {
        return $true
    }
    if ($Name -ceq 'kilo') {
        if ([string]::IsNullOrEmpty($homeDir)) { return $false }
        if ((Test-IdemPathEqual -Left $normalizedPath -Right $providerRoot) -or
            (Test-IdemPathUnderRoot -Path $normalizedPath -Root $providerRoot)) {
            return $true
        }
        $kiloHome = Join-Path $homeDir '.kilo'
        $kiloSkills = Join-Path $kiloHome 'skills'
        return (Test-IdemPathEqual -Left $normalizedPath -Right $kiloHome) -or
            (Test-IdemPathEqual -Left $normalizedPath -Right $kiloSkills)
    }

    $skillsRoot = Join-Path $providerRoot 'skills'
    if ((Test-IdemPathEqual -Left $normalizedPath -Right $providerRoot) -or
        (Test-IdemPathEqual -Left $normalizedPath -Right $skillsRoot)) {
        return $true
    }

    $profile = Join-Path $providerRoot 'autoprompt.opencode.json'
    if (Test-IdemPathEqual -Left $normalizedPath -Right $profile) {
        return $true
    }
    $agentsRoot = Join-Path $providerRoot 'agents'
    if (Test-IdemPathEqual -Left $normalizedPath -Right $agentsRoot) {
        return $true
    }
    if (-not (Test-IdemPathEqual -Left (Split-Path -Parent $normalizedPath) `
        -Right $agentsRoot)) {
        return $false
    }
    return (Split-Path -Leaf $normalizedPath) -clike 'ap-*.md'
}

function Get-UninstallProviderEdits {
    param([string]$Name, [string]$ConfigRoot, [hashtable[]]$Edits)
    return @($Edits | Where-Object {
        Test-UninstallProviderPath -Name $Name -ConfigRoot $ConfigRoot -Path $_.File
    })
}

function Get-UninstallOtherProvider {
    param([string]$Name)
    if ($Name -ceq 'opencode') { return 'kilo' }
    if ($Name -ceq 'kilo') { return 'opencode' }
    return ''
}

function Test-UninstallOtherProviderPath {
    param([string]$Name, [string]$ConfigRoot, [string]$Path)
    $other = Get-UninstallOtherProvider -Name $Name
    if ([string]::IsNullOrEmpty($other)) { return $false }
    return (Test-UninstallProviderPath -Name $other -ConfigRoot $ConfigRoot `
        -Path $Path)
}

function Test-UninstallSharedProviderState {
    param([string]$Name, [string]$ConfigRoot, [hashtable]$Receipt)
    if ($Name -cnotin @(
        'claude', 'codex', 'opencode', 'kilo', 'vscode', 'vibe',
        'cursor', 'dcode', 'roo', 'gemini', 'cline', 'goose',
        'omp', 'deepseek', 'reasonix'
    )) { return $false }
    foreach ($file in @($Receipt.Files)) {
        if (-not [string]::IsNullOrEmpty($file) -and
            -not (Test-IdemPathEqual -Left $file -Right `
                (Join-Path $ConfigRoot $AutopromptHashManifestName)) -and
            -not (Test-UninstallProviderPath -Name $Name `
                -ConfigRoot $ConfigRoot -Path $file)) {
            return $true
        }
    }
    foreach ($edit in @($Receipt.Edits)) {
        if (-not (Test-UninstallProviderPath -Name $Name `
            -ConfigRoot $ConfigRoot -Path $edit.File)) {
            return $true
        }
    }
    foreach ($directory in @($Receipt.CreatedDirectories)) {
        if (-not [string]::IsNullOrEmpty($directory) -and
            -not (Test-UninstallProviderPath -Name $Name `
                -ConfigRoot $ConfigRoot -Path $directory)) {
            return $true
        }
    }
    return $false
}

function Restore-UninstallSnapshot {
    param([hashtable]$Snapshot)
    if ((Restore-IdemManagedSnapshot -Snapshot $Snapshot) -and
        (Remove-IdemManagedRecovery -Snapshot $Snapshot)) {
        return $true
    }
    Add-IdemManagedUndo -Snapshot $Snapshot
    [Console]::Error.WriteLine(
        "error=uninstall-rollback-incomplete " +
        "recovery=$($Snapshot.RecoveryPath) action=retry-uninstall"
    )
    return $false
}

function Set-UninstallProviderReceipt {
    param(
        [string]$ConfigRoot,
        [hashtable]$Receipt,
        [string[]]$Files,
        [string[]]$CreatedDirectories = @(),
        [bool]$OmpManaged = $false,
        [string]$OmpDetachedRoot = '',
        [hashtable[]]$Edits
    )
    $nonce = if ([string]::IsNullOrEmpty($Receipt.Nonce)) {
        'provider-uninstall'
    } else {
        $Receipt.Nonce
    }
    $backup = 'none'
    foreach ($edit in @($Edits)) {
        $candidate = "$($edit.File)$AutopromptConfigEditBackupSuffix"
        if ($Receipt.Backup -ceq $candidate) {
            $backup = $candidate
            break
        }
    }
    if ($backup -ceq 'none') {
        foreach ($edit in @($Edits)) {
            $candidate = "$($edit.File)$AutopromptConfigEditBackupSuffix"
            if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                $backup = $candidate
                break
            }
        }
    }
    return (Write-Receipt -ConfigRoot $ConfigRoot -Nonce $nonce -Backup $backup `
        -Files $Files -CreatedDirectories $CreatedDirectories `
        -OmpManaged $OmpManaged -OmpDetachedRoot $OmpDetachedRoot -Edits $Edits)
}

function Get-UninstallProviderPlan {
    param([string]$ConfigRoot, [string]$Name, [hashtable]$Receipt)
    $manifest = Join-Path $ConfigRoot $AutopromptHashManifestName
    $isScoped = Test-UninstallSharedProviderState -Name $Name `
        -ConfigRoot $ConfigRoot -Receipt $Receipt
    if (-not $isScoped) {
        return @{ IsScoped = $false; Manifest = $manifest
            ProviderEdits = [hashtable[]]@($Receipt.Edits)
            ProviderDirectories = [string[]]@($Receipt.CreatedDirectories)
            RetainedDirectories = [string[]]@(); RetainedEdits = [hashtable[]]@()
            RetainedFiles = [string[]]@()
            RetainedOmpManaged = $false
            RetainedOmpDetachedRoot = '' }
    }
    $providerEdits = Get-UninstallProviderEdits -Name $Name `
        -ConfigRoot $ConfigRoot -Edits ([hashtable[]]$Receipt.Edits)
    $providerDirectories = @($Receipt.CreatedDirectories | Where-Object {
        Test-UninstallProviderPath -Name $Name -ConfigRoot $ConfigRoot -Path $_
    })
    $retainedDirectories = @($Receipt.CreatedDirectories | Where-Object {
        -not (Test-UninstallProviderPath -Name $Name `
            -ConfigRoot $ConfigRoot -Path $_)
    })
    $retainedEdits = @($Receipt.Edits | Where-Object {
        -not (Test-UninstallProviderPath -Name $Name `
            -ConfigRoot $ConfigRoot -Path $_.File)
    })
    [string[]]$retainedFiles = @($Receipt.Files | Where-Object {
        -not [string]::IsNullOrEmpty($_) -and
            -not (Test-IdemPathEqual -Left $_ -Right $manifest) -and
            -not (Test-UninstallProviderPath -Name $Name `
                -ConfigRoot $ConfigRoot -Path $_)
    })
    if (Test-Path -LiteralPath $manifest -PathType Leaf) {
        $receiptManifest = @($Receipt.Files | Where-Object {
            Test-IdemPathEqual -Left $_ -Right $manifest
        } | Select-Object -First 1)
        if ($receiptManifest.Count -eq 0) { $receiptManifest = @($manifest) }
        $retainedFiles = [string[]]@($retainedFiles + $receiptManifest[0])
    }
    return @{ IsScoped = $true; Manifest = $manifest
        ProviderEdits = [hashtable[]]@($providerEdits)
        ProviderDirectories = [string[]]@($providerDirectories)
        RetainedDirectories = [string[]]@($retainedDirectories)
        RetainedEdits = [hashtable[]]@($retainedEdits)
        RetainedFiles = $retainedFiles
        RetainedOmpManaged = if ($Name -ceq 'omp') {
            $false
        } else {
            [bool]$Receipt.OmpManaged
        }
        RetainedOmpDetachedRoot = if ($Name -ceq 'omp') {
            ''
        } else {
            [string]$Receipt.OmpDetachedRoot
        } }
}

function New-UninstallSnapshot {
    param([string]$ConfigRoot, [hashtable]$Receipt)
    $script:AutopromptReceiptOmpManaged = [bool]$Receipt.OmpManaged
    $script:AutopromptReceiptCreatedDirectories = @($Receipt.CreatedDirectories)
    $script:AutopromptReceiptEdits = @($Receipt.Edits)
    $script:AutopromptConfigEditLastBackup = $Receipt.Backup
    $paths = @($Receipt.Files)
    foreach ($edit in @($Receipt.Edits)) {
        $paths += $edit.File
        $paths += "$($edit.File)$AutopromptConfigEditBackupSuffix"
    }
    if (-not [string]::IsNullOrEmpty($Receipt.Backup) -and
        $Receipt.Backup -ne 'none') {
        $paths += $Receipt.Backup
    }
    $snapshot = New-IdemManagedSnapshot -ConfigRoot $ConfigRoot -Paths $paths
    if ($null -eq $snapshot) {
        [Console]::Error.WriteLine(
            'error=uninstall-snapshot-failed action=retry-uninstall'
        )
    }
    return $snapshot
}

function Remove-UninstallProviderFiles {
    param([string]$ConfigRoot, [string]$Name, [hashtable]$Receipt,
        [hashtable]$Plan)
    $removed = 0
    $retained = 0
    foreach ($file in @($Receipt.Files)) {
        $shouldSkip = [string]::IsNullOrEmpty($file) -or
            ($Plan.IsScoped -and (Test-IdemPathEqual `
                -Left $file -Right $Plan.Manifest)) -or
            ($Plan.IsScoped -and -not (Test-UninstallProviderPath `
                -Name $Name -ConfigRoot $ConfigRoot -Path $file))
        if ($shouldSkip) { continue }
        if (-not (Test-Path -LiteralPath $file)) {
            [Console]::Out.WriteLine("uninstall-file=$file note=already-absent")
        } else {
            if ($Name -ceq 'codex') {
                $isManifest = Test-IdemPathEqual -Left $file -Right $Plan.Manifest
                $item = Get-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
                $recordedHash = if ($isManifest) { '' } else {
                    Get-IdemManifestHash -ConfigRoot $ConfigRoot -Key $file
                }
                $reason = ''
                if (-not $isManifest -and ($null -eq $item -or
                    $item -isnot [System.IO.FileInfo] -or
                    $item.Attributes.HasFlag([System.IO.FileAttributes]::ReparsePoint))) {
                    $reason = 'linked-or-unsafe'
                } elseif (-not $isManifest -and [string]::IsNullOrEmpty($recordedHash)) {
                    $reason = 'unfingerprinted'
                } elseif (-not $isManifest) {
                    $liveHash = Get-IdemSha256 -Path $file
                    if ($liveHash -is [int]) {
                        $reason = 'hash-unreadable'
                    } elseif ($liveHash -cne $recordedHash) {
                        $reason = 'hash-drift'
                    }
                }
                if (-not [string]::IsNullOrEmpty($reason)) {
                    [Console]::Out.WriteLine(
                        "uninstall-retained=$file reason=$reason ownership=relinquished"
                    )
                    $retained++
                    if ($Plan.IsScoped -and -not (Remove-IdemManifestHash `
                        -ConfigRoot $ConfigRoot -Key $file)) {
                        return @{ Code = 74; Removed = $removed; Retained = $retained }
                    }
                    continue
                }
            }
            try {
                Remove-Item -LiteralPath $file -Force -ErrorAction Stop
            } catch {
                [Console]::Error.WriteLine("error=file-remove-failed path=$file")
                [Console]::Error.WriteLine(
                    "Autoprompt uninstall: could not remove $file " +
                    '(permission denied?). Remove it manually and re-run.'
                )
                return @{ Code = 74; Removed = $removed; Retained = $retained }
            }
            $removed++
        }
        if ($Plan.IsScoped -and -not (Remove-IdemManifestHash `
            -ConfigRoot $ConfigRoot -Key $file)) {
            return @{ Code = 74; Removed = $removed; Retained = $retained }
        }
    }
    return @{ Code = 0; Removed = $removed; Retained = $retained }
}

function Set-UninstallFinalReceipt {
    param([string]$ConfigRoot, [hashtable]$Receipt, [hashtable]$Plan)
    $receiptPath = Join-Path $ConfigRoot $AutopromptReceiptName
    if ($Plan.IsScoped) {
        $code = Set-UninstallProviderReceipt -ConfigRoot $ConfigRoot `
            -Receipt $Receipt -Files $Plan.RetainedFiles `
            -CreatedDirectories $Plan.RetainedDirectories `
            -OmpManaged $Plan.RetainedOmpManaged `
            -OmpDetachedRoot $Plan.RetainedOmpDetachedRoot `
            -Edits ([hashtable[]]$Plan.RetainedEdits)
        return $code -eq 0
    }
    if (-not (Test-Path -LiteralPath $receiptPath -PathType Leaf)) {
        return $true
    }
    try {
        Remove-Item -LiteralPath $receiptPath -Force -ErrorAction Stop
    } catch {
        return $false
    }
    return $true
}

function Uninstall-Client {
    param([string]$ConfigRoot, [string]$Name)
    if ([string]::IsNullOrEmpty($ConfigRoot)) {
        [Console]::Error.WriteLine('error=no-config-root')
        [Console]::Error.WriteLine(
            'Autoprompt uninstall: a config-root is required ' +
            '(the directory holding the install receipt).'
        )
        return 70
    }
    $receipt = Read-UninstallReceipt -ConfigRoot $ConfigRoot
    if ($receipt -is [int]) { return $receipt }
    $plan = Get-UninstallProviderPlan -ConfigRoot $ConfigRoot `
        -Name $Name -Receipt $receipt
    $snapshot = New-UninstallSnapshot -ConfigRoot $ConfigRoot -Receipt $receipt
    if ($null -eq $snapshot) { return 74 }
    $editCode = Restore-UninstallConfigEdits `
        -Edits ([hashtable[]]$plan.ProviderEdits)
    if ($editCode -ne 0) {
        if (-not (Restore-UninstallSnapshot -Snapshot $snapshot)) { return 77 }
        return $editCode
    }
    $removal = Remove-UninstallProviderFiles -ConfigRoot $ConfigRoot `
        -Name $Name -Receipt $receipt -Plan $plan
    if ($removal.Code -ne 0 -or
        -not (Remove-UninstallEmptyDirs -ConfigRoot $ConfigRoot `
            -CreatedDirectories $plan.ProviderDirectories -Name $Name) -or
        -not (Set-UninstallFinalReceipt -ConfigRoot $ConfigRoot `
            -Receipt $receipt -Plan $plan)) {
        if (-not (Restore-UninstallSnapshot -Snapshot $snapshot)) { return 77 }
        return 74
    }
    if (-not (Remove-IdemManagedRecovery -Snapshot $snapshot)) {
        [Console]::Error.WriteLine(
            "error=uninstall-cleanup-failed recovery=$($snapshot.RecoveryPath) " +
            'action=retry-uninstall'
        )
        Restore-UninstallSnapshot -Snapshot $snapshot | Out-Null
        return 77
    }
    $summary = "client=$Name uninstall=ok removed=$($removal.Removed) "
    if ($Name -ceq 'codex') { $summary += "retained=$($removal.Retained) " }
    $summary += "restored-edits=$($script:UninstallRestoredEditFiles)"
    [Console]::Out.WriteLine($summary)
    return 0
}

function ConvertTo-AutopromptNativePath {
    param([string]$Path)
    if ([string]::IsNullOrEmpty($Path) -or
        -not (Test-AutopromptWindowsHost)) {
        return $Path
    }
    $match = [regex]::Match($Path, '^/([A-Za-z])(?:/(.*))?$')
    if (-not $match.Success) { return $Path }
    $native = $match.Groups[1].Value.ToUpperInvariant() + ':\'
    $tail = $match.Groups[2].Value
    if (-not [string]::IsNullOrEmpty($tail)) {
        $native += $tail.Replace('/', '\')
    }
    return $native
}

function Get-IdemNormalizedPath {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return '' }
    try {
        $nativePath = ConvertTo-AutopromptNativePath -Path $Path
        $fullPath = [System.IO.Path]::GetFullPath($nativePath)
        $pathRoot = [System.IO.Path]::GetPathRoot($fullPath)
        if ($fullPath.Length -eq $pathRoot.Length) { return $pathRoot }
        return $fullPath.TrimEnd([char]92, [char]47)
    } catch {
        return ''
    }
}

function Test-IdemAbsolutePath {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    try {
        if (-not [System.IO.Path]::IsPathRooted($Path)) { return $false }
    } catch {
        return $false
    }
    return $Path -cnotmatch '^[A-Za-z]:[^\\/]'
}

function Test-IdemPathUnderRoot {
    param([string]$Path, [string]$Root)
    if (-not (Test-IdemAbsolutePath -Path $Path) -or
        -not (Test-IdemAbsolutePath -Path $Root)) {
        return $false
    }
    $normalizedPath = Get-IdemNormalizedPath -Path $Path
    $normalizedRoot = Get-IdemNormalizedPath -Path $Root
    if ([string]::IsNullOrEmpty($normalizedPath) -or
        [string]::IsNullOrEmpty($normalizedRoot)) {
        return $false
    }
    $prefix = $normalizedRoot + [System.IO.Path]::DirectorySeparatorChar
    return $normalizedPath.StartsWith($prefix, (Get-IdemPathComparison))
}

$script:AutopromptPhysicalPathMaxDepth = 40
function Get-IdemPhysicalPath {
    param([string]$Path, [int]$Depth = 0)
    if ($Depth -gt $script:AutopromptPhysicalPathMaxDepth -or
        -not (Test-IdemAbsolutePath -Path $Path)) {
        return ''
    }
    $normalized = Get-IdemNormalizedPath -Path $Path
    if ([string]::IsNullOrEmpty($normalized)) { return '' }
    $root = [System.IO.Path]::GetPathRoot($normalized)
    $current = $root
    $relative = $normalized.Substring($root.Length)
    foreach ($segment in @($relative -split '[\\/]' | Where-Object { $_ })) {
        $current = Join-Path $current $segment
        try {
            $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
        } catch {
            $item = $null
        }
        if ($null -eq $item -or
            -not ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
            continue
        }
        $target = [string]@($item.Target)[0]
        if ([string]::IsNullOrEmpty($target)) { return '' }
        if (-not (Test-IdemAbsolutePath -Path $target)) {
            $target = Join-Path (Split-Path -Parent $current) $target
        }
        $current = Get-IdemPhysicalPath -Path $target -Depth ($Depth + 1)
        if ([string]::IsNullOrEmpty($current)) { return '' }
    }
    return Get-IdemNormalizedPath -Path $current
}

function Test-IdemReceiptPathUnderRoot {
    param([string]$Path, [string]$Root)
    if (-not (Test-IdemPathUnderRoot -Path $Path -Root $Root)) {
        return $false
    }
    $physicalPath = Get-IdemPhysicalPath -Path $Path
    $physicalRoot = Get-IdemPhysicalPath -Path $Root
    return -not [string]::IsNullOrEmpty($physicalPath) -and
        -not [string]::IsNullOrEmpty($physicalRoot) -and
        (Test-IdemPathUnderRoot -Path $physicalPath -Root $physicalRoot)
}

function Test-UninstallReceiptPaths {
    param(
        [string]$ConfigRoot,
        [string]$Backup,
        [string[]]$Files,
        [string[]]$CreatedDirectories,
        [string]$OmpDetachedRoot,
        [hashtable[]]$Edits
    )
    $paths = @($Files) + @($CreatedDirectories) + @($Edits | ForEach-Object {
        $_.File
    })
    if (-not [string]::IsNullOrEmpty($OmpDetachedRoot) -and
        -not (Test-AutopromptOmpDetachedManifestAuthority `
            -ConfigRoot $ConfigRoot -OmpDetachedRoot $OmpDetachedRoot `
            -Files $Files)) {
        return $false
    }
    if (-not [string]::IsNullOrEmpty($OmpDetachedRoot)) {
        foreach ($directory in @($CreatedDirectories)) {
            if ((Test-IdemReceiptPathUnderRoot `
                    -Path $directory -Root $ConfigRoot) -or
                -not (Test-AutopromptOmpDetachedReceiptPath `
                    -Path $directory -DefaultAgentRoot $OmpDetachedRoot)) {
                continue
            }
            if (-not (Test-AutopromptOmpDetachedDirectory `
                -Path $directory -DefaultAgentRoot $OmpDetachedRoot)) {
                return $false
            }
        }
        foreach ($edit in @($Edits)) {
            if (-not (Test-IdemReceiptPathUnderRoot `
                    -Path $edit.File -Root $ConfigRoot) -and
                (Test-AutopromptOmpDetachedReceiptPath `
                    -Path $edit.File -DefaultAgentRoot $OmpDetachedRoot)) {
                return $false
            }
        }
        if (-not [string]::IsNullOrEmpty($Backup) -and $Backup -cne 'none' -and
            -not (Test-IdemReceiptPathUnderRoot `
                -Path $Backup -Root $ConfigRoot) -and
            (Test-AutopromptOmpDetachedReceiptPath `
                -Path $Backup -DefaultAgentRoot $OmpDetachedRoot)) {
            return $false
        }
    }
    foreach ($path in $paths) {
        if (-not (Test-UninstallReceiptPathAllowed -Path $path `
            -Root $ConfigRoot -OmpDetachedRoot $OmpDetachedRoot)) {
            return $false
        }
    }
    return [string]::IsNullOrEmpty($Backup) -or $Backup -ceq 'none' -or
        (Test-UninstallReceiptPathAllowed -Path $Backup -Root $ConfigRoot `
            -OmpDetachedRoot $OmpDetachedRoot)
}

function Test-AutopromptOmpDetachedNativePath {
    param([string]$Path, [string]$DefaultAgentRoot)
    $defaultAgentRoot = Get-IdemNormalizedPath -Path $DefaultAgentRoot
    $normalizedPath = Get-IdemNormalizedPath -Path $Path
    if ([string]::IsNullOrEmpty($defaultAgentRoot) -or
        [string]::IsNullOrEmpty($normalizedPath)) {
        return $false
    }
    $nativeAgents = Join-Path $defaultAgentRoot 'agents'
    if (-not (Test-IdemPathEqual -Left $normalizedPath -Right $nativeAgents) -and
        -not (Test-IdemPathUnderRoot `
            -Path $normalizedPath -Root $nativeAgents)) {
        return $false
    }
    $physicalPath = Get-IdemPhysicalPath -Path $normalizedPath
    $physicalRoot = Get-IdemPhysicalPath -Path $defaultAgentRoot
    return -not [string]::IsNullOrEmpty($physicalPath) -and
        -not [string]::IsNullOrEmpty($physicalRoot) -and
        (Test-IdemPathUnderRoot -Path $physicalPath -Root $physicalRoot)
}

function Test-AutopromptOmpDetachedReceiptPath {
    param([string]$Path, [string]$DefaultAgentRoot)
    $defaultAgentRoot = Get-IdemNormalizedPath -Path $DefaultAgentRoot
    $normalizedPath = Get-IdemNormalizedPath -Path $Path
    if ([string]::IsNullOrEmpty($defaultAgentRoot) -or
        [string]::IsNullOrEmpty($normalizedPath) -or
        (Split-Path -Leaf $defaultAgentRoot) -cne 'agent') {
        return $false
    }
    $homeDir = Get-ConfiguredHome
    if ([string]::IsNullOrEmpty($homeDir) -or
        (Test-IdemPathEqual -Left (Split-Path -Parent $defaultAgentRoot) `
            -Right $homeDir) -or
        -not (Test-IdemReceiptPathUnderRoot `
            -Path $defaultAgentRoot -Root $homeDir)) {
        return $false
    }
    $configDirectory = Split-Path -Parent $defaultAgentRoot
    return (Test-IdemPathEqual -Left $normalizedPath -Right $configDirectory) -or
        (Test-IdemPathEqual -Left $normalizedPath -Right $defaultAgentRoot) -or
        (Test-AutopromptOmpDetachedNativePath `
            -Path $normalizedPath -DefaultAgentRoot $defaultAgentRoot)
}

function Test-AutopromptOmpDetachedManifestAuthority {
    param(
        [string]$ConfigRoot,
        [string]$OmpDetachedRoot,
        [string[]]$Files
    )
    $ompDetachedRoot = Get-IdemNormalizedPath -Path $OmpDetachedRoot
    if ([string]::IsNullOrEmpty($ompDetachedRoot) -or
        -not (Test-AutopromptOmpDetachedReceiptPath `
            -Path $ompDetachedRoot -DefaultAgentRoot $ompDetachedRoot)) {
        return $false
    }
    try {
        $entries = Read-IdemManifestEntries -ConfigRoot $ConfigRoot
    } catch {
        return $false
    }
    $nativeAgents = Join-Path $ompDetachedRoot 'agents'
    $nativeEntries = @($entries.Keys | Where-Object {
        $entryPath = Get-IdemNormalizedPath -Path ([string]$_)
        -not [string]::IsNullOrEmpty($entryPath) -and
            (Test-AutopromptOmpDetachedNativePath `
                -Path $entryPath -DefaultAgentRoot $ompDetachedRoot) -and
            (Test-IdemPathEqual -Left (Split-Path -Parent $entryPath) `
                -Right $nativeAgents) -and
            (Split-Path -Leaf $entryPath) -clike 'ap-*.md'
    })
    if ($nativeEntries.Count -ne 25) { return $false }
    foreach ($entry in $nativeEntries) {
        $receiptMatches = @($Files | Where-Object {
            Test-IdemPathEqual -Left $_ -Right ([string]$entry)
        })
        if ($receiptMatches.Count -ne 1) { return $false }
    }
    foreach ($file in @($Files)) {
        if (Test-IdemReceiptPathUnderRoot -Path $file -Root $ConfigRoot) {
            continue
        }
        if (-not (Test-AutopromptOmpDetachedReceiptPath -Path $file `
            -DefaultAgentRoot $ompDetachedRoot)) {
            continue
        }
        $matches = @(Get-IdemManifestMatchingKeys -Entries $entries -Key $file `
            -ConfigRoot $ConfigRoot)
        if ($matches.Count -ne 1 -or
            [string]::IsNullOrEmpty([string]$entries[$matches[0]])) {
            return $false
        }
    }
    return $true
}

function Test-AutopromptLegacySelfContainedOmpAuthority {
    param([string]$ConfigRoot, [string[]]$Files, [hashtable[]]$Edits)
    $config = Join-Path $ConfigRoot 'config.yml'
    foreach ($edit in @($Edits)) {
        if ($edit.Key -ceq 'task.maxRecursionDepth' -and
            (Test-IdemPathEqual -Left $edit.File -Right $config)) {
            return $true
        }
    }
    $agents = Join-Path $ConfigRoot 'agents'
    foreach ($file in @($Files)) {
        if (-not (Test-IdemPathEqual -Left (Split-Path -Parent $file) `
                -Right $agents) -or
            (Split-Path -Leaf $file) -cnotlike 'ap-*.md') {
            continue
        }
        $source = Join-Path (Join-Path $AutopromptInstallRepoRoot `
            'agents/omp/agents') (Split-Path -Leaf $file)
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { continue }
        try {
            $recordedHash = Get-IdemManifestHash `
                -ConfigRoot $ConfigRoot -Key $file
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

function Get-AutopromptLegacyOmpDetachedRoot {
    param([string]$ConfigRoot, [string[]]$Files)
    try {
        $entries = Read-IdemManifestEntries -ConfigRoot $ConfigRoot
    } catch {
        return ''
    }
    $candidate = ''
    $count = 0
    foreach ($entry in $entries.Keys) {
        $path = Get-IdemNormalizedPath -Path ([string]$entry)
        if ([string]::IsNullOrEmpty($path) -or
            (Split-Path -Leaf $path) -cnotlike 'ap-*.md') {
            continue
        }
        $nativeAgents = Split-Path -Parent $path
        $defaultAgentRoot = Split-Path -Parent $nativeAgents
        if ((Split-Path -Leaf $nativeAgents) -cne 'agents' -or
            (Split-Path -Leaf $defaultAgentRoot) -cne 'agent' -or
            -not (Test-AutopromptOmpDetachedReceiptPath `
                -Path $defaultAgentRoot -DefaultAgentRoot $defaultAgentRoot)) {
            continue
        }
        if (-not [string]::IsNullOrEmpty($candidate) -and
            -not (Test-IdemPathEqual -Left $candidate -Right $defaultAgentRoot)) {
            return ''
        }
        $candidate = $defaultAgentRoot
        $count++
    }
    if ([string]::IsNullOrEmpty($candidate) -or $count -ne 25 -or
        -not (Test-AutopromptOmpDetachedManifestAuthority `
            -ConfigRoot $ConfigRoot -OmpDetachedRoot $candidate -Files $Files)) {
        return ''
    }
    return $candidate
}

function Test-AutopromptOmpDetachedDirectory {
    param([string]$Path, [string]$DefaultAgentRoot)
    $defaultAgentRoot = Get-IdemNormalizedPath -Path $DefaultAgentRoot
    $normalizedPath = Get-IdemNormalizedPath -Path $Path
    if ([string]::IsNullOrEmpty($defaultAgentRoot) -or
        [string]::IsNullOrEmpty($normalizedPath)) {
        return $false
    }
    $configDirectory = Split-Path -Parent $defaultAgentRoot
    $nativeAgents = Join-Path $defaultAgentRoot 'agents'
    $isKnownDirectory = (Test-IdemPathEqual `
            -Left $normalizedPath -Right $configDirectory) -or
        (Test-IdemPathEqual -Left $normalizedPath -Right $defaultAgentRoot) -or
        (Test-IdemPathEqual -Left $normalizedPath -Right $nativeAgents)
    return $isKnownDirectory -and
        (Test-AutopromptOmpDetachedReceiptPath `
            -Path $normalizedPath -DefaultAgentRoot $defaultAgentRoot)
}

function Test-UninstallReceiptPathAllowed {
    param([string]$Path, [string]$Root, [string]$OmpDetachedRoot = '')
    if (Test-IdemReceiptPathUnderRoot -Path $Path -Root $Root) { return $true }
    if (-not [string]::IsNullOrEmpty($OmpDetachedRoot) -and
        (Test-AutopromptOmpDetachedReceiptPath -Path $Path `
            -DefaultAgentRoot $OmpDetachedRoot)) {
        return $true
    }
    if (Test-AutopromptInstallRootOverridePresent) {
        if ($script:AutopromptInstallRootClient -ceq 'vscode') {
            $settings = Get-VscodeSettingsFile
            return (Test-IdemPathEqual -Left $Path -Right $settings) -or
                (Test-IdemPathEqual -Left $Path `
                    -Right "$settings$AutopromptConfigEditBackupSuffix")
        }
        return $false
    }
    $homeDir = Get-ConfiguredHome
    if ([string]::IsNullOrEmpty($homeDir)) { return $false }
    $kiloHome = Join-Path $homeDir '.kilo'
    $kiloSkills = Join-Path $kiloHome 'skills'
    $kiloSkill = Join-Path $kiloSkills 'autoprompt'
    if ((Test-IdemPathEqual -Left $Path -Right $kiloHome) -or
        (Test-IdemPathEqual -Left $Path -Right $kiloSkills)) {
        return $true
    }
    if (Test-IdemPathEqual -Left $Path -Right $kiloSkill) { return $true }
    if (Test-IdemReceiptPathUnderRoot -Path $Path -Root $kiloSkill) {
        return $true
    }
    $settings = Get-VscodeSettingsFile
    return (Test-IdemPathEqual -Left $Path -Right $settings) -or
        (Test-IdemPathEqual -Left $Path `
            -Right "$settings$AutopromptConfigEditBackupSuffix")
}

function Test-AutopromptManagedInstallPathAllowed {
    param([string]$Path, [string]$Root)
    if (Test-UninstallReceiptPathAllowed -Path $Path -Root $Root `
        -OmpDetachedRoot $script:AutopromptReceiptOmpDetachedRoot) {
        return $true
    }
    if (-not $env:PI_CODING_AGENT_DIR -or
        (Test-AutopromptInstallRootOverridePresent)) {
        return $false
    }
    $profile = Get-AutopromptOmpProfile
    if (-not [string]::IsNullOrEmpty($profile) -or
        -not (Test-IdemPathEqual -Left $Root `
            -Right (Get-AutopromptConfigRoot -Name 'omp'))) {
        return $false
    }
    $currentRoot = Get-AutopromptOmpDefaultAgentRoot
    if (-not [string]::IsNullOrEmpty(
        $script:AutopromptReceiptOmpDetachedRoot
    ) -and -not (Test-IdemPathEqual `
        -Left $script:AutopromptReceiptOmpDetachedRoot -Right $currentRoot)) {
        [Console]::Error.WriteLine(
            'error=omp-detached-root-drift ' +
            "recorded=$script:AutopromptReceiptOmpDetachedRoot " +
            "current=$currentRoot action=uninstall-first"
        )
        return $false
    }
    return Test-AutopromptOmpDetachedReceiptPath -Path $Path `
        -DefaultAgentRoot $currentRoot
}

function Test-RepairProviderPath {
    param([string]$Name, [string]$ConfigRoot, [string]$Path, [string]$Landed)
    return Test-UninstallProviderPath -Name $Name `
        -ConfigRoot $ConfigRoot -Path $Path
}

function ConvertTo-OrderedRepairCandidates {
    param([System.Collections.IDictionary]$Candidates)
    $keys = [string[]]@($Candidates.Keys)
    [Array]::Sort($keys, [System.StringComparer]::Ordinal)
    $ordered = New-Object System.Collections.Specialized.OrderedDictionary `
        (Get-IdemPathComparer)
    $identities = New-Object 'System.Collections.Generic.HashSet[string]' `
        (Get-IdemPathComparer)
    foreach ($key in $keys) {
        $normalized = Get-IdemNormalizedPath -Path $key
        if ([string]::IsNullOrEmpty($normalized) -or
            -not $identities.Add($normalized)) {
            throw "duplicate or invalid repair target: $key"
        }
        $ordered.Add($normalized, $Candidates[$key])
    }
    return $ordered
}

function New-RepairRuntimeCandidates {
    param([string]$Name, [string]$Landed, [string]$StageRoot)
    $tool = Join-Path $AutopromptInstallRepoRoot 'scripts/runtime-payload.cjs'
    $stageSkill = Join-Path $StageRoot 'skills/autoprompt'
    $liveSkill = Split-Path -Parent $Landed
    if (-not (Get-Command node -ErrorAction SilentlyContinue) -or
        -not (Test-Path -LiteralPath $tool -PathType Leaf)) {
        throw 'runtime payload tool unavailable'
    }
    & node $tool --install $Name --destination $stageSkill | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'runtime payload stage failed' }
    & node $tool --verify $Name --destination $stageSkill | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'runtime payload verification failed' }
    $relativeFiles = @(& node $tool --list $Name)
    if ($LASTEXITCODE -ne 0) { throw 'runtime payload inventory failed' }
    $candidates = @{}
    foreach ($relativePath in $relativeFiles) {
        if ([string]::IsNullOrEmpty($relativePath)) { continue }
        $nativeRelative = $relativePath -replace '/', `
            [IO.Path]::DirectorySeparatorChar
        $candidates[(Join-Path $liveSkill $nativeRelative)] =
            Join-Path $stageSkill $nativeRelative
    }
    return @{ Candidates = $candidates; StageSkill = $stageSkill
        LiveSkill = $liveSkill }
}

function Add-RepairPersonaCandidates {
    param([hashtable]$Candidates, [object[]]$Personas, [string]$Target)
    foreach ($persona in $Personas) {
        $Candidates[(Join-Path $Target $persona.Name)] = $persona.FullName
    }
}

function Add-DeepSeekRepairCandidates {
    param([hashtable]$Candidates, [string]$ConfigRoot, [string]$StageSkill)
    $sourceRoot = Join-Path $StageSkill 'agent-preset'
    $targetRoot = Join-Path $ConfigRoot '.agent-presets/autoprompt'
    foreach ($name in @('agent.cordis.yml', 'preset.yml')) {
        $source = Join-Path $sourceRoot $name
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
            throw "DeepSeek preset stage missing: $name"
        }
        $Candidates[(Join-Path $targetRoot $name)] = $source
    }
}

function Add-ReasonixRepairCandidates {
    param([hashtable]$Candidates, [string]$ConfigRoot, [string]$StageSkill)
    $sourceRoot = Join-Path $StageSkill 'skills'
    $personas = @(Get-ChildItem -LiteralPath $sourceRoot -Directory |
        Where-Object { $_.Name -clike 'ap-*' } |
        ForEach-Object {
            Get-Item -LiteralPath (Join-Path $_.FullName 'SKILL.md') `
                -ErrorAction Stop
        })
    if ($personas.Count -ne 25) { throw 'Reasonix skill inventory incomplete' }
    foreach ($persona in $personas) {
        $target = Join-Path (Join-Path $ConfigRoot 'skills') `
            (Join-Path $persona.Directory.Name 'SKILL.md')
        $Candidates[$target] = $persona.FullName
    }
}

function Add-CodexRepairCandidates {
    param([hashtable]$Candidates, [string]$ConfigRoot, [string]$LiveSkill,
        [string]$StageSkill, [string]$StageRoot)
    $sourceAgents = Join-Path $AutopromptInstallRepoRoot 'agents/codex/agents'
    $castingTool = Join-Path $StageSkill 'workflow/codex-agent-casting.js'
    $profileTool = Join-Path $StageSkill 'workflow/codex-agent-profile.js'
    $stageAgents = Join-Path $StageSkill 'agents-runtime'
    $stageProfile = Join-Path $StageRoot 'autoprompt.config.toml'
    $hadAgentsDirectory = Test-Path Env:CODEX_AGENTS_DIR
    $previousAgentsDirectory = $env:CODEX_AGENTS_DIR
    try {
        $env:CODEX_AGENTS_DIR = $stageAgents
        New-Item -ItemType Directory -Path $stageAgents -Force | Out-Null
        $sourceRoles = @(Get-ChildItem -LiteralPath $sourceAgents `
            -Filter 'ap-*.toml' -File)
        try {
            $policy = Get-Content -LiteralPath (Join-Path $sourceAgents `
                'role-policy.json') -Raw | ConvertFrom-Json
            $expectedRoles = @($policy.physical_roles.psobject.Properties).Count
        } catch { throw 'canonical Codex role policy is unreadable' }
        if ($expectedRoles -le 0 -or $sourceRoles.Count -ne $expectedRoles) {
            throw "canonical Codex role inventory is incomplete (found=$($sourceRoles.Count) expected=$expectedRoles)"
        }
        foreach ($sourceRole in $sourceRoles) {
            Copy-Item -LiteralPath $sourceRole.FullName `
                -Destination (Join-Path $stageAgents $sourceRole.Name) -ErrorAction Stop
        }
        & node $castingTool --write-manifest --agents-dir $stageAgents `
            --selector off | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'generated Codex agent stage failed' }
        & node $profileTool --write --agents-dir $stageAgents `
            --profile $stageProfile | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'generated Codex profile stage failed' }
        & node $castingTool --resolve --agents-dir $stageAgents `
            --selector off | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw 'generated Codex agent verification failed'
        }
        & node $profileTool --verify --agents-dir $stageAgents `
            --profile $stageProfile | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw 'generated Codex profile verification failed'
        }
    } finally {
        if ($hadAgentsDirectory) { $env:CODEX_AGENTS_DIR = $previousAgentsDirectory }
        else { Remove-Item Env:CODEX_AGENTS_DIR -ErrorAction SilentlyContinue }
    }
    $generatedFiles = @(Get-ChildItem -LiteralPath $stageAgents `
        -Filter 'ap-*.toml' -File) + @(
        Get-Item -LiteralPath (Join-Path $stageAgents '.autoprompt-casting.json')
    )
    foreach ($generated in $generatedFiles) {
        $target = Join-Path (Join-Path $LiveSkill 'agents-runtime') $generated.Name
        $Candidates[$target] = $generated.FullName
    }
    $Candidates[(Join-Path $ConfigRoot 'autoprompt.config.toml')] = $stageProfile
}

function New-RepairManagedPayload {
    param([string]$Name, [string]$ConfigRoot, [string]$Landed,
        [string]$StageRoot)
    $candidates = @{}
    if ($Name -notin @(
        'claude', 'codex', 'opencode', 'kilo',
        'omp', 'deepseek', 'reasonix'
    )) {
        return ConvertTo-OrderedRepairCandidates -Candidates $candidates
    }
    $runtime = New-RepairRuntimeCandidates -Name $Name -Landed $Landed `
        -StageRoot $StageRoot
    $candidates = $runtime.Candidates
    $personas = @(Get-OpencodeAgentFiles `
        -SourceDir (Join-Path $runtime.StageSkill 'agents'))
    if ($Name -in @('opencode', 'kilo', 'omp') -and $personas.Count -ne 25) {
        throw "$Name agent inventory incomplete"
    }
    if ($Name -eq 'claude') {
        Add-RepairPersonaCandidates -Candidates $candidates `
            -Personas $personas `
            -Target (Get-AutopromptNativeAgentsRoot -Name 'claude')
    } elseif ($Name -in @('opencode', 'kilo')) {
        Add-RepairPersonaCandidates -Candidates $candidates `
            -Personas $personas `
            -Target (Get-AutopromptNativeAgentsRoot -Name $Name)
        $profileName = if ($Name -eq 'kilo') {
            'autoprompt.kilo.json'
        } else {
            'autoprompt.opencode.json'
        }
        $stageProfile = Join-Path $StageRoot $profileName
        $profileWritten = if ($Name -eq 'kilo') {
            Write-KiloProfilePolicy -Path $stageProfile
        } else {
            Write-OpencodeProfilePolicy -Path $stageProfile
        }
        if (-not $profileWritten) { throw "$Name profile stage failed" }
        $profile = Get-AutopromptProfileFile -Name $Name
        $candidates[$profile] = $stageProfile
    } elseif ($Name -eq 'codex') {
        Add-CodexRepairCandidates -Candidates $candidates `
            -ConfigRoot $ConfigRoot -LiveSkill $runtime.LiveSkill `
            -StageSkill $runtime.StageSkill -StageRoot $StageRoot
    } elseif ($Name -eq 'omp') {
        $detachedRoot = Get-IdemNormalizedPath `
            -Path $script:AutopromptReceiptOmpDetachedRoot
        $nativeAgents = if (-not [string]::IsNullOrEmpty($detachedRoot)) {
            $candidate = Join-Path $detachedRoot 'agents'
            if (-not (Test-AutopromptOmpDetachedNativePath `
                -Path $candidate -DefaultAgentRoot $detachedRoot)) {
                throw 'OMP detached agents root failed physical containment'
            }
            $candidate
        } else {
            Get-AutopromptNativeAgentsRoot -Name 'omp'
        }
        Add-RepairPersonaCandidates -Candidates $candidates `
            -Personas $personas `
            -Target $nativeAgents
    } elseif ($Name -eq 'deepseek') {
        Add-DeepSeekRepairCandidates -Candidates $candidates `
            -ConfigRoot $ConfigRoot -StageSkill $runtime.StageSkill
    } else {
        Add-ReasonixRepairCandidates -Candidates $candidates `
            -ConfigRoot $ConfigRoot -StageSkill $runtime.StageSkill
    }
    return ConvertTo-OrderedRepairCandidates -Candidates $candidates
}

function Set-RepairReceiptState {
    param([hashtable]$Receipt)
    $script:AutopromptReceiptFiles = @($Receipt.Files)
    $script:AutopromptReceiptCreatedDirectories = @($Receipt.CreatedDirectories)
    $script:AutopromptReceiptEdits = @($Receipt.Edits)
    $script:AutopromptReceiptOmpManaged = [bool]$Receipt.OmpManaged
    $script:AutopromptReceiptOmpDetachedRoot = $Receipt.OmpDetachedRoot
    $script:AutopromptConfigEditLastBackup = $Receipt.Backup
}

function New-RepairSkillContext {
    param([string]$Name, [string]$SkillName, [string]$Description,
        [string]$Body, [string]$Variant)
    $resolve = Get-PrecheckUpstream -Call {
        Resolve-Destination -Name $Name -Variant $Variant
    }
    if ($resolve.Code -ne 0) { return @{ Code = $resolve.Code } }
    $destination = Get-CopyDestination -Record $resolve.Record
    $render = Get-CopyRender -Call {
        Format-Skill -Format $destination.Format -Name $SkillName `
            -Description $Description -Body $Body
    }
    if ($render.Code -ne 0) { return @{ Code = $render.Code } }
    $stage = Join-Path ([System.IO.Path]::GetTempPath()) `
        ("clrepair_" + [guid]::NewGuid().ToString('N'))
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($stage, $render.Rendered, $encoding)
    $payloadHash = Get-IdemSha256 -Path $stage
    if ($payloadHash -is [int]) {
        Remove-Item -LiteralPath $stage -Force -ErrorAction SilentlyContinue
        return @{ Code = $payloadHash }
    }
    return @{ Code = 0; Stage = $stage; Landed = $destination.Landed
        PayloadHash = $payloadHash }
}

function Get-RepairFileState {
    param([string]$Name, [string]$ConfigRoot, [string]$Path,
        [string]$Landed)
    if ([string]::IsNullOrEmpty($Path) -or
        $Path.TrimEnd('\', '/').EndsWith(
            $AutopromptHashManifestName,
            [System.StringComparison]::Ordinal
        ) -or -not (Test-RepairProviderPath -Name $Name `
            -ConfigRoot $ConfigRoot -Path $Path -Landed $Landed)) {
        return @{ Code = 0; Outcome = 'skip' }
    }
    $recordedHash = Get-IdemManifestHash -ConfigRoot $ConfigRoot -Key $Path
    if ($recordedHash -eq '') {
        [Console]::Out.WriteLine(
            "client=$Name repair=unfingerprinted dest=$Path"
        )
        return @{ Code = 0; Outcome = 'unfingerprinted' }
    }
    $liveHash = ''
    $fileExists = Test-Path -LiteralPath $Path -PathType Leaf
    if ($fileExists) {
        $liveHash = Get-IdemSha256 -Path $Path
        if ($liveHash -is [int]) { return @{ Code = $liveHash } }
    }
    if ($liveHash -eq $recordedHash) {
        [Console]::Out.WriteLine(
            "client=$Name repair=ok dest=$Path hash=$recordedHash"
        )
        return @{ Code = 0; Outcome = 'ok' }
    }
    $reason = if ($fileExists) { 'hash-drift' } else { 'missing-file' }
    return @{ Code = 0; Outcome = 'restore'; RecordedHash = $recordedHash
        Reason = $reason }
}

function Restore-RepairSkillFile {
    param([hashtable]$Context, [string]$ConfigRoot, [string]$Name,
        [string]$SkillName, [string]$Description, [string]$Body,
        [string]$Variant, [string]$RecordedHash)
    if ($Context.PayloadHash -ne $RecordedHash) {
        [Console]::Error.WriteLine(
            "client=$Name repair=refused dest=$($Context.Landed) " +
            "recorded=$RecordedHash would-be=$($Context.PayloadHash) " +
            'reason=payload-mismatch'
        )
        [Console]::Error.WriteLine(
            'Autoprompt repair: the supplied payload renders to ' +
            "$($Context.PayloadHash) but the recorded hash is $RecordedHash " +
            "for $($Context.Landed) - refusing to write " +
            '(supply the matching payload).'
        )
        return 76
    }
    $install = Get-CopyRender -Call {
        Install-Idempotent -ConfigRoot $ConfigRoot -Name $Name `
            -SkillName $SkillName -Description $Description `
            -Body $Body -Variant $Variant
    }
    if ($install.Code -eq 0) { return 0 }
    [Console]::Error.WriteLine(
        "client=$Name repair=failed dest=$($Context.Landed) " +
        "reason=delegate-rc=$($install.Code)"
    )
    return 73
}

function Get-RepairManagedCandidate {
    param([hashtable]$Context, [string]$Name, [string]$ConfigRoot,
        [string]$Landed, [string]$Path)
    if ([string]::IsNullOrEmpty($Context.ManagedStage)) {
        $Context.ManagedStage = Join-Path ([System.IO.Path]::GetTempPath()) `
            ("clrepair_payload_" + [guid]::NewGuid().ToString('N'))
        try {
            New-Item -ItemType Directory -Path $Context.ManagedStage -Force `
                -ErrorAction Stop | Out-Null
            $Context.Candidates = New-RepairManagedPayload -Name $Name `
                -ConfigRoot $ConfigRoot -Landed $Landed `
                -StageRoot $Context.ManagedStage
        } catch {
            [Console]::Error.WriteLine(
                "client=$Name repair=failed reason=candidate-stage-failed"
            )
            return @{ Code = 73 }
        }
    }
    $candidate = $Context.Candidates[(Get-IdemNormalizedPath -Path $Path)]
    return @{ Code = 0; Path = $candidate }
}

function Restore-RepairManagedFile {
    param([hashtable]$Context, [string]$Name, [string]$ConfigRoot,
        [string]$Landed, [string]$Path, [string]$RecordedHash)
    $candidate = Get-RepairManagedCandidate -Context $Context -Name $Name `
        -ConfigRoot $ConfigRoot -Landed $Landed -Path $Path
    if ($candidate.Code -ne 0) { return $candidate.Code }
    if ([string]::IsNullOrEmpty($candidate.Path) -or
        -not (Test-Path -LiteralPath $candidate.Path -PathType Leaf)) {
        [Console]::Error.WriteLine(
            "client=$Name repair=refused dest=$Path recorded=$RecordedHash " +
            'reason=cannot-remint-non-skill'
        )
        return 76
    }
    $sourceHash = Get-IdemSha256 -Path $candidate.Path
    if ($sourceHash -is [int]) { return $sourceHash }
    if ($sourceHash -ne $RecordedHash) {
        [Console]::Error.WriteLine(
            "client=$Name repair=refused dest=$Path " +
            "recorded=$RecordedHash would-be=$sourceHash reason=payload-mismatch"
        )
        return 76
    }
    if (Copy-IdemAtomic -Source $candidate.Path -Target $Path) { return 0 }
    [Console]::Error.WriteLine(
        "client=$Name repair=failed dest=$Path reason=restore-write-failed"
    )
    return 73
}

function Restore-RepairFile {
    param([hashtable]$Context, [hashtable]$State, [string]$ConfigRoot,
        [string]$Name, [string]$Path, [string]$SkillName,
        [string]$Description, [string]$Body, [string]$Variant)
    if (Test-IdemPathEqual -Left $Path -Right $Context.Landed) {
        $code = Restore-RepairSkillFile -Context $Context `
            -ConfigRoot $ConfigRoot -Name $Name -SkillName $SkillName `
            -Description $Description -Body $Body -Variant $Variant `
            -RecordedHash $State.RecordedHash
    } else {
        $code = Restore-RepairManagedFile -Context $Context -Name $Name `
            -ConfigRoot $ConfigRoot -Landed $Context.Landed -Path $Path `
            -RecordedHash $State.RecordedHash
    }
    if ($code -ne 0) { return $code }
    $postHash = Get-IdemSha256 -Path $Path
    if ($postHash -ne $State.RecordedHash) {
        [Console]::Error.WriteLine(
            "client=$Name repair=failed dest=$Path " +
            "recorded=$($State.RecordedHash) post=$postHash " +
            'reason=post-write-mismatch'
        )
        return 73
    }
    [Console]::Out.WriteLine(
        "client=$Name repair=restored dest=$Path " +
        "hash=$postHash reason=$($State.Reason)"
    )
    return 0
}

function Write-RepairSummary {
    param([string]$Name, [hashtable]$Counts)
    [Console]::Out.WriteLine(
        "client=$Name repair=done restored=$($Counts.restored) " +
        "ok=$($Counts.ok) unfingerprinted=$($Counts.unfingerprinted)"
    )
}

function Complete-RepairReceiptMigration {
    param([string]$ConfigRoot, [hashtable]$Receipt)
    if (-not $Receipt.NeedsOmpManagedMigration -and
        -not $Receipt.NeedsOmpDetachedRootMigration) { return 0 }
    $code = Write-Receipt -ConfigRoot $ConfigRoot -Nonce $Receipt.Nonce `
        -Backup $Receipt.Backup -Files ([string[]]@($Receipt.Files)) `
        -CreatedDirectories ([string[]]@($Receipt.CreatedDirectories)) `
        -OmpManaged ([bool]$Receipt.OmpManaged) `
        -OmpDetachedRoot $Receipt.OmpDetachedRoot `
        -Edits ([hashtable[]]@($Receipt.Edits))
    if ($code -eq 0) { return 0 }
    [Console]::Error.WriteLine(
        "repair=failed reason=receipt-migration code=$code action=retry-repair"
    )
    return 73
}

function Repair-Install {
    param([string]$ConfigRoot, [string]$Name, [string]$SkillName,
        [string]$Description, [string]$Body, [string]$Variant = '')
    if ([string]::IsNullOrEmpty($ConfigRoot)) {
        [Console]::Error.WriteLine("error=no-config-root")
        return 70
    }
    $receipt = Read-UninstallReceipt -ConfigRoot $ConfigRoot
    if ($receipt -is [int]) { return $receipt }
    Set-RepairReceiptState -Receipt $receipt
    $context = New-RepairSkillContext -Name $Name -SkillName $SkillName `
        -Description $Description -Body $Body -Variant $Variant
    if ($context.Code -ne 0) { return $context.Code }
    $context.ManagedStage = ''
    $context.Candidates = @{}
    $counts = @{ restored = 0; ok = 0; unfingerprinted = 0 }
    try {
        foreach ($path in $receipt.Files) {
            $state = Get-RepairFileState -Name $Name -ConfigRoot $ConfigRoot `
                -Path $path -Landed $context.Landed
            if ($state.Code -ne 0) { return $state.Code }
            if ($state.Outcome -eq 'skip') { continue }
            if ($state.Outcome -ne 'restore') {
                $counts[$state.Outcome]++
                continue
            }
            $code = Restore-RepairFile -Context $context -State $state `
                -ConfigRoot $ConfigRoot -Name $Name -Path $path `
                -SkillName $SkillName -Description $Description `
                -Body $Body -Variant $Variant
            if ($code -ne 0) { return $code }
            $counts.restored++
        }
        $migrationCode = Complete-RepairReceiptMigration `
            -ConfigRoot $ConfigRoot -Receipt $receipt
        if ($migrationCode -ne 0) { return $migrationCode }
        Write-RepairSummary -Name $Name -Counts $counts
        return 0
    } finally {
        Remove-Item -LiteralPath $context.Stage -Recurse -Force `
            -ErrorAction SilentlyContinue
        if (-not [string]::IsNullOrEmpty($context.ManagedStage)) {
            Remove-Item -LiteralPath $context.ManagedStage -Recurse -Force `
                -ErrorAction SilentlyContinue
        }
    }
}
# --- F-LIB-UNINSTALL (end) ---

# --- F-LIB-EXTRAS (begin) ---
$AutopromptVscodeActivationKey = `
    'chat.subagents.allowInvocationsFromSubagents'

function Get-VscodeSettingsFile {
    if (-not [string]::IsNullOrEmpty($env:AUTOPROMPT_VSCODE_SETTINGS_PATH)) {
        return $env:AUTOPROMPT_VSCODE_SETTINGS_PATH
    }
    $homeDir = if ($env:HOME) { $env:HOME } elseif ($env:USERPROFILE) {
        $env:USERPROFILE
    } else {
        [Environment]::GetFolderPath('UserProfile')
    }
    if ([Runtime.InteropServices.RuntimeInformation]::IsOSPlatform(
        [Runtime.InteropServices.OSPlatform]::Windows)) {
        $appData = if ($env:APPDATA) { $env:APPDATA } else {
            Join-Path $homeDir 'AppData/Roaming'
        }
        return (Join-Path $appData 'Code/User/settings.json')
    }
    if ([Runtime.InteropServices.RuntimeInformation]::IsOSPlatform(
        [Runtime.InteropServices.OSPlatform]::OSX)) {
        return (Join-Path $homeDir 'Library/Application Support/Code/User/settings.json')
    }
    $configRoot = if ($env:XDG_CONFIG_HOME) { $env:XDG_CONFIG_HOME } else {
        Join-Path $homeDir '.config'
    }
    return (Join-Path $configRoot 'Code/User/settings.json')
}

function Get-VscodeSettingsHelper {
    return (Join-Path $AutopromptInstallRepoRoot `
        'scripts/install/vscode-settings.cjs')
}

# Install-Extras delegates the package boundary to scripts/runtime-payload.cjs. Its
# checked-in provider manifest is the exact, hash-bound runtime inventory.
function Get-ExtrasNativeDestination {
    param([string]$Name, [string]$AgentsDest)
    if ([string]::IsNullOrEmpty($AgentsDest)) {
        return @{ Code = 0; Path = '' }
    }
    $actual = [IO.Path]::GetFullPath($AgentsDest).
        TrimEnd([char]92, [char]47)
    $expected = [IO.Path]::GetFullPath(
        (Get-AutopromptNativeAgentsRoot -Name $Name)
    ).TrimEnd([char]92, [char]47)
    if ($actual.Equals($expected, (Get-IdemPathComparison))) {
        return @{ Code = 0; Path = $actual }
    }
    [Console]::Error.WriteLine(
        "client=$Name error=extras-unsafe-agents-dest " +
        "dest=$AgentsDest expected=$expected"
    )
    return @{ Code = 84; Path = '' }
}

function Get-ExtrasConfigRoot {
    param([string]$Name, [string]$SkillDest, [string]$ConfigRoot)
    if (-not [string]::IsNullOrEmpty($ConfigRoot)) { return $ConfigRoot }
    if ($Name -eq 'claude') {
        $suffix = Join-Path '.claude/skills' 'autoprompt'
        return $SkillDest.Substring(0, $SkillDest.Length - $suffix.Length).
            TrimEnd([char]92, [char]47)
    }
    if ($Name -eq 'codex') {
        $suffix = Join-Path 'skills' 'autoprompt'
        return $SkillDest.Substring(0, $SkillDest.Length - $suffix.Length).
            TrimEnd([char]92, [char]47)
    }
    return Split-Path -Parent $SkillDest
}

function Get-ExtrasRuntimeInventory {
    param([string]$Name, [string]$Tool, [string]$Stage)
    $runtimeDestination = if ($Name -eq 'codex') {
        Join-Path $Stage 'skills/autoprompt'
    } else { $Stage }
    & node $Tool --install $Name --destination $runtimeDestination | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'install failed' }
    & node $Tool --verify $Name --destination $runtimeDestination | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'verify failed' }
    $relativeFiles = @(& node $Tool --list $Name)
    if ($LASTEXITCODE -ne 0) { throw 'inventory failed' }
    return $relativeFiles
}

function Get-CodexExtrasRuntimePlan {
    param([string]$Tool, [string]$Stage)
    $runtimeDestination = Join-Path $Stage 'skills/autoprompt'
    $json = @(& node $Tool --plan codex --destination $runtimeDestination)
    if ($LASTEXITCODE -ne 0 -or $json.Count -eq 0) {
        throw 'Codex runtime plan failed'
    }
    try { $plan = (($json -join "`n") | ConvertFrom-Json) }
    catch { throw 'Codex runtime plan JSON is invalid' }
    if ($plan.schemaVersion -ne 1 -or $plan.provider -cne 'codex' -or
        $null -eq $plan.files -or @($plan.files).Count -eq 0) {
        throw 'Codex runtime plan is invalid'
    }
    return $plan
}

function Install-CodexExtrasRuntimePlan {
    param([string]$ConfigRoot, [string]$Tool, [string]$Stage)
    $plan = Get-CodexExtrasRuntimePlan -Tool $Tool -Stage $Stage
    $mappings = @()
    $agentCount = 0
    foreach ($item in @($plan.files)) {
        if ($item.kind -ceq 'discovery-shim') { continue }
        if ([string]::IsNullOrEmpty($item.target) -or
            [string]::IsNullOrEmpty($item.receiptPath) -or
            [IO.Path]::IsPathRooted($item.receiptPath) -or
            ($item.receiptPath -split '[\\/]' | Where-Object { $_ -in @('', '.', '..') })) {
            throw 'Codex runtime plan contains an unsafe receipt path'
        }
        $mappings += @{
            Source = [IO.Path]::GetFullPath($item.target)
            Target = Join-Path $ConfigRoot ($item.receiptPath -replace '/', `
                [IO.Path]::DirectorySeparatorChar)
        }
        if ($item.receiptPath -clike '*/skills/autoprompt/agents/ap-*.toml') {
            $agentCount++
        }
    }
    $managedCode = Install-IdemManagedFiles -ConfigRoot $ConfigRoot `
        -Mappings $mappings -RefuseUnownedTarget -UseCodexBatchIndex
    if ($managedCode -ne 0) {
        throw "Codex runtime registration failed: $managedCode"
    }
    return $agentCount
}

function Install-ExtrasSkillFiles {
    param([string]$ConfigRoot, [string]$Stage, [string]$SkillDest,
        [string[]]$RelativeFiles)
    $agentCount = 0
    $mappings = @()
    foreach ($relativePath in $RelativeFiles) {
        if ([string]::IsNullOrEmpty($relativePath)) { continue }
        $nativeRelative = $relativePath -replace '/', `
            [IO.Path]::DirectorySeparatorChar
        $mappings += @{
            Source = Join-Path $Stage $nativeRelative
            Target = Join-Path $SkillDest $nativeRelative
        }
        if ($relativePath.StartsWith('agents/')) { $agentCount++ }
    }
    $managedCode = Install-IdemManagedFiles -ConfigRoot $ConfigRoot `
        -Mappings $mappings -RefuseUnownedTarget
    if ($managedCode -ne 0) {
        throw "managed registration failed: $managedCode"
    }
    return $agentCount
}

function Install-ExtrasNativePersonas {
    param([string]$ConfigRoot, [string]$Stage, [string]$NativeDest)
    if ([string]::IsNullOrEmpty($NativeDest)) { return 0 }
    $sourceAgentsDir = Join-Path $Stage 'agents'
    $personas = @(Get-ChildItem -LiteralPath $sourceAgentsDir `
        -Filter 'ap-*.md' -File -ErrorAction SilentlyContinue)
    if ($personas.Count -ne 25) {
        throw "required source missing: $sourceAgentsDir/ap-*.md"
    }
    $mappings = @()
    foreach ($persona in $personas) {
        $mappings += @{
            Source = $persona.FullName
            Target = Join-Path $NativeDest $persona.Name
        }
    }
    $managedCode = Install-IdemManagedFiles -ConfigRoot $ConfigRoot `
        -Mappings $mappings -RefuseUnownedTarget
    if ($managedCode -ne 0) {
        throw "native registration failed: $managedCode"
    }
    return $personas.Count
}

function Get-ExtrasInstallContext {
    param([string]$Name, [string]$SrcDir, [string]$SkillDest,
        [string]$AgentsDest, [string]$ConfigRoot)
    if ([string]::IsNullOrEmpty($SrcDir) -or
        -not (Test-Path -LiteralPath $SrcDir -PathType Container)) {
        [Console]::Error.WriteLine(
            "client=$Name error=extras-no-src-dir dir=$SrcDir"
        )
        return @{ Code = 80 }
    }
    if ([string]::IsNullOrEmpty($SkillDest)) {
        [Console]::Error.WriteLine("client=$Name error=extras-no-skill-dest")
        return @{ Code = 81 }
    }
    $native = Get-ExtrasNativeDestination -Name $Name -AgentsDest $AgentsDest
    if ($native.Code -ne 0) { return @{ Code = $native.Code } }
    $tool = Join-Path $AutopromptInstallRepoRoot `
        'scripts/runtime-payload.cjs'
    if (-not (Test-Path -LiteralPath $tool -PathType Leaf) -or
        -not (Get-Command node -ErrorAction SilentlyContinue)) {
        [Console]::Error.WriteLine(
            "client=$Name error=extras-runtime-tool-unavailable path=$tool"
        )
        return @{ Code = 82 }
    }
    $root = Get-ExtrasConfigRoot -Name $Name -SkillDest $SkillDest `
        -ConfigRoot $ConfigRoot
    return @{ Code = 0; NativeDestination = $native.Path
        Tool = $tool; ConfigRoot = $root }
}

function Install-Extras {
    param([string]$Name, [string]$SrcDir, [string]$SkillDest,
        [string]$AgentsDest = '', [string]$ConfigRoot = '')
    $context = Get-ExtrasInstallContext -Name $Name -SrcDir $SrcDir `
        -SkillDest $SkillDest -AgentsDest $AgentsDest -ConfigRoot $ConfigRoot
    if ($context.Code -ne 0) { return $context.Code }
    $stage = Join-Path ([System.IO.Path]::GetTempPath()) `
        ("clextras_" + [guid]::NewGuid().ToString('N'))
    $journalStart = $script:AutopromptManagedUndoJournal.Count
    try {
        $relativeFiles = @(Get-ExtrasRuntimeInventory -Name $Name `
            -Tool $context.Tool -Stage $stage)
        $agentCount = if ($Name -eq 'codex') {
            Install-CodexExtrasRuntimePlan -ConfigRoot $context.ConfigRoot `
                -Tool $context.Tool -Stage $stage
        } else {
            Install-ExtrasSkillFiles `
                -ConfigRoot $context.ConfigRoot -Stage $stage `
                -SkillDest $SkillDest -RelativeFiles $relativeFiles
        }
        $nativeCount = Install-ExtrasNativePersonas `
            -ConfigRoot $context.ConfigRoot -Stage $stage `
            -NativeDest $context.NativeDestination
    } catch {
        $rolledBack = Undo-IdemManagedChanges -FromIndex $journalStart
        if (-not $rolledBack) {
            [Console]::Error.WriteLine(
                "client=$Name error=extras-rollback-incomplete action=retry-install"
            )
        }
        [Console]::Error.WriteLine(
            "client=$Name error=extras-copy-failed detail=$($_.Exception.Message)"
        )
        return 83
    } finally {
        Remove-Item -LiteralPath $stage -Recurse -Force `
            -ErrorAction SilentlyContinue
    }
    [Console]::Out.WriteLine(
        "client=$Name extras=ok files=$($relativeFiles.Count) " +
        "agents=$agentCount native=$nativeCount"
    )
    return 0
}
# --- F-LIB-EXTRAS (end) ---
