#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const CONTRACT = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'agents', 'contracts', 'autoprompt.contract.json'),
  'utf8',
))
const MANIFEST = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'agents', 'manifests', 'grok-runtime.json'),
  'utf8',
))
const RUNTIME_ROOT = path.join(ROOT, 'agents', 'grok')
const dispatcher = require(path.join(RUNTIME_ROOT, 'workflow', 'grok-dispatch.js'))
const server = require(path.join(RUNTIME_ROOT, 'workflow', 'grok-dispatch-server.js'))
const grokConfig = require(path.join(ROOT, 'scripts', 'install', 'grok-config.cjs'))

const NONCE = 'RUN-GROK-0001'

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8').replace(/\r\n/g, '\n')
}

function frontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text)
  assert.ok(match, 'agent definition must start with YAML frontmatter')
  const header = {}
  for (const line of match[1].split('\n')) {
    const parsed = /^([A-Za-z][A-Za-z0-9-]*): (.*)$/.exec(line)
    assert.ok(parsed, `unparsable frontmatter line: ${line}`)
    const raw = parsed[2]
    header[parsed[1]] = raw.startsWith('"') ? JSON.parse(raw) : raw
  }
  return header
}

function sandbox(prefix = 'autoprompt-grok-dispatch-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const mission = path.join(root, 'PROMPTS.txt')
  fs.writeFileSync(mission, 'the exact mission ledger\n')
  return { root, mission }
}

function baseEnv(overrides = {}) {
  return { AUTOPROMPT_GROK_BIN: 'grok-under-test', ...overrides }
}

function dispatch(request, env, options = {}) {
  return dispatcher.dispatch(request, {
    env,
    runtimeRoot: RUNTIME_ROOT,
    dryRun: true,
    writePrompt: envelope => {
      const target = path.join(options.promptRoot || os.tmpdir(), `envelope-${crypto.randomUUID()}.md`)
      fs.writeFileSync(target, envelope)
      return target
    },
    ...options,
  })
}

function denial(request, env, options = {}) {
  try {
    dispatch(request, env, options)
  } catch (error) {
    assert.ok(error instanceof dispatcher.DispatchError, `unexpected error type: ${error}`)
    return error
  }
  assert.fail(`dispatch was admitted: ${JSON.stringify(request)}`)
}

test('the Grok Build contract records the source-checked runtime it targets', () => {
  const provider = CONTRACT.providers.grok
  assert.equal(provider.status, 'supported')
  assert.equal(provider.target, '1.0.5')
  assert.equal(provider.official.repository, 'https://github.com/xai-org/grok-build.git')
  assert.match(provider.official.sourceRevision, /^[0-9a-f]{40}$/)
  assert.equal(provider.profile.model, 'inherit')
  assert.equal(provider.runtimePrerequisites.maxDepth, 4)
  assert.ok(provider.capabilities.includes('sealed-headless-dispatch'))
  assert.ok(provider.capabilities.includes('process-level-recursion'))
  assert.ok(provider.allowedDeltas.includes('mcp-dispatch-registration'))
})

