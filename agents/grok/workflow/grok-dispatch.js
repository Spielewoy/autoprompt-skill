#!/usr/bin/env node
'use strict'

// Sealed, fail-closed Autoprompt dispatcher for Grok Build.
//
// Grok Build caps native subagent nesting at one level: a subagent cannot call
// `spawn_subagent`. Autoprompt needs the full L0..L4 topology, so every child is
// started as its own top-level Grok Build process bound to one canonical persona
// definition through `grok -p --agent <definition>`.
//
// This module owns the whole admission decision. It validates the daemon-free
// caller identity carried in the environment, the canonical child allowlist, the
// depth ceiling, the framework registry, and the exact bytes of the run's prompt
// ledger before it seals a dispatch envelope and launches the child. Nothing else
// in the package may start an `ap-*` role.

const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const MAX_DEPTH = 4
const RUNTIME_ID = 'grok-build-adapter-v1'
const INSTANCE_PATTERN = /^[a-z0-9][a-z0-9-]{0,23}$/
const NONCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,127}$/
const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh'])
const PERMISSION_MODES = Object.freeze(['default', 'acceptEdits', 'auto', 'dontAsk', 'plan'])
const BYPASS_PERMISSION_MODE = 'bypassPermissions'
const TOPOLOGY_FILE = 'autoprompt-topology.json'

class DispatchError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'DispatchError'
    this.code = code
  }
}

function denied(message) {
  return new DispatchError('AUTOPROMPT_DISPATCH_DENIED', message)
}

function usage(message) {
  return new DispatchError('AUTOPROMPT_DISPATCH_USAGE', message)
}

function readTopology(workflowRoot = __dirname) {
  const source = path.join(workflowRoot, TOPOLOGY_FILE)
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(source, 'utf8'))
  } catch (error) {
    throw denied(`sealed topology is unreadable at ${source}: ${error.message}`)
  }
  if (!parsed || parsed.schemaVersion !== 1 || parsed.runtime !== RUNTIME_ID) {
    throw denied(`sealed topology at ${source} is not a current Grok Build topology`)
  }
  if (parsed.maxDepth !== MAX_DEPTH) {
    throw denied(`sealed topology pins depth ${parsed.maxDepth}; this dispatcher pins ${MAX_DEPTH}`)
  }
  const personas = parsed.personas
  const frameworks = parsed.frameworks
  const rootChildren = parsed.rootAllowedChildren
  if (!personas || typeof personas !== 'object' || Array.isArray(personas)) {
    throw denied('sealed topology has no persona registry')
  }
  if (!Array.isArray(frameworks) || !Array.isArray(rootChildren)) {
    throw denied('sealed topology has no framework or root registry')
  }
  for (const [persona, children] of Object.entries(personas)) {
    if (!Array.isArray(children) || children.some(child => !personas[child])) {
      throw denied(`sealed topology has an invalid child list for ${persona}`)
    }
  }
  if (rootChildren.some(child => !personas[child])) {
    throw denied('sealed topology has an invalid root child list')
  }
  return Object.freeze({
    personas: Object.freeze(personas),
    frameworks: Object.freeze(new Set(frameworks)),
    rootAllowedChildren: Object.freeze(rootChildren),
  })
}

// The caller's canonical role, derived from an `ap-<role>` or `ap-<role>--<instance>`
// session identity. Anything else is refused rather than treated as the root.
function canonicalRole(identity, topology) {
  if (typeof identity !== 'string' || identity === '') return null
  if (topology.personas[identity]) return identity
  for (const persona of Object.keys(topology.personas)) {
    const prefix = `${persona}--`
    if (identity.startsWith(prefix) && INSTANCE_PATTERN.test(identity.slice(prefix.length))) {
      return persona
    }
  }
  throw denied(`caller identity is not an allowlisted Autoprompt persona: ${identity}`)
}

