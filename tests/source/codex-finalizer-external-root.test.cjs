#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const { CleanupRegistry } = require(path.join(ROOT, 'agents', 'codex', 'workflow', 'finalizer.js'))
const { atomicWriteJson, readChecksummedJson } = require(path.join(ROOT, 'agents', 'codex', 'workflow', 'event-log.js'))
// These exercise Linux's /proc/self/fd descriptor backend. The Windows-only
// external-root policy also has separate native windowsMutations coverage.
const portableTest = process.platform === 'linux' ? test : test.skip

function fixture(t, activationId = 'external-root-test', generationId = 1) {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-external-root-')))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const allowedRoot = path.join(directory, 'ordinary')
  const externalRoot = path.join(directory, 'short-external')
  fs.mkdirSync(allowedRoot)
  fs.mkdirSync(externalRoot)
  const registryPath = path.join(directory, 'cleanup.json')
  const validator = descriptor => descriptor.kind === 'windows-checker-snapshots' &&
    descriptor.owner === activationId && path.dirname(descriptor.path) === directory
  const registry = new CleanupRegistry({
    registryPath,
    allowedRoots: [allowedRoot],
    controlBinding: { activationId, generationId },
    externalRootValidator: validator,
  })
  return { directory, allowedRoot, externalRoot, registryPath, validator, registry }
}

function registerRoot(context) {
  return context.registry.registerExternalRoot({
    id: 'windows-checker-snapshots',
    path: context.externalRoot,
    kind: 'windows-checker-snapshots',
    owner: 'external-root-test',
  })
}

function reload(context, options = {}) {
  return new CleanupRegistry({
    registryPath: context.registryPath,
    allowedRoots: [context.allowedRoot],
    controlBinding: { activationId: 'external-root-test', generationId: 1 },
    externalRootValidator: context.validator,
    ...options,
  })
}

portableTest('external cleanup root owns only registered descendants and cleans child before empty root', t => {
  const context = fixture(t)
  const descriptor = registerRoot(context)
  assert.equal(context.registry.getExternalRoot(descriptor.id).path, context.externalRoot)
  const snapshot = path.join(context.externalRoot, 'snapshot-one')
  fs.mkdirSync(snapshot)
  fs.writeFileSync(path.join(snapshot, 'owned.txt'), 'owned\n')
  context.registry.register({ path: snapshot, kind: 'checker-snapshot', owner: 'checker-one' })
  context.registry.run()
  assert.equal(fs.existsSync(snapshot), false)
  assert.equal(fs.existsSync(context.externalRoot), false)
  assert.equal(context.registry.getExternalRoot(descriptor.id), null)
  assert.doesNotThrow(() => context.registry.run(), 'cleanup recovery is idempotent after root removal')
  const durable = readChecksummedJson(context.registryPath)
  assert.equal(durable.entries[0].status, 'CLEANED')
  assert.equal(durable.externalRoots[0].status, 'CLEANED')
})

portableTest('external cleanup root refuses replacement and preserves foreign bytes', t => {
  const context = fixture(t)
  registerRoot(context)
  const displaced = path.join(context.directory, 'displaced-external')
  fs.renameSync(context.externalRoot, displaced)
  fs.mkdirSync(context.externalRoot)
  const sentinel = path.join(context.externalRoot, 'foreign.txt')
  fs.writeFileSync(sentinel, 'foreign\n')
  assert.throws(() => context.registry.run(), error =>
    error.code === 'CLEANUP_EXTERNAL_ROOT_UNSAFE' && /physical identity/i.test(error.message))
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'foreign\n')
  assert.equal(readChecksummedJson(context.registryPath).externalRoots[0].status, 'REGISTERED')
})