test('every persona ships a native definition that denies the native task tool', () => {
  const dispatchTool = 'mcp__autoprompt__dispatch'
  for (const persona of CONTRACT.personas) {
    const source = read(`agents/grok/agents/${persona.id}.md`)
    const header = frontmatter(source)
    assert.equal(header.name, persona.id, persona.id)
    assert.equal(header.model, 'inherit', persona.id)
    assert.equal(header.promptMode, 'extend', persona.id)
    assert.equal(header.mcpInheritance, 'none', persona.id)
    assert.equal(header.discoverSkills, 'false', persona.id)
    assert.equal(header.inheritSkills, 'false', persona.id)
    assert.equal(header.permissionMode, 'default', persona.id)
    assert.doesNotMatch(source, /[–—]/, `${persona.id} must use ASCII punctuation`)

    const tools = header.tools.split(', ').filter(Boolean)
    const disallowed = header.disallowedTools.split(', ').filter(Boolean)
    assert.ok(tools.length > 0, `${persona.id} needs a closed allowlist, never an inherited toolset`)
    assert.ok(disallowed.includes('Agent'), `${persona.id} must deny the native task tool`)
    for (const capability of ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebSearch', 'WebFetch']) {
      assert.equal(
        tools.includes(capability),
        persona.capabilities.includes(capability),
        `${persona.id} ${capability}`,
      )
    }
    const dispatches = persona.allowedChildren.length > 0
    assert.equal(tools.includes(dispatchTool), dispatches, `${persona.id} dispatch tool`)
    assert.equal(
      disallowed.includes('search_tool') && disallowed.includes('use_tool'),
      !dispatches,
      `${persona.id} MCP discovery`,
    )

    const writes = persona.capabilities.some(capability => ['Write', 'Edit'].includes(capability))
    const executes = persona.capabilities.includes('Bash')
    const expectedMode = writes && executes
      ? 'all'
      : writes ? 'read-write' : executes ? 'execute' : 'read-only'
    assert.equal(header.capabilityMode, expectedMode, `${persona.id} capability mode`)
  }
})

test('the sealed topology mirrors the canonical contract and is fully manifested', () => {
  const topology = JSON.parse(read('agents/grok/workflow/autoprompt-topology.json'))
  assert.equal(topology.runtime, dispatcher.RUNTIME_ID)
  assert.equal(topology.maxDepth, dispatcher.MAX_DEPTH)
  assert.deepEqual(
    Object.keys(topology.personas).sort(),
    CONTRACT.personas.map(persona => persona.id).sort(),
  )
  for (const persona of CONTRACT.personas) {
    assert.deepEqual(topology.personas[persona.id], persona.allowedChildren, persona.id)
  }
  assert.deepEqual(topology.frameworks, CONTRACT.frameworks.map(framework => framework.id))
  assert.deepEqual(topology.rootAllowedChildren, [
    'ap-scope-coordinator',
    'ap-feature-coordinator',
    'ap-sweep-coordinator',
    'ap-preflight-probe',
    'ap-intake',
  ])
  for (const relative of [
    'workflow/autoprompt-topology.json',
    'workflow/grok-dispatch.js',
    'workflow/grok-dispatch-server.js',
    'workflow/launch-grok.sh',
    'workflow/launch-grok.ps1',
    'autoprompt.grok.toml',
  ]) {
    assert.ok(MANIFEST.files.includes(relative), relative)
  }
  assert.equal(MANIFEST.files.filter(file => file.startsWith('agents/')).length, 25)
  assert.equal(MANIFEST.files.filter(file => file.startsWith('frameworks/')).length, 18)
})

test('the activation profile pins exactly what the launcher and doctor verify', () => {
  const profile = read('agents/grok/autoprompt.grok.toml')
  for (const line of [
    '[autoprompt]',
    'runtime = "grok-build-adapter-v1"',
    'max_depth = 4',
    'dispatch = "sealed-headless-reentry"',
    'mcp_server = "autoprompt"',
    'native_subagent_spawn = "denied"',
  ]) {
    assert.equal(profile.split('\n').filter(candidate => candidate === line).length, 1, line)
  }
  assert.match(profile, /^personas = 25$/m)
  assert.match(profile, /^frameworks = 18$/m)
})

