'use strict'

const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const START_TIMEOUT_MS = 15000
const RELEASE_TIMEOUT_MS = 5000
const MAX_LOCK_BYTES = 4096
const POWERSHELL_SOURCE = String.raw`
$ErrorActionPreference = 'Stop'
$leasePath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:AUTOPROMPT_TOOL_LEASE_PATH_B64))
$leaseBytes = [Convert]::FromBase64String($env:AUTOPROMPT_TOOL_LEASE_BYTES_B64)
$readyPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:AUTOPROMPT_TOOL_LEASE_READY_PATH_B64))
$readyBytes = [Convert]::FromBase64String($env:AUTOPROMPT_TOOL_LEASE_READY_BYTES_B64)
function ConvertTo-ExtendedLeasePath([string]$value) {
  # Windows PowerShell is hosted by .NET Framework, whose ordinary path
  # normalization can retain MAX_PATH behavior. The controller supplied only
  # absolute, normalized Windows paths; use the documented device spelling
  # solely for the holder's FileStream and Move calls.
  if ($value.StartsWith('\\?\')) { return $value }
  if ($value.Length -ge 3 -and $value[1] -eq ':' -and $value[2] -eq '\') { return '\\?\' + $value }
  if ($value.StartsWith('\\')) { return '\\?\UNC\' + $value.Substring(2) }
  # The non-Windows PowerShell probe intentionally exercises the same holder
  # lifecycle with native POSIX temporary paths.
  if ($value.StartsWith('/')) { return $value }
  throw 'AUTOPROMPT_TOOL_LEASE_PATH_INVALID'
}
$leaseNativePath = ConvertTo-ExtendedLeasePath $leasePath
$readyNativePath = ConvertTo-ExtendedLeasePath $readyPath
$stream = [IO.FileStream]::new($leaseNativePath, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read, 4096, [IO.FileOptions]::DeleteOnClose)
try {
  $stream.Write($leaseBytes, 0, $leaseBytes.Length)
  $stream.Flush($true)
  $readyStagingNativePath = ConvertTo-ExtendedLeasePath ($readyPath + '.staging')
  $ready = [IO.FileStream]::new($readyStagingNativePath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
  try { $ready.Write($readyBytes, 0, $readyBytes.Length); $ready.Flush($true) } finally { $ready.Dispose() }
  # Publish only after closing the writer. A readable FileShare.Read handle
  # still forbids the controller from deleting the readiness receipt.
  [IO.File]::Move($readyStagingNativePath, $readyNativePath)
  [Console]::In.ReadLine() | Out-Null
} finally {
  $stream.Dispose()
}
`

function fail(code, message) { const error = new Error(message); error.code = code; throw error }
function sleep(milliseconds) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds) }
function exactFile(file, expected, filesystem = fs) {
  try {
    const item = filesystem.lstatSync(file)
    return item.isFile() && !item.isSymbolicLink() && item.nlink === 1 && filesystem.readFileSync(file).equals(expected)
  } catch { return false }
}
function minimalEnvironment(environment, lockPath, lockBytes, readyPath, readyBytes) {
  const systemRoot = environment.SystemRoot, systemDrive = path.win32.parse(systemRoot).root.slice(0, 2)
  const result = {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    SystemDrive: systemDrive,
    PATH: path.win32.join(systemRoot, 'System32'),
    TEMP: path.win32.dirname(lockPath),
    TMP: path.win32.dirname(lockPath),
    AUTOPROMPT_TOOL_LEASE_PATH_B64: Buffer.from(lockPath, 'utf8').toString('base64'),
    AUTOPROMPT_TOOL_LEASE_BYTES_B64: lockBytes.toString('base64'),
    AUTOPROMPT_TOOL_LEASE_READY_PATH_B64: Buffer.from(readyPath, 'utf8').toString('base64'),
    AUTOPROMPT_TOOL_LEASE_READY_BYTES_B64: readyBytes.toString('base64'),
  }
  return result
}