function parsedDepth(value) {
  if (value === undefined || value === '') return 0
  if (!/^(?:0|[1-9][0-9]*)$/.test(String(value))) {
    throw denied(`caller depth is not a plain integer: ${value}`)
  }
  const depth = Number(value)
  if (depth < 0 || depth > MAX_DEPTH) throw denied(`caller depth ${depth} is outside 0..${MAX_DEPTH}`)
  return depth
}

function missionBinding(missionPath, nonce) {
  if (!NONCE_PATTERN.test(String(nonce || ''))) {
    throw denied('run nonce must be 8-128 safe characters')
  }
  let resolved
  let payload
  try {
    resolved = fs.realpathSync(path.resolve(String(missionPath || '')))
    payload = fs.readFileSync(resolved)
    new TextDecoder('utf-8', { fatal: true }).decode(payload)
  } catch (error) {
    throw denied(`mission ledger must be a readable UTF-8 file: ${error.message}`)
  }
  if (payload.length === 0) throw denied('mission ledger must not be empty')
  return Object.freeze({
    path: resolved,
    sha256: crypto.createHash('sha256').update(payload).digest('hex'),
    bytes: payload.length,
    nonce: String(nonce),
  })
}

function inheritedBinding(raw) {
  if (raw === undefined || raw === '') return null
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw denied('inherited mission binding is not valid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw denied('inherited mission binding is not an object')
  }
  if (Object.keys(parsed).sort().join(',') !== 'bytes,nonce,path,sha256') {
    throw denied('inherited mission binding has unexpected keys')
  }
  if (typeof parsed.path !== 'string' || !path.isAbsolute(parsed.path) ||
      !SHA256_PATTERN.test(String(parsed.sha256)) ||
      !Number.isSafeInteger(parsed.bytes) || parsed.bytes <= 0 ||
      !NONCE_PATTERN.test(String(parsed.nonce))) {
    throw denied('inherited mission binding is malformed')
  }
  return Object.freeze({
    path: parsed.path,
    sha256: parsed.sha256,
    bytes: parsed.bytes,
    nonce: parsed.nonce,
  })
}

function sameBinding(left, right) {
  return left.path === right.path && left.sha256 === right.sha256 &&
    left.bytes === right.bytes && left.nonce === right.nonce
}

function serializedBinding(binding) {
  return JSON.stringify({
    bytes: binding.bytes,
    nonce: binding.nonce,
    path: binding.path,
    sha256: binding.sha256,
  })
}

function frameworkText(runtimeRoot, framework) {
  if (framework === null) return ''
  const source = path.join(runtimeRoot, 'frameworks', `${framework}.md`)
  let text
  try {
    text = fs.readFileSync(source, 'utf8')
  } catch (error) {
    throw denied(`sealed framework ${framework} is unreadable: ${error.message}`)
  }
  return text.replace(/\r\n/g, '\n').trim()
}

function personaDefinition(runtimeRoot, persona) {
  const definition = path.join(runtimeRoot, 'agents', `${persona}.md`)
  let stats
  try {
    stats = fs.lstatSync(definition)
  } catch (error) {
    throw denied(`persona definition for ${persona} is missing: ${error.message}`)
  }
  if (!stats.isFile()) throw denied(`persona definition for ${persona} is not a regular file`)
  return definition
}

