#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
function resolveBash() {
  if (process.platform !== 'win32') return 'bash'
  for (const p of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432, 'C:\\Program Files', 'D:\\Program Files']) {
    if (!p) continue
    try { const c = `${p}\\Git\\bin\\bash.exe`; if (childProcess.spawnSync(c, ['--version'], { timeout: 2000 }).status === 0) return c } catch {}
    try { const c = `${p}\\Git\\usr\\bin\\bash.exe`; if (childProcess.spawnSync(c, ['--version'], { timeout: 2000 }).status === 0) return c } catch {}
  }
  return 'bash'
}
const BASH = resolveBash()
const POWERSHELL = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
const BASH_LIBRARY = path.join(ROOT, 'scripts', 'install', 'lib', 'install-lib.sh')
const POWERSHELL_LIBRARY = path.join(ROOT, 'scripts', 'install', 'lib', 'install-lib.ps1')

function run (command, args) {
  return childProcess.spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30000
  })
}

function shellLiteral (value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function psLiteral (value) {
  return `'${value.replaceAll("'", "''")}'`
}

function assertExplicitUserOnly (completed) {
  assert.equal(completed.status, 0, `${completed.stdout}\n${completed.stderr}`)
  assert.match(completed.stdout, /^disable-model-invocation: true$/m)
  assert.match(completed.stdout, /^user-invocable: true$/m)
  assert.doesNotMatch(completed.stdout, /^disable-model-invocation: false$/m)
}

test('Bash md-claude formatter emits an explicit-user-only skill', () => {
  const command = [
    `source ${shellLiteral(BASH_LIBRARY)}`,
    `_format_md_yaml md-claude autoprompt 'Explicit orchestration' 'Run the goal.'`
  ].join('; ')
  assertExplicitUserOnly(run(BASH, ['-lc', command]))
})

test('PowerShell md-claude formatter emits an explicit-user-only skill', {
  skip: process.platform !== 'win32' && !process.env.CI
}, () => {
  const command = [
    `. ${psLiteral(POWERSHELL_LIBRARY)}`,
    `[Console]::Out.Write((Format-MdYaml -Token 'md-claude' -Name 'autoprompt' -Description 'Explicit orchestration' -Body 'Run the goal.'))`
  ].join('; ')
  assertExplicitUserOnly(run(POWERSHELL, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command
  ]))
})