function createWindowsToolLease(options) {
  const platform = options.platform || process.platform
  const filesystem = options.fs || fs, spawn = options.spawn || childProcess.spawn
  const wait = options.wait || sleep, environment = options.environment || process.env
  const lockPath = options.lockPath, lockBytes = Buffer.from(options.lockBytes || '')
  if (platform !== 'win32') fail('TOOL_LEASE_UNAVAILABLE', 'The Windows tool lease requires native Windows')
  if (typeof lockPath !== 'string' || !path.win32.isAbsolute(lockPath) || lockBytes.length < 1 || lockBytes.length > MAX_LOCK_BYTES) {
    fail('TOOL_LEASE_INVALID', 'The Windows tool lease binding is invalid')
  }
  const systemRoot = environment.SystemRoot
  if (typeof systemRoot !== 'string' || !/^[A-Za-z]:\\Windows$/i.test(systemRoot) || !filesystem.existsSync(systemRoot)) fail('TOOL_LEASE_UNAVAILABLE', 'The Windows system root is unavailable')
  if (filesystem.existsSync(lockPath)) fail('TOOL_LEASE_INVALID', 'The Windows tool lease path already exists')
  const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  if (!filesystem.existsSync(powershell)) fail('TOOL_LEASE_UNAVAILABLE', 'The Windows PowerShell runtime is unavailable')
  const readyBytes = Buffer.from(crypto.randomBytes(32).toString('hex'))
  const readyPath = `${lockPath}.ready-${readyBytes.toString('ascii')}`
  const encoded = Buffer.from(POWERSHELL_SOURCE, 'utf16le').toString('base64')
  let child
  try {
    child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      cwd: path.win32.dirname(powershell), env: minimalEnvironment(environment, lockPath, lockBytes, readyPath, readyBytes),
      shell: false, windowsHide: true, detached: false, stdio: ['pipe', 'ignore', 'pipe'],
    })
  } catch (error) { fail('TOOL_LEASE_UNAVAILABLE', `The Windows tool lease holder could not start: ${error.code || 'ERROR'}`) }
  let stderr = Buffer.alloc(0), childError = null, releasePromise = null
  const settled = new Promise(resolve => {
    child.once('error', error => { childError = error; resolve({ error }) })
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  child.stdin.on('error', () => {})
  child.stderr.on('data', bytes => { stderr = Buffer.concat([stderr, Buffer.from(bytes)]).subarray(-4096) })
  const deadline = Date.now() + (options.startTimeoutMs || START_TIMEOUT_MS)
  while (!exactFile(lockPath, lockBytes, filesystem) || !exactFile(readyPath, readyBytes, filesystem)) {
    if (childError || Date.now() >= deadline) {
      try { child.kill('SIGKILL') } catch {}
      try { child.stdin.destroy() } catch {}
      try { if (exactFile(readyPath, readyBytes, filesystem)) filesystem.unlinkSync(readyPath) } catch {}
      fail('TOOL_LEASE_UNAVAILABLE', `The Windows tool lease holder did not establish its exact lease${childError ? `: ${childError.code || 'ERROR'}` : stderr.length ? `: ${stderr.toString('utf8').trim().slice(-512)}` : ''}`)
    }
    wait(10)
  }
  try { filesystem.unlinkSync(readyPath) } catch {
    try { child.kill('SIGKILL') } catch {}
    try { child.stdin.destroy() } catch {}
    fail('TOOL_LEASE_UNAVAILABLE', 'The Windows tool lease readiness receipt could not be consumed')
  }
  return Object.freeze({
    path: lockPath,
    pid: child.pid,
    assertHeld() { if (releasePromise || childError || !exactFile(lockPath, lockBytes, filesystem)) fail('TOOL_LEASE_LOST', 'The Windows tool lease is no longer held') },
    release() {
      if (releasePromise) return releasePromise
      releasePromise = (async () => {
        child.stdin.end('\n')
        const timeoutMs = options.releaseTimeoutMs || RELEASE_TIMEOUT_MS
        let timer
        const result = await Promise.race([settled, new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs) })])
        clearTimeout(timer)
        if (!result) {
          try { child.kill('SIGKILL') } catch {}
          fail('TOOL_LEASE_RELEASE_FAILED', 'The Windows tool lease holder did not stop')
        }
        if (result.error) fail('TOOL_LEASE_RELEASE_FAILED', `The Windows tool lease holder failed: ${result.error.code || 'ERROR'}`)
        const absentDeadline = Date.now() + timeoutMs
        while (filesystem.existsSync(lockPath) && Date.now() < absentDeadline) await new Promise(resolve => setTimeout(resolve, 10))
        if (filesystem.existsSync(lockPath)) fail('TOOL_LEASE_RELEASE_FAILED', 'The Windows tool lease was not released')
      })()
      return releasePromise
    },
  })
}

