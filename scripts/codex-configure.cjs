#!/usr/bin/env node
'use strict'

const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const operationLock = require('./install/operation-lock.cjs')

const PACKAGE_ROOT = path.resolve(__dirname, '..')
const RECEIPT = '.autoprompt-install-receipt.json'
const HASHES = '.autoprompt-install-hashes.json'
const AGENT_PATTERN = /^ap-[a-z0-9-]+\.toml$/
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/
const TIERS = Object.freeze([
  ['ap-scope-coordinator', 'ap-feature-coordinator', 'ap-sweep-coordinator', 'ap-manager'],
  ['ap-reviewer', 'ap-fresh-verifier', 'ap-verifier', 'ap-juror', 'ap-goal-checker', 'ap-depth-prober', 'ap-arbiter', 'ap-framework-validator', 'ap-re-anchor'],
  ['ap-implementer', 'ap-planner', 'ap-researcher', 'ap-scoper', 'ap-synthesizer', 'ap-execharness-resolver', 'ap-framework-generator'],
  ['ap-preflight-probe', 'ap-intake', 'ap-scribe'],
  ['ap-sweeper', 'ap-janitor'],
])
const EFFORTS = ['xhigh', 'high', 'high', 'medium', 'low']
const ROLE_TIER = new Map(TIERS.flatMap((roles, tier) => roles.map(role => [role, tier])))

class ConfigureError extends Error {}

