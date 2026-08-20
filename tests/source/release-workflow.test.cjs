#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8')
}

test('1.0.2 release publishes the verified archive through npm trusted publishing', () => {
  const packageJson = JSON.parse(read('package.json'))
  const workflow = read('.github/workflows/release.yml')
  const notes = read('scripts/build-release-assets.ps1')

  assert.equal(packageJson.version, '1.0.2')
  assert.match(workflow, /^\s+fetch-depth: 0$/m)
  assert.match(workflow, /^\s+id-token: write$/m)
  assert.match(workflow, /^\s+registry-url: "https:\/\/registry\.npmjs\.org"$/m)
  assert.match(workflow, /npm install --global npm@11\.6\.3 --ignore-scripts --no-audit --no-fund/)
  assert.match(workflow, /if: github\.repository == 'Spielewoy\/autoprompt-skill'/)
  assert.match(workflow, /npm view "\$\(\$package\.name\)@\$\(\$package\.version\)" version --json/)
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
})

test('Windows pull-request CI runs the older Codex upgrade lifecycle', () => {
  const workflow = read('.github/workflows/ci.yml')
  const windowsJob = workflow.slice(workflow.indexOf('windows-provider-contracts:'))

  assert.match(windowsJob, /runs-on: windows-latest/)
  assert.match(windowsJob, /--test-name-pattern="receiptless legacy"/)
})

test('release automation changes trigger the full publication gate on main', () => {
  const workflow = read('.github/workflows/release-readiness.yml')

  assert.match(workflow, /- "\.github\/workflows\/release\.yml"/)
  assert.match(workflow, /- "scripts\/build-release-assets\.ps1"/)
  assert.match(workflow, /- "tests\/source\/\*\*"/)
})
