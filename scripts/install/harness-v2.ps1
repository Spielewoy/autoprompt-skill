# Private v2 package routing shared by the public PowerShell entrypoints.
function Test-HarnessV2Provider {
    param([string]$Client)
    return $Client -cin @('claude','opencode','kilo','vscode','prime','omp','deepseek','hermes','grok')
}
function Get-HarnessV2Root {
    param([string]$Client)
    $root = & node -e 'process.stdout.write(require(process.argv[1]).resolveRoot(process.argv[2]))' (Join-Path $RepoRoot 'scripts/harness-v2-package.cjs') $Client
    if ($LASTEXITCODE -ne 0) { throw "Invalid v2 config root for $Client" }
    return [string]$root
}
function Install-HarnessV2Lifecycle {
    param([string]$Client)
    try {
        $root = Get-HarnessV2Root -Client $Client
        & node (Join-Path $RepoRoot 'scripts/harness-v2-package.cjs') install $Client --root $root
        if ($LASTEXITCODE -ne 0) { throw 'Private v2 lifecycle failed' }
        $script:ResultRows += "RESULT=PASS client=$Client dest=$root format=private-v2"
    } catch {
        [Console]::Error.WriteLine($_)
        $script:ResultRows += "RESULT=FAIL client=$Client stage=lifecycle"
        $script:AnyFail = 1
    }
}
function Uninstall-HarnessV2Lifecycle {
    param([string]$Client)
    try {
        $root = Get-HarnessV2Root -Client $Client
        $output = @(& node (Join-Path $RepoRoot 'scripts/harness-v2-package.cjs') uninstall $Client --root $root)
        if ($LASTEXITCODE -ne 0) { throw 'Private v2 lifecycle failed' }
        if ($output.Count -ne 1) { throw 'Private v2 lifecycle returned an invalid result' }
        $result = $output[0] | ConvertFrom-Json -ErrorAction Stop
        if ($result.status -ceq 'uninstalled') {
            $script:ResultRows += "RESULT=OK client=$Client removed=private-v2"
        } elseif ($result.status -ceq 'not-installed') {
            $script:ResultRows += "SKIP=skip client=$Client reason=no-receipt"
        } else {
            throw 'Private v2 lifecycle returned an unknown uninstall status'
        }
    } catch {
        [Console]::Error.WriteLine($_)
        $script:ResultRows += "RESULT=FAIL client=$Client code=1"
        $script:UninstallExitCode = 1
    }
}
function Get-HarnessV2Status {
    param([string]$Client)
    $detected = 'no'; $version = '-'
    $installed = 'no'; $verifies = 'no'; $reason = 'not-installed'; $activation = 'unavailable'; $payload = 'unverified'; $message = ''
    try {
        $root = if ($Client -ceq 'reasonix') { Get-ConfigRoot -Client $Client } else { Get-HarnessV2Root -Client $Client }
        if (Test-Path -LiteralPath (Join-Path $root ".autoprompt-$Client-v2.json")) {
            $installed = 'yes'
            $arguments = if ($Client -ceq 'reasonix') { @((Join-Path $RepoRoot 'scripts/reasonix-package.cjs'), 'doctor', '--root', $root) } else { @((Join-Path $RepoRoot 'scripts/harness-v2-package.cjs'), 'doctor', $Client, '--root', $root) }
            $output = @(& node @arguments 2>$null)
            $code = $LASTEXITCODE
            try {
                $result = ($output -join "`n") | ConvertFrom-Json -ErrorAction Stop
                if ($result.payload -cne 'verified' -or $result.activation -cnotin @('unavailable','local-canary-required','static-ready;dynamic-preflight-required')) { throw 'Invalid doctor response' }
                $detected = if ($result.detected -eq $true) { 'yes' } else { 'no' }
                if ($result.nativeVersion -is [string] -and $result.nativeVersion -cmatch '^[A-Za-z0-9.+-]+$') { $version = $result.nativeVersion }
                $payload = $result.payload; $activation = $result.activation; $reason = $result.reason; $message = $result.message
                if ($code -eq 0 -and $activation -cne 'unavailable') { $verifies = 'yes' }
            } catch { $reason = 'payload-invalid' }
        } elseif (Get-Command $AutopromptClientBin[$Client] -ErrorAction SilentlyContinue) { $detected = 'yes' }
    } catch { $reason = 'invalid-root' }
    return @{ Detected = $detected; Installed = $installed; Verifies = $verifies; Version = $version; Reason = $reason; Extras = $(if ($payload -ceq 'verified') { 'complete' } else { 'missing' }); Mode = '-'; Support = 'degraded'; Activation = $activation; Payload = $payload; Message = $message }
}
