'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { atomicCreateJson, checksumRecord, fsyncDirectory, stableStringify } = require('../../../agents/codex/workflow/event-log.js')
const { inspectPathNoFollow } = require('../../../agents/codex/workflow/safe-run-root.js')
const { materializeWindowsGrokRuntime } = require('./windows-runtime.cjs')
const { buildGrokInlineWorker } = require('./inline-worker-bundle.cjs')

const HASH = /^[a-f0-9]{64}$/u
const MAX_REQUEST_BYTES = 256 * 1024
const MAX_CLEANUP_COMMIT_BYTES = 8192
const BROKER_ENVIRONMENT = new Set(['SystemRoot', 'WINDIR', 'SystemDrive', 'PATH', 'TEMP', 'TMP'])
const WORKER_ENVIRONMENT = new Set(['SystemRoot', 'HOME', 'GROK_HOME', 'AUTOPROMPT_GROK_MODEL', 'AUTOPROMPT_GROK_RELAY_TOKEN', 'AUTOPROMPT_GROK_PROXY_TOKEN', 'AUTOPROMPT_GROK_PROXY_PORT', 'AUTOPROMPT_GROK_MCP_PORT', 'AUTOPROMPT_GROK_ALLOWED_MCP_TOOLS', 'AUTOPROMPT_GROK_ISSUED_CALLS', 'AUTOPROMPT_GROK_AUDIT_PATH'])
const REQUIRED_WORKER_ENVIRONMENT = ['SystemRoot', 'HOME', 'GROK_HOME', 'AUTOPROMPT_GROK_MODEL', 'AUTOPROMPT_GROK_RELAY_TOKEN', 'AUTOPROMPT_GROK_PROXY_TOKEN', 'AUTOPROMPT_GROK_PROXY_PORT', 'AUTOPROMPT_GROK_MCP_PORT', 'AUTOPROMPT_GROK_ALLOWED_MCP_TOOLS']
// Load the broker only from bytes whose pathname, open descriptor and digest
// agree. `require(path)` would execute the file before runBroker could verify
// its controller-captured hash.
const BROKER_BOOTSTRAP = `'use strict';const f=require('node:fs'),c=require('node:crypto'),P=require('node:path'),M=require('node:module'),p=process.argv[1],h=process.argv[5];let d;try{const n=f.lstatSync(p,{bigint:true});if(!P.isAbsolute(p)||!n.isFile()||n.isSymbolicLink()||n.nlink!==1n||n.size<1n||n.size>262144n)throw Error('Invalid broker module');d=f.openSync(p,f.constants.O_RDONLY|(f.constants.O_NOFOLLOW||0));const o=f.fstatSync(d,{bigint:true});if(o.dev!==n.dev||o.ino!==n.ino)throw Error('Changed broker module');const b=f.readFileSync(d),a=f.fstatSync(d,{bigint:true}),q=f.lstatSync(p,{bigint:true});if(['dev','ino','size','mtimeNs','ctimeNs'].some(k=>o[k]!==a[k])||q.dev!==o.dev||q.ino!==o.ino||c.createHash('sha256').update(b).digest('hex')!==h)throw Error('Changed broker module');const m=new M(p);m.filename=p;m.paths=M._nodeModulePaths(P.dirname(p));m._compile(b.toString('utf8'),p);Promise.resolve(m.exports.runBroker(p,process.argv[2],process.argv[3],process.argv[4],h)).catch(e=>{process.stderr.write(String(e&&e.stack||e)+'\\n');process.exitCode=1})}catch(e){process.stderr.write(String(e&&e.stack||e)+'\\n');process.exitCode=1}finally{if(d!==undefined)f.closeSync(d)}`

