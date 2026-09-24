'use strict'

// Controller-only Darwin Grok projection. The launchd ProcessOwner supplies
// the retained FD3/FD4 listeners; this module snapshots only the exact runtime
// bytes needed by the default-deny Seatbelt worker.
const crypto = require('node:crypto')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const zlib = require('node:zlib')
const { buildDarwinGrokProfile } = require('./darwin-profile.cjs')
const { buildGrokInlineWorker } = require('./inline-worker-bundle.cjs')

const PINNED_VERSION = '1.0.13'
const MAX_RUNTIME_BYTES = 512 * 1024 * 1024
const MAX_COMPRESSED_BYTES = 128 * 1024 * 1024
const MACH_O_CPU = Object.freeze({ x64: 0x01000007, arm64: 0x0100000c })
const LISTENER_RECORD = '.grok-darwin-listeners.json'
const fail = (code, message) => { throw Object.assign(new Error(message), { name: 'GrokDarwinLaunchError', code }) }
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const under = (child, parent) => { const relative = path.relative(parent, child); return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) }

function absolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) fail('GROK_DARWIN_LAUNCH_INVALID', `${label} is invalid`)
  return path.resolve(value)
}
function physicalDirectory(directory, label) {
  const expected = absolute(directory, label)
  let stat, real
  try { stat = fs.lstatSync(expected); real = fs.realpathSync.native(expected) } catch { fail('GROK_DARWIN_LAUNCH_INVALID', `${label} is unavailable`) }
  if (!stat.isDirectory() || stat.isSymbolicLink() || real !== expected || stat.mode & 0o077 || typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    fail('GROK_DARWIN_LAUNCH_INVALID', `${label} is not one physical private directory`)
  }
  return real
}
function directoryBinding(directory, label) {
  const real = physicalDirectory(directory, label), stat = fs.lstatSync(real, { bigint: true })
  return Object.freeze({ path: real, identity: Object.freeze({ dev: String(stat.dev), ino: String(stat.ino), mode: Number(stat.mode) }) })
}
function revalidateDirectory(expected, label) {
  if (!exact(expected, ['path', 'identity']) || !exact(expected.identity, ['dev', 'ino', 'mode'])) fail('GROK_DARWIN_LAUNCH_INVALID', `${label} binding is invalid`)
  const current = directoryBinding(expected.path, label)
  if (current.identity.dev !== expected.identity.dev || current.identity.ino !== expected.identity.ino || current.identity.mode !== expected.identity.mode) fail('GROK_DARWIN_LAUNCH_IDENTITY_CHANGED', `${label} changed after session preparation`)
  return current
}
function privateDirectory(directory, label) {
  const expected = absolute(directory, label)
  try { fs.mkdirSync(expected, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
  return physicalDirectory(expected, label)
}
function assertPhysicalAncestry(file, label) {
  const expected = absolute(file, label)
  try {
    if (fs.realpathSync.native(expected) !== expected) fail('GROK_DARWIN_LAUNCH_INVALID', `${label} is not canonical`)
    for (let cursor = expected; ; cursor = path.dirname(cursor)) {
      const stat = fs.lstatSync(cursor)
      if (stat.isSymbolicLink() || cursor !== expected && !stat.isDirectory()) fail('GROK_DARWIN_LAUNCH_INVALID', `${label} ancestry is not physical`)
      if (cursor === path.parse(cursor).root) break
    }
  } catch (error) { if (error?.code?.startsWith?.('GROK_')) throw error; fail('GROK_DARWIN_LAUNCH_INVALID', `${label} is unavailable`) }
  return expected
}
function boundFile(file, label, maximumBytes = MAX_RUNTIME_BYTES, executable = false) {
  const expected = assertPhysicalAncestry(file, label)
  let descriptor
  try {
    const before = fs.lstatSync(expected, { bigint: true })
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(maximumBytes) || before.mode & 0o022n || executable && !(before.mode & 0o111n)) fail('GROK_DARWIN_LAUNCH_INVALID', `${label} is not one bounded physical file`)
    descriptor = fs.openSync(expected, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    const opened = fs.fstatSync(descriptor, { bigint: true })
    if (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => opened[key] !== before[key])) fail('GROK_DARWIN_LAUNCH_IDENTITY_CHANGED', `${label} changed while opening`)
    const bytes = fs.readFileSync(descriptor), after = fs.fstatSync(descriptor, { bigint: true }), named = fs.lstatSync(expected, { bigint: true })
    if (bytes.length !== Number(opened.size) || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => after[key] !== opened[key] || named[key] !== opened[key])) {
      fail('GROK_DARWIN_LAUNCH_IDENTITY_CHANGED', `${label} changed while reading`)
    }
    return Object.freeze({ path: expected, size: bytes.length, sha256: sha256(bytes), mode: Number(opened.mode), identity: Object.freeze({ dev: String(opened.dev), ino: String(opened.ino) }), bytes })
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor) }
}
function publicBinding(binding) { return Object.freeze({ path: binding.path, size: binding.size, sha256: binding.sha256, mode: binding.mode, identity: binding.identity }) }
function sameBinding(left, right) { return left.path === right.path && left.size === right.size && left.sha256 === right.sha256 && left.mode === right.mode && left.identity.dev === right.identity.dev && left.identity.ino === right.identity.ino }
function revalidateBinding(expected, label) {
  const current = publicBinding(boundFile(expected.path, label, MAX_RUNTIME_BYTES, true))
  if (!sameBinding(current, expected)) fail('GROK_DARWIN_LAUNCH_IDENTITY_CHANGED', `${label} changed after session preparation`)
  return current
}
function copySnapshot(source, target, label) {
  const admitted = boundFile(source, `${label} source`, MAX_RUNTIME_BYTES, true)
  let existed = false
  try { fs.lstatSync(target); existed = true } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (!existed) {
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL)
    fs.chmodSync(target, 0o500)
  }
  const copied = boundFile(target, `private ${label}`, MAX_RUNTIME_BYTES, true)
  const sourceAfter = boundFile(source, `${label} source`, MAX_RUNTIME_BYTES, true)
  if (copied.sha256 !== admitted.sha256 || copied.size !== admitted.size || !sameBinding(admitted, sourceAfter)) {
    fail('GROK_DARWIN_LAUNCH_IDENTITY_CHANGED', `Private ${label} differs from its admitted source`)
  }
  return publicBinding(copied)
}
function parseMachO(bytes, architecture) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 40 || bytes.length > MAX_RUNTIME_BYTES || bytes.readUInt32LE(0) !== 0xfeedfacf ||
      bytes.readUInt32LE(4) !== MACH_O_CPU[architecture] || bytes.readUInt32LE(12) !== 2) fail('GROK_DARWIN_LAUNCH_INVALID', 'Official Grok payload is not a thin 64-bit Mach-O executable for this architecture')
  const commands = bytes.readUInt32LE(16), commandBytes = bytes.readUInt32LE(20)
  if (commands < 1 || commands > 4096 || commandBytes < 8 || commandBytes > bytes.length - 32 || bytes.readUInt32LE(32) === 0 || bytes.readUInt32LE(36) < 8 || bytes.readUInt32LE(36) > commandBytes) {
    fail('GROK_DARWIN_LAUNCH_INVALID', 'Official Grok Mach-O load-command header is invalid')
  }
  return architecture
}
function publishExecutable(file, bytes) {
  const temporary = `${file}.tmp-${crypto.randomBytes(8).toString('hex')}`
  let descriptor
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o500)
    let offset = 0
    while (offset < bytes.length) offset += fs.writeSync(descriptor, bytes, offset, bytes.length - offset)
    fs.fsyncSync(descriptor); fs.closeSync(descriptor); descriptor = undefined
    fs.linkSync(temporary, file)
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    try { fs.unlinkSync(temporary) } catch {}
  }
}
function materializeGrok(compressed, target, architecture) {
  const admitted = boundFile(compressed, 'compressed Grok source', MAX_COMPRESSED_BYTES)
  let bytes
  try { bytes = zlib.brotliDecompressSync(admitted.bytes, { maxOutputLength: MAX_RUNTIME_BYTES }) }
  catch { fail('GROK_DARWIN_LAUNCH_INVALID', 'Official Grok payload could not be decompressed within its bound') }
  parseMachO(bytes, architecture)
  let exists = false
  try { fs.lstatSync(target); exists = true } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (!exists) {
    try { publishExecutable(target, bytes) } catch (error) { if (error.code !== 'EEXIST') throw error }
  }
  const output = boundFile(target, 'private Grok executable', MAX_RUNTIME_BYTES, true)
  const sourceAfter = boundFile(compressed, 'compressed Grok source', MAX_COMPRESSED_BYTES)
  if (!sameBinding(admitted, sourceAfter) || output.sha256 !== sha256(bytes) || output.size !== bytes.length) fail('GROK_DARWIN_LAUNCH_IDENTITY_CHANGED', 'Private Grok executable differs from its official compressed source')
  parseMachO(output.bytes, architecture)
  return publicBinding(output)
}
function manifest(root, expectedName, architecture, wrapper) {
  const record = boundFile(path.join(root, 'package.json'), `${expectedName} manifest`, 128 * 1024)
  let value
  try { value = JSON.parse(record.bytes.toString('utf8')) } catch { fail('GROK_DARWIN_LAUNCH_INVALID', `${expectedName} manifest is invalid`) }
  if (!value || value.name !== expectedName || value.version !== PINNED_VERSION) fail('GROK_DARWIN_LAUNCH_INVALID', `${expectedName} is not the pinned release`)
  if (wrapper) {
    if (value.bin?.grok !== 'bin/grok' || value.optionalDependencies?.[`@xai-official/grok-darwin-${architecture}`] !== PINNED_VERSION) fail('GROK_DARWIN_LAUNCH_INVALID', 'Official Grok wrapper manifest is incompatible')
  } else if (!Array.isArray(value.os) || !value.os.includes('darwin') || !Array.isArray(value.cpu) || !value.cpu.includes(architecture)) {
    fail('GROK_DARWIN_LAUNCH_INVALID', 'Official Grok Darwin package targets another platform')
  }
  return value
}
function packageRuntime(grokExecutable, architecture) {
  const executable = assertPhysicalAncestry(grokExecutable, 'Grok wrapper executable')
  if (path.basename(executable) !== 'grok' || path.basename(path.dirname(executable)) !== 'bin') fail('GROK_DARWIN_LAUNCH_INVALID', 'Grok executable must be the official bin/grok entrypoint')
  const wrapper = boundFile(executable, 'Grok wrapper executable', 4 * 1024 * 1024, true)
  if (!wrapper.bytes.subarray(0, 20).toString('utf8').startsWith('#!/usr/bin/env node')) fail('GROK_DARWIN_LAUNCH_INVALID', 'Official Grok wrapper entrypoint is invalid')
  const packageRoot = path.dirname(path.dirname(executable))
  manifest(packageRoot, '@xai-official/grok', architecture, true)
  const platformName = `grok-darwin-${architecture}`
  const platformRoot = path.join(path.dirname(packageRoot), platformName)
  try { if (fs.realpathSync.native(platformRoot) !== platformRoot) fail('GROK_DARWIN_LAUNCH_INVALID', 'Official Grok Darwin package is not physical') }
  catch (error) { if (error?.code?.startsWith?.('GROK_')) throw error; fail('GROK_DARWIN_LAUNCH_INVALID', 'Official Grok Darwin package is unavailable') }
  manifest(platformRoot, `@xai-official/${platformName}`, architecture, false)
  const compressed = path.join(platformRoot, 'bin', 'grok.br')
  boundFile(compressed, 'compressed Grok Darwin payload', MAX_COMPRESSED_BYTES)
  return Object.freeze({ packageRoot, platformRoot, compressed })
}
const close = server => new Promise(resolve => server.close(resolve))
async function reserveListeners(expected = null) {
  const proxy = net.createServer(), mcp = net.createServer()
  try {
    const listenPort = (server, port) => new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen({ host: '::1', port, ipv6Only: true, exclusive: true }, () => {
        server.off('error', reject)
        const address = server.address()
        if (!address || typeof address === 'string' || address.address !== '::1' || address.family !== 'IPv6' || address.port < 1024) return reject(new Error('invalid IPv6 reservation'))
        resolve(address.port)
      })
    })
    const proxyPort = await listenPort(proxy, expected?.proxyPort || 0), mcpPort = await listenPort(mcp, expected?.mcpPort || 0)
    if (proxyPort === mcpPort) fail('GROK_DARWIN_LAUNCH_INVALID', 'Darwin listener reservations collided')
    await Promise.all([close(proxy), close(mcp)])
    return Object.freeze({ proxyPort, mcpPort })
  } catch (error) {
    try { if (proxy.listening) await close(proxy) } catch {}
    try { if (mcp.listening) await close(mcp) } catch {}
    if (error?.code?.startsWith?.('GROK_')) throw error
    fail(expected ? 'GROK_DARWIN_LISTENER_UNAVAILABLE' : 'GROK_DARWIN_LAUNCH_INVALID', `Darwin IPv6 listener reservation failed: ${error.code || 'unavailable'}`)
  }
}
function listenerRecord(recordPath, sessionBinding) {
  const record = boundFile(recordPath, 'Darwin listener record', 1024)
  let value
  try { value = JSON.parse(record.bytes.toString('utf8')) } catch { fail('GROK_DARWIN_LAUNCH_INVALID', 'Darwin listener record is invalid') }
  if (!exact(value, ['schemaVersion', 'sessionIdentity', 'proxyPort', 'mcpPort']) || value.schemaVersion !== 1 || !exact(value.sessionIdentity, ['dev', 'ino']) ||
      value.sessionIdentity.dev !== sessionBinding.identity.dev || value.sessionIdentity.ino !== sessionBinding.identity.ino || record.mode !== 0o100400 ||
      ![value.proxyPort, value.mcpPort].every(port => Number.isSafeInteger(port) && port >= 1024 && port <= 65535) || value.proxyPort === value.mcpPort) fail('GROK_DARWIN_LAUNCH_INVALID', 'Darwin listener record differs from its private session')
  return Object.freeze({ proxyPort: value.proxyPort, mcpPort: value.mcpPort })
}
function publishListenerRecord(recordPath, sessionBinding, ports) {
  const bytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1, sessionIdentity: { dev: sessionBinding.identity.dev, ino: sessionBinding.identity.ino }, proxyPort: ports.proxyPort, mcpPort: ports.mcpPort })}\n`)
  let descriptor
  try {
    descriptor = fs.openSync(recordPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o400)
    fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor)
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor) }
  return listenerRecord(recordPath, sessionBinding)
}
async function sessionListeners(sessionRoot, reserve) {
  const sessionBinding = directoryBinding(sessionRoot, 'Grok session root'), recordPath = path.join(sessionRoot, LISTENER_RECORD)
  let exists = false
  try { fs.lstatSync(recordPath); exists = true } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (exists) {
    const recorded = listenerRecord(recordPath, sessionBinding)
    const verified = await reserve(recorded)
    if (verified.proxyPort !== recorded.proxyPort || verified.mcpPort !== recorded.mcpPort) fail('GROK_DARWIN_LISTENER_UNAVAILABLE', 'Darwin listener verifier changed the recorded ports')
    return recorded
  }
  const fresh = await reserve()
  try { return publishListenerRecord(recordPath, sessionBinding, fresh) }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    const recorded = listenerRecord(recordPath, sessionBinding), verified = await reserve(recorded)
    if (verified.proxyPort !== recorded.proxyPort || verified.mcpPort !== recorded.mcpPort) fail('GROK_DARWIN_LISTENER_UNAVAILABLE', 'Darwin listener verifier changed the recorded ports')
    return recorded
  }
}
function jsonValue(value, label) {
  let text
  try { text = JSON.stringify(value) } catch { fail('GROK_DARWIN_LAUNCH_INVALID', `${label} is not serializable`) }
  if (typeof text !== 'string' || Buffer.byteLength(text) > 4 * 1024 * 1024) fail('GROK_DARWIN_LAUNCH_INVALID', `${label} exceeds its bound`)
  return text
}
function text(value, label) { if (typeof value !== 'string' || !value || value.includes('\0')) fail('GROK_DARWIN_LAUNCH_INVALID', `${label} is invalid`); return value }

async function prepareSession(options = {}) {
  const platform = options._dependencies?.platform || process.platform
  if (platform !== 'darwin') fail('GROK_DARWIN_LAUNCH_INVALID', 'Darwin Grok projection requires macOS')
  const architecture = options.architecture || process.arch
  if (!['x64', 'arm64'].includes(architecture) || architecture !== process.arch) fail('GROK_DARWIN_LAUNCH_INVALID', 'Darwin Grok architecture differs from the controller')
  const runtime = packageRuntime(options.grokExecutable, architecture)
  const sessionRoot = privateDirectory(options.sessionRoot, 'Grok session root')
  const launchRoot = privateDirectory(options.launchRoot, 'Grok launch root')
  if (!under(launchRoot, sessionRoot)) fail('GROK_DARWIN_LAUNCH_INVALID', 'Launch root must be a private child of the session root')
  const roots = Object.freeze({
    home: privateDirectory(path.join(sessionRoot, 'grok-home'), 'Grok home'),
    skills: privateDirectory(path.join(sessionRoot, 'grok-home', 'skills'), 'Grok skills'),
    cwd: privateDirectory(path.join(launchRoot, 'grok-cwd'), 'Grok cwd'),
    scratch: privateDirectory(path.join(launchRoot, 'grok-scratch'), 'Grok scratch'),
    runtime: privateDirectory(path.join(sessionRoot, 'grok-runtime'), 'Grok runtime'),
  })
  const node = copySnapshot(options.nodeExecutable || process.execPath, path.join(roots.runtime, 'node'), 'Node executable')
  const grok = materializeGrok(runtime.compressed, path.join(roots.runtime, 'grok'), architecture)
  const ports = await sessionListeners(sessionRoot, options._dependencies?.reserveListeners || reserveListeners)
  if (!exact(ports, ['proxyPort', 'mcpPort']) || ![ports.proxyPort, ports.mcpPort].every(value => Number.isSafeInteger(value) && value >= 1024 && value <= 65535) || ports.proxyPort === ports.mcpPort) fail('GROK_DARWIN_LAUNCH_INVALID', 'Darwin listener reservation is invalid')
  const darwinListeners = Object.freeze({ proxy: Object.freeze({ fd: 3, host: '::1', port: ports.proxyPort }), mcp: Object.freeze({ fd: 4, host: '::1', port: ports.mcpPort }) })
  const runtimeBindings = Object.freeze({ node, grok })
  const privateRootBindings = Object.freeze({ session: directoryBinding(sessionRoot, 'Grok session root'), launch: directoryBinding(launchRoot, 'Grok launch root'),
    ...Object.fromEntries(Object.entries(roots).map(([name, root]) => [name, directoryBinding(root, `Grok ${name} root`)])) })
  return Object.freeze({ platform, architecture, packageRoot: runtime.packageRoot, sessionRoot, launchRoot, privateRoots: roots, privateRootBindings, runtimeBindings,
    nodeExecutable: node.path, nodeExecutableSha256: node.sha256, grokExecutable: grok.path, grokExecutableSha256: grok.sha256, darwinListeners,
    config: Object.freeze({ sessionHome: roots.home, runtimeProjection: Object.freeze({ platform: 'darwin', nodeExecutable: node.path, skillsPath: roots.skills, proxyPort: ports.proxyPort, mcpPort: ports.mcpPort }) }) })
}

async function prepareLaunch(options = {}) {
  const { session, sessionRoot, launchRoot, config, spec, pipe } = options
  if (!session || session.platform !== 'darwin' || session.sessionRoot !== sessionRoot || session.launchRoot !== launchRoot || !config || !spec ||
      !exact(pipe, ['socketPath']) || typeof pipe.socketPath !== 'string' || !path.isAbsolute(pipe.socketPath) || pipe.socketPath.includes('\0')) fail('GROK_DARWIN_LAUNCH_INVALID', 'Darwin Grok launch projection is invalid')
  const roots = session.privateRoots, projection = config.runtimeProjection, listeners = session.darwinListeners
  if (config.sessionHome !== roots.home || !exact(projection, ['platform', 'nodeExecutable', 'skillsPath', 'proxyPort', 'mcpPort']) || projection.platform !== 'darwin' || projection.nodeExecutable !== session.nodeExecutable || projection.skillsPath !== roots.skills ||
      !exact(listeners, ['proxy', 'mcp']) || !exact(listeners.proxy, ['fd', 'host', 'port']) || !exact(listeners.mcp, ['fd', 'host', 'port']) || listeners.proxy.fd !== 3 || listeners.mcp.fd !== 4 || listeners.proxy.host !== '::1' || listeners.mcp.host !== '::1' ||
      projection.proxyPort !== session.darwinListeners.proxy.port || projection.mcpPort !== session.darwinListeners.mcp.port || !Array.isArray(spec.argv) || spec.argv.some(value => typeof value !== 'string' || value.includes('\0'))) fail('GROK_DARWIN_LAUNCH_INVALID', 'Darwin Grok session configuration changed')
  if (!exact(session.runtimeBindings, ['node', 'grok']) || session.runtimeBindings.node.path !== session.nodeExecutable || session.runtimeBindings.grok.path !== session.grokExecutable) fail('GROK_DARWIN_LAUNCH_INVALID', 'Darwin Grok runtime bindings are unavailable')
  if (!exact(session.privateRootBindings, ['session', 'launch', 'home', 'skills', 'cwd', 'scratch', 'runtime'])) fail('GROK_DARWIN_LAUNCH_INVALID', 'Darwin Grok private-root bindings are unavailable')
  for (const [name, binding] of Object.entries(session.privateRootBindings)) {
    const expectedPath = name === 'session' ? sessionRoot : name === 'launch' ? launchRoot : roots[name]
    if (binding.path !== expectedPath) fail('GROK_DARWIN_LAUNCH_INVALID', 'Darwin Grok private-root binding changed')
    revalidateDirectory(binding, `Grok ${name} root`)
  }
  revalidateBinding(session.runtimeBindings.node, 'private Node executable')
  revalidateBinding(session.runtimeBindings.grok, 'private Grok executable')
  const model = text(config.model, 'Grok model'), relayToken = text(config.relayToken, 'Grok relay token'), proxyToken = text(config.proxyToken, 'Grok proxy token')
  if (!/^[a-f0-9]{64}$/u.test(relayToken) || !/^[a-f0-9]{64}$/u.test(proxyToken) || !config.allowedMcpTools || typeof config.allowedMcpTools !== 'object' || Array.isArray(config.allowedMcpTools) || !Object.keys(config.allowedMcpTools).length ||
      Object.entries(config.allowedMcpTools).some(([name, tool]) => typeof name !== 'string' || !name || typeof tool !== 'string' || !tool) || !Array.isArray(config.issuedCalls)) fail('GROK_DARWIN_LAUNCH_INVALID', 'Grok controller policy is invalid')
  const worker = (options._dependencies?.buildWorker || buildGrokInlineWorker)({ nodeExecutable: session.nodeExecutable, nodeArgs: [], workerArgs: spec.argv })
  const profileText = (options._dependencies?.buildProfile || buildDarwinGrokProfile)({ nodeExecutable: session.nodeExecutable, grokExecutable: session.grokExecutable,
    home: roots.home, cwd: roots.cwd, scratch: roots.scratch, proxyPort: projection.proxyPort, mcpPort: projection.mcpPort })
  const env = Object.freeze({
    HOME: roots.home, GROK_HOME: roots.home, XDG_CONFIG_HOME: path.join(roots.home, 'config'), XDG_DATA_HOME: path.join(roots.home, 'data'), XDG_STATE_HOME: path.join(roots.home, 'state'), XDG_CACHE_HOME: path.join(roots.home, 'cache'), TMPDIR: roots.scratch,
    AUTOPROMPT_GROK_EXECUTABLE: session.grokExecutable, AUTOPROMPT_GROK_CWD: roots.cwd, AUTOPROMPT_GROK_MODEL: model,
    AUTOPROMPT_GROK_RELAY_TOKEN: relayToken, AUTOPROMPT_GROK_PROXY_TOKEN: proxyToken, AUTOPROMPT_GROK_RELAY_FD: '0',
    AUTOPROMPT_GROK_PROXY_LISTENER_FD: '3', AUTOPROMPT_GROK_MCP_LISTENER_FD: '4', AUTOPROMPT_GROK_PROXY_PORT: String(projection.proxyPort), AUTOPROMPT_GROK_MCP_PORT: String(projection.mcpPort),
    AUTOPROMPT_GROK_ALLOWED_MCP_TOOLS: jsonValue(config.allowedMcpTools, 'Grok MCP policy'), AUTOPROMPT_GROK_ISSUED_CALLS: jsonValue(config.issuedCalls, 'Grok issued-call history'), AUTOPROMPT_GROK_AUDIT_PATH: path.join(roots.scratch, 'audit.jsonl'),
  })
  return Object.freeze({ relayStdin: Object.freeze({ socketPath: pipe.socketPath }), darwinListeners: session.darwinListeners, cleanup: async () => {},
    launch: Object.freeze({ executable: '/usr/bin/sandbox-exec', argv: Object.freeze(['-p', profileText, session.nodeExecutable, ...worker.argv]), cwd: roots.cwd, env }) })
}

module.exports = { PINNED_VERSION, prepareSession, prepareLaunch }
