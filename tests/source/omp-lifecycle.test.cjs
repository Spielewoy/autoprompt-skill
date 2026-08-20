#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const lifecycle = require('../../scripts/install/omp-lifecycle.cjs')

function sandbox(t, name = 'omp-lifecycle') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `autoprompt-${name}-`))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function agentHome(t, name) {
  const temporary = sandbox(t, name)
  const configRoot = path.join(temporary, 'omp-agent-home')
  fs.mkdirSync(configRoot, { recursive: true })
  return configRoot
}

function receipt(configRoot) {
  return JSON.parse(fs.readFileSync(path.join(configRoot, lifecycle.RECEIPT_NAME), 'utf8'))
}

test('install into an agent dir without config.yml records the created flag', (t) => {
  const configRoot = agentHome(t, 'omp-created-flag')
  const configPath = path.join(configRoot, 'config.yml')
  assert.equal(fs.existsSync(configPath), false)

  lifecycle.install(configRoot, ROOT, 'node')

  assert.equal(fs.existsSync(configPath), true)
  assert.equal(fs.readFileSync(configPath, 'utf8'), 'task:\n  maxRecursionDepth: 4\n')
  assert.equal(receipt(configRoot).configEdit.created, true)
})

test('uninstall deletes a config.yml the installer created, leaving no stray file', (t) => {
  const configRoot = agentHome(t, 'omp-created-cleanup')
  const configPath = path.join(configRoot, 'config.yml')

  lifecycle.install(configRoot, ROOT, 'node')
  assert.equal(fs.existsSync(configPath), true)

  const result = lifecycle.uninstall(configRoot)
  assert.equal(result.removed, 59)
  assert.equal(
    fs.existsSync(configPath),
    false,
    'a config.yml brought into existence by install must not survive uninstall',
  )
  assert.equal(fs.existsSync(path.join(configRoot, lifecycle.RECEIPT_NAME)), false)
})

test('uninstall restores a pre-existing config.yml byte-for-byte', (t) => {
  const configRoot = agentHome(t, 'omp-preexisting')
  const configPath = path.join(configRoot, 'config.yml')
  const original = 'model: some-model\ntask:\n  maxConcurrency: 8\n'
  fs.writeFileSync(configPath, original)

  lifecycle.install(configRoot, ROOT, 'node')
  const afterInstall = fs.readFileSync(configPath, 'utf8')
  assert.match(afterInstall, /maxRecursionDepth:\s*4/)
  assert.equal(receipt(configRoot).configEdit.created, false)

  lifecycle.uninstall(configRoot)
  assert.equal(
    fs.readFileSync(configPath, 'utf8'),
    original,
    'a pre-existing config.yml must be restored to its exact prior bytes',
  )
})

test('uninstall leaves a user-edited created config in place', (t) => {
  const configRoot = agentHome(t, 'omp-created-edited')
  const configPath = path.join(configRoot, 'config.yml')

  lifecycle.install(configRoot, ROOT, 'node')
  // User edits the config after install: uninstall must not delete their work.
  const edited = 'task:\n  maxRecursionDepth: 4\n  maxConcurrency: 16\n'
  fs.writeFileSync(configPath, edited)

  lifecycle.uninstall(configRoot)
  assert.equal(
    fs.existsSync(configPath),
    true,
    'a config.yml the user modified after install must not be deleted',
  )
  assert.equal(fs.readFileSync(configPath, 'utf8'), edited)
})
