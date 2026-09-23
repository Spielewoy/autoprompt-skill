'use strict'

// Candidate-only regression for the Darwin PID-snapshot race. The packaged
// helper remains untouched until a native artifact proves this candidate.
const assert = require('node:assert/strict')
const cp = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { ProcessOwner } = require('../../agents/codex/workflow/process-owner.js')
const { createDarwinCoalitionAdapter } = require('../../agents/codex/workflow/darwin-launchd-process.js')

const ROOT = path.resolve(__dirname, '../..')
const SOURCE = path.join(ROOT, 'tests/helpers/darwin-coalition-helper-churn.c')
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const run = (file, argv, options = {}) => cp.spawnSync(file, argv, { encoding: 'utf8', shell: false, timeout: 60000, maxBuffer: 4 * 1024 * 1024, ...options })

test('Darwin coalition churn candidate compiles and drains a held coalition with disappearing snapshots', { skip: process.platform !== 'darwin', timeout: 180000 }, async t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ap-darwin-churn-candidate-')))
  let owner
  t.after(async () => {
    if (owner) {
      await owner.cancelAll({ reason: 'candidate churn cleanup', graceMs: 0, killMs: 10000, waitForPending: true })
      await owner.assertDrained()
    }
    fs.rmSync(root, { recursive: true, force: true })
  })
  const compiler = run('/usr/bin/xcrun', ['--find', 'clang'])
  assert.equal(compiler.status, 0, compiler.stderr)
  const sdk = run('/usr/bin/xcrun', ['--show-sdk-path'])
  assert.equal(sdk.status, 0, sdk.stderr)
  let output = path.resolve(process.env.AUTOPROMPT_DARWIN_CANDIDATE_PATH || path.join(root, 'darwin-coalition-helper-churn'))
  const compile = run(compiler.stdout.trim(), ['-isysroot', sdk.stdout.trim(), '-mmacosx-version-min=13.5', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', SOURCE, '-o', output])
  assert.equal(compile.status, 0, compile.stderr)
  fs.chmodSync(output, 0o500)
  output = fs.realpathSync.native(output)
  const boot = run(output, ['boot']); assert.equal(boot.status, 0, boot.stderr)
  const value = JSON.parse(boot.stdout)
  assert.equal(value.schemaVersion, 1); assert.equal(value.ok, true); assert.match(value.bootUuid, /^[a-f0-9-]{36}$/)
  const fixtureSource = path.join(root, 'churn-fixture.c'), fixture = path.join(root, 'churn-fixture'), state = path.join(root, 'state.txt')
  fs.writeFileSync(fixtureSource, String.raw`#define _DARWIN_C_SOURCE
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
static void stop(int s) { (void)s; _exit(0); }
static void hold(void) {
  signal(SIGTERM, stop); signal(SIGCHLD, SIG_IGN); alarm(90);
  for (int i = 0; i < 120; i++) {
    pid_t p = fork(); if (p < 0) _exit(72); if (p == 0) _exit(0);
    usleep(25000);
  }
  for (;;) pause();
}
int main(int argc, char **argv) {
  if (argc != 2) return 64;
  pid_t child = fork(); if (child < 0) return 70; if (child == 0) hold();
  int fd = open(argv[1], O_WRONLY | O_CREAT | O_EXCL, 0600); if (fd < 0) return 71;
  if (dprintf(fd, "%d\n", child) < 0 || fsync(fd) != 0 || close(fd) != 0) return 73;
  hold(); return 0;
}
`, { mode: 0o600 })
  const fixtureBuild = run(compiler.stdout.trim(), ['-isysroot', sdk.stdout.trim(), '-mmacosx-version-min=13.5', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', fixtureSource, '-o', fixture])
  assert.equal(fixtureBuild.status, 0, fixtureBuild.stderr)
  fs.chmodSync(fixture, 0o500)
  const controlRoot = path.join(root, 'control'), registryPath = path.join(controlRoot, 'processes.json')
  fs.mkdirSync(controlRoot, { mode: 0o700 })
  const helperBinding = { path: output, sha256: sha256(fs.readFileSync(output)) }
  const adapter = createDarwinCoalitionAdapter({ controlRoot, providerPrivateOwnershipRoot: root, helper: helperBinding })
  owner = new ProcessOwner({ adapter, registryPath, pollMs: 25, startupTimeoutMs: 60000, adapterCallTimeoutMs: 70000 })
  const usageAfter = []
  let launched, usageBefore
  {
    const reservationId = `churn-${crypto.randomUUID()}`
    launched = await owner.launch({ reservationId, executable: fixture, argv: [state], cwd: root, env: { AUTOPROMPT_OWNERSHIP_RESERVATION: reservationId }, shell: false, targetKey: 'darwin-helper-churn' })
    const request = JSON.parse(fs.readFileSync(path.join(controlRoot, sha256(reservationId), 'request.json'), 'utf8'))
    assert.equal(request.helper.sha256, helperBinding.sha256, 'owned cancellation must use the candidate helper')
    const deadline = Date.now() + 20000
    while (!fs.existsSync(state) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
    assert.equal(fs.existsSync(state), true, 'held fixture did not publish its child')
    const coalition = launched.groupIdentity.split(':').at(-1)
    const helper = argv => {
      const result = run(output, argv); assert.equal(result.status, 0, result.stderr || result.stdout)
      const json = JSON.parse(result.stdout); assert.equal(json.ok, true, JSON.stringify(json)); return json
    }
    const heldPid = Number(fs.readFileSync(state, 'utf8').trim()); assert.ok(Number.isSafeInteger(heldPid) && heldPid > 1)
    usageBefore = helper(['usage', coalition]); assert.equal(usageBefore.exists, true); assert.ok(BigInt(usageBefore.tasksStarted) > BigInt(usageBefore.tasksExited))
    for (let i = 0; i < 20; i++) {
      const census = helper(['census', coalition]); assert.equal(census.complete, true); assert.deepEqual(census.errors, []); assert.ok(census.members.some(member => member.pid === heldPid)); assert.ok(census.members.some(member => member.pid === launched.rootPid))
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    const churned = helper(['usage', coalition]); assert.ok(BigInt(churned.tasksStarted) > 2n); assert.ok(BigInt(churned.tasksExited) > 0n)
    await owner.cancelAll({ reason: 'candidate churn proof drain', graceMs: 100, killMs: 30000, waitForPending: true })
    assert.equal(await owner.assertDrained(), true)
    for (let i = 0; i < 2; i++) {
      const after = helper(['usage', coalition]); if (after.exists) assert.equal(after.tasksStarted, after.tasksExited)
      usageAfter.push(after)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  const proof = { schemaVersion: 1, sourceSha256: sha256(fs.readFileSync(SOURCE)), binarySha256: sha256(fs.readFileSync(output)), architecture: process.arch, compiler: compiler.stdout.trim(), sdk: sdk.stdout.trim(), bootUuid: value.bootUuid, heldCoalitionDrain: true, censusIterations: 20, usageBefore, usageAfter }
  const proofPath = process.env.AUTOPROMPT_DARWIN_CANDIDATE_EVIDENCE
  if (proofPath) fs.writeFileSync(path.resolve(proofPath), `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 })
  t.diagnostic(JSON.stringify(proof))
})
