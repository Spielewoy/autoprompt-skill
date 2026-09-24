'use strict'

// Controller-side projection for the Windows Grok launch.  This module only
// prepares the closed resource graph; the transport and native launcher own
// the actual process entry and recovery.
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const sandbox = require('./windows-sandbox.cjs')
const { ensureWindowsPrivateAcl, auditPrivatePermissions } = require('../../../agents/codex/workflow/safe-run-root.js')

const HASH = /^[a-f0-9]{64}$/u
const PINNED_VERSION = '1.0.13'
const fail = (code, message) => { throw Object.assign(new Error(message), { name: 'GrokWindowsLaunchError', code }) }
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const absolute = (value, label) => {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) fail('GROK_WINDOWS_LAUNCH_INVALID', `${label} is invalid`)
  return value
}
const physical = (value, label) => {
  absolute(value, label)
  let item, real
  try { item = fs.lstatSync(value); real = fs.realpathSync.native(value) } catch { fail('GROK_WINDOWS_LAUNCH_INVALID', `${label} is unavailable`) }
  const canonical = path.resolve(value)
  if (!item.isDirectory() || item.isSymbolicLink() || (process.platform === 'win32' ? real.toLowerCase() !== canonical.toLowerCase() : real !== canonical)) fail('GROK_WINDOWS_LAUNCH_INVALID', `${label} is not a physical directory`)
  return real
}
function mkdirPrivate(directory, label) {
  absolute(directory, label)
  let created = false
  try { fs.mkdirSync(directory, { mode: 0o700 }); created = true } catch (error) {
    if (error.code === 'ENOENT') {
      const parent = path.dirname(directory)
      if (parent === directory) fail('GROK_WINDOWS_LAUNCH_INVALID', `${label} parent is unavailable`)
      mkdirPrivate(parent, `${label} parent`)
      try { fs.mkdirSync(directory, { mode: 0o700 }); created = true } catch (retry) { if (retry.code !== 'EEXIST') throw retry }
    } else if (error.code !== 'EEXIST') throw error
  }
  try {
    // A reused lease directory can carry an active AppContainer ACE. Never
    // replace its DACL merely to re-establish controller ownership.
    if (created) ensureWindowsPrivateAcl(directory)
    auditPrivatePermissions(directory, { recurse: false })
  } catch (error) { fail('GROK_WINDOWS_LAUNCH_INVALID', `${label} is not controller-private: ${error.message}`) }
  return physical(directory, label)
}
function bound(file, label, maximumBytes = 512 * 1024 * 1024) {
  absolute(file, label)
  let fd
  try {
    const before = fs.lstatSync(file, { bigint: true })
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(maximumBytes)) fail('GROK_WINDOWS_LAUNCH_INVALID', `${label} is not one bounded physical file`)
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    const opened = fs.fstatSync(fd, { bigint: true })
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.mtimeNs !== before.mtimeNs || opened.ctimeNs !== before.ctimeNs) fail('GROK_WINDOWS_LAUNCH_IDENTITY_CHANGED', `${label} changed while opening`)
    const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd, { bigint: true }), named = fs.lstatSync(file, { bigint: true })
    if (bytes.length !== Number(opened.size) || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => after[key] !== opened[key]) ||
        !named.isFile() || named.isSymbolicLink() || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => named[key] !== opened[key])) fail('GROK_WINDOWS_LAUNCH_IDENTITY_CHANGED', `${label} changed while reading`)
    return Object.freeze({ path: fs.realpathSync.native(file), size: bytes.length, sha256: hash(bytes), identity: { dev: String(opened.dev), ino: String(opened.ino) } })
  } finally { if (fd !== undefined) fs.closeSync(fd) }
}
function copyExact(source, target) {
  const sourceBinding = bound(source, 'Node source')
  const existing = () => {
    const result = bound(target, 'private Node copy')
    try { auditPrivatePermissions(target, { recurse: false }) } catch { fail('GROK_WINDOWS_LAUNCH_INVALID', 'Existing private Node copy is not controller-private') }
    if (result.sha256 !== sourceBinding.sha256 || result.size !== sourceBinding.size) fail('GROK_WINDOWS_LAUNCH_IDENTITY_CHANGED', 'Existing private Node copy differs from the admitted source')
    return result
  }
  try { fs.lstatSync(target); return existing() } catch (error) { if (error.code !== 'ENOENT') throw error }
  mkdirPrivate(path.dirname(target), 'Node copy parent')
  let created = false
  try { fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL); created = true } catch (error) {
    // Another controller path won the exclusive publication race. Its DACL is
    // authority-bearing: verify it, never chmod or replace it.
    if (error.code === 'EEXIST') return existing()
    throw error
  }
  if (!created) fail('GROK_WINDOWS_LAUNCH_INVALID', 'Private Node copy was not published')
  try { fs.chmodSync(target, 0o700) } catch {}
  try { ensureWindowsPrivateAcl(target); auditPrivatePermissions(target, { recurse: false }) } catch (error) { fail('GROK_WINDOWS_LAUNCH_INVALID', `Private Node copy is not controller-private: ${error.message}`) }
  const copied = bound(target, 'private Node copy')
  if (copied.sha256 !== sourceBinding.sha256 || copied.size !== sourceBinding.size) fail('GROK_WINDOWS_LAUNCH_IDENTITY_CHANGED', 'Private Node copy differs from the admitted source')
  return copied
}
function packageRootFromExecutable(executable) {
  absolute(executable, 'Grok executable')
  if (path.basename(executable).toLowerCase() !== 'grok' || path.basename(path.dirname(executable)).toLowerCase() !== 'bin') fail('GROK_WINDOWS_LAUNCH_INVALID', 'Grok executable must be the official package bin/grok entrypoint')
  const root = physical(path.dirname(path.dirname(executable)), 'Grok package root')
  let manifest
  try { manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) } catch { fail('GROK_WINDOWS_LAUNCH_INVALID', 'Grok package manifest is unreadable') }
  if (!manifest || manifest.name !== '@xai-official/grok' || manifest.version !== PINNED_VERSION) fail('GROK_WINDOWS_LAUNCH_INVALID', 'Grok package is not the pinned official release')
  return root
}
function under(child, parent) { const rel = path.relative(parent, child); return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)) }
async function prepareSession(options = {}) {
  const platform = options.platform || process.platform
  if (platform !== 'win32') fail('GROK_WINDOWS_LAUNCH_INVALID', 'Windows Grok projection requires win32')
  const packageRoot = packageRootFromExecutable(options.grokExecutable)
  const sessionRoot = mkdirPrivate(options.sessionRoot, 'Grok session root')
  const launchRoot = mkdirPrivate(options.launchRoot, 'Grok launch root')
  if (!under(launchRoot, sessionRoot) || launchRoot === sessionRoot) fail('GROK_WINDOWS_LAUNCH_INVALID', 'Launch root must be a private child of the session root')
  const loader = options._dependencies?.workerLoader || require('../../../agents/codex/workflow/windows-worker-loader.js')
  if (![loader.captureWorkerTuple, loader.describeTuple, loader.revalidateTuple, loader.materializeTuple].every(fn => typeof fn === 'function')) fail('GROK_WINDOWS_LAUNCH_INVALID', 'Windows worker loader contract is unavailable')
  const tuple = await loader.captureWorkerTuple(), admitted = loader.describeTuple(tuple)
  if (!admitted || typeof admitted.identity !== 'string' || !/^[a-f0-9]{64}$/u.test(admitted.identity) ||
      typeof admitted.controllerSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(admitted.controllerSha256)) fail('GROK_WINDOWS_LAUNCH_INVALID', 'Windows worker tuple identity is invalid')
  loader.revalidateTuple(tuple)
  const sourceNode = options.nodeExecutable || process.execPath
  const brokerNodePath = path.join(sessionRoot, 'runtime', 'node.exe')
  const brokerNodeBinding = copyExact(sourceNode, brokerNodePath)
  if (brokerNodeBinding.sha256 !== admitted.controllerSha256) fail('GROK_WINDOWS_LAUNCH_IDENTITY_CHANGED', 'Broker Node differs from the admitted worker controller')
  loader.revalidateTuple(tuple)
  const privateRoots = Object.freeze({
    home: mkdirPrivate(path.join(sessionRoot, 'grok-home'), 'Grok home'),
    cwd: mkdirPrivate(path.join(launchRoot, 'grok-cwd'), 'Grok cwd'),
    scratch: mkdirPrivate(path.join(launchRoot, 'grok-scratch'), 'Grok scratch'),
    runtime: mkdirPrivate(path.join(launchRoot, 'grok-runtime'), 'Grok runtime'),
    skills: mkdirPrivate(path.join(sessionRoot, 'grok-home', 'skills'), 'Grok skills'),
    control: mkdirPrivate(path.join(launchRoot, 'broker-control'), 'Broker control root'),
    broker: mkdirPrivate(path.join(launchRoot, 'broker'), 'Broker cwd'),
  })
  const workerRoot = path.join(launchRoot, 'windows-worker')
  const workerRuntime = loader.materializeTuple(tuple, workerRoot)
  loader.revalidateTuple(tuple)
  if (!workerRuntime || workerRuntime.identity !== admitted.identity || typeof workerRuntime.node !== 'string') fail('GROK_WINDOWS_LAUNCH_IDENTITY_CHANGED', 'Materialized Windows worker differs from its admitted tuple')
  const nodeBinding = bound(workerRuntime.node, 'admitted Windows worker Node')
  const roots = Object.freeze({ ...privateRoots, worker: physical(workerRoot, 'Windows worker root') })
  return Object.freeze({ platform, architecture: options.architecture || process.arch, packageRoot, sessionRoot, launchRoot,
    workerIdentity: admitted.identity, nodeExecutable: nodeBinding.path, nodeExecutableSha256: nodeBinding.sha256,
    brokerNodeExecutable: brokerNodeBinding.path, brokerNodeSha256: brokerNodeBinding.sha256, privateRoots: roots,
    config: Object.freeze({ sessionHome: roots.home, runtimeProjection: Object.freeze({ platform: 'win32', nodeExecutable: nodeBinding.path, skillsPath: roots.skills, mcpPort: 19778 }) }) })
}
async function prepareLaunch(options = {}) {
  const { config, spec, sessionRoot, launchRoot, pipe, processOwner, binding } = options
  if (!config || !spec || !pipe || !processOwner || !binding) fail('GROK_WINDOWS_LAUNCH_INVALID', 'Launch projection fields are required')
  const session = options.session || { ...await prepareSession({ ...options, sessionRoot, launchRoot }), sessionRoot, launchRoot }
  if (session.sessionRoot !== sessionRoot || session.launchRoot !== launchRoot) fail('GROK_WINDOWS_LAUNCH_INVALID', 'Launch roots differ from prepared session')
  const roots = session.privateRoots
  if (config.sessionHome !== roots?.home || config.runtimeProjection?.nodeExecutable !== session.nodeExecutable ||
      config.runtimeProjection?.skillsPath !== roots.skills || config.runtimeProjection?.mcpPort !== 19778) fail('GROK_WINDOWS_LAUNCH_INVALID', 'Persistent Grok configuration does not match the prepared session')
  const configText = (value, label) => {
    if (typeof value !== 'string' || !value || value.includes('\0')) fail('GROK_WINDOWS_LAUNCH_INVALID', `${label} is invalid`)
    return value
  }
  // The authenticated native config, rather than the transient runner spec,
  // supplies every secret and worker policy field. `spec` is argv-only.
  const model = configText(config.model, 'Grok model')
  const relayToken = configText(config.relayToken, 'Grok relay token')
  const proxyToken = configText(config.proxyToken, 'Grok proxy token')
  if (!/^[a-f0-9]{64}$/u.test(relayToken) || !/^[a-f0-9]{64}$/u.test(proxyToken)) fail('GROK_WINDOWS_LAUNCH_INVALID', 'Grok capability token is invalid')
  if (!config.allowedMcpTools || typeof config.allowedMcpTools !== 'object' || Array.isArray(config.allowedMcpTools) || !Object.keys(config.allowedMcpTools).length ||
      Object.entries(config.allowedMcpTools).some(([name, tool]) => typeof name !== 'string' || !name || typeof tool !== 'string' || !tool) || !Array.isArray(config.issuedCalls)) fail('GROK_WINDOWS_LAUNCH_INVALID', 'Grok controller policy is invalid')
  const jsonEnvironment = (value, label) => {
    let text
    try { text = JSON.stringify(value) } catch { fail('GROK_WINDOWS_LAUNCH_INVALID', `${label} is not serializable`) }
    if (typeof text !== 'string' || Buffer.byteLength(text) > 4 * 1024 * 1024) fail('GROK_WINDOWS_LAUNCH_INVALID', `${label} exceeds its bound`)
    return text
  }
  const allowedMcpTools = jsonEnvironment(config.allowedMcpTools, 'Grok MCP policy')
  const issuedCalls = jsonEnvironment(config.issuedCalls, 'Grok issued-call history')
  const systemRoot = configText(config.systemRoot, 'Windows system root')
  const systemPath = configText(config.systemPath, 'Windows system path')
  if (!/^[A-Za-z]:\\Windows$/iu.test(systemRoot) || !/^[A-Za-z]:\\Windows\\System32$/iu.test(systemPath) || path.win32.dirname(systemPath).toLowerCase() !== systemRoot.toLowerCase()) fail('GROK_WINDOWS_LAUNCH_INVALID', 'Windows system environment is invalid')
  const workerEnvironment = {
    SystemRoot: systemRoot, HOME: roots.home, GROK_HOME: roots.home,
    AUTOPROMPT_GROK_MODEL: model, AUTOPROMPT_GROK_RELAY_TOKEN: relayToken, AUTOPROMPT_GROK_PROXY_TOKEN: proxyToken,
    AUTOPROMPT_GROK_PROXY_PORT: '19777', AUTOPROMPT_GROK_MCP_PORT: '19778', AUTOPROMPT_GROK_ALLOWED_MCP_TOOLS: allowedMcpTools,
    AUTOPROMPT_GROK_ISSUED_CALLS: issuedCalls, AUTOPROMPT_GROK_AUDIT_PATH: path.join(roots.scratch, 'audit.jsonl')
  }
  const brokerEnvironment = { SystemRoot: systemRoot, PATH: systemPath, TEMP: roots.scratch, TMP: roots.scratch }
  // The sandbox materializer consumes the source package projection.  Passing
  // its published descriptor here would make the broker re-materialize from a
  // non-package object and breaks persisted recovery closure validation.
  const runtime = { packageRoot: session.packageRoot, outputRoot: roots.runtime, architecture: session.architecture }
  const stage = options._dependencies?.stageWindowsHelperDeployment || require('../../../agents/codex/workflow/windows-helper-deployment.js').stageWindowsHelperDeployment
  let staged
  try {
    staged = stage(roots.control, { shortPrivateRoot: true })
    const sandboxOptions = { processOwner, binding, controlRoot: roots.control, helperDeploymentRoot: staged.root, helperDeploymentBinding: staged.cleanupBinding, brokerNodeExecutable: session.brokerNodeExecutable,
    brokerNodeSha256: session.brokerNodeSha256, brokerCwd: roots.broker, brokerEnvironment, nodeExecutable: session.nodeExecutable,
    nodeExecutableSha256: session.nodeExecutableSha256, nodeArgs: [], workerArgs: spec.argv, runtime, policy: { readOnly: false, targetPath: roots.cwd,
      scratchPath: roots.scratch, readableRoots: [roots.cwd, roots.scratch, roots.home], writableRoots: [roots.cwd, roots.scratch, roots.home] }, workerEnvironment,
    pipe, cancellationPath: path.join(roots.runtime, 'cancel'), timeoutMs: 300000, outputLimit: 1024 * 1024, _dependencies: options._dependencies }
    const prepare = options._dependencies?.prepareSandbox || sandbox.prepareWindowsGrokSandbox
    const prepared = await prepare(sandboxOptions)
    const cleanup = prepared.cleanup
    return Object.freeze({ ...prepared, cleanup: async () => { await cleanup(); staged.cleanup?.() } })
  } catch (error) {
    // A sandbox preparation error with recovery metadata still needs the exact
    // staged helper bytes for authenticated restoration. Retain that closure.
    if (!error?.recovery && !error?.cleanupFailure) {
      try { staged?.cleanup?.() } catch (cleanupError) { Object.defineProperty(error, 'cleanupFailure', { value: cleanupError }) }
    }
    throw error
  }
}
module.exports = { PINNED_VERSION, prepareSession, prepareLaunch, packageRootFromExecutable, copyExact }
