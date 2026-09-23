'use strict'

const assert = require('node:assert/strict')
const cp = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '../..')
const HELPER_SOURCE = path.join(ROOT, 'agents/codex/workflow/darwin-coalition-helper.c')
const ADAPTER_SOURCE = path.join(ROOT, 'agents/codex/workflow/darwin-launchd-process.js')
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

function command(executable, argv, options = {}) {
  return cp.spawnSync(executable, argv, {
    shell: false,
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  })
}

function requireSuccess(result, description) {
  assert.equal(result.error, undefined, `${description}: ${result.error?.message}`)
  assert.equal(result.signal, null, `${description}: signal ${result.signal}`)
  assert.equal(result.status, 0, `${description}: ${result.stderr || result.stdout}`)
  return result
}

function helperJson(helper, argv) {
  const result = requireSuccess(command(helper, argv), `helper ${argv.join(' ')}`)
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean)
  assert.equal(lines.length, 1)
  const value = JSON.parse(lines[0])
  assert.equal(value.schemaVersion, 1)
  assert.equal(value.ok, true)
  return value
}

function alive(pid) {
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
}

async function waitFor(predicate, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs
  let value
  while (Date.now() < deadline) {
    value = await predicate()
    if (value) return value
    await sleep(50)
  }
  assert.fail(`${description}; last=${JSON.stringify(value)}`)
}

