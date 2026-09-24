'use strict'

// These are controller-owned tools, not permissions delegated to an LLM. Native
// transports must disable their built-ins and expose only this bounded surface.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const cp = require('node:child_process')
const { readBound, writePrivate, privateDirectory, sha256 } = require('../agents/reasonix/workflow/native.js')
const { BoundaryError, OUTPUT_LIMIT, TOOLS, validateArguments } = require('./harness-v2-bridge/grok/tool-schema.cjs')
const PROVIDERS = new Set(['claude', 'opencode', 'kilo', 'prime', 'omp', 'deepseek', 'vscode', 'reasonix', 'hermes', 'grok'])
function fail(code, message) { throw new BoundaryError(code, message) }
function canonicalJson(value) {
  const order = item => Array.isArray(item) ? item.map(order) : item && typeof item === 'object'
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, order(item[key])])) : item
  return JSON.stringify(order(value))
}
function within(root, file) {
  const relative = path.relative(root, file)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}
function physical(file, options = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')) fail('TOOL_PATH_INVALID', 'An absolute physical path is required')
  const normalized = path.resolve(file)
  let cursor = path.parse(normalized).root
  const parts = path.relative(cursor, normalized).split(path.sep).filter(Boolean)
  for (let index = 0; index < parts.length; index++) {
    cursor = path.join(cursor, parts[index])
    let stat
    try { stat = fs.lstatSync(cursor) }
    catch (error) {
      if (options.missingLeaf && index === parts.length - 1 && error.code === 'ENOENT') return normalized
      throw error
    }
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1)) {
      fail('TOOL_PATH_DENIED', 'Linked or non-regular task resources are not authorized')
    }
    if (index !== parts.length - 1 && !stat.isDirectory()) fail('TOOL_PATH_INVALID', 'A path ancestor is not a directory')
  }
  return normalized
}
function directory(file) {
  const result = physical(file)
  if (result === path.parse(result).root || !fs.statSync(result).isDirectory()) fail('TOOL_POLICY_INVALID', 'Task roots must be physical directories below the filesystem root')
  return result
}
function ownedDirectory(file) {
  const root = directory(file), stat = fs.lstatSync(root)
  if (process.platform !== 'win32' && ((stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid()))) {
    fail('TOOL_POLICY_INVALID', 'Controller state requires an owned private directory')
  }
  return root
}
function validatePolicy(input) {
  const allowed = new Set(['schemaVersion', 'provider', 'activationId', 'generation', 'sessionId', 'reservationId', 'readOnly',
    'targetPath', 'scratchPath', 'readableRoots', 'writableRoots', 'nestedDispatch', 'commandBoundary', 'externalWrites', 'toolFree', 'darwinCommandOwner', 'windowsControllerNode'])
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.has(key)) ||
      !PROVIDERS.has(input.provider) || typeof input.readOnly !== 'boolean' || input.nestedDispatch !== false ||
      input.commandBoundary !== true || input.externalWrites !== false ||
      (input.toolFree !== undefined && typeof input.toolFree !== 'boolean') ||
      (input.schemaVersion !== undefined && input.schemaVersion !== 1)) fail('TOOL_POLICY_INVALID', 'Invalid controller tool policy')
  if (input.darwinCommandOwner !== undefined) {
    const owner = input.darwinCommandOwner
    if (!owner || typeof owner !== 'object' || Array.isArray(owner) ||
        Object.keys(owner).sort().join(',') !== 'controlRoot,manifestRoot,nodeExecutable,providerPrivateOwnershipRoot,registryPath,schemaVersion,stateRoot' ||
        owner.schemaVersion !== 1 || ['manifestRoot', 'providerPrivateOwnershipRoot', 'stateRoot', 'registryPath', 'controlRoot'].some(key => typeof owner[key] !== 'string' || !path.isAbsolute(owner[key]) || owner[key].includes('\0'))) {
      fail('TOOL_POLICY_INVALID', 'Invalid Darwin command ownership descriptor')
    }
    if (!owner.nodeExecutable || Object.keys(owner.nodeExecutable).sort().join(',') !== 'path,sha256' ||
        typeof owner.nodeExecutable.path !== 'string' || !path.isAbsolute(owner.nodeExecutable.path) || owner.nodeExecutable.path.includes('\0') ||
        !/^[a-f0-9]{64}$/.test(owner.nodeExecutable.sha256 || '')) fail('TOOL_POLICY_INVALID', 'Invalid Darwin controller Node binding')
  }
  if (input.windowsControllerNode !== undefined) {
    if (process.platform !== 'win32') fail('TOOL_POLICY_INVALID', 'Windows controller Node binding is not valid on this platform')
    const node = input.windowsControllerNode
    if (!node || typeof node !== 'object' || Array.isArray(node) || Object.keys(node).sort().join(',') !== 'path,sha256' ||
        typeof node.path !== 'string' || !path.isAbsolute(node.path) || node.path.includes('\0') || !/^[a-f0-9]{64}$/.test(node.sha256 || '')) {
      fail('TOOL_POLICY_INVALID', 'Invalid Windows controller Node binding')
    }
  }
  for (const key of ['activationId', 'sessionId', 'reservationId']) if (input[key] !== undefined &&
      (typeof input[key] !== 'string' || !input[key] || input[key].length > 512 || input[key].includes('\0'))) fail('TOOL_POLICY_INVALID', 'Invalid tool policy identity')
  if (input.generation !== undefined && (!Number.isSafeInteger(input.generation) || input.generation < 1)) fail('TOOL_POLICY_INVALID', 'Invalid tool policy generation')
  const targetPath = directory(input.targetPath)
  const scratchPath = input.scratchPath ? directory(input.scratchPath) : null
  if (scratchPath && (within(targetPath, scratchPath) || within(scratchPath, targetPath))) fail('TOOL_POLICY_INVALID', 'Checker scratch must be physically disjoint from the candidate')
  const roots = key => {
    if (!Array.isArray(input[key]) || input[key].length > 32 || (key === 'readableRoots' && !input[key].length)) fail('TOOL_POLICY_INVALID', 'Explicit bounded tool roots are required')
    return [...new Set(input[key].map(directory))].sort()
  }
  const readableRoots = roots('readableRoots'), writableRoots = roots('writableRoots')
  const contains = file => within(targetPath, file) || (scratchPath && within(scratchPath, file))
  if ([...readableRoots, ...writableRoots].some(file => !contains(file)) ||
      writableRoots.some(file => !readableRoots.some(root => within(root, file))) ||
      (input.readOnly && writableRoots.some(file => !scratchPath || !within(scratchPath, file) || within(targetPath, file)))) {
    fail('TOOL_POLICY_INVALID', 'Tool roots expand beyond their controller assignment')
  }
  return { ...input, schemaVersion: 1, targetPath, ...(scratchPath ? { scratchPath } : {}), readableRoots, writableRoots }
}
function authorize(policy, file, write = false) {
  const absolute = physical(path.isAbsolute(file) ? file : path.resolve(policy.targetPath, file), { missingLeaf: write })
  const roots = write ? policy.writableRoots : policy.readableRoots
  if (!roots.some(root => within(root, absolute))) fail('TOOL_PATH_DENIED', write ? 'This path is not writable by the assigned role' : 'This path is outside the assigned readable roots')
  if (write && roots.some(root => within(root, absolute) && path.relative(root, absolute).split(path.sep).includes('.git'))) fail('TOOL_PATH_DENIED', 'The controller owns repository safety metadata')
  return absolute
}
function readText(file) {
  const stat = fs.statSync(file)
  if (!stat.isFile() || stat.size > 4 * OUTPUT_LIMIT) fail('TOOL_OUTPUT_LIMIT', 'File is not a bounded text resource')
  const bytes = readBound(file)
  const decoder = new TextDecoder('utf-8', { fatal: true })
  try { return decoder.decode(bytes) } catch { fail('TOOL_ARGUMENTS_INVALID', 'This text tool does not decode binary files') }
}
function atomicWrite(policy, file, content) {
  const target = authorize(policy, file, true), parent = physical(path.dirname(target))
  const mode = fs.existsSync(target) ? fs.lstatSync(target).mode & 0o777 : 0o600
  const temporary = path.join(parent, `.autoprompt-write-${crypto.randomUUID()}`)
  try {
    fs.writeFileSync(temporary, content, { flag: 'wx', mode })
    authorize(policy, target, true); physical(parent)
    fs.renameSync(temporary, target)
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary) }
  return { path: target, bytesWritten: Buffer.byteLength(content) }
}
function safeEnvironment() {
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot
    if (typeof systemRoot !== 'string' || !/^[A-Za-z]:\\Windows$/i.test(systemRoot)) fail('COMMAND_SANDBOX_UNSUPPORTED', 'Windows system root is unavailable')
    return { SystemRoot: systemRoot, WINDIR: systemRoot, SystemDrive: systemRoot.slice(0, 2),
      PATH: [path.dirname(process.execPath), path.join(systemRoot, 'System32')].join(path.delimiter),
      ComSpec: path.join(systemRoot, 'System32', 'cmd.exe'), PATHEXT: '.COM;.EXE;.BAT;.CMD', LOCALAPPDATA: process.env.LOCALAPPDATA || '',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ALLOW_PROTOCOL: '', GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: 'push.default', GIT_CONFIG_VALUE_0: 'nothing',
      GIT_CONFIG_KEY_1: 'credential.helper', GIT_CONFIG_VALUE_1: '', GIT_CONFIG_KEY_2: 'core.sshCommand', GIT_CONFIG_VALUE_2: 'cmd /d /c exit 1' }
  }
  return { PATH: [path.dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(path.delimiter),
    HOME: '/tmp/home', TMPDIR: '/tmp', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TERM: 'dumb',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ALLOW_PROTOCOL: '', GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: 'push.default', GIT_CONFIG_VALUE_0: 'nothing',
    GIT_CONFIG_KEY_1: 'credential.helper', GIT_CONFIG_VALUE_1: '', GIT_CONFIG_KEY_2: 'core.sshCommand', GIT_CONFIG_VALUE_2: '/bin/false' }
}
function sandboxArguments(policy, cwd) {
  if (process.platform !== 'linux') fail('COMMAND_SANDBOX_UNSUPPORTED', 'The installed command boundary requires Linux bubblewrap')
  const argv = ['--die-with-parent', '--unshare-net', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--new-session']
  for (const mount of ['/usr', '/bin', '/lib', '/lib64']) {
    if (!fs.existsSync(mount)) continue
    const stat = fs.lstatSync(mount)
    if (stat.isSymbolicLink()) argv.push('--symlink', fs.readlinkSync(mount), mount)
    else argv.push('--ro-bind', mount, mount)
  }
  argv.push('--dir', '/etc')
  for (const file of ['/etc/ld.so.cache', '/etc/localtime']) if (fs.existsSync(file)) argv.push('--ro-bind', file, file)
  argv.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/tmp/home', '--dir', '/run')
  // Mount only the Node executable, not its containing private test directory.
  const node = fs.realpathSync.native(process.execPath)
  if (!within('/usr', node)) argv.push('--ro-bind', node, node)
  const reads = [...policy.readableRoots].sort((a, b) => a.length - b.length)
  for (const root of reads) argv.push('--ro-bind', root, root)
  for (const root of [...policy.writableRoots].sort((a, b) => a.length - b.length)) argv.push('--bind', root, root)
  for (const root of [...new Set([...reads, ...policy.writableRoots])]) {
    const git = path.join(root, '.git')
    if (fs.existsSync(git)) { physical(git); argv.push('--ro-bind', git, git) }
  }
  return [...argv, '--chdir', cwd, '--', '/bin/bash', '--noprofile', '--norc']
}

// These outcomes are established before sandboxArguments() or cp.spawn(). A
// caller may correct its assigned cwd, but no receipt may call that correction
// a foreground command execution.
const NOT_STARTED_CWD_CODES = new Set(['TOOL_PATH_DENIED', 'TOOL_PATH_INVALID'])
function notStartedCommand(args, code) {
  const message = code === 'TOOL_PATH_DENIED'
    ? 'Command cwd is outside the assigned readable roots'
    : 'Command cwd must be an existing assigned directory'
  const output = `${code}: ${message}`
  return { tool: 'bash', command: args.command, status: 'failed', exitCode: null,
    output, outputSha256: sha256(output), code, executionState: 'NOT_STARTED' }
}
async function command(policy, args, options = {}) {
  if (!args.command.trim() || Buffer.byteLength(args.command) > 65536) fail('TOOL_ARGUMENTS_INVALID', 'A bounded nonempty command is required')
  let cwd
  try {
    cwd = authorize(policy, args.cwd || (policy.readOnly && policy.scratchPath ? policy.scratchPath : policy.targetPath))
    if (!fs.statSync(cwd).isDirectory()) fail('TOOL_PATH_INVALID', 'Command cwd must be a directory')
  } catch (error) {
    // physical() can surface ENOENT/ENOTDIR while resolving this requested
    // cwd. Only this synchronous pre-spawn region receives a no-spawn result;
    // errors after it remain ordinary runtime failures.
    const code = error instanceof BoundaryError ? error.code
      : ['ENOENT', 'ENOTDIR'].includes(error?.code) ? 'TOOL_PATH_INVALID' : null
    if (NOT_STARTED_CWD_CODES.has(code)) return notStartedCommand(args, code)
    throw error
  }
  if (process.platform === 'win32') return require('../agents/codex/workflow/windows-appcontainer-command.js').runWindowsAppContainerCommand(policy, { ...args, cwd }, options)
  if (process.platform === 'darwin') {
    const owner = policy.darwinCommandOwner
    if (!owner || typeof policy.activationId !== 'string' || !Number.isSafeInteger(policy.generation)) fail('TOOL_POLICY_INVALID', 'Darwin commands require registered activation-bound ownership')
    const backend = require('./darwin-command-sandbox.cjs').createDarwinCommandSandbox({
      controlRoot: owner.stateRoot, ownershipControlRoot: owner.controlRoot, registryPath: owner.registryPath,
      providerPrivateOwnershipRoot: owner.providerPrivateOwnershipRoot,
      activationId: policy.activationId, generationId: policy.generation,
      nodeExecutable: owner.nodeExecutable,
    })
    return backend.command(policy, { ...args, cwd }, options)
  }
  const argv = [...sandboxArguments(policy, cwd), '-c', args.command]
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const child = cp.spawn('/usr/bin/bwrap', argv, { cwd: '/', env: safeEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], detached: true, shell: false })
    const stdout = [], stderr = [], aggregate = []
    let size = 0, truncated = false, cancelled = false, timedOut = false, killTimer, settled = false
    const stop = () => {
      if (!child.pid || settled) return
      try { process.kill(-child.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') child.kill('SIGTERM') }
      killTimer ||= setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch {} }, 100)
      killTimer.unref?.()
    }
    const cancel = () => { cancelled = true; stop() }
    const collect = target => bytes => {
      if (truncated) return
      if (size + bytes.length > OUTPUT_LIMIT) { truncated = true; stop(); return }
      size += bytes.length; target.push(bytes); aggregate.push(bytes)
    }
    child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr))
    const timer = setTimeout(() => { timedOut = true; stop() }, args.timeoutMs || 60000)
    options.signal?.addEventListener('abort', cancel, { once: true })
    if (options.signal?.aborted) cancel()
    const cleanup = () => { settled = true; clearTimeout(timer); clearTimeout(killTimer); options.signal?.removeEventListener('abort', cancel) }
    child.once('error', error => { cleanup(); reject(new BoundaryError('COMMAND_SANDBOX_UNSUPPORTED', `Cannot start the required sandbox: ${error.code || 'FAILED'}`)) })
    child.once('close', (exitCode, signal) => {
      if (settled) return
      cleanup()
      const out = Buffer.concat(stdout), err = Buffer.concat(stderr), combined = Buffer.concat(aggregate)
      resolve({ tool: 'bash', command: args.command, cwd, status: exitCode === 0 && !signal && !truncated && !cancelled && !timedOut ? 'completed' : 'failed',
        exitCode, signal, stdout: out.toString('utf8'), stderr: err.toString('utf8'), output: combined.toString('utf8'),
        stdoutBase64: out.toString('base64'), stderrBase64: err.toString('base64'), outputBase64: combined.toString('base64'),
        outputSha256: sha256(combined), truncated, cancelled, timedOut, background: false, durationMs: Date.now() - start })
    })
  })
}
async function executeTool(rawPolicy, name, args, options = {}) {
  const policy = validatePolicy(rawPolicy)
  // Authority is in the hashed controller policy, not a native tool listing
  // or a later event-parser rejection after a tool has already executed.
  if (policy.toolFree === true) fail('TOOL_DENIED', 'This controller assignment authorizes no tools')
  validateArguments(name, args)
  if (options.signal?.aborted) fail('TOOL_CANCELLED', 'Tool execution was cancelled before it started')
  if (name === 'bash') return command(policy, args, options)
  let output, details = {}
  if (name === 'read') {
    const file = authorize(policy, args.path), lines = readText(file).split('\n'), start = (args.startLine || 1) - 1
    output = lines.slice(start, start + (args.lineCount || 500)).join('\n')
    details = { path: file, totalLines: lines.length, startLine: start + 1 }
  } else if (name === 'list') {
    const file = authorize(policy, args.path)
    output = fs.readdirSync(file, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map(entry => `${entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'directory' : 'file'}\t${entry.name}`).join('\n')
  } else if (name === 'write') {
    details = atomicWrite(policy, args.path, args.content); output = `Wrote ${details.bytesWritten} bytes.`
  } else if (name === 'edit') {
    if (!args.oldText) fail('TOOL_ARGUMENTS_INVALID', 'The exact old text must not be empty')
    const file = authorize(policy, args.path, true), original = readText(file), parts = original.split(args.oldText)
    if (parts.length === 1 || (parts.length !== 2 && args.replaceAll !== true)) fail('TOOL_EDIT_AMBIGUOUS', 'The old text is missing or has multiple matches')
    details = atomicWrite(policy, file, parts.join(args.newText)); output = `Replaced ${parts.length - 1} exact match(es).`
  } else if (name === 'search') {
    if (!args.text || args.text.length > 4096) fail('TOOL_ARGUMENTS_INVALID', 'Search requires bounded literal text')
    const matches = [], limit = args.maxResults || 100
    let visited = 0, bytes = 0
    const visit = file => {
      if (matches.length >= limit) return
      if (++visited > 2000) fail('TOOL_OUTPUT_LIMIT', 'Search exceeded its bounded file inventory')
      const real = authorize(policy, file), stat = fs.lstatSync(real)
      if (stat.isDirectory()) {
        for (const entry of fs.readdirSync(real, { withFileTypes: true })) {
          if (entry.name === '.git' || entry.isSymbolicLink()) continue
          visit(path.join(real, entry.name)); if (matches.length >= limit) break
        }
      } else {
        bytes += stat.size
        if (bytes > 16 * OUTPUT_LIMIT) fail('TOOL_OUTPUT_LIMIT', 'Search exceeded its bounded byte inventory')
        let source
        try { source = readText(real) } catch (error) { if (error.code === 'TOOL_ARGUMENTS_INVALID' || error.code === 'TOOL_OUTPUT_LIMIT') return; throw error }
        const lines = source.split('\n')
        for (let index = 0; index < lines.length && matches.length < limit; index++) if (lines[index].includes(args.text)) matches.push({ path: real, line: index + 1, text: lines[index] })
      }
    }
    visit(args.path); output = JSON.stringify(matches); details = { limited: matches.length === limit, filesVisited: visited }
  }
  if (Buffer.byteLength(output) > OUTPUT_LIMIT) fail('TOOL_OUTPUT_LIMIT', 'Tool output exceeds its bounded response size')
  return { tool: name, status: 'completed', exitCode: 0, output, outputSha256: sha256(output), ...details }
}
function windowsControllerNodeBinding() {
  if (process.release?.name !== 'node' || process.versions?.bun || process.versions?.electron) fail('TOOL_POLICY_INVALID', 'Windows tool policy must be minted by the outer Node controller')
  const nodePath = physical(process.execPath), item = fs.lstatSync(nodePath)
  if (!item.isFile() || item.isSymbolicLink() || item.nlink !== 1 || item.size < 1 || item.size > 512 * 1024 * 1024) fail('TOOL_POLICY_INVALID', 'Windows controller Node is not a bounded physical executable')
  return Object.freeze({ path: nodePath, sha256: sha256(fs.readFileSync(nodePath)) })
}
function prepareBoundary({ provider, root, policy, darwinCommandOwner }) {
  if (policy?.windowsControllerNode !== undefined) fail('TOOL_POLICY_INVALID', 'Windows controller Node binding is minted only by the outer controller')
  const parent = ownedDirectory(root)
  let normalized = validatePolicy({ ...policy, provider })
  if (process.platform === 'win32') normalized = validatePolicy({ ...normalized, windowsControllerNode: windowsControllerNodeBinding() })
  if ([...normalized.readableRoots, ...normalized.writableRoots].some(task => within(task, parent) || within(parent, task))) fail('TOOL_POLICY_INVALID', 'Controller state must be disjoint from all task roots')
  const directory = path.join(parent, `tools-${crypto.randomUUID()}`)
  fs.mkdirSync(directory, { mode: 0o700 })
  if (process.platform === 'win32') require('../agents/codex/workflow/safe-run-root.js').ensureWindowsPrivateAcl(directory)
  const policyPath = path.join(directory, 'policy.json'), receiptPath = path.join(directory, 'receipts.jsonl')
  let registeredCommandOwner = null
  if (darwinCommandOwner !== undefined) {
    if (process.platform !== 'darwin' || !darwinCommandOwner || typeof darwinCommandOwner !== 'object' || Array.isArray(darwinCommandOwner) ||
        Object.keys(darwinCommandOwner).sort().join(',') !== 'manifestRoot,providerPrivateOwnershipRoot' ||
        typeof normalized.activationId !== 'string' || !Number.isSafeInteger(normalized.generation) || normalized.generation < 1) fail('TOOL_POLICY_INVALID', 'Darwin command ownership requires an activation-bound policy')
    const { STATE_CHILD } = require('./harness-v2-command-owner-discovery.cjs')
    const nodePath = physical(process.execPath), nodeItem = fs.lstatSync(nodePath)
    if (!nodeItem.isFile() || nodeItem.isSymbolicLink()) fail('TOOL_POLICY_INVALID', 'Darwin controller Node is not a physical executable')
    const owner = { schemaVersion: 1, manifestRoot: darwinCommandOwner.manifestRoot, providerPrivateOwnershipRoot: darwinCommandOwner.providerPrivateOwnershipRoot,
      stateRoot: path.join(directory, STATE_CHILD), registryPath: path.join(directory, STATE_CHILD, 'processes.json'), controlRoot: path.join(directory, STATE_CHILD, 'process-control'),
      nodeExecutable: { path: nodePath, sha256: sha256(fs.readFileSync(nodePath)) } }
    if (!ownedDirectory(owner.providerPrivateOwnershipRoot) || !within(owner.providerPrivateOwnershipRoot, directory)) fail('TOOL_POLICY_INVALID', 'Darwin command ownership root does not contain policy state')
    normalized = validatePolicy({ ...normalized, darwinCommandOwner: owner })
  }
  const bytes = canonicalJson(normalized), policySha256 = sha256(bytes)
  writePrivate(policyPath, bytes); writePrivate(receiptPath, '')
  if (normalized.darwinCommandOwner) {
    const discovery = require('./harness-v2-command-owner-discovery.cjs')
    registeredCommandOwner = discovery.register(policyPath, policySha256, normalized.darwinCommandOwner.manifestRoot, { provider: normalized.provider, activationId: normalized.activationId, generation: normalized.generation })
    for (const key of ['stateRoot', 'registryPath', 'controlRoot']) if (registeredCommandOwner[key] !== normalized.darwinCommandOwner[key]) fail('TOOL_POLICY_INVALID', 'Darwin command ownership descriptor differs from its registered policy')
  }
  return { root: directory, policy: normalized, policyPath, policySha256, receiptPath, ...(registeredCommandOwner ? { darwinCommandOwner: normalized.darwinCommandOwner } : {}),
    serverSpec: { command: normalized.darwinCommandOwner?.nodeExecutable.path || (process.platform === 'win32' ? normalized.windowsControllerNode.path : process.execPath), args: [path.join(__dirname, 'harness-v2-tool-server.cjs'), '--policy', policyPath, '--sha256', policySha256],
      env: { ...safeEnvironment(), HOME: directory, TMPDIR: directory, ...(process.platform === 'win32' ? { TEMP: directory, TMP: directory } : {}) } } }
}
async function drainDarwinCommandOwner(prepared) {
  if (!prepared?.darwinCommandOwner) return { discovered: 0 }
  const owner = prepared.darwinCommandOwner, policy = prepared.policy
  const discovery = require('./harness-v2-command-owner-discovery.cjs')
  const drained = await discovery.drainOneAuthenticated(prepared.policyPath, prepared.policySha256, owner.manifestRoot, { provider: policy.provider, activationId: policy.activationId, generation: policy.generation }, { providerPrivateOwnershipRoot: owner.providerPrivateOwnershipRoot })
  // A normal transport has just proved this exact secondary coalition drained.
  // Remove only its sealed canary pointer; an error above deliberately leaves
  // it durable for crash/canary recovery.
  discovery.unregisterCanaryDiscovery(prepared.policyPath, prepared.policySha256, owner)
  return drained
}
function validateLoadedDarwinCommandOwner(policy, root) {
  const owner = policy.darwinCommandOwner
  if (!owner) return null
  const { STATE_CHILD } = require('./harness-v2-command-owner-discovery.cjs')
  const expected = { stateRoot: path.join(root, STATE_CHILD), registryPath: path.join(root, STATE_CHILD, 'processes.json'), controlRoot: path.join(root, STATE_CHILD, 'process-control') }
  if (Object.keys(owner).sort().join(',') !== 'controlRoot,manifestRoot,nodeExecutable,providerPrivateOwnershipRoot,registryPath,schemaVersion,stateRoot' || owner.schemaVersion !== 1 ||
      Object.keys(expected).some(key => owner[key] !== expected[key]) || !path.isAbsolute(owner.manifestRoot) || !path.isAbsolute(owner.providerPrivateOwnershipRoot) ||
      !owner.nodeExecutable || Object.keys(owner.nodeExecutable).sort().join(',') !== 'path,sha256' || !path.isAbsolute(owner.nodeExecutable.path || '') || owner.nodeExecutable.path.includes('\0') || !/^[a-f0-9]{64}$/.test(owner.nodeExecutable.sha256 || '') ||
      !within(owner.providerPrivateOwnershipRoot, root)) fail('TOOL_POLICY_INVALID', 'Darwin command ownership descriptor differs from its policy root')
  return owner
}
function loadBoundary(policyPath, policySha256) {
  if (!/^[a-f0-9]{64}$/.test(policySha256 || '')) fail('TOOL_POLICY_INVALID', 'Tool policy digest is invalid')
  const root = ownedDirectory(path.dirname(physical(policyPath)))
  if (process.platform === 'win32') require('../agents/codex/workflow/windows-filesystem.js').createWindowsFilesystemCapture().assertRecordParent(policyPath)
  const bytes = readBound(policyPath)
  if (sha256(bytes) !== policySha256 || path.basename(policyPath) !== 'policy.json') fail('TOOL_POLICY_INVALID', 'Tool policy bytes changed')
  const policy = validatePolicy(JSON.parse(bytes))
  const darwinCommandOwner = validateLoadedDarwinCommandOwner(policy, root)
  return { root, policyPath, policySha256, policy, ...(darwinCommandOwner ? { darwinCommandOwner } : {}), receiptPath: path.join(root, 'receipts.jsonl') }
}
function readReceipts(boundary) {
  const current = loadBoundary(boundary.policyPath, boundary.policySha256)
  const bytes = readBound(current.receiptPath)
  if (bytes.length > 32 * OUTPUT_LIMIT) fail('TOOL_RECEIPT_INVALID', 'Tool receipt journal exceeded its bound')
  if (bytes.length && bytes.at(-1) !== 10) fail('TOOL_RECEIPT_INVALID', 'Tool receipt journal has an incomplete append')
  let previous = null
  const records = bytes.toString('utf8').split('\n').filter(Boolean).map((line, index) => {
    const record = JSON.parse(line), { hash, ...body } = record
    if (body.sequence !== index + 1 || body.previous !== previous || body.policySha256 !== current.policySha256 || hash !== sha256(canonicalJson(body))) fail('TOOL_RECEIPT_INVALID', 'Tool receipt chain is invalid')
    previous = hash; return record
  })
  return records
}
function appendReceipt(boundary, name, args, result, startedAt) {
  const records = readReceipts(boundary)
  const body = { sequence: records.length + 1, previous: records.at(-1)?.hash || null,
    policySha256: boundary.policySha256, tool: name, argsSha256: sha256(canonicalJson(args)), resultSha256: sha256(canonicalJson(result)),
    outputSha256: result.outputSha256 || sha256(result.output || ''), status: result.status, exitCode: result.exitCode ?? null,
    ...(result.executionState === 'NOT_STARTED' ? { executionState: 'NOT_STARTED' } : {}),
    startedAt, endedAt: new Date().toISOString() }
  const record = { ...body, hash: sha256(canonicalJson(body)) }
  const fd = fs.openSync(boundary.receiptPath, fs.constants.O_WRONLY | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW || 0))
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1) fail('TOOL_RECEIPT_INVALID', 'Tool receipt journal changed')
    fs.writeSync(fd, `${JSON.stringify(record)}\n`); fs.fsyncSync(fd)
  } finally { fs.closeSync(fd) }
  return record
}
// Static diagnostics do not certify kernel isolation. The dynamic probe still
// proves the actual sandbox before a transport can launch a mission.
function assertCommandSandboxPrerequisites(options = {}) {
  const platform = options.platform || process.platform
  if (platform === 'linux') {
    for (const file of ['/usr/bin/bwrap', '/bin/bash']) {
      try {
        if (!fs.statSync(file).isFile()) throw new Error('not a regular file')
        fs.accessSync(file, fs.constants.X_OK)
      } catch {
        fail('COMMAND_SANDBOX_UNSUPPORTED', `Linux command boundary requires executable ${file}; install ${file.endsWith('bwrap') ? 'bubblewrap' : 'Bash'} before activation`)
      }
    }
    return { backend: 'bubblewrap' }
  }
  if (platform === 'win32') {
    const environment = require('../agents/codex/workflow/process-owner.js').normalizeWindowsChildEnvironment(options.env || process.env)
    const systemRoot = environment.SYSTEMROOT
    if (typeof systemRoot !== 'string' || !/^[A-Za-z]:\\Windows$/i.test(systemRoot)) fail('COMMAND_SANDBOX_UNSUPPORTED', 'Windows system root is unavailable')
    const runtime = require('../agents/codex/workflow/windows-worker-loader.js').staticAvailability()
    if (!runtime.available) fail('COMMAND_SANDBOX_UNSUPPORTED', `The packaged Windows worker bundle is unavailable: ${runtime.code}`)
    return { backend: 'windows-appcontainer', manifestSha256: runtime.manifestSha256, scope: runtime.scope }
  }
  if (platform === 'darwin') {
    const helper = require('../agents/codex/workflow/darwin-coalition-loader.js').loadDarwinCoalitionHelper()
    for (const executable of ['/usr/bin/sandbox-exec', '/bin/sh', '/bin/bash', '/bin/launchctl']) fs.accessSync(executable, fs.constants.X_OK)
    return { backend: 'darwin-seatbelt-coalition', helperSha256: helper.sha256 }
  }
  fail('COMMAND_SANDBOX_UNSUPPORTED', 'This platform has no supported native command sandbox; use the documented Linux VM runtime')
}
async function probeCommandSandbox() {
  if (process.platform === 'win32') return require('../agents/codex/workflow/windows-appcontainer-probe.js').probeWindowsAppContainer()
  if (process.platform === 'darwin') return require('./darwin-command-probe.cjs').probeDarwinCommandSandbox()
  if (process.platform !== 'linux') return { supported: false, backend: 'bubblewrap', code: 'COMMAND_SANDBOX_UNSUPPORTED' }
  const result = cp.spawnSync('/usr/bin/bwrap', ['--die-with-parent', '--unshare-net', '--unshare-pid', '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64', '--', '/bin/true'], { env: safeEnvironment(), encoding: 'utf8', timeout: 10000, shell: false })
  return { supported: !result.error && result.status === 0, backend: 'bubblewrap',
    ...(result.error || result.status !== 0 ? { code: 'COMMAND_SANDBOX_UNSUPPORTED', reason: result.error?.code || result.stderr.trim().slice(0, 1024) } : {}) }
}
module.exports = { BoundaryError, TOOLS, OUTPUT_LIMIT, canonicalJson, sha256, within, physical, validatePolicy, validateArguments,
  authorize, executeTool, prepareBoundary, drainDarwinCommandOwner, loadBoundary, readReceipts, appendReceipt, assertCommandSandboxPrerequisites, probeCommandSandbox, sandboxArguments, safeEnvironment }
