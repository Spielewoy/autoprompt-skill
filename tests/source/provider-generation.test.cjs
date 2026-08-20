#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const CONTRACT_PATH = path.join(ROOT, 'agents', 'contracts', 'autoprompt.contract.json')
const VSCODE_SCHEMA_PATH = path.join(
  ROOT,
  'tests',
  'fixtures',
  'providers',
  'vscode',
  'custom-agent-frontmatter.schema.json',
)
const { renderOutputs } = require('../../scripts/generate-provider-contracts.cjs')

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8').replace(/\r\n/g, '\n')
}

function filesBelow(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name)
    return entry.isDirectory() ? filesBelow(target) : [target]
  })
}

function stripFrontmatter(text) {
  return text.replace(/^---\n[\s\S]*?\n---\n/, '')
}

function asciiDashes(text) {
  return text.replace(/[\u2013\u2014]/g, '-')
}

function vscodeTools(capabilities) {
  const aliases = [
    ['execute', ['Bash']],
    ['read', ['Read']],
    ['edit', ['Write', 'Edit']],
    ['search', ['Glob', 'Grep']],
    ['agent', ['Agent']],
    ['web', ['WebSearch', 'WebFetch']],
  ]
  return aliases
    .filter(([, sources]) => sources.some(source => capabilities.includes(source)))
    .map(([alias]) => alias)
}

function parseFrontmatter(source, label) {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]+)$/.exec(source)
  assert.ok(match, `${label} must contain YAML frontmatter and a body`)
  const header = {}
  for (const line of match[1].split('\n')) {
    const separator = line.indexOf(':')
    assert.notEqual(separator, -1, `${label} has an invalid frontmatter line: ${line}`)
    const key = line.slice(0, separator)
    const rawValue = line.slice(separator + 1).trim()
    assert.equal(Object.hasOwn(header, key), false, `${label} repeats ${key}`)
    if (rawValue === 'true' || rawValue === 'false') {
      header[key] = rawValue === 'true'
    } else {
      header[key] = JSON.parse(rawValue)
    }
  }
  return { body: match[2], header }
}

function assertVsCodeSchema(header, label) {
  const schema = JSON.parse(fs.readFileSync(VSCODE_SCHEMA_PATH, 'utf8'))
  const accepted = new Set(Object.keys(schema.properties))
  for (const key of schema.required) assert.ok(Object.hasOwn(header, key), `${label} requires ${key}`)
  for (const key of Object.keys(header)) assert.ok(accepted.has(key), `${label} rejects ${key}`)
  assert.equal(typeof header.name, 'string', `${label} name`)
  assert.ok(header.name.length > 0, `${label} name must not be empty`)
  assert.equal(typeof header.description, 'string', `${label} description`)
  assert.ok(header.description.length > 0, `${label} description must not be empty`)
  assert.ok(Array.isArray(header.tools), `${label} tools`)
  assert.ok(Array.isArray(header.agents), `${label} agents`)
  assert.equal(new Set(header.tools).size, header.tools.length, `${label} tools must be unique`)
  assert.equal(new Set(header.agents).size, header.agents.length, `${label} agents must be unique`)
  assert.ok(header.tools.every(value => typeof value === 'string' && value), `${label} tools entries`)
  assert.ok(header.agents.every(value => typeof value === 'string' && value), `${label} agents entries`)
  assert.equal(typeof header['user-invocable'], 'boolean', `${label} user-invocable`)
  assert.equal(typeof header['disable-model-invocation'], 'boolean', `${label} disable-model-invocation`)
}

test('the shared contract exposes all personas, levels, and frameworks', () => {
  const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'))
  assert.equal(contract.personas.length, 25)
  assert.equal(contract.frameworks.length, 18)
  assert.deepEqual([...new Set(contract.personas.map(persona => persona.tier))].sort(), [
    'R1', 'R2', 'R3', 'R4', 'R5',
  ])

  for (const persona of contract.personas) {
    assert.equal(fs.existsSync(path.join(ROOT, persona.source)), true, persona.source)
    assert.ok(Array.isArray(persona.allowedChildren), `${persona.id} allowedChildren`)
    assert.equal(new Set(persona.allowedChildren).size, persona.allowedChildren.length, `${persona.id} children`)
    assert.deepEqual([...persona.allowedChildren].sort(), persona.allowedChildren, `${persona.id} child order`)
    assert.ok(
      persona.allowedChildren.every(child => contract.personas.some(candidate => candidate.id === child)),
      `${persona.id} children must be canonical personas`,
    )
    assert.equal(persona.allowedChildren.length > 0, persona.capabilities.includes('Agent'), persona.id)
  }
  for (const framework of contract.frameworks) {
    assert.equal(fs.existsSync(path.join(ROOT, framework.source)), true, framework.source)
  }
})