portableTest('external cleanup root refuses foreign durable authority before mutation', t => {
  const context = fixture(t)
  registerRoot(context)
  const durable = readChecksummedJson(context.registryPath)
  delete durable.checksum
  durable.externalRoots[0].owner = 'foreign-activation'
  atomicWriteJson(context.registryPath, durable)
  assert.throws(() => context.registry.load(), error => error.code === 'CLEANUP_EXTERNAL_ROOT_UNSAFE')
  assert.equal(fs.existsSync(context.externalRoot), true)
})

portableTest('external cleanup root refuses unregistered residue', t => {
  const context = fixture(t)
  registerRoot(context)
  const sentinel = path.join(context.externalRoot, 'unregistered.txt')
  fs.writeFileSync(sentinel, 'retain\n')
  assert.throws(() => context.registry.run(), error =>
    error.code === 'CLEANUP_EXTERNAL_ROOT_NOT_EMPTY')
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'retain\n')
  assert.equal(readChecksummedJson(context.registryPath).externalRoots[0].status, 'REGISTERED')
})

portableTest('authorized predecessor generation recovers and cleans an external root', t => {
  const context = fixture(t, 'external-root-test', 1)
  const descriptor = registerRoot(context)
  const snapshot = path.join(context.externalRoot, 'predecessor-snapshot')
  fs.mkdirSync(snapshot)
  context.registry.register({ path: snapshot, owner: 'checker-predecessor' })
  const successor = new CleanupRegistry({
    registryPath: context.registryPath,
    allowedRoots: [context.allowedRoot],
    controlBinding: {
      activationId: 'external-root-test',
      generationId: 2,
      predecessorGenerationId: 1,
    },
    externalRootValidator: context.validator,
  })
  assert.equal(successor.getExternalRoot(descriptor.id).path, context.externalRoot)
  successor.run()
  const durable = readChecksummedJson(context.registryPath)
  assert.equal(durable.generationId, 2)
  assert.equal(durable.externalRoots[0].status, 'CLEANED')
  assert.equal(fs.existsSync(context.externalRoot), false)
})

portableTest('external cleanup root recovers a confirmed prior removal before its durable cleanup commit', t => {
  const context = fixture(t)
  const descriptor = registerRoot(context)
  fs.rmdirSync(context.externalRoot)
  context.registry.run()
  assert.equal(context.registry.getExternalRoot(descriptor.id), null)
  assert.equal(readChecksummedJson(context.registryPath).externalRoots[0].status, 'CLEANED')
})

portableTest('cleaned external root id can bind a distinct newly allocated root', t => {
  const context = fixture(t)
  const first = registerRoot(context)
  context.registry.run()
  fs.mkdirSync(context.externalRoot)
  assert.throws(() => context.registry.registerExternalRoot({
    id: first.id,
    path: context.externalRoot,
    kind: 'windows-checker-snapshots',
    owner: 'external-root-test',
  }), error => error.code === 'CLEANUP_EXTERNAL_ROOT_DUPLICATE')
  assert.equal(context.registry.load().externalRoots.length, 1,
    'refused historical-path reuse must not corrupt the durable registry')
  fs.rmdirSync(context.externalRoot)
  const replacement = path.join(context.directory, 'short-external-next')
  fs.mkdirSync(replacement)
  const second = context.registry.registerExternalRoot({
    id: first.id,
    path: replacement,
    kind: 'windows-checker-snapshots',
    owner: 'external-root-test',
  })
  assert.equal(context.registry.getExternalRoot(first.id).path, replacement)
  context.registry.run()
  assert.equal(fs.existsSync(replacement), false)
  const durable = readChecksummedJson(context.registryPath)
  assert.deepEqual(durable.externalRoots.map(root => root.status), ['CLEANED', 'CLEANED'])
  assert.equal(second.targetIdentity.type, 'directory')
})

