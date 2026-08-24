# uninstall.ps1 -- runnable entry point that reverses a Autoprompt install to ZERO
# residue, restoring any config edits byte-for-byte. Behavior-faithful twin of
# uninstall.sh.
#
# THIN ORCHESTRATOR over lib/install-lib.ps1; the reversal is Uninstall-Client's job.
# RECEIPT MODEL: one receipt per CONFIG-ROOT whose files[] can span several clients
# sharing the root. So `uninstall.ps1 all` uninstalls each DISTINCT config-root once;
# `uninstall.ps1 <client>` removes the receipt under that client's root.
#
# Test isolation: HOME / XDG_CONFIG_HOME honored if set. A root with no receipt is a
# non-fatal SKIP.

[CmdletBinding()]
param([Parameter(Position = 0)][string]$Target)

$ErrorActionPreference = 'Continue'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Lib = Join-Path $ScriptDir 'lib/install-lib.ps1'
$RepoRoot = (Resolve-Path (Join-Path $ScriptDir '../..')).Path
if (-not (Test-Path -LiteralPath $Lib -PathType Leaf)) {
    [Console]::Error.WriteLine("Autoprompt uninstall: library not found at $Lib -- is the repo intact?")
    exit 1
}
. $Lib

$ClientsAll = @(
    'prime','vscode','claude','codex','opencode','kilo',
    'omp','deepseek','reasonix'
)
$LegacyCleanupClients = @('vibe','cursor','roo','gemini','cline','goose','dcode')
$script:ResultRows = @()
$script:UninstallExitCode = 0

function Write-Usage {
    [Console]::Error.WriteLine("Usage: uninstall.ps1 <client>|all")
    [Console]::Error.WriteLine("  clients: $($ClientsAll -join ' ')")
}

function Get-HomeDir {
    if ($env:HOME) { return $env:HOME }
    if ($env:USERPROFILE) { return $env:USERPROFILE }
    return [Environment]::GetFolderPath('UserProfile')
}

function Get-ConfigRoot {
    param([string]$Client)
    return (Get-AutopromptConfigRoot -Name $Client)
}

function Invoke-LibRecord {
    param([scriptblock]$Call)
    $sw = New-Object System.IO.StringWriter
    $orig = [Console]::Out
    [Console]::SetOut($sw)
    try { $code = & $Call } finally { [Console]::SetOut($orig) }
    return @{ Code = [int]$code; Record = $sw.ToString().Trim() }
}

function Invoke-CodexActivationRevocation {
    param([string]$Root)
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return $true }
    $helper = Join-Path $RepoRoot 'scripts/codex-configure.cjs'
    if (-not (Get-Command node -ErrorAction SilentlyContinue) -or
        -not (Test-Path -LiteralPath $helper -PathType Leaf)) {
        [Console]::Error.WriteLine(
            'Autoprompt uninstall (codex): unresolved activation state; node/helper unavailable.'
        )
        return $false
    }
    $hadOverride = Test-Path Env:AUTOPROMPT_INSTALL_ROOT
    $previousOverride = $env:AUTOPROMPT_INSTALL_ROOT
    try {
        $env:AUTOPROMPT_INSTALL_ROOT = $Root
        $output = @(& node $helper --revoke-all 2>&1)
        if ($LASTEXITCODE -ne 0) {
            foreach ($line in $output) { [Console]::Error.WriteLine($line) }
            return $false
        }
        return $true
    } finally {
        if ($hadOverride) { $env:AUTOPROMPT_INSTALL_ROOT = $previousOverride }
        else { Remove-Item Env:AUTOPROMPT_INSTALL_ROOT -ErrorAction SilentlyContinue }
    }
}

function Test-CodexKnownResidue {
    param([string]$Root)
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return $false }
    $helper = Join-Path $RepoRoot 'scripts/codex-configure.cjs'
    if (-not (Get-Command node -ErrorAction SilentlyContinue) -or
        -not (Test-Path -LiteralPath $helper -PathType Leaf)) { return $true }
    $hadOverride = Test-Path Env:AUTOPROMPT_INSTALL_ROOT
    $previousOverride = $env:AUTOPROMPT_INSTALL_ROOT
    try {
        $env:AUTOPROMPT_INSTALL_ROOT = $Root
        $output = @(& node $helper --has-known-residue 2>&1)
        $code = $LASTEXITCODE
        if ($code -ne 0) {
            foreach ($line in $output) { [Console]::Error.WriteLine($line) }
        }
        return ($code -ne 0)
    } finally {
        if ($hadOverride) { $env:AUTOPROMPT_INSTALL_ROOT = $previousOverride }
        else { Remove-Item Env:AUTOPROMPT_INSTALL_ROOT -ErrorAction SilentlyContinue }
    }
}

