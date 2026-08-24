#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const AGENT_FILE_PATTERN = /^ap-[a-z0-9-]+\.toml$/
const PROFILE_SECTION_PATTERN = /^\[agents\.(ap-[a-z0-9-]+)\]$/
const ROUTE_PROFILE_LIMITS = Object.freeze({
  DIRECT: Object.freeze({ maxDepth: 2, maxLiveIncludingRoot: 4 }),
  LIGHT: Object.freeze({ maxDepth: 3, maxLiveIncludingRoot: 4 }),
  ROADMAP: Object.freeze({ maxDepth: 4, maxLiveIncludingRoot: 6, absoluteUserLiveCeiling: 10 }),
})

function fail(message) {
  throw new Error(message)
}

function positiveInteger(value, label) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(number) || number <= 0) fail(`${label} must be a positive integer`)
  return number
}

function readSettings(settingsPath) {
  if (!settingsPath) return null
  let settings
  try { settings = JSON.parse(fs.readFileSync(path.resolve(settingsPath), 'utf8')) } catch {
    fail(`settings are unreadable: ${settingsPath}`)
  }
  return settings
}

function parseArgs(argv) {
  const options = {
    action: '',
    agentsDirectory: '',
    profilePath: '',
    workspacePath: process.cwd(),
    route: process.env.AUTOPROMPT_ROUTE || null,
    maxSubs: process.env.AUTOPROMPT_MAX_SUBS || process.env.AUTOPROMPT_MAX_CONCURRENT || null,
    userLiveCeiling: process.env.AUTOPROMPT_USER_LIVE_CEILING || null,
    settingsPath: '',
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--write' || argument === '--verify') {
      if (options.action) fail('choose exactly one action')
      options.action = argument.slice(2)
      continue
    }
    if (!['--agents-dir', '--profile', '--workspace', '--route', '--max-subs', '--settings', '--user-live-ceiling'].includes(argument)) fail(`unknown flag ${argument}`)
    const value = argv[index + 1]
    if (value == null) fail(`${argument} requires a value`)
    index += 1
    if (argument === '--agents-dir') options.agentsDirectory = path.resolve(value)
    else if (argument === '--profile') options.profilePath = path.resolve(value)
    else if (argument === '--workspace') options.workspacePath = path.resolve(value)
    else if (argument === '--route') options.route = value
    else if (argument === '--max-subs') options.maxSubs = value
    else if (argument === '--user-live-ceiling') options.userLiveCeiling = value
    else options.settingsPath = path.resolve(value)
  }
  if (!options.action || !options.agentsDirectory || !options.profilePath) {
    fail('usage: codex-agent-profile.js --write|--verify --agents-dir <path> --profile <path> [--workspace <path>] [--route DIRECT|LIGHT|ROADMAP] [--max-subs N|--settings path] [--user-live-ceiling N]')
  }
  const settings = readSettings(options.settingsPath)
  if (settings) {
    const concurrency = settings.concurrency || {}
    if (options.maxSubs == null) options.maxSubs = concurrency.effectiveMaxSubs
    if (!options.route && settings.route) options.route = settings.route
  }
  if (options.route) options.route = String(options.route).trim().toUpperCase()
  return options
}

function loadManifest(agentsDirectory) {
  const manifestPath = path.join(agentsDirectory, '.autoprompt-casting.json')
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch {
    fail(`casting manifest is unreadable: ${manifestPath}`)
  }
  const agents = manifest && manifest.agents
  if (!Array.isArray(agents) || agents.length === 0 || agents.some(name => !AGENT_FILE_PATTERN.test(name))) {
    fail('casting manifest has an invalid agent set')
  }
  const sorted = [...agents].sort()
  if (new Set(sorted).size !== sorted.length) fail('casting manifest has duplicate agents')
  for (const name of sorted) {
    const agentPath = path.join(agentsDirectory, name)
    if (!fs.existsSync(agentPath) || !fs.statSync(agentPath).isFile()) {
      fail(`casting agent is missing: ${name}`)
    }
  }
  return sorted
}

function tomlString(value) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function relativeConfigPath(profilePath, agentsDirectory, agentFile) {
  const profileDirectory = path.dirname(profilePath)
  const target = path.join(agentsDirectory, agentFile)
  const relative = path.relative(profileDirectory, target)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    fail('private agents must be descendants of the profile directory')
  }
  return relative.split(path.sep).join('/')
}

function deriveProfileLimits(options = {}) {
  const route = options.route ? String(options.route).toUpperCase() : null
  if (route === null) {
    return Object.freeze({ route: null, status: 'ROUTE_PENDING', maxDepth: 1, maxConcurrentThreads: 1 })
  }
  const routeLimits = ROUTE_PROFILE_LIMITS[route]
  if (!routeLimits) fail(`unknown route: ${options.route}`)
  const requestedSubs = positiveInteger(options.maxSubs, 'max-subs')
  let liveIncludingRoot = routeLimits.maxLiveIncludingRoot
  if (route === 'ROADMAP' && options.userLiveCeiling != null) {
    liveIncludingRoot = Math.min(
      positiveInteger(options.userLiveCeiling, 'user-live-ceiling'),
      routeLimits.absoluteUserLiveCeiling,
    )
  }
  const routeChildCeiling = liveIncludingRoot - 1
  return Object.freeze({
    route,
    status: 'ROUTE_BOUND',
    maxDepth: routeLimits.maxDepth,
    maxConcurrentThreads: Math.min(requestedSubs, routeChildCeiling),
  })
}

