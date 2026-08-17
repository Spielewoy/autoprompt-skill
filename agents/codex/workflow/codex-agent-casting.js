#!/usr/bin/env node
'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const MANIFEST_NAME = '.autoprompt-casting.json'
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/
const MAX_EFFORT_MODELS = new Set([
  'gpt-5.6',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
])

function fail(message) {
  process.stderr.write(`codex-agent-casting: ${message}\n`)
  process.exit(2)
}

function sha256(parts) {
  const hash = crypto.createHash('sha256')
  for (const part of parts) hash.update(part)
  return `sha256:${hash.digest('hex')}`
}

function hashFile(filePath) {
  return sha256([fs.readFileSync(filePath)])
}

function listAgentFiles(agentsDirectory) {
  return fs.readdirSync(agentsDirectory)
    .filter(name => /^ap-.*\.toml$/.test(name))
    .sort()
}

function hashAgentDefinitions(agentsDirectory, names) {
  const parts = []
  for (const name of names) {
    const content = fs.readFileSync(path.join(agentsDirectory, name))
    parts.push(Buffer.from(`${Buffer.byteLength(name, 'utf8')}:`), Buffer.from(name))
    parts.push(Buffer.from(`${content.length}:`), content)
  }
  return sha256(parts)
}

function readBasicString(text, key) {
  const match = text.match(new RegExp(`^${key}\\s*=\\s*"((?:\\\\.|[^"\\\\])*)"\\s*$`, 'm'))
  if (!match) return null
  return match[1].replace(/\\([\\"])/g, '$1')
}

function readAgents(agentsDirectory) {
  if (!fs.existsSync(agentsDirectory) || !fs.statSync(agentsDirectory).isDirectory()) {
    fail(`Codex agents directory is not readable: ${agentsDirectory}`)
  }
  const files = listAgentFiles(agentsDirectory)
  if (!files.length) fail(`no ap-*.toml agent definitions found in ${agentsDirectory}`)
  return files.map(file => {
    const text = fs.readFileSync(path.join(agentsDirectory, file), 'utf8')
    return {
      file,
      model: readBasicString(text, 'model'),
      effort: readBasicString(text, 'model_reasoning_effort'),
    }
  })
}

function defaultAgentsDirectory() {
  if (process.env.CODEX_AGENTS_DIR) return process.env.CODEX_AGENTS_DIR
  if (process.env.CODEX_HOME) {
    return path.join(process.env.CODEX_HOME, 'skills', 'autoprompt', 'agents-runtime')
  }
  if (process.env.HOME) {
    return path.join(process.env.HOME, '.codex', 'skills', 'autoprompt', 'agents-runtime')
  }
  fail('CODEX_AGENTS_DIR, CODEX_HOME, or HOME is required to locate the private agent runtime')
}

function parseArgs(argv) {
  const options = {
    action: '',
    agentsDirectory: defaultAgentsDirectory(),
    sourceAgents: '',
    selector: process.env.AUTOPROMPT_AGENTS || 'off',
    registry: process.env.AUTOPROMPT_MODEL_REGISTRY || '',
  }
  const actions = ['--resolve', '--write-manifest', '--export-inheritance']
  const valueFlags = ['--agents-dir', '--source-agents', '--selector', '--registry']
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (actions.includes(argument)) {
      if (options.action) fail('choose exactly one action')
      options.action = argument.slice(2)
      continue
    }
    if (!valueFlags.includes(argument)) fail(`unknown flag ${argument}`)
    const value = argv[index + 1]
    if (value == null) fail(`${argument} requires a value`)
    index += 1
    if (argument === '--agents-dir') options.agentsDirectory = value
    if (argument === '--source-agents') options.sourceAgents = value
    if (argument === '--selector') options.selector = value
    if (argument === '--registry') options.registry = value
  }
  if (!options.action) fail('choose an action')
  return options
}

function normalizeSelector(selector) {
  const trimmed = selector.trim()
  return trimmed.toLowerCase() === 'off' ? 'off' : trimmed
}

function selectorIsOff(selector) {
  return normalizeSelector(selector) === 'off'
}

function readRegistry(registryPath) {
  if (!registryPath) return new Map()
  const parsed = JSON.parse(fs.readFileSync(registryPath, 'utf8'))
  if (!Array.isArray(parsed)) fail('model registry must be a JSON array')
  return new Map(parsed.map(entry => [entry.name, entry.modelString]))
}

function selectedModels(selector, registryPath) {
  const registry = readRegistry(registryPath)
  const normalized = normalizeSelector(selector)
  if (/^auto(?::|$)/i.test(normalized)) return null
  return normalized.split(',').map(item => {
    const name = item.trim()
    return registry.get(name) || name
  })
}

function validateAgentCast(agents, selector, registryPath) {
  if (selectorIsOff(selector)) {
    if (agents.some(agent => agent.model != null || agent.effort != null)) {
      fail('agents=off requires inheritance-only Codex agent TOMLs with no model or effort override')
    }
    return {
      enabled: false,
      models: [],
      effort: { status: 'inherited-only', source: 'session-inheritance' },
    }
  }

  if (agents.some(agent => !agent.model)) {
    fail('enabled Codex casting requires a model in every ap-*.toml agent definition')
  }
  if (agents.some(agent => !agent.effort)) {
    fail('enabled Codex casting requires model_reasoning_effort in every ap-*.toml agent definition')
  }
  const allowedEfforts = new Set(['max', 'xhigh', 'high', 'medium', 'low'])
  for (const agent of agents) {
    if (!allowedEfforts.has(agent.effort)) {
      fail(`unsupported model_reasoning_effort ${agent.effort} in ${agent.file}`)
    }
    if (agent.effort === 'max' && !MAX_EFFORT_MODELS.has(agent.model)) {
      fail(`max model_reasoning_effort requires a verified GPT-5.6 model in ${agent.file}`)
    }
  }
  const models = [...new Set(agents.map(agent => agent.model))].sort()
  const selected = selectedModels(selector, registryPath)
  if (selected) {
    const selectedSet = [...new Set(selected)].sort()
    if (selectedSet.length === 1 && (models.length !== 1 || models[0] !== selectedSet[0])) {
      fail('single-model selector requires every Codex agent role to use that exact model')
    }
    if (models.length !== selectedSet.length || models.some((model, index) => model !== selectedSet[index])) {
      fail('installed Codex agent models do not match the selected model set')
    }
  }
  return {
    enabled: true,
    models,
    effort: { status: 'selectable', source: 'codex-custom-agent-toml' },
  }
}

function makeState(options) {
  const agents = readAgents(options.agentsDirectory)
  const fileNames = agents.map(agent => agent.file)
  const cast = validateAgentCast(agents, options.selector, options.registry)
  const registryHash = options.registry ? hashFile(options.registry) : 'none'
  const agentDefinitionsHash = hashAgentDefinitions(options.agentsDirectory, fileNames)
  const castingHash = sha256([
    Buffer.from(normalizeSelector(options.selector), 'utf8'),
    Buffer.from('\0', 'utf8'),
    Buffer.from(agentDefinitionsHash, 'utf8'),
    Buffer.from('\0', 'utf8'),
    Buffer.from(registryHash, 'utf8'),
  ])
  return {
    schemaVersion: 1,
    provider: 'codex',
    selector: normalizeSelector(options.selector),
    enabled: cast.enabled,
    agents: fileNames,
    models: cast.models,
    effort: cast.effort,
    agentDefinitionsHash,
    castingHash,
    registryHash,
  }
}

function manifestPath(agentsDirectory) {
  return path.join(agentsDirectory, MANIFEST_NAME)
}

function writeManifestFile(options) {
  const state = makeState(options)
  const target = manifestPath(options.agentsDirectory)
  const temporary = `${target}.tmp-${process.pid}`
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  fs.renameSync(temporary, target)
  return state
}

function writeManifest(options) {
  process.stdout.write(`${JSON.stringify(writeManifestFile(options))}\n`)
}

function listSourcePersonas(sourceAgents) {
  if (!sourceAgents || !fs.existsSync(sourceAgents) || !fs.statSync(sourceAgents).isDirectory()) {
    fail(`source agents directory is not readable: ${sourceAgents}`)
  }
  const names = fs.readdirSync(sourceAgents)
    .filter(name => /^ap-.*\.md$/.test(name))
    .sort()
  if (!names.length) fail(`no ap-*.md source personas found in ${sourceAgents}`)
  return names
}

function readFrontmatter(sourcePath) {
  const normalized = fs.readFileSync(sourcePath, 'utf8').replace(/\r\n/g, '\n')
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) fail(`source persona is missing YAML frontmatter: ${sourcePath}`)
  const fields = {}
  const lines = match[1].split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const field = lines[index].match(
      /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/,
    )
    if (!field) fail(`source persona has malformed YAML frontmatter: ${sourcePath}`)
    const value = field[2].trim()
    if (!['>', '>-', '>+'].includes(value)) {
      fields[field[1]] = value
      continue
    }
    const folded = []
    while (index + 1 < lines.length && /^\s+/.test(lines[index + 1])) {
      index += 1
      folded.push(lines[index].trim())
    }
    fields[field[1]] = folded.join(' ')
  }
  return { fields, body: match[2] }
}

