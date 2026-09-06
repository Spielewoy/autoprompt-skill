'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')

const root = path.resolve(__dirname, '..', '..')
const castingTool = path.join(root, 'agents', 'codex', 'workflow', 'codex-agent-casting.js')
const profileTool = path.join(root, 'agents', 'codex', 'workflow', 'codex-agent-profile.js')
const { deriveProfileLimits, relativeConfigPath } = require('../../agents/codex/workflow/codex-agent-profile.js')

test('private profile accepts dotted descendants and rejects parent escapes', () => {
  const profile = path.join(os.tmpdir(), 'autoprompt-profile', 'config.toml')
  const directory = path.dirname(profile)
  assert.equal(relativeConfigPath(profile, path.join(directory, '..agents'), 'worker.toml'), '..agents/worker.toml')
  assert.throws(() => relativeConfigPath(profile, path.dirname(directory), 'worker.toml'), /descendants/)
})

function runNode(script, args, options = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CODEX_AGENTS_DIR: os.tmpdir() },
    ...options,
  })
}

function writeAgent(directory, name, effort, model = 'gpt-5.6-luna') {
  fs.writeFileSync(path.join(directory, `${name}.toml`), [
    `model = "${model}"`,
    `model_reasoning_effort = "${effort}"`,
    'sandbox_mode = "read-only"',
    `name = "${name}"`,
    'description = "Test agent"',
    'developer_instructions = "Test"',
    '',
  ].join('\n'))
}

test('casting accepts max and all backward-compatible effort levels', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-casting-effort-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  for (const effort of ['max', 'xhigh', 'high', 'medium', 'low']) {
    writeAgent(directory, `ap-${effort}`, effort)
  }

  const result = runNode(castingTool, [
    '--write-manifest',
    '--agents-dir', directory,
    '--selector', 'gpt-5.6-luna',
  ])

  assert.equal(result.status, 0, result.stderr)
  const state = JSON.parse(result.stdout)
  assert.equal(state.enabled, true)
  assert.deepEqual(state.models, ['gpt-5.6-luna'])
})

test('casting rejects max for a model without verified max support', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-casting-unsupported-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  writeAgent(directory, 'ap-test', 'max', 'Provider/Unknown')

  const result = runNode(castingTool, [
    '--write-manifest',
    '--agents-dir', directory,
    '--selector', 'Provider/Unknown',
  ])

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /max .* requires a verified GPT-5\.6 model/i)
})

test('profile writes only the canonical concurrency key and verifies deterministically', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-profile-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const agentsDirectory = path.join(directory, 'agents-runtime')
  const profilePath = path.join(directory, 'autoprompt.config.toml')
  fs.mkdirSync(agentsDirectory)
  writeAgent(agentsDirectory, 'ap-test', 'max')
  fs.writeFileSync(path.join(agentsDirectory, '.autoprompt-casting.json'), JSON.stringify({
    agents: ['ap-test.toml'],
  }))

  const writeResult = runNode(profileTool, [
    '--write',
    '--agents-dir', agentsDirectory,
    '--profile', profilePath,
  ])
  assert.equal(writeResult.status, 0, writeResult.stderr)

  const expectedPrefix = [
    '[agents]',
    'max_depth = 1',
    'max_concurrent_threads_per_session = 1',
    '',
  ].join('\n')
  const written = fs.readFileSync(profilePath, 'utf8')
  assert.ok(written.startsWith(expectedPrefix), written)
  assert.doesNotMatch(written, /^max_threads\s*=/m)

  const verifyArgs = [
    '--verify',
    '--agents-dir', agentsDirectory,
    '--profile', profilePath,
  ]
  const firstVerify = runNode(profileTool, verifyArgs)
  const secondVerify = runNode(profileTool, verifyArgs)
  assert.equal(firstVerify.status, 0, firstVerify.stderr)
  assert.equal(secondVerify.status, 0, secondVerify.stderr)
  assert.equal(secondVerify.stdout, firstVerify.stdout)
  assert.equal(fs.readFileSync(profilePath, 'utf8'), written)

  fs.writeFileSync(
    profilePath,
    written.replace('max_concurrent_threads_per_session', 'max_threads'),
  )
  const legacyVerify = runNode(profileTool, verifyArgs)
  assert.notEqual(legacyVerify.status, 0)
  assert.match(legacyVerify.stderr, /profile .* casting manifest|concurrency/i)
})

test('profile limits stay route-pending until classification and use route caps as ceilings', () => {
  assert.deepEqual(deriveProfileLimits(), {
    route: null,
    status: 'ROUTE_PENDING',
    maxDepth: 1,
    maxConcurrentThreads: 1,
  })
  assert.deepEqual(deriveProfileLimits({ route: 'DIRECT', maxSubs: 99 }), {
    route: 'DIRECT',
    status: 'ROUTE_BOUND',
    maxDepth: 2,
    maxConcurrentThreads: 3,
  })
  assert.deepEqual(deriveProfileLimits({ route: 'LIGHT', maxSubs: 2 }), {
    route: 'LIGHT',
    status: 'ROUTE_BOUND',
    maxDepth: 3,
    maxConcurrentThreads: 2,
  })
  assert.deepEqual(deriveProfileLimits({ route: 'ROADMAP', maxSubs: 99 }), {
    route: 'ROADMAP',
    status: 'ROUTE_BOUND',
    maxDepth: 4,
    maxConcurrentThreads: 5,
  })
  assert.deepEqual(deriveProfileLimits({ route: 'ROADMAP', maxSubs: 99, userLiveCeiling: 10 }), {
    route: 'ROADMAP',
    status: 'ROUTE_BOUND',
    maxDepth: 4,
    maxConcurrentThreads: 9,
  })
})

test('profile ignores the global Codex cast but still rejects project role collisions', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-profile-scope-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const home = path.join(directory, 'home')
  const codexHome = path.join(home, '.codex')
  const globalAgents = path.join(codexHome, 'agents')
  const stageAgents = path.join(directory, 'stage', 'agents-runtime')
  const profilePath = path.join(directory, 'stage', 'autoprompt.config.toml')
  fs.mkdirSync(globalAgents, { recursive: true })
  fs.mkdirSync(stageAgents, { recursive: true })
  writeAgent(globalAgents, 'ap-test', 'max')
  writeAgent(stageAgents, 'ap-test', 'max')
  fs.writeFileSync(path.join(stageAgents, '.autoprompt-casting.json'), JSON.stringify({
    agents: ['ap-test.toml'],
  }))
  const env = {
    ...process.env,
    CODEX_AGENTS_DIR: stageAgents,
    CODEX_HOME: codexHome,
    HOME: home,
    USERPROFILE: home,
  }

  const globalResult = runNode(profileTool, [
    '--write',
    '--agents-dir', stageAgents,
    '--profile', profilePath,
  ], { cwd: home, env })
  assert.equal(globalResult.status, 0, globalResult.stderr)

  const project = path.join(directory, 'project')
  const projectAgents = path.join(project, '.codex', 'agents')
  fs.mkdirSync(path.join(project, '.git'), { recursive: true })
  fs.mkdirSync(projectAgents, { recursive: true })
  writeAgent(projectAgents, 'ap-test', 'max')
  const projectResult = runNode(profileTool, [
    '--verify',
    '--agents-dir', stageAgents,
    '--profile', profilePath,
    '--workspace', project,
  ], { env })
  assert.notEqual(projectResult.status, 0)
  assert.match(projectResult.stderr, /project role shadows the private Autoprompt cast: ap-test\.toml/)
})