function buildEnvelope(request) {
  const { persona, task, framework, parentDepth, binding, frameworkBody } = request
  const bounded = task.replace(/\r\n/g, '\n')
  return [
    '# SEALED AUTOPROMPT DISPATCH ENVELOPE',
    `AUTOPROMPT-RUN-MARKER: runtime=${RUNTIME_ID} nonce=${binding.nonce} prompt=sha256:${binding.sha256}`,
    `RUN-NONCE: ${binding.nonce}`,
    'MISSION POINTER: read the exact prompt ledger before acting; stop if its hash or byte length differs.',
    `AUTOPROMPT_MISSION_BINDING: ${serializedBinding(binding)}`,
    `AUTOPROMPT_BINDING_CALL: grok-dispatch --mission ${JSON.stringify(binding.path)} --nonce ${JSON.stringify(binding.nonce)}`,
    `AUTOPROMPT_PERSONA: ${persona}`,
    `AUTOPROMPT_FRAMEWORK: ${framework === null ? 'none' : framework}`,
    `AUTOPROMPT_RUNTIME_DEPTH: parent=${parentDepth} child=${parentDepth + 1}`,
    'The dispatcher binds the canonical persona definition to this child process; dispatch further work only through the sealed Autoprompt dispatcher.',
    '',
    '## BEGIN SEALED FRAMEWORK',
    ...(frameworkBody === '' ? [] : [frameworkBody]),
    '## END SEALED FRAMEWORK',
    '',
    `## BEGIN BOUNDED TASK (utf8-bytes=${Buffer.byteLength(bounded, 'utf8')})`,
    bounded,
    '## END BOUNDED TASK',
  ].join('\n')
}

function permissionMode(env) {
  const requested = env.AUTOPROMPT_GROK_PERMISSION_MODE
  if (requested === undefined || requested === '') return 'default'
  if (requested === BYPASS_PERMISSION_MODE) {
    if (env.AUTOPROMPT_GROK_ALLOW_BYPASS === '1') return BYPASS_PERMISSION_MODE
    throw denied('bypassPermissions requires AUTOPROMPT_GROK_ALLOW_BYPASS=1')
  }
  if (!PERMISSION_MODES.includes(requested)) {
    throw denied(`unsupported permission mode: ${requested}`)
  }
  return requested
}

function optionalModel(value, label) {
  if (value === undefined || value === '') return null
  if (!MODEL_PATTERN.test(value)) throw denied(`${label} is not a safe model identifier`)
  return value
}

function optionalEffort(value) {
  if (value === undefined || value === '') return null
  if (!EFFORTS.includes(value)) throw denied(`reasoning effort must be one of ${EFFORTS.join(', ')}`)
  return value
}

// The single admission gate: canonical persona, allowlisted edge, depth ceiling,
// known framework, and a mission binding that still matches the exact ledger bytes.
function admitDispatch(request, context) {
  const topology = context.topology
  const env = context.env
  const persona = String(request.persona || '')
  if (!topology.personas[persona]) throw denied(`unknown Autoprompt persona: ${persona || '(empty)'}`)

  const task = typeof request.task === 'string' ? request.task : ''
  if (task.trim() === '') throw usage('task must be a non-empty string')

  const framework = request.framework === undefined || request.framework === null ||
    request.framework === '' || request.framework === 'none'
    ? null
    : String(request.framework)
  if (framework !== null && !topology.frameworks.has(framework)) {
    throw denied(`unknown Autoprompt framework: ${framework}`)
  }

  const instance = request.instance === undefined || request.instance === null || request.instance === ''
    ? null
    : String(request.instance)
  if (instance !== null && !INSTANCE_PATTERN.test(instance)) {
    throw denied('instance must be 1-24 lowercase letters, digits, or hyphens')
  }

  const parentDepth = parsedDepth(env.AUTOPROMPT_GROK_DEPTH)
  const callerRole = canonicalRole(env.AUTOPROMPT_GROK_PERSONA, topology)
  if (callerRole === null && parentDepth !== 0) {
    throw denied('an unnamed caller may dispatch only from depth 0')
  }
  if (callerRole !== null && parentDepth === 0) {
    throw denied(`caller ${callerRole} reports depth 0, which is reserved for the conductor`)
  }
  if (parentDepth + 1 > MAX_DEPTH) {
    throw denied(`Autoprompt depth limit reached at depth ${parentDepth}`)
  }

  const allowed = callerRole === null ? topology.rootAllowedChildren : topology.personas[callerRole]
  if (callerRole !== null && allowed.length === 0) {
    throw denied(`terminal role ${callerRole} cannot dispatch children`)
  }
  if (!allowed.includes(persona)) {
    throw denied(`child edge ${callerRole === null ? 'root' : callerRole} -> ${persona} is not allowlisted`)
  }

  const inherited = inheritedBinding(env.AUTOPROMPT_GROK_BINDING)
  const nonce = request.nonce === undefined || request.nonce === ''
    ? (inherited ? inherited.nonce : env.AUTOPROMPT_GROK_NONCE)
    : String(request.nonce)
  const missionPath = request.mission === undefined || request.mission === ''
    ? (inherited ? inherited.path : '')
    : String(request.mission)
  if (!missionPath) throw usage('a mission ledger path is required')
  const binding = missionBinding(missionPath, nonce)
  if (inherited && !sameBinding(inherited, binding)) {
    throw denied('mission binding no longer matches the exact prompt ledger of this run')
  }

  return Object.freeze({
    persona,
    instance,
    framework,
    task,
    parentDepth,
    callerRole,
    binding,
  })
}