function tomlString(value) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function exportPersona(sourceAgents, agentsDirectory, sourceName) {
  const sourcePath = path.join(sourceAgents, sourceName)
  const { fields, body } = readFrontmatter(sourcePath)
  const missing = ['name', 'description', 'tools'].filter(field => !fields[field])
  if (missing.length) {
    fail(`source persona frontmatter is missing ${missing.join(', ')}: ${sourcePath}`)
  }
  const name = fields.name
  const description = fields.description
  const tools = fields.tools
  const sandbox = /(?:^|,\s*)(?:Write|Bash|Edit)(?:,|$)/i.test(tools)
    ? 'workspace-write'
    : 'read-only'
  const target = path.join(agentsDirectory, `${path.basename(sourceName, '.md')}.toml`)
  const temporary = `${target}.tmp-${process.pid}`
  const content = [
    `sandbox_mode = "${tomlString(sandbox)}"`,
    `name = "${tomlString(name)}"`,
    `description = "${tomlString(description)}"`,
    '',
    'developer_instructions = """',
    tomlString(body).replace(/"""/g, '\\"\\"\\"'),
    '"""',
    '',
  ].join('\n')
  fs.writeFileSync(temporary, content, 'utf8')
  fs.renameSync(temporary, target)
}

function readOwnedAgents(agentsDirectory) {
  const target = manifestPath(agentsDirectory)
  if (!fs.existsSync(target)) return new Set()
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(target, 'utf8'))
  } catch {
    fail('existing casting manifest is not valid JSON; refuse to replace private roles')
  }
  if (!manifest || !Array.isArray(manifest.agents) ||
      manifest.agents.some(name => !/^ap-[a-z0-9-]+\.toml$/.test(name))) {
    fail('existing casting manifest has an invalid agent set; refuse to replace private roles')
  }
  return new Set(manifest.agents)
}