function fail(message) { throw new ConfigureError(message) }
function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex') }
function comparable(file) {
  let resolved = path.resolve(file)
  try { resolved = fs.realpathSync.native(resolved) } catch {}
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}
function isWithin(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}
function readJson(file, label) {
  let parsed
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { fail(`${label} is unreadable: ${file}`) }
  return parsed
}
function readableRegularFile(file, label) {
  let stat
  try { stat = fs.lstatSync(file) } catch { fail(`${label} is missing: ${file}`) }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} is not a regular file: ${file}`)
}
function resolveRoot(env) {
  const home = env.HOME || env.USERPROFILE || os.homedir()
  const raw = env.AUTOPROMPT_INSTALL_ROOT || env.CODEX_HOME || path.join(home, '.codex')
  if (!raw || raw.includes('\0') || !path.isAbsolute(raw) || raw.split(/[\\/]/).includes('..')) {
    fail('Codex root must be an absolute path without traversal')
  }
  const root = path.resolve(raw)
  if (root === path.parse(root).root) fail('filesystem root is not a valid Codex root')
  let stat
  try { stat = fs.lstatSync(root) } catch { fail(`Codex root is not installed: ${root}`) }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Codex root must be a real directory')
  return root
}
function parseModelList(value) {
  const models = String(value).split(',').map(item => item.trim())
  if (!models.length || models.some(model => !MODEL_PATTERN.test(model))) fail('agents selector contains an invalid model identifier')
  if (new Set(models).size !== models.length) fail('agents selector contains duplicate models')
  if (models.length > 5) fail('Codex supports at most five selected models')
  return models
}
function readModelMap(modelMap) {
  if (!modelMap || !path.isAbsolute(modelMap)) fail('agents=auto requires an absolute readable --model-map')
  readableRegularFile(path.resolve(modelMap), 'model map')
  const parsed = readJson(modelMap, 'model map')
  if (!Array.isArray(parsed) || !parsed.length) fail('model map must be a non-empty JSON array')
  const seenNames = new Set()
  const seenModels = new Set()
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string' || !entry.name ||
        typeof entry.modelString !== 'string' || !MODEL_PATTERN.test(entry.modelString)) {
      fail(`model map entry ${index + 1} is invalid`)
    }
    if (seenNames.has(entry.name) || seenModels.has(entry.modelString)) fail('model map names and model strings must be unique')
    seenNames.add(entry.name); seenModels.add(entry.modelString)
    const effort = entry.effortHint || 'medium'
    if (!['max', 'high', 'medium', 'low'].includes(effort)) fail(`model map entry ${entry.name} has an invalid effortHint`)
    return { name: entry.name, model: entry.modelString, effort, index }
  })
}
function resolveSelector(selector, modelMap) {
  const value = String(selector || '').trim()
  if (value.toLowerCase() === 'off') {
    if (modelMap) fail('--model-map is only valid with agents=auto')
    return { selector: 'off', models: [], registry: '' }
  }
  if (!/^auto(?::|$)/i.test(value)) {
    if (modelMap) fail('--model-map is only valid with agents=auto')
    return { selector: value, models: parseModelList(value), registry: '' }
  }
  const entries = readModelMap(modelMap)
  const pool = value.includes(':') ? value.slice(value.indexOf(':') + 1) : ''
  let selected = entries
  if (pool.trim()) {
    const names = pool.split(',').map(name => name.trim())
    if (names.some(name => !name) || new Set(names).size !== names.length) fail('agents=auto pool is invalid')
    const byName = new Map(entries.map(entry => [entry.name, entry]))
    selected = names.map(name => byName.get(name) || fail(`unknown model map name: ${name}`))
  }
  if (selected.length > 5) fail('Codex supports at most five selected models')
  const weights = { max: 0, high: 1, medium: 2, low: 3 }
  selected = [...selected].sort((a, b) => weights[a.effort] - weights[b.effort] || a.index - b.index)
  return {
    selector: pool.trim() ? `auto:${pool}` : 'auto',
    models: selected.map(entry => entry.model),
    registry: path.resolve(modelMap),
  }
}
function modelIndexes(count) {
  return ({ 1: [0, 0, 0, 0, 0], 2: [0, 0, 1, 1, 1], 3: [0, 1, 1, 2, 2], 4: [0, 1, 2, 3, 3], 5: [0, 1, 2, 3, 4] })[count]
}
function renderAgent(bytes, role, selection) {
  const text = bytes.toString('utf8')
  const marker = 'developer_instructions = """'
  const markerIndex = text.indexOf(marker)
  if (markerIndex < 0) fail(`agent definition is malformed: ${role}.toml`)
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  let header = text.slice(0, markerIndex)
  const body = text.slice(markerIndex)
  header = header.split(/\r?\n/)
    .filter(line => !/^(?:model|model_reasoning_effort)\s*=/.test(line))
  while (header.at(-1) === '') header.pop()
  if (selection.models.length) {
    const tier = ROLE_TIER.get(role)
    if (tier === undefined) fail(`installed role has no Codex casting tier: ${role}`)
    const model = selection.models[modelIndexes(selection.models.length)[tier]]
    const sandbox = header.findIndex(line => /^sandbox_mode\s*=/.test(line))
    if (sandbox < 0) fail(`agent definition has no sandbox_mode: ${role}.toml`)
    header.splice(sandbox + 1, 0, `model = "${model}"`, `model_reasoning_effort = "${EFFORTS[tier]}"`)
  }
  return Buffer.from(`${header.join(newline)}${newline}${newline}${body}`, 'utf8')
}
function runTool(script, args, options) {
  const result = childProcess.spawnSync(process.execPath, [script, ...args], {
    cwd: options.root, encoding: 'utf8', env: { ...options.env, HOME: options.env.HOME || options.env.USERPROFILE || options.root }, shell: false,
  })
  if (result.status !== 0) fail(String(result.stderr || result.stdout || `validator failed (${result.status})`).trim())
}
function atomicWrite(file, bytes, suffix, options) {
  const temporary = `${file}.autoprompt-configure-${suffix}`
  const { guard, index, phase, renameHook } = options
  guard.assertExisting(file, 'file')
  guard.assertParent(temporary)
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: fs.statSync(file).mode })
    guard.assertExisting(temporary, 'file')
    if (renameHook) renameHook({ file, index, phase, temporary })
    guard.assertExisting(file, 'file')
    fs.renameSync(temporary, file)
  } finally {
    if (fs.existsSync(temporary)) {
      guard.assertExisting(temporary, 'file')
      fs.unlinkSync(temporary)
    }
  }
}
function configureCodex(options = {}) {
  const env = options.env || process.env
  const packageRoot = options.packageRoot || PACKAGE_ROOT
  const root = resolveRoot(env)
  const guard = new operationLock.RootGuard(root)
  const lease = operationLock.acquire(root, 'configure-codex', { guard })
  try {
    const selection = resolveSelector(options.selector, options.modelMap || '')
    const agentsDirectory = path.join(root, 'skills', 'autoprompt', 'agents-runtime')
    const castingPath = path.join(agentsDirectory, '.autoprompt-casting.json')
    const profilePath = path.join(root, 'autoprompt.config.toml')
    const receiptPath = path.join(root, RECEIPT)
    const hashesPath = path.join(root, HASHES)
    for (const [file, label] of [[receiptPath, 'install receipt'], [hashesPath, 'hash manifest'], [castingPath, 'casting manifest'], [profilePath, 'Codex profile']]) {
      try { guard.assertExisting(file, 'file') } catch (error) { fail(`${label} failed physical containment: ${error.message}`) }
    }
    const receipt = readJson(receiptPath, 'install receipt')
    if (!Array.isArray(receipt.files)) fail('install receipt has no managed file inventory')
    const owned = new Set(receipt.files.map(comparable))
    const casting = readJson(castingPath, 'casting manifest')
    if (!Array.isArray(casting.agents) || !casting.agents.length || casting.agents.some(name => !AGENT_PATTERN.test(name)) || new Set(casting.agents).size !== casting.agents.length) fail('casting manifest has an invalid agent inventory')
    const declaredAgents = new Set(casting.agents)
    const undeclared = fs.readdirSync(agentsDirectory).filter(name => AGENT_PATTERN.test(name) && !declaredAgents.has(name))
    if (undeclared.length) fail(`unowned Codex agent collision: ${undeclared.join(', ')}`)
    const agentPaths = [...casting.agents].sort().map(name => path.join(agentsDirectory, name))
    const targets = [...agentPaths, castingPath, profilePath]
    for (const file of [...targets, hashesPath]) {
      if (!owned.has(comparable(file))) fail(`target is not receipt-owned: ${file}`)
      try { guard.assertExisting(file, 'file') } catch (error) { fail(`receipt-owned target failed physical containment: ${error.message}`) }
    }
    const hashes = readJson(hashesPath, 'hash manifest')
    if (!hashes || typeof hashes !== 'object' || Array.isArray(hashes)) fail('hash manifest is invalid')
    const hashKeys = new Map(Object.keys(hashes).map(key => [comparable(key), key]))
    for (const file of targets) {
      const key = hashKeys.get(comparable(file))
      if (!key || !/^[a-f0-9]{64}$/.test(hashes[key]) || sha256(fs.readFileSync(file)) !== hashes[key]) fail(`receipt-owned target has drift: ${file}`)
    }

    guard.assertRoot()
    const stage = fs.mkdtempSync(path.join(root, '.autoprompt-configure-'))
    const stageAgents = path.join(stage, 'skills', 'autoprompt', 'agents-runtime')
    const stageProfile = path.join(stage, 'autoprompt.config.toml')
    try {
      guard.assertExisting(stage, 'directory')
      const originals = new Map([...targets, hashesPath].map(file => [file, fs.readFileSync(file)]))
      fs.mkdirSync(stageAgents, { recursive: true })
    for (const file of agentPaths) {
      const role = path.basename(file, '.toml')
      fs.writeFileSync(path.join(stageAgents, path.basename(file)), renderAgent(fs.readFileSync(file), role, selection))
    }
    if (selection.models.length) {
      for (const name of casting.agents) {
        const staged = fs.readFileSync(path.join(stageAgents, name), 'utf8')
        if (!/^model\s*=\s*"/m.test(staged) || !/^model_reasoning_effort\s*=\s*"/m.test(staged)) {
          fail(`staged agent is missing casting fields: ${name}`)
        }
      }
    }
    const castingTool = path.join(packageRoot, 'agents', 'codex', 'workflow', 'codex-agent-casting.js')
    const profileTool = path.join(packageRoot, 'agents', 'codex', 'workflow', 'codex-agent-profile.js')
    const registryArgs = selection.registry ? ['--registry', selection.registry] : []
    runTool(castingTool, ['--write-manifest', '--agents-dir', stageAgents, '--selector', selection.selector, ...registryArgs], { env, root })
    runTool(profileTool, ['--write', '--agents-dir', stageAgents, '--profile', stageProfile, '--workspace', root], { env, root })
    runTool(castingTool, ['--resolve', '--agents-dir', stageAgents, '--selector', selection.selector, ...registryArgs], { env, root })
    runTool(profileTool, ['--verify', '--agents-dir', stageAgents, '--profile', stageProfile, '--workspace', root], { env, root })
    const desired = new Map(agentPaths.map(file => [file, fs.readFileSync(path.join(stageAgents, path.basename(file)))]))
    desired.set(castingPath, fs.readFileSync(path.join(stageAgents, '.autoprompt-casting.json')))
    desired.set(profilePath, fs.readFileSync(stageProfile))
    const nextHashes = { ...hashes }
    for (const [file, bytes] of desired) nextHashes[hashKeys.get(comparable(file))] = sha256(bytes)
    desired.set(hashesPath, Buffer.from(`${JSON.stringify(nextHashes, null, 2)}\n`))
    const unchanged = [...desired].every(([file, bytes]) => originals.get(file).equals(bytes))
    if (unchanged) return { status: 'unchanged', selector: selection.selector, models: selection.models, agents: agentPaths.length }
      const committed = []
      const suffix = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`
      try {
        for (const [file, bytes] of desired) {
          const index = committed.length + 1
          atomicWrite(file, bytes, suffix, { guard, index, phase: 'commit', renameHook: options.renameHook })
          committed.push(file)
          if (options.faultAfterRename === committed.length) throw new Error('injected commit failure')
        }
        runTool(castingTool, ['--resolve', '--agents-dir', agentsDirectory, '--selector', selection.selector, ...registryArgs], { env, root })
        runTool(profileTool, ['--verify', '--agents-dir', agentsDirectory, '--profile', profilePath, '--workspace', root], { env, root })
      } catch (error) {
        const rollbackErrors = []
        let rollbackIndex = 0
        for (const file of committed.reverse()) {
          rollbackIndex += 1
          try {
            atomicWrite(file, originals.get(file), `${suffix}-rollback`, {
              guard, index: rollbackIndex, phase: 'rollback', renameHook: options.renameHook,
            })
          } catch (rollbackError) {
            rollbackErrors.push(`${file}: ${rollbackError.message}`)
          }
        }
        if (rollbackErrors.length) {
          throw new Error(`${error.message}; rollback errors: ${rollbackErrors.join('; ')}`)
        }
        throw error
      }
      return { status: 'updated', selector: selection.selector, models: selection.models, agents: agentPaths.length }
    } finally {
      guard.assertExisting(stage, 'directory')
      fs.rmSync(stage, { recursive: true, force: true })
    }
  } finally {
    operationLock.release(lease)
  }
}
function run(options = {}) {
  const stdout = options.stdout || process.stdout
  const stderr = options.stderr || process.stderr
  try {
    const result = configureCodex(options)
    stdout.write(`Autoprompt Codex configured: status=${result.status} selector=${result.selector} models=${result.models.length} agents=${result.agents}\n`)
    return 0
  } catch (error) {
    stderr.write(`Autoprompt configure (codex): ${error.message}\n`)
    return error instanceof ConfigureError ? 1 : 1
  }
}

if (require.main === module) process.exitCode = run({ selector: process.argv[2], modelMap: process.argv[3] || '' })
module.exports = { ConfigureError, configureCodex, renderAgent, resolveSelector, run }
