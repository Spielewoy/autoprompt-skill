#!/usr/bin/env node
'use strict'

// Sealed, fail-closed Autoprompt dispatcher for Grok Build.
//
// Grok Build caps native subagent nesting at one level: a subagent cannot call
// `spawn_subagent`. Autoprompt needs the full L0..L4 topology, so every child is
// started as its own top-level Grok Build process bound to one canonical persona
// definition through `grok --prompt-file <envelope> --agent <definition>`.
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
const ACTIVATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{15,127}$/
const DEFAULT_MAX_CONCURRENT = 6
const MAX_CONCURRENT_CEILING = 64
const EFFORT_PATTERN = /^[a-z][a-z0-9-]{0,31}$/
const CANONICAL_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max'])
const PERMISSION_MODES = Object.freeze(['default', 'acceptEdits', 'auto', 'dontAsk', 'plan'])
const BYPASS_PERMISSION_MODE = 'bypassPermissions'
const TOPOLOGY_FILE = 'autoprompt-topology.json'
// Lease ids name files under the slot root, so the shape is enforced wherever one
// arrives from disk or from the environment rather than from this process.
const LEASE_ID_PATTERN = /^[0-9a-f]{16,}$/

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

// The activation capability. Grok Build serves `~/.grok/config.toml` MCP servers to
// every session in every project, so the dispatch tool is reachable from sessions
// Autoprompt never started. The launcher mints this token, so an unnamed caller
// without it is an ordinary Grok session, never the conductor.
function activationToken(env) {
  const token = env.AUTOPROMPT_GROK_ACTIVATION
  if (typeof token !== 'string' || token === '') {
    throw denied('no Autoprompt activation is present; start the run through launch-grok')
  }
  if (!ACTIVATION_PATTERN.test(token)) {
    throw denied('the Autoprompt activation token is malformed')
  }
  return token
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

// Grok Build takes `--reasoning-effort` as a free string and remaps host aliases
// itself, so this checks the shape and lets the host reject an unknown id at
// depth 0 rather than pinning a copy of an enum that can drift.
function optionalEffort(value) {
  if (value === undefined || value === '') return null
  if (!EFFORT_PATTERN.test(value)) {
    throw denied(`reasoning effort must be a lowercase host effort id (canonical: ${CANONICAL_EFFORTS.join(', ')})`)
  }
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

  const activation = activationToken(env)
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
    activation,
  })
}

