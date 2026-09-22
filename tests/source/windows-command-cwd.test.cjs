'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')

function fixture(t, scenario = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'command-cwd-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const requestedCwd = path.join(root, ...Array(12).fill('canonical-command-working-directory'))
  const controlRoot = path.join(root, 'control'), shallowParent = path.join(root, 'shallow')
  fs.mkdirSync(requestedCwd, { recursive: true }); fs.mkdirSync(controlRoot); fs.mkdirSync(shallowParent)
  fs.writeFileSync(path.join(requestedCwd, 'sentinel'), 'canonical-target')
  assert.ok(requestedCwd.length >= 260)
  const events = [], evidence = { exitCode: 0, stdout: Buffer.from('ok'), stderr: Buffer.alloc(0),
    launcherSessionId: 1, timedOut: false, truncated: false, cancelled: false }
  let stagingRoot, runtimeRoot, helperRoot, launchCount = 0
  const suppliedFilesystem = scenario.filesystem ? scenario.filesystem(fs, events) : fs
  const filesystem = { ...suppliedFilesystem, unlinkSync(file) {
    if (path.basename(file) === 'command-cwd') events.push('bridge-unlink')
    return suppliedFilesystem.unlinkSync(file)
  } }
  const localSafe = require('../../agents/codex/workflow/safe-run-root.js')
  const launcher = {
    verifyDrainEvidence() { return true },
    proveNotStarted() { return evidence },
    async launch(request) {
      launchCount += 1; events.push('launch')
      scenario.beforeLaunch?.({ request, requestedCwd, stagingRoot })
      if (scenario.launchError) throw scenario.launchError
      assert.ok(request.cwd.length < 260)
      assert.equal(fs.realpathSync.native(request.cwd), fs.realpathSync.native(requestedCwd))
      return evidence
    },
  }
  const replacements = {
    'node:fs': filesystem,
    './safe-run-root.js': { ...localSafe, ensureWindowsPrivateAcl() {}, createWindowsCompilerDirectory(prefix) {
      stagingRoot = fs.mkdtempSync(path.join(shallowParent, prefix)); scenario.afterStaging?.({ stagingRoot }); return stagingRoot
    } },
    './windows-filesystem.js': { createWindowsFilesystemCapture() { return { assertRecordParent() {} } } },
    './windows-appcontainer-probe.js': {
      failureDiagnostic: require('../../agents/codex/workflow/windows-appcontainer-probe.js').failureDiagnostic,
      canaryKey() { return 'e'.repeat(64) },
      async runWindowsAppContainerCanary() { return { supported: true, workerIdentity: 'a'.repeat(64),
        runtimeSha256: 'e'.repeat(64), processCleanup: 'owned-job-drained' } },
    },
    './windows-worker-loader.js': {
      async captureWorkerTuple() { return Object.freeze({}) },
      revalidateTuple() { return { identity: 'a'.repeat(64) } },
      materializeTuple(tuple, directory) {
        runtimeRoot = directory; fs.mkdirSync(directory)
        return { identity: 'a'.repeat(64), bash: path.join(directory, 'usr/bin/bash.exe'), bashSha256: 'b'.repeat(64),
          msysRuntime: { dllPath: path.join(directory, 'usr/bin/msys-2.0.dll'), dllSha256: 'c'.repeat(64), sharedId: 'msys-2.0S5' } }
      },
    },
    './windows-helper-deployment.js': { stageWindowsHelperDeployment(parent) {
      helperRoot = path.join(parent, 'helpers'); fs.mkdirSync(helperRoot)
      return { root: helperRoot, cleanup() { events.push('helper-cleanup'); fs.rmSync(helperRoot, { recursive: true, force: true }) } }
    } },
    './windows-appcontainer-resources.js': { async prepareWindowsAppContainerResources() {
      scenario.afterPrepare?.({ requestedCwd, stagingRoot })
      return { profileName: 'owned', profileSid: 'owned', environment: {}, recovery: { leaseId: 'owned' },
        async release(received) { assert.equal(received, evidence); events.push('release'); return { restored: 1, newEntries: 0, deletedEntries: 0 } } }
    }, recoverWindowsAppContainerResources() { assert.fail('unexpected recovery') } },
  }
  const filename = path.resolve(__dirname, '../../agents/codex/workflow/windows-appcontainer-command.js')
  const localRequire = createRequire(filename), module = { exports: {} }
  replacements['./windows-appcontainer.js'] = { ...localRequire('./windows-appcontainer.js'),
    createWindowsAppContainerLauncher() { return launcher } }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, Buffer,
    __dirname: path.dirname(filename), process: { platform: 'win32', env: { SystemRoot: 'C:\\Windows' } },
    require: name => Object.hasOwn(replacements, name) ? replacements[name] : localRequire(name) }, { filename })
  const run = () => module.exports.runWindowsAppContainerCommand({ targetPath: requestedCwd, scratchPath: requestedCwd,
    readableRoots: [requestedCwd], writableRoots: [requestedCwd] }, { command: 'printf owned', cwd: requestedCwd }, { controlRoot })
  return { root, requestedCwd, events, run, get stagingRoot() { return stagingRoot },
    get runtimeRoot() { return runtimeRoot }, get helperRoot() { return helperRoot }, get launchCount() { return launchCount } }
}