test('root dispatch is limited to the canonical entry roles', () => {
  const { mission } = sandbox()
  const plan = dispatch(
    { persona: 'ap-scope-coordinator', task: 'produce the roadmap', framework: 'plan-scope', mission, nonce: NONCE },
    baseEnv(),
  )
  assert.equal(plan.admission.parentDepth, 0)
  assert.equal(plan.plan.command, 'grok-under-test')
  assert.deepEqual(plan.plan.args.slice(0, 3), ['-p', '--prompt-file', plan.plan.promptFile])
  assert.ok(plan.plan.args.includes('--no-subagents'))
  assert.ok(plan.plan.args.includes('--verbatim'))
  assert.deepEqual(
    plan.plan.args.slice(plan.plan.args.indexOf('--permission-mode')),
    ['--permission-mode', 'default'],
  )
  assert.equal(plan.plan.env.AUTOPROMPT_GROK_DEPTH, '1')
  assert.equal(plan.plan.env.AUTOPROMPT_GROK_PERSONA, 'ap-scope-coordinator')
  assert.equal(plan.plan.env.GROK_DISABLE_AUTOUPDATER, '1')

  assert.equal(
    denial({ persona: 'ap-implementer', task: 'build', mission, nonce: NONCE }, baseEnv()).code,
    'AUTOPROMPT_DISPATCH_DENIED',
  )
  assert.match(
    denial({ persona: 'ap-not-a-role', task: 'build', mission, nonce: NONCE }, baseEnv()).message,
    /unknown Autoprompt persona/,
  )
  assert.match(
    denial(
      { persona: 'ap-scope-coordinator', task: 'build', framework: 'not-a-framework', mission, nonce: NONCE },
      baseEnv(),
    ).message,
    /unknown Autoprompt framework/,
  )
})

test('child edges, terminal roles, and the depth ceiling are enforced against the caller identity', () => {
  const { mission } = sandbox()
  const admitted = dispatch(
    { persona: 'ap-planner', task: 'plan the lane', mission, nonce: NONCE },
    baseEnv({
      AUTOPROMPT_GROK_PERSONA: 'ap-manager--lane-one',
      AUTOPROMPT_GROK_DEPTH: '2',
    }),
  )
  assert.equal(admitted.admission.callerRole, 'ap-manager')
  assert.equal(admitted.plan.env.AUTOPROMPT_GROK_DEPTH, '3')

  assert.match(
    denial({ persona: 'ap-planner', task: 'plan', mission, nonce: NONCE }, baseEnv({
      AUTOPROMPT_GROK_PERSONA: 'ap-juror',
      AUTOPROMPT_GROK_DEPTH: '3',
    })).message,
    /terminal role ap-juror cannot dispatch children/,
  )
  assert.match(
    denial({ persona: 'ap-scope-coordinator', task: 'scope', mission, nonce: NONCE }, baseEnv({
      AUTOPROMPT_GROK_PERSONA: 'ap-scope-coordinator',
      AUTOPROMPT_GROK_DEPTH: '1',
    })).message,
    /is not allowlisted/,
  )
  assert.match(
    denial({ persona: 'ap-juror', task: 'judge', mission, nonce: NONCE }, baseEnv({
      AUTOPROMPT_GROK_PERSONA: 'ap-implementer',
      AUTOPROMPT_GROK_DEPTH: '4',
    })).message,
    /depth limit reached at depth 4/,
  )
  assert.match(
    denial({ persona: 'ap-planner', task: 'plan', mission, nonce: NONCE }, baseEnv({
      AUTOPROMPT_GROK_PERSONA: 'not-an-autoprompt-role',
      AUTOPROMPT_GROK_DEPTH: '1',
    })).message,
    /not an allowlisted Autoprompt persona/,
  )
  assert.match(
    denial({ persona: 'ap-planner', task: 'plan', mission, nonce: NONCE }, baseEnv({
      AUTOPROMPT_GROK_PERSONA: 'ap-manager',
      AUTOPROMPT_GROK_DEPTH: '0',
    })).message,
    /reserved for the conductor/,
  )
  assert.match(
    denial({ persona: 'ap-planner', task: 'plan', mission, nonce: NONCE, instance: 'Not Valid' }, baseEnv({
      AUTOPROMPT_GROK_PERSONA: 'ap-manager',
      AUTOPROMPT_GROK_DEPTH: '2',
    })).message,
    /instance must be/,
  )
})