function childCommand(admission, context) {
  const runtimeRoot = context.runtimeRoot
  const env = context.env
  const definition = personaDefinition(runtimeRoot, admission.persona)
  // Everything that can be refused is resolved before the envelope is written, so
  // a rejected plan never leaves a task brief behind in the temp directory.
  const mode = permissionMode(env)
  const model = optionalModel(context.request.model || env.AUTOPROMPT_GROK_MODEL, 'model')
  const effort = optionalEffort(context.request.effort || env.AUTOPROMPT_GROK_EFFORT)
  let turns = null
  if (context.request.maxTurns !== undefined && context.request.maxTurns !== null) {
    turns = Number(context.request.maxTurns)
    if (!Number.isSafeInteger(turns) || turns < 1) throw denied('maxTurns must be a positive integer')
  }
  const envelope = buildEnvelope({
    persona: admission.persona,
    task: admission.task,
    framework: admission.framework,
    parentDepth: admission.parentDepth,
    binding: admission.binding,
    frameworkBody: frameworkText(runtimeRoot, admission.framework),
  })
  const promptFile = context.writePrompt(envelope)
  // `-p/--single` conflicts with `--prompt-file` in Grok Build's own argument
  // parser, and a prompt file alone already selects headless mode.
  const args = [
    '--prompt-file', promptFile,
    '--verbatim',
    '--agent', definition,
    '--output-format', 'json',
    '--no-subagents',
    '--no-auto-update',
    '--permission-mode', mode,
  ]
  // Each hop is a fresh top-level process, so the run model and effort have to be
  // reapplied on the command line and carried forward in the sealed environment.
  if (model !== null) args.push('--model', model)
  if (effort !== null) args.push('--reasoning-effort', effort)
  if (turns !== null) args.push('--max-turns', String(turns))

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
  if (model === null) delete childEnv.AUTOPROMPT_GROK_MODEL
  else childEnv.AUTOPROMPT_GROK_MODEL = model
  if (effort === null) delete childEnv.AUTOPROMPT_GROK_EFFORT
  else childEnv.AUTOPROMPT_GROK_EFFORT = effort

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

// Remove the envelope, then the directory only when it is left empty. A recursive
// delete of the parent would destroy a caller-supplied directory that holds more
// than this one prompt.
function cleanupPrompt(promptFile) {
  try {
    fs.rmSync(promptFile, { force: true })
  } catch {}
  try {
    fs.rmdirSync(path.dirname(promptFile))
  } catch {}
}

// The live-child ceiling for the whole run. `tokensaver` is the doctrine default
// of six; `wide` and `custom max_subs=N` raise it through the environment.
function maxConcurrent(env) {
  const requested = env.AUTOPROMPT_GROK_MAX_SUBS
  if (requested === undefined || requested === '') return DEFAULT_MAX_CONCURRENT
  if (!/^[1-9][0-9]*$/.test(String(requested))) {
    throw denied('AUTOPROMPT_GROK_MAX_SUBS must be a positive integer')
  }
  const value = Number(requested)
  if (value > MAX_CONCURRENT_CEILING) {
    throw denied(`AUTOPROMPT_GROK_MAX_SUBS may not exceed ${MAX_CONCURRENT_CEILING}`)
  }
  return value
}

// ---------------------------------------------------------------------------
// The run-global live-child ceiling.
//
// Every hop is a separate process, so a counter inside one dispatcher can only
// ever bound one group. The ceiling the modes contract promises is run-global, so
// the slots live on disk under a directory derived from the run's activation
// token: every dispatcher in the run - the conductor, each coordinator, each
// manager - competes for the same set. Slots carry the holder's pid, so a crashed
// worker's slot is reclaimed instead of shrinking the run forever.
// ---------------------------------------------------------------------------
function slotRoot(env) {
  const digest = crypto.createHash('sha256').update(activationToken(env)).digest('hex').slice(0, 16)
  const base = env.AUTOPROMPT_GROK_SLOT_ROOT || os.tmpdir()
  return path.join(base, `autoprompt-grok-slots-${digest}`)
}

// Windows is why these exist. Hard links, replace-renames, and unlinks are all
// available and atomic there (NTFS, one volume), but a scanner, an indexer, or a
// backup agent holding a handle for a moment turns any of them into a transient
// EBUSY/EPERM/EACCES. Retrying briefly keeps a sharing violation from crashing a
// dispatcher; failing loudly afterwards keeps a slot root that cannot support the
// primitives at all - a FAT, UDF, or network path handed to
// AUTOPROMPT_GROK_SLOT_ROOT - from silently degrading the ceiling instead.
const TRANSIENT_FS_CODES = Object.freeze(['EBUSY', 'EPERM', 'EACCES', 'EMFILE'])
const FS_RETRY_ATTEMPTS = 5

function pauseBriefly(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function retryTransientFs(operation) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return operation()
    } catch (error) {
      if (attempt >= FS_RETRY_ATTEMPTS || !TRANSIENT_FS_CODES.includes(error.code)) throw error
      pauseBriefly(attempt * 4)
    }
  }
}

function removeSlotFile(target) {
  try {
    retryTransientFs(() => fs.rmSync(target, { force: true }))
    return true
  } catch {
    return false
  }
}

