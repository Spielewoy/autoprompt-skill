#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const PRIME_ROOT = path.join(ROOT, 'agents', 'prime')
const PRIME_DISPATCHER = path.join(PRIME_ROOT, 'skills', 'autoprompt', 'src', 'autoprompt', '__init__.py')
const CONTRACT = require('../../agents/contracts/autoprompt.contract.json')
const OFFICIAL = require('../fixtures/providers/prime/official-v0.7.2-contract.json')
const { renderOutputs } = require('../../scripts/generate-provider-contracts.cjs')
const { renderManifests } = require('../../scripts/runtime-payload.cjs')

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8').replace(/\r\n/g, '\n')
}

function filesBelow(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name)
    return entry.isDirectory() ? filesBelow(target) : [target]
  })
}

function spawnPython(args) {
  const candidates = process.platform === 'win32'
    ? [['python', []], ['py', ['-3']]]
    : [['python3', []], ['python', []]]
  let completed
  for (const [command, prefix] of candidates) {
    completed = childProcess.spawnSync(command, [...prefix, ...args], { cwd: ROOT, encoding: 'utf8' })
    if (completed.error?.code !== 'ENOENT') break
  }
  assert.ok(completed, 'Python 3 is required')
  assert.equal(completed.status, 0, completed.stderr || completed.stdout)
  return completed
}

function sealedPrimePrompt({ missionPath, persona, framework = 'plan-scope' }) {
  const script = [
    'import importlib.util, sys',
    'sys.dont_write_bytecode = True',
    'spec = importlib.util.spec_from_file_location("autoprompt_prime_envelope", sys.argv[1])',
    'module = importlib.util.module_from_spec(spec)',
    'sys.modules[spec.name] = module',
    'spec.loader.exec_module(module)',
    'binding = module.bind(sys.argv[2], nonce="prime-extension-fixture-0001")',
    'sys.stdout.buffer.write(module._sealed_prompt(sys.argv[3], "bounded task", sys.argv[4], 1, binding).encode("utf-8"))',
  ].join('; ')
  return spawnPython(['-c', script, PRIME_DISPATCHER, missionPath, persona, framework]).stdout
}

test('Prime contract is pinned to the inspected official v0.7.2 API', () => {
  const prime = CONTRACT.providers.prime
  assert.equal(prime.status, 'supported')
  assert.equal(prime.target, OFFICIAL.packageVersion)
  assert.equal(prime.packagePeerRange, OFFICIAL.extensionPeerRange)
  assert.equal(prime.official.commit, OFFICIAL.commit)
  assert.equal(prime.profile.model, 'inherit')
  assert.equal(prime.runtimePrerequisites.rlmMaxDepth, 4)
  assert.ok(prime.capabilities.includes('python-backed-dispatch'))
  assert.ok(prime.capabilities.includes('extension-system-prompts'))
  assert.ok(prime.capabilities.includes('native-rlm-subagents'))
  assert.ok(prime.capabilities.includes('recursive-subagents'))
  assert.ok(prime.capabilities.includes('sealed-envelope-persona-admission'))
  assert.ok(OFFICIAL.extension.beforeAgentStartFields.includes('prompt'))
  assert.equal(OFFICIAL.extension.handlerSessionIdentity, 'ctx.sessionManager.getSessionName')
  assert.equal(/full/i.test(prime.status), false)
})

