'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const INSTALLED_ENTRY = path.join(ROOT, 'agents', 'codex', 'workflow', 'phase-budget.js')
const installedSource = fs.readFileSync(INSTALLED_ENTRY, 'utf8')
const installedRuntime = require(INSTALLED_ENTRY)
const { resolveSettings } = require(path.join(ROOT, 'agents', 'codex', 'workflow', 'settings.js'))

test('installed CLI binds canonical request object bytes to its canonical object hash', () => {
  const reader = /function readExactPathRequestEnvelopeBinding[\s\S]*?\n\}/u.exec(installedSource)?.[0] || ''
  assert.match(reader, /return Object\.freeze\(\{\s*bytes:\s*requestBytes,\s*hash:\s*requestRef\.sha256\s*\}\)/u)
  assert.doesNotMatch(reader, /return Object\.freeze\(\{\s*bytes:\s*requestBytes,\s*hash\s*\}\)/u)
})

test('installed CLI rejects a substituted canonical request hash', () => {
  const bytes = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    argv: ['path=direct', 'Inspect the contained local workspace files.'],
  }))
  assert.throws(() => installedRuntime.productionExactPathPreflight({
    route: 'DIRECT',
    requestEnvelopeBytes: bytes,
    requestEnvelopeHash: '0'.repeat(64),
    targetIdentity: 'filesystem:test-target',
    providerCapabilitiesHash: '1'.repeat(64),
    budgetSnapshotHash: '2'.repeat(64),
    settings: { path: { exactRoute: 'DIRECT' } },
  }), error => error.code === 'EXACT_PATH_FACTS_REQUIRED')
})

test('installed CLI opens exactInvocationObject and denies split reorder or duplicate argv drift', () => {
  const reader = /function readExactPathRequestEnvelopeBinding[\s\S]*?\n\}/u.exec(installedSource)?.[0] || ''
  assert.match(reader, /header\.exactInvocationObject/u)
  assert.match(reader, /exactInvocation(?:Bytes|Object)[\s\S]*?(?:argv|canonicalRequest)[\s\S]*?(?:timingSafeEqual|stableStringify|deepEqual)/u)
})

test('installed CLI provider receipt hashing is insertion-order independent', () => {
  assert.doesNotMatch(installedSource, /providerCapabilitiesHash\s*=\s*hashText\(JSON\.stringify\(providerCapabilities\)\)/u)
  assert.match(installedSource, /providerCapabilitiesHash\s*=\s*hashText\(stableStringify\(providerCapabilities\)\)/u)
})

test('installed CLI exact path treats following concurrency words as mission content', () => {
  const raw = installedRuntime.activationRuntimeSettings({
    requestArgv: ['path=direct', 'wide', 'Inspect the contained local workspace files.'],
    modelSelection: { mode: 'provider-default', selector: 'off', models: [] },
  }, { providerMaximum: 10 })
  const resolved = resolveSettings(raw)
  assert.equal(resolved.status, 'READY')
  assert.equal(resolved.path.exactRoute, 'DIRECT')
  assert.equal(resolved.concurrency.friendlyMode, 'tokensaver')
})

test('installed CLI grammar denies embedded agent thread parallel subagent worker and delegate controls', () => {
  const grammar = /function productionExactPathPreflight[\s\S]*?\n\}/u.exec(installedSource)?.[0] || ''
  for (const control of ['concurrency', 'agent', 'thread', 'parallel', 'subagent', 'worker', 'delegate']) {
    assert.match(grammar, new RegExp(`(?:forbidden|deny|reject|unsafe)[\\s\\S]{0,800}\\b${control}\\b`, 'iu'), control)
  }
})