test('provider-native prompts are deterministic generated views', () => {
  const completed = childProcess.spawnSync(
    process.execPath,
    ['scripts/generate-provider-contracts.cjs', '--check'],
    { cwd: ROOT, encoding: 'utf8' },
  )

  assert.equal(completed.status, 0, completed.stderr)
  assert.match(completed.stdout, /provider contracts are current/)

  const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'))
  const outputs = renderOutputs(ROOT)
  assert.equal(outputs.size, contract.personas.length * 6 + contract.frameworks.length * 6 + 20)
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
  for (const provider of ['claude', 'codex', 'opencode', 'kilo', 'vscode']) {
    assert.equal(outputs.get(`agents/${provider}/VERSION`), `${version}\n`, provider)
  }
})

test('every canonical persona has complete forms for all seven public providers', () => {
  const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'))

  for (const persona of contract.personas) {
    const canonical = read(persona.source)
    const body = stripFrontmatter(canonical)
    const claude = read(`agents/claude/agents/${persona.id}.md`)
    const codex = read(`agents/codex/agents/${persona.id}.toml`)
    const opencode = read(`agents/opencode/agents/${persona.id}.md`)
    const kilo = read(`agents/kilo/agents/${persona.id}.md`)
    const vscode = read(`agents/vscode/agents/${persona.id}.agent.md`)
    const prime = read(`agents/prime/personas/${persona.id}.md`)
    const omp = read(`agents/omp/agents/${persona.id}.md`)

    assert.equal(claude, canonical, `${persona.id} Claude source`)
    assert.match(codex, new RegExp(`^name = "${persona.id}"$`, 'm'))
    assert.match(codex, /^sandbox_mode = "(?:read-only|workspace-write)"$/m)
    assert.match(codex, /^developer_instructions = """$/m)
    assert.equal(codex.includes(body.trim()), true, `${persona.id} Codex body`)
    assert.match(opencode, /^mode: subagent$/m)
    assert.equal(opencode.includes(body.trim()), true, `${persona.id} OpenCode body`)
    assert.match(kilo, /^mode: subagent$/m)
    assert.equal(kilo.includes(body.trim()), true, `${persona.id} Kilo body`)

    const parsed = parseFrontmatter(vscode, persona.id)
    assertVsCodeSchema(parsed.header, persona.id)
    assert.deepEqual(parsed.header, {
      name: persona.id,
      description: asciiDashes(persona.description),
      tools: vscodeTools(persona.capabilities),
      agents: persona.allowedChildren,
      'user-invocable': false,
      'disable-model-invocation': false,
    })
    assert.equal(parsed.body.trim(), asciiDashes(body.trim()), `${persona.id} VS Code body`)
    assert.equal(Object.hasOwn(parsed.header, 'model'), false, `${persona.id} inherits the selected model`)
    assert.doesNotMatch(vscode, /[\u2013\u2014]/, `${persona.id} must use ASCII punctuation`)

    assert.equal(prime.trim(), body.trim(), `${persona.id} Prime body`)
    const ompBody = stripFrontmatter(omp).trim().replace(/\r\n/g, '\n')
    assert.ok(ompBody.includes(`You are **${persona.id}**`), `${persona.id} OMP body identity`)
    assert.ok(ompBody.length > 800, `${persona.id} OMP body substantial`)
    assert.match(omp, new RegExp(`^name: ${persona.id}$`, 'm'))
  }
})

test('all providers expose the same framework set', () => {
  const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'))
  const expected = contract.frameworks.map(framework => `${framework.id}.md`).sort()

  for (const provider of ['claude', 'codex', 'opencode', 'kilo', 'vscode', 'omp']) {
    const actual = fs.readdirSync(path.join(ROOT, 'agents', provider, 'frameworks'))
      .filter(name => name.endsWith('.md'))
      .sort()
    assert.deepEqual(actual, expected, provider)
  }
  const prime = fs.readdirSync(path.join(ROOT, 'agents', 'prime', 'prompts', 'frameworks'))
    .filter(name => name.endsWith('.md'))
    .sort()
  assert.deepEqual(prime, expected, 'prime')
})

test('the VS Code package records its proven runtime contract and has valid links', () => {
  const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'))
  assert.deepEqual(contract.providers.vscode, {
    frontmatter: {
      required: [
        'name',
        'description',
        'tools',
        'agents',
        'user-invocable',
        'disable-model-invocation',
      ],
      model: 'omit',
    },
    capabilities: [
      'native-markdown-subagents',
      'recursive-subagents',
      'selected-model-inheritance',
    ],
    runtimePrerequisites: {
      'chat.subagents.allowInvocationsFromSubagents': true,
    },
    settingsLifecycle: {
      edit: 'transactional',
      backup: 'byte-exact',
      restore: ['rollback', 'uninstall'],
      unsafeJsonc: 'refuse',
      conflicts: 'refuse',
    },
    allowedDeltas: [
      'skill-frontmatter',
      'markdown-agent-export',
      'agent-tool-alias',
      'explicit-agent-allowlists',
      'selected-model-inheritance',
    ],
  })
  assert.equal(contract.generated.vscodeAgents, 'agents/vscode/agents')
  assert.equal(contract.generated.vscodeFrameworks, 'agents/vscode/frameworks')

  const files = [
    'SKILL.md',
    'GATES.md',
    'MODES.md',
    'PLAYBOOKS.md',
    'README.md',
  ]
  for (const file of files) {
    const source = read(`agents/vscode/${file}`)
    assert.doesNotMatch(source, /[\u2013\u2014]/, `${file} must use ASCII punctuation`)
    assert.doesNotMatch(source, /OpenCode|opencode|OPENCODE|subagent_depth/, `${file} provider language`)
  }

  const packageRoot = path.join(ROOT, 'agents', 'vscode')
  const packageFiles = filesBelow(packageRoot)
  const agents = packageFiles
    .filter(file => file.endsWith('.agent.md'))
    .map(file => path.basename(file))
    .sort()
  assert.deepEqual(
    agents,
    contract.personas.map(persona => `${persona.id}.agent.md`).sort(),
  )
  for (const absolutePath of packageFiles) {
    const source = fs.readFileSync(absolutePath, 'utf8').replace(/\r\n/g, '\n')
    const label = path.relative(packageRoot, absolutePath).split(path.sep).join('/')
    assert.doesNotMatch(source, /[\u2013\u2014]/, `${label} must use ASCII punctuation`)
    for (const match of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1]
      if (/^(?:[a-z]+:|#)/i.test(target)) continue
      const relative = target.split('#', 1)[0]
      assert.equal(
        fs.existsSync(path.resolve(path.dirname(absolutePath), relative)),
        true,
        `${label} link ${target}`,
      )
    }
  }

  const readme = read('agents/vscode/README.md')
  assert.match(readme, /VS Code 1\.133/)
  assert.match(readme, /GitHub Copilot 0\.61/)

  for (const file of ['README.md', 'SKILL.md', 'GATES.md', 'MODES.md']) {
    const source = read(`agents/vscode/${file}`)
    assert.match(
      source,
      /installer transactionally sets `chat\.subagents\.allowInvocationsFromSubagents=true`/i,
      `${file} transactional settings edit`,
    )
    assert.match(source, /byte-exact backup/i, `${file} settings backup`)
    assert.match(
      source,
      /restores the prior bytes on rollback or uninstall/i,
      `${file} settings restore`,
    )
    assert.match(
      source,
      /refuses unsafe JSONC and conflicting state/i,
      `${file} unsafe settings refusal`,
    )
    assert.doesNotMatch(
      source,
      /(?:does not|never) (?:edit|mutate) (?:VS Code settings|that setting)|user must enable/i,
      `${file} stale settings claim`,
    )
  }
})
