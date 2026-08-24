#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const PROVIDER_LABELS = Object.freeze({
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  kilo: 'Kilo Code',
  vscode: 'VS Code',
  prime: 'Prime Agent',
  omp: 'Oh My Pi',
  deepseek: 'DeepSeek Harness',
  reasonix: 'Reasonix',
})

function writeFile(root, relativePath, contents = '') {
  const destination = path.join(root, ...relativePath.split('/'))
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.writeFileSync(destination, contents)
}

function writeRoles(root, extension, count = 25) {
  for (let index = 1; index <= count; index += 1) {
    writeFile(root, `agents/ap-role-${index}${extension}`)
  }
}

function writeStrongNonCodexRoot(root, providerId) {
  switch (providerId) {
    case 'claude':
      writeRoles(root, '.md')
      writeFile(root, 'skills/autoprompt/workflow/autoprompt-gate.js')
      writeFile(root, 'skills/autoprompt/autoprompt-models.schema.md')
      return
    case 'opencode':
      writeRoles(root, '.md')
      writeFile(root, 'autoprompt.opencode.json', '{"$schema":"https://opencode.ai/config.json"}\n')
      writeFile(root, 'skills/autoprompt/workflow/launch-opencode.sh')
      writeFile(root, 'skills/autoprompt/workflow/launch-opencode.ps1')
      return
    case 'kilo':
      writeRoles(root, '.md')
      writeFile(root, 'autoprompt.kilo.json', '{"$schema":"https://app.kilo.ai/config.json"}\n')
      return
    case 'vscode':
      writeRoles(root, '.agent.md')
      return
    case 'prime':
      writeFile(root, '.autoprompt-prime-install.json')
      writeFile(root, 'settings.json')
      writeFile(root, 'autoprompt/packages/prime/package.json', '{"keywords":["prime-agent"]}\n')
      writeFile(root, 'autoprompt/packages/prime/skills/autoprompt/src/autoprompt/__init__.py')
      return
    case 'omp':
      writeRoles(root, '.md')
      writeFile(root, 'skills/autoprompt/SKILL.md', [
        '---',
        'name: autoprompt',
        'description: Invoke /skill:autoprompt.',
        'user-invocable: true',
        '---',
        '',
      ].join('\n'))
      return
    case 'deepseek':
      writeFile(root, '.agent-presets/autoprompt/agent.cordis.yml')
      writeFile(root, '.agent-presets/autoprompt/preset.yml')
      return
    case 'reasonix':
      for (let index = 1; index <= 25; index += 1) {
        writeFile(root, `skills/ap-role-${index}/SKILL.md`)
      }
      return
    default:
      throw new Error(`unsupported test provider: ${providerId}`)
  }
}

test('non-Codex inspection does not depend on the Codex package registry', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-root-compat-isolation-'))
  try {
    const isolatedHelper = path.join(sandbox, 'bin', 'provider-root-compat.cjs')
    fs.mkdirSync(path.dirname(isolatedHelper), { recursive: true })
    fs.copyFileSync(path.join(ROOT, 'bin', 'provider-root-compat.cjs'), isolatedHelper)

    const { createProviderRootCompat } = require(isolatedHelper)
    const providerRoot = path.join(sandbox, 'claude-root')
    writeStrongNonCodexRoot(providerRoot, 'claude')

    const compat = createProviderRootCompat(PROVIDER_LABELS)
    assert.deepEqual(compat.inspect(providerRoot, 'claude'), { status: 'accept' })

    const emptyCodexRoot = path.join(sandbox, 'empty-codex-root')
    fs.mkdirSync(emptyCodexRoot)
    assert.equal(compat.inspect(emptyCodexRoot, 'codex').status, 'warn')
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('Codex inventory counts do not change non-Codex root compatibility', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-root-compat-scope-'))
  const { createProviderRootCompat } = require('../../bin/provider-root-compat.cjs')
  const compat = createProviderRootCompat(PROVIDER_LABELS, {
    personaCount: 2,
  })
  try {
    for (const providerId of Object.keys(PROVIDER_LABELS).filter(id => id !== 'codex')) {
      const providerRoot = path.join(sandbox, providerId)
      writeStrongNonCodexRoot(providerRoot, providerId)
      const actual = compat.inspect(providerRoot, providerId)
      if (providerId === 'vscode') {
        assert.deepEqual(actual, {
          status: 'warn',
          headline: 'Warning: The required VS Code subagent setting cannot be verified from this provider root.',
          details: ['Found selected-provider markers: agents/ap-*.agent.md (25 files)'],
        })
      } else {
        assert.deepEqual(actual, { status: 'accept' }, providerId)
      }
    }

    const codexRoot = path.join(sandbox, 'codex')
    writeFile(codexRoot, 'autoprompt.config.toml')
    writeFile(codexRoot, 'skills/autoprompt/agents-runtime/ap-one.toml')
    writeFile(codexRoot, 'skills/autoprompt/agents-runtime/ap-two.toml')
    writeFile(codexRoot, 'skills/autoprompt/agents-runtime/.autoprompt-casting.json')
    assert.deepEqual(compat.inspect(codexRoot, 'codex'), { status: 'accept' })
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})
