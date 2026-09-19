// Source-derived diagnostic only; regenerate with derive.py. No production selector.
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const cp = require('node:child_process')
const { ensureWindowsPrivateAcl } = require('../../../agents/codex/workflow/safe-run-root.js')
const { createWindowsAppContainerLauncher, WindowsAppContainerError, parseMsysSharedId } = require('../../../agents/codex/workflow/windows-appcontainer.js')
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
// Copy a closed executable dependency set into the existing read-only runtime.
// Granting the original Git installation would also expose unrelated plugins,
// credentials and mutable launchers to a worker.
function importedDlls(bytes) {
  const invalid = () => { throw new WindowsAppContainerError('WINDOWS_RUNTIME_INVALID', 'Git Bash runtime has an invalid PE dependency table') }
  const range = (offset, size) => { if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(size) || size < 0 || offset + size > bytes.length) invalid(); return offset }
  if (!Buffer.isBuffer(bytes) || bytes.length < 64 || bytes.readUInt16LE(0) !== 0x5a4d) invalid()
  const pe = bytes.readUInt32LE(60); range(pe, 24)
  if (bytes.readUInt32LE(pe) !== 0x00004550) invalid()
  const sections = bytes.readUInt16LE(pe + 6), optionalSize = bytes.readUInt16LE(pe + 20), optional = pe + 24
  range(optional, optionalSize)
  const magic = bytes.readUInt16LE(range(optional, 2)), directoryOffset = magic === 0x20b ? 112 : magic === 0x10b ? 96 : 0
  if (!directoryOffset || optionalSize < directoryOffset || !sections || sections > 96) invalid()
  const directoryCount = bytes.readUInt32LE(optional + directoryOffset - 4)
  if (directoryCount > 16 || optionalSize < directoryOffset + directoryCount * 8) invalid()
  const sectionTable = optional + optionalSize; range(sectionTable, sections * 40)
  const locate = (rva, length) => {
    const matches = []
    for (let index = 0; index < sections; index++) {
      const section = sectionTable + index * 40, base = bytes.readUInt32LE(section + 12), size = bytes.readUInt32LE(section + 16), raw = bytes.readUInt32LE(section + 20)
      if (rva >= base && rva - base + length <= size) matches.push(range(raw + rva - base, length))
    }
    if (matches.length !== 1) invalid()
    return matches[0]
  }
  const names = new Set()
  const nameAt = rva => {
    let name = ''
    for (let index = 0; index < 256; index++) {
      const byte = bytes[locate(rva + index, 1)]
      if (!byte) { if (!/^[A-Za-z0-9_+.-]+\.dll$/i.test(name) || name.includes('..')) invalid(); names.add(name.toLowerCase()); return }
      if (byte < 33 || byte > 126) invalid()
      name += String.fromCharCode(byte)
    }
    invalid()
  }
  for (const [directoryIndex, descriptorSize, nameOffset] of [[1, 20, 12], [13, 32, 4]]) {
    if (directoryCount <= directoryIndex) continue
    const address = optional + directoryOffset + directoryIndex * 8, rva = bytes.readUInt32LE(address), size = bytes.readUInt32LE(address + 4)
    if (!rva && !size) continue
    if (!rva || size < descriptorSize || size > 1024 * 1024) invalid()
    let terminated = false
    for (let offset = 0; offset + descriptorSize <= size; offset += descriptorSize) {
      const descriptor = locate(rva + offset, descriptorSize)
      if (bytes.subarray(descriptor, descriptor + descriptorSize).every(byte => byte === 0)) { terminated = true; break }
      // Delay imports must use RVAs. Old absolute-address descriptors cannot
      // be interpreted without relocating the image and are refused.
      if (directoryIndex === 13 && bytes.readUInt32LE(descriptor) !== 1) invalid()
      nameAt(bytes.readUInt32LE(descriptor + nameOffset))
      if (names.size > 128) invalid()
    }
    if (!terminated) invalid()
  }
  return [...names].sort()
}
function bindBashRuntime(runtimeDirectory, systemRoot) {
  const files = new Map(); let totalBytes = 0
  const visit = name => {
    const label = name.toLowerCase()
    if (files.has(label)) return
    if (files.size >= 96) throw new WindowsAppContainerError('WINDOWS_RUNTIME_INVALID', 'Git Bash runtime dependency count exceeds its bound')
    const binding = bindRuntimeFile(path.join(runtimeDirectory, name), 32 * 1024 * 1024)
    totalBytes += binding.bytes.length
    if (totalBytes > 256 * 1024 * 1024) throw new WindowsAppContainerError('WINDOWS_RUNTIME_INVALID', 'Git Bash runtime dependency bytes exceed their bound')
    files.set(label, Object.freeze({ ...binding, name: label, ...(label === 'msys-2.0.dll' ? { sharedId: parseMsysSharedId(binding.bytes) } : {}) }))
    for (const dependency of importedDlls(binding.bytes)) {
      if (fs.existsSync(path.join(runtimeDirectory, dependency))) visit(dependency)
      else if (/^(?:api-ms-win-|ext-ms-win-)[a-z0-9.-]+\.dll$/.test(dependency)) continue
      else if (!systemRoot || !fs.existsSync(path.join(systemRoot, 'System32', dependency))) {
        throw new WindowsAppContainerError('WINDOWS_RUNTIME_INVALID', `Git Bash runtime dependency is missing: ${dependency}`)
      }
    }
  }
  visit('bash.exe')
  if (!files.has('msys-2.0.dll')) throw new WindowsAppContainerError('WINDOWS_RUNTIME_INVALID', 'Git Bash runtime does not bind its MSYS dependency')
  return Object.freeze([...files.values()])
}
function bindRuntimeFile(file, maxBytes) {
  const canonical = fs.realpathSync.native(file)
  if (canonical.toLowerCase() !== path.resolve(file).toLowerCase()) throw new WindowsAppContainerError('WINDOWS_RUNTIME_INVALID', 'Git Bash runtime paths must be canonical')
  for (let cursor = canonical; ; cursor = path.dirname(cursor)) {
    const stat = fs.lstatSync(cursor)
    if (stat.isSymbolicLink() || (cursor !== canonical && !stat.isDirectory())) throw new WindowsAppContainerError('WINDOWS_RUNTIME_INVALID', 'Git Bash runtime ancestry must be physical')
    if (cursor === path.parse(cursor).root) break
  }
  const descriptor = fs.openSync(canonical, 'r')
  try {
    const before = fs.fstatSync(descriptor, { bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(maxBytes)) throw new WindowsAppContainerError('WINDOWS_RUNTIME_INVALID', 'Git Bash runtime file is not bounded and physical')
    const bytes = fs.readFileSync(descriptor), after = fs.fstatSync(descriptor, { bigint: true })
    if (bytes.length !== Number(before.size) || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => before[key] !== after[key])) throw new WindowsAppContainerError('WINDOWS_RUNTIME_MISMATCH', 'Git Bash runtime changed while binding')
    return Object.freeze({ path: canonical, bytes, sha256: sha256(bytes) })
  } finally { fs.closeSync(descriptor) }
}
function resolveWindowsBash(options = {}) {
  return require('./binding.cjs').select(options.diagnosticTuple, { bindBashRuntime, bindRuntimeFile })
}
async function runWindowsAppContainerCommand(policy, args, options = {}) {
  if (process.platform !== 'win32' || typeof options.controlRoot !== 'string' || !path.isAbsolute(options.controlRoot)) throw new WindowsAppContainerError('COMMAND_SANDBOX_UNSUPPORTED', 'A private controller root is required for Windows commands')
  const controlRoot = fs.realpathSync.native(options.controlRoot)
  const nonce = crypto.randomUUID().replaceAll('-', '')
  const cancellationPath = path.join(controlRoot, `cancel-${nonce}`)
  // MSYS derives its installation root by removing the DLL filename, bin and
  // usr components. Keep that real layout inside one owned command directory.
  const runtimeRoot = path.join(path.dirname(controlRoot), `command-runtime-${nonce}`)
  const runtimeDirectory = path.join(runtimeRoot, 'usr', 'bin')
  const runtimeNode = path.join(runtimeDirectory, 'node.exe'), runtimeBash = path.join(runtimeDirectory, 'bash.exe')
  let launcher, helperDeployment
  const { prepareWindowsAppContainerResources, recoverWindowsAppContainerResources } = require('../../../agents/codex/workflow/windows-appcontainer-resources.js')
  const bashSource = resolveWindowsBash(options)
  const systemRoot = process.env.SystemRoot
  const executable = runtimeBash, executableSha256 = bashSource.bash.sha256
  const msysSource = bashSource.files.find(binding => binding.name === 'msys-2.0.dll')
  const msysRuntime = { dllPath: path.join(runtimeDirectory, 'msys-2.0.dll'), dllSha256: msysSource.sha256, sharedId: msysSource.sharedId }
  const start = Date.now()
  let lease, evidence, released = false, recoveryPending = false, privateScratch = null, runtimeCleanupUnknown = false, primaryError = null
  try {
    helperDeployment = require('../../../agents/codex/workflow/windows-helper-deployment.js').stageWindowsHelperDeployment(controlRoot)
    launcher = createWindowsAppContainerLauncher({ deploymentRoot: helperDeployment.root })
    if (!policy.scratchPath) {
      privateScratch = path.join(path.dirname(controlRoot), `command-scratch-${nonce}`)
      fs.mkdirSync(privateScratch, { mode: 0o700 }); ensureWindowsPrivateAcl(privateScratch)
      policy = { ...policy, scratchPath: privateScratch, readableRoots: [...policy.readableRoots, privateScratch], writableRoots: [...policy.writableRoots, privateScratch] }
    }
    fs.mkdirSync(runtimeRoot, { mode: 0o700 })
    ensureWindowsPrivateAcl(runtimeRoot)
    fs.mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 })
    const runtimeEtc = path.join(runtimeRoot, 'etc')
    fs.mkdirSync(runtimeEtc, { mode: 0o700 })
    // The immutable per-command mount table maps /tmp to the lease's existing
    // private TEMP/TMP scratch path; no host installation or global mount changes.
    fs.writeFileSync(path.join(runtimeEtc, 'fstab'), 'none /tmp usertemp binary,posix=0,noacl 0 0\n', { flag: 'wx', mode: 0o400 })
    const expectedNodeHash = sha256(fs.readFileSync(process.execPath))
    require('node:assert/strict').equal(expectedNodeHash, options.diagnosticTuple.node.sha256, 'Diagnostic Node changed before copy')
    fs.copyFileSync(process.execPath, runtimeNode, fs.constants.COPYFILE_EXCL)
    for (const binding of bashSource.files) {
      const destination = path.join(runtimeDirectory, binding.name)
      fs.writeFileSync(destination, binding.bytes, { flag: 'wx', mode: 0o500 })
      if (sha256(fs.readFileSync(destination)) !== binding.sha256) throw new WindowsAppContainerError('WINDOWS_RUNTIME_MISMATCH', 'Git Bash runtime dependency changed while copying')
    }
    if (sha256(fs.readFileSync(runtimeNode)) !== expectedNodeHash) throw new WindowsAppContainerError('WINDOWS_RUNTIME_MISMATCH', 'Controller Node changed while copying')
    if (sha256(fs.readFileSync(runtimeBash)) !== executableSha256) throw new WindowsAppContainerError('WINDOWS_RUNTIME_MISMATCH', 'Git Bash runtime changed while copying')
    lease = await prepareWindowsAppContainerResources({ policy, controlRoot, deploymentRoot: helperDeployment.root,
      executableRoots: [{ path: runtimeRoot, kind: 'directory' }],
      verifyDrainEvidence: launcher.verifyDrainEvidence })
    const env = {
      SystemRoot: systemRoot, WINDIR: systemRoot, ComSpec: path.join(systemRoot, 'System32', 'cmd.exe'), LOCALAPPDATA: process.env.LOCALAPPDATA || '',
      PATHEXT: '.COM;.EXE;.BAT;.CMD', PATH: runtimeDirectory, MSYSTEM: 'MINGW64', CHERE_INVOKING: '1',
      NODE_OPTIONS: '--preserve-symlinks --preserve-symlinks-main', AUTOPROMPT_APP_CONTAINER_SID: lease.profileSid,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: '',
      GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: 'push.default', GIT_CONFIG_VALUE_0: 'nothing',
      GIT_CONFIG_KEY_1: 'credential.helper', GIT_CONFIG_VALUE_1: '', GIT_CONFIG_KEY_2: 'core.sshCommand', GIT_CONFIG_VALUE_2: 'cmd /d /c exit 1',
      ...lease.environment,
    }
    evidence = await launcher.launch({ profileName: lease.profileName, profileSid: lease.profileSid,
      executable, executableSha256, msysRuntime, arguments: ['--noprofile', '--norc', '-c', args.command], cwd: args.cwd,
      environment: Object.entries(env).map(([key, value]) => `${key}=${value}`), timeoutMs: args.timeoutMs || 60000,
      outputLimit: 1024 * 1024, cancellationPath }, { signal: options.signal, leaseId: lease.recovery.leaseId })
    await lease.release(evidence)
    released = true
    const stdout = evidence.stdout, stderr = evidence.stderr, output = Buffer.concat([stdout, stderr])
    return { tool: 'bash', command: args.command, cwd: args.cwd,
      status: evidence.exitCode === 0 && !evidence.timedOut && !evidence.truncated && !evidence.cancelled ? 'completed' : 'failed',
      exitCode: evidence.exitCode, signal: null, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), output: output.toString('utf8'),
      stdoutBase64: stdout.toString('base64'), stderrBase64: stderr.toString('base64'), outputBase64: output.toString('base64'), outputSha256: sha256(output),
      launcherSessionId: evidence.launcherSessionId, truncated: evidence.truncated, cancelled: evidence.cancelled, timedOut: evidence.timedOut, background: false, durationMs: Date.now() - start }
  } catch (error) {
    primaryError = error
    runtimeCleanupUnknown = error.cleanupConfirmed === false
    try {
      if (!lease && error.recovery) {
        recoveryPending = true
        const binding = { profileSid: error.recovery.profileSid, leaseId: error.recovery.leaseId }
        const unused = launcher.proveNotStarted(binding)
        await recoverWindowsAppContainerResources({ controlRoot, deploymentRoot: helperDeployment.root, journalPath: error.recovery.journalPath, verifyDrainEvidence: launcher.verifyDrainEvidence, evidence: unused })
        recoveryPending = false; released = true; error.recoveryResolved = true
      }
      if (lease && !evidence) {
        let unused
        try { unused = launcher.proveNotStarted({ profileSid: lease.profileSid, leaseId: lease.recovery.leaseId }) } catch {}
        if (unused) { await lease.release(unused); released = true }
      }
    } catch (recoveryError) {
      // A secondary recovery failure must not erase the original lease or an
      // unknown-cleanup marker that tells the caller to retain its outer root.
      error.cleanupConfirmed = false
      error.recoveryFailureCode = String(recoveryError.code || 'recovery-failed').slice(0, 64)
      runtimeCleanupUnknown = true
    }
    if (lease && !released) error.recovery = Object.freeze({ ...lease.recovery, profileSid: lease.profileSid })
    throw error
  } finally {
    // Unconfirmed launches retain their exact request artifacts alongside the
    // resource journal. Recovery must prove process drain before revoking grants.
    if ((!lease && !recoveryPending) || released) {
      let cleanupFailure
      const cleanup = operation => {
        try { operation() } catch (error) { if (!cleanupFailure) cleanupFailure = error }
      }
      if (privateScratch) cleanup(() => fs.rmSync(privateScratch, { recursive: true, force: true }))
      if (!runtimeCleanupUnknown) cleanup(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }))
      cleanup(() => helperDeployment?.cleanup())
      cleanup(() => { try { fs.unlinkSync(cancellationPath) } catch (error) { if (error.code !== 'ENOENT') throw error } })
      if (cleanupFailure) {
        const error = primaryError || cleanupFailure
        error.cleanupConfirmed = false
        error.retainedControlRoot = controlRoot
        error.retainedRuntimeRoot = runtimeRoot
        error.cleanupCode = String(cleanupFailure.code || 'cleanup-failed').slice(0, 64)
        if (!primaryError) throw error
      }
    }
  }
}
module.exports = { runWindowsAppContainerCommand, importedDlls, bindBashRuntime, resolveWindowsBash }
