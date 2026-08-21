#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const BASH = process.platform === 'win32'
  ? 'C:\\Program Files\\Git\\bin\\bash.exe'
  : 'bash'
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

function assertManualInvocation (completed) {
  assert.equal(completed.status, 0, `${completed.stdout}\n${completed.stderr}`)
  assert.match(completed.stdout, /^invocation: manual$/m)
  assert.doesNotMatch(completed.stdout, /^invocation: automatic$/m)
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

test('Bash md-reasonix formatter emits a manual-only skill', () => {
  const command = [
    `source ${shellLiteral(BASH_LIBRARY)}`,
    `_format_md_yaml md-reasonix autoprompt 'Explicit orchestration' 'Run the goal.'`
  ].join('; ')
  assertManualInvocation(run(BASH, ['-lc', command]))
})

test('PowerShell md-reasonix formatter emits a manual-only skill', {
  skip: process.platform !== 'win32' && !process.env.CI
}, () => {
  const command = [
    `. ${psLiteral(POWERSHELL_LIBRARY)}`,
    `[Console]::Out.Write((Format-MdYaml -Token 'md-reasonix' -Name 'autoprompt' -Description 'Explicit orchestration' -Body 'Run the goal.'))`
  ].join('; ')
  assertManualInvocation(run(POWERSHELL, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command
  ]))
})