function writeEvidence(value) {
  const output = process.env.AUTOPROMPT_DARWIN_PROCESS_EVIDENCE
  if (output) fs.writeFileSync(output, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

function preserveTestedHelper(helper, evidence) {
  const output = process.env.AUTOPROMPT_DARWIN_PROCESS_EVIDENCE
  if (!output) return
  const artifact = path.join(path.dirname(output), 'darwin-coalition-helper')
  if (fs.existsSync(artifact)) {
    assert.equal(sha256(fs.readFileSync(artifact)), sha256(fs.readFileSync(helper)))
  } else {
    fs.copyFileSync(helper, artifact, fs.constants.COPYFILE_EXCL)
  }
  fs.chmodSync(artifact, 0o500)
  evidence.helperArtifact = {
    file: path.basename(artifact),
    sha256: sha256(fs.readFileSync(artifact)),
    sourceSha256: sha256(fs.readFileSync(HELPER_SOURCE)),
    architecture: process.arch,
  }
}

test('Darwin coalition production sources retain exact-token and atomic-usage boundaries', () => {
  const helper = fs.readFileSync(HELPER_SOURCE, 'utf8')
  const adapter = fs.readFileSync(ADAPTER_SOURCE, 'utf8')
  assert.match(helper, /bind_process\(pids\[index\], &bound/)
  assert.match(helper, /signal_function\(&bound\.token, signal_number\)/)
  assert.match(helper, /coalition_info_resource_usage/)
  assert.match(helper, /struct ap_coalition_usage_prefix/)
  assert.doesNotMatch(adapter, /process\.kill\s*\(/)
  assert.match(adapter, /remaining\.status !== 3/)
  assert.match(adapter, /launchd-absent-without-published-identity/)
})

test('native Darwin launchd coalition survives root death and a fresh adapter drains detached children', {
  skip: process.platform !== 'darwin' && 'requires native macOS',
  timeout: 150000,
}, async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'ap-darwin-owner-'))
  fs.chmodSync(temporaryRoot, 0o700)
  const controlRoot = path.join(temporaryRoot, 'control')
  const helper = path.join(temporaryRoot, 'darwin-coalition-helper')
  const fixtureSource = path.join(temporaryRoot, 'detached-fixture.c')
  const fixture = path.join(temporaryRoot, 'detached-fixture')
  const slowHelperSource = path.join(temporaryRoot, 'slow-helper.c')
  const slowHelper = path.join(temporaryRoot, 'slow-helper')
  const stateFile = path.join(temporaryRoot, 'children.txt')
  const registryPath = path.join(temporaryRoot, 'processes.json')
  const compilerProbe = requireSuccess(command('/usr/bin/xcrun', ['--find', 'clang']), 'locate clang')
  const compiler = fs.realpathSync.native(compilerProbe.stdout.trim())
  assert.equal(path.isAbsolute(compiler), true)
  const compilerVersion = requireSuccess(command(compiler, ['--version']), 'read clang version').stdout.trim()
  const sdkPath = requireSuccess(command('/usr/bin/xcrun', ['--show-sdk-path']), 'read SDK path').stdout.trim()
  const sdkVersion = requireSuccess(command('/usr/bin/xcrun', ['--show-sdk-version']), 'read SDK version').stdout.trim()
  requireSuccess(command(compiler, [
    '-isysroot', sdkPath, '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', HELPER_SOURCE, '-o', helper,
  ]), 'compile coalition helper')
  const loadCommands = requireSuccess(command('/usr/bin/otool', ['-l', helper]), 'read helper load commands').stdout
  const buildVersion = /cmd LC_BUILD_VERSION[\s\S]*?platform\s+(\S+)[\s\S]*?minos\s+(\S+)[\s\S]*?sdk\s+(\S+)/.exec(loadCommands)
  assert.ok(buildVersion, 'compiled helper must publish LC_BUILD_VERSION')
  const fixtureText = String.raw`#define _DARWIN_C_SOURCE
#include <crt_externs.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
static void finish(int signal_number) { (void)signal_number; _exit(0); }
static void hold(int clear_environment) {
  if (setsid() < 0) _exit(91);
  if (clear_environment) { static char *empty[] = { NULL }; *_NSGetEnviron() = empty; }
  signal(SIGTERM, finish); signal(SIGALRM, finish); alarm(90);
  for (;;) pause();
}
int main(int argc, char **argv) {
  if (argc != 2) return 64;
  pid_t first = fork(); if (first < 0) return 70; if (first == 0) hold(0);
  pid_t second = fork(); if (second < 0) return 71; if (second == 0) hold(1);
  int descriptor = open(argv[1], O_WRONLY | O_CREAT | O_EXCL, 0600); if (descriptor < 0) return 72;
  if (dprintf(descriptor, "%d %d\n", first, second) < 0 || fsync(descriptor) != 0 || close(descriptor) != 0) return 73;
  return 23;
}
`
  fs.writeFileSync(fixtureSource, fixtureText, { mode: 0o600 })
  requireSuccess(command(compiler, [
    '-isysroot', sdkPath, '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', fixtureSource, '-o', fixture,
  ]), 'compile detached fixture')
  fs.writeFileSync(slowHelperSource, [
    '#include <string.h>',
    '#include <unistd.h>',
    `static const char *helper = ${JSON.stringify(helper)};`,
    'int main(int argc, char **argv) {',
    '  if (argc > 1 && strcmp(argv[1], "inspect") == 0) sleep(3);',
    '  execv(helper, argv);',
    '  return 71;',
    '}',
    '',
  ].join('\n'), { mode: 0o600 })
  requireSuccess(command(compiler, [
    '-isysroot', sdkPath, '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', slowHelperSource, '-o', slowHelper,
  ]), 'compile delayed helper shim')

  const helperBinding = { path: fs.realpathSync.native(helper), sha256: sha256(fs.readFileSync(helper)) }
  const { createDarwinCoalitionAdapter } = require('../../agents/codex/workflow/darwin-launchd-process.js')
  const { ProcessOwner } = require('../../agents/codex/workflow/process-owner.js')
  assert.throws(() => createDarwinCoalitionAdapter({
    controlRoot,
    providerPrivateOwnershipRoot: temporaryRoot,
    helper: { ...helperBinding, sha256: '0'.repeat(64) },
  }), { code: 'PROCESS_IDENTITY_CHANGED' })

  const adapter = createDarwinCoalitionAdapter({ controlRoot, providerPrivateOwnershipRoot: temporaryRoot, helper: helperBinding })
  const reservationId = `native-${crypto.randomUUID()}`
  const owner = new ProcessOwner({
    adapter,
    registryPath,
    pollMs: 50,
    startupTimeoutMs: 60000,
    adapterCallTimeoutMs: 70000,
  })
  let ownership = null
  let children = []
  let fresh = null
  const evidence = {
    schemaVersion: 1,
    platform: `${process.platform}-${process.arch}`,
    helperSha256: helperBinding.sha256,
    helperSourceSha256: sha256(fs.readFileSync(HELPER_SOURCE)),
    compiler: { path: compiler, version: compilerVersion },
    sdkVersion,
    sdkPath,
    deploymentTarget: process.env.MACOSX_DEPLOYMENT_TARGET || 'compiler-default',
    binaryBuildVersion: { platform: buildVersion[1], minimumOs: buildVersion[2], sdk: buildVersion[3] },
  }
  try {
    const launched = await owner.launch({
      reservationId,
      executable: fixture,
      argv: [stateFile],
      cwd: temporaryRoot,
      env: { AUTOPROMPT_OWNERSHIP_RESERVATION: reservationId },
      shell: false,
      targetKey: 'darwin-native-coalition',
    })
    ownership = { rootPid: launched.rootPid, groupIdentity: launched.groupIdentity }
    children = await waitFor(() => {
      if (!fs.existsSync(stateFile)) return null
      const values = fs.readFileSync(stateFile, 'utf8').trim().split(/\s+/).map(Number)
      return values.length === 2 && values.every(value => Number.isSafeInteger(value) && value > 0) ? values : null
    }, 20000, 'detached children did not publish')
    await waitFor(() => !alive(ownership.rootPid), 20000, 'trusted launchd root did not exit')

    fresh = createDarwinCoalitionAdapter({ controlRoot, providerPrivateOwnershipRoot: temporaryRoot, helper: helperBinding })
    const freshOwner = new ProcessOwner({
      adapter: fresh,
      registryPath,
      pollMs: 50,
      startupTimeoutMs: 60000,
      adapterCallTimeoutMs: 70000,
    })
    await freshOwner.recoverReservations()
    const recoveredRecord = freshOwner.listRecords().find(value => value.reservationId === reservationId)
    assert.ok(recoveredRecord)
    assert.equal(recoveredRecord.rootPid, ownership.rootPid)
    assert.equal(recoveredRecord.groupIdentity, ownership.groupIdentity)
    const coalitionId = ownership.groupIdentity.split(':').at(-1)
    const before = helperJson(helper, ['usage', coalitionId])
    assert.equal(before.exists, true)
    assert.equal(BigInt(before.tasksStarted) - BigInt(before.tasksExited) >= 2n, true)
    const members = await fresh.listOwned(ownership.groupIdentity)
    for (const pid of children) assert.equal(members.includes(pid), true)

    await freshOwner.cancelAll({ graceMs: 500, killMs: 30000, reason: 'native crash recovery proof' })
    assert.equal(await freshOwner.assertDrained(), true)
    await waitFor(async () => (await fresh.listOwned(ownership.groupIdentity)).length === 0, 30000, 'coalition did not drain')
    const zeroOne = helperJson(helper, ['usage', coalitionId])
    await sleep(100)
    const zeroTwo = helperJson(helper, ['usage', coalitionId])
    for (const usage of [zeroOne, zeroTwo]) {
      if (usage.exists) assert.equal(usage.tasksStarted, usage.tasksExited)
    }

    const reservationDirectory = path.join(controlRoot, sha256(reservationId))
    const requestPath = path.join(reservationDirectory, 'request.json')
    const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'))
    const absent = command('/bin/launchctl', ['print', `${request.domain}/${request.label}`])
    assert.equal(absent.error, undefined)
    assert.equal(absent.signal, null)
    assert.equal(absent.status, 3)

    const slowControlRoot = path.join(temporaryRoot, 'slow-control')
    const slowBinding = { path: fs.realpathSync.native(slowHelper), sha256: sha256(fs.readFileSync(slowHelper)) }
    const slowAdapter = createDarwinCoalitionAdapter({ controlRoot: slowControlRoot, providerPrivateOwnershipRoot: temporaryRoot, helper: slowBinding })
    const slowReservationId = `slow-${crypto.randomUUID()}`
    const slowRecord = {
      reservationId: slowReservationId,
      reservationIdentity: slowAdapter.reservationIdentity(slowReservationId),
      startupDeadlineAt: new Date(Date.now() + 500).toISOString(),
      targetKey: 'darwin-paused-startup',
    }
    slowRecord.reservationBinding = slowAdapter.prepareReservation(slowRecord)
    await assert.rejects(slowAdapter.spawnOwned({
      ...slowRecord,
      executable: fixture,
      argv: [path.join(temporaryRoot, 'must-not-spawn.txt')],
      cwd: temporaryRoot,
      env: { AUTOPROMPT_OWNERSHIP_RESERVATION: slowReservationId },
      shell: false,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    }), { code: 'PROCESS_RESERVATION_FAILURE' })
    const expired = await slowAdapter.probeReservation(slowRecord)
    assert.equal(expired.state, 'DEAD')
    const slowDirectory = path.join(slowControlRoot, sha256(slowReservationId))
    const slowRequest = JSON.parse(fs.readFileSync(path.join(slowDirectory, 'request.json'), 'utf8'))
    const slowAbsent = command('/bin/launchctl', ['print', `${slowRequest.domain}/${slowRequest.label}`])
    assert.equal(slowAbsent.status, 3)
    await sleep(3500)
    assert.equal(fs.existsSync(path.join(slowDirectory, 'ready.json')), false)
    assert.equal(fs.existsSync(path.join(temporaryRoot, 'must-not-spawn.txt')), false)

    fs.writeFileSync(requestPath, `${JSON.stringify({ ...request, label: `${request.label}.changed` })}\n`, { mode: 0o600 })
    await assert.rejects(fresh.listOwned(ownership.groupIdentity), { code: 'PROCESS_IDENTITY_INVALID' })
    evidence.ownership = ownership
    evidence.terminalRecord = freshOwner.listRecords().find(value => value.reservationId === reservationId)
    evidence.children = children
    evidence.usageBefore = before
    evidence.usageAfter = [zeroOne, zeroTwo]
    evidence.launchctlAbsentStatus = absent.status
    evidence.pausedStartup = { state: expired.state, launchctlAbsentStatus: slowAbsent.status, lateReady: false }
    evidence.checksumRefused = true
    evidence.survivors = children.filter(alive)
    assert.deepEqual(evidence.survivors, [])
  } finally {
    if (ownership && fresh) {
      try { await fresh.signalOwned(ownership.groupIdentity, 'KILL') } catch {}
    }
    if (fs.existsSync(helper)) preserveTestedHelper(helper, evidence)
    if (children.every(pid => !alive(pid))) fs.rmSync(temporaryRoot, { recursive: true, force: true })
    else evidence.retainedRoot = temporaryRoot
    writeEvidence(evidence)
  }
})
