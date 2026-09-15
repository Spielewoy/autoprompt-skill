'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const cp = require('node:child_process')
const { createWindowsFilesystemCapture } = require('./windows-filesystem.js')
const MAX_OUTPUT = 1024 * 1024
class WindowsAppContainerError extends Error {
  constructor(code, message) { super(message); this.name = 'WindowsAppContainerError'; this.code = code }
}
function fail(code, message) { throw new WindowsAppContainerError(code, message) }
function exact(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)) }
function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex') }
function boundFile(file, maxBytes, singleLink = true) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')) fail('WINDOWS_RUNTIME_INVALID', 'Runtime paths must be absolute')
  const canonical = fs.realpathSync.native(file)
  if (canonical.toLowerCase() !== path.resolve(file).toLowerCase()) fail('WINDOWS_RUNTIME_INVALID', 'Runtime paths must be canonical')
  for (let cursor = canonical; ; cursor = path.dirname(cursor)) {
    const stat = fs.lstatSync(cursor)
    if (stat.isSymbolicLink() || (!stat.isDirectory() && cursor !== canonical)) fail('WINDOWS_RUNTIME_INVALID', 'Runtime ancestry must be physical')
    if (cursor === path.parse(cursor).root) break
  }
  const descriptor = fs.openSync(canonical, 'r')
  try {
    const stat = fs.fstatSync(descriptor, { bigint: true })
    if (!stat.isFile() || (singleLink && stat.nlink !== 1n) || stat.size < 1n || stat.size > BigInt(maxBytes)) fail('WINDOWS_RUNTIME_INVALID', 'Runtime file is not bounded and physical')
    const bytes = fs.readFileSync(descriptor)
    const after = fs.fstatSync(descriptor, { bigint: true })
    if (bytes.length !== Number(stat.size) || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => stat[key] !== after[key])) fail('WINDOWS_RUNTIME_MISMATCH', 'Runtime changed while binding')
    return Object.freeze({ path: canonical, dev: String(stat.dev), ino: String(stat.ino), size: Number(stat.size), sha256: digest(bytes) })
  } finally { fs.closeSync(descriptor) }
}
function validateLaunch(input) {
  const keys = ['profileName', 'profileSid', 'executable', 'executableSha256', 'arguments', 'cwd', 'environment', 'timeoutMs', 'outputLimit', 'cancellationPath']
  if (!exact(input, keys) || !/^Autoprompt_[a-f0-9]{32}$/.test(input.profileName) || !/^S-1-15-2-(?:[0-9]+-){6}[0-9]+$/.test(input.profileSid) ||
      !/^[a-f0-9]{64}$/.test(input.executableSha256) || !Array.isArray(input.arguments) || input.arguments.length > 256 ||
      input.arguments.some(value => typeof value !== 'string' || value.includes('\0')) ||
      !Array.isArray(input.environment) || input.environment.length > 64 || input.environment.some(value => typeof value !== 'string' || !/^[^=\0]+=/.test(value) || value.includes('\0')) ||
      !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 300000 || !Number.isSafeInteger(input.outputLimit) || input.outputLimit < 1 || input.outputLimit > MAX_OUTPUT ||
      ['executable', 'cwd', 'cancellationPath'].some(key => typeof input[key] !== 'string' || !path.win32.isAbsolute(input[key]) || input[key].includes('\0'))) fail('WINDOWS_LAUNCH_INVALID', 'Invalid controller AppContainer launch request')
  if (Buffer.byteLength(JSON.stringify(input)) > 120000) fail('WINDOWS_LAUNCH_INVALID', 'AppContainer launch exceeds its request bound')
  return { schemaVersion: 1, ...input }
}
function parseResult(text, expected) {
  let wire
  try { wire = JSON.parse(text) } catch { fail('WINDOWS_LAUNCH_PROTOCOL', 'AppContainer helper returned invalid JSON') }
  if ((exact(wire, ['schemaVersion', 'status', 'code']) || (exact(wire, ['schemaVersion', 'status', 'code', 'diagnostic']) && typeof wire.diagnostic === 'string' && /^[A-Za-z0-9_ .:()-]{1,256}$/.test(wire.diagnostic))) && wire.schemaVersion === 1 && wire.status === 'REFUSED' && /^(?:WINDOWS_[A-Z_]{1,64}|APPCONTAINER_CLEANUP_UNCONFIRMED)$/.test(wire.code)) fail(wire.code, `AppContainer helper refused the launch${wire.diagnostic ? `: ${wire.diagnostic}` : ''}`)
  const keys = ['RootPid', 'ExitCode', 'ObservedJobMembers', 'LauncherSessionId', 'AppContainerSid', 'StdoutBase64', 'StderrBase64', 'RootImageMatches', 'Drained', 'TimedOut', 'OutputLimit', 'Cancelled']
  const result = wire && wire.result
  if (!exact(wire, ['schemaVersion', 'status', 'result']) || wire.schemaVersion !== 1 || wire.status !== 'COMPLETED' || !exact(result, keys) || result.AppContainerSid !== expected.profileSid || result.RootImageMatches !== true || result.Drained !== true ||
      !Number.isSafeInteger(result.RootPid) || result.RootPid < 1 || result.RootPid > 0xffffffff || !Number.isSafeInteger(result.ExitCode) || result.ExitCode < 0 || result.ExitCode > 0xffffffff ||
      !Number.isSafeInteger(result.LauncherSessionId) || result.LauncherSessionId < 0 || !Number.isSafeInteger(result.ObservedJobMembers) || result.ObservedJobMembers < 1 || result.ObservedJobMembers > 1024 || ['TimedOut', 'OutputLimit', 'Cancelled'].some(key => typeof result[key] !== 'boolean')) fail('WINDOWS_LAUNCH_PROTOCOL', 'AppContainer helper returned invalid ownership evidence')
  const decode = key => {
    if (typeof result[key] !== 'string' || result[key].length > Math.ceil(MAX_OUTPUT / 3) * 4) fail('WINDOWS_LAUNCH_PROTOCOL', 'AppContainer output exceeds its bound')
    const bytes = Buffer.from(result[key], 'base64')
    if (bytes.toString('base64') !== result[key]) fail('WINDOWS_LAUNCH_PROTOCOL', 'AppContainer output is not canonical base64')
    return bytes
  }
  const stdout = decode('StdoutBase64'), stderr = decode('StderrBase64')
  if (stdout.length + stderr.length > expected.outputLimit) fail('WINDOWS_LAUNCH_PROTOCOL', 'AppContainer output exceeds the admitted limit')
  return Object.freeze({ rootPid: result.RootPid, launcherSessionId: result.LauncherSessionId, exitCode: result.ExitCode, observedJobMembers: result.ObservedJobMembers, profileSid: result.AppContainerSid, drained: true,
    timedOut: result.TimedOut, truncated: result.OutputLimit, cancelled: result.Cancelled, stdout, stderr })
}
// This primitive does not grant resources or advertise a sandbox capability.
// Its caller must retain the controller resource lease through confirmed drain.
function createWindowsAppContainerLauncher(options = {}) {
  if (process.platform !== 'win32') fail('COMMAND_SANDBOX_UNSUPPORTED', 'Windows AppContainer is unavailable on this platform')
  const systemRoot = process.env.SystemRoot
  if (typeof systemRoot !== 'string' || !/^[A-Za-z]:\\Windows$/i.test(systemRoot)) fail('WINDOWS_RUNTIME_INVALID', 'Windows system root is unavailable')
  const root = options.deploymentRoot || __dirname
  const helper = boundFile(path.join(root, 'windows-appcontainer.ps1'), 1024 * 1024)
  const native = boundFile(path.join(root, 'windows-appcontainer-native.cs'), 4 * 1024 * 1024)
  const powershell = boundFile(path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), 64 * 1024 * 1024, false)
  const capture = createWindowsFilesystemCapture()
  capture.assertRecordParent(helper.path)
  const drainedEvidence = new WeakMap(), startedLeases = new Set()
  const bindings = [[helper, 1024 * 1024, true], [native, 4 * 1024 * 1024, true], [powershell, 64 * 1024 * 1024, false]]
  const verify = () => { for (const [binding, max, single] of bindings) if (JSON.stringify(boundFile(binding.path, max, single)) !== JSON.stringify(binding)) fail('WINDOWS_RUNTIME_MISMATCH', 'Windows AppContainer deployment changed') }
  return Object.freeze({ kind: 'windows-appcontainer-native-v1', proveNotStarted: binding => { if (startedLeases.has(binding.leaseId)) fail('APPCONTAINER_CLEANUP_UNCONFIRMED', 'This lease has started a native helper'); const evidence = Object.freeze({ drained: true, notStarted: true, profileSid: binding.profileSid }); drainedEvidence.set(evidence, { ...binding }); return evidence }, verifyDrainEvidence: (evidence, binding) => { const owned = drainedEvidence.get(evidence); return Boolean(owned && owned.profileSid === binding.profileSid && owned.leaseId === binding.leaseId) }, binding: Object.freeze({ helper, native, powershell }),
    async launch(input, options = {}) {
      const request = validateLaunch(input)
      verify()
      capture.assertRecordParent(request.cancellationPath)
      if (fs.existsSync(request.cancellationPath)) fail('WINDOWS_LAUNCH_INVALID', 'Cancellation marker must be fresh')
      const executable = boundFile(request.executable, 512 * 1024 * 1024, false)
      if (executable.sha256 !== request.executableSha256) fail('WINDOWS_RUNTIME_MISMATCH', 'Assigned executable changed')
      return new Promise((resolve, reject) => {
        startedLeases.add(options.leaseId)
        const child = cp.spawn(powershell.path, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper.path, '-NativeSha256', native.sha256, '-Request'], {
          windowsHide: true, shell: false, cwd: path.dirname(powershell.path), stdio: ['pipe', 'pipe', 'pipe'],
          env: { SystemRoot: systemRoot, WINDIR: systemRoot, SystemDrive: systemRoot.slice(0, 2), PATH: path.join(systemRoot, 'System32'), PSModulePath: '', TEMP: path.dirname(request.cancellationPath), TMP: path.dirname(request.cancellationPath) },
        })
        const output = [], errors = []; let size = 0, settled = false, overLimit = false
        const cancel = () => { try { fs.writeFileSync(request.cancellationPath, 'cancel\n', { flag: 'wx', mode: 0o600 }) } catch (error) { if (error.code !== 'EEXIST') overLimit = true } }
        const timer = setTimeout(cancel, request.timeoutMs + 10000)
        const hardTimer = setTimeout(() => { overLimit = true; child.kill() }, request.timeoutMs + 25000)
        options.signal?.addEventListener('abort', cancel, { once: true }); if (options.signal?.aborted) cancel()
        const finish = () => { settled = true; clearTimeout(timer); clearTimeout(hardTimer); options.signal?.removeEventListener('abort', cancel) }
        const collect = list => bytes => { size += bytes.length; if (size > 3 * MAX_OUTPUT) { overLimit = true; cancel(); return } list.push(bytes) }
        child.stdout.on('data', collect(output)); child.stderr.on('data', collect(errors))
        child.stdin.on('error', () => {})
        child.once('error', error => { if (settled) return; finish(); reject(new WindowsAppContainerError('WINDOWS_LAUNCH_UNAVAILABLE', error.code || 'AppContainer helper failed')) })
        child.once('close', (status, signal) => {
          if (settled) return
          finish()
          try {
            verify()
            if (signal || status !== 0 || errors.length || overLimit) fail('APPCONTAINER_CLEANUP_UNCONFIRMED', 'AppContainer helper did not return confirmed process cleanup')
            const evidence = parseResult(Buffer.concat(output).toString('utf8'), request)
            drainedEvidence.set(evidence, { profileSid: request.profileSid, leaseId: options.leaseId })
            resolve(evidence)
          } catch (error) { reject(error) }
        })
        child.stdin.end(JSON.stringify(request))
      })
    },
  })
}
module.exports = { WindowsAppContainerError, validateLaunch, parseResult, createWindowsAppContainerLauncher }
