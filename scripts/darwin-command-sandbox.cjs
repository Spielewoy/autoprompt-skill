'use strict'

// This backend is intentionally not wired into harness-v2-tool-boundary yet.
// It is an activation-bound Darwin primitive, not a fallback for platforms
// without complete coalition and Seatbelt evidence.
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { ProcessOwner, prepareProcessLaunchEnvironment } = require('../agents/codex/workflow/process-owner.js')
const { OwnedCodexProxyRunner } = require('../agents/codex/workflow/phase-budget.js')
const { createDarwinCoalitionAdapter } = require('../agents/codex/workflow/darwin-launchd-process.js')

const HASH = /^[a-f0-9]{64}$/
const OUTPUT_LIMIT = 1024 * 1024
const SYSTEM_SANDBOX_EXEC = '/usr/bin/sandbox-exec'
const digest = value => crypto.createHash('sha256').update(value).digest('hex')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

class DarwinCommandError extends Error {
  constructor(code, message) { super(message); this.name = 'DarwinCommandError'; this.code = code }
}
function fail(code, message) { throw new DarwinCommandError(code, message) }
function quoted(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0') || /[\r\n]/.test(value)) fail('COMMAND_SANDBOX_UNSUPPORTED', 'Darwin sandbox path is invalid')
  return JSON.stringify(value)
}
function physicalDirectory(directory) {
  const resolved = fs.realpathSync.native(directory)
  const stat = fs.lstatSync(resolved)
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('COMMAND_SANDBOX_UNSUPPORTED', 'Darwin sandbox root is not a physical directory')
  return resolved
}
function boundExecutable(binding, expectedPath) {
  if (!binding || typeof binding !== 'object' || !path.isAbsolute(binding.path || '') || !HASH.test(binding.sha256 || '') ||
      (expectedPath && binding.path !== expectedPath)) fail('COMMAND_SANDBOX_UNSUPPORTED', 'Darwin sandbox executable lacks an exact binding')
  const before = fs.lstatSync(binding.path)
  if (!before.isFile() || before.isSymbolicLink()) fail('COMMAND_SANDBOX_UNSUPPORTED', 'Darwin sandbox executable is not a regular file')
  const bytes = fs.readFileSync(binding.path)
  const after = fs.lstatSync(binding.path)
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || digest(bytes) !== binding.sha256) {
    fail('COMMAND_SANDBOX_UNSUPPORTED', 'Darwin sandbox executable changed while validating')
  }
  return binding.path
}
function systemSandboxBinding(options = {}) {
  if (options.sandboxExecutable) return Object.freeze({ ...options.sandboxExecutable })
  const bytes = fs.readFileSync(SYSTEM_SANDBOX_EXEC)
  return Object.freeze({ path: SYSTEM_SANDBOX_EXEC, sha256: digest(bytes) })
}
function ancestors(directory) {
  const values = []
  for (let current = directory; ; current = path.dirname(current)) {
    values.push(current)
    if (current === '/') return values
  }
}
function renderSeatbeltProfile(policy, options = {}) {
  if (!policy || !Array.isArray(policy.readableRoots) || !Array.isArray(policy.writableRoots)) fail('TOOL_POLICY_INVALID', 'Darwin command policy has no authenticated roots')
  const node = fs.realpathSync.native(options.nodePath || process.execPath)
  const nodeStat = fs.lstatSync(node)
  if (!nodeStat.isFile() || nodeStat.isSymbolicLink()) fail('COMMAND_SANDBOX_UNSUPPORTED', 'Darwin Node runtime is not a physical executable')
  const temp = physicalDirectory(options.tempRoot)
  const reads = [...new Set(policy.readableRoots.map(physicalDirectory))]
  const writes = [...new Set(policy.writableRoots.map(physicalDirectory))]
  const metadata = new Set(['/', ...ancestors(node), ...ancestors(temp), ...reads.flatMap(ancestors), ...writes.flatMap(ancestors)])
  const lines = ['(version 1)', '(deny default)',
    ...[...metadata].sort().map(item => `(allow file-read-metadata (literal ${quoted(item)}))`),
    // Node is launched directly. It may only exec the fixed POSIX shell and
    // this exact Node runtime; other programs, including launchctl, remain
    // denied by the default profile.
    `(allow process-exec (literal ${quoted(node)}))`, `(allow file-read* (literal ${quoted(node)}))`,
    '(allow process-exec (literal "/bin/sh"))', '(allow file-read* (literal "/bin/sh"))',
    '(allow process-fork)', '(allow process-info* (target self))', '(allow signal (target self))',
    '(allow file-read* (subpath "/System"))', '(allow file-read* (subpath "/usr/lib"))',
    '(allow file-read* (subpath "/usr/share"))', '(allow file-read* (literal "/dev/null"))', '(allow file-read* (literal "/dev/urandom"))',
    ...reads.sort().map(item => `(allow file-read* (subpath ${quoted(item)}))`),
    ...writes.sort().map(item => `(allow file-read* file-write* (subpath ${quoted(item)}))`),
    `(allow file-read* file-write* (subpath ${quoted(temp)}))`,
    // No network*, mach-lookup, mach-register, system-write-bootstrap,
    // system-privilege, setuid, or launchd exception is allowed. The default
    // denial is the authority for those operations.
  ]
  return `${lines.join('\n')}\n`
}
const commandRelay = [
  "const cp=require('node:child_process')",
  "const child=cp.spawn('/bin/sh',['-c',process.argv[1]],{env:process.env,stdio:['ignore','pipe','pipe'],shell:false})",
  "child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr)",
  "child.once('error',error=>{process.stderr.write(String(error.code||error.message));process.exitCode=127})",
  "child.once('exit',(code,signal)=>{if(signal){process.kill(process.pid,signal)}else process.exitCode=code===null?1:code})",
].join(';')
function exactBase64(value, field) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    fail('TOOL_OUTPUT_INCOMPLETE', `Darwin owned proxy ${field} is not canonical base64`)
  }
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value) fail('TOOL_OUTPUT_INCOMPLETE', `Darwin owned proxy ${field} base64 changed while decoding`)
  return bytes
}
function resultFromExecution(args, cwd, execution, flags) {
  const stdoutBytes = exactBase64(execution.stdoutBase64, 'stdout')
  const stderrBytes = exactBase64(execution.stderrBase64, 'stderr')
  if (execution.stdoutTruncated || execution.stderrTruncated || !HASH.test(execution.stdoutSha256 || '') ||
      execution.stdoutByteCount !== stdoutBytes.length || digest(stdoutBytes) !== execution.stdoutSha256 ||
      !HASH.test(execution.stderrSha256 || '') || execution.stderrByteCount !== stderrBytes.length || digest(stderrBytes) !== execution.stderrSha256) {
    fail('TOOL_OUTPUT_INCOMPLETE', 'Darwin owned proxy output bytes are not exact')
  }
  const combined = Buffer.concat([stdoutBytes, stderrBytes])
  const oversized = execution.stdoutByteCount > OUTPUT_LIMIT || execution.stderrByteCount > OUTPUT_LIMIT || combined.length > OUTPUT_LIMIT
  const cancelled = flags.cancelled || execution.signal === 'OWNED_STOP'
  const timedOut = flags.timedOut
  if (execution.drained !== true || execution.processOwned !== true || execution.exactArgv !== true) fail('PROCESS_DRAIN_TIMEOUT', 'Darwin command lacks an exact coalition drain receipt')
  return { tool: 'bash', command: args.command, cwd, status: execution.status === 0 && !execution.signal && !oversized && !cancelled && !timedOut ? 'completed' : 'failed',
    exitCode: execution.status, signal: execution.signal || null, stdout: stdoutBytes.toString('utf8'), stderr: stderrBytes.toString('utf8'), output: combined.toString('utf8'),
    stdoutBase64: execution.stdoutBase64, stderrBase64: execution.stderrBase64, outputBase64: combined.toString('base64'),
    outputSha256: digest(combined), truncated: Boolean(oversized), cancelled, timedOut, background: false, durationMs: flags.durationMs() }
}
function createDarwinCommandSandbox(options = {}) {
  const platform = options.platform || process.platform
  if (platform !== 'darwin') fail('COMMAND_SANDBOX_UNSUPPORTED', 'Darwin command sandbox requires native macOS')
  const controlRoot = physicalDirectory(options.controlRoot)
  const helper = Object.freeze({ ...options.helper })
  boundExecutable(helper)
  const sandboxBinding = systemSandboxBinding(options)
  boundExecutable(sandboxBinding, options.sandboxExecutable ? undefined : SYSTEM_SANDBOX_EXEC)
  const requestedTempRoot = options.tempRoot || path.join(controlRoot, 'command-tmp')
  fs.mkdirSync(requestedTempRoot, { recursive: true, mode: 0o700 })
  const tempRoot = physicalDirectory(requestedTempRoot)
  const processOwner = options.processOwner || (options.runner ? null : new ProcessOwner({
    adapter: options.adapter || createDarwinCoalitionAdapter({ controlRoot: path.join(controlRoot, 'coalitions'), providerPrivateOwnershipRoot: controlRoot, helper }),
    registryPath: path.join(controlRoot, 'processes.json'), pollMs: options.pollMs || 20,
  }))
  const proxyRoot = path.join(controlRoot, 'proxy')
  // OwnedCodexProxyRunner creates a reservation child with recursive:false.
  // Its parent is controller state, so establish it before the first launch.
  fs.mkdirSync(proxyRoot, { recursive: true, mode: 0o700 })
  const runner = options.runner || new OwnedCodexProxyRunner({ processOwner, controlRoot: proxyRoot, targetKey: options.targetKey || 'darwin-command-sandbox', activationId: options.activationId, generationId: options.generationId })
  if (!runner || typeof runner.run !== 'function' || typeof runner.stop !== 'function') fail('COMMAND_SANDBOX_UNSUPPORTED', 'Darwin command sandbox requires an owned coalition runner')
  async function command(policy, args, runtime = {}) {
    if (!args || typeof args.command !== 'string' || !args.command.trim() || Buffer.byteLength(args.command) > 65536) fail('TOOL_ARGUMENTS_INVALID', 'A bounded nonempty command is required')
    if (runtime.signal?.aborted) fail('TOOL_CANCELLED', 'Darwin command was cancelled before launch')
    const cwd = physicalDirectory(args.cwd || (policy.readOnly ? policy.scratchPath : policy.targetPath))
    const profile = renderSeatbeltProfile(policy, { nodePath: process.execPath, tempRoot })
    const reservationId = runtime.reservationId || crypto.randomUUID(), sessionId = runtime.sessionId || crypto.randomUUID()
    const start = Date.now(), flags = { cancelled: false, timedOut: false, durationMs: () => Date.now() - start }
    const baseEnvironment = { PATH: path.dirname(process.execPath), HOME: tempRoot, TMPDIR: tempRoot, TMP: tempRoot, TEMP: tempRoot, LANG: 'C', LC_ALL: 'C' }
    const environment = processOwner?.adapter
      ? prepareProcessLaunchEnvironment(processOwner.adapter, reservationId, baseEnvironment)
      : baseEnvironment
    let launchStarted = false, runSettled = false, stopPromise = null, stopFailure = null
    const requestStop = async reason => {
      // `runner.stop()` reports alreadyTerminal until `runner.run()` has added
      // its owned session. Retry that race while the launch remains pending;
      // do not mistake the pre-attachment response for a drain receipt.
      for (;;) {
        const stopped = await runner.stop({ sessionId, reason, terminalStatus: 'CANCELLED' })
        if (!stopped?.alreadyTerminal || runSettled) return stopped
        await delay(10)
      }
    }
    const scheduleStop = reason => {
      flags.cancelled ||= reason === 'Darwin command cancelled'
      flags.timedOut ||= reason === 'Darwin command timed out'
      if (!launchStarted || stopPromise) return
      stopPromise = requestStop(reason).catch(error => { stopFailure = error; return null })
    }
    const cancel = () => scheduleStop('Darwin command cancelled')
    const timer = setTimeout(() => scheduleStop('Darwin command timed out'), runtime.timeoutMs || args.timeoutMs || 60000)
    runtime.signal?.addEventListener('abort', cancel, { once: true })
    try {
      // A cancellation delivered between listener registration and launch is
      // still a pre-launch cancellation: never create a reservation for it.
      if (runtime.signal?.aborted) fail('TOOL_CANCELLED', 'Darwin command was cancelled before launch')
      const executable = boundExecutable(sandboxBinding, options.sandboxExecutable ? undefined : SYSTEM_SANDBOX_EXEC)
      launchStarted = true
      if (flags.cancelled || flags.timedOut) fail('TOOL_CANCELLED', 'Darwin command was cancelled before launch')
      const execution = await runner.run({ executable, argv: ['-p', profile, process.execPath, '-e', commandRelay, args.command], cwd, env: environment, stdin: '', shell: false, sessionId, reservationId })
      runSettled = true
      if (stopPromise) await stopPromise
      if (stopFailure) throw stopFailure
      boundExecutable(sandboxBinding, options.sandboxExecutable ? undefined : SYSTEM_SANDBOX_EXEC)
      return resultFromExecution(args, cwd, execution, flags)
    } finally {
      runSettled = true
      clearTimeout(timer)
      runtime.signal?.removeEventListener('abort', cancel)
      if (stopPromise) await stopPromise
      if (stopFailure) throw stopFailure
    }
  }
  return Object.freeze({ backend: 'darwin-seatbelt-coalition', scope: 'initial-node-and-posix-shell-only', helper, sandboxBinding, controlRoot, tempRoot, processOwner, runner, renderSeatbeltProfile: policy => renderSeatbeltProfile(policy, { nodePath: process.execPath, tempRoot }), command })
}

module.exports = { DarwinCommandError, SYSTEM_SANDBOX_EXEC, OUTPUT_LIMIT, boundExecutable, renderSeatbeltProfile, createDarwinCommandSandbox }
