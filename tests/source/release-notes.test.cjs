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