test('the sealed envelope binds the exact prompt ledger and refuses drift', () => {
  const { mission } = sandbox()
  const binding = dispatcher.missionBinding(mission, NONCE)
  const inherited = JSON.stringify({
    bytes: binding.bytes,
    nonce: binding.nonce,
    path: binding.path,
    sha256: binding.sha256,
  })
  const plan = dispatch(
    { persona: 'ap-implementer', task: 'build the lane', framework: 'backend-build' },
    baseEnv({
      AUTOPROMPT_GROK_PERSONA: 'ap-feature-coordinator',
      AUTOPROMPT_GROK_DEPTH: '1',
      AUTOPROMPT_GROK_BINDING: inherited,
    }),
  )
  const envelope = plan.plan.envelope.split('\n')
  assert.equal(envelope[0], '# SEALED AUTOPROMPT DISPATCH ENVELOPE')
  assert.equal(envelope[1], `AUTOPROMPT-RUN-MARKER: runtime=${dispatcher.RUNTIME_ID} nonce=${NONCE} prompt=sha256:${binding.sha256}`)
  assert.equal(envelope[6], 'AUTOPROMPT_PERSONA: ap-implementer')
  assert.equal(envelope[7], 'AUTOPROMPT_FRAMEWORK: backend-build')
  assert.equal(envelope[8], 'AUTOPROMPT_RUNTIME_DEPTH: parent=1 child=2')
  assert.ok(plan.plan.envelope.includes('## BEGIN SEALED FRAMEWORK'))
  assert.ok(plan.plan.envelope.includes(read('agents/grok/frameworks/backend-build.md').trim()))
  assert.ok(plan.plan.envelope.endsWith('## END BOUNDED TASK'))
  assert.equal(plan.plan.env.AUTOPROMPT_GROK_BINDING, inherited)

  fs.appendFileSync(mission, 'a later edit\n')
  assert.match(
    denial({ persona: 'ap-implementer', task: 'build' }, baseEnv({
      AUTOPROMPT_GROK_PERSONA: 'ap-feature-coordinator',
      AUTOPROMPT_GROK_DEPTH: '1',
      AUTOPROMPT_GROK_BINDING: inherited,
    })).message,
    /no longer matches the exact prompt ledger/,
  )
})

test('permission mode, model, and effort are operator inputs with fail-closed defaults', () => {
  const { mission } = sandbox()
  const request = { persona: 'ap-scope-coordinator', task: 'scope it', mission, nonce: NONCE }
  const relaxed = dispatch(request, baseEnv({ AUTOPROMPT_GROK_PERMISSION_MODE: 'acceptEdits' }))
  assert.ok(relaxed.plan.args.includes('acceptEdits'))

  assert.match(
    denial(request, baseEnv({ AUTOPROMPT_GROK_PERMISSION_MODE: 'bypassPermissions' })).message,
    /AUTOPROMPT_GROK_ALLOW_BYPASS=1/,
  )
  const bypass = dispatch(request, baseEnv({
    AUTOPROMPT_GROK_PERMISSION_MODE: 'bypassPermissions',
    AUTOPROMPT_GROK_ALLOW_BYPASS: '1',
  }))
  assert.ok(bypass.plan.args.includes('bypassPermissions'))
  assert.match(
    denial(request, baseEnv({ AUTOPROMPT_GROK_PERMISSION_MODE: 'anything-else' })).message,
    /unsupported permission mode/,
  )

  const routed = dispatch(request, baseEnv({
    AUTOPROMPT_GROK_MODEL: 'grok-build',
    AUTOPROMPT_GROK_EFFORT: 'high',
  }))
  assert.deepEqual(routed.plan.args.slice(-4), ['--model', 'grok-build', '--reasoning-effort', 'high'])
  assert.equal(routed.plan.env.AUTOPROMPT_GROK_MODEL, undefined, 'a child never re-applies the run model twice')
  assert.match(
    denial(request, baseEnv({ AUTOPROMPT_GROK_EFFORT: 'maximum' })).message,
    /reasoning effort must be one of/,
  )
  assert.match(
    denial(request, baseEnv({ AUTOPROMPT_GROK_MODEL: 'grok build; rm -rf /' })).message,
    /not a safe model identifier/,
  )
})

