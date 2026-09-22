'use strict'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const cp = require('node:child_process')
const { createWindowsCompilerDirectory, ensureWindowsPrivateAcl, inspectPathNoFollow } = require('./safe-run-root.js')
const { createWindowsFilesystemCapture } = require('./windows-filesystem.js')
const { createWindowsAppContainerLauncher, WindowsAppContainerError, parseMsysSharedId } = require('./windows-appcontainer.js')
const { failureDiagnostic } = require('./windows-appcontainer-probe.js')
const workerBundle = require('./windows-worker-loader.js')
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
function within(root, value) {
  const relative = path.relative(path.resolve(root).toLowerCase(), path.resolve(value).toLowerCase())
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}
function sameDirectoryIdentity(left, right) {
  return Boolean(left && right && String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino))
}
function verifyCommandCwdBridgeParent(bridge, expectedEntries) {
  if (!bridge) return
  const staging = inspectPathNoFollow(bridge.stagingRoot)
  const requested = inspectPathNoFollow(bridge.requestedCwd)
  const parent = inspectPathNoFollow(bridge.root)
  let entries
  try { entries = fs.readdirSync(bridge.root).sort() } catch {}
  if (!staging.exists || !sameDirectoryIdentity(staging.identity, bridge.stagingIdentity) ||
      !requested.exists || !sameDirectoryIdentity(requested.identity, bridge.requestedIdentity) ||
      !parent.exists || !sameDirectoryIdentity(parent.identity, bridge.rootIdentity) ||
      !entries || entries.length !== expectedEntries.length || entries.some((entry, index) => entry !== expectedEntries[index])) {
    throw new WindowsAppContainerError('WINDOWS_RUNTIME_MISMATCH', 'Private command cwd bridge changed identity')
  }
}
function verifyActiveCommandCwdBridge(bridge) {
  verifyCommandCwdBridgeParent(bridge, ['command-cwd'])
  let alias, resolved
  try { alias = fs.lstatSync(bridge.alias, { bigint: true }); resolved = fs.realpathSync.native(bridge.alias) } catch {
    throw new WindowsAppContainerError('WINDOWS_RUNTIME_MISMATCH', 'Private command cwd bridge is unavailable')
  }
  if (!alias.isSymbolicLink() || !sameDirectoryIdentity(alias, bridge.aliasIdentity) ||
      resolved.toLowerCase() !== bridge.requestedRealpath.toLowerCase() || bridge.alias.length >= 260) {
    throw new WindowsAppContainerError('WINDOWS_RUNTIME_MISMATCH', 'Private command cwd bridge changed identity')
  }
}
function prepareCommandCwdBridge(stagingRoot, requestedCwd) {
  if (requestedCwd.length < 260) return null
  // CreateProcessW still limits lpCurrentDirectory to MAX_PATH. Change only
  // that launch spelling; the policy, command receipt and backing directory
  // remain bound to the canonical requested cwd for the lease's lifetime.
  const staging = inspectPathNoFollow(stagingRoot)
  const requested = inspectPathNoFollow(requestedCwd)
  if (!staging.exists || !staging.identity || !requested.exists || !requested.identity) {
    throw new WindowsAppContainerError('WINDOWS_RUNTIME_INVALID', 'Private command cwd bridge requires physical directories')
  }
  const root = path.join(stagingRoot, 'cwd-bridge'), alias = path.join(root, 'command-cwd')
  let created = false
  try {
    fs.mkdirSync(root, { mode: 0o700 })
    created = true
    const rootItem = inspectPathNoFollow(root)
    if (!rootItem.exists || !rootItem.identity || alias.length >= 260) {
      throw new WindowsAppContainerError('WINDOWS_RUNTIME_INVALID', 'Private command cwd bridge root is invalid')
    }
    const bridge = Object.freeze({ root, alias, stagingRoot, requestedCwd,
      stagingIdentity: staging.identity, requestedIdentity: requested.identity, requestedRealpath: requested.realpath,
      rootIdentity: rootItem.identity })
    verifyCommandCwdBridgeParent(bridge, [])
    return bridge
  } catch (error) {
    let retain = created
    if (!created) {
      try { fs.lstatSync(root); retain = true } catch (cleanupError) { if (cleanupError.code !== 'ENOENT') retain = true }
      try {
        const stagingAfter = inspectPathNoFollow(stagingRoot)
        const requestedAfter = inspectPathNoFollow(requestedCwd)
        if (!stagingAfter.exists || !sameDirectoryIdentity(stagingAfter.identity, staging.identity) ||
            !requestedAfter.exists || !sameDirectoryIdentity(requestedAfter.identity, requested.identity)) retain = true
      } catch { retain = true }
    }
    if (retain) {
      error.cleanupConfirmed = false
      error.retainedStagingRoot = stagingRoot
    }
    throw error
  }
}
function activateCommandCwdBridge(bridge) {
  if (!bridge) return null
  try {
    verifyCommandCwdBridgeParent(bridge, [])
    fs.symlinkSync(bridge.requestedRealpath, bridge.alias, 'junction')
    const alias = fs.lstatSync(bridge.alias, { bigint: true })
    const active = Object.freeze({ ...bridge,
      aliasIdentity: Object.freeze({ dev: String(alias.dev), ino: String(alias.ino) }) })
    verifyActiveCommandCwdBridge(active)
    return active
  } catch (error) {
    // A collision or any ambiguity after the leased empty preimage was applied
    // must retain that lease. Recovery may not classify or delete foreign bytes.
    error.cleanupConfirmed = false
    error.retainedStagingRoot = bridge.stagingRoot
    throw error
  }
}
function removeCommandCwdBridge(bridge) {
  if (!bridge) return
  try {
    verifyActiveCommandCwdBridge(bridge)
    fs.unlinkSync(bridge.alias)
    try { fs.lstatSync(bridge.alias); throw new WindowsAppContainerError('WINDOWS_RUNTIME_MISMATCH', 'Private command cwd bridge survived removal') }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    verifyCommandCwdBridgeParent(bridge, [])
  } catch (error) {
    error.cleanupConfirmed = false
    error.retainedStagingRoot = bridge.stagingRoot
    throw error
  }
}
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
function windowsBashCandidates(environment = process.env, requested) {
  const windows = path.win32
  const candidates = [requested, environment.AUTOPROMPT_WINDOWS_BASH]
  const bases = [environment.ProgramW6432, environment.ProgramFiles, environment['ProgramFiles(x86)'],
    'C:\\Program Files', 'C:\\Program Files (x86)', environment.LOCALAPPDATA && windows.join(environment.LOCALAPPDATA, 'Programs')].filter(Boolean)
  for (const base of bases) candidates.push(windows.join(base, 'Git', 'usr', 'bin', 'bash.exe'), windows.join(base, 'Git', 'bin', 'bash.exe'))
  // Git for Windows may be installed on another drive or under a package
  // manager. Only a physical Bash/MSYS dependency closure is eligible; never
  // invoke cmd.exe, where.exe, a PATH script, or WSL's bash.exe shim.
  for (const directory of (environment.PATH || environment.Path || '').split(';').filter(value => windows.isAbsolute(value))) {
    if (environment.SystemRoot && windows.resolve(directory).toLowerCase() === windows.join(environment.SystemRoot, 'System32').toLowerCase()) continue
    candidates.push(windows.join(directory, 'bash.exe'))
    if (/^(?:cmd|bin)$/i.test(windows.basename(directory))) candidates.push(windows.join(windows.dirname(directory), 'usr', 'bin', 'bash.exe'))
  }
  return [...new Set(candidates.filter(value => typeof value === 'string' && windows.isAbsolute(value) && !value.includes('\0')))]
}
function resolveWindowsBash(options = {}) {
  const environment = options.env || process.env
  let failure
  for (const requested of windowsBashCandidates(environment, options.bashPath)) {
    try {
      const bash = bindRuntimeFile(requested, 16 * 1024 * 1024)
      const runtimeDirectory = path.dirname(bash.path)
      const files = bindBashRuntime(runtimeDirectory, environment.SystemRoot)
      const version = cp.spawnSync(bash.path, ['--version'], {
        encoding: 'utf8', timeout: 5000, windowsHide: true, shell: false, cwd: runtimeDirectory,
        env: { SystemRoot: environment.SystemRoot, WINDIR: environment.SystemRoot, SystemDrive: environment.SystemDrive || environment.SystemRoot.slice(0, 2), PATH: runtimeDirectory },
      })
      const match = /GNU bash, version (\d+)\.(\d+)/.exec(version.stdout || '')
      if (!version.error && version.status === 0 && match && (+match[1] > 4 || +match[1] === 4 && +match[2] >= 3)) return Object.freeze({ bash, files })
    } catch (error) {
      // A selected MSYS DLL with invalid namespace metadata is not eligible for
      // an unbound fallback or a host-side execution attempt.
      if (error.code === 'WINDOWS_MSYS_RUNTIME_INVALID') throw error
      if (error instanceof WindowsAppContainerError) failure = error
    }
  }
  throw new WindowsAppContainerError('COMMAND_SANDBOX_UNSUPPORTED', `Git Bash 4.3 or newer with its complete physical DLL closure is required for the Windows command boundary${failure ? `: ${failure.message}` : ''}`)
}
// Admission belongs to this controller process and the exact captured tuple.
// No caller-supplied option, result object or exported token can set it.
let admittedWorker = null, pendingAdmission = null, admissionPoison = null
function currentAdmission(tuple) {
  const worker = workerBundle.revalidateTuple(tuple)
  const key = require('./windows-appcontainer-probe.js').canaryKey(worker.identity)
  return { worker, key }
}
function retainUnknownAdmission(error) {
  if (error.cleanupConfirmed === false || error.code === 'APPCONTAINER_CLEANUP_UNCONFIRMED' || (error.recovery && !error.recoveryResolved)) {
    // Keep the first failure's recovery binding independent of later operations
    // and of the mutable error returned to its caller.
    admissionPoison ||= Object.freeze({ code: error.code, message: error.message,
      ...(error.recovery ? { recovery: Object.freeze({ ...error.recovery }) } : {}),
      recoveryRoot: error.recoveryRoot, retainedHelperRoot: error.retainedHelperRoot,
      retainedRuntimeRoot: error.retainedRuntimeRoot, retainedStagingRoot: error.retainedStagingRoot,
      retainedControlRoot: error.retainedControlRoot })
    admittedWorker = null
  }
}
function refusePoisonedAdmission() {
  if (!admissionPoison) return
  const error = new WindowsAppContainerError('APPCONTAINER_CLEANUP_UNCONFIRMED', 'A previous Windows worker operation has unconfirmed cleanup')
  error.cleanupConfirmed = false
  error.admissionFailure = admissionPoison
  // Prior recovery belongs to the previous operation. In particular, never put
  // it in .recovery, which this operation's catch may recover or replace.
  error.recoveryRoot = admissionPoison.recoveryRoot || admissionPoison.retainedHelperRoot || admissionPoison.retainedRuntimeRoot || admissionPoison.retainedStagingRoot || admissionPoison.retainedControlRoot
  throw error
}
async function ensureWorkerAdmission() {
  refusePoisonedAdmission()
  const tuple = await workerBundle.captureWorkerTuple()
  refusePoisonedAdmission()
  const { worker, key } = currentAdmission(tuple)
  if (admittedWorker?.tuple === tuple && admittedWorker.key === key) return admittedWorker
  let pending = pendingAdmission
  if (!pending || pending.tuple !== tuple || pending.key !== key) {
    pending = { tuple, key, promise: null }
    const ownedPending = pending
    pending.promise = (async () => {
      const result = await require('./windows-appcontainer-probe.js').runWindowsAppContainerCanary(
        (policy, args, options) => runTupleCommand(policy, args, options, tuple, key), worker.identity, key)
      if (!result || result.supported !== true || result.workerIdentity !== worker.identity || result.runtimeSha256 !== key || result.processCleanup !== 'owned-job-drained') {
        const error = new WindowsAppContainerError('COMMAND_SANDBOX_UNSUPPORTED', 'The selected Windows worker tuple did not pass its fresh native canary')
        if (result && result.supported === false) error.canaryResult = result
        if (result?.recoveryRoot || result?.retainedStagingRoot) {
          error.cleanupConfirmed = false
          if (result.recoveryRoot) error.recoveryRoot = result.recoveryRoot
          if (result.retainedStagingRoot) error.retainedStagingRoot = result.retainedStagingRoot
        }
        throw error
      }
      if (currentAdmission(tuple).key !== key) throw new WindowsAppContainerError('WINDOWS_RUNTIME_MISMATCH', 'Runtime changed during the Windows worker canary')
      refusePoisonedAdmission()
      admittedWorker = Object.freeze({ tuple, key, result: Object.freeze(result) })
      return admittedWorker
    })().catch(error => { retainUnknownAdmission(error); throw error }).finally(() => {
      if (pendingAdmission === ownedPending) pendingAdmission = null
    })
    pendingAdmission = pending
  }
  const admitted = await pending.promise
  refusePoisonedAdmission()
  if (currentAdmission(tuple).key !== admitted.key) throw new WindowsAppContainerError('WINDOWS_RUNTIME_MISMATCH', 'Runtime changed after the Windows worker canary')
  return admitted
}
async function probeWindowsAppContainer() {
  if (process.platform !== 'win32') return { supported: false, backend: 'windows-appcontainer', code: 'COMMAND_SANDBOX_UNSUPPORTED' }
  try { return (await ensureWorkerAdmission()).result }
  catch (error) {
    if (error.canaryResult) return error.canaryResult
    return { supported: false, backend: 'windows-appcontainer', code: error.code || 'WINDOWS_RUNTIME_UNAVAILABLE', diagnostic: failureDiagnostic(error, 'worker-admission'), ...(error.cleanupConfirmed === false ? {
      cleanupConfirmed: false, recoveryRoot: error.recoveryRoot || error.retainedHelperRoot || error.retainedRuntimeRoot || error.retainedStagingRoot,
      ...(error.retainedStagingRoot ? { retainedStagingRoot: error.retainedStagingRoot } : {}),
    } : {}) }
  }
}
async function runWindowsAppContainerCommand(policy, args, options = {}) {
  if (process.platform !== 'win32' || typeof options.controlRoot !== 'string' || !path.isAbsolute(options.controlRoot)) throw new WindowsAppContainerError('COMMAND_SANDBOX_UNSUPPORTED', 'A private controller root is required for Windows commands')
  try {
    const admitted = await ensureWorkerAdmission()
    if (currentAdmission(admitted.tuple).key !== admitted.key) throw new WindowsAppContainerError('WINDOWS_RUNTIME_MISMATCH', 'Runtime changed before command launch')
    return await runTupleCommand(policy, args, options, admitted.tuple, admitted.key)
  } catch (error) { retainUnknownAdmission(error); throw error }
}
async function runTupleCommand(policy, args, options, tuple, key) {
  refusePoisonedAdmission()
  if (currentAdmission(tuple).key !== key) throw new WindowsAppContainerError('WINDOWS_RUNTIME_MISMATCH', 'Runtime changed before tuple execution')
  if (process.platform !== 'win32' || typeof options.controlRoot !== 'string' || !path.isAbsolute(options.controlRoot)) throw new WindowsAppContainerError('COMMAND_SANDBOX_UNSUPPORTED', 'A private controller root is required for Windows commands')
  const controlRoot = fs.realpathSync.native(options.controlRoot)
  createWindowsFilesystemCapture().assertRecordParent(path.join(controlRoot, 'command-parent-check'))
  const nonce = crypto.randomUUID().replaceAll('-', '')
  // MSYS derives its installation root by removing the DLL filename, bin and
  // usr components. Keep that real layout inside one owned command directory.
  let stagingRoot, runtimeRoot, runtimeDirectory, cwdBridge
  let launcher, helperDeployment
  const { prepareWindowsAppContainerResources, recoverWindowsAppContainerResources } = require('./windows-appcontainer-resources.js')
  // Only the source-pinned, physically captured bundle can select worker bytes.
  // The loader keeps this opaque tuple for both the probe and later commands.
  const workerIdentity = workerBundle.revalidateTuple(tuple).identity
  const systemRoot = process.env.SystemRoot
  const start = Date.now()
  let lease, evidence, released = false, recoveryPending = false, privateScratch = null, runtimeOwned = false, runtimeCleanupUnknown = false, primaryError = null, cwdBridgeActive = false
  try {
    // PowerShell 5.1 and its hosted .NET Framework System.IO calls do not have
    // a controller-owned long-path configuration. Keep every managed helper
    // and executable path below the token profile's short, private root.
    stagingRoot = createWindowsCompilerDirectory('autoprompt-command-')
    runtimeRoot = path.join(stagingRoot, `command-runtime-${nonce}`)
    runtimeDirectory = path.join(runtimeRoot, 'usr', 'bin')
    if ([...(Array.isArray(policy.readableRoots) ? policy.readableRoots : []), ...(Array.isArray(policy.writableRoots) ? policy.writableRoots : [])]
      .some(root => typeof root === 'string' && (within(root, stagingRoot) || within(stagingRoot, root)))) {
      throw new WindowsAppContainerError('WINDOWS_RESOURCE_INVALID', 'Private command staging must be disjoint from worker resources')
    }
    cwdBridge = prepareCommandCwdBridge(stagingRoot, args.cwd)
    helperDeployment = require('./windows-helper-deployment.js').stageWindowsHelperDeployment(stagingRoot)
    // The cancellation marker lives in this operation's exclusively created
    // helper directory, whose cleanup follows the same process-drain evidence.
    const cancellationPath = path.join(helperDeployment.root, 'cancel')
    launcher = createWindowsAppContainerLauncher({ deploymentRoot: helperDeployment.root })
    if (!policy.scratchPath) {
      const scratch = path.join(path.dirname(controlRoot), `command-scratch-${nonce}`)
      fs.mkdirSync(scratch, { mode: 0o700 }); privateScratch = scratch
      ensureWindowsPrivateAcl(privateScratch)
      policy = { ...policy, scratchPath: privateScratch, readableRoots: [...policy.readableRoots, privateScratch], writableRoots: [...policy.writableRoots, privateScratch] }
    }
    const runtime = workerBundle.materializeTuple(tuple, runtimeRoot)
    runtimeOwned = true
    if (runtime.identity !== workerIdentity) throw new WindowsAppContainerError('WINDOWS_RUNTIME_MISMATCH', 'Worker tuple changed during materialization')
    lease = await prepareWindowsAppContainerResources({ policy, controlRoot, deploymentRoot: helperDeployment.root,
      executableRoots: [{ path: runtimeRoot, kind: 'directory' }, ...(cwdBridge ? [{ path: cwdBridge.root, kind: 'directory' }] : [])],
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
    refusePoisonedAdmission()
    if (currentAdmission(tuple).key !== key) throw new WindowsAppContainerError('WINDOWS_RUNTIME_MISMATCH', 'Runtime changed while preparing resource grants')
    if (cwdBridge) { cwdBridge = activateCommandCwdBridge(cwdBridge); cwdBridgeActive = true }
    evidence = await launcher.launch({ profileName: lease.profileName, profileSid: lease.profileSid,
      executable: runtime.bash, executableSha256: runtime.bashSha256, msysRuntime: runtime.msysRuntime, arguments: ['--noprofile', '--norc', '-c', args.command], cwd: cwdBridge?.alias || args.cwd,
      environment: Object.entries(env).map(([key, value]) => `${key}=${value}`), timeoutMs: args.timeoutMs || 60000,
      outputLimit: 1024 * 1024, cancellationPath }, { signal: options.signal, leaseId: lease.recovery.leaseId })
    if (cwdBridge && launcher.verifyDrainEvidence(evidence, { profileSid: lease.profileSid, leaseId: lease.recovery.leaseId }) !== true) {
      const error = new WindowsAppContainerError('APPCONTAINER_CLEANUP_UNCONFIRMED', 'Windows command cwd bridge lacks authoritative process drain evidence')
      error.cleanupConfirmed = false
      throw error
    }
    if (cwdBridgeActive) { removeCommandCwdBridge(cwdBridge); cwdBridgeActive = false }
    const resourceRecovery = Object.freeze({ ...await lease.release(evidence) })
    released = true
    const stdout = evidence.stdout, stderr = evidence.stderr, output = Buffer.concat([stdout, stderr])
    return { tool: 'bash', workerIdentity, resourceRecovery, command: args.command, cwd: args.cwd,
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
      if (lease && !evidence && (!cwdBridge || !runtimeCleanupUnknown)) {
        let unused
        try { unused = launcher.proveNotStarted({ profileSid: lease.profileSid, leaseId: lease.recovery.leaseId }) } catch {}
        if (unused) {
          if (cwdBridge && launcher.verifyDrainEvidence(unused, { profileSid: lease.profileSid, leaseId: lease.recovery.leaseId }) !== true) {
            throw new WindowsAppContainerError('APPCONTAINER_CLEANUP_UNCONFIRMED', 'Windows command cwd bridge lacks authoritative not-started evidence')
          }
          if (cwdBridgeActive) { removeCommandCwdBridge(cwdBridge); cwdBridgeActive = false }
          await lease.release(unused); released = true
          // A poison wrapper describes another operation's unknown cleanup.
          // This operation has independently proved that it never started.
          if (error.admissionFailure || error.workerFailure) runtimeCleanupUnknown = false
        }
      }
    } catch (recoveryError) {
      // A secondary recovery failure must not erase the original lease or an
      // unknown-cleanup marker that tells the caller to retain its outer root.
      error.cleanupConfirmed = false
      error.recoveryFailureCode = String(recoveryError.code || 'recovery-failed').slice(0, 64)
      runtimeCleanupUnknown = true
    }
    if (lease && !released) error.recovery = Object.freeze({ ...lease.recovery, profileSid: lease.profileSid })
    if (runtimeCleanupUnknown || recoveryPending || (lease && !released)) {
      error.cleanupConfirmed = false
      error.retainedRuntimeRoot = runtimeRoot
      error.retainedStagingRoot = stagingRoot
    }
    throw error
  } finally {
    // Unconfirmed launches retain their exact request artifacts alongside the
    // resource journal. Recovery must prove process drain before revoking grants.
    if ((!lease && !recoveryPending) || released) {
      let cleanupFailure
      const cleanup = operation => {
        try { operation() } catch (error) { if (!cleanupFailure) cleanupFailure = error }
      }
      let stagingCleanupAllowed = true
      if (cwdBridge) {
        try {
          if (cwdBridgeActive) throw new WindowsAppContainerError('APPCONTAINER_CLEANUP_UNCONFIRMED', 'Windows command cwd bridge remained active after cleanup')
          verifyCommandCwdBridgeParent(cwdBridge, [])
        } catch (error) {
          cleanupFailure ||= error
          stagingCleanupAllowed = false
        }
      }
      if (privateScratch) cleanup(() => fs.rmSync(privateScratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
      // Failed materialization owns its own cleanup accounting; EEXIST never
      // transfers ownership of a competing directory to this operation.
      if (stagingCleanupAllowed && runtimeOwned && !runtimeCleanupUnknown) cleanup(() => fs.rmSync(runtimeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
      if (stagingCleanupAllowed) cleanup(() => helperDeployment?.cleanup())
      // An exclusive loader collision or any failed/unknown child cleanup must
      // retain the staging parent rather than recursively deleting bytes whose
      // ownership or process lifetime was not proved.
      if (stagingCleanupAllowed && !cleanupFailure && stagingRoot && !runtimeCleanupUnknown && !fs.existsSync(runtimeRoot) && !(helperDeployment && fs.existsSync(helperDeployment.root))) {
        cleanup(() => fs.rmSync(stagingRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
      }
      if (!cleanupFailure && stagingRoot && fs.existsSync(stagingRoot)) {
        cleanupFailure = primaryError || new WindowsAppContainerError('APPCONTAINER_CLEANUP_UNCONFIRMED', 'Windows command staging cleanup is unconfirmed')
      }
      if (cleanupFailure) {
        const error = primaryError || cleanupFailure
        error.cleanupConfirmed = false
        error.retainedControlRoot = controlRoot
        error.retainedRuntimeRoot = runtimeRoot
        error.retainedStagingRoot = stagingRoot
        error.cleanupCode = String(cleanupFailure.code || 'cleanup-failed').slice(0, 64)
        if (!primaryError) throw error
      }
    }
  }
}
module.exports = { runWindowsAppContainerCommand, probeWindowsAppContainer, importedDlls, bindBashRuntime, windowsBashCandidates, resolveWindowsBash }
