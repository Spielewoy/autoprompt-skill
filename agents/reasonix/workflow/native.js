'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const childProcess = require('node:child_process')
const toml = require('@iarna/toml')

const MINIMUM_VERSION = '1.30.0'
const FORBIDDEN_TOOLS = Object.freeze([
  'task', 'fleet', 'run_skill', 'load_skill', 'activate_skill', 'create_skill',
  'skill_create', 'skill_edit', 'skill_delete', 'remember', 'forget',
  'use_capability', 'ask', 'update_goal', 'complete_step', 'todo_write', 'wait',
])
const CONTROLLED_SERVER = 'autoprompt_owned'
const CONTROLLED_PROXY = 'use_capability'
const CONTROLLED_NAMES = Object.freeze(['read', 'list', 'search', 'write', 'edit', 'bash'])
// v1.30 keeps MCP schemas behind one stable proxy. Permission rules still
// resolve against the exact native MCP name, never the proxy or a wildcard.
const CONTROLLED_TOOLS = Object.freeze(CONTROLLED_NAMES
  .map(name => `mcp__${CONTROLLED_SERVER}__${name}`))
const CONTROLLED_NATIVE_TOOLS = Object.freeze(['todo_write'])
const CONTROLLED_CAPABILITIES = Object.freeze(CONTROLLED_NAMES
  .map(name => `mcp-tool:${CONTROLLED_SERVER}/${name}`))
const CONTROLLED_DENIED_TOOLS = Object.freeze([...FORBIDDEN_TOOLS,
  'bash', 'bash_output', 'kill_shell', 'read_file', 'list_dir', 'ls', 'glob', 'grep',
  'write_file', 'edit_file', 'apply_patch', 'multi_edit', 'move_file', 'notebook_edit',
  'delete_range', 'delete_symbol', 'web_fetch', 'web_search', 'code_index', 'compress',
  'read_only_task', 'parallel_tasks', 'read_subagent_result', 'read_only_skill',
  'read_skill', 'install_skill', 'install_source', 'slash_command', 'explore',
  'research', 'review', 'security_review', 'review_report', 'docs', 'history',
  'list_sessions', 'read_session', 'memory', 'lsp_definition', 'lsp_diagnostics',
  'lsp_hover', 'lsp_references', `mcp_connect__${CONTROLLED_SERVER}`,
])
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex')
function validateNativeTodoWrite(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== 1 || !Array.isArray(args.todos) || args.todos.length < 1 || args.todos.length > 128) throw new ReasonixError('TOOL_POLICY_DENIED', 'Reasonix todo_write arguments are invalid')
  const ids = new Set(); let active = 0
  for (const todo of args.todos) {
    if (!todo || typeof todo !== 'object' || Array.isArray(todo) || Object.keys(todo).some(key => !['content','status','activeForm','level','step_id'].includes(key)) || typeof todo.content !== 'string' || !todo.content.trim() || todo.content.length > 2000 || !['pending','in_progress','completed'].includes(todo.status) || (todo.activeForm !== undefined && (typeof todo.activeForm !== 'string' || todo.activeForm.length > 2000)) || (todo.level !== undefined && todo.level !== 0 && todo.level !== 1) || (todo.step_id !== undefined && (typeof todo.step_id !== 'string' || todo.step_id.length > 256))) throw new ReasonixError('TOOL_POLICY_DENIED', 'Reasonix todo_write item is invalid')
    if (todo.status === 'in_progress') active++
    if (todo.step_id) { if (ids.has(todo.step_id)) throw new ReasonixError('TOOL_POLICY_DENIED', 'Reasonix todo_write reuses a stable step_id'); ids.add(todo.step_id) }
  }
  if (active > 1) throw new ReasonixError('TOOL_POLICY_DENIED', 'Reasonix todo_write has more than one in-progress item')
  return args
}
const inside = (root, candidate) => {
  const relative = path.relative(root, candidate)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

class ReasonixError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'ReasonixError'
    this.code = code
    this.details = details
  }
}

