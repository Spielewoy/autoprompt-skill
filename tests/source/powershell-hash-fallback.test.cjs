#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const LIBRARY = path.join(ROOT, 'scripts', 'install', 'lib', 'install-lib.ps1')

function quotePowerShell(value) {
  return `'${value.replaceAll("'", "''")}'`
}

test('PowerShell hashing falls back to .NET when Get-FileHash is unavailable', {
  skip: process.platform !== 'win32',
}, () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt hash fallback '))
  const source = path.join(sandbox, 'payload')
  const bytes = Buffer.from('autoprompt hash fallback\n', 'utf8')
  fs.writeFileSync(source, bytes)
  const expected = crypto.createHash('sha256').update(bytes).digest('hex')
  const program = [
    `$ErrorActionPreference = 'Stop'`,
    `. ${quotePowerShell(LIBRARY)}`,
    `function global:Get-FileHash { throw 'simulated unavailable cmdlet' }`,
    `$value = Get-IdemSha256 -Path ${quotePowerShell(source)}`,
    `if ($value -isnot [string]) { exit 42 }`,
    `[Console]::Out.WriteLine($value)`,
  ].join('; ')

  try {
    const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const completed = childProcess.spawnSync(powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', program,
    ], { encoding: 'utf8' })
    assert.equal(completed.status, 0, completed.stderr)
    assert.equal(completed.stdout.trim(), expected)
    assert.equal(completed.stderr, '')
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('PowerShell validation resolves a real PATH Python outside fixed install roots', {
  skip: process.platform !== 'win32',
}, () => {
  const discovered = childProcess.spawnSync('python', [
    '-c', 'import sys,yaml,tomllib;print(sys.executable)',
  ], { encoding: 'utf8' })
  assert.equal(discovered.status, 0, discovered.stderr)
  const python = discovered.stdout.trim()
  assert.equal(fs.existsSync(python), true)

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt python resolver '))
  const program = [
    `$ErrorActionPreference = 'Stop'`,
    `. ${quotePowerShell(LIBRARY)}`,
    `$value = Resolve-VerifyPython`,
    `if ($null -eq $value) { exit 65 }`,
    `[Console]::Out.WriteLine($value)`,
  ].join('; ')
  const env = {
    ...process.env,
    LOCALAPPDATA: sandbox,
    ProgramFiles: sandbox,
    'ProgramFiles(x86)': sandbox,
    PATH: `${path.dirname(python)}${path.delimiter}${process.env.SystemRoot}\\System32`,
  }

  try {
    const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const completed = childProcess.spawnSync(powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', program,
    ], { encoding: 'utf8', env })
    assert.equal(completed.status, 0, completed.stderr)
    assert.equal(path.resolve(completed.stdout.trim()), path.resolve(python))
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})
