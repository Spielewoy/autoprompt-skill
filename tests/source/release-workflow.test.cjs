#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const RELEASE_POWERSHELL = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
const HAS_RELEASE_POWERSHELL = process.platform === 'win32' || childProcess.spawnSync(
  RELEASE_POWERSHELL,
  ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'],
  { stdio: 'ignore', windowsHide: true },
).status === 0

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8')
}

test('release publishes the verified archive through npm trusted publishing', () => {
  const packageJson = JSON.parse(read('package.json'))
  const workflow = read('.github/workflows/release.yml')
  const notes = read('scripts/build-release-assets.ps1')

  assert.match(packageJson.version, /^\d+\.\d+\.\d+$/)
  assert.equal(
    packageJson.scripts['benchmark:release-quality-gate'],
    'node scripts/benchmark-evidence/quality-gate.cjs --policy scripts/benchmark-evidence/release-quality-policy.json --if-supplied',
  )
  assert.match(packageJson.scripts.prepublishOnly, /npm run benchmark:release-quality-gate/)
  assert.match(workflow, /verify-release:[\s\S]+?runs-on: windows-latest/)
  assert.match(workflow, /publish-release:[\s\S]+?needs: verify-release[\s\S]+?runs-on: ubuntu-latest/)
  assert.match(workflow, /Verify Linux package metadata/)
  assert.match(workflow, /^\s+fetch-depth: 0$/m)
  assert.match(workflow, /^\s+id-token: write$/m)
  assert.match(workflow, /^\s+registry-url: "https:\/\/registry\.npmjs\.org"$/m)
  assert.match(workflow, /npm install --global npm@11\.6\.3 --ignore-scripts --no-audit --no-fund/)
  assert.match(workflow, /if: github\.repository == 'Spielewoy\/autoprompt-skill'/)
  assert.match(workflow, /npm view "\$\(\$package\.name\)@\$\(\$package\.version\)" version --json/)
  assert.match(workflow, /\$archive = \[IO\.Path\]::GetFullPath\(\(Join-Path dist/)
  assert.match(workflow, /npm publish \$archive --ignore-scripts --provenance --access public/)
  assert.doesNotMatch(workflow, /NPM_TOKEN|NODE_AUTH_TOKEN/)
  assert.match(workflow, /git merge-base --is-ancestor \$env:GITHUB_SHA refs\/remotes\/origin\/main/)
  assert.match(workflow, /RELEASE_TAG: \$\{\{ github\.ref_name \}\}/)
  assert.equal(workflow.match(/\$\{\{ github\.ref_name \}\}/g)?.length, 1)
  assert.ok(workflow.indexOf('Require the tagged commit on main') < workflow.indexOf('Publish npm package'))
  assert.ok(workflow.indexOf('Run the complete release gate') < workflow.indexOf('Build release assets'))
  assert.ok(workflow.indexOf('Build release assets') < workflow.indexOf('Publish npm package'))
  assert.ok(workflow.indexOf('Publish npm package') < workflow.indexOf('Publish GitHub release'))
  assert.match(workflow, /gh release upload "v\$version" @assets --clobber/)
  assert.doesNotMatch(workflow, /gh api --method DELETE/)
  assert.match(notes, /Older Codex installs are detected and updated in place/)
  assert.doesNotMatch(notes, /45% fewer|29 failures fell to 16|\+14\.61|cuts failures by/i)
})

test('generated release notes contain no unsupported numeric benchmark claim', {
  skip: !HAS_RELEASE_POWERSHELL,
}, t => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-release-notes-'))
  t.after(() => fs.rmSync(output, { recursive: true, force: true }))
  const result = childProcess.spawnSync(RELEASE_POWERSHELL, ['-NoProfile', '-NonInteractive', '-File', path.join(ROOT, 'scripts', 'build-release-assets.ps1'), '-OutputDirectory', output], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000, windowsHide: true,
  })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  const notes = fs.readFileSync(path.join(output, 'RELEASE_NOTES.md'), 'utf8')
  assert.match(notes, /Benchmark claims remain withheld until a preregistered run has complete independently verifiable evidence/)
  assert.doesNotMatch(notes, /45% fewer|29 failures fell to 16|\+14\.61|cuts failures by/i)
})

test('Windows pull-request CI runs the older Codex upgrade lifecycle', () => {
  const workflow = read('.github/workflows/ci.yml')
  const windowsJob = workflow.slice(workflow.indexOf('windows-provider-contracts:'))

  assert.match(windowsJob, /runs-on: windows-latest/)
  assert.match(windowsJob, /--test-name-pattern="receiptless legacy"/)
})

test('release automation changes trigger the full publication gate on main', () => {
  const workflow = read('.github/workflows/release-readiness.yml')

  for (const requiredPath of [
    'AUTOPROMPT-TOTAL-FIX-MAP.md',
    'AUTOPROMPT-IMPLEMENTATION-COVERAGE.json',
    'CODEX-IMPLEMENTATION-EVIDENCE.json',
    'agents/codex/**',
    'agents/contracts/**',
    'agents/manifests/codex-runtime.json',
    'evidence/codex-*/**',
    'packages/codex/**',
    'scripts/benchmark-evidence/**',
    'scripts/build-release-assets.ps1',
    'scripts/codex-artifact.cjs',
    'scripts/codex-configure.cjs',
    'scripts/codex-evidence-bundle.cjs',
    'scripts/codex-evidence/**',
    'scripts/codex-runtime-identity.cjs',
    'tests/benchmarks/**',
    'tests/fixtures/codex-*/**',
    'tests/source/**',
    '.github/workflows/ci.yml',
    '.github/workflows/release.yml',
    '.github/workflows/release-readiness.yml',
  ]) assert.match(workflow, new RegExp(`- "${requiredPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`), requiredPath)
})

test('release readiness and tag verification inherit the conditional signed quality gate from prepublish', () => {
  const packageJson = JSON.parse(read('package.json'))
  const readiness = read('.github/workflows/release-readiness.yml')
  const release = read('.github/workflows/release.yml')

  assert.match(packageJson.scripts.prepublishOnly, /npm run verify && npm run benchmark:release-quality-gate/)
  assert.match(readiness, /run: npm run prepublishOnly/)
  assert.match(release, /run: npm run prepublishOnly/)
  assert.match(readiness, /AUTOPROMPT_RELEASE_QUALITY_EVIDENCE_PATH:/)
  assert.match(readiness, /AUTOPROMPT_RELEASE_QUALITY_TRUST_REGISTRY_PATH:/)
  assert.match(release, /AUTOPROMPT_RELEASE_QUALITY_EVIDENCE_PATH:/)
  assert.match(release, /AUTOPROMPT_RELEASE_QUALITY_TRUST_REGISTRY_PATH:/)
})