portableTest('external cleanup roots reject overlap and descendants outside their exact authority', t => {
  const context = fixture(t)
  registerRoot(context)
  const overlap = path.join(context.externalRoot, 'overlap')
  fs.mkdirSync(overlap)
  assert.throws(() => context.registry.registerExternalRoot({
    id: 'overlap', path: overlap, kind: 'windows-checker-snapshots', owner: 'external-root-test',
  }), error => error.code === 'CLEANUP_EXTERNAL_ROOT_DUPLICATE')
  const foreign = path.join(context.directory, 'foreign', 'snapshot')
  fs.mkdirSync(foreign, { recursive: true })
  assert.throws(() => context.registry.register({ path: foreign, owner: 'foreign' }), error =>
    error.code === 'CLEANUP_ENTRY_UNSAFE')
})

portableTest('retained external children preserve the exact root for a later cleanup pass', t => {
  const context = fixture(t)
  const descriptor = registerRoot(context)
  const ephemeral = path.join(context.externalRoot, 'ephemeral')
  const retained = path.join(context.externalRoot, 'retained')
  fs.mkdirSync(ephemeral)
  fs.mkdirSync(retained)
  context.registry.register({ path: ephemeral, owner: 'ephemeral-child' })
  context.registry.register({ path: retained, owner: 'retained-child' })

  const retaining = reload(context, { retainEntry: entry => entry.path === retained })
  retaining.run()
  assert.equal(fs.existsSync(ephemeral), false)
  assert.equal(fs.existsSync(retained), true)
  assert.equal(fs.existsSync(context.externalRoot), true)
  assert.equal(retaining.getExternalRoot(descriptor.id).path, context.externalRoot)
  let durable = readChecksummedJson(context.registryPath)
  assert.deepEqual(durable.entries.map(entry => entry.status), ['CLEANED', 'REGISTERED'])
  assert.equal(durable.externalRoots[0].status, 'REGISTERED')

  const finalizer = reload(context, { retainEntry: () => false })
  finalizer.run()
  assert.equal(fs.existsSync(retained), false)
  assert.equal(fs.existsSync(context.externalRoot), false)
  durable = readChecksummedJson(context.registryPath)
  assert.deepEqual(durable.entries.map(entry => entry.status), ['CLEANED', 'CLEANED'])
  assert.equal(durable.externalRoots[0].status, 'CLEANED')
})

portableTest('nonboolean retention policy fails closed before deleting the child', t => {
  const context = fixture(t)
  registerRoot(context)
  const child = path.join(context.externalRoot, 'retained')
  fs.mkdirSync(child)
  context.registry.register({ path: child, owner: 'retained-child' })

  const corrupt = reload(context, { retainEntry: () => 'retain' })
  assert.throws(() => corrupt.run(), error => error.code === 'CLEANUP_CONFIG_INVALID' && /boolean/.test(error.message))
  assert.equal(fs.existsSync(child), true)
  assert.equal(fs.existsSync(context.externalRoot), true)
  const durable = readChecksummedJson(context.registryPath)
  assert.equal(durable.entries[0].status, 'REGISTERED')
  assert.equal(durable.externalRoots[0].status, 'REGISTERED')
})

portableTest('swapped external root is rejected before retention policy evaluation', t => {
  const context = fixture(t)
  registerRoot(context)
  const child = path.join(context.externalRoot, 'retained')
  fs.mkdirSync(child)
  context.registry.register({ path: child, owner: 'retained-child' })
  const displaced = path.join(context.directory, 'displaced-external')
  fs.renameSync(context.externalRoot, displaced)
  fs.mkdirSync(context.externalRoot)
  let evaluated = 0
  const guarded = reload(context, { retainEntry: () => { evaluated += 1; return true } })
  assert.throws(() => guarded.run(), error =>
    error.code === 'CLEANUP_EXTERNAL_ROOT_UNSAFE' && /physical identity/i.test(error.message))
  assert.equal(evaluated, 0)
  assert.equal(fs.existsSync(context.externalRoot), true)
  assert.equal(readChecksummedJson(context.registryPath).externalRoots[0].status, 'REGISTERED')
})