function readBound(file) {
  const before = fs.lstatSync(file)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new ReasonixError('PAYLOAD_INVALID', `Expected one regular file: ${file}`)
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  try {
    const opened = fs.fstatSync(fd)
    if (opened.ino !== before.ino || opened.dev !== before.dev) throw new ReasonixError('PAYLOAD_INVALID', 'File changed while opening')
    const bytes = fs.readFileSync(fd)
    const after = fs.lstatSync(file)
    if (opened.ino !== after.ino || opened.dev !== after.dev || after.size !== bytes.length || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) {
      throw new ReasonixError('PAYLOAD_INVALID', 'File changed while reading')
    }
    return bytes
  } finally { fs.closeSync(fd) }
}

function privateDirectory(directory) {
  if (fs.existsSync(directory)) {
    const stat = fs.lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ReasonixError('PAYLOAD_INVALID', `Private directory is linked or invalid: ${directory}`)
    if (path.dirname(directory) !== directory) privateDirectory(path.dirname(directory))
    return false
  }
  privateDirectory(path.dirname(directory))
  fs.mkdirSync(directory, { mode: 0o700 })
  return true
}

// AppContainer resource plans reject writable directories with inherited
// ACLs. Establish a protected DACL only when this adapter just created its
// own leaf: reapplying it would remove a live package lease ACE, and parent
// directories are never candidates for mutation here.
function privateWindowsLeaf(directory) {
  const created = privateDirectory(directory)
  if (created && process.platform === 'win32') require('../../codex/workflow/safe-run-root.js').ensureWindowsPrivateAcl(directory)
  return created
}

function writePrivate(file, data) {
  privateDirectory(path.dirname(file))
  fs.writeFileSync(file, data, { flag: 'wx', mode: 0o600 })
}

// `harness-v2-native` imports this module, so resolve its reviewed Windows
// shim machinery only while probing or launching.  The lazy edge avoids a
// partially initialized circular export without duplicating its parser.
function harnessNative() { return require('../../../scripts/harness-v2-native.cjs') }

function locateExecutable(env = process.env, requested, options = {}) {
  const platform = options.platform || process.platform
  const names = requested ? [requested] : (env.PATH || '').split(path.delimiter)
    .filter(Boolean).flatMap(directory => platform === 'win32'
      ? [path.join(directory, 'reasonix.exe'), path.join(directory, 'reasonix.cmd')] : [path.join(directory, 'reasonix')])
  for (const name of names) {
    try {
      const resolved = fs.realpathSync.native(name)
      fs.accessSync(resolved, fs.constants.X_OK)
      if (platform === 'win32' && /\.cmd$/i.test(resolved)) {
        const invocation = harnessNative().windowsNpmShimInvocation(resolved)
        return { path: resolved, sha256: invocation.shim.sha256, invocation }
      }
      if (platform === 'win32' && /\.bat$/i.test(resolved)) {
        throw new ReasonixError('PROVIDER_UNSUPPORTED', 'Windows batch launchers are not an admitted Reasonix executable form')
      }
      return { path: resolved, sha256: sha256(readBound(resolved)) }
    } catch (error) { if (requested) throw error }
  }
  throw new ReasonixError('PROVIDER_UNSUPPORTED', 'Reasonix CLI is not installed or is not executable')
}

