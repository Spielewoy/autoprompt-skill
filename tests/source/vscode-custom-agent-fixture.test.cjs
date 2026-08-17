#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const FIXTURE_ROOT = path.join(ROOT, 'tests', 'fixtures', 'providers', 'vscode')
const AGENTS_ROOT = path.join(FIXTURE_ROOT, '.github', 'agents')
const PACKAGE_AGENTS_ROOT = path.join(ROOT, 'agents', 'vscode', 'agents')
const CONTRACT_PATH = path.join(ROOT, 'agents', 'contracts', 'autoprompt.contract.json')
const SCHEMA_PATH = path.join(FIXTURE_ROOT, 'custom-agent-frontmatter.schema.json')
const VS_CODE_COMMIT = 'a5b500951314efd502d07465bd138dfbd714a960'

function read(relativePath) {
  return fs.readFileSync(path.join(FIXTURE_ROOT, relativePath), 'utf8').replace(/\r\n/g, '\n')
}

function parseFrontmatter(relativePath) {
  return parseFrontmatterSource(read(relativePath), relativePath)
}

function parseFrontmatterSource(source, label) {
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
    } else if (rawValue.startsWith('[') || rawValue.startsWith('"')) {
      header[key] = JSON.parse(rawValue)
    } else {
      header[key] = rawValue
    }
  }

  return { body: match[2], header, source }
}

function validate(instance, schema, location = '$') {
  const errors = []

  if (schema.oneOf) {
    const matches = schema.oneOf.filter(candidate => validate(instance, candidate, location).length === 0)
    if (matches.length !== 1) errors.push(`${location} must match exactly one accepted form`)
    return errors
  }

  if (schema.type === 'object') {
    if (!instance || typeof instance !== 'object' || Array.isArray(instance)) {
      return [`${location} must be an object`]
    }
    for (const key of schema.required || []) {
      if (!Object.hasOwn(instance, key)) errors.push(`${location}.${key} is required`)
    }
    for (const [key, value] of Object.entries(instance)) {
      if (schema.properties?.[key]) {
        errors.push(...validate(value, schema.properties[key], `${location}.${key}`))
      } else if (schema.additionalProperties === false) {
        errors.push(`${location}.${key} is not accepted`)
      }
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(instance)) return [`${location} must be an array`]
    if (schema.minItems !== undefined && instance.length < schema.minItems) {
      errors.push(`${location} must contain at least ${schema.minItems} item`)
    }
    if (schema.uniqueItems && new Set(instance).size !== instance.length) {
      errors.push(`${location} must contain unique items`)
    }
    if (schema.items) {
      instance.forEach((item, index) => errors.push(...validate(item, schema.items, `${location}[${index}]`)))
    }
  } else if (schema.type === 'string') {
    if (typeof instance !== 'string') return [`${location} must be a string`]
    if (schema.minLength !== undefined && instance.length < schema.minLength) {
      errors.push(`${location} must not be empty`)
    }
  } else if (schema.type === 'boolean' && typeof instance !== 'boolean') {
    errors.push(`${location} must be a boolean`)
  }

  return errors
}

function acceptedAgent(overrides = {}) {
  return {
    name: 'fixture-agent',
    description: 'A non-empty fixture description.',
    tools: ['agent'],
    agents: ['fixture-leaf'],
    'user-invocable': true,
    'disable-model-invocation': false,
    ...overrides,
  }
}

test('the pinned VS Code 1.133 schema records primary evidence', () => {
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'))
  const readme = read('README.md')

  assert.deepEqual(schema['x-vscode-release'], {
    version: '1.133.0',
    commit: VS_CODE_COMMIT,
    bundledCopilotVersion: '0.61.0',
  })
  assert.equal(schema['x-recursive-subagent-tool'], 'agent')
  assert.match(readme, /VS Code `1\.133\.0`/)
  assert.match(readme, /GitHub Copilot `0\.61\.0`/)
  assert.ok(readme.includes(VS_CODE_COMMIT))
  assert.match(readme, /https:\/\/code\.visualstudio\.com\/docs\/agent-customization\/custom-agents/)
  assert.match(readme, /https:\/\/code\.visualstudio\.com\/docs\/agents\/subagents/)
  assert.match(readme, new RegExp(`https://github\\.com/microsoft/vscode/blob/${VS_CODE_COMMIT}/`))
})

