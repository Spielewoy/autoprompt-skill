'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const owner = require('../../agents/codex/workflow/process-owner.js')
const canary = require('../../scripts/harness-v2-closed-canary.cjs')

test('shared platform process-owner factory selects injected POSIX or Windows constructors without host platform claims', () => {
  const calls = []
  const posix = owner.createPlatformProcessAdapter({ platform: 'linux', posix: { marker: 'posix' },
    createPosixProcessAdapter: options => { calls.push({ kind: 'posix', options }); return { kind: 'test-posix' } },
    createWindowsJobAdapter: () => { throw new Error('wrong platform') } })
  assert.equal(posix.kind, 'test-posix')
  const windows = owner.createPlatformProcessAdapter({ platform: 'win32', windows: { controlRoot: '/owned/control', providerPrivateOwnershipRoot: '/owned', trustedOwnershipRoots: ['/owned'] },
    createPosixProcessAdapter: () => { throw new Error('wrong platform') },
    createWindowsJobAdapter: options => { calls.push({ kind: 'windows', options }); return { kind: 'test-windows' } } })
  assert.equal(windows.kind, 'test-windows')
  const helper = { path: '/package/coalition-helper-arm64', sha256: 'a'.repeat(64) }
  const darwin = owner.createPlatformProcessAdapter({ platform: 'darwin', darwin: { controlRoot: '/owned/darwin-control', providerPrivateOwnershipRoot: '/owned' },
    loadDarwinCoalitionHelper: () => helper,
    createDarwinCoalitionAdapter: options => { calls.push({ kind: 'darwin', options }); return { kind: 'test-darwin' } },
    createPosixProcessAdapter: () => { throw new Error('wrong platform') } })
  assert.equal(darwin.kind, 'test-darwin')
  assert.deepEqual(calls, [
    { kind: 'posix', options: { marker: 'posix', platform: 'linux' } },
    { kind: 'windows', options: { controlRoot: '/owned/control', providerPrivateOwnershipRoot: '/owned', trustedOwnershipRoots: ['/owned'] } },
    { kind: 'darwin', options: { controlRoot: '/owned/darwin-control', providerPrivateOwnershipRoot: '/owned', helper } },
  ])
})

test('shared platform process-owner factory propagates platform factory failures', () => {
  assert.throws(() => owner.createPlatformProcessAdapter({ platform: 'win32', windows: {},
    createWindowsJobAdapter: () => { const error = new Error('job ownership unavailable'); error.code = 'PROVIDER_UNSUPPORTED'; throw error } }),
  { code: 'PROVIDER_UNSUPPORTED' })
})

test('closed canary platform selection preserves explicit protected Job roots and rejects missing roots', () => {
  const seen = []
  const adapter = canary.closedCanaryProcessAdapter({ platform: 'win32', controlRoot: '/activation/reviewed/control',
    providerPrivateOwnershipRoot: '/activation', trustedOwnershipRoots: ['/activation'],
    createPlatformAdapter: options => { seen.push(options); return { kind: 'windows-job-object' } } })
  assert.equal(adapter.kind, 'windows-job-object')
  assert.deepEqual(seen, [{ platform: 'win32', windows: { controlRoot: '/activation/reviewed/control', providerPrivateOwnershipRoot: '/activation', trustedOwnershipRoots: ['/activation'] } }])
  assert.throws(() => canary.closedCanaryProcessAdapter({ platform: 'win32', controlRoot: path.resolve('/activation/control'), providerPrivateOwnershipRoot: '', trustedOwnershipRoots: [] }),
  { code: 'LOCAL_CANARY_INVALID' })
})


test('closed canary forwards only explicit Darwin ownership roots to the packaged adapter factory', () => {
  const seen = []
  const adapter = canary.closedCanaryProcessAdapter({ platform: 'darwin', controlRoot: '/activation/reviewed/control', providerPrivateOwnershipRoot: '/activation', trustedOwnershipRoots: ['/activation'],
    createPlatformAdapter: options => { seen.push(options); return { kind: 'darwin-launchd-coalition' } } })
  assert.equal(adapter.kind, 'darwin-launchd-coalition')
  assert.deepEqual(seen, [{ platform: 'darwin', darwin: { controlRoot: '/activation/reviewed/control', providerPrivateOwnershipRoot: '/activation' } }])
})