function probeExecutable(options = {}) {
  const executable = locateExecutable(options.env, options.executable, options)
  const shared = harnessNative()
  const spawn = options.spawnSync || childProcess.spawnSync
  const invoke = argv => {
    const launch = shared.executableInvocation(executable, argv)
    return spawn(launch.executable, launch.argv, {
      env: options.env || process.env, encoding: 'utf8', shell: false, timeout: 15000, maxBuffer: 1024 * 1024,
    })
  }
  const version = invoke(['--version'])
  const match = /\breasonix\s+v?(\d+)\.(\d+)\.(\d+)\b/i.exec(String(version.stdout || ''))
  const tuple = match && match.slice(1).map(Number)
  if (version.error || version.status !== 0 || !tuple || tuple[0] < 1 || (tuple[0] === 1 && tuple[1] < 30)) {
    throw new ReasonixError('PROVIDER_UNSUPPORTED', `Reasonix ${MINIMUM_VERSION} or later is required`)
  }
  const help = invoke(['run', '--help'])
  const text = `${help.stdout || ''}\n${help.stderr || ''}`
  if (help.error || help.status !== 0 || !['--output-format', '--resume', '--dir', '--max-steps', '--permission-mode', '--allowed-tools'].every(flag => text.includes(flag))) {
    throw new ReasonixError('PROVIDER_UNSUPPORTED', 'Reasonix lacks the required streamed run and resume interface')
  }
  // Validate the immutable shim/package/interpreter closure again after both
  // probes, then inventory the actual entrypoint rather than cmd.exe syntax.
  shared.executableInvocation(executable)
  const runtimePath = shared.executableRuntimePath(executable)
  return Object.freeze({
    ...executable, version: tuple.join('.'), provider: 'reasonix',
    runtimeIdentity: shared.runtimeDependencyIdentity(runtimePath, options.env || process.env, executable.invocation),
    portableRuntimeIdentity: shared.portableRuntimeDependencyIdentity('reasonix', runtimePath, options.env || process.env, executable.invocation),
    evidenceHashes: [sha256(String(version.stdout)), sha256(text)],
  })
}

// Copy model connection settings, never user hooks, plugins, agent prompts,
// permission overrides, or project config. Native Reasonix parses the emitted
// TOML itself; its model/provider semantics are preserved verbatim.
function connectionConfig(file) {
  const source = toml.parse(readBound(file).toString('utf8'))
  if (!Array.isArray(source.providers) || !source.providers.length) {
    throw new ReasonixError('PROVIDER_UNSUPPORTED', 'Configure a Reasonix model provider before activation')
  }
  const providers = source.providers.map(provider => {
    const selected = {}
    for (const key of [
      'name', 'kind', 'base_url', 'chat_url', 'request_url', 'model', 'models', 'default',
      'api_key_env', 'headers', 'extra_body', 'context_window', 'max_tokens',
      'max_output_tokens', 'responses_mode', 'reasoning_effort',
    ]) if (Object.hasOwn(provider, key)) selected[key] = provider[key]
    if (typeof selected.name !== 'string' || !selected.name) throw new ReasonixError('PROVIDER_UNSUPPORTED', 'A Reasonix provider has no name')
    if (Object.hasOwn(selected, 'max_output_tokens') && (!Number.isSafeInteger(selected.max_output_tokens) || selected.max_output_tokens <= 0)) {
      throw new ReasonixError('PROFILE_INVALID', 'Reasonix provider max_output_tokens must be a positive safe integer')
    }
    return selected
  })
  return { ...(source.default_model ? { default_model: source.default_model } : {}), providers }
}