function childCommand(admission, context) {
  const runtimeRoot = context.runtimeRoot
  const env = context.env
  const definition = personaDefinition(runtimeRoot, admission.persona)
  const envelope = buildEnvelope({
    persona: admission.persona,
    task: admission.task,
    framework: admission.framework,
    parentDepth: admission.parentDepth,
    binding: admission.binding,
    frameworkBody: frameworkText(runtimeRoot, admission.framework),
  })
  const promptFile = context.writePrompt(envelope)
  const args = [
    '-p',
    '--prompt-file', promptFile,
    '--verbatim',
    '--agent', definition,
    '--output-format', 'json',
    '--no-subagents',
    '--no-auto-update',
    '--permission-mode', permissionMode(env),
  ]
  const model = optionalModel(context.request.model || env.AUTOPROMPT_GROK_MODEL, 'model')
  if (model !== null) args.push('--model', model)
  const effort = optionalEffort(context.request.effort || env.AUTOPROMPT_GROK_EFFORT)
  if (effort !== null) args.push('--reasoning-effort', effort)
  if (context.request.maxTurns !== undefined && context.request.maxTurns !== null) {
    const turns = Number(context.request.maxTurns)
    if (!Number.isSafeInteger(turns) || turns < 1) throw denied('maxTurns must be a positive integer')
    args.push('--max-turns', String(turns))
  }

  const childEnv = {
    ...env,
    AUTOPROMPT_GROK_PERSONA: admission.instance === null
      ? admission.persona
      : `${admission.persona}--${admission.instance}`,
    AUTOPROMPT_GROK_DEPTH: String(admission.parentDepth + 1),
    AUTOPROMPT_GROK_NONCE: admission.binding.nonce,
    AUTOPROMPT_GROK_BINDING: serializedBinding(admission.binding),
    AUTOPROMPT_GROK_RUNTIME_ROOT: runtimeRoot,
    AUTOPROMPT_GROK_FRAMEWORK: admission.framework === null ? 'none' : admission.framework,
    GROK_DISABLE_AUTOUPDATER: '1',
  }
  delete childEnv.AUTOPROMPT_GROK_MODEL
  delete childEnv.AUTOPROMPT_GROK_EFFORT

  return Object.freeze({
    command: env.AUTOPROMPT_GROK_BIN || 'grok',
    args: Object.freeze(args),
    env: childEnv,
    promptFile,
    definition,
    envelope,
  })
}

function defaultRuntimeRoot(env) {
  return env.AUTOPROMPT_GROK_RUNTIME_ROOT || path.resolve(__dirname, '..')
}

function writePromptFile(envelope) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-grok-'))
  const promptFile = path.join(directory, 'dispatch-envelope.md')
  fs.writeFileSync(promptFile, envelope, { encoding: 'utf8', mode: 0o600 })
  return promptFile
}