// The one primitive both the slot and the reclaim token are built on: publish a
// fully written file at a path only if nobody has published there yet. A partial
// file must never be visible, so the payload is written elsewhere and linked into
// place. `false` means someone else got there first; anything else is a slot root
// that cannot do exclusive creation, which is a configuration error, not a race.
function claimExclusive(target, payload) {
  const staging = `${target}.staging-${process.pid}-${crypto.randomBytes(6).toString('hex')}`
  try {
    fs.writeFileSync(staging, JSON.stringify(payload))
    retryTransientFs(() => fs.linkSync(staging, target))
    return true
  } catch (error) {
    if (error.code === 'EEXIST') return false
    throw denied(
      `run slot storage at ${path.dirname(target)} cannot hold exclusive claims ` +
        `(${error.code || error.message}); point AUTOPROMPT_GROK_SLOT_ROOT at a local ` +
        'filesystem that supports hard links',
    )
  } finally {
    removeSlotFile(staging)
  }
}

// Staging and collected files are named after the process that made them, so a
// dispatcher killed mid-claim leaves litter that anyone can identify as dead and
// nobody can mistake for a slot. Swept once per acquire, never during the poll.
function sweepAbandonedSlotFiles(root) {
  let entries
  try {
    entries = fs.readdirSync(root)
  } catch {
    return
  }
  for (const entry of entries) {
    const litter = /\.(?:staging|collected)-(\d+)-[0-9a-f]+$/.exec(entry)
    if (litter === null || holderIsAlive(Number(litter[1]))) continue
    removeSlotFile(path.join(root, entry))
  }
}

function holderIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

// A slot is held by a lease, never by a bare path. A path alone cannot say who
// holds the slot now, so a stale holder releasing "its" path would evict whoever
// took that index in the meantime. Every unlink checks the lease id on disk first.
function formatSlotHandle(lease) {
  return `${lease.path}#${lease.id}`
}

function parseSlotHandle(value) {
  if (typeof value !== 'string' || value === '') return null
  const separator = value.lastIndexOf('#')
  if (separator <= 0) return null
  const lease = { path: value.slice(0, separator), id: value.slice(separator + 1) }
  return LEASE_ID_PATTERN.test(lease.id) ? lease : null
}

function readSlotRecord(slotPath) {
  try {
    const record = JSON.parse(fs.readFileSync(slotPath, 'utf8'))
    if (typeof record.leaseId !== 'string' || !Array.isArray(record.pids)) return null
    return record
  } catch {
    return null
  }
}

// Claiming is a hard link from a fully written temp file, so a slot is never
// visible half-written: a competitor that opened it mid-write would otherwise read
// an empty file, judge it corrupt, and hand the same slot to a second holder.
function claimSlotFile(slotPath) {
  const lease = { path: slotPath, id: crypto.randomBytes(12).toString('hex') }
  if (claimExclusive(slotPath, { leaseId: lease.id, pids: [process.pid], at: Date.now() })) {
    return lease
  }
  // The slot is taken. Reclaim it only when every recorded holder is provably
  // gone; anything unreadable counts as held, because guessing wrong
  // oversubscribes the run.
  const held = readSlotRecord(slotPath)
  if (held === null || held.pids.some(holderIsAlive)) return null
  reclaimDeadSlot(slotPath, held.leaseId)
  return null
}

function reclaimTokenPath(slotPath, leaseId) {
  return `${slotPath}.reclaim-${leaseId}`
}

function readReclaimToken(tokenPath) {
  try {
    const record = JSON.parse(fs.readFileSync(tokenPath, 'utf8'))
    return Number.isSafeInteger(record.reclaimedBy) ? record : null
  } catch {
    return null
  }
}