function planInheritanceExport(options, sources) {
  const expected = new Set(sources.map(name => `${path.basename(name, '.md')}.toml`))
  const installed = fs.existsSync(options.agentsDirectory)
    ? listAgentFiles(options.agentsDirectory)
    : []
  const owned = readOwnedAgents(options.agentsDirectory)
  for (const name of installed) {
    if (!expected.has(name) && !owned.has(name)) {
      fail(`unowned private agent prevents exact export: ${name}`)
    }
  }
  return {
    stale: installed.filter(name => !expected.has(name) && owned.has(name)),
  }
}

function exportInheritance(options) {
  if (!selectorIsOff(options.selector)) fail('inheritance export requires selector off')
  if (!options.sourceAgents) fail('--source-agents is required for inheritance export')
  const sources = listSourcePersonas(options.sourceAgents)
  const plan = planInheritanceExport(options, sources)
  fs.mkdirSync(options.agentsDirectory, { recursive: true })
  for (const sourceName of sources) {
    exportPersona(options.sourceAgents, options.agentsDirectory, sourceName)
  }
  for (const name of plan.stale) {
    fs.unlinkSync(path.join(options.agentsDirectory, name))
  }
  process.stdout.write(`${JSON.stringify(writeManifestFile(options))}\n`)
}

function readManifest(options) {
  const target = manifestPath(options.agentsDirectory)
  const selector = normalizeSelector(options.selector)
  const configure = selector === 'off'
    ? ''
    : `, then run autoprompt configure codex --agents ${selector}${/^auto(?::|$)/i.test(selector) ? ' --model-map <absolute-json>' : ''}`
  const recovery = `run autoprompt install codex${configure}`
  if (!fs.existsSync(target)) {
    fail(`casting manifest is missing; ${recovery}`)
  }
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(target, 'utf8'))
  } catch {
    fail(`casting manifest is not valid JSON; ${recovery}`)
  }
  if (!manifest || manifest.schemaVersion !== 1 || !HASH_PATTERN.test(manifest.agentDefinitionsHash || '') ||
      !HASH_PATTERN.test(manifest.castingHash || '')) {
    fail(`casting manifest is incomplete; ${recovery}`)
  }
  return manifest
}

function resolve(options) {
  const manifest = readManifest(options)
  if (manifest.selector !== normalizeSelector(options.selector)) {
    fail('requested selector does not match the exported Codex agent cast')
  }
  const registryHash = options.registry ? hashFile(options.registry) : 'none'
  if (manifest.registryHash !== registryHash) {
    fail('model registry does not match the exported Codex agent cast')
  }
  const current = makeState(options)
  if (manifest.agentDefinitionsHash !== current.agentDefinitionsHash) {
    fail('installed Codex agent definitions do not match their casting manifest')
  }
  if (manifest.castingHash !== current.castingHash) {
    fail('Codex casting metadata does not match the installed definitions')
  }
  process.stdout.write(`${JSON.stringify(current)}\n`)
}

const options = parseArgs(process.argv.slice(2))
if (options.registry && (!fs.existsSync(options.registry) || !fs.statSync(options.registry).isFile())) {
  fail(`model registry is not readable: ${options.registry}`)
}
if (options.action === 'write-manifest') writeManifest(options)
else if (options.action === 'export-inheritance') exportInheritance(options)
else resolve(options)