class GrokWindowsSandboxError extends Error {
  constructor(code, message) { super(message); this.name = 'GrokWindowsSandboxError'; this.code = code }
}
const fail = (code, message) => { throw new GrokWindowsSandboxError(code, message) }
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}
function exact(value, fields) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join('\0') === fields.slice().sort().join('\0')
}
function cleanObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.entries(value).some(([key, item]) =>
    typeof key !== 'string' || !key || key.includes('\0') || typeof item !== 'string' || item.includes('\0'))) {
    fail('GROK_WINDOWS_SANDBOX_INVALID', `${label} is invalid`)
  }
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
}
function closedEnvironment(value, allowed, required, label) {
  const result = cleanObject(value, label)
  if (Object.keys(result).some(key => !allowed.has(key)) || required.some(key => !result[key])) {
    fail('GROK_WINDOWS_SANDBOX_INVALID', `${label} contains an unadmitted or missing field`)
  }
  return result
}
function cleanBinding(value) {
  const fields = ['reservationId', 'sessionId', 'targetKey']
  if (!exact(value, fields) || fields.some(field => typeof value[field] !== 'string' || !value[field] || value[field].includes('\0'))) {
    fail('GROK_WINDOWS_SANDBOX_INVALID', 'Grok Windows sandbox requires an exact owner binding')
  }
  return Object.fromEntries(fields.map(field => [field, value[field]]))
}
function cleanOwnerBinding(value) {
  const fields = ['reservationId', 'sessionId', 'targetKey', 'launchBindingHash']
  if (!exact(value, fields) || !HASH.test(value.launchBindingHash || '')) fail('GROK_WINDOWS_SANDBOX_RECOVERY_INVALID', 'Grok recovery owner binding is invalid')
  return { ...cleanBinding({ reservationId: value.reservationId, sessionId: value.sessionId, targetKey: value.targetKey }), launchBindingHash: value.launchBindingHash }
}
function cleanPolicy(value) {
  const fields = ['readOnly', 'targetPath', 'scratchPath', 'readableRoots', 'writableRoots']
  if (!exact(value, fields) || typeof value.readOnly !== 'boolean' ||
      !['targetPath', 'scratchPath'].every(key => typeof value[key] === 'string' && value[key] && !value[key].includes('\0')) ||
      !['readableRoots', 'writableRoots'].every(key => Array.isArray(value[key]) && value[key].length <= 32 &&
        value[key].every(item => typeof item === 'string' && item && !item.includes('\0')))) {
    fail('GROK_WINDOWS_SANDBOX_INVALID', 'Grok Windows AppContainer policy is invalid')
  }
  return { readOnly: value.readOnly, targetPath: value.targetPath, scratchPath: value.scratchPath,
    readableRoots: [...value.readableRoots], writableRoots: [...value.writableRoots] }
}
function boundFile(file, maximumBytes = MAX_REQUEST_BYTES, single = true) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')) fail('GROK_WINDOWS_SANDBOX_INVALID', 'Bound file path is invalid')
  let descriptor
  try {
    const named = fs.lstatSync(file, { bigint: true })
    if (!named.isFile() || named.isSymbolicLink() || (single && named.nlink !== 1n) || named.size < 1n || named.size > BigInt(maximumBytes)) fail('GROK_WINDOWS_SANDBOX_IDENTITY_CHANGED', 'Bound file is not one bounded physical file')
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    const opened = fs.fstatSync(descriptor, { bigint: true })
    if (opened.dev !== named.dev || opened.ino !== named.ino) fail('GROK_WINDOWS_SANDBOX_IDENTITY_CHANGED', 'Bound file changed while opening')
    const bytes = fs.readFileSync(descriptor), after = fs.fstatSync(descriptor, { bigint: true })
    const namedAfter = fs.lstatSync(file, { bigint: true })
    if (bytes.length !== Number(opened.size) || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => opened[key] !== after[key]) ||
        namedAfter.dev !== opened.dev || namedAfter.ino !== opened.ino) fail('GROK_WINDOWS_SANDBOX_IDENTITY_CHANGED', 'Bound file changed while reading')
    const result = { path: fs.realpathSync.native(file), sha256: sha256(bytes), size: bytes.length,
      identity: { dev: String(opened.dev), ino: String(opened.ino) } }
    Object.defineProperty(result, 'bytes', { value: bytes })
    return deepFreeze(result)
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor) }
}
function sameBinding(left, right) { return stableStringify(left) === stableStringify(right) }
function removeExact(file, binding) {
  const current = boundFile(file, MAX_REQUEST_BYTES)
  if (!sameBinding(current, binding)) fail('GROK_WINDOWS_SANDBOX_IDENTITY_CHANGED', 'Broker request identity changed before cleanup')
  fs.unlinkSync(file)
}
function cleanupCommitPath(controlRoot, leaseId) {
  if (typeof controlRoot !== 'string' || !path.isAbsolute(controlRoot) || !/^[a-f0-9]{32}$/u.test(leaseId || '')) {
    fail('GROK_WINDOWS_SANDBOX_RECOVERY_INVALID', 'Grok helper cleanup record path is invalid')
  }
  return path.join(controlRoot, `grok-helper-cleanup-${leaseId}.json`)
}
function restoreReceiptBinding(semantic) {
  const journalBinding = boundFile(semantic.lease.resourceJournalBinding.path, 8 * 1024 * 1024)
  if (!sameBinding(journalBinding, semantic.lease.resourceJournalBinding)) fail('GROK_WINDOWS_SANDBOX_IDENTITY_CHANGED', 'Grok resource journal changed before cleanup commit')
  let journal
  try { journal = JSON.parse(journalBinding.bytes.toString('utf8')) } catch { fail('GROK_WINDOWS_SANDBOX_RECOVERY_INVALID', 'Grok resource journal is invalid') }
  const journalBody = { schemaVersion: 1, leaseId: journal?.leaseId, plan: journal?.plan }
  if (!exact(journal, ['schemaVersion', 'leaseId', 'plan', 'sha256']) || journal.schemaVersion !== 1 ||
      journal.leaseId !== semantic.lease.recovery.leaseId || !journal.plan || typeof journal.plan !== 'object' || Array.isArray(journal.plan) ||
      !Array.isArray(journal.plan.entries) || journal.sha256 !== sha256(Buffer.from(JSON.stringify(journalBody)))) {
    fail('GROK_WINDOWS_SANDBOX_RECOVERY_INVALID', 'Grok resource journal is not a sealed restoration plan')
  }
  const binding = boundFile(`${semantic.lease.recovery.journalPath}.restored`, 4096)
  let receipt
  try { receipt = JSON.parse(binding.bytes.toString('utf8')) } catch { fail('GROK_WINDOWS_SANDBOX_RECOVERY_INVALID', 'Grok resource restoration receipt is invalid') }
  if (!exact(receipt, ['schemaVersion', 'leaseId', 'profileSid', 'result']) || receipt.schemaVersion !== 1 ||
      receipt.leaseId !== semantic.lease.recovery.leaseId || receipt.profileSid !== semantic.lease.profileSid ||
      !exact(receipt.result, ['restored', 'newEntries', 'deletedEntries']) || Object.values(receipt.result).some(value => !Number.isSafeInteger(value) || value < 0) ||
      receipt.result.restored > 16384 || receipt.result.deletedEntries > 16384 || receipt.result.newEntries > 32768 ||
      receipt.result.restored + receipt.result.newEntries > 32768 ||
      receipt.result.restored + receipt.result.deletedEntries !== journal.plan.entries.length) {
    fail('GROK_WINDOWS_SANDBOX_RECOVERY_INVALID', 'Grok resource restoration receipt is not complete')
  }
  return binding
}
function cleanupCommitBody(requestBinding, semantic, expected, restoredReceipt) {
  return {
    schemaVersion: 1, leaseId: semantic.lease.recovery.leaseId,
    request: { name: path.basename(requestBinding.path), sha256: requestBinding.sha256, identity: requestBinding.identity },
    owner: cleanOwnerBinding(expected), helperDeploymentBinding: cleanHelperDeploymentBinding(semantic.helperDeploymentBinding, semantic.helperDeploymentRoot),
    restoredReceipt: { name: path.basename(restoredReceipt.path), sha256: restoredReceipt.sha256, identity: restoredReceipt.identity },
  }
}
function cleanupCommitDigest(body) { return sha256(Buffer.from(stableStringify(body))) }
function cleanupCommitStagingPattern(file) {
  const escaped = path.basename(file).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`^\\.${escaped}\\.[1-9][0-9]*\\.[a-f0-9]{16}\\.create$`, 'u')
}
function boundCleanupCommit(file, expectedBytes, recoverAlias = true) {
  const directory = path.dirname(file)
  let root
  try { root = inspectPathNoFollow(directory) } catch {
    fail('GROK_WINDOWS_SANDBOX_IDENTITY_CHANGED', 'Grok helper cleanup record parent changed')
  }
  if (!root.exists || !root.identity) fail('GROK_WINDOWS_SANDBOX_IDENTITY_CHANGED', 'Grok helper cleanup record parent is absent')
  const current = boundFile(file, MAX_CLEANUP_COMMIT_BYTES, false)
  let named
  try { named = fs.lstatSync(file, { bigint: true }) } catch {
    fail('GROK_WINDOWS_SANDBOX_IDENTITY_CHANGED', 'Grok helper cleanup record changed after reading')
  }
  if (!named.isFile() || named.isSymbolicLink() || String(named.dev) !== current.identity.dev || String(named.ino) !== current.identity.ino) {
    fail('GROK_WINDOWS_SANDBOX_IDENTITY_CHANGED', 'Grok helper cleanup record changed after reading')
  }
  if (expectedBytes && !current.bytes.equals(expectedBytes)) fail('GROK_WINDOWS_SANDBOX_IDENTITY_CHANGED', 'Grok helper cleanup record changed')
  if (named.nlink === 1n) return current
  if (named.nlink !== 2n) fail('GROK_WINDOWS_SANDBOX_IDENTITY_CHANGED', 'Grok helper cleanup record has unknown hard links')
  // A reader first authenticates the complete record and its recovery closure.
  // Only the second, exact-byte-bound pass may remove a crash alias.
  if (!recoverAlias) return current
  const candidates = fs.readdirSync(directory).filter(name => cleanupCommitStagingPattern(file).test(name))
  if (candidates.length !== 1) fail('GROK_WINDOWS_SANDBOX_IDENTITY_CHANGED', 'Grok helper cleanup record has no unique staging alias')
  const alias = path.join(directory, candidates[0])
  let aliasStat
  try { aliasStat = fs.lstatSync(alias, { bigint: true }) } catch {
    fail('GROK_WINDOWS_SANDBOX_IDENTITY_CHANGED', 'Grok helper cleanup staging alias changed')
  }
  if (!aliasStat.isFile() || aliasStat.isSymbolicLink() || aliasStat.nlink !== 2n ||
      aliasStat.dev !== named.dev || aliasStat.ino !== named.ino) {
    fail('GROK_WINDOWS_SANDBOX_IDENTITY_CHANGED', 'Grok helper cleanup staging alias is foreign')
  }
  let finalAgain, aliasAgain
  try {
    finalAgain = fs.lstatSync(file, { bigint: true })
    aliasAgain = fs.lstatSync(alias, { bigint: true })
  } catch { fail('GROK_WINDOWS_SANDBOX_IDENTITY_CHANGED', 'Grok helper cleanup staging alias changed') }
  if (finalAgain.dev !== named.dev || finalAgain.ino !== named.ino || finalAgain.nlink !== 2n ||
      aliasAgain.dev !== named.dev || aliasAgain.ino !== named.ino || aliasAgain.nlink !== 2n) {
    fail('GROK_WINDOWS_SANDBOX_IDENTITY_CHANGED', 'Grok helper cleanup staging alias changed')
  }
  fs.unlinkSync(alias)
  fsyncDirectory(directory)
  let rootAfter
  try { rootAfter = inspectPathNoFollow(directory) } catch {
    fail('GROK_WINDOWS_SANDBOX_IDENTITY_CHANGED', 'Grok helper cleanup record parent changed')
  }
  if (!rootAfter.exists || !sameBinding(root.identity, rootAfter.identity)) {
    fail('GROK_WINDOWS_SANDBOX_IDENTITY_CHANGED', 'Grok helper cleanup record parent changed')
  }
  const recovered = boundFile(file, MAX_CLEANUP_COMMIT_BYTES)
  if (!sameBinding(recovered, current) || !recovered.bytes.equals(current.bytes)) fail('GROK_WINDOWS_SANDBOX_IDENTITY_CHANGED', 'Grok helper cleanup record changed during alias recovery')
  return recovered
}
function writeCleanupCommit(controlRoot, requestBinding, semantic, expected) {
  const restoredReceipt = restoreReceiptBinding(semantic)
  const body = cleanupCommitBody(requestBinding, semantic, expected, restoredReceipt)
  const value = { ...body, sha256: cleanupCommitDigest(body) }
  const signed = { ...value, checksum: checksumRecord(value) }
  const bytes = Buffer.from(`${stableStringify(signed)}\n`)
  if (bytes.length > MAX_CLEANUP_COMMIT_BYTES) fail('GROK_WINDOWS_SANDBOX_INVALID', 'Grok helper cleanup record exceeds its bound')
  const file = cleanupCommitPath(controlRoot, semantic.lease.recovery.leaseId)
  try {
    atomicCreateJson(file, value, { mode: 0o600 })
  }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    boundCleanupCommit(file, bytes)
  }
  return Object.freeze({ path: file, ...body, sha256: value.sha256 })
}
function readCleanupCommit(controlRoot, requestBinding, semantic, expected) {
  const file = cleanupCommitPath(controlRoot, semantic.lease.recovery.leaseId)
  try {
    if (!inspectPathNoFollow(file, { mustBeDirectory: false }).exists) return null
  } catch {
    fail('GROK_WINDOWS_SANDBOX_IDENTITY_CHANGED', 'Grok helper cleanup record path is not one exact physical file')
  }
  let binding = boundCleanupCommit(file, undefined, false)
  let value
  try { value = JSON.parse(binding.bytes.toString('utf8')) } catch { fail('GROK_WINDOWS_SANDBOX_RECOVERY_INVALID', 'Grok helper cleanup record is invalid') }
  if (!exact(value, ['schemaVersion', 'leaseId', 'request', 'owner', 'helperDeploymentBinding', 'restoredReceipt', 'sha256', 'checksum']) || value.schemaVersion !== 1 ||
      value.leaseId !== semantic.lease.recovery.leaseId || !HASH.test(value.sha256 || '') ||
      !HASH.test(value.checksum || '') || value.checksum !== checksumRecord(value)) {
    fail('GROK_WINDOWS_SANDBOX_RECOVERY_INVALID', 'Grok helper cleanup record schema is invalid')
  }
  const body = { schemaVersion: value.schemaVersion, leaseId: value.leaseId, request: value.request, owner: value.owner,
    helperDeploymentBinding: value.helperDeploymentBinding, restoredReceipt: value.restoredReceipt }
  if (cleanupCommitDigest(body) !== value.sha256 || stableStringify(body) !== stableStringify(cleanupCommitBody(requestBinding, semantic, expected, restoreReceiptBinding(semantic)))) {
    fail('GROK_WINDOWS_SANDBOX_IDENTITY_CHANGED', 'Grok helper cleanup record does not bind the sealed recovery closure')
  }
  binding = boundCleanupCommit(file, binding.bytes)
  return Object.freeze({ path: file, binding, ...body, sha256: value.sha256 })
}
function helperDeploymentPresent(helperDeploymentRoot) {
  try {
    const inspected = inspectPathNoFollow(helperDeploymentRoot)
    if (!inspected.exists) return false
    if (!inspected.identity || typeof inspected.realpath !== 'string') {
      fail('GROK_WINDOWS_SANDBOX_IDENTITY_CHANGED', 'Grok helper deployment is not one exact physical directory')
    }
    return true
  } catch (error) {
    if (error instanceof GrokWindowsSandboxError) throw error
    fail('GROK_WINDOWS_SANDBOX_IDENTITY_CHANGED', 'Grok helper deployment is not one exact physical directory')
  }
}
function ownerAuthority(processOwner) {
  if (!processOwner || typeof processOwner.issueBoundDrainReceipt !== 'function' || typeof processOwner.verifyBoundDrainReceipt !== 'function') {
    fail('GROK_WINDOWS_SANDBOX_INVALID', 'Grok Windows sandbox requires ProcessOwner drain authority')
  }
  return processOwner
}
function dependencies(overrides = {}) {
  return {
    materializeRuntime: overrides.materializeRuntime || materializeWindowsGrokRuntime,
    buildWorker: overrides.buildWorker || buildGrokInlineWorker,
    createLauncher: overrides.createLauncher || (options => require('../../../agents/codex/workflow/windows-appcontainer.js').createWindowsAppContainerLauncher(options)),
    resources: overrides.resources || require('../../../agents/codex/workflow/windows-appcontainer-resources.js'),
    helperDeployment: overrides.helperDeployment || require('../../../agents/codex/workflow/windows-helper-deployment.js'),
  }
}
function assertTrustedHelperDeployment(controlRoot, helperDeploymentRoot, helperDeploymentBinding, deps) {
  // Portable closure tests model Windows paths on POSIX.  Native recovery must
  // additionally bind an external short deployment to the current token
  // profile and its protected direct child.
  let trusted
  if (process.platform !== 'win32') {
    let stat
    try {
      if (fs.realpathSync.native(helperDeploymentRoot) !== path.resolve(helperDeploymentRoot)) throw new Error('noncanonical')
      stat = fs.lstatSync(helperDeploymentRoot, { bigint: true })
    } catch { fail('GROK_WINDOWS_SANDBOX_RECOVERY_INVALID', 'Grok helper deployment is not an authenticated private root') }
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('GROK_WINDOWS_SANDBOX_RECOVERY_INVALID', 'Grok helper deployment is not an authenticated private root')
    trusted = { identity: { dev: String(stat.dev), ino: String(stat.ino) } }
  } else try { trusted = deps.helperDeployment.assertTrustedWindowsHelperDeployment(controlRoot, helperDeploymentRoot) }
  catch { fail('GROK_WINDOWS_SANDBOX_RECOVERY_INVALID', 'Grok helper deployment is not an authenticated private root') }
  if (trusted.identity.dev !== helperDeploymentBinding.identity.dev || trusted.identity.ino !== helperDeploymentBinding.identity.ino) {
    fail('GROK_WINDOWS_SANDBOX_IDENTITY_CHANGED', 'Grok helper deployment identity changed')
  }
}
function cleanHelperDeploymentBinding(value, expectedRoot) {
  if (!exact(value, ['root', 'identity']) || value.root !== expectedRoot || !exact(value.identity, ['dev', 'ino']) ||
      !/^(?:0|[1-9][0-9]*)$/u.test(value.identity.dev || '') || !/^(?:0|[1-9][0-9]*)$/u.test(value.identity.ino || '')) {
    fail('GROK_WINDOWS_SANDBOX_INVALID', 'Grok helper cleanup binding is invalid')
  }
  return deepFreeze({ root: value.root, identity: { dev: value.identity.dev, ino: value.identity.ino } })
}
function parseSemantic(requestBinding) {
  let semantic
  try { semantic = JSON.parse(requestBinding.bytes.toString('utf8')) } catch { fail('GROK_WINDOWS_SANDBOX_INVALID', 'Grok broker request is invalid') }
  if (!semantic || typeof semantic !== 'object' || Array.isArray(semantic) || semantic.schemaVersion !== 1) fail('GROK_WINDOWS_SANDBOX_INVALID', 'Grok broker request schema is invalid')
  return semantic
}
function verifyPersistedClosure(semantic, moduleBinding, requestBinding, launchBindingHash, deps, options = {}) {
  if (sha256(Buffer.from(stableStringify({ semantic, moduleBinding, requestBinding }))) !== launchBindingHash) fail('GROK_WINDOWS_SANDBOX_IDENTITY_CHANGED', 'Grok broker closure changed')
  const brokerNodeBinding = boundFile(semantic.broker.executableBinding.path, 512 * 1024 * 1024, false)
  if (!sameBinding(brokerNodeBinding, semantic.broker.executableBinding)) fail('GROK_WINDOWS_SANDBOX_IDENTITY_CHANGED', 'Grok broker executable changed')
  const appNodeBinding = boundFile(semantic.appNodeBinding.path, 512 * 1024 * 1024, false)
  if (!sameBinding(appNodeBinding, semantic.appNodeBinding)) fail('GROK_WINDOWS_SANDBOX_IDENTITY_CHANGED', 'Grok worker Node executable changed')
  const runtimeBinding = boundFile(semantic.runtime.executable.path, 512 * 1024 * 1024, false)
  if (!sameBinding(runtimeBinding, semantic.runtime.executable)) fail('GROK_WINDOWS_SANDBOX_IDENTITY_CHANGED', 'Grok runtime executable changed')
  const resourceJournalBinding = boundFile(semantic.lease.resourceJournalBinding.path, 8 * 1024 * 1024)
  if (!sameBinding(resourceJournalBinding, semantic.lease.resourceJournalBinding)) fail('GROK_WINDOWS_SANDBOX_IDENTITY_CHANGED', 'Grok resource journal changed')
  if (options.skipLauncher === true) return null
  const launcher = deps.createLauncher({ deploymentRoot: semantic.helperDeploymentRoot })
  if (!sameBinding(launcher.binding, semantic.launcherBinding)) fail('GROK_WINDOWS_SANDBOX_IDENTITY_CHANGED', 'Grok AppContainer helper binding changed')
  return launcher
}
function semanticLaunch(options, policy, runtime, worker, launcher, lease, binding, appNodeBinding, brokerNodeBinding, resourceJournalBinding, helperDeploymentBinding) {
  const workerEnvironment = closedEnvironment(options.workerEnvironment, WORKER_ENVIRONMENT, REQUIRED_WORKER_ENVIRONMENT, 'Grok worker environment')
  const systemRoot = workerEnvironment.SystemRoot
  if (typeof systemRoot !== 'string' || !/^[A-Za-z]:\\Windows$/iu.test(systemRoot)) fail('GROK_WINDOWS_SANDBOX_INVALID', 'Grok worker SystemRoot is invalid')
  const environment = {
    ...lease.environment,
    ...workerEnvironment,
    SystemRoot: systemRoot,
    AUTOPROMPT_GROK_SYSTEM_PATH: path.win32.join(systemRoot, 'System32'),
    AUTOPROMPT_GROK_EXECUTABLE: runtime.executable.path,
    AUTOPROMPT_GROK_CWD: policy.targetPath,
    AUTOPROMPT_GROK_RELAY_FD: '0',
    LOCALAPPDATA: path.win32.join(lease.environment.USERPROFILE, 'AppData', 'Local'),
  }
  return {
    schemaVersion: 1,
    binding,
    policy,
    runtime,
    appNodeBinding,
    worker: { payloadSha256: worker.payloadSha256, moduleSha256: worker.moduleSha256, executable: worker.executable, argv: worker.argv },
    launcherBinding: launcher.binding,
    helperDeploymentRoot: options.helperDeploymentRoot,
    helperDeploymentBinding,
    lease: { profileName: lease.profileName, profileSid: lease.profileSid, recovery: lease.recovery, resourceJournalBinding },
    appLaunch: {
      profileName: lease.profileName, profileSid: lease.profileSid,
      executable: worker.executable, executableSha256: options.nodeExecutableSha256,
      arguments: worker.argv, cwd: policy.targetPath,
      environment: Object.entries(environment).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}=${value}`),
      timeoutMs: options.timeoutMs, outputLimit: options.outputLimit,
      cancellationPath: options.cancellationPath, relayStdin: true, streamOutput: true,
    },
    pipe: options.pipe,
    broker: { executable: options.brokerNodeExecutable, executableBinding: brokerNodeBinding, cwd: options.brokerCwd,
      environment: closedEnvironment(options.brokerEnvironment, BROKER_ENVIRONMENT, ['SystemRoot', 'PATH'], 'Grok broker environment'), bootstrapSha256: sha256(Buffer.from(BROKER_BOOTSTRAP)) },
  }
}

async function prepareWindowsGrokSandbox(options = {}) {
  const processOwner = ownerAuthority(options.processOwner)
  const binding = cleanBinding(options.binding)
  const policy = cleanPolicy(options.policy)
  const deps = dependencies(options._dependencies)
  if (typeof options.controlRoot !== 'string' || !path.isAbsolute(options.controlRoot) || typeof options.helperDeploymentRoot !== 'string' || !path.isAbsolute(options.helperDeploymentRoot) ||
      typeof options.brokerNodeExecutable !== 'string' || !path.isAbsolute(options.brokerNodeExecutable) || typeof options.brokerCwd !== 'string' || !path.isAbsolute(options.brokerCwd) ||
      !HASH.test(options.brokerNodeSha256 || '') || typeof options.nodeExecutable !== 'string' || !path.isAbsolute(options.nodeExecutable) || !HASH.test(options.nodeExecutableSha256 || '') ||
      typeof options.cancellationPath !== 'string' || !path.isAbsolute(options.cancellationPath) || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 ||
      !Number.isSafeInteger(options.outputLimit) || options.outputLimit < 1 ||
      !exact(options.pipe, ['socketPath']) || typeof options.pipe.socketPath !== 'string' || !/^\\\\\.\\pipe\\autoprompt-grok-[a-f0-9]{64}$/u.test(options.pipe.socketPath)) {
    fail('GROK_WINDOWS_SANDBOX_INVALID', 'Grok Windows sandbox launch options are invalid')
  }
  const helperDeploymentBinding = cleanHelperDeploymentBinding(options.helperDeploymentBinding, options.helperDeploymentRoot)
  assertTrustedHelperDeployment(options.controlRoot, options.helperDeploymentRoot, helperDeploymentBinding, deps)
  const runtime = deps.materializeRuntime(options.runtime)
  const appNodeBinding = boundFile(options.nodeExecutable, 512 * 1024 * 1024, false)
  const brokerNodeBinding = boundFile(options.brokerNodeExecutable, 512 * 1024 * 1024, false)
  if (appNodeBinding.sha256 !== options.nodeExecutableSha256 || brokerNodeBinding.sha256 !== options.brokerNodeSha256) fail('GROK_WINDOWS_SANDBOX_IDENTITY_CHANGED', 'Grok Node executable binding changed')
  const worker = deps.buildWorker({ nodeExecutable: options.nodeExecutable, nodeArgs: options.nodeArgs || [], workerArgs: options.workerArgs || [] })
  const launcher = deps.createLauncher({ deploymentRoot: options.helperDeploymentRoot })
  let entered = false, launchBindingHash = null
  const verifyDrainEvidence = (evidence, leaseBinding) => {
    if (!entered && launcher.verifyDrainEvidence(evidence, leaseBinding) === true) return true
    if (!launchBindingHash) return false
    try { return processOwner.verifyBoundDrainReceipt(evidence, { ...binding, launchBindingHash }) === true } catch { return false }
  }
  let lease
  try {
    lease = await deps.resources.prepareWindowsAppContainerResources({
      policy, controlRoot: options.controlRoot, deploymentRoot: options.helperDeploymentRoot,
      executableRoots: [{ path: options.nodeExecutable, kind: 'file' }, { path: runtime.executable.path, kind: 'file' }],
      verifyDrainEvidence,
    })
  } catch (error) {
    if (error?.recovery && typeof deps.resources.recoverWindowsAppContainerResources === 'function') {
      try {
        const unused = launcher.proveNotStarted({ profileSid: error.recovery.profileSid, leaseId: error.recovery.leaseId })
        await deps.resources.recoverWindowsAppContainerResources({ controlRoot: options.controlRoot, deploymentRoot: options.helperDeploymentRoot,
          ...error.recovery, verifyDrainEvidence, evidence: unused })
      } catch (cleanupError) { try { Object.defineProperty(error, 'cleanupFailure', { value: cleanupError }) } catch {} }
    }
    throw error
  }
  let requestBinding
  try {
    const resourceJournalBinding = boundFile(lease.recovery.journalPath, 8 * 1024 * 1024)
    const semantic = semanticLaunch(options, policy, runtime, worker, launcher, lease, binding, appNodeBinding, brokerNodeBinding, resourceJournalBinding, helperDeploymentBinding)
    const moduleBinding = boundFile(__filename)
    const requestPath = path.join(options.controlRoot, `grok-broker-${lease.recovery.leaseId}.json`)
    const bytes = Buffer.from(`${JSON.stringify(semantic)}\n`)
    if (bytes.length > MAX_REQUEST_BYTES) fail('GROK_WINDOWS_SANDBOX_INVALID', 'Grok broker request exceeds its bound')
    fs.writeFileSync(requestPath, bytes, { flag: 'wx', mode: 0o600 })
    requestBinding = boundFile(requestPath)
    const immutable = { semantic, moduleBinding, requestBinding }
    launchBindingHash = sha256(Buffer.from(stableStringify(immutable)))
    const launch = deepFreeze({ executable: options.brokerNodeExecutable,
      argv: ['-e', BROKER_BOOTSTRAP, '--', moduleBinding.path, requestBinding.path, requestBinding.sha256, launchBindingHash, moduleBinding.sha256],
      cwd: options.brokerCwd, env: semantic.broker.environment })
    let cleaned = false, cleanupStarted = false, cleanupPromise = null
    const cleanup = async () => {
      if (cleaned) return
      if (cleanupPromise) return cleanupPromise
      // Once cleanup begins, even a failed or pending attempt permanently
      // revokes the same-process capability to enter ProcessOwner.
      cleanupStarted = true
      cleanupPromise = (async () => {
        let evidence
        const expected = { ...binding, launchBindingHash }
        if (!entered) evidence = launcher.proveNotStarted({ profileSid: lease.profileSid, leaseId: lease.recovery.leaseId })
        else {
          evidence = await processOwner.issueBoundDrainReceipt(expected)
          processOwner.verifyBoundDrainReceipt(evidence, expected)
        }
        await lease.release(evidence)
        writeCleanupCommit(options.controlRoot, requestBinding, semantic, expected)
        deps.helperDeployment.cleanupWindowsHelperDeployment(options.controlRoot, helperDeploymentBinding)
        if (helperDeploymentPresent(semantic.helperDeploymentRoot)) {
          fail('GROK_WINDOWS_SANDBOX_IDENTITY_CHANGED', 'Grok helper deployment remains after exact cleanup')
        }
        removeExact(requestBinding.path, requestBinding)
        cleaned = true
      })()
      try { return await cleanupPromise } catch (error) { cleanupPromise = null; throw error }
    }
    return Object.freeze({ launch, relayStdin: deepFreeze({ ...options.pipe }), launchBindingHash,
      markReservationEntered() { if (cleaned || cleanupStarted) fail('GROK_WINDOWS_SANDBOX_STATE_INVALID', 'Cleaning Grok sandbox cannot enter a reservation'); entered = true },
      cleanup,
    })
  } catch (error) {
    // Preparation has not entered ProcessOwner. The launcher's unstarted
    // capability is the only authority that may restore this fresh lease.
    try {
      const unused = launcher.proveNotStarted({ profileSid: lease.profileSid, leaseId: lease.recovery.leaseId })
      await lease.release(unused)
      if (requestBinding) removeExact(requestBinding.path, requestBinding)
    } catch (cleanupError) { try { Object.defineProperty(error, 'cleanupFailure', { value: cleanupError }) } catch {} }
    throw error
  }
}

async function runBroker(modulePath, requestPath, expectedRequestSha256, expectedLaunchBindingHash, expectedModuleSha256, overrides = {}) {
  if (![expectedRequestSha256, expectedLaunchBindingHash, expectedModuleSha256].every(value => HASH.test(value || ''))) fail('GROK_WINDOWS_SANDBOX_INVALID', 'Grok broker binding is invalid')
  const moduleBinding = boundFile(modulePath)
  if (moduleBinding.sha256 !== expectedModuleSha256 || moduleBinding.path !== fs.realpathSync.native(__filename)) fail('GROK_WINDOWS_SANDBOX_IDENTITY_CHANGED', 'Grok broker module changed')
  const requestBinding = boundFile(requestPath)
  if (requestBinding.sha256 !== expectedRequestSha256) fail('GROK_WINDOWS_SANDBOX_IDENTITY_CHANGED', 'Grok broker request changed')
  const semantic = parseSemantic(requestBinding)
  const deps = dependencies(overrides)
  const launcher = verifyPersistedClosure(semantic, moduleBinding, requestBinding, expectedLaunchBindingHash, deps)
  if (!sameBinding(boundFile(process.execPath, 512 * 1024 * 1024, false), semantic.broker.executableBinding)) fail('GROK_WINDOWS_SANDBOX_IDENTITY_CHANGED', 'Current Grok broker executable changed')
  const result = await launcher.launch(semantic.appLaunch, { relayStdin: process.stdin, leaseId: semantic.lease.recovery.leaseId,
    onStdout: bytes => process.stdout.write(bytes), onStderr: bytes => process.stderr.write(bytes) })
  if (!result || result.drained !== true || result.profileSid !== semantic.lease.profileSid) fail('GROK_WINDOWS_SANDBOX_DRAIN_UNCONFIRMED', 'Grok AppContainer launch did not prove drain')
  if (result.exitCode !== 0) process.exitCode = 1
  return result
}

async function recoverWindowsGrokSandbox(options = {}) {
  const processOwner = ownerAuthority(options.processOwner)
  const expected = cleanOwnerBinding(options.binding)
  if (typeof options.controlRoot !== 'string' || !path.isAbsolute(options.controlRoot) ||
      typeof options.brokerRequestPath !== 'string' || !path.isAbsolute(options.brokerRequestPath) ||
      path.dirname(options.brokerRequestPath) !== options.controlRoot ||
      typeof options.helperDeploymentRoot !== 'string' || !path.isAbsolute(options.helperDeploymentRoot)) {
    fail('GROK_WINDOWS_SANDBOX_RECOVERY_INVALID', 'Grok recovery paths are invalid')
  }
  const deps = dependencies(options._dependencies)
  const moduleBinding = boundFile(__filename)
  const requestBinding = boundFile(options.brokerRequestPath)
  const semantic = parseSemantic(requestBinding)
  if (!sameBinding(semantic.binding, { reservationId: expected.reservationId, sessionId: expected.sessionId, targetKey: expected.targetKey }) ||
      semantic.helperDeploymentRoot !== options.helperDeploymentRoot ||
      semantic.lease?.recovery?.journalPath !== semantic.lease?.resourceJournalBinding?.path ||
      !/^[a-f0-9]{32}$/u.test(semantic.lease?.recovery?.leaseId || '')) {
    fail('GROK_WINDOWS_SANDBOX_RECOVERY_INVALID', 'Grok recovery metadata differs from its owner binding')
  }
  const helperDeploymentBinding = cleanHelperDeploymentBinding(semantic.helperDeploymentBinding, semantic.helperDeploymentRoot)
  const committed = readCleanupCommit(options.controlRoot, requestBinding, semantic, expected)
  const helperPresent = helperDeploymentPresent(semantic.helperDeploymentRoot)
  if (helperPresent) assertTrustedHelperDeployment(options.controlRoot, semantic.helperDeploymentRoot, helperDeploymentBinding, deps)
  else if (!committed) fail('GROK_WINDOWS_SANDBOX_RECOVERY_INVALID', 'Grok helper deployment is absent without a committed cleanup record')
  verifyPersistedClosure(semantic, moduleBinding, requestBinding, expected.launchBindingHash, deps, { skipLauncher: !helperPresent })
  const receipt = await processOwner.issueBoundDrainReceipt(expected)
  if (processOwner.verifyBoundDrainReceipt(receipt, expected) !== true) fail('GROK_WINDOWS_SANDBOX_RECOVERY_INVALID', 'Grok recovery drain receipt is foreign')
  const verifyDrainEvidence = (evidence, leaseBinding) => leaseBinding.profileSid === semantic.lease.profileSid &&
    leaseBinding.leaseId === semantic.lease.recovery.leaseId && processOwner.verifyBoundDrainReceipt(evidence, expected) === true
  const result = committed
    ? JSON.parse(restoreReceiptBinding(semantic).bytes.toString('utf8')).result
    : await deps.resources.recoverWindowsAppContainerResources({ controlRoot: options.controlRoot,
      deploymentRoot: options.helperDeploymentRoot, ...semantic.lease.recovery, verifyDrainEvidence, evidence: receipt })
  if (!committed) writeCleanupCommit(options.controlRoot, requestBinding, semantic, expected)
  deps.helperDeployment.cleanupWindowsHelperDeployment(options.controlRoot, helperDeploymentBinding)
  if (helperDeploymentPresent(semantic.helperDeploymentRoot)) {
    fail('GROK_WINDOWS_SANDBOX_IDENTITY_CHANGED', 'Grok helper deployment remains after exact cleanup')
  }
  removeExact(requestBinding.path, requestBinding)
  return result
}

async function recoverDiscoveredWindowsGrokSandbox(options = {}) {
  const owner = ownerAuthority(options.processOwner)
  if (typeof owner.listRecords !== 'function' || typeof options.targetKey !== 'string' || !options.targetKey) {
    fail('GROK_WINDOWS_SANDBOX_RECOVERY_INVALID', 'Grok discovery requires the current ProcessOwner registry')
  }
  const requestBinding = boundFile(options.brokerRequestPath)
  const semantic = parseSemantic(requestBinding)
  const binding = cleanBinding(semantic.binding)
  if (binding.targetKey !== options.targetKey) fail('GROK_WINDOWS_SANDBOX_RECOVERY_INVALID', 'Grok broker belongs to another target')
  const records = owner.listRecords().filter(record => record.reservationId === binding.reservationId &&
    record.sessionId === binding.sessionId && record.targetKey === binding.targetKey)
  if (records.length !== 1 || !HASH.test(records[0].launchBindingHash || '')) {
    fail('PROCESS_IDENTITY_INVALID', 'Grok broker has no unique bound process reservation')
  }
  const helperDeploymentBinding = cleanHelperDeploymentBinding(semantic.helperDeploymentBinding, semantic.helperDeploymentRoot)
  assertTrustedHelperDeployment(options.controlRoot, semantic.helperDeploymentRoot, helperDeploymentBinding, dependencies(options._dependencies))
  return recoverWindowsGrokSandbox({ controlRoot: options.controlRoot, brokerRequestPath: options.brokerRequestPath,
    helperDeploymentRoot: semantic.helperDeploymentRoot, processOwner: owner,
    binding: { ...binding, launchBindingHash: records[0].launchBindingHash }, _dependencies: options._dependencies })
}

module.exports = { GrokWindowsSandboxError, BROKER_BOOTSTRAP, prepareWindowsGrokSandbox, recoverWindowsGrokSandbox, recoverDiscoveredWindowsGrokSandbox, runBroker }