test('the schema accepts only the VS Code forms Autoprompt needs', () => {
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'))

  assert.deepEqual(validate(acceptedAgent(), schema), [])
  assert.deepEqual(validate(acceptedAgent({ tools: 'agent' }), schema), [])
  assert.deepEqual(validate(acceptedAgent({ agents: [] }), schema), [])
  assert.deepEqual(validate(acceptedAgent({ model: 'Current Model' }), schema), [])
  assert.deepEqual(validate(acceptedAgent({ model: ['First Model', 'Fallback Model'] }), schema), [])

  assert.notDeepEqual(validate(acceptedAgent({ model: [] }), schema), [])
  assert.notDeepEqual(validate(acceptedAgent({ tools: [42] }), schema), [])
  assert.notDeepEqual(validate(acceptedAgent({ agents: 'fixture-leaf' }), schema), [])
  assert.notDeepEqual(validate(acceptedAgent({ userInvocable: true }), schema), [])
  assert.notDeepEqual(validate(acceptedAgent({ disableModelInvocation: false }), schema), [])
})

test('the minimal agent chain proves allowlisted nested invocation and a closed leaf', () => {
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'))
  const files = fs.readdirSync(AGENTS_ROOT).filter(file => file.endsWith('.agent.md')).sort()
  assert.deepEqual(files, [
    'ap-feature-coordinator.agent.md',
    'ap-implementer.agent.md',
    'autoprompt.agent.md',
  ])

  const agents = Object.fromEntries(files.map(file => [file, parseFrontmatter(`.github/agents/${file}`)]))
  for (const [file, agent] of Object.entries(agents)) {
    assert.deepEqual(validate(agent.header, schema), [], file)
    assert.ok(agent.body.trim().length > 0, `${file} must contain instructions`)
    assert.doesNotMatch(agent.source, /[\u2013\u2014]/, `${file} must use ASCII punctuation`)
    assert.equal(Object.hasOwn(agent.header, 'model'), false, `${file} must inherit the selected model`)
  }

  assert.deepEqual(agents['autoprompt.agent.md'].header, {
    name: 'autoprompt',
    description: 'Run the Autoprompt workflow through its allowlisted coordinator.',
    tools: ['agent'],
    agents: ['ap-feature-coordinator'],
    'user-invocable': true,
    'disable-model-invocation': true,
  })
  assert.deepEqual(agents['ap-feature-coordinator.agent.md'].header, {
    name: 'ap-feature-coordinator',
    description: 'Coordinate one feature and delegate implementation to the allowlisted worker.',
    tools: ['agent'],
    agents: ['ap-implementer'],
    'user-invocable': false,
    'disable-model-invocation': false,
  })
  assert.deepEqual(agents['ap-implementer.agent.md'].header, {
    name: 'ap-implementer',
    description: 'Implement one bounded feature without delegating further.',
    tools: [],
    agents: [],
    'user-invocable': false,
    'disable-model-invocation': false,
  })
})

test('all 25 shipped VS Code agents validate against the pinned 1.133 schema', () => {
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'))
  const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'))
  const expected = contract.personas.map(persona => `${persona.id}.agent.md`).sort()
  const files = fs.readdirSync(PACKAGE_AGENTS_ROOT)
    .filter(file => file.endsWith('.agent.md'))
    .sort()

  assert.equal(expected.length, 25)
  assert.deepEqual(files, expected)

  for (const file of files) {
    const source = fs.readFileSync(path.join(PACKAGE_AGENTS_ROOT, file), 'utf8')
      .replace(/\r\n/g, '\n')
    const agent = parseFrontmatterSource(source, file)
    assert.deepEqual(validate(agent.header, schema), [], file)
    assert.equal(agent.header.name, file.replace(/\.agent\.md$/, ''), file)
    assert.equal(Object.hasOwn(agent.header, 'model'), false, `${file} must inherit the selected model`)
    assert.ok(agent.body.trim().length > 0, `${file} must contain instructions`)
  }
})