// The token must not outlive the reclaim it guards. A reclaimer killed between
// taking the token and finishing its delete would otherwise strand the slot for
// the rest of the run: the token admits nobody else, and the dead lease it guards
// can never release itself. So a token whose own reclaimer is gone is collectable,
// and collecting it has exactly one winner for the same reason the token does -
// `rename` moves the file once and every other caller gets ENOENT. A token whose
// reclaimer is still alive is left alone, exactly like a live slot holder.
function collectAbandonedReclaimToken(tokenPath) {
  const record = readReclaimToken(tokenPath)
  if (record !== null && holderIsAlive(record.reclaimedBy)) return false
  const collected = `${tokenPath}.collected-${process.pid}-${crypto.randomBytes(6).toString('hex')}`
  try {
    retryTransientFs(() => fs.renameSync(tokenPath, collected))
  } catch (error) {
    // Gone already means the generation is free to claim again, which is the same
    // answer collecting it would have given. Anything else is a live competitor.
    return error.code === 'ENOENT'
  }
  removeSlotFile(collected)
  return true
}

function takeReclaimToken(tokenPath) {
  // Two rounds at most: take the token, or collect one abandoned generation and
  // take it. A third round would mean a live competitor, which is a loss, not a
  // retry.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (claimExclusive(tokenPath, { reclaimedBy: process.pid, at: Date.now() })) return true
    if (!collectAbandonedReclaimToken(tokenPath)) return false
  }
  return false
}

// Reading a record and then unlinking the path is not a compare-and-delete: two
// reclaimers can both judge the same dead lease, one deletes it, a fresh holder
// claims the index, and the second deletes that live holder instead. So the right
// to delete a given dead generation is itself claimed atomically - the token above
// admits exactly one reclaimer per lease id, and only that reclaimer touches the
// slot. The current file can then change only through its own holder (dead, by
// definition here) or through this single reclaimer, so the re-read below is racing
// nobody. The lease id names a file, so its shape is checked before it is used.
function reclaimDeadSlot(slotPath, deadLeaseId) {
  if (typeof deadLeaseId !== 'string' || !LEASE_ID_PATTERN.test(deadLeaseId)) return false
  const token = reclaimTokenPath(slotPath, deadLeaseId)
  if (!takeReclaimToken(token)) return false
  try {
    const current = readSlotRecord(slotPath)
    if (current === null || current.leaseId !== deadLeaseId) return false
    return removeSlotFile(slotPath)
  } finally {
    removeSlotFile(token)
  }
}

// The lease is taken before the child exists, so the child's own pid is recorded
// once it does. Liveness then follows the worker, not just the dispatcher that
// started it: a dispatcher that dies while its worker runs must not free the slot.
//
// The replace is safe for the same reason the reclaim re-read is: while this
// process is alive it is a recorded holder, so no reclaimer may act on the lease,
// and the only other writer would be the holder itself.
function bindHoldersToSlot(lease, pids) {
  const holders = (Array.isArray(pids) ? pids : [pids])
    .filter(pid => Number.isSafeInteger(pid) && pid > 0)
  if (!lease || holders.length === 0) return false
  const held = readSlotRecord(lease.path)
  if (held === null || held.leaseId !== lease.id) return false
  const merged = [...new Set([...held.pids, ...holders])]
  const staging = `${lease.path}.staging-${process.pid}-${crypto.randomBytes(6).toString('hex')}`
  try {
    fs.writeFileSync(staging, JSON.stringify({ ...held, pids: merged }))
    retryTransientFs(() => fs.renameSync(staging, lease.path))
    return true
  } catch {
    removeSlotFile(staging)
    return false
  }
}

function bindChildToSlot(lease, childPid) {
  return bindHoldersToSlot(lease, [childPid])
}

function tryAcquireSlot(env, limit, options = {}) {
  const root = slotRoot(env)
  fs.mkdirSync(root, { recursive: true })
  if (options.sweep !== false) sweepAbandonedSlotFiles(root)
  for (let index = 0; index < limit; index += 1) {
    const lease = claimSlotFile(path.join(root, `slot-${index}`))
    if (lease !== null) return lease
  }
  return null
}