// Async counterpart used by protocol servers whose event loop must remain
// responsive while PowerShell establishes the lease. The synchronous API is
// retained for native bootstrap helpers and deterministic unit fixtures.
async function createWindowsToolLeaseAsync(options) {
  const platform = options.platform || process.platform
  const filesystem = options.fs || fs, spawn = options.spawn || childProcess.spawn, environment = options.environment || process.env
  const lockPath = options.lockPath, lockBytes = Buffer.from(options.lockBytes || '')
  if (platform !== 'win32') fail('TOOL_LEASE_UNAVAILABLE', 'The Windows tool lease requires native Windows')
  if (typeof lockPath !== 'string' || !path.win32.isAbsolute(lockPath) || lockBytes.length < 1 || lockBytes.length > MAX_LOCK_BYTES) fail('TOOL_LEASE_INVALID', 'The Windows tool lease binding is invalid')
  const systemRoot = environment.SystemRoot
  if (typeof systemRoot !== 'string' || !/^[A-Za-z]:\\Windows$/i.test(systemRoot) || !filesystem.existsSync(systemRoot)) fail('TOOL_LEASE_UNAVAILABLE', 'The Windows system root is unavailable')
  if (filesystem.existsSync(lockPath)) fail('TOOL_LEASE_INVALID', 'The Windows tool lease path already exists')
  const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  if (!filesystem.existsSync(powershell)) fail('TOOL_LEASE_UNAVAILABLE', 'The Windows PowerShell runtime is unavailable')
  const readyBytes = Buffer.from(crypto.randomBytes(32).toString('hex')), readyPath = `${lockPath}.ready-${readyBytes.toString('ascii')}`
  const encoded = Buffer.from(POWERSHELL_SOURCE, 'utf16le').toString('base64')
  let child
  try {
    child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      cwd: path.win32.dirname(powershell), env: minimalEnvironment(environment, lockPath, lockBytes, readyPath, readyBytes),
      shell: false, windowsHide: true, detached: false, stdio: ['pipe', 'ignore', 'pipe'],
    })
  } catch (error) { fail('TOOL_LEASE_UNAVAILABLE', `The Windows tool lease holder could not start: ${error.code || 'ERROR'}`) }
  let stderr = Buffer.alloc(0), childError = null, releasePromise = null
  const settled = new Promise(resolve => {
    child.once('error', error => { childError = error; resolve({ error }) })
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  child.stdin.on('error', () => {})
  child.stderr.on('data', bytes => { stderr = Buffer.concat([stderr, Buffer.from(bytes)]).subarray(-4096) })
  const deadline = Date.now() + (options.startTimeoutMs || START_TIMEOUT_MS)
  while (!exactFile(lockPath, lockBytes, filesystem) || !exactFile(readyPath, readyBytes, filesystem)) {
    if (childError || Date.now() >= deadline) {
      try { child.kill('SIGKILL') } catch {}
      try { child.stdin.destroy() } catch {}
      try { if (exactFile(readyPath, readyBytes, filesystem)) filesystem.unlinkSync(readyPath) } catch {}
      fail('TOOL_LEASE_UNAVAILABLE', `The Windows tool lease holder did not establish its exact lease${childError ? `: ${childError.code || 'ERROR'}` : stderr.length ? `: ${stderr.toString('utf8').trim().slice(-512)}` : ''}`)
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  try { filesystem.unlinkSync(readyPath) } catch {
    try { child.kill('SIGKILL') } catch {}
    try { child.stdin.destroy() } catch {}
    fail('TOOL_LEASE_UNAVAILABLE', 'The Windows tool lease readiness receipt could not be consumed')
  }
  return Object.freeze({
    path: lockPath, pid: child.pid,
    assertHeld() { if (releasePromise || childError || !exactFile(lockPath, lockBytes, filesystem)) fail('TOOL_LEASE_LOST', 'The Windows tool lease is no longer held') },
    release() {
      if (releasePromise) return releasePromise
      releasePromise = (async () => {
        child.stdin.end('\n')
        const timeoutMs = options.releaseTimeoutMs || RELEASE_TIMEOUT_MS
        let timer
        const result = await Promise.race([settled, new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs) })])
        clearTimeout(timer)
        if (!result) { try { child.kill('SIGKILL') } catch {}; fail('TOOL_LEASE_RELEASE_FAILED', 'The Windows tool lease holder did not stop') }
        if (result.error) fail('TOOL_LEASE_RELEASE_FAILED', `The Windows tool lease holder failed: ${result.error.code || 'ERROR'}`)
        const absentDeadline = Date.now() + timeoutMs
        while (filesystem.existsSync(lockPath) && Date.now() < absentDeadline) await new Promise(resolve => setTimeout(resolve, 10))
        if (filesystem.existsSync(lockPath)) fail('TOOL_LEASE_RELEASE_FAILED', 'The Windows tool lease was not released')
      })()
      return releasePromise
    },
  })
}

module.exports = { START_TIMEOUT_MS, RELEASE_TIMEOUT_MS, MAX_LOCK_BYTES, POWERSHELL_SOURCE, exactFile, minimalEnvironment, createWindowsToolLease, createWindowsToolLeaseAsync }
