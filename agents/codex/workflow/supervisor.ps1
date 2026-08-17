<#
.SYNOPSIS
  autoprompt supervisor (Windows PowerShell 5.1 port of supervisor.sh) --
  external auto-relaunch for a one-sitting unattended run.

.DESCRIPTION
  This is a STANDALONE OS PROCESS, NOT a Claude Code hook. It touches no
  settings.json, registers no hook, and is launched by the operator. It honors
  the global no-hooks rule.

  It relaunches the autoprompt CLI with RESUME on any unexpected exit, loops
  until the JANITOR has written the DONE-sentinel (autoprompt/DONE-<nonce>),
  and has a crash-loop/poison-restart guard that distinguishes:
    - a FINISHED run     (sentinel present)      -> clean halt (exit 0)
    - a HEALTHY-LONG run (frontier advances)     -> keep relaunching, no escalation
    - a TRULY-STUCK run  (no frontier progress)  -> escalate, stop relaunching (exit 1)

  Behavior-faithful to agents/claude/workflow/supervisor.sh: identical sentinel glob
  (autoprompt/DONE-*), identical "done": true check, identical env var names
  (AUTOPROMPT_RESUME / AUTOPROMPT_UNATTENDED), identical --launcher selection,
  identical backoff schedule and poison guard.

.PARAMETER Launcher
  apidemo | codexdemo (or any launcher command on PATH). Defaults to
  $env:AUTOPROMPT_LAUNCHER. Exec'd as a bare command name.

.PARAMETER Cmd
  Verbatim launch command (e.g. "claude --dangerously-skip-permissions -p"),
  word-split with the mission appended. Overrides -Launcher. Defaults to
  $env:AUTOPROMPT_LAUNCH_CMD. A fresh user with no apidemo/codexdemo alias
  uses --cmd with their real CLI.

.PARAMETER Mission
  The mission text passed through to the launch command.

.EXAMPLE
  powershell -File supervisor.ps1 --launcher apidemo "<mission>"

.EXAMPLE
  powershell -File supervisor.ps1 --cmd "claude --dangerously-skip-permissions -p" "<mission>"

.NOTES
  Env (all optional), mirroring supervisor.sh:
    AUTOPROMPT_LAUNCH_CMD  verbatim launch command (overrides --launcher)
    AUTOPROMPT_LAUNCHER  default launcher label if --launcher is omitted
    LEDGER_DIR            default "autoprompt"
    SENTINEL              explicit sentinel glob (default <LEDGER_DIR>/DONE-*).
                          Passed to Get-ChildItem -Path as ONE pattern (no word-
                          split), so a single dir-wildcard like 'autoprompt/*/DONE-*'
                          works but a space-separated MULTI-pattern (a .sh-only escape
                          hatch) does not -- use one wildcard on PowerShell. When UNSET
                          (the default -- every real run) the glob is <LEDGER_DIR>/DONE-*
                          as one quoted path, so a LEDGER_DIR containing spaces (a
                          Windows path) still matches its own DONE-* sentinel.
    MAX_RESTARTS          rapid restarts allowed in WINDOW without progress (default 5)
    WINDOW               rolling window seconds for the poison guard (default 600)
    RETRY_BASE           base backoff seconds between relaunches (default 5; 0 in tests)
    RETRY_CAP            max backoff seconds (default 300)
    AUTOPROMPT_MODE      tokensaver | wide | billionaire | custom (default tokensaver).
                          WIDE and BILLIONAIRE share wide semantics. CUSTOM requires a
                          positive numeric AUTOPROMPT_MAX_CONCURRENT value, floors it
                          to a whole-agent ceiling, and passes both values through.

  The 5-level topology (L0 conductor -> L1 coordinators -> L2 managers -> L3
  executors -> L4 leaves) lives in the harness; rule 68 (L1 never executes) and
  rule 67 (single-block spawns) are enforced there. This OS-level supervisor only
  relaunches the L0 entry process and passes the mode through; it spawns no agents.
  Test hooks (only honored with --dry-run):
    FAKE_EXITS           space-separated exit codes the fake launcher returns in turn
    FAKE_SENTINEL_AFTER  write the sentinel before the launch with this 1-based index
    FAKE_POISON          1 => fake never advances the frontier and always exits non-zero
#>

# MODEL INHERITANCE NOTE (codex stack):
# The Codex defeater is .codex/config.toml model= (operator config, git-untracked,
# out of scope to rewrite). This supervisor has no env-var neutralization because
# the pin is a file, not an env var. The agents/claude/workflow/supervisor.ps1 DOES
# neutralize CLAUDE_CODE_SUBAGENT_MODEL (an env var) at launch. See agents/codex/SKILL.md
# for operator guidance on setting model = "inherit" in .codex/config.toml.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-EnvOrDefault {
    param([string]$Name, $Default)
    $value = [Environment]::GetEnvironmentVariable($Name)
    if ([string]::IsNullOrEmpty($value)) { return $Default }
    return $value
}

function Get-RequiredArgumentValue {
    param([string]$Flag, [int]$Index, [string[]]$Arguments)
    if ($Index -lt $Arguments.Count) { return $Arguments[$Index] }
    [Console]::Error.WriteLine("supervisor: $Flag requires a value")
    return $null
}

function Test-CapabilityAttestation {
    param([string]$Raw, [string[]]$Expected)
    try { $attestation = $Raw | ConvertFrom-Json -ErrorAction Stop } catch { return $false }
    $bindings = @(
        'provider', 'cliVersion', 'permissionProfile', 'agentSelector',
        'agentDefinitionsHash', 'castingHash', 'effortStatus', 'effortSource'
    )
    for ($index = 0; $index -lt $bindings.Count; $index += 1) {
        $property = $attestation.PSObject.Properties[$bindings[$index]]
        if ($null -eq $property -or $property.Value -isnot [string] -or $property.Value -cne $Expected[$index]) { return $false }
    }
    $schemaVersion = $attestation.PSObject.Properties['schemaVersion']
    $proofKind = $attestation.PSObject.Properties['proofKind']
    $proofHash = $attestation.PSObject.Properties['proofHash']
    $proofBytes = $attestation.PSObject.Properties['proofBytes']
    if ($null -eq $schemaVersion -or $schemaVersion.Value -isnot [int] -or $schemaVersion.Value -ne 4 -or
        $null -eq $proofKind -or $proofKind.Value -isnot [string] -or $proofKind.Value -cne 'disposable-scratch' -or
        $null -eq $proofHash -or $proofHash.Value -isnot [string] -or $proofHash.Value -cnotmatch '^sha256:[a-f0-9]{64}$') { return $false }
    # The proof hash must recompute from the inspectable scratch bytes the
    # attestation carries; a bare well-formed hash string proves nothing.
    if ($null -eq $proofBytes -or $proofBytes.Value -isnot [string] -or
        $proofBytes.Value.Length -eq 0 -or $proofBytes.Value.Length -gt 4096) { return $false }
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $recomputed = 'sha256:' + ([BitConverter]::ToString(
            $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($proofBytes.Value))
        ) -replace '-', '').ToLowerInvariant()
    } finally {
        $sha.Dispose()
    }
    if ($recomputed -cne $proofHash.Value) { return $false }
    foreach ($name in @('run', 'read', 'write')) {
        $property = $attestation.PSObject.Properties[$name]
        if ($null -eq $property -or $property.Value -isnot [bool] -or $property.Value -ne $true) { return $false }
    }
    return $true
}

