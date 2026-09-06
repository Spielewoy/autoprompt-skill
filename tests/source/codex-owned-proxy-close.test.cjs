#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const WORKFLOW = path.join(ROOT, 'agents', 'codex', 'workflow')
const {
  OwnedCodexProxyRunner,
  createCodexJsonlAccumulator,
} = require(path.join(WORKFLOW, 'phase-budget.js'))
const {
  ProcessOwner,
  createPosixProcessAdapter,
  createWindowsJobAdapter,
  prepareProcessLaunchEnvironment,
} = require(path.join(WORKFLOW, 'process-owner.js'))
const { ensureWindowsPrivateAcl } = require(path.join(WORKFLOW, 'safe-run-root.js'))

async function waitFor(predicate, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(`timed out waiting for ${description}`)
}

test('owned Codex proxy publishes status only after inherited output closes and retains final usage', {
  timeout: 30_000,
}, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-owned-proxy-close-'))
  const processControlRoot = path.join(directory, 'process-control')
  const proxyControlRoot = path.join(directory, 'proxy-control')
  const releasePath = path.join(directory, 'release-grandchild')
  const rootPidPath = path.join(directory, 'child-root.pid')
  const rootExitedPath = path.join(directory, 'child-root-exited.json')
  const childRootPath = path.join(directory, 'child-root.cjs')
  const grandchildPath = path.join(directory, 'delayed-grandchild.cjs')
  fs.mkdirSync(processControlRoot)
  fs.mkdirSync(proxyControlRoot)
  if (process.platform === 'win32') ensureWindowsPrivateAcl(directory)

  const finalOutput = Object.freeze({
    reportType: 'result',
    reportId: 'delayed-final-output',
    allAssignedItemsPass: true,
  })
  fs.writeFileSync(grandchildPath, [
    "'use strict'",
    "const fs = require('node:fs')",
    'const [releasePath, rootExitedPath, rootPidText, finalOutputText] = process.argv.slice(2)',
    'const rootPid = Number(rootPidText)',
    'function rootIsAlive() {',
    "  try { process.kill(rootPid, 0); return true } catch (error) { return error.code !== 'ESRCH' }",
    '}',
    'function awaitRelease() {',
    '  if (!fs.existsSync(releasePath)) { setTimeout(awaitRelease, 5); return }',
    '  const events = [',
    "    { type: 'item.completed', item: { type: 'agent_message', text: finalOutputText } },",
    "    { type: 'turn.completed', usage: { input_tokens: 13, cached_input_tokens: 5, output_tokens: 3, reasoning_output_tokens: 2 } },",
    '  ]',
    "  fs.writeSync(1, `${events.map(JSON.stringify).join('\\n')}\\n`)",
    '}',
    'function awaitRootExit() {',
    '  if (rootIsAlive()) { setTimeout(awaitRootExit, 5); return }',
    "  fs.writeFileSync(rootExitedPath, `${JSON.stringify({ rootPid, observedExited: true })}\\n`)",
    '  awaitRelease()',
    '}',
    'awaitRootExit()',
    '',
  ].join('\n'))
  fs.writeFileSync(childRootPath, [
    "'use strict'",
    "const fs = require('node:fs')",
    "const { spawn } = require('node:child_process')",
    'const [grandchildPath, releasePath, rootPidPath, rootExitedPath, finalOutputText] = process.argv.slice(2)',
    "fs.writeFileSync(rootPidPath, `${process.pid}\\n`)",
    "fs.writeSync(1, `${JSON.stringify({ type: 'thread.started', thread_id: '11111111-2222-4333-8444-555555555555' })}\\n`)",
    'const grandchild = spawn(process.execPath, [',
    '  grandchildPath, releasePath, rootExitedPath, String(process.pid), finalOutputText,',
    "], { shell: false, windowsHide: true, stdio: ['ignore', 1, 2] })",
    'grandchild.unref()',
    'process.exit(0)',
    '',
  ].join('\n'))

  const processAdapter = process.platform === 'win32'
    ? createWindowsJobAdapter({
        controlRoot: processControlRoot,
        providerPrivateOwnershipRoot: directory,
      })
    : createPosixProcessAdapter()
  const owner = new ProcessOwner({
    adapter: processAdapter,
    registryPath: path.join(directory, 'process-registry.json'),
    pollMs: 5,
  })
  const runner = new OwnedCodexProxyRunner({
    processOwner: owner,
    controlRoot: proxyControlRoot,
    targetKey: 'delayed-output-target',
    pollMs: 5,
  })
  const sessionId = 'delayed-output-session'
  const reservationId = crypto.randomUUID()
  let request = null
  const launchOwned = owner.launch.bind(owner)
  owner.launch = async spec => {
    request = JSON.parse(fs.readFileSync(spec.argv.at(-1), 'utf8'))
    return launchOwned(spec)
  }
  t.after(async () => {
    try { fs.writeFileSync(releasePath, 'release\n') } catch {}
    try { await runner.stop({ sessionId, reason: 'test cleanup' }) } catch {}
    try {
      await owner.cancelAll({ reason: 'test cleanup', graceMs: 0, killMs: 2_000 })
    } catch {}
    fs.rmSync(directory, { recursive: true, force: true })
  })

  const accumulator = createCodexJsonlAccumulator()
  let lineCount = 0
  const executionPromise = runner.run({
    executable: process.execPath,
    argv: [
      childRootPath, grandchildPath, releasePath, rootPidPath, rootExitedPath,
      JSON.stringify(finalOutput),
    ],
    cwd: directory,
    env: prepareProcessLaunchEnvironment(processAdapter, reservationId, process.env),
    stdin: '',
    sessionId,
    reservationId,
    onStdoutLine(line) {
      lineCount += 1
      accumulator.push(line, lineCount)
    },
  })

  await waitFor(() => fs.existsSync(rootExitedPath), 10_000, 'the delayed grandchild to observe root exit')
  await waitFor(() => lineCount === 1, 5_000, 'the initial thread event')
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.ok(request, 'the real process owner must receive the proxy request')
  const rootExit = JSON.parse(fs.readFileSync(rootExitedPath, 'utf8'))
  assert.equal(rootExit.observedExited, true)
  assert.equal(rootExit.rootPid, Number(fs.readFileSync(rootPidPath, 'utf8').trim()))
  assert.equal(fs.existsSync(request.statusPath), false,
    'the proxy must not publish status while a descendant still holds inherited stdout open')
  assert.equal(lineCount, 1, 'the delayed terminal records must remain pending until release')

  fs.writeFileSync(releasePath, 'release\n')
  const execution = await executionPromise
  const parsed = accumulator.snapshot()
  assert.equal(fs.existsSync(request.statusPath), true)
  assert.equal(execution.status, 0)
  assert.equal(execution.drained, true)
  assert.equal(lineCount, 3)
  assert.deepEqual(parsed.output, finalOutput)
  assert.deepEqual(parsed.usage, {
    noncachedInput: 8,
    cachedInput: 5,
    output: 3,
    reasoning: 2,
  })
  await owner.assertTargetDrained('delayed-output-target')
  await owner.assertDrained()
})
