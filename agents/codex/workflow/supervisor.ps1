<#
.SYNOPSIS
  Exact-argv PowerShell adapter for the Autoprompt Codex v2 supervisor.

.DESCRIPTION
  The deterministic controller is implemented once in phase-budget.js. This
  adapter does not flatten a command string, relaunch roots, scan sentinel
  globs, or start a child outside the central scheduler. A provider without an
  owned-descendant adapter returns a typed PROVIDER_UNSUPPORTED outcome.
#>
[CmdletBinding(PositionalBinding = $false)]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$SupervisorArguments
)

$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath Env:SENTINEL) {
    [Console]::Error.WriteLine('supervisor: LEGACY_SENTINEL_UNSUPPORTED: modern Codex does not accept SENTINEL overrides')
    # This is a pre-runtime process refusal, so do not enter PowerShell's
    # extensible shutdown path: registered exit handlers can otherwise keep the
    # adapter alive after the diagnostic and hide the required exit code from
    # its parent. Console.Error is synchronous; terminate with the exact code.
    [Environment]::Exit(2)
}
$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$runtime = Join-Path $scriptDirectory 'phase-budget.js'
if (-not [string]::IsNullOrWhiteSpace($env:AUTOPROMPT_RUNTIME) -and
    [IO.Path]::GetFullPath($env:AUTOPROMPT_RUNTIME) -cne [IO.Path]::GetFullPath($runtime)) {
    [Console]::Error.WriteLine('supervisor: ALTERNATE_RUNTIME_UNSUPPORTED: AUTOPROMPT_RUNTIME cannot replace the receipt-bound controller')
    exit 2
}

# Validate and preserve the exact public concurrency mode before entering C0.
# This grants no launch authority; phase-budget.js still verifies every receipt.
$mode = if ([string]::IsNullOrWhiteSpace($env:AUTOPROMPT_MODE)) { 'tokensaver' } else { $env:AUTOPROMPT_MODE }
switch -CaseSensitive ($mode) {
    'tokensaver' { $fanout = 'up to 6 live per wave' }
    'wide' { $fanout = 'wide up to the runtime ceiling' }
    'billionaire' { $fanout = 'wide up to the runtime ceiling' }
    'custom' {
        [double]$parsedCustomMax = 0
        $valid = [double]::TryParse(
            [string]$env:AUTOPROMPT_MAX_CONCURRENT,
            [Globalization.NumberStyles]::Float,
            [Globalization.CultureInfo]::InvariantCulture,
            [ref]$parsedCustomMax
        )
        if (-not $valid -or [double]::IsNaN($parsedCustomMax) -or
            [double]::IsInfinity($parsedCustomMax) -or $parsedCustomMax -lt 1) {
            [Console]::Error.WriteLine('supervisor: custom mode requires a positive numeric AUTOPROMPT_MAX_CONCURRENT')
            exit 2
        }
        $customMax = [Math]::Floor($parsedCustomMax)
        $env:AUTOPROMPT_MAX_CONCURRENT = [string]$customMax
        $fanout = "up to $customMax live per wave (AUTOPROMPT_MAX_CONCURRENT)"
    }
    default { $mode = 'tokensaver'; $fanout = 'up to 6 live per wave' }
}
$env:AUTOPROMPT_MODE = $mode

$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
if ($null -eq $node) {
    [Console]::Error.WriteLine('supervisor: node is required for the canonical Codex runtime')
    exit 2
}

# Scope convergence is implemented by phase-budget.js. These exact durable
# marker names are shell/runtime contract data, not terminal sentinels:
# SCOPE-BUDGET-BREACH and SCOPE-CONVERGE-REQUEST.

# Source-checkout-only contract simulation. Installed payloads contain neither
# .git nor the canonical un-packaged test driver/contract, and an installed
# adapter cannot satisfy the exact source adapter path below.
if ($SupervisorArguments -contains '--dry-run') {
    $testRoot = $env:AUTOPROMPT_TEST_SOURCE_ROOT
    $testDriver = $env:AUTOPROMPT_TEST_CONTRACT_DRIVER
    $testContract = $env:AUTOPROMPT_TEST_CONTRACT_FILE
    $expectedScriptDirectory = if ([string]::IsNullOrWhiteSpace($testRoot)) { '' } else {
        [IO.Path]::GetFullPath((Join-Path $testRoot 'agents/codex/workflow'))
    }
    $expectedDriver = if ([string]::IsNullOrWhiteSpace($testRoot)) { '' } else {
        [IO.Path]::GetFullPath((Join-Path $testRoot 'tests/fixtures/codex-supervisor-contract-dry-run.cjs'))
    }
    $expectedContract = if ([string]::IsNullOrWhiteSpace($testRoot)) { '' } else {
        [IO.Path]::GetFullPath((Join-Path $testRoot 'tests/source/supervisor-mode-contract.test.cjs'))
    }
    if (-not [string]::IsNullOrWhiteSpace($testRoot) -and
        [IO.Path]::GetFullPath($scriptDirectory) -ceq $expectedScriptDirectory -and
        (Test-Path -LiteralPath (Join-Path $testRoot '.git')) -and
        [IO.Path]::GetFullPath($testDriver) -ceq $expectedDriver -and
        [IO.Path]::GetFullPath($testContract) -ceq $expectedContract -and
        (Test-Path -LiteralPath $expectedDriver -PathType Leaf) -and
        (Test-Path -LiteralPath $expectedContract -PathType Leaf)) {
        & $node.Source $expectedDriver '--port' 'powershell' @SupervisorArguments
        exit $LASTEXITCODE
    }
}

if (-not (Test-Path -LiteralPath $runtime -PathType Leaf)) {
    [Console]::Error.WriteLine("supervisor: runtime is not readable: $runtime")
    exit 2
}
$savedErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$runtimeCapabilitiesRaw = & $node.Source $runtime '--supervisor' '--capabilities' 2>$null
$runtimeProbeExitCode = $LASTEXITCODE
$ErrorActionPreference = $savedErrorActionPreference
if ($runtimeProbeExitCode -ne 0) {
    [Console]::Error.WriteLine('supervisor: RUNTIME_CONTROLLER_INVALID: canonical controller probe failed')
    exit 2
}
try { $runtimeCapabilities = $runtimeCapabilitiesRaw | ConvertFrom-Json } catch {
    [Console]::Error.WriteLine('supervisor: RUNTIME_CONTROLLER_INVALID: canonical controller probe returned corrupt JSON')
    exit 2
}
if ($runtimeCapabilities.schemaVersion -ne 2 -or $runtimeCapabilities.provider -cne 'codex') {
    [Console]::Error.WriteLine('supervisor: RUNTIME_CONTROLLER_INVALID: canonical controller version/provider mismatch')
    exit 2
}

# Explicit-entry/resume values are adapter data, not heuristic prompt matching.
$env:AUTOPROMPT_ENTRY_PROMPT = '$autoprompt'
$env:AUTOPROMPT_RESUME_PROMPT = '$autoprompt resume '

if ($mode -ceq 'custom') {
    [Console]::Out.WriteLine("mode=custom; per-L3 fan-out=$fanout")
}

# The call operator with an argument array preserves spaces, empty strings,
# quotes, backslashes, Unicode, and leading -- without argument flattening.
$argumentList = @($runtime, '--supervisor') + @($SupervisorArguments)
& $node.Source @argumentList
exit $LASTEXITCODE