// Public entry point: admit, seal, and run one child Grok Build process.
function dispatch(request, options = {}) {
  const env = options.env || process.env
  const runtimeRoot = options.runtimeRoot || defaultRuntimeRoot(env)
  const topology = options.topology || readTopology(path.join(runtimeRoot, 'workflow'))
  const admission = admitDispatch(request, { topology, env })
  const plan = childCommand(admission, {
    runtimeRoot,
    env,
    request,
    writePrompt: options.writePrompt || writePromptFile,
  })
  if (options.dryRun) return { admission, plan, status: null, stdout: '', stderr: '' }
  const spawn = options.spawn || childProcess.spawnSync
  const result = spawn(plan.command, [...plan.args], {
    cwd: options.cwd || process.cwd(),
    env: plan.env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error) {
    throw new DispatchError('AUTOPROMPT_DISPATCH_LAUNCH', `could not start ${plan.command}: ${result.error.message}`)
  }
  try {
    fs.rmSync(path.dirname(plan.promptFile), { recursive: true, force: true })
  } catch {}
  return {
    admission,
    plan,
    status: result.status === null || result.status === undefined ? 1 : result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  }
}

const FLAGS = Object.freeze({
  '--persona': 'persona',
  '--task': 'task',
  '--task-file': 'taskFile',
  '--framework': 'framework',
  '--instance': 'instance',
  '--mission': 'mission',
  '--nonce': 'nonce',
  '--model': 'model',
  '--effort': 'effort',
  '--max-turns': 'maxTurns',
  '--runtime-root': 'runtimeRoot',
})

function parseArgs(argv) {
  const parsed = { dryRun: false }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--dry-run') {
      parsed.dryRun = true
      continue
    }
    if (!Object.prototype.hasOwnProperty.call(FLAGS, flag)) {
      throw usage(`unknown flag: ${flag}`)
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw usage(`${flag} requires a value`)
    parsed[FLAGS[flag]] = value
    index += 1
  }
  if (parsed.task !== undefined && parsed.taskFile !== undefined) {
    throw usage('--task and --task-file are mutually exclusive')
  }
  if (parsed.taskFile !== undefined) {
    try {
      parsed.task = fs.readFileSync(parsed.taskFile, 'utf8')
    } catch (error) {
      throw usage(`--task-file is unreadable: ${error.message}`)
    }
    delete parsed.taskFile
  }
  return parsed
}

function run(argv, io = process, env = process.env) {
  let parsed
  try {
    parsed = parseArgs(argv)
  } catch (error) {
    io.stderr.write(`grok-dispatch: ${error.message}\n`)
    return 2
  }
  try {
    const result = dispatch(parsed, {
      env,
      runtimeRoot: parsed.runtimeRoot || defaultRuntimeRoot(env),
      dryRun: parsed.dryRun,
    })
    if (parsed.dryRun) {
      io.stdout.write(`${JSON.stringify({
        persona: result.admission.persona,
        framework: result.admission.framework,
        depth: result.admission.parentDepth + 1,
        command: result.plan.command,
        args: result.plan.args,
      })}\n`)
      try {
        fs.rmSync(path.dirname(result.plan.promptFile), { recursive: true, force: true })
      } catch {}
      return 0
    }
    if (result.stdout) io.stdout.write(result.stdout)
    if (result.stderr) io.stderr.write(result.stderr)
    return result.status
  } catch (error) {
    if (error instanceof DispatchError) {
      io.stderr.write(`grok-dispatch: ${error.code} ${error.message}\n`)
      return error.code === 'AUTOPROMPT_DISPATCH_USAGE' ? 2 : 3
    }
    throw error
  }
}

if (require.main === module) process.exitCode = run(process.argv.slice(2))

module.exports = {
  DispatchError,
  MAX_DEPTH,
  RUNTIME_ID,
  admitDispatch,
  buildEnvelope,
  childCommand,
  dispatch,
  missionBinding,
  parseArgs,
  readTopology,
  run,
}