test('deep command cwd uses one shallow owned junction and removes it only after release', async t => {
  const f = fixture(t)
  const result = await f.run()
  assert.equal(result.status, 'completed')
  assert.ok(f.events.indexOf('launch') < f.events.indexOf('release'))
  assert.ok(f.events.indexOf('release') < f.events.indexOf('bridge-unlink'))
  assert.ok(f.events.indexOf('bridge-unlink') < f.events.indexOf('helper-cleanup'))
  assert.equal(fs.readFileSync(path.join(f.requestedCwd, 'sentinel'), 'utf8'), 'canonical-target')
  assert.equal(fs.existsSync(f.stagingRoot), false)
})

test('a preexisting command cwd alias is never adopted or recursively removed', async t => {
  const f = fixture(t, { afterStaging({ stagingRoot }) {
    const alias = path.join(stagingRoot, 'command-cwd')
    fs.mkdirSync(alias); fs.writeFileSync(path.join(alias, 'foreign-sentinel'), 'another-owner')
  } })
  await assert.rejects(f.run(), error => error.code === 'EEXIST' && error.cleanupConfirmed === false &&
    error.retainedStagingRoot === f.stagingRoot)
  assert.equal(f.launchCount, 0)
  assert.equal(fs.readFileSync(path.join(f.stagingRoot, 'command-cwd', 'foreign-sentinel'), 'utf8'), 'another-owner')
  assert.equal(f.events.includes('helper-cleanup'), false)
})

test('a replaced staging ancestor blocks bridge removal and every recursive child cleanup', async t => {
  let moved
  const f = fixture(t, { afterPrepare({ stagingRoot }) {
    moved = `${stagingRoot}.moved`
    fs.renameSync(stagingRoot, moved)
    fs.mkdirSync(stagingRoot)
    fs.writeFileSync(path.join(stagingRoot, 'foreign-sentinel'), 'replacement-owner')
  } })
  await assert.rejects(f.run(), error => error.code === 'WINDOWS_RUNTIME_MISMATCH' &&
    error.cleanupConfirmed === false && error.retainedStagingRoot === f.stagingRoot)
  assert.equal(f.launchCount, 0)
  assert.equal(fs.readFileSync(path.join(f.stagingRoot, 'foreign-sentinel'), 'utf8'), 'replacement-owner')
  assert.equal(fs.existsSync(path.join(moved, 'command-cwd')), true)
  assert.equal(fs.existsSync(path.join(moved, path.basename(f.runtimeRoot))), true)
  assert.equal(fs.existsSync(path.join(moved, path.basename(f.helperRoot))), true)
  assert.equal(f.events.includes('helper-cleanup'), false)
})

test('replaced command cwd junction retains the entire staging tree without launch or recursive cleanup', async t => {
  let foreign
  const f = fixture(t, { afterPrepare({ stagingRoot }) {
    foreign = path.join(path.dirname(stagingRoot), 'foreign'); fs.mkdirSync(foreign)
    fs.unlinkSync(path.join(stagingRoot, 'command-cwd'))
    fs.symlinkSync(foreign, path.join(stagingRoot, 'command-cwd'), process.platform === 'win32' ? 'junction' : 'dir')
  } })
  await assert.rejects(f.run(), error => error.code === 'WINDOWS_RUNTIME_MISMATCH' &&
    error.cleanupConfirmed === false && error.retainedStagingRoot === f.stagingRoot)
  assert.equal(f.launchCount, 0)
  assert.equal(fs.existsSync(f.runtimeRoot), true)
  assert.equal(fs.existsSync(f.helperRoot), true)
  assert.equal(fs.realpathSync.native(path.join(f.stagingRoot, 'command-cwd')), fs.realpathSync.native(foreign))
  assert.equal(fs.readFileSync(path.join(f.requestedCwd, 'sentinel'), 'utf8'), 'canonical-target')
})

test('ambiguous command cwd removal retains staging and poisons later admission', async t => {
  const failure = Object.assign(new Error('junction busy'), { code: 'EBUSY' })
  const f = fixture(t, { filesystem(base, events) { return { ...base, unlinkSync(file) {
    if (path.basename(file) === 'command-cwd' && events.includes('release')) throw failure
    return base.unlinkSync(file)
  } } } })
  await assert.rejects(f.run(), error => error === failure && error.cleanupConfirmed === false &&
    error.retainedStagingRoot === f.stagingRoot)
  assert.equal(fs.existsSync(f.runtimeRoot), true)
  assert.equal(fs.existsSync(f.helperRoot), true)
  assert.equal(fs.readFileSync(path.join(f.requestedCwd, 'sentinel'), 'utf8'), 'canonical-target')
  const launches = f.launchCount
  await assert.rejects(f.run(), error => error !== failure && error.cleanupConfirmed === false &&
    error.admissionFailure?.message === failure.message)
  assert.equal(f.launchCount, launches)
})
