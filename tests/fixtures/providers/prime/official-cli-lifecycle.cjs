#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const [cliInput, packageInput] = process.argv.slice(2)
if (!cliInput || !packageInput) {
  throw new Error('usage: official-cli-lifecycle.cjs <prime-agent-cli.js> <adapter-package-root>')
}

const cli = path.resolve(cliInput)
const packageRoot = path.resolve(packageInput)
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-prime-cli-'))
const agentDir = path.join(fixtureRoot, 'agent-home')
const projectDir = path.join(fixtureRoot, 'project')
const settingsPath = path.join(agentDir, 'settings.json')

function credentialFreeEnvironment() {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/(?:API[_-]?KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD|AUTH)/i.test(key),
  ))
  return {
    ...environment,
    CI: '1',
    NO_COLOR: '1',
    PRIME_AGENT_CODING_AGENT_DIR: agentDir,
  }
}

function prime(...args) {
  const completed = childProcess.spawnSync(process.execPath, [cli, ...args], {
    cwd: projectDir,
    encoding: 'utf8',
    env: credentialFreeEnvironment(),
  })
  assert.equal(completed.status, 0, completed.stderr || completed.stdout)
  return `${completed.stdout}${completed.stderr}`
}

function packageSources(settings) {
  return settings.packages.map(item => typeof item === 'string' ? item : item.source)
}

function hasPackage(settings) {
  return packageSources(settings).some(source =>
    typeof source === 'string' && path.resolve(agentDir, source) === packageRoot,
  )
}

try {
  fs.mkdirSync(agentDir, { recursive: true })
  fs.mkdirSync(projectDir, { recursive: true })
  fs.writeFileSync(settingsPath, `${JSON.stringify({
    customSentinel: { preserve: true },
    packages: [],
    rlmMaxDepth: 4,
  }, null, 2)}\n`)

  assert.match(prime('--version'), /^0\.7\.2\s*$/)
  const installOutput = prime('package', 'install', packageRoot)
  const installedSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  assert.deepEqual(installedSettings.customSentinel, { preserve: true })
  assert.equal(installedSettings.rlmMaxDepth, 4)
  assert.ok(hasPackage(installedSettings), JSON.stringify(installedSettings.packages))

  const listOutput = prime('package', 'list')
  assert.match(listOutput, /User packages:/)
  assert.ok(listOutput.includes(packageRoot), listOutput)

  const removeOutput = prime('package', 'remove', packageRoot)
  const removedSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  assert.deepEqual(removedSettings.customSentinel, { preserve: true })
  assert.equal(removedSettings.rlmMaxDepth, 4)
  assert.equal(hasPackage(removedSettings), false)

  process.stdout.write(`${JSON.stringify({
    install: /installed/i.test(installOutput),
    listed: true,
    preserved: ['customSentinel', 'rlmMaxDepth'],
    remove: /removed/i.test(removeOutput),
    version: '0.7.2',
  })}\n`)
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true })
}