function Invoke-Supervisor {
    param([string[]]$Argv)

    $launcher   = Get-EnvOrDefault 'AUTOPROMPT_LAUNCHER' ''
    $launchCmd  = Get-EnvOrDefault 'AUTOPROMPT_LAUNCH_CMD' ''
    $agentsSelector = Get-EnvOrDefault 'AUTOPROMPT_AGENTS' 'off'
    $modelRegistry = Get-EnvOrDefault 'AUTOPROMPT_MODEL_REGISTRY' ''
    $ledgerDir  = Get-EnvOrDefault 'LEDGER_DIR' 'autoprompt'
    $maxRestarts = [int](Get-EnvOrDefault 'MAX_RESTARTS' 5)
    $window      = [int](Get-EnvOrDefault 'WINDOW' 600)
    $retryBase   = [int](Get-EnvOrDefault 'RETRY_BASE' 5)
    $retryCap    = [int](Get-EnvOrDefault 'RETRY_CAP' 300)
    # Heartbeat env defaults (PLAN-idle-watchdog), IDENTICAL to supervisor.sh. IDLE_TIMEOUT
    # defaults to 1800s so a long-but-progressing build/test does NOT trip the heartbeat
    # (the frontier count grows on ANY artifact write); raise AUTOPROMPT_IDLE_TIMEOUT for
    # long atomic steps.
    $idleTimeout = [int](Get-EnvOrDefault 'AUTOPROMPT_IDLE_TIMEOUT' 1800)
    $heartbeatInterval = [int](Get-EnvOrDefault 'AUTOPROMPT_HEARTBEAT_INTERVAL' 60)
    # PLAN-auto-compact-threshold: proactive, SUPERVISOR-FIRED compaction below the
    # harness ~400k ceiling. IDENTICAL semantics + knobs to supervisor.sh and the claude
    # ps1 port. The supervisor observes the parent's context size from OUTSIDE (parent
    # session transcript; watermark/ledger-byte fallbacks) and, on crossing $compactAt,
    # writes COMPACT-REQUEST, then on grace timeout fires the kill->RESUME itself.
    $compactAt = Get-EnvOrDefault 'AUTOPROMPT_COMPACT_AT' '200000'
    $parsedCompactAt = 0
    if (-not [int]::TryParse([string]$compactAt, [ref]$parsedCompactAt) -or $parsedCompactAt -le 0 -or $parsedCompactAt -ge 10000000) {
        $parsedCompactAt = 200000
    }
    $compactAt = $parsedCompactAt
    $bytesPerToken = [int](Get-EnvOrDefault 'AUTOPROMPT_BYTES_PER_TOKEN' 4)
    if ($bytesPerToken -le 0) { $bytesPerToken = 4 }
    $compactCooldown = [int](Get-EnvOrDefault 'AUTOPROMPT_COMPACT_COOLDOWN' 120)
    $compactGrace = [int](Get-EnvOrDefault 'AUTOPROMPT_COMPACT_GRACE' 180)
    $externalCompactDelta = [int](Get-EnvOrDefault 'AUTOPROMPT_EXTERNAL_COMPACT_DELTA' 50000)
    # Execution mode selects the 5-level topology's wave cap. Unknown modes retain
    # the safe tokensaver fallback. CUSTOM is an explicit request for a caller-supplied
    # ceiling, so a missing or invalid value fails closed.
    $autopromptMode = Get-EnvOrDefault 'AUTOPROMPT_MODE' 'tokensaver'
    switch -CaseSensitive ($autopromptMode) {
        'tokensaver'  { $fanout = 'up to 6 live per wave'; $l3Tracks = 'parallel' }
        'wide'        { $fanout = 'wide up to the runtime ceiling'; $l3Tracks = 'parallel' }
        'billionaire' { $fanout = 'wide up to the runtime ceiling'; $l3Tracks = 'parallel' }
        'custom'      {
            $rawCustomMax = Get-EnvOrDefault 'AUTOPROMPT_MAX_CONCURRENT' ''
            [double]$parsedCustomMax = 0
            $validCustomMax = [double]::TryParse(
                [string]$rawCustomMax,
                [Globalization.NumberStyles]::Float,
                [Globalization.CultureInfo]::InvariantCulture,
                [ref]$parsedCustomMax
            )
            if (-not $validCustomMax -or [double]::IsNaN($parsedCustomMax) -or
                [double]::IsInfinity($parsedCustomMax) -or $parsedCustomMax -lt 1) {
                [Console]::Error.WriteLine('supervisor: custom mode requires a positive numeric AUTOPROMPT_MAX_CONCURRENT')
                return 2
            }
            $customMax = [Math]::Floor($parsedCustomMax)
            $env:AUTOPROMPT_MAX_CONCURRENT = [string]$customMax
            $fanout = "up to $customMax live per wave (AUTOPROMPT_MAX_CONCURRENT)"
            $l3Tracks = 'parallel'
        }
        default       { $autopromptMode = 'tokensaver'; $fanout = 'up to 6 live per wave'; $l3Tracks = 'parallel' }
    }
    # F-SPEED steer-2 B3: PHASE WALL-CLOCK BUDGET for the SCOPE phase. IDENTICAL knobs +
    # semantics to supervisor.sh. IDLE_TIMEOUT fires only on frontier STALENESS; a scope
    # phase that keeps writing scope-<angle>-vN.md IS progressing and resets that clock, so
    # it is never bounded. This budget is anchored to scope ENTRY and NOT reset by frontier
    # growth. Each knob is validated with [int]::TryParse: an absurd/non-numeric value
    # falls back to the default (never disables the guard).
    $scopeSoftSec = 60
    if (-not [int]::TryParse([string](Get-EnvOrDefault 'AUTOPROMPT_SCOPE_SOFT_SEC' '60'), [ref]$scopeSoftSec) -or $scopeSoftSec -le 0) { $scopeSoftSec = 60 }
    $scopeHardSec = 300
    if (-not [int]::TryParse([string](Get-EnvOrDefault 'AUTOPROMPT_SCOPE_HARD_SEC' '300'), [ref]$scopeHardSec) -or $scopeHardSec -le 0) { $scopeHardSec = 300 }
    $scopeGraceSec = 60
    if (-not [int]::TryParse([string](Get-EnvOrDefault 'AUTOPROMPT_SCOPE_GRACE' '60'), [ref]$scopeGraceSec) -or $scopeGraceSec -lt 0) { $scopeGraceSec = 60 }
    $maxScopeResets = 1
    if (-not [int]::TryParse([string](Get-EnvOrDefault 'AUTOPROMPT_MAX_SCOPE_RESETS' '1'), [ref]$maxScopeResets) -or $maxScopeResets -lt 0) { $maxScopeResets = 1 }
    # Derive this script's own dir for the phase-budget CLI path (codex has no
    # ledger-check.js sibling to hang it off). An operator override wins; the Test-Path
    # guard at the call site fail-opens if node/module are absent.
    $scriptDir = Split-Path -Parent $PSCommandPath
    $phaseBudgetPath = if ($env:AUTOPROMPT_PHASE_BUDGET) { $env:AUTOPROMPT_PHASE_BUDGET } else { Join-Path $scriptDir 'phase-budget.js' }
    $codexCastingPath = if ($env:AUTOPROMPT_CODEX_CASTING) { $env:AUTOPROMPT_CODEX_CASTING } else { Join-Path $scriptDir 'codex-agent-casting.js' }
    $codexProfileTool = if ($env:AUTOPROMPT_CODEX_PROFILE_TOOL) { $env:AUTOPROMPT_CODEX_PROFILE_TOOL } else { Join-Path $scriptDir 'codex-agent-profile.js' }
    $codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
    $codexAgentsPath = if ($env:AUTOPROMPT_CODEX_AGENTS_DIR) { $env:AUTOPROMPT_CODEX_AGENTS_DIR } else { Join-Path $scriptDir '../agents-runtime' }
    $codexProfileName = Get-EnvOrDefault 'AUTOPROMPT_CODEX_PROFILE_NAME' 'autoprompt'
    $codexProfilePath = if ($env:AUTOPROMPT_CODEX_PROFILE_FILE) { $env:AUTOPROMPT_CODEX_PROFILE_FILE } else { Join-Path $codexHome 'autoprompt.config.toml' }
    $dryRun      = $false
    $mission     = ''

    # EDIT 23: per-conversation session token. The supervisor is the durable producer
    # across relaunches of one conversation: seed it (env > file > empty) before the
    # loop, re-export the held token to each child, and HARVEST the resolver-minted
    # marker token after each launch so a 2nd prompt rejoins the same session_NN.
    $sessionToken = Get-EnvOrDefault 'AUTOPROMPT_SESSION_TOKEN' ''
    $initialResume = (Get-EnvOrDefault 'AUTOPROMPT_RESUME' '').Trim().ToLowerInvariant() -in @('1', 'true', 'yes')
    $runNonce = Get-EnvOrDefault 'AUTOPROMPT_RUN_NONCE' ''
    $legacySentinel = (Get-EnvOrDefault 'AUTOPROMPT_LEGACY_SENTINEL' '0') -eq '1'

    # --- arg parse (mirrors the .sh case loop) ----------------------------------
    $i = 0
    while ($i -lt $Argv.Count) {
        $arg = $Argv[$i]
        switch -CaseSensitive ($arg) {
            '--launcher'   {
                $value = Get-RequiredArgumentValue -Flag $arg -Index ($i + 1) -Arguments $Argv
                if ($null -eq $value) { return 2 }
                $launcher = $value; $i += 2; continue
            }
            '--cmd'        {
                $value = Get-RequiredArgumentValue -Flag $arg -Index ($i + 1) -Arguments $Argv
                if ($null -eq $value) { return 2 }
                $launchCmd = $value; $i += 2; continue
            }
            '--agents'     {
                $value = Get-RequiredArgumentValue -Flag $arg -Index ($i + 1) -Arguments $Argv
                if ($null -eq $value) { return 2 }
                $agentsSelector = $value; $i += 2; continue
            }
            '--model-registry' {
                $value = Get-RequiredArgumentValue -Flag $arg -Index ($i + 1) -Arguments $Argv
                if ($null -eq $value) { return 2 }
                $modelRegistry = $value; $i += 2; continue
            }
            '--dry-run'    { $dryRun = $true; $i += 1; continue }
            '--ledger-dir' {
                $value = Get-RequiredArgumentValue -Flag $arg -Index ($i + 1) -Arguments $Argv
                if ($null -eq $value) { return 2 }
                $ledgerDir = $value; $i += 2; continue
            }
            '--'           {
                # A trailing bare '--' with no following tokens yields an EMPTY
                # mission (matches supervisor.sh `shift; MISSION="$*"`). Only build
                # the slice when there is at least one token after '--', else the
                # range reverses (e.g. 2..1) and throws "index out of range".
                if (($i + 1) -lt $Argv.Count) {
                    $mission = ($Argv[($i + 1)..($Argv.Count - 1)] -join ' ')
                } else {
                    $mission = ''
                }
                $i = $Argv.Count; continue
            }
            default {
                if ($arg -like '-*') {
                    [Console]::Error.WriteLine("supervisor: unknown flag $arg")
                    return 2
                }
                $mission = $arg; $i += 1; continue
            }
        }
    }

    $missionBytes = [Text.Encoding]::UTF8.GetBytes($mission)
    $missionSha = [Security.Cryptography.SHA256]::Create()
    try {
        $scopeMissionBinding = 'sha256:' + ([BitConverter]::ToString($missionSha.ComputeHash($missionBytes)) -replace '-', '').ToLowerInvariant()
    } finally {
        $missionSha.Dispose()
    }
    if (-not $legacySentinel) {
        if ([string]::IsNullOrEmpty($runNonce)) {
            $nonceBytes = New-Object byte[] 16
            $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
            try { $generator.GetBytes($nonceBytes) } finally { $generator.Dispose() }
            $runNonce = 'NONCE-' + ([BitConverter]::ToString($nonceBytes) -replace '-', '').ToLowerInvariant()
        } elseif ($runNonce -cnotmatch '^NONCE-[A-Za-z0-9_-]+$') {
            [Console]::Error.WriteLine('supervisor: AUTOPROMPT_RUN_NONCE is malformed')
            return 2
        }
    }

    $capabilityProvider = 'codex'
    $capabilityCliVersion = 'unknown'
    $capabilityPermissionProfile = Get-EnvOrDefault 'AUTOPROMPT_PERMISSION_PROFILE' 'default'
    $capabilityAgentDefinitionsHash = 'unknown'
    $capabilityCastingHash = 'unknown'
    $capabilityEffortStatus = 'unknown'
    $capabilityEffortSource = 'unverified'
    $capabilityAttestation = $null
    $suppliedCapabilityAttestation = Get-EnvOrDefault 'AUTOPROMPT_CAPABILITY_ATTESTATION' ''

    if (-not $dryRun) {
        if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
            [Console]::Error.WriteLine('supervisor: Codex capability binding requires node on PATH')
            return 2
        }
        if (-not (Test-Path -LiteralPath $codexCastingPath -PathType Leaf)) {
            [Console]::Error.WriteLine("supervisor: Codex casting validator is not readable: $codexCastingPath")
            return 2
        }
        $nodeArgs = @($codexCastingPath, '--resolve', '--agents-dir', $codexAgentsPath, '--selector', $agentsSelector)
        if (-not [string]::IsNullOrEmpty($modelRegistry)) { $nodeArgs += @('--registry', $modelRegistry) }
        $previousErrorActionPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            $castingOutput = @(& node @nodeArgs 2>&1)
            $castingExitCode = $LASTEXITCODE
        } finally { $ErrorActionPreference = $previousErrorActionPreference }
        $castingJson = ($castingOutput | ForEach-Object { [string]$_ }) -join [Environment]::NewLine
        if ($castingExitCode -ne 0) {
            [Console]::Error.WriteLine($castingJson.Trim())
            return 2
        }
        try { $casting = $castingJson | ConvertFrom-Json -ErrorAction Stop } catch {
            [Console]::Error.WriteLine("supervisor: Codex casting validator returned invalid JSON: $($_.Exception.Message)")
            return 2
        }
        $capabilityAgentDefinitionsHash = [string]$casting.agentDefinitionsHash
        $capabilityCastingHash = [string]$casting.castingHash
        $capabilityEffortStatus = [string]$casting.effort.status
        $capabilityEffortSource = [string]$casting.effort.source

        if (-not (Test-Path -LiteralPath $codexProfileTool -PathType Leaf)) {
            [Console]::Error.WriteLine("supervisor: Codex profile validator is not readable: $codexProfileTool")
            return 2
        }
        $profileOutput = @(& node $codexProfileTool --verify --agents-dir $codexAgentsPath --profile $codexProfilePath --workspace (Get-Location).Path 2>&1)
        if ($LASTEXITCODE -ne 0) {
            [Console]::Error.WriteLine(($profileOutput -join [Environment]::NewLine))
            return 2
        }
        if ($launchCmd -match '(?:^|\s)(?:--profile|-p)(?:\s|$)') {
            [Console]::Error.WriteLine("supervisor: launch command must not select a profile; Autoprompt owns --profile $codexProfileName")
            return 2
        }

        $configuredVersion = Get-EnvOrDefault 'AUTOPROMPT_CLI_VERSION' ''
        if (-not [string]::IsNullOrEmpty($configuredVersion)) {
            $capabilityCliVersion = $configuredVersion
        } else {
            $cliCommand = if (-not [string]::IsNullOrEmpty($launchCmd)) { ($launchCmd -split '\s+')[0] } else { $launcher }
            if (-not [string]::IsNullOrEmpty($cliCommand) -and (Get-Command $cliCommand -ErrorAction SilentlyContinue)) {
                try { $capabilityCliVersion = [string]((& $cliCommand --version 2>$null | Select-Object -First 1)) } catch {}
            }
        }
        if ($capabilityCliVersion -ne 'unknown' -and -not [string]::IsNullOrEmpty($suppliedCapabilityAttestation)) {
            $expectedBindings = @(
                $capabilityProvider, $capabilityCliVersion, $capabilityPermissionProfile,
                $agentsSelector, $capabilityAgentDefinitionsHash, $capabilityCastingHash,
                $capabilityEffortStatus, $capabilityEffortSource
            )
            if (Test-CapabilityAttestation -Raw $suppliedCapabilityAttestation -Expected $expectedBindings) {
                $capabilityAttestation = $suppliedCapabilityAttestation
            }
        }
    }

    $sentinelGlob = Get-EnvOrDefault 'SENTINEL' (Join-Path $ledgerDir 'DONE-*')
    $escalateFile = Join-Path $ledgerDir 'SUPERVISOR-ESCALATE'
    $snapshotFile = Join-Path $ledgerDir '.sentinel-snapshot'
    # EDIT 23: durable session-token store under the ledger dir, surviving across
    # relaunches of one conversation. Seeded before the loop, harvested after launches.
    $sessionTokenFile = Join-Path $ledgerDir '.session-token'
    # PLAN-auto-compact-threshold path vars. Discovery is CWD-AGNOSTIC and slug-free,
    # IDENTICAL to supervisor.sh and the claude ps1 port -- NO slug, NO launcher edit.
    $runCwd = (Get-EnvOrDefault 'RUN_CWD' (Get-Location).Path)
    $parentTranscript = Get-EnvOrDefault 'AUTOPROMPT_PARENT_TRANSCRIPT' ''
    $watermarkFile = Join-Path $ledgerDir '.context-watermark'
    $compactRequestFile = Join-Path $ledgerDir 'COMPACT-REQUEST'
    $compactStateFile = Join-Path $ledgerDir '.compaction-state'
    # F-SPEED steer-2 B3 scope-phase state files (durable across relaunches).
    $scopePhaseStartFile = Join-Path $ledgerDir '.scope-phase-start'
    $scopeResetsFile = Join-Path $ledgerDir '.scope-forced-resets'
    if (-not (Test-Path -LiteralPath $ledgerDir)) {
        New-Item -ItemType Directory -Path $ledgerDir -Force | Out-Null
    }

    # Supervisor start time (captured BEFORE the first launch). It is no longer part
    # of the stale-sentinel guarantee (see below) -- it is kept only to name the
    # quarantine target (superseded-<epoch>-...). Get-Date cannot fail here.
    $startTime = Get-Date

    # THE stale-sentinel guarantee is a LIVE STARTUP SNAPSHOT, not LastWriteTime.
    # Before the first launch we record every pre-existing DONE-* PATH into
    # $snapshotFile. Test-SentinelPresent REFUSES any DONE-* whose path is in that
    # snapshot -- regardless of LastWriteTime. As quarantine SUCCESSFULLY renames each
    # stale occupant aside it PRUNES that path from the snapshot, so a path is vetoed
    # IFF its stale occupant still physically exists. A DONE-* counts as THIS run's
    # completion if its path was NOT present at startup OR was present but has since
    # been cleared by a successful quarantine (the launcher then wrote a FRESH one
    # there -- the same-activation DONE-<nonce> case). A failed quarantine
    # rename leaves the path vetoed -> RELAUNCH, never a false halt. The
    # LastWriteTime>=start belt is gone -- it could not backstop the same-second
    # class, which is the whole reason this defense exists. FAIL-SAFE: if the snapshot
    # cannot be written or read, ALL DONE-* are treated as suspect -> relaunch.
    $script:state = @{
        DryRun        = $dryRun
        LedgerDir     = $ledgerDir
        SentinelGlob  = $sentinelGlob
        LaunchIndex   = 0
        StartTime     = $startTime
        SnapshotFile  = $snapshotFile
        SnapshotOk    = $false
        SnapshotPaths = @{}
        ScopeEscalate = $false
        ScopeTerminal = $false
    }

    function Write-SupLog {
        param([string]$Message)
        $ts = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss')
        Write-Host "[supervisor $ts] $Message"
    }

    # Take the startup snapshot of pre-existing DONE-* PATHS, BEFORE the first
    # launch and BEFORE any sentinel check or quarantine. Each path is written on
    # its own line to $snapshotFile and held in a hashtable for O(1) lookup.
    # SnapshotOk=$true marks a trustworthy snapshot; if writing fails we leave it
    # $false, and Test-SentinelPresent then treats EVERY DONE-* as suspect
    # (relaunch), the fail-safe direction.
    function Save-PreExistingSentinels {
        $script:state.SnapshotOk = $false
        $script:state.SnapshotPaths = @{}
        try {
            $found = @(Get-ChildItem -Path $script:state.SentinelGlob -ErrorAction SilentlyContinue)
            $lines = New-Object System.Collections.Generic.List[string]
            foreach ($file in $found) {
                $lines.Add($file.FullName)
                $script:state.SnapshotPaths[$file.FullName] = $true
            }
            Set-Content -LiteralPath $script:state.SnapshotFile -Value $lines -Encoding ascii -ErrorAction Stop
            $script:state.SnapshotOk = $true
        } catch {
            $script:state.SnapshotOk = $false
        }
    }

    # Is $Path one of the paths recorded in the startup snapshot? If the snapshot is
    # not trustworthy (SnapshotOk=$false) we answer YES for every path -> every
    # DONE-* is treated as pre-existing -> never halts -> relaunch. That is the
    # deliberate fail-safe: a missing/unreadable snapshot must never permit a halt.
    function Test-PathInSnapshot {
        param([string]$Path)
        if (-not $script:state.SnapshotOk) { return $true }
        return $script:state.SnapshotPaths.ContainsKey($Path)
    }

    # Drop one path from the live snapshot so a genuinely-fresh sentinel can later
    # reclaim it. Called by quarantine ONLY after a SUCCESSFUL rename: once the stale
    # occupant has been moved aside, the path is empty, so the ONLY thing that can
    # appear there is a fresh sentinel written by THIS run. The activation nonce is
    # minted once (CSPRNG) and re-exported unchanged to every relaunched child (no
    # clock), so a re-launch of
    # the SAME activation writes the SAME path the snapshot recorded -- if the snapshot
    # kept vetoing it, that fresh sentinel would be refused forever and the supervisor
    # would relaunch without end (the livelock). We drop it from the in-memory set AND
    # rewrite $SnapshotFile so a mid-run re-read agrees. If the rewrite fails we KEEP
    # the path in memory (over-veto = relaunch, never a false halt). A path whose
    # rename FAILED is never pruned, so it stays vetoed while its occupant still exists.
    function Remove-PathFromSnapshot {
        param([string]$Path)
        if (-not $script:state.SnapshotOk) { return }
        $script:state.SnapshotPaths.Remove($Path) | Out-Null
        try {
            $lines = New-Object System.Collections.Generic.List[string]
            foreach ($key in $script:state.SnapshotPaths.Keys) { $lines.Add($key) }
            Set-Content -LiteralPath $script:state.SnapshotFile -Value $lines -Encoding ascii -ErrorAction Stop
        } catch {
            # Rewrite failed: the in-memory set already dropped the path (the source of
            # truth for this process); the on-disk copy is only for a mid-run re-read,
            # which this port does not do. Leaving it stale cannot cause a false halt.
        }
    }

    # A DONE-sentinel counts as THIS run's completion iff it exists, carries the
    # done marker, AND its path is NOT in the LIVE startup snapshot. The snapshot
    # starts as every pre-existing DONE-* path and is pruned as quarantine clears
    # each one, so a path is vetoed IFF its stale occupant still physically exists;
    # a fresh sentinel at a cleared path is honored. Mirrors the .sh for-loop glob +
    # grep '"done"\s*:\s*true'.
    function Test-SentinelPresent {
        if (-not $legacySentinel) {
            $sentinelPath = Join-Path $script:state.LedgerDir "DONE-$runNonce"
            if (-not (Test-Path -LiteralPath $sentinelPath -PathType Leaf) -or
                (Test-PathInSnapshot $sentinelPath)) {
                return $false
            }
            try {
                $sentinel = Get-Content -LiteralPath $sentinelPath -Raw -ErrorAction Stop |
                    ConvertFrom-Json -ErrorAction Stop
                $done = $sentinel.PSObject.Properties['done']
                $nonce = $sentinel.PSObject.Properties['nonce']
                return $null -ne $done -and $done.Value -is [bool] -and $done.Value -eq $true -and
                    $null -ne $nonce -and $nonce.Value -is [string] -and $nonce.Value -ceq $runNonce
            } catch {
                return $false
            }
        }
        $found = @(Get-ChildItem -Path $script:state.SentinelGlob -File -ErrorAction SilentlyContinue)
        foreach ($file in $found) {
            $content = Get-Content -LiteralPath $file.FullName -Raw -ErrorAction SilentlyContinue
            if ($null -ne $content -and $content -match '"done"\s*:\s*true') {
                if (-not (Test-PathInSnapshot $file.FullName)) {
                    return $true
                }
            }
        }
        return $false
    }

    # At startup, BEFORE the first launch, QUARANTINE every pre-existing done:true
    # DONE-* sentinel: rename it aside to <dir>\superseded-<start-epoch>-<name> so
    # the new name no longer starts with DONE- and thus no longer matches the live
    # DONE-* glob -- it cannot halt this fresh mission. (Prefixing, NOT suffixing: a
    # DONE-X.superseded-N name would STILL match DONE-* and re-trip the same-second
    # halt, so the leading DONE- must be displaced.) This is the PRIMARY fix for the
    # whole stale-sentinel class -- after quarantine there is no leftover sentinel
    # left to race, so a same-second / sub-second LastWriteTime collision is moot.
    # We RENAME, never delete (deleting artifacts is the JANITOR's job; never
    # silently remove operator files) and log a loud line naming each quarantined
    # file. On a SUCCESSFUL rename the path is pruned from the live snapshot so a
    # genuine fresh same-activation DONE-<nonce> (the minted nonce is re-exported to
    # every relaunched child, no clock) can reclaim it -- else the snapshot would veto
    # that fresh sentinel forever and the supervisor would relaunch without end
    # (livelock). If a rename FAILS (read-only dir / permissions / clobber) the
    # leftover DONE-* still matches the live glob, its path is NOT pruned, and
    # Test-SentinelPresent unconditionally refuses it. A failed rename degrades to
    # RELAUNCH, never a halt. Net invariant: the snapshot vetoes a path IFF its stale
    # occupant still exists.
    function Move-StaleSentinelAside {
        $startEpoch = [int64][Math]::Floor(([DateTimeOffset]$script:state.StartTime).ToUnixTimeSeconds())
        $found = @(Get-ChildItem -Path $script:state.SentinelGlob -File -ErrorAction SilentlyContinue)
        foreach ($file in $found) {
            $content = Get-Content -LiteralPath $file.FullName -Raw -ErrorAction SilentlyContinue
            if ($null -ne $content -and $content -match '"done"\s*:\s*true') {
                $quarantined = Join-Path $file.DirectoryName "superseded-$startEpoch-$($file.Name)"
                try {
                    Move-Item -LiteralPath $file.FullName -Destination $quarantined -Force -ErrorAction Stop
                    # The stale occupant is gone, so this path can no longer hold
                    # anything but a FRESH this-run sentinel. Drop it from the live
                    # snapshot so the same-activation DONE-<nonce> is
                    # reclaimable -- otherwise the snapshot would veto the genuine
                    # fresh sentinel forever (the livelock).
                    Remove-PathFromSnapshot $file.FullName
                    Write-SupLog "QUARANTINE: pre-existing DONE-sentinel '$($file.FullName)' (from a prior run) renamed to '$quarantined' so it cannot halt this fresh mission. It is preserved, not deleted."
                } catch {
                    Write-SupLog "WARNING: could not quarantine pre-existing DONE-sentinel '$($file.FullName)' -- it is IGNORED for halting by the startup snapshot and will not stop this mission. Remove it if it is no longer relevant."
                }
            }
        }
    }

    # The frontier marker: MONOTONIC forward-progress counter (not a success
    # counter). In dry-run a poison fake never advances; a healthy fake bumps a
    # counter file. In real runs we count EVERY gate artifact across the whole
    # lifecycle (intake, scope/roadmap, plan draft/review/fresh-verify,
    # plan-final, impl, impl-review, verify, signoff, sweep-round, arbiter,
    # goal-check). Versioned, per-feature, retained roadmap-scout, legacy scope-angle,
    # and per-round files multiply as work proceeds, so a crash-looping-but-advancing
    # run -- including the memory-heavy pre-build SCOPE phase that writes roadmap/scout files long
    # before any plan-final -- bumps the count every relaunch and resets the
    # poison window; a run writing nothing new stays flat and still trips poison.
    function Get-FrontierCount {
        if ($script:state.DryRun) {
            if ((Get-EnvOrDefault 'FAKE_POISON' '0') -eq '1') { return 0 }
            $counterFile = Join-Path $script:state.LedgerDir '.fake-frontier'
            if (Test-Path -LiteralPath $counterFile) {
                return [int]((Get-Content -LiteralPath $counterFile -Raw).Trim())
            }
            return 0
        }
        $count = 0
        # Three artifact layouts must ALL be counted, or a run driven by one of them
        # is invisible to the frontier and a healthy-long run trips POISON:
        #   prose/agent (SKILL.md/GATES.md): autoprompt/prompt-NNN-<slug>/artifacts/
        #   harness (autoprompt-gate.js ARTIFACT_DIR): autoprompt/.artifacts/<run-tag>/
        #   session ledger (SPEC-1 SCRIBE): autoprompt/session_NN/prompt_NN-<slug>/ and
        #     its optional artifacts/ subdir. The per-prompt ledger .md files
        #     (BRIEF/GATELOG/COVERAGE...) count as forward progress (monotonic; same
        #     rationale as the multiplying-artifacts globs), so a run advancing ONLY in
        #     the new layout is never falsely poisoned.
        # The leading-dot harness dir is not matched by the prose "*" wildcard and its
        # nesting differs, so it needs its own glob -- which also stops the prose glob
        # from double-counting it. Ledger-root prose files (BRIEF/PLAN/GATELOG...) live
        # one level above artifacts/ so they are not counted by the first two globs; the
        # session-ledger glob counts them at their nested depth. The DONE sentinel lives
        # at the ledger root, not under any artifacts/ dir.
        $proseArtifacts   = Join-Path (Join-Path $script:state.LedgerDir '*') 'artifacts'
        $harnessArtifacts = Join-Path (Join-Path $script:state.LedgerDir '.artifacts') '*'
        $artifactGlobs = @(
            (Join-Path $proseArtifacts   '*.md')
            (Join-Path $harnessArtifacts '*.md')
            (Join-Path (Join-Path (Join-Path $script:state.LedgerDir 'session_*') 'prompt_*') (Join-Path 'artifacts' '*.md'))
            (Join-Path (Join-Path (Join-Path $script:state.LedgerDir 'session_*') 'prompt_*') '*.md')
        )
        $count += @(Get-ChildItem -Path $artifactGlobs -File -ErrorAction SilentlyContinue).Count
        return $count
    }

    # === F-SPEED steer-2 B3: PHASE WALL-CLOCK BUDGET for the SCOPE phase =============
    # PowerShell port of scope_phase_elapsed / retained-scout discovery /
    # scope_converge_request_age. Anchored to scope entry before the first artifact and
    # never reset by frontier growth.
    function Get-ScopePhaseElapsed {
        if ($script:state.DryRun) {
            $fse = Get-EnvOrDefault 'FAKE_SCOPE_ELAPSED' ''
            if (-not [string]::IsNullOrEmpty($fse)) { return [int]$fse }
            return $null
        }
        $ld = $script:state.LedgerDir
        $buildGlobs = @(
            (Join-Path (Join-Path (Join-Path $ld '.artifacts') '*') '*-impl-v*.md')
            (Join-Path (Join-Path (Join-Path $ld '*') 'artifacts') '*-impl-v*.md')
            (Join-Path (Join-Path (Join-Path (Join-Path $ld 'session_*') 'prompt_*') 'artifacts') '*-impl-v*.md')
        )
        if (@(Get-ChildItem -Path $buildGlobs -File -ErrorAction SilentlyContinue).Count -gt 0) {
            Remove-Item -LiteralPath $scopePhaseStartFile -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $scopeResetsFile -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath (Join-Path $ld 'SCOPE-CONVERGE-REQUEST') -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath (Join-Path $ld 'SCOPE-BUDGET-BREACH') -Force -ErrorAction SilentlyContinue
            return $null
        }
        $nowS = [int64][Math]::Floor(([DateTimeOffset](Get-Date)).ToUnixTimeSeconds())
        $startS = 0
        $storedBinding = ''
        if (Test-Path -LiteralPath $scopePhaseStartFile) {
            try {
                $first = (Get-Content -LiteralPath $scopePhaseStartFile -First 1 -ErrorAction Stop)
                if ($null -ne $first) {
                    $fields = ([string]$first).Trim() -split '\s+'
                    if ($fields.Count -ge 1) { [void][int64]::TryParse($fields[0], [ref]$startS) }
                    if ($fields.Count -ge 2) { $storedBinding = $fields[1] }
                }
            } catch { $startS = 0; $storedBinding = '' }
        }
        if ($storedBinding -cne $scopeMissionBinding) {
            $startS = 0
            Remove-Item -LiteralPath (Join-Path $ld 'SCOPE-CONVERGE-REQUEST') -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath (Join-Path $ld 'SCOPE-BUDGET-BREACH') -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $scopeResetsFile -Force -ErrorAction SilentlyContinue
        }
        if ($startS -le 0) {
            $startS = $nowS
            try {
                $tmp = "$scopePhaseStartFile.tmp"
                "$startS $scopeMissionBinding" | Set-Content -LiteralPath $tmp -Encoding ascii
                Move-Item -LiteralPath $tmp -Destination $scopePhaseStartFile -Force
            } catch { }
        }
        $el = $nowS - $startS
        if ($el -lt 0) { $el = 0 }
        return [int]$el
    }

    function Get-ScopeLandedAngles {
        if ($script:state.DryRun) { return (Get-EnvOrDefault 'FAKE_SCOPE_LANDED' '') }
        $ld = $script:state.LedgerDir
        $scopeGlobs = @(
            (Join-Path (Join-Path (Join-Path $ld '.artifacts') '*') 'roadmap-scout-*.md')
            (Join-Path (Join-Path (Join-Path $ld '*') 'artifacts') 'roadmap-scout-*.md')
            (Join-Path (Join-Path (Join-Path (Join-Path $ld 'session_*') 'prompt_*') 'artifacts') 'roadmap-scout-*.md')
            (Join-Path (Join-Path (Join-Path $ld '.artifacts') '*') 'scope-*.md')
            (Join-Path (Join-Path (Join-Path $ld '*') 'artifacts') 'scope-*.md')
            (Join-Path (Join-Path (Join-Path (Join-Path $ld 'session_*') 'prompt_*') 'artifacts') 'scope-*.md')
        )
        $keys = New-Object System.Collections.Generic.List[string]
        foreach ($f in @(Get-ChildItem -Path $scopeGlobs -File -ErrorAction SilentlyContinue)) {
            $key = if ($f.Name -like 'roadmap-scout-*.md') {
                $f.Name -replace '\.md$', ''
            } else {
                $f.Name -replace '^scope-', '' -replace '-v[0-9]+\.md$', '' -replace '\.md$', ''
            }
            if (-not [string]::IsNullOrEmpty($key) -and -not $keys.Contains($key)) { $keys.Add($key) }
        }
        return ($keys -join ',')
    }

    function Get-ScopeConvergeRequestAge {
        $req = Join-Path $script:state.LedgerDir 'SCOPE-CONVERGE-REQUEST'
        if (-not (Test-Path -LiteralPath $req)) { return 0 }
        $nowS = [int64][Math]::Floor(([DateTimeOffset](Get-Date)).ToUnixTimeSeconds())
        $reqTs = 0
        try {
            $first = (Get-Content -LiteralPath $req -First 1 -ErrorAction Stop)
            if ($null -ne $first) { $f = ([string]$first).Trim() -split '\s+'; if ($f.Count -ge 1) { [void][int64]::TryParse($f[0], [ref]$reqTs) } }
        } catch { $reqTs = 0 }
        $age = $nowS - $reqTs
        if ($age -lt 0) { $age = 0 }
        return [int]$age
    }

    # === PLAN-auto-compact-threshold: proactive supervisor-fired compaction ==========
    # PowerShell port of canon_path / find_parent_transcript / read_context_estimate /
    # note_external_compaction / maybe_request_compaction / kill_tree. The slug-free
    # discovery rule is BYTE-FOR-BYTE the same decision as supervisor.sh and the claude
    # ps1 port -- there is no slug to diverge on.

    function Get-CanonPath {
        param([string]$Path)
        if ($null -eq $Path) { return '' }
        $p = $Path.ToLowerInvariant() -replace '\\', '/'
        $p = $p -replace '/+', '/'
        $p = $p -replace '^([a-z]):', '/$1'
        return $p
    }

    function Find-ParentTranscript {
        param([long]$LaunchEpoch)
        if (-not [string]::IsNullOrEmpty($parentTranscript) -and (Test-Path -LiteralPath $parentTranscript)) {
            return $parentTranscript
        }
        $cfg = Get-EnvOrDefault 'CLAUDE_CONFIG_DIR' (Join-Path $HOME '.claude')
        $want = Get-CanonPath $runCwd
        $glob = Join-Path (Join-Path $cfg 'projects') (Join-Path '*' '*.jsonl')
        $newest = $null; $newestMt = [long]0
        foreach ($f in @(Get-ChildItem -Path $glob -File -ErrorAction SilentlyContinue)) {
            $mt = [int64][Math]::Floor(([DateTimeOffset]$f.LastWriteTimeUtc).ToUnixTimeSeconds())
            if ($mt -lt $LaunchEpoch) { continue }
            $tcwd = $null
            try {
                foreach ($line in [System.IO.File]::ReadLines($f.FullName)) {
                    $m = [regex]::Match($line, '"cwd":"([^"]*)"')
                    if ($m.Success) { $tcwd = $m.Groups[1].Value; break }
                }
            } catch { $tcwd = $null }
            if ([string]::IsNullOrEmpty($tcwd)) { continue }
            $tcwd = $tcwd -replace '\\\\', '\'
            if ((Get-CanonPath $tcwd) -ne $want) { continue }
            if ($mt -gt $newestMt) { $newest = $f.FullName; $newestMt = $mt }
        }
        return $newest
    }

    function Read-ContextEstimate {
        param([long]$LaunchEpoch)
        if ($script:state.DryRun) {
            $fw = Get-EnvOrDefault 'FAKE_WATERMARK' ''
            if (-not [string]::IsNullOrEmpty($fw)) { return [int]$fw }
            return 0
        }
        $tx = Find-ParentTranscript -LaunchEpoch $LaunchEpoch
        if (-not [string]::IsNullOrEmpty($tx) -and (Test-Path -LiteralPath $tx)) {
            $lastUsage = $null
            try {
                foreach ($line in [System.IO.File]::ReadLines($tx)) {
                    if ($line -notmatch '"usage"') { continue }
                    try {
                        $obj = $line | ConvertFrom-Json
                        if ($obj.message -and $obj.message.usage) { $lastUsage = $obj.message.usage }
                    } catch { }
                }
            } catch { $lastUsage = $null }
            if ($null -ne $lastUsage) {
                $sum = 0
                foreach ($k in @('input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens')) {
                    $v = $lastUsage.$k
                    if ($null -ne $v) { $sum += [int]$v }
                }
                if ($sum -gt 0) { return $sum }
            }
            try {
                $sz = (Get-Item -LiteralPath $tx).Length
                if ($sz -gt 0) { return [int]([math]::Floor($sz / $bytesPerToken)) }
            } catch { }
        }
        if (Test-Path -LiteralPath $watermarkFile) {
            try {
                $first = (Get-Content -LiteralPath $watermarkFile -First 1 -ErrorAction Stop)
                if ($null -ne $first) {
                    $fields = ([string]$first).Trim() -split '\s+'
                    $wmTok = 0
                    if ($fields.Count -ge 1 -and [int]::TryParse($fields[0], [ref]$wmTok)) {
                        $wmTs = $null
                        if ($fields.Count -ge 2) { $parsedTs = [long]0; if ([long]::TryParse($fields[1], [ref]$parsedTs)) { $wmTs = $parsedTs } }
                        if ($null -eq $wmTs -or $wmTs -ge $LaunchEpoch) { return $wmTok }
                    }
                }
            } catch { }
        }
        $bytes = [long]0
        $ledgerGlobs = @(
            (Join-Path (Join-Path (Join-Path $script:state.LedgerDir 'session_*') 'prompt_*') '*.md')
            (Join-Path (Join-Path (Join-Path $script:state.LedgerDir 'session_*') 'prompt_*') (Join-Path 'artifacts' '*.md'))
            (Join-Path (Join-Path $script:state.LedgerDir '*') (Join-Path 'artifacts' '*.md'))
        )
        foreach ($g in $ledgerGlobs) {
            foreach ($f in @(Get-ChildItem -Path $g -File -ErrorAction SilentlyContinue)) { $bytes += $f.Length }
        }
        return [int]([math]::Floor($bytes / $bytesPerToken))
    }

    function Note-ExternalCompaction {
        param([long]$Now, [int]$CurrentEst)
        $prevEst = 0; $lastCompact = 0
        if (Test-Path -LiteralPath $compactStateFile) {
            try {
                $first = (Get-Content -LiteralPath $compactStateFile -First 1 -ErrorAction Stop)
                if ($null -ne $first) {
                    $f = ([string]$first).Trim() -split '\s+'
                    if ($f.Count -ge 1) { [void][int]::TryParse($f[0], [ref]$lastCompact) }
                    if ($f.Count -ge 2) { [void][int]::TryParse($f[1], [ref]$prevEst) }
                }
            } catch { }
        }
        if ($prevEst -gt 0 -and (($prevEst - $CurrentEst) -ge $externalCompactDelta)) {
            try {
                $tmp = "$compactStateFile.tmp"
                "$Now $CurrentEst external_compaction" | Set-Content -LiteralPath $tmp -Encoding ascii
                Move-Item -LiteralPath $tmp -Destination $compactStateFile -Force
            } catch { }
            if (Test-Path -LiteralPath $compactRequestFile) { Remove-Item -LiteralPath $compactRequestFile -Force -ErrorAction SilentlyContinue }
            Write-SupLog "EXTERNAL COMPACTION detected: context estimate dropped $prevEst->$CurrentEst (>=$externalCompactDelta) -- arming cooldown and clearing any pending COMPACT-REQUEST (no double-fire)."
            return $true
        }
        try {
            $tmp = "$compactStateFile.tmp"
            "$lastCompact $CurrentEst" | Set-Content -LiteralPath $tmp -Encoding ascii
            Move-Item -LiteralPath $tmp -Destination $compactStateFile -Force
        } catch { }
        return $false
    }

    function Request-CompactionIfNeeded {
        param([long]$LaunchEpoch, [long]$Now)
        $result = @{ Requested = $false; Force = $false }
        $est = Read-ContextEstimate -LaunchEpoch $LaunchEpoch
        if (Note-ExternalCompaction -Now $Now -CurrentEst $est) { return $result }
        $lastCompact = 0
        if (Test-Path -LiteralPath $compactStateFile) {
            try {
                $first = (Get-Content -LiteralPath $compactStateFile -First 1 -ErrorAction Stop)
                if ($null -ne $first) { $f = ([string]$first).Trim() -split '\s+'; if ($f.Count -ge 1) { [void][int]::TryParse($f[0], [ref]$lastCompact) } }
            } catch { }
        }
        if ($lastCompact -gt 0 -and (($Now - $lastCompact) -lt $compactCooldown)) { return $result }
        if (Test-Path -LiteralPath $compactRequestFile) {
            $reqTs = 0
            try {
                $first = (Get-Content -LiteralPath $compactRequestFile -First 1 -ErrorAction Stop)
                if ($null -ne $first) { $f = ([string]$first).Trim() -split '\s+'; if ($f.Count -ge 1) { [void][int]::TryParse($f[0], [ref]$reqTs) } }
            } catch { }
            if (($Now - $reqTs) -ge $compactGrace) { $result.Force = $true; $result.Requested = $true }
            return $result
        }
        if ($est -ge $compactAt) {
            try {
                $tmp = "$compactRequestFile.tmp"
                "$Now proactive est=$est threshold=$compactAt" | Set-Content -LiteralPath $tmp -Encoding ascii
                Move-Item -LiteralPath $tmp -Destination $compactRequestFile -Force
                Write-SupLog "COMPACT-REQUEST written: context est=$est tokens >= AUTOPROMPT_COMPACT_AT=$compactAt. Parent will checkpoint+compact at its next gate boundary (not a wipe, not a stop)."
            } catch { }
            $result.Requested = $true
        }
        return $result
    }

    function Stop-ProcessTree {
        param($Proc)
        if ($null -eq $Proc) { return }
        $rootId = $null
        try { $rootId = $Proc.Id } catch { $rootId = $null }
        if ($null -ne $rootId) {
            try {
                & taskkill.exe /T /F /PID $rootId 2>$null | Out-Null
                if ($LASTEXITCODE -eq 0) { return }
            } catch { }
            try {
                $all = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue
                $toKill = New-Object System.Collections.Generic.List[int]
                $queue = New-Object System.Collections.Generic.Queue[int]
                $queue.Enqueue([int]$rootId)
                while ($queue.Count -gt 0) {
                    $procId = $queue.Dequeue(); $toKill.Add($procId)
                    foreach ($c in @($all | Where-Object { $_.ParentProcessId -eq $procId })) { $queue.Enqueue([int]$c.ProcessId) }
                }
                foreach ($victim in ($toKill.ToArray() | Sort-Object -Descending)) {
                    try { Stop-Process -Id $victim -Force -ErrorAction SilentlyContinue } catch { }
                }
            } catch { }
        }
        try { $Proc.Kill() } catch { }
    }

    # Run the real or fake launcher once; return its exit code.
    function Invoke-Launcher {
        $script:state.LaunchIndex += 1
        $idx = $script:state.LaunchIndex
        $childLaunchEpoch = [int64][Math]::Floor(([DateTimeOffset](Get-Date)).ToUnixTimeSeconds())
        if (-not $script:state.DryRun) {
            $storedBinding = ''
            if (Test-Path -LiteralPath $scopePhaseStartFile) {
                try {
                    $first = Get-Content -LiteralPath $scopePhaseStartFile -First 1 -ErrorAction Stop
                    if ($null -ne $first) {
                        $fields = ([string]$first).Trim() -split '\s+'
                        if ($fields.Count -ge 2) { $storedBinding = $fields[1] }
                    }
                } catch { $storedBinding = '' }
            }
            if ($storedBinding -cne $scopeMissionBinding) {
                Remove-Item -LiteralPath (Join-Path $ledgerDir 'SCOPE-CONVERGE-REQUEST') -Force -ErrorAction SilentlyContinue
                Remove-Item -LiteralPath (Join-Path $ledgerDir 'SCOPE-BUDGET-BREACH') -Force -ErrorAction SilentlyContinue
                Remove-Item -LiteralPath $scopeResetsFile -Force -ErrorAction SilentlyContinue
                try {
                    $tmp = "$scopePhaseStartFile.tmp"
                    "$childLaunchEpoch $scopeMissionBinding" | Set-Content -LiteralPath $tmp -Encoding ascii
                    Move-Item -LiteralPath $tmp -Destination $scopePhaseStartFile -Force
                } catch {}
            }
        }
        $absLedger = $script:state.LedgerDir
        if (-not [System.IO.Path]::IsPathRooted($absLedger)) {
            $absLedger = Join-Path (Get-Location).Path $absLedger
        }
        if ($script:state.DryRun) {
            # Compute everything in the PARENT (idx-indexed), then background a generated
            # fake-child script via Start-Process so the heartbeat poll loop has a real
            # handle (PLAN-idle-watchdog: background on BOTH paths so the poll loop is
            # exercised under --dry-run). The fake writes the sentinel / advances the
            # frontier / optionally stays alive (FAKE_CHILD_ALIVE), then exits with the code.
            $sentinelAfter = Get-EnvOrDefault 'FAKE_SENTINEL_AFTER' ''
            $writeSentinel = (-not [string]::IsNullOrEmpty($sentinelAfter) -and $idx -ge [int]$sentinelAfter)
            $advance = ((Get-EnvOrDefault 'FAKE_POISON' '0') -ne '1')
            $alive = [int](Get-EnvOrDefault 'FAKE_CHILD_ALIVE' 0)
            $fakeExits = (Get-EnvOrDefault 'FAKE_EXITS' '0').Trim()
            $codes = @($fakeExits -split '\s+' | Where-Object { $_ -ne '' })
            $code = 0
            if ($idx -ge 1 -and $idx -le $codes.Count) { $code = [int]$codes[$idx - 1] }
            $fakeChild = Join-Path $absLedger '.fake-child.ps1'
            @(
                'param($Ledger,$WriteSentinel,$Advance,$Alive,$Code)'
                'if ($WriteSentinel -eq "1") {'
                '  $done = Join-Path $Ledger "DONE-FAKE"'
                '  $tmp = "$done.tmp"'
                '  ''{"done": true, "nonce": "FAKE", "verdict": "fake done", "ts": "now"}'' | Set-Content -LiteralPath $tmp -Encoding ascii -NoNewline'
                '  Move-Item -LiteralPath $tmp -Destination $done -Force'
                '}'
                'if ($Advance -eq "1") {'
                '  $cf = Join-Path $Ledger ".fake-frontier"'
                '  $cur = 0; if (Test-Path -LiteralPath $cf) { $cur = [int]((Get-Content -LiteralPath $cf -Raw).Trim()) }'
                '  ($cur + 1) | Set-Content -LiteralPath $cf -Encoding ascii -NoNewline'
                '}'
                'if ($Alive -gt 0) { Start-Sleep -Seconds $Alive }'
                'exit $Code'
            ) -join "`n" | Set-Content -LiteralPath $fakeChild -Encoding ascii
            $wsArg = if ($writeSentinel) { '1' } else { '0' }
            $advArg = if ($advance) { '1' } else { '0' }
            $proc = Start-Process -FilePath 'powershell' `
                -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $fakeChild, $absLedger, $wsArg, $advArg, "$alive", "$code") `
                -PassThru -NoNewWindow -WorkingDirectory (Get-Location).Path
            return (Wait-ChildWithHeartbeat -Proc $proc)
        }
        # Launch one is fresh unless the operator explicitly requested resume.
        # Relaunches always export AUTOPROMPT_RESUME=1.
        # When $launchCmd is set it is used VERBATIM (word-split into command +
        # args, mission appended) so a fresh user can pass their real CLI;
        # otherwise the bare $launcher label is exec'd as before.
        # MODEL-INHERITANCE NOTE: unlike agents/claude/workflow/supervisor.ps1, this codex
        # supervisor has NO CLAUDE_CODE_SUBAGENT_MODEL neutralization -- the Codex pin
        # is .codex/config.toml model= (an operator file, not an env var), so there is
        # no env to strip. See the MODEL INHERITANCE NOTE header above.
        $previousUnattended = $env:AUTOPROMPT_UNATTENDED
        $previousResume = $env:AUTOPROMPT_RESUME
        $previousMode = $env:AUTOPROMPT_MODE
        $previousRunNonce = $env:AUTOPROMPT_RUN_NONCE
        $previousSessionToken = $env:AUTOPROMPT_SESSION_TOKEN
        $previousAgents = $env:AUTOPROMPT_AGENTS
        $previousCapabilityAttestation = $env:AUTOPROMPT_CAPABILITY_ATTESTATION
        $previousProvider = $env:AUTOPROMPT_PROVIDER
        $previousCliVersion = $env:AUTOPROMPT_CLI_VERSION
        $previousPermissionProfile = $env:AUTOPROMPT_PERMISSION_PROFILE
        $previousAgentDefinitionsHash = $env:AUTOPROMPT_AGENT_DEFINITIONS_HASH
        $previousCastingHash = $env:AUTOPROMPT_CASTING_HASH
        $previousEffortStatus = $env:AUTOPROMPT_EFFORT_STATUS
        $previousEffortSource = $env:AUTOPROMPT_EFFORT_SOURCE
        $env:AUTOPROMPT_UNATTENDED = '1'
        if ($idx -gt 1 -or $initialResume) {
            $env:AUTOPROMPT_RESUME = '1'
        } else {
            $env:AUTOPROMPT_RESUME = $null
        }
        $env:AUTOPROMPT_MODE = $autopromptMode
        if (-not $legacySentinel) { $env:AUTOPROMPT_RUN_NONCE = $runNonce }
        $env:AUTOPROMPT_AGENTS = $agentsSelector
        $env:AUTOPROMPT_PROVIDER = $capabilityProvider
        $env:AUTOPROMPT_CLI_VERSION = $capabilityCliVersion
        $env:AUTOPROMPT_PERMISSION_PROFILE = $capabilityPermissionProfile
        $env:AUTOPROMPT_AGENT_DEFINITIONS_HASH = $capabilityAgentDefinitionsHash
        $env:AUTOPROMPT_CASTING_HASH = $capabilityCastingHash
        $env:AUTOPROMPT_EFFORT_STATUS = $capabilityEffortStatus
        $env:AUTOPROMPT_EFFORT_SOURCE = $capabilityEffortSource
        $env:AUTOPROMPT_CAPABILITY_ATTESTATION = $capabilityAttestation
        # Re-export the held session token ONLY when the supervisor holds one; an empty
        # token is cleared so the first SCRIBE-run resolver MINTS one (then we harvest).
        if (-not [string]::IsNullOrEmpty($sessionToken)) {
            $env:AUTOPROMPT_SESSION_TOKEN = $sessionToken
        } else {
            $env:AUTOPROMPT_SESSION_TOKEN = $null
        }
        try {
            if (-not [string]::IsNullOrEmpty($launchCmd)) {
                $parts = @($launchCmd -split '\s+' | Where-Object { $_ -ne '' })
                $exe   = $parts[0]
                $rest  = @($parts | Select-Object -Skip 1)
                $procArgs = @($rest + @('--profile', $codexProfileName, $mission))
                $proc = Start-Process -FilePath $exe -ArgumentList $procArgs -PassThru -NoNewWindow -WorkingDirectory (Get-Location).Path
            } else {
                $proc = Start-Process -FilePath $launcher -ArgumentList @('--profile', $codexProfileName, $mission) -PassThru -NoNewWindow -WorkingDirectory (Get-Location).Path
            }
            return (Wait-ChildWithHeartbeat -Proc $proc)
        } catch {
            # A launcher that cannot be executed (a bad --cmd/--launcher: user typo
            # or missing alias) throws a TERMINATING error under 'Stop'. Mirror the
            # bash exit 127 so it feeds the SAME poison-guard/relaunch path instead
            # of unwinding the loop and crashing the supervisor with a stack trace.
            Write-SupLog "launch failed: $($_.Exception.Message)"
            return 127
        } finally {
            $env:AUTOPROMPT_UNATTENDED = $previousUnattended
            $env:AUTOPROMPT_RESUME = $previousResume
            $env:AUTOPROMPT_MODE = $previousMode
            $env:AUTOPROMPT_RUN_NONCE = $previousRunNonce
            $env:AUTOPROMPT_SESSION_TOKEN = $previousSessionToken
            $env:AUTOPROMPT_AGENTS = $previousAgents
            $env:AUTOPROMPT_CAPABILITY_ATTESTATION = $previousCapabilityAttestation
            $env:AUTOPROMPT_PROVIDER = $previousProvider
            $env:AUTOPROMPT_CLI_VERSION = $previousCliVersion
            $env:AUTOPROMPT_PERMISSION_PROFILE = $previousPermissionProfile
            $env:AUTOPROMPT_AGENT_DEFINITIONS_HASH = $previousAgentDefinitionsHash
            $env:AUTOPROMPT_CASTING_HASH = $previousCastingHash
            $env:AUTOPROMPT_EFFORT_STATUS = $previousEffortStatus
            $env:AUTOPROMPT_EFFORT_SOURCE = $previousEffortSource
        }
    }

    # Wait-ChildWithHeartbeat (PLAN-idle-watchdog, behavior-parallel to supervisor.sh):
    # poll a backgrounded child for liveness + frontier-COUNT staleness, killing it on an
    # idle-timeout so the outer relaunch loop RESUMEs it. FEEDS the existing poison guard
    # (a no-count-growth heartbeat kill is a no-progress restart). The poll wakes on a
    # responsive 200ms slice so a fast-exiting child is detected promptly; the staleness
    # evaluation runs once per $heartbeatInterval of elapsed wall-clock.
    function Wait-ChildWithHeartbeat {
        param($Proc)
        $handle = $Proc.Handle   # cache the OS handle so .ExitCode populates on exit
        $nowEpoch = { [int64][Math]::Floor(([DateTimeOffset](Get-Date)).ToUnixTimeSeconds()) }
        $childLaunchEpoch = & $nowEpoch
        $lastProgress = & $nowEpoch
        $lastEval = $lastProgress
        $lastSeenCount = Get-FrontierCount
        while (-not $Proc.HasExited) {
            Start-Sleep -Milliseconds 200
            if (Test-SentinelPresent) { break }
            $now = & $nowEpoch
            if (($now - $lastEval) -lt $heartbeatInterval) { continue }
            $lastEval = $now
            $curCount = Get-FrontierCount
            if ($curCount -gt $lastSeenCount) {
                $lastSeenCount = $curCount; $lastProgress = $now
            } elseif (($now - $lastProgress) -ge $idleTimeout) {
                Write-SupLog "HEARTBEAT: no frontier progress for >=${idleTimeout}s while alive and no sentinel -- killing to relaunch with RESUME (auto-continue an idle agent)."
                Stop-ProcessTree -Proc $Proc
                break
            }
            # PLAN-auto-compact-threshold: proactive supervisor-fired compaction check.
            $compact = Request-CompactionIfNeeded -LaunchEpoch $childLaunchEpoch -Now $now
            if ($compact.Force) {
                Write-SupLog "COMPACT FALLBACK: request unhonored for >=${compactGrace}s (parent likely wedged) -- recording a .forced-reset marker, then killing the WHOLE child process tree so no subagent is orphaned; the outer loop RESUMEs from the SCRIBE-refreshed ANCHOR.md."
                try {
                    $tmp = (Join-Path $ledgerDir '.forced-reset.tmp')
                    "$now forced est_unhonored grace=$compactGrace" | Set-Content -LiteralPath $tmp -Encoding ascii
                    Move-Item -LiteralPath $tmp -Destination (Join-Path $ledgerDir '.forced-reset') -Force
                } catch { }
                try {
                    $tmp2 = "$compactStateFile.tmp"
                    "$now forced" | Set-Content -LiteralPath $tmp2 -Encoding ascii
                    Move-Item -LiteralPath $tmp2 -Destination $compactStateFile -Force
                } catch { }
                if (Test-Path -LiteralPath $compactRequestFile) { Remove-Item -LiteralPath $compactRequestFile -Force -ErrorAction SilentlyContinue }
                Stop-ProcessTree -Proc $Proc
                break
            }
            # F-SPEED steer-2 B3: PHASE WALL-CLOCK BUDGET check. Once per tick, when the
            # SCOPE phase is active, consult phase-budget.js. Anchored to scope ENTRY, NOT
            # reset by frontier growth. Fail-open: an absent node/module skips the block.
            $scopeEl = Get-ScopePhaseElapsed
            if ($null -ne $scopeEl -and (Test-Path -LiteralPath $phaseBudgetPath)) {
                $reqAge = Get-ScopeConvergeRequestAge
                $prior = 0
                if (Test-Path -LiteralPath $scopeResetsFile) {
                    try {
                        $pf = (Get-Content -LiteralPath $scopeResetsFile -First 1 -ErrorAction Stop)
                        if ($null -ne $pf) { [void][int]::TryParse(([string]$pf).Trim(), [ref]$prior) }
                    } catch { $prior = 0 }
                }
                $landed = Get-ScopeLandedAngles
                & node $phaseBudgetPath --verdict --phase scope --elapsed $scopeEl `
                    --soft $scopeSoftSec --hard $scopeHardSec --request-age $reqAge `
                    --grace $scopeGraceSec --prior-resets $prior --max-resets $maxScopeResets `
                    --landed $landed *> $null
                $verdictCode = $LASTEXITCODE
                $convergeReqFile = Join-Path $ledgerDir 'SCOPE-CONVERGE-REQUEST'
                if ($verdictCode -eq 10) {
                    if (-not (Test-Path -LiteralPath $convergeReqFile)) {
                        try {
                            $tmp = "$convergeReqFile.tmp"
                            "$now soft scope budget: mission=$scopeMissionBinding elapsed=${scopeEl}s soft=${scopeSoftSec}s landed=$landed -- converge on the landed angles; do NOT fabricate unscoped ones." | Set-Content -LiteralPath $tmp -Encoding ascii
                            Move-Item -LiteralPath $tmp -Destination $convergeReqFile -Force
                        } catch { }
                        Write-SupLog "SCOPE BUDGET soft breach at ${scopeEl}s (>= ${scopeSoftSec}s, frontier advancing) -- wrote SCOPE-CONVERGE-REQUEST (converge on landed=$landed); child NOT killed."
                    }
                } elseif ($verdictCode -eq 20) {
                    try {
                        $breachFile = Join-Path $ledgerDir 'SCOPE-BUDGET-BREACH'
                        $tmp = "$breachFile.tmp"
                        "$now hard scope budget breach: mission=$scopeMissionBinding elapsed=${scopeEl}s hard=${scopeHardSec}s landed=$landed residual=$landed -- converge on landed, surface any unscoped angle; DO NOT fabricate." | Set-Content -LiteralPath $tmp -Encoding ascii
                        Move-Item -LiteralPath $tmp -Destination $breachFile -Force
                    } catch { }
                    try {
                        $tmpR = "$scopeResetsFile.tmp"
                        "$($prior + 1)" | Set-Content -LiteralPath $tmpR -Encoding ascii
                        Move-Item -LiteralPath $tmpR -Destination $scopeResetsFile -Force
                    } catch { }
                    Write-SupLog "SCOPE BUDGET hard breach at ${scopeEl}s (frontier was advancing) -- wrote SCOPE-BUDGET-BREACH (residual=$landed); killing the process tree and terminating this supervisor run."
                    $script:state.ScopeTerminal = $true
                    Stop-ProcessTree -Proc $Proc
                    break
                } elseif ($verdictCode -eq 30) {
                    try {
                        $lines = @(
                            "supervisor escalation: scope budget breached past MAX_SCOPE_RESETS=$maxScopeResets"
                            "scope_elapsed=$scopeEl hard=$scopeHardSec prior_resets=$prior landed=$landed"
                            'converge unreachable -- landed angles surfaced as the honest residual; NO fabricated roadmap'
                            "ts=$((Get-Date).ToString())"
                        )
                        $lines -join [Environment]::NewLine | Set-Content -LiteralPath $escalateFile -Encoding ascii
                    } catch { }
                    Write-SupLog "SCOPE BUDGET escalation at ${scopeEl}s -- breached past MAX_SCOPE_RESETS=$maxScopeResets; landed=$landed surfaced as residual; killing and exiting 1."
                    $script:state.ScopeEscalate = $true
                    Stop-ProcessTree -Proc $Proc
                    break
                }
            }
        }
        try { $Proc.WaitForExit() } catch {}
        $exit = 0
        try { if ($Proc.HasExited) { $exit = $Proc.ExitCode } } catch { $exit = 0 }
        if ($null -eq $exit) { $exit = 0 }
        return $exit
    }

    # Legacy broad DONE-* matching is a DOWNGRADE honored only for a verified
    # legacy resume: the operator opted in explicitly AND the ledger directory
    # carries physical evidence of a pre-nonce run (legacy governance files a
    # three-file new-format run never creates). A fresh or new-format directory
    # fails closed so the downgrade can never weaken a current-format run.
    if ($legacySentinel) {
        $legacyEvidence = $false
        foreach ($marker in @('BRIEF.md', 'AGENTS.md', 'bucketlist.md', 'ANCHOR.md')) {
            if (Test-Path -LiteralPath (Join-Path $ledgerDir $marker) -PathType Leaf) {
                $legacyEvidence = $true
                break
            }
        }
        if (-not $legacyEvidence) {
            [Console]::Error.WriteLine("supervisor: AUTOPROMPT_LEGACY_SENTINEL=1 requires a verified legacy resume (legacy governance files under $ledgerDir); unset it for new runs")
            return 2
        }
    }

    if ([string]::IsNullOrEmpty($launcher) -and [string]::IsNullOrEmpty($launchCmd) -and -not $dryRun) {
        [Console]::Error.WriteLine('supervisor: no launch command (use --cmd "<your CLI>" / AUTOPROMPT_LAUNCH_CMD, or --launcher apidemo|codexdemo / AUTOPROMPT_LAUNCHER)')
        return 2
    }

    $launcherLabel =
        if (-not [string]::IsNullOrEmpty($launchCmd)) { $launchCmd }
        elseif (-not [string]::IsNullOrEmpty($launcher)) { $launcher }
        else { '<dry-run>' }
    Write-SupLog "starting: launcher=$launcherLabel ledger=$ledgerDir mission=`"$mission`""
    Write-SupLog "topology: 5-level L0->L4; mode=$autopromptMode; per-L3 fan-out=$fanout; L3 tracks=$l3Tracks; L1 never executes (rule 68); single-block spawns (rule 67) -- enforced in the harness."
    # Snapshot pre-existing DONE-* PATHS FIRST, THEN quarantine. Order matters: the
    # snapshot must see the dir as it was before any rename, so a failed rename still
    # leaves the path recorded (and vetoed). Quarantine prunes each SUCCESSFULLY
    # renamed path back out of the snapshot, so the net invariant after this pair is:
    # a path is vetoed IFF its stale occupant still physically exists.
    Save-PreExistingSentinels
    Move-StaleSentinelAside

    # EDIT 23: seed the per-conversation session token ONCE, before the relaunch loop.
    # An env-supplied token (operator or a prior same-conversation export) wins and is
    # persisted to the durable file; else a previously-harvested token is read back;
    # else the token stays empty and the first SCRIBE-run resolver MINTS one. Fail-soft:
    # an unwritable/unreadable token file never aborts the run.
    if (-not [string]::IsNullOrEmpty($sessionToken)) {
        try { Set-Content -LiteralPath $sessionTokenFile -Value $sessionToken -Encoding ascii -ErrorAction Stop } catch {}
    } elseif (Test-Path -LiteralPath $sessionTokenFile) {
        try {
            $fileToken = (Get-Content -LiteralPath $sessionTokenFile -First 1 -ErrorAction Stop)
            if ($null -ne $fileToken) { $sessionToken = ([string]$fileToken).Trim() }
        } catch {}
    }

    [long[]]$restartTimes = @()   # epoch seconds of recent restarts (no progress)
    $lastFrontier = Get-FrontierCount
    $backoff = $retryBase

    while ($true) {
        if (Test-SentinelPresent) {
            Write-SupLog 'DONE-sentinel present -- run complete, halting cleanly.'
            return 0
        }

        $exitCode = Invoke-Launcher

        # Scope budget termination is checked before sentinels so a breach cannot be
        # masked by output written during the same tick or poison-relaunch the mission.
        if ($script:state.ScopeEscalate) {
            return 1
        }
        if ($script:state.ScopeTerminal) {
            Write-SupLog 'SCOPE BUDGET terminal stop -- no same-mission relaunch will consume another worker.'
            return 124
        }

        if (Test-SentinelPresent) {
            Write-SupLog "DONE-sentinel present after launch (exit $exitCode) -- run complete, halting cleanly."
            return 0
        }

        # P4 (terminal marker, PLAN-idle-watchdog): the child EXITED with no DONE-
        # sentinel -- a TERMINAL boundary. Write RUN-ENDED so a downstream audit treats
        # this as run-ended. (Codex has NO JS autoprompt-ledger-check.js, so unlike the
        # claude port there is no `node --terminal` audit to invoke; the marker is the
        # doctrine signal.) Written every exit-without-sentinel; idempotent. The clean-
        # DONE path short-circuits above, so RUN-ENDED is only written when not done.
        try {
            "run-ended exit=$exitCode ts=$(Get-Date)" | Set-Content -LiteralPath (Join-Path $ledgerDir 'RUN-ENDED') -Encoding ascii
        } catch {}

        $now = [int64][Math]::Floor(([DateTimeOffset](Get-Date)).ToUnixTimeSeconds())
        $curFrontier = Get-FrontierCount
        # EDIT 23: HARVEST the resolver-minted session token after a launch when the
        # supervisor holds none yet. The SCRIBE-run --resolve-prompt-dir CLI writes the
        # marker "<LedgerDir>/.session-current" as "session_NN  <token>" (two
        # whitespace-separated fields -- the EDIT 7 contract). Read the 2nd field and
        # persist it so the NEXT launch re-exports the SAME token and a 2nd prompt
        # rejoins the same session_NN. Fail-soft: an absent/corrupt marker (no 2nd
        # field) leaves the token empty and the next launch mints again.
        if ([string]::IsNullOrEmpty($sessionToken)) {
            $markerPath = Join-Path $ledgerDir '.session-current'
            if (Test-Path -LiteralPath $markerPath) {
                try {
                    $markerLine = (Get-Content -LiteralPath $markerPath -First 1 -ErrorAction Stop)
                    if ($null -ne $markerLine) {
                        $fields = ([string]$markerLine).Trim() -split '\s+'
                        if ($fields.Count -ge 2 -and -not [string]::IsNullOrEmpty($fields[1])) {
                            $sessionToken = $fields[1]
                            try { Set-Content -LiteralPath $sessionTokenFile -Value $sessionToken -Encoding ascii -ErrorAction Stop } catch {}
                        }
                    }
                } catch {}
            }
        }
        Write-SupLog "launcher exited ($exitCode); frontier $lastFrontier -> $curFrontier; no sentinel -- relaunching with RESUME."

        if ($curFrontier -gt $lastFrontier) {
            # Healthy-long: progress was made. Reset the poison window and backoff.
            $restartTimes = @()
            $backoff = $retryBase
            $lastFrontier = $curFrontier
        } else {
            # No progress since the last launch. Record this restart in the rolling
            # window and check the poison guard.
            $newTimes = New-Object System.Collections.Generic.List[long]
            $rapid = 1
            foreach ($t in $restartTimes) {
                if (($now - $t) -lt $window) {
                    $newTimes.Add($t)
                    $rapid += 1
                }
            }
            $newTimes.Add($now)
            $restartTimes = $newTimes.ToArray()
            if ($rapid -ge $maxRestarts) {
                Write-SupLog "POISON: $rapid restarts within ${window}s with NO frontier progress -- escalating, not relaunching."
                $escalateTs = (Get-Date).ToString()
                $lines = @(
                    'supervisor escalation: crash-loop with no frontier progress'
                    "restarts_in_window=$rapid window_s=$window last_exit=$exitCode frontier=$curFrontier"
                    "ts=$escalateTs"
                )
                $lines -join [Environment]::NewLine | Set-Content -LiteralPath $escalateFile -Encoding ascii
                return 1
            }
            # Exponential backoff, capped, between unproductive relaunches.
            if ($backoff -gt 0) { Start-Sleep -Seconds $backoff }
            $next = $backoff * 2
            if ($next -gt $retryCap) { $next = $retryCap }
            $backoff = $next
        }
    }
}

# Only auto-run when invoked as a script, not when dot-sourced by the test suite.
if ($MyInvocation.InvocationName -ne '.') {
    $exit = Invoke-Supervisor -Argv $args
    exit $exit
}
