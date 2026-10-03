'use strict'

// Fixed owned launcher for synchronous Windows activation checks. The request
// lives in the private activation directory, never in command-line arguments.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const { ProcessOwner, createWindowsJobAdapter } = require('./process-owner.js')
const { OwnedCodexProxyRunner } = require('./phase-budget.js')

let stage = 'initialization'
async function main() {
  assert.equal(process.platform, 'win32')
  stage = 'request-validation'
  const { inspectPathNoFollow, auditPrivatePermissions, ensureWindowsPrivateAcl } = require('./safe-run-root.js')
  const requestPath = path.resolve(process.argv[2])
  inspectPathNoFollow(requestPath, { mustBeDirectory: false })
  const requestStat = fs.lstatSync(requestPath)
  assert(requestStat.isFile() && requestStat.nlink === 1 && requestStat.size <= 4 * 1024 * 1024)
  const input = JSON.parse(fs.readFileSync(requestPath, 'utf8'))
  const root = path.resolve(input.activationRoot)
  const preflight = path.join(root, 'windows-preflight')
  assert.equal(path.dirname(requestPath), preflight)
  inspectPathNoFollow(root, { mustBeDirectory: true })
  stage = 'private-acl-audit'
  auditPrivatePermissions(preflight, { recurse: false })
  assert.equal(path.resolve(input.registryPath), path.join(preflight, 'registry.json'))
  assert.equal(path.resolve(input.controlRoot), path.join(preflight, 'control'))
  stage = 'private-control-directories'
  for (const directory of [input.controlRoot, path.join(preflight, 'proxy')]) {
    const observed = inspectPathNoFollow(directory, { mustBeDirectory: true })
    if (!observed.exists) fs.mkdirSync(directory, { mode: 0o700 })
    ensureWindowsPrivateAcl(directory)
    auditPrivatePermissions(directory, { recurse: false })
  }
  stage = 'owner-construction'
  const owner = new ProcessOwner({
    adapter: createWindowsJobAdapter({ controlRoot: input.controlRoot, providerPrivateOwnershipRoot: root,
      immutableReadFiles: input.operation === 'run' ? input.immutableReadFiles : [] }),
    registryPath: input.registryPath,
    controlBinding: { activationId: input.activationId, generationId: 1 },
  })
  const drain = async () => {
    stage = 'reservation-recovery'
    await owner.recoverReservations()
    await owner.cancelAll({ reason: 'Windows Codex preflight cleanup', graceMs: 0, killMs: 2000, terminalStatus: 'FAILED', waitForPending: true })
    await owner.assertDrained()
    return { registryPath: input.registryPath, controlRoot: input.controlRoot, drained: true }
  }
  if (input.operation === 'drain') {
    const preflightEvidence = await drain()
    const localConformance = []
    const conformanceRoot = path.join(root, 'local-conformance')
    const conformancePath = inspectPathNoFollow(conformanceRoot, { mustBeDirectory: true })
    if (conformancePath.exists) {
      stage = 'local-conformance-registry-recovery'
      auditPrivatePermissions(conformanceRoot, { recurse: false })
      const { readChecksummedJson } = require('./event-log.js')
      for (const name of fs.readdirSync(conformanceRoot)) {
        const match = /^process-registry-([1-9][0-9]*)\.json$/.exec(name)
        if (!match) continue
        const generation = Number(match[1])
        assert(Number.isSafeInteger(generation) && generation >= 1)
        const registryPath = path.join(conformanceRoot, name)
        inspectPathNoFollow(registryPath, { mustBeDirectory: false })
        const registry = readChecksummedJson(registryPath)
        assert.equal(registry.activationId, input.activationId)
        assert.equal(registry.generationId, generation)
        const controlRoot = path.join(conformanceRoot, `process-control-${generation}`)
        const control = inspectPathNoFollow(controlRoot, { mustBeDirectory: true })
        assert(control.exists, 'Persisted local conformance control root is missing')
        const localOwner = new ProcessOwner({
          adapter: createWindowsJobAdapter({ controlRoot, providerPrivateOwnershipRoot: root, trustedOwnershipRoots: [root] }),
          registryPath, controlBinding: { activationId: input.activationId, generationId: generation },
        })
        await localOwner.cancelAll({ reason: 'Windows Codex local conformance recovery', graceMs: 0, killMs: 2000,
          terminalStatus: 'FAILED', waitForPending: true })
        await localOwner.assertDrained()
        localConformance.push({ registryPath, controlRoot, drained: true })
      }
    }
    const supervisor = []
    if (input.supervisor) {
      const runPath = path.resolve(input.supervisor.runPath)
      assert(runPath.startsWith(path.join(root, 'r') + path.sep))
      const { openRunRecord } = require('./run-record.js')
      const { assertGenerationControlAuthority } = require('./generation-control.js')
      const bound = openRunRecord(runPath, { requireInitialized: false })
      const generation = input.supervisor.generation
      assertGenerationControlAuthority({ runPath, activationId: input.activationId, generation })
      const runtimeOwner = new ProcessOwner({
        adapter: createWindowsJobAdapter({ controlRoot: bound.paths.processControl, providerPrivateOwnershipRoot: root, trustedOwnershipRoots: [root] }),
        registryPath: bound.paths.processRegistry,
        controlBinding: { activationId: input.activationId, generationId: generation, ...(generation > 1 ? { predecessorGenerationId: generation - 1 } : {}) },
      })
      await runtimeOwner.recoverReservations()
      await runtimeOwner.cancelAll({ reason: 'Windows Codex permanent revocation', graceMs: 0, killMs: 2000, terminalStatus: 'FAILED', waitForPending: true })
      await runtimeOwner.assertDrained()
      supervisor.push({ registryPath: bound.paths.processRegistry, controlRoot: bound.paths.processControl, drained: true })
    }
    process.stdout.write(JSON.stringify({ schemaVersion: 1, activationId: input.activationId, drain: preflightEvidence, supervisor, localConformance }))
    return
  }
  assert.equal(input.operation, 'run')
  stage = 'runner-construction'
  const runner = new OwnedCodexProxyRunner({ processOwner: owner, controlRoot: path.join(preflight, 'proxy'),
    targetKey: `preflight:${input.activationId}`, activationId: input.activationId })
  const sessionId = crypto.randomUUID(), reservationId = crypto.randomUUID()
  const deadline = setTimeout(() => { void runner.stop({ sessionId, reason: 'preflight deadline' }).catch(() => {}) }, input.timeoutMs)
  try {
    stage = 'owned-launch'
    const result = await runner.run({ ...input.spec, sessionId, reservationId, stdin: '' })
    assert.equal(result.processOwned, true)
    assert.equal(result.drained, true)
    assert.equal(result.signal, null)
    process.stdout.write(JSON.stringify({ schemaVersion: 1, activationId: input.activationId, result, drain: await drain() }))
  } catch (error) {
    const evidence = await drain()
    process.stdout.write(JSON.stringify({ schemaVersion: 1, activationId: input.activationId,
      error: { code: error.code || 'WINDOWS_PREFLIGHT_FAILED', message: error.message }, drain: evidence }))
    process.exitCode = 1
  } finally { clearTimeout(deadline) }
}
main().catch(error => { console.error(JSON.stringify({ kind: 'windows-codex-preflight-error', stage, code: error.code || 'WINDOWS_PREFLIGHT_DRAIN_UNPROVEN', message: String(error.message || '').slice(0, 4096), location: String(error.stack || '').split('\n').find(line => /^\s+at /.test(line)) || null })); process.exitCode = 1 })