function Uninstall-Root {
    param([string]$Root, [string]$Label)
    if ($Label -ceq 'codex' -and -not (Invoke-CodexActivationRevocation -Root $Root)) {
        $script:ResultRows += "RESULT=FAIL client=$Label code=1"
        $script:UninstallExitCode = 1
        return
    }
    $receipt = Join-Path $Root $AutopromptReceiptName
    if (-not (Test-Path -LiteralPath $receipt -PathType Leaf)) {
        if ($Label -ceq 'codex' -and (Test-CodexKnownResidue -Root $Root)) {
            [Console]::Error.WriteLine(
                "Autoprompt uninstall (codex): unresolved residue remains under $Root categories=managed,known-legacy,unresolved-collision."
            )
            $script:ResultRows += "RESULT=FAIL client=$Label code=3"
            $script:UninstallExitCode = 1
            return
        }
        [Console]::Error.WriteLine("Autoprompt uninstall ($Label): SKIP -- no install receipt under $Root.")
        $script:ResultRows += "SKIP=skip client=$Label reason=no-receipt"
        return
    }
    $r = Invoke-LibRecord -Call { Uninstall-Client -ConfigRoot $Root -Name $Label }
    if ($r.Code -ne 0) {
        [Console]::Error.WriteLine("Autoprompt uninstall ($Label): failed (code $($r.Code), see message above).")
        $script:ResultRows += "RESULT=FAIL client=$Label code=$($r.Code)"
        if ($r.Code -eq 77) { $script:UninstallExitCode = 77 }
        elseif ($script:UninstallExitCode -ne 77) { $script:UninstallExitCode = 1 }
        return
    }
    if ($Label -ceq 'codex' -and (Test-CodexKnownResidue -Root $Root)) {
        [Console]::Error.WriteLine(
            "Autoprompt uninstall (codex): unresolved residue remains under $Root categories=managed,known-legacy,unresolved-collision."
        )
        $script:ResultRows += "RESULT=FAIL client=$Label code=3"
        $script:UninstallExitCode = 1
        return
    }
    $removed = ($r.Record -replace '^.*uninstall=ok removed=', '') -replace ' .*$', ''
    [Console]::Error.WriteLine("Autoprompt uninstall ($Label): OK -- $($r.Record)")
    $script:ResultRows += "RESULT=OK client=$Label removed=$removed"
}

function Uninstall-PrimeLifecycle {
    $root = Get-ConfigRoot -Client 'prime'
    $receipt = Join-Path $root '.autoprompt-prime-install.json'
    if (-not (Test-Path -LiteralPath $receipt -PathType Leaf)) {
        [Console]::Error.WriteLine(
            "Autoprompt uninstall (prime): SKIP -- no install receipt under $root."
        )
        $script:ResultRows += 'SKIP=skip client=prime reason=no-receipt'
        return
    }
    $helper = Join-Path $ScriptDir 'prime-lifecycle.cjs'
    if (-not (Get-Command node -ErrorAction SilentlyContinue) -or
        -not (Test-Path -LiteralPath $helper -PathType Leaf)) {
        [Console]::Error.WriteLine(
            'Autoprompt uninstall (prime): node or the Prime lifecycle helper is missing.'
        )
        $script:ResultRows += 'RESULT=FAIL client=prime code=3'
        $script:UninstallExitCode = 1
        return
    }
    $output = @(& node $helper uninstall --repo-root $RepoRoot)
    $code = $LASTEXITCODE
    if ($code -ne 0 -or $output.Count -eq 0) {
        [Console]::Error.WriteLine("Autoprompt uninstall (prime): failed (code $code).")
        $script:ResultRows += "RESULT=FAIL client=prime code=$code"
        $script:UninstallExitCode = 1
        return
    }
    [Console]::Error.WriteLine(
        'Autoprompt uninstall (prime): OK -- removed the 48-file package and owned settings.'
    )
    $script:ResultRows += 'RESULT=OK client=prime removed=48'
}

function Write-Matrix {
    [Console]::Out.WriteLine("")
    [Console]::Out.WriteLine("==== Autoprompt uninstall matrix ====")
    foreach ($line in $script:ResultRows) {
        $client = ($line -replace '^.* client=', '') -replace ' .*$', ''
        if ($line -like 'RESULT=OK*') {
            $removed = ($line -replace '^.* removed=', '') -replace ' .*$', ''
            [Console]::Out.WriteLine(("  OK    {0,-9} removed={1}" -f $client, $removed))
        } elseif ($line -like 'RESULT=FAIL*') {
            $code = ($line -replace '^.* code=', '') -replace ' .*$', ''
            [Console]::Out.WriteLine(("  FAIL  {0,-9} code={1}" -f $client, $code))
        } elseif ($line -like 'SKIP=*') {
            $reason = ($line -replace '^.* reason=', '') -replace ' .*$', ''
            [Console]::Out.WriteLine(("  SKIP  {0,-9} reason={1}" -f $client, $reason))
        }
    }
    [Console]::Out.WriteLine("======================================")
}

# --- main ---
if ([string]::IsNullOrEmpty($Target)) { Write-Usage; exit 2 }
if (-not (Test-AutopromptInstallRootContract -Target $Target)) { exit 2 }

if ($Target -eq 'all') {
    foreach ($c in $ClientsAll) {
        if ($c -ceq 'prime') { Uninstall-PrimeLifecycle }
        else {
            $root = Get-ConfigRoot -Client $c
            Uninstall-Root -Root $root -Label $c
        }
    }
    Write-Matrix
    exit $script:UninstallExitCode
}

if ($ClientsAll -notcontains $Target -and $LegacyCleanupClients -notcontains $Target) {
    [Console]::Error.WriteLine("Autoprompt uninstall: unknown client $Target.")
    Write-Usage; exit 2
}
if ($Target -ceq 'prime') { Uninstall-PrimeLifecycle }
else { Uninstall-Root -Root (Get-ConfigRoot -Client $Target) -Label $Target }
Write-Matrix
exit $script:UninstallExitCode
