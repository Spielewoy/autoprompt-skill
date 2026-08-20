#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const {
  installPayload,
  loadManifest,
  prunePayload,
  renderManifests,
  verifyPayload,
} = require('../../scripts/runtime-payload.cjs')

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

test('committed runtime manifests match every provider source file', () => {
  const completed = childProcess.spawnSync(
    process.execPath,
    ['scripts/runtime-payload.cjs', '--check'],
    { cwd: ROOT, encoding: 'utf8' },
  )

  assert.equal(completed.status, 0, completed.stderr)
  assert.match(completed.stdout, /runtime manifests are current/)
})

test('all seven public provider payloads contain the complete product', () => {
  const contract = require('../../agents/contracts/autoprompt.contract.json')
  assert.equal(contract.personas.length, 25)
  assert.equal(contract.frameworks.length, 18)

  const manifests = renderManifests(ROOT)
  for (const provider of ['claude', 'codex', 'opencode', 'kilo', 'vscode', 'omp']) {
    const manifest = manifests.get(`agents/manifests/${provider}-runtime.json`)
    assert.ok(manifest.files.includes('GATES.md'))
    assert.ok(manifest.files.includes('MODES.md'))
    assert.ok(manifest.files.includes('PLAYBOOKS.md'))
    assert.ok(manifest.files.includes('VERSION'))
    assert.equal(manifest.files.filter(file => file.startsWith('frameworks/')).length, 18)
  }

  const claude = manifests.get('agents/manifests/claude-runtime.json')
  const codex = manifests.get('agents/manifests/codex-runtime.json')
  const opencode = manifests.get('agents/manifests/opencode-runtime.json')
  const kilo = manifests.get('agents/manifests/kilo-runtime.json')
  const vscode = manifests.get('agents/manifests/vscode-runtime.json')
  const omp = manifests.get('agents/manifests/omp-runtime.json')
  const prime = manifests.get('agents/manifests/prime-runtime.json')
  assert.equal(claude.files.filter(file => /^agents\/ap-.*\.md$/.test(file)).length, 25)
  assert.equal(codex.files.filter(file => /^agents\/ap-.*\.toml$/.test(file)).length, 25)
  assert.equal(opencode.files.filter(file => /^agents\/ap-.*\.md$/.test(file)).length, 25)
  assert.equal(kilo.files.filter(file => /^agents\/ap-.*\.md$/.test(file)).length, 25)
  assert.equal(vscode.files.filter(file => /^agents\/ap-.*\.agent\.md$/.test(file)).length, 25)
  assert.equal(omp.files.filter(file => /^agents\/ap-.*\.md$/.test(file)).length, 25)
  assert.equal(prime.files.filter(file => /^personas\/ap-.*\.md$/.test(file)).length, 25)
  assert.equal(prime.files.filter(file => /^prompts\/frameworks\/.*\.md$/.test(file)).length, 18)
  assert.ok(claude.files.includes('workflow/autoprompt-gate.js'))
  assert.ok(codex.files.includes('workflow/codex-agent-casting.js'))
  assert.ok(opencode.files.includes('autoprompt.opencode.json'))
  assert.ok(opencode.files.includes('workflow/launch-opencode.ps1'))
  assert.ok(opencode.files.includes('workflow/launch-opencode.sh'))
  assert.ok(kilo.files.includes('autoprompt.kilo.json'))
  assert.ok(vscode.files.includes('SKILL.md'))
  assert.ok(vscode.files.includes('README.md'))
  assert.ok(omp.files.includes('autoprompt-models.schema.md'))
  assert.ok(omp.files.includes('workflow/supervisor.sh'))
  assert.ok(omp.files.includes('workflow/model-casting.js'))
  assert.equal(omp.files.length, 57)
  assert.ok(prime.files.includes('package.json'))
  assert.ok(prime.files.includes('extensions/autoprompt.ts'))
  assert.ok(prime.files.includes('skills/autoprompt/SKILL.md'))
  assert.ok(prime.files.includes('skills/autoprompt/pyproject.toml'))
  assert.ok(prime.files.includes('skills/autoprompt/src/autoprompt/__init__.py'))
  assert.equal(prime.files.length, 48)
})

test('each provider installs and verifies as a complete isolated payload', () => {
  for (const provider of ['claude', 'codex', 'opencode', 'kilo', 'vscode', 'prime', 'omp']) {
    const destination = temporaryDirectory(`autoprompt-${provider}-`)
    try {
      const installed = installPayload(provider, destination, ROOT)
      const expected = loadManifest(provider, ROOT).files
      const installedRelative = installed.map(file => path.relative(destination, file).split(path.sep).join('/'))
      assert.deepEqual(installedRelative, expected)
      assert.deepEqual(verifyPayload(provider, destination, ROOT), {
        files: expected.length,
        provider,
      })

      fs.mkdirSync(path.join(destination, 'obsolete'), { recursive: true })
      fs.writeFileSync(path.join(destination, 'obsolete', 'stale.txt'), 'stale\n')
      assert.deepEqual(prunePayload(provider, destination, ROOT), [])
      assert.equal(fs.existsSync(path.join(destination, 'obsolete', 'stale.txt')), true)
    } finally {
      fs.rmSync(destination, { recursive: true, force: true })
    }
  }
})

test('runtime verification rejects tampered installed source', () => {
  const destination = temporaryDirectory('autoprompt-tamper-')
  try {
    installPayload('codex', destination, ROOT)
    fs.appendFileSync(path.join(destination, 'GATES.md'), '\ntampered\n')
    assert.throws(
      () => verifyPayload('codex', destination, ROOT),
      /installed hash mismatch: GATES\.md/,
    )
  } finally {
    fs.rmSync(destination, { recursive: true, force: true })
  }
})
