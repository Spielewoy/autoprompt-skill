'use strict'

// The persistent policy belongs to one activation and one fresh local SID.
// Credentials are additionally held immutable by every owned Windows Job.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const cp = require('node:child_process')
const { atomicWriteJson, atomicCreateJson, readChecksummedJson } = require('./event-log.js')
const { inspectPathNoFollow, pathIsInside, ensureWindowsPrivateAcl, auditPrivatePermissions, windowsControllerEnvironment } = require('./safe-run-root.js')
const HELPER = path.join(__dirname, 'windows-codex-network-lease.ps1')
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
function fail(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined)
  error.code = 'WINDOWS_CODEX_NETWORK_LEASE_INVALID'
  throw error
}
function physical(file, directory = true) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.startsWith('\\\\')) fail('Local absolute lease paths required')
  const captured = inspectPathNoFollow(file, { mustBeDirectory: directory })
  if (!captured.exists) fail('Lease path is missing')
  if (!directory) {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2 * 1024 * 1024) fail('Lease file must be a bounded physical regular file')
  }
  return path.resolve(file)
}
function inputs(options, lease) {
  if (process.platform !== 'win32') fail('Windows Codex network lease requires Windows')
  const activationRoot = physical(options.activationRoot)
  const targetPath = physical(options.targetPath || options.target)
  const activationId = options.activationId
  if (typeof activationId !== 'string' || !/^apv2-[a-f0-9]{32}$/.test(activationId)) fail('Exact activation identity required')
  const codexHome = physical(options.codexHome || lease?.codexHome)
  if (!pathIsInside(activationRoot, codexHome)) fail('Codex home must belong to the activation')
  const usersPath = physical(path.join(codexHome, '.sandbox-secrets', 'sandbox_users.json'), false)
  const root = path.join(activationRoot, 'windows-network-lease')
  inspectPathNoFollow(root)
  const journalPath = path.join(root, 'lease.json')
  const systemRoot = options.controllerEnv?.SystemRoot || process.env.SystemRoot
  if (typeof systemRoot !== 'string' || !/^[A-Za-z]:\\Windows$/i.test(systemRoot)) fail('Trusted Windows system root required')
  return { activationRoot, activationId, targetPath, codexHome, usersPath, root, journalPath,
    powershell: path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    controllerEnv: options.controllerEnv || windowsControllerEnvironment(systemRoot) }
}
function invoke(input, record, mode, drained = false) {
  physical(HELPER, false)
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', HELPER, '-Mode', mode,
    '-AccountName', record.accountName, '-ActivationId', record.leaseId, '-JournalPath', record.wfpJournalPath,
    '-AccountJournalPath', record.accountJournalPath, '-UsersPath', input.usersPath, '-TargetPath', input.targetPath]
  if (record.sid) args.push('-Sid', record.sid)
  if (drained) args.push('-WorkerDrained')
  const result = cp.spawnSync(input.powershell, args, { env: input.controllerEnv, encoding: 'utf8', timeout: 90000, maxBuffer: 65536, windowsHide: true })
  if (result.error || result.status !== 0) fail(`Windows Codex lease ${mode} failed; resources and recovery journal retained`, result.error || new Error(String(result.stderr).slice(-4096)))
  try { return JSON.parse(result.stdout.trim()) } catch (error) { fail('Invalid Windows lease helper response', error) }
}
function load(input) {
  physical(input.root); auditPrivatePermissions(input.root, { recurse: false }); physical(input.journalPath, false)
  const record = readChecksummedJson(input.journalPath)
  if (record.schemaVersion !== 1 || record.purpose !== 'windows-codex-network-lease' || record.activationId !== input.activationId ||
      record.activationRoot !== input.activationRoot || record.codexHome !== input.codexHome || record.targetPath !== input.targetPath ||
      record.usersPath !== input.usersPath || record.journalPath !== input.journalPath || !/^[a-f0-9]{32}$/.test(record.leaseId) ||
      !/^apcodex_[a-f0-9]{12}$/.test(record.accountName) || record.helperSha256 !== digest(HELPER) ||
      record.accountJournalPath !== path.join(input.root, 'account.json') || record.wfpJournalPath !== path.join(input.root, 'wfp.json') ||
      record.preflightRegistryPath !== path.join(input.activationRoot, 'windows-preflight', 'registry.json') ||
      record.preflightControlRoot !== path.join(input.activationRoot, 'windows-preflight', 'control')) fail('Foreign Windows network lease journal')
  for (const [name, file] of [['activationRoot', input.activationRoot], ['targetPath', input.targetPath], ['codexHome', input.codexHome], ['root', input.root]]) {
    const current = inspectPathNoFollow(file).identity, expected = record.pathIdentities?.[name]
    if (!expected || current.dev !== expected.dev || current.ino !== expected.ino) fail('Lease directory identity changed')
  }
  return record
}
function accountRecord(record) {
  physical(record.accountJournalPath, false)
  const account = JSON.parse(fs.readFileSync(record.accountJournalPath, 'utf8'))
  if (account.schemaVersion !== 1 || account.leaseId !== record.leaseId || account.accountName !== record.accountName ||
      account.usersPath !== record.usersPath || account.targetPath !== record.targetPath ||
      (record.sid && account.sid !== record.sid)) fail('Foreign account recovery journal')
  return account
}
function readWindowsCodexNetworkLease(options) {
  const input = inputs(options, options.lease)
  if (!fs.existsSync(input.journalPath)) return null
  const record = load(input), account = accountRecord(record)
  return { ...record, sid: record.sid || account.sid, recoveryState: account.state }
}
function verifyWindowsCodexNetworkLease(options, supplied = options.lease) {
  const input = inputs(options, supplied), record = load(input)
  if (!supplied || supplied.leaseId !== record.leaseId || supplied.sid !== record.sid || supplied.usersSha256 !== record.usersSha256 ||
      supplied.accountName !== record.accountName || supplied.journalPath !== record.journalPath) fail('Windows network lease admission binding changed')
  if (options.allowReleased === true && ['RELEASED', 'RELEASING'].includes(record.state)) {
    return Object.freeze({ ...record, released: record.state === 'RELEASED', recoveryRequired: record.state === 'RELEASING' })
  }
  if (record.state !== 'READY' ||
      !/^S-1-5-21-(?:[0-9]+-){3}[0-9]+$/.test(record.sid) || !/^[a-f0-9]{64}$/.test(record.usersSha256) ||
      digest(input.usersPath) !== record.usersSha256) fail('Windows network lease admission binding changed')
  const account = accountRecord(record)
  if (account.state !== 'SEALED' || account.ownerSid !== record.ownerSid || JSON.stringify(account.groupSids) !== JSON.stringify(record.groupSids)) fail('Account recovery identity changed')
  const observed = invoke(input, record, 'AccountVerify')
  if (observed.sid !== record.sid || observed.ownerSid !== record.ownerSid || JSON.stringify(observed.groupSids) !== JSON.stringify(record.groupSids)) fail('Live account identity changed')
  physical(record.wfpJournalPath, false); physical(record.wfpJournalPath + '.install', false)
  if (digest(record.wfpJournalPath) !== record.wfpJournalSha256 || digest(record.wfpJournalPath + '.install') !== record.wfpReceiptSha256) fail('WFP recovery policy changed')
  const policy = invoke(input, record, 'Verify')
  if (!policy.verified || policy.removed) fail('WFP policy closure is unavailable')
  return Object.freeze({ ...record })
}
function ensureWindowsCodexNetworkLease(options) {
  const input = inputs(options, options.priorLease || options.lease)
  if (fs.existsSync(input.journalPath)) {
    const record = load(input)
    return verifyWindowsCodexNetworkLease(options, options.priorLease || options.lease || record)
  }
  if (fs.existsSync(input.root)) fail('Unjournaled Windows network lease root requires recovery')
  fs.mkdirSync(input.root, { mode: 0o700 }); ensureWindowsPrivateAcl(input.root); auditPrivatePermissions(input.root, { recurse: false })
  let record = { schemaVersion: 1, purpose: 'windows-codex-network-lease', state: 'PLANNED', activationId: input.activationId,
    activationRoot: input.activationRoot, codexHome: input.codexHome, targetPath: input.targetPath, usersPath: input.usersPath,
    leaseId: crypto.randomBytes(16).toString('hex'), accountName: `apcodex_${crypto.randomBytes(6).toString('hex')}`,
    sid: null, ownerSid: null, groupSids: [], usersSha256: null, journalPath: input.journalPath,
    accountJournalPath: path.join(input.root, 'account.json'), wfpJournalPath: path.join(input.root, 'wfp.json'), helperSha256: digest(HELPER),
    preflightRegistryPath: path.join(input.activationRoot, 'windows-preflight', 'registry.json'),
    preflightControlRoot: path.join(input.activationRoot, 'windows-preflight', 'control'),
    pathIdentities: Object.fromEntries(['activationRoot', 'targetPath', 'codexHome', 'root'].map(name => [name, inspectPathNoFollow(input[name]).identity])) }
  atomicCreateJson(input.journalPath, record)
  // Account state is written by the native helper before each mutation; no
  // credential or password appears in either recovery journal.
  const fd = fs.openSync(record.accountJournalPath, 'wx', 0o600)
  try { fs.writeFileSync(fd, JSON.stringify({ schemaVersion: 1, leaseId: record.leaseId, accountName: record.accountName, sid: null,
    ownerSid: null, groupSids: [], state: 'PLANNED', usersPath: input.usersPath, targetPath: input.targetPath })); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  const account = invoke(input, record, 'AccountCreate')
  record = { ...record, sid: account.sid, ownerSid: account.ownerSid, groupSids: account.groupSids, usersSha256: digest(input.usersPath), state: 'ACCOUNT_SEALED' }
  atomicWriteJson(input.journalPath, record)
  const policy = invoke(input, record, 'Install')
  if (!policy.verified || policy.removed) fail('Persistent WFP policy did not verify')
  record = { ...record, state: 'READY', wfpJournalSha256: digest(record.wfpJournalPath), wfpReceiptSha256: digest(record.wfpJournalPath + '.install') }
  atomicWriteJson(input.journalPath, record)
  return verifyWindowsCodexNetworkLease(options, record)
}
function cleanupWindowsCodexNetworkLease(options, supplied = options.lease) {
  if (options.permanent !== true) return { retained: true, removed: false }
  const input = inputs(options, supplied), record = load(input), account = accountRecord(record)
  if (!supplied || supplied.leaseId !== record.leaseId || typeof options.verifyDrain !== 'function') fail('Permanent cleanup requires independent Job drain authority')
  if (record.state === 'RELEASED') return { retained: true, removed: true, released: true, journalPath: input.journalPath }
  const bound = { ...record, sid: record.sid || account.sid }
  if (!bound.sid) fail('Account creation outcome is uncertain; retain recovery journal')
  // Fence runtime admission durably and prevent new account logons before the
  // controller establishes drain. Keep credentials and WFP intact throughout.
  atomicWriteJson(input.journalPath, { ...bound, state: 'RELEASING' })
  if (account.state !== 'DELETED') invoke(input, bound, 'AccountDisable')
  const evidence = options.verifyDrain()
  if (evidence && typeof evidence.then === 'function') fail('Cleanup requires synchronous drain verification')
  if (!evidence || evidence.schemaVersion !== 1 || evidence.activationId !== input.activationId ||
      evidence.preflight?.registryPath !== record.preflightRegistryPath || evidence.preflight?.controlRoot !== record.preflightControlRoot ||
      evidence.preflight?.drained !== true || !Array.isArray(evidence.supervisor) || evidence.supervisor.some(item => item.drained !== true ||
        typeof item.registryPath !== 'string' || typeof item.controlRoot !== 'string' || !pathIsInside(input.activationRoot, item.registryPath) ||
        !pathIsInside(input.activationRoot, item.controlRoot))) fail('Cleanup drain evidence is foreign')
  // The callback belongs to the controller and queries native owned Jobs. A
  // serialized drained flag alone is deliberately insufficient authority.
  if (account.state !== 'DELETED') invoke(input, bound, 'AccountDelete', true)
  if (fs.existsSync(record.wfpJournalPath)) invoke(input, bound, 'Remove', true)
  atomicWriteJson(input.journalPath, { ...record, sid: bound.sid, state: 'RELEASED' })
  return { retained: true, removed: true, released: true, journalPath: input.journalPath }
}
module.exports = { ensureWindowsCodexNetworkLease, verifyWindowsCodexNetworkLease, readWindowsCodexNetworkLease, cleanupWindowsCodexNetworkLease }