test('the MCP server exposes one dispatch tool and reports denials as tool errors', () => {
  const { mission } = sandbox()
  const initialize = server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  assert.equal(initialize.result.serverInfo.name, 'autoprompt')
  assert.equal(initialize.result.protocolVersion, server.PROTOCOL_VERSION)

  const tools = server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  assert.equal(tools.result.tools.length, 1)
  assert.equal(tools.result.tools[0].name, 'dispatch')
  assert.deepEqual(tools.result.tools[0].inputSchema.required, ['persona', 'task'])

  assert.equal(server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null)
  assert.match(
    server.handle({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'not-dispatch', arguments: {} },
    }).error.message,
    /unknown tool/,
  )

  const calls = []
  const spawn = (command, args, options) => {
    calls.push({ command, args, env: options.env })
    return { status: 0, stdout: '{"result":"ok"}\n', stderr: '' }
  }
  const accepted = server.callDispatch(
    { persona: 'ap-sweep-coordinator', task: 'converge the run', mission, nonce: NONCE },
    { env: baseEnv(), runtimeRoot: RUNTIME_ROOT, spawn },
  )
  assert.equal(accepted.isError, false)
  assert.match(accepted.content[0].text, /^persona=ap-sweep-coordinator framework=none depth=1 exit=0/)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].env.AUTOPROMPT_GROK_PERSONA, 'ap-sweep-coordinator')

  const refused = server.callDispatch(
    { persona: 'ap-janitor', task: 'clean up', mission, nonce: NONCE },
    { env: baseEnv(), runtimeRoot: RUNTIME_ROOT, spawn },
  )
  assert.equal(refused.isError, true)
  assert.match(refused.content[0].text, /AUTOPROMPT_DISPATCH_DENIED/)
  assert.equal(calls.length, 1, 'a denied dispatch never starts a child process')
})

test('the MCP registration edit is additive, idempotent, and refuses foreign sections', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-grok-config-'))
  const config = path.join(root, 'config.toml')
  const backup = `${config}.autoprompt.bak`
  const serverPath = path.join(root, 'skills', 'autoprompt', 'workflow', 'grok-dispatch-server.js')
  const original = '[mcp_servers.linear]\ncommand = "npx"\n\n[permission]\nallow = ["Read"]\n'
  fs.writeFileSync(config, original)

  const applied = grokConfig.renderRegistration(Buffer.from(original, 'utf8'), serverPath)
  assert.equal(applied.status, 'applied')
  assert.equal(applied.bytes.toString('utf8').startsWith(original), true, 'user configuration is preserved verbatim')
  assert.match(applied.bytes.toString('utf8'), /\[mcp_servers\.autoprompt\]/)
  assert.equal(grokConfig.registeredServerPath(applied.bytes.toString('utf8')), serverPath)
  assert.equal(grokConfig.renderRegistration(applied.bytes, serverPath).status, 'noop')

  assert.throws(
    () => grokConfig.renderRegistration(
      Buffer.from('[mcp_servers.autoprompt]\ncommand = "other"\nsecret = 1\n', 'utf8'),
      serverPath,
    ),
    /autoprompt-section-conflict/,
  )
  assert.throws(
    () => grokConfig.renderRegistration(Buffer.from(original, 'utf8'), 'relative/path.js'),
    /server-path-not-absolute/,
  )

  fs.writeFileSync(config, applied.bytes)
  fs.writeFileSync(backup, original)
  assert.equal(grokConfig.restore(config, backup, 'present', serverPath), 0)
  assert.equal(fs.readFileSync(config, 'utf8'), original)
  assert.equal(fs.existsSync(backup), false)
  fs.rmSync(root, { recursive: true, force: true })
})