function renderCredentials(connection, environment) {
  // v1.30 resolves provider keys from REASONIX_HOME/.env, not the inherited
  // process environment. Project only explicitly configured credential names;
  // never copy the caller's whole environment or an untrusted dotenv file.
  const names = [...new Set(connection.providers.map(provider => provider.api_key_env).filter(Boolean))].sort()
  return names.flatMap(name => {
    if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new ReasonixError('PROFILE_INVALID', 'Invalid configured credential name')
    if (!Object.hasOwn(environment, name) || environment[name] === '') return []
    const value = environment[name]
    if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > 65536) throw new ReasonixError('PROFILE_INVALID', 'Invalid configured credential value')
    // Match godotenv's quoted-value escaping, including its interpolation
    // metacharacters. Opaque credentials must not expand $OTHER_VARIABLE.
    const escaped = value.replace(/[\\"$`]/g, character => `\\${character}`).replace(/\n/g, '\\n').replace(/\r/g, '\\r')
    return [`${name}="${escaped}"\n`]
  }).join('')
}

// v1.30 can kill its direct stdio child when the native context ends, before
// closing that child's stdin. Keep the real controller server one pipe behind
// a byte-preserving relay: even SIGKILL of this relay closes the server's input
// and lets its existing lease/cancellation cleanup run. The server stays in
// the same owned process group; no detached child or alternative tool surface.
function runControlledStdioRelay(argv) {
  if (argv[0] !== '--controlled-stdio') throw new ReasonixError('TOOL_POLICY_INVALID', 'Expected the controlled stdio entry point')
  const serverPath = require.resolve('../../../scripts/harness-v2-tool-server.cjs')
  const prepared = require(serverPath).parseArguments(argv.slice(1))
  if (prepared.policy.provider !== 'reasonix') throw new ReasonixError('TOOL_POLICY_INVALID', 'Controlled stdio requires a Reasonix policy')
  const child = childProcess.spawn(process.execPath, [serverPath, ...argv.slice(1)], {
    env: process.env, stdio: ['pipe', 'pipe', 'inherit'], shell: false, detached: false,
  })
  let closing = false, parentSignal, failed = false, graceTimer, killTimer
  const close = signal => {
    if (signal) parentSignal ||= signal
    if (closing) return
    closing = true
    process.stdin.unpipe(child.stdin)
    process.stdin.pause()
    child.stdin.end()
    if (signal) child.kill(signal)
    graceTimer = setTimeout(() => child.kill('SIGTERM'), 1000)
    killTimer = setTimeout(() => child.kill('SIGKILL'), 3000)
    graceTimer.unref(); killTimer.unref()
  }
  const brokenPipe = error => { if (error.code !== 'EPIPE') failed = true; close() }
  const terminate = () => close('SIGTERM'), interrupt = () => close('SIGINT')
  process.once('SIGTERM', terminate); process.once('SIGINT', interrupt)
  process.stdin.once('end', () => close())
  process.stdin.on('error', brokenPipe); process.stdout.on('error', brokenPipe)
  child.stdin.on('error', brokenPipe); child.stdout.on('error', brokenPipe)
  child.once('error', () => { failed = true; close() })
  child.once('close', (code, signal) => {
    clearTimeout(graceTimer); clearTimeout(killTimer)
    process.stdin.unpipe(child.stdin); process.stdin.destroy()
    process.removeListener('SIGTERM', terminate); process.removeListener('SIGINT', interrupt)
    const terminalSignal = signal || parentSignal
    if (terminalSignal) process.kill(process.pid, terminalSignal)
    else process.exitCode = failed ? 1 : code ?? 1
  })
  process.stdin.pipe(child.stdin)
  child.stdout.pipe(process.stdout)
}

function renderConfig(options) {
  const { connection, systemPrompt, targetPath, scratchPath, readOnly } = options
  if (!connection || !Array.isArray(connection.providers) || !path.isAbsolute(targetPath) || !path.isAbsolute(scratchPath)) {
    throw new ReasonixError('PROFILE_INVALID', 'Native profile requires absolute target and scratch paths and a provider configuration')
  }
  // Load lazily: the boundary itself imports readBound/writePrivate from here.
  const controlled = options.toolBoundary ? require('../../../scripts/harness-v2-controlled-tools.cjs') : null
  const server = controlled?.serverSpec(options.toolBoundary, 'reasonix')
  const toolFree = options.toolBoundary?.policy.toolFree === true
  return toml.stringify({
    ...connection,
    agent: { system_prompt: systemPrompt, max_subagent_depth: 1, max_subagent_concurrency: 1, max_parallel_writers: 1 },
    skills: { disable_implicit_invocation: true, paths: [] },
    ...(server ? {
      // A nonempty native enabled list filters builtin registration. Empty
      // means ALL builtins in Reasonix, so never emit [] for controlled runs.
      // The pinned native registry treats a nonmatching, nonempty filter as
      // no builtins. An empty array would enable every builtin instead.
      tools: { enabled: toolFree ? ['autoprompt_no_tools'] : [CONTROLLED_PROXY, ...CONTROLLED_NATIVE_TOOLS] },
      plugins: toolFree ? [] : [{ name: CONTROLLED_SERVER, type: 'stdio', ...server,
        args: [__filename, '--controlled-stdio', ...server.args.slice(1)],
      }],
    } : {}),
    permissions: {
      mode: server ? 'deny' : 'allow',
      ...(server ? { allow: toolFree ? [] : [...CONTROLLED_TOOLS, ...CONTROLLED_NATIVE_TOOLS] } : {}),
      // Keep use_capability denied: a concrete call is authorized under its
      // resolved MCP name; list/inspect/decline and native targets gain no grant.
      deny: server ? toolFree ? [...CONTROLLED_DENIED_TOOLS, ...CONTROLLED_TOOLS, ...CONTROLLED_NATIVE_TOOLS] : CONTROLLED_DENIED_TOOLS.filter(name => !CONTROLLED_NATIVE_TOOLS.includes(name)) : [...FORBIDDEN_TOOLS, ...(readOnly && !options.checkerScratch ? ['write_file', 'edit_file', 'apply_patch'] : [])],
      allow_dynamic_bash: false,
    },
    sandbox: { workspace_root: readOnly ? scratchPath : targetPath, allow_write: [...(readOnly ? [] : [scratchPath]), ...(options.writableRoots || [])], bash: 'enforce', network: false },
    telemetry: { cli_metrics: 'off' },
    secrets: { filter_subprocess_env: true },
  })
}

function parseTerminal(text) {
  const decode = value => {
    const result = JSON.parse(value)
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('not an object')
    return result
  }
  try { return decode(text) } catch {}
  // The native terminal may present its one result in a labelled JSON block.
  // Ignore presentation only; competing JSON/fences stay ambiguous and fail.
  // The adapter still validates the full schema and authenticated receipts.
  const block = typeof text === 'string' && /^(.*?)```json\s*\n([\s\S]*?)\n```(.*?)$/isu.exec(text)
  if (block && !/[{}\[\]]|```/u.test(`${block[1]}${block[3]}`)) {
    try { return decode(block[2].trim()) } catch {}
  }
  throw new ReasonixError('CHILD_RESULT_INVALID', 'Reasonix must return one JSON object matching the assigned result schema')
}

function nativeUsage(usage) {
  const input = usage.promptTokens
  const cached = usage.cacheHitTokens
  const output = usage.completionTokens
  const reasoning = usage.reasoningTokens || 0
  if (usage.estimated === true || ![input, cached, output, reasoning].every(value => Number.isSafeInteger(value) && value >= 0) || cached > input || reasoning > output) {
    throw new ReasonixError('PROVIDER_USAGE_UNKNOWN', 'Reasonix returned missing, estimated, or inconsistent token accounting')
  }
  return { noncachedInput: input - cached, cachedInput: cached, output, reasoning }
}

module.exports = { CONTROLLED_CAPABILITIES, CONTROLLED_DENIED_TOOLS, CONTROLLED_NATIVE_TOOLS, CONTROLLED_PROXY, CONTROLLED_SERVER, CONTROLLED_TOOLS, FORBIDDEN_TOOLS, MINIMUM_VERSION, ReasonixError, connectionConfig, inside, locateExecutable, nativeUsage, parseTerminal, privateDirectory, privateWindowsLeaf, probeExecutable, readBound, renderConfig, renderCredentials, sha256, validateNativeTodoWrite, writePrivate }

if (require.main === module) {
  try { runControlledStdioRelay(process.argv.slice(2)) } catch (error) {
    process.stderr.write(`${error.code || 'TOOL_SERVER_FAILED'}: Controlled Reasonix stdio could not start\n`)
    process.exitCode = 1
  }
}