// Releasing is ownership-checked: a lease that no longer matches the slot on disk
// has already been yielded or reclaimed, and its holder must not evict the
// successor that legitimately took the index.
function releaseSlot(lease) {
  const held = typeof lease === 'string' ? parseSlotHandle(lease) : lease
  if (!held || !held.path) return false
  const record = readSlotRecord(held.path)
  if (record === null || record.leaseId !== held.id) return false
  const removed = removeSlotFile(held.path)
  // A reclaim token naming this lease can only be an abandoned one - some
  // reclaimer judged this lease dead while it was not - and once the lease is
  // gone it guards nothing, because lease ids are never reused. Removing it here
  // is what keeps the run's slot directory empty enough to disappear at the end.
  removeSlotFile(reclaimTokenPath(held.path, held.id))
  try {
    fs.rmdirSync(path.dirname(held.path))
  } catch {}
  return removed
}

async function acquireSlot(env, limit, options = {}) {
  const wait = options.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)))
  let delay = 25
  let sweep = true
  for (;;) {
    const lease = tryAcquireSlot(env, limit, { sweep })
    if (lease !== null) return lease
    // Litter left by dead processes is collected once per acquire, not on every
    // poll: it cannot appear while this caller waits without a competitor dying,
    // and the polling loop is the contended path.
    sweep = false
    await wait(delay)
    delay = Math.min(delay * 2, 250)
  }
}

// A dispatcher that already holds a slot must not keep it while it waits for its
// own children: six live coordinators each waiting on a worker would otherwise
// deadlock the run. It yields its slot for the wait and takes one back after,
// under a fresh lease, so the yielded index belongs to whoever claimed it next.
async function withYieldedSlot(env, limit, options, work) {
  const inherited = parseSlotHandle(env.AUTOPROMPT_GROK_SLOT)
  // The worker this slot was tracking does not change when the lease does, so its
  // pids are carried into the new generation. Otherwise the reacquired lease would
  // only record this dispatcher, and a dispatcher death would free a live worker.
  const holders = inherited ? (readSlotRecord(inherited.path)?.pids ?? []) : []
  if (inherited) {
    releaseSlot(inherited)
    delete env.AUTOPROMPT_GROK_SLOT
  }
  try {
    return await work()
  } finally {
    if (inherited) {
      const reacquired = await acquireSlot(env, limit, options)
      bindHoldersToSlot(reacquired, holders)
      env.AUTOPROMPT_GROK_SLOT = formatSlotHandle(reacquired)
    }
  }
}

// One child, started without blocking: several ready siblings must be able to run
// at the same time, which a synchronous spawn could never allow.
function startChild(plan, options = {}) {
  const spawn = options.spawn || childProcess.spawn
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(plan.command, [...plan.args], {
        cwd: options.cwd || process.cwd(),
        env: plan.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      cleanupPrompt(plan.promptFile)
      reject(new DispatchError('AUTOPROMPT_DISPATCH_LAUNCH', `could not start ${plan.command}: ${error.message}`))
      return
    }
    if (typeof options.onSpawn === 'function') options.onSpawn(child)
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', chunk => { stdout += chunk })
    child.stderr?.on('data', chunk => { stderr += chunk })
    child.on('error', error => {
      cleanupPrompt(plan.promptFile)
      reject(new DispatchError('AUTOPROMPT_DISPATCH_LAUNCH', `could not start ${plan.command}: ${error.message}`))
    })
    child.on('close', (code, signal) => {
      cleanupPrompt(plan.promptFile)
      resolve({
        status: code === null || code === undefined ? (signal ? 1 : 0) : code,
        signal: signal || null,
        stdout,
        stderr,
      })
    })
  })
}

function planDispatch(request, options = {}) {
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
  return { admission, plan }
}