test('canonical generation creates one native Prime package with 25 personas and 18 framework prompts', () => {
  const outputs = renderOutputs(ROOT)
  const primeOutputs = [...outputs.keys()].filter(file => file.startsWith('agents/prime/'))
  assert.equal(primeOutputs.filter(file => /^agents\/prime\/personas\/ap-.*\.md$/.test(file)).length, 25)
  assert.equal(primeOutputs.filter(file => file.startsWith('agents/prime/prompts/frameworks/')).length, 18)
  assert.ok(primeOutputs.includes('agents/prime/package.json'))
  assert.ok(primeOutputs.includes('agents/prime/extensions/autoprompt.ts'))
  assert.ok(primeOutputs.includes('agents/prime/skills/autoprompt/SKILL.md'))
  assert.ok(primeOutputs.includes('agents/prime/skills/autoprompt/pyproject.toml'))
  assert.ok(primeOutputs.includes('agents/prime/skills/autoprompt/src/autoprompt/__init__.py'))

  const skill = read('agents/prime/skills/autoprompt/SKILL.md')
  assert.match(skill, /autoprompt\.bind\(/)
  assert.match(skill, /AUTOPROMPT-RUN-MARKER/)
  assert.match(skill, /autoprompt\.dispatch\(/)

  for (const persona of CONTRACT.personas) {
    const generated = read(`agents/prime/personas/${persona.id}.md`)
    assert.match(
      generated,
      new RegExp(`^\\s*You are \\*\\*${persona.id}\\*\\*`, 'u'),
      persona.id,
    )
    assert.doesNotMatch(generated, /^---\n/u, persona.id)
  }
  for (const framework of CONTRACT.frameworks) {
    const generated = read(`agents/prime/prompts/frameworks/${framework.id}.md`)
    assert.match(generated, /^---\ndescription: /)
    assert.ok(generated.replace(/^---\n[\s\S]*?\n---\n/, '').trim().length > 0, framework.id)
  }
})

test('Prime package manifest uses only official resource keys and the official bundled-peer range', () => {
  const manifest = JSON.parse(read('agents/prime/package.json'))
  assert.equal(manifest.type, 'module')
  assert.ok(manifest.keywords.includes('pi-package'))
  assert.deepEqual(Object.keys(manifest.pi).sort(), OFFICIAL.resources.sort())
  assert.deepEqual(manifest.pi, {
    extensions: ['./extensions/autoprompt.ts'],
    skills: ['./skills/autoprompt'],
    prompts: ['./prompts/frameworks'],
  })
  assert.deepEqual(manifest.peerDependencies, {
    '@earendil-works/pi-coding-agent': OFFICIAL.extensionPeerRange,
  })
})

test('Prime extension rejects raw ap-* impersonation and binds only internally consistent sealed dispatches', {
  skip: Number(process.versions.node.split('.')[0]) < 22
    ? 'Prime Agent loads TypeScript; Node 20 has no native type stripping'
    : false,
}, async () => {
  const extensionSource = read('agents/prime/extensions/autoprompt.ts')
  assert.match(extensionSource, /readFileSync\(join\(PERSONA_ROOT, `\$\{id\}\.md`\), "utf8"\)\.replace\(\/\\r\\n\/g, "\\n"\)/)
  assert.match(extensionSource, /readFileSync\(join\(FRAMEWORK_ROOT, `\$\{id\}\.md`\), "utf8"\)\.replace\(\/\\r\\n\/g, "\\n"\)\.trim\(\)/)
  const extensionUrl = `${pathToFileURL(path.join(PRIME_ROOT, 'extensions', 'autoprompt.ts')).href}?test=${Date.now()}`
  const extension = await import(extensionUrl)
  const handlers = new Map()
  let sessionName = 'ap-reviewer--lane-a'
  let sessionId = 'reviewer-session'
  const fakePi = {
    on: (event, handler) => handlers.set(event, handler),
  }
  extension.default(fakePi)
  const handler = handlers.get('before_agent_start')
  assert.equal(typeof handler, 'function')

  const context = {
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionName: () => sessionName,
    },
  }
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-prime-extension-'))
  const missionPath = path.join(fixtureRoot, 'PROMPTS.txt')
  try {
    fs.writeFileSync(missionPath, 'exact extension mission\n')
    const baseEvent = { prompt: 'raw unmanaged task', systemPrompt: 'Prime base system prompt' }
    const raw = await handler(baseEvent, context)
    assert.match(raw.systemPrompt, /AUTOPROMPT PERSONA ACTIVATION DENIED/)
    assert.doesNotMatch(raw.systemPrompt, /# SEALED AUTOPROMPT PERSONA/)

    const prompt = sealedPrimePrompt({ missionPath, persona: 'ap-reviewer' })
    const reviewer = await handler({ ...baseEvent, prompt }, context)
    assert.match(reviewer.systemPrompt, /Prime base system prompt/)
    assert.match(reviewer.systemPrompt, /ap-reviewer/)
    assert.match(reviewer.systemPrompt, /# SEALED AUTOPROMPT PERSONA/)
    assert.match(reviewer.systemPrompt, /autoprompt\.dispatch/)

    const followup = await handler({ ...baseEvent, prompt: 'continue the admitted task' }, context)
    assert.match(followup.systemPrompt, /# SEALED AUTOPROMPT PERSONA/)

    sessionId = 'raw-same-name-after-admission'
    const secondRaw = await handler(baseEvent, context)
    assert.match(secondRaw.systemPrompt, /AUTOPROMPT PERSONA ACTIVATION DENIED/)
    assert.doesNotMatch(secondRaw.systemPrompt, /# SEALED AUTOPROMPT PERSONA/)

    for (const [label, tampered] of [
      ['persona', prompt.replace('AUTOPROMPT_PERSONA: ap-reviewer', 'AUTOPROMPT_PERSONA: ap-juror')],
      ['framework', prompt.replace('AUTOPROMPT_FRAMEWORK: plan-scope', 'AUTOPROMPT_FRAMEWORK: polish')],
      ['binding', prompt.replace(/"sha256":"[0-9a-f]{64}"/, `"sha256":"${'0'.repeat(64)}"`)],
    ]) {
      sessionId = `tampered-${label}`
      const denied = await handler({ ...baseEvent, prompt: tampered }, context)
      assert.match(denied.systemPrompt, /AUTOPROMPT PERSONA ACTIVATION DENIED/, label)
      assert.doesNotMatch(denied.systemPrompt, /# SEALED AUTOPROMPT PERSONA/, label)
    }

    sessionId = 'reviewer-session'
    fs.writeFileSync(missionPath, 'mission changed after admission\n')
    const stale = await handler({ ...baseEvent, prompt: 'continue after mutation' }, context)
    assert.match(stale.systemPrompt, /AUTOPROMPT PERSONA ACTIVATION DENIED/)
    assert.doesNotMatch(stale.systemPrompt, /# SEALED AUTOPROMPT PERSONA/)

    sessionName = 'ordinary-session'
    sessionId = 'ordinary-session-id'
    assert.equal(await handler(baseEvent, context), undefined)
    assert.equal(extension.PERSONA_IDS.length, 25)
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('Python dispatcher exhaustively proves names, topology, depth, model inheritance, and terminal denial', () => {
  const fixture = path.join(ROOT, 'tests', 'fixtures', 'providers', 'prime', 'test_dispatcher.py')
  const completed = spawnPython([fixture])
  assert.match(completed.stderr + completed.stdout, /OK/)
})

test('Prime runtime manifest packages exactly the native adapter resources', () => {
  const manifest = renderManifests(ROOT).get('agents/manifests/prime-runtime.json')
  assert.ok(manifest)
  assert.equal(manifest.provider, 'prime')
  assert.equal(manifest.sourceRoot, 'agents/prime')
  assert.equal(manifest.files.filter(file => /^personas\/ap-.*\.md$/.test(file)).length, 25)
  assert.equal(manifest.files.filter(file => file.startsWith('prompts/frameworks/')).length, 18)
  assert.ok(manifest.files.includes('extensions/autoprompt.ts'))
  assert.ok(manifest.files.includes('skills/autoprompt/src/autoprompt/__init__.py'))
  assert.deepEqual([...manifest.files].sort(), manifest.files)
  assert.deepEqual(Object.keys(manifest.sha256), manifest.files)
})

test('Prime package inventory has no unmanifested provider files', () => {
  const manifest = require('../../agents/manifests/prime-runtime.json')
  const actual = filesBelow(PRIME_ROOT)
    .map(file => path.relative(PRIME_ROOT, file).split(path.sep).join('/'))
    .sort()
  assert.deepEqual(actual, manifest.files)
})

function pathToFileURL(file) {
  const resolved = path.resolve(file).replaceAll('\\', '/')
  return new URL(`file:///${resolved.replace(/^\//, '')}`)
}