function renderProfile(options, agents) {
  const limits = deriveProfileLimits(options)
  const lines = [
    '[agents]',
    `max_depth = ${limits.maxDepth}`,
    `max_concurrent_threads_per_session = ${limits.maxConcurrentThreads}`,
  ]
  for (const agentFile of agents) {
    const role = path.basename(agentFile, '.toml')
    lines.push(
      '',
      `[agents.${role}]`,
      `description = "Autoprompt internal role ${role}"`,
      `config_file = "${tomlString(relativeConfigPath(options.profilePath, options.agentsDirectory, agentFile))}"`,
    )
  }
  return `${lines.join('\n')}\n`
}

function writeProfile(options, agents) {
  fs.mkdirSync(path.dirname(options.profilePath), { recursive: true })
  const temporary = `${options.profilePath}.tmp-${process.pid}`
  fs.writeFileSync(temporary, renderProfile(options, agents), 'utf8')
  fs.renameSync(temporary, options.profilePath)
}

function parseProfile(profilePath) {
  const lines = fs.readFileSync(profilePath, 'utf8').split(/\r?\n/)
  const declarations = new Map()
  let role = ''
  for (const line of lines) {
    const section = line.match(PROFILE_SECTION_PATTERN)
    if (section) {
      role = section[1]
      if (declarations.has(role)) fail(`profile has duplicate role ${role}`)
      declarations.set(role, '')
      continue
    }
    if (!role) continue
    const config = line.match(/^config_file\s*=\s*"((?:\\.|[^"\\])*)"$/)
    if (config) declarations.set(role, config[1].replace(/\\([\\"])/g, '$1'))
  }
  return declarations
}

function projectConfigDirectories(workspacePath) {
  if (!workspacePath) return []
  const lineage = []
  let current = workspacePath
  while (true) {
    lineage.push(current)
    if (fs.existsSync(path.join(current, '.git'))) {
      return lineage.map(directory => path.join(directory, '.codex', 'agents'))
    }
    const parent = path.dirname(current)
    if (parent === current) {
      return [path.join(workspacePath, '.codex', 'agents')]
    }
    current = parent
  }
}

function globalCodexAgentsDirectory(environment = process.env) {
  const configured = (environment.CODEX_HOME || '').trim()
  if (configured) return path.join(path.resolve(configured), 'agents')
  const home = (environment.USERPROFILE || environment.HOME || '').trim()
  return home ? path.join(path.resolve(home), '.codex', 'agents') : ''
}

function comparableDirectory(directory) {
  let resolved = path.resolve(directory)
  try {
    resolved = fs.realpathSync.native(resolved)
  } catch {}
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function rejectProjectRoleCollisions(options, agents) {
  const privateAgents = new Set(agents)
  const globalAgents = globalCodexAgentsDirectory()
  const globalIdentity = globalAgents ? comparableDirectory(globalAgents) : ''
  for (const directory of projectConfigDirectories(options.workspacePath)) {
    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) continue
    if (globalIdentity && comparableDirectory(directory) === globalIdentity) continue
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isFile() && privateAgents.has(entry.name)) {
        fail(`project role shadows the private Autoprompt cast: ${entry.name}`)
      }
    }
  }
}

function verifyProfile(options, agents) {
  let content
  try {
    content = fs.readFileSync(options.profilePath, 'utf8')
  } catch {
    fail(`profile is unreadable: ${options.profilePath}`)
  }
  if (content !== renderProfile(options, agents)) {
    fail('profile contents do not match the casting manifest')
  }
  const expected = new Map(agents.map(agentFile => [
    path.basename(agentFile, '.toml'),
    relativeConfigPath(options.profilePath, options.agentsDirectory, agentFile),
  ]))
  const actual = parseProfile(options.profilePath)
  if (actual.size !== expected.size) fail('profile declarations do not match the casting manifest')
  for (const [role, configFile] of expected) {
    if (actual.get(role) !== configFile) fail('profile declarations do not match the casting manifest')
    const resolved = path.resolve(path.dirname(options.profilePath), actual.get(role))
    if (resolved !== path.join(options.agentsDirectory, `${role}.toml`)) {
      fail(`profile role escapes the private cast: ${role}`)
    }
  }
  rejectProjectRoleCollisions(options, agents)
}

function main(argv) {
  const options = parseArgs(argv)
  const agents = loadManifest(options.agentsDirectory)
  if (options.action === 'write') writeProfile(options, agents)
  verifyProfile(options, agents)
  process.stdout.write(`${JSON.stringify({
    profile: options.profilePath,
    agents,
    agentCount: agents.length,
    limits: deriveProfileLimits(options),
  })}\n`)
}

if (require.main === module) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`codex-agent-profile: ${error.message}\n`)
    process.exitCode = 2
  }
}

module.exports = {
  loadManifest,
  main,
  parseArgs,
  parseProfile,
  globalCodexAgentsDirectory,
  projectConfigDirectories,
  relativeConfigPath,
  deriveProfileLimits,
  ROUTE_PROFILE_LIMITS,
  renderProfile,
  verifyProfile,
  writeProfile,
}