// One live child inside one run-global slot. The slot is taken before the process
// starts and released the moment it exits, so the ceiling counts live workers
// across the whole run rather than per dispatcher.
async function runInSlot(plan, env, limit, options) {
  const lease = await acquireSlot(env, limit, options)
  const held = { ...plan, env: { ...plan.env, AUTOPROMPT_GROK_SLOT: formatSlotHandle(lease) } }
  try {
    return await startChild(held, {
      ...options,
      onSpawn: child => {
        bindChildToSlot(lease, child?.pid)
        if (typeof options.onSpawn === 'function') options.onSpawn(child)
      },
    })
  } finally {
    releaseSlot(lease)
  }
}

// Public entry point: admit, seal, and run one child Grok Build process.
async function dispatch(request, options = {}) {
  const env = options.env || process.env
  const { admission, plan } = planDispatch(request, options)
  if (options.dryRun) {
    return { admission, plan, status: null, signal: null, stdout: '', stderr: '' }
  }
  const limit = maxConcurrent(env)
  const result = await withYieldedSlot(
    env,
    limit,
    options,
    () => runInSlot(plan, env, limit, options),
  )
  return { admission, plan, ...result }
}

// Spawn-all-then-collect for one ready group: every job is admitted before any
// child starts, so a denied edge in the group cancels the whole group instead of
// leaving half a fleet running.
async function dispatchBatch(requests, options = {}) {
  if (!Array.isArray(requests) || requests.length === 0) {
    throw usage('a dispatch group needs at least one job')
  }
  const env = options.env || process.env
  const limit = maxConcurrent(env)
  const runtimeRoot = options.runtimeRoot || defaultRuntimeRoot(env)
  const topology = options.topology || readTopology(path.join(runtimeRoot, 'workflow'))

  // Phase one admits every job and writes nothing; phase two seals the envelopes.
  // Splitting them keeps a refused group from leaving task briefs on disk.
  const admissions = requests.map(request => admitDispatch(request, { topology, env }))
  const planned = []
  try {
    admissions.forEach((admission, index) => {
      planned.push({
        admission,
        plan: childCommand(admission, {
          runtimeRoot,
          env,
          request: requests[index],
          writePrompt: options.writePrompt || writePromptFile,
        }),
      })
    })
  } catch (error) {
    for (const entry of planned) cleanupPrompt(entry.plan.promptFile)
    throw error
  }

  if (options.dryRun) {
    return planned.map(entry => ({
      admission: entry.admission,
      plan: entry.plan,
      status: null,
      signal: null,
      stdout: '',
      stderr: '',
    }))
  }

  // Every job is queued at once and each starts as soon as the run has a free
  // live-child slot, so the group is spawn-all-then-collect under one ceiling.
  return withYieldedSlot(env, limit, options, () => Promise.all(planned.map(async entry => {
    try {
      const result = await runInSlot(entry.plan, env, limit, options)
      return { admission: entry.admission, plan: entry.plan, ...result }
    } catch (error) {
      return {
        admission: entry.admission,
        plan: entry.plan,
        status: 1,
        signal: null,
        stdout: '',
        stderr: error.message,
        error,
      }
    }
  })))
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

async function run(argv, io = process, env = process.env) {
  let parsed
  try {
    parsed = parseArgs(argv)
  } catch (error) {
    io.stderr.write(`grok-dispatch: ${error.message}\n`)
    return 2
  }
  try {
    const result = await dispatch(parsed, {
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
      cleanupPrompt(result.plan.promptFile)
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

if (require.main === module) {
  run(process.argv.slice(2)).then(code => { process.exitCode = code })
}

module.exports = {
  DispatchError,
  MAX_DEPTH,
  RUNTIME_ID,
  admitDispatch,
  buildEnvelope,
  childCommand,
  acquireSlot,
  bindChildToSlot,
  bindHoldersToSlot,
  dispatch,
  dispatchBatch,
  maxConcurrent,
  planDispatch,
  formatSlotHandle,
  parseSlotHandle,
  reclaimDeadSlot,
  reclaimTokenPath,
  releaseSlot,
  slotRoot,
  startChild,
  withYieldedSlot,
  missionBinding,
  parseArgs,
  readTopology,
  run,
}
