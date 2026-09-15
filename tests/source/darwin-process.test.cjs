'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const darwin = require('../../agents/codex/workflow/darwin-process.js')

const helper = path.resolve(__dirname, '../../agents/codex/workflow/darwin-process.py')
const runDarwinObserver = process.platform === 'darwin' && process.env.AUTOPROMPT_REAL_DARWIN_PROCESS === '1'

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }
async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  let latest
  while (Date.now() < deadline) {
    latest = predicate()
    if (latest) return latest
    await sleep(50)
  }
  return latest
}
async function waitForClose(child, timeoutMs = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) return
  await Promise.race([
    new Promise(resolve => child.once('close', resolve)),
    sleep(timeoutMs).then(() => { throw new Error('Darwin observer child did not exit') }),
  ])
}

function parserFixture(payload, reservation = 'fixture-marker') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-proc-parser-'))
  const fixture = path.join(root, 'fixture.bin')
  const runner = path.join(root, 'runner.py')
  fs.writeFileSync(fixture, payload, { mode: 0o600 })
  fs.writeFileSync(runner, [
    'import importlib.util, pathlib, sys',
    `spec=importlib.util.spec_from_file_location('darwin_process', ${JSON.stringify(helper)})`,
    'module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)',
    'try:',
    `  print('present=' + str(module.parse_procargs2(pathlib.Path(${JSON.stringify(fixture)}).read_bytes(), ${JSON.stringify(reservation)})))`,
    'except module.UnknownProcess as error:',
    "  print('unknown=' + error.reason)",
  ].join('\n'), { mode: 0o600 })
  const result = childProcess.spawnSync('python3', ['-I', '-S', '-B', runner], { encoding: 'utf8', env: { PATH: process.env.PATH || '/usr/bin:/bin' }, timeout: 10000 })
  fs.rmSync(root, { recursive: true, force: true })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

function procargs({ argc = 1, executable = '/usr/bin/node', argv = ['node'], environment = [] } = {}) {
  return Buffer.concat([
    Buffer.from(Uint32Array.of(argc).buffer), Buffer.from(executable + '\0'), Buffer.from('\0\0'),
    ...argv.map(value => Buffer.from(value + '\0')),
    Buffer.from('\0'), ...environment.map(value => Buffer.isBuffer(value) ? Buffer.concat([value, Buffer.from('\0')]) : Buffer.from(value + '\0')),
  ])
}

test('Darwin procargs parser accepts only an exact NUL-delimited reservation entry', () => {
  const payload = procargs({ environment: ['PATH=/usr/bin', 'AUTOPROMPT_OWNERSHIP_RESERVATION=fixture-marker', 'OTHER=1'] })
  assert.equal(parserFixture(payload), 'present=True')
  assert.equal(parserFixture(procargs({ environment: ['AUTOPROMPT_OWNERSHIP_RESERVATION=fixture-marker-extra'] })), 'present=False')
  assert.equal(parserFixture(procargs({ environment: ['OTHER=fixture-marker'] })), 'present=False')
  assert.equal(parserFixture(procargs({ argc: 0, argv: [], environment: ['AUTOPROMPT_OWNERSHIP_RESERVATION=fixture-marker'] })), 'present=True')
  assert.equal(parserFixture(procargs({ argc: 3, argv: ['node', '', 'tail'], environment: ['AUTOPROMPT_OWNERSHIP_RESERVATION=fixture-marker'] })), 'present=True')
})

test('Darwin procargs parser treats truncation, argv mismatch, malformed entries, and opaque environment bytes as UNKNOWN', () => {
  assert.match(parserFixture(Buffer.from([1, 0, 0, 0, 47, 0, 0, 110])), /^unknown=PROCARGS_TRUNCATED$/)
  assert.match(parserFixture(procargs({ argc: 2, argv: ['node'], environment: [] })), /^unknown=PROCARGS_(TRUNCATED|MALFORMED|ENV_UNAVAILABLE)$/)
  assert.match(parserFixture(procargs({ environment: ['MALFORMED'] })), /^unknown=PROCARGS_MALFORMED$/)
  assert.match(parserFixture(procargs({ environment: [Buffer.from([0xff, 0x3d, 0x31])] })), /^unknown=PROCARGS_MALFORMED$/)
  assert.match(parserFixture(procargs({ environment: [] })), /^unknown=PROCARGS_ENV_UNAVAILABLE$/)
})

test('Darwin UID-filtered proc_listpids interprets byte counts and refuses ambiguous truncation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-pid-list-'))
  const runner = path.join(root, 'runner.py')
  fs.writeFileSync(runner, [
    'import ctypes, importlib.util, os',
    `spec=importlib.util.spec_from_file_location('darwin_process', ${JSON.stringify(helper)})`,
    'm=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    // This unit fixture supplies the Darwin caller UID; Windows Python has no getuid.
    'os.getuid=lambda: 4242',
    'class Fake:',
    '  def __init__(self, result): self.result=result; self.calls=[]',
    '  def proc_listpids(self, kind, uid, values, size):',
    '    self.calls.append((kind,uid,size)); values[0]=17; values[1]=3; return size if self.result == -1 else self.result',
    'for result, expected in ((8,[3,17]), (6,"PIDLIST_MALFORMED"), (-1,"PIDLIST_GREW")):',
    '  probe=m.DarwinProc.__new__(m.DarwinProc); probe.proc=Fake(result)',
    '  try: got=probe.pids()\n  except m.UnknownProcess as e: got=e.reason',
    '  assert got == expected, (result,got); assert probe.proc.calls[0][0] == m.PROC_UID_ONLY; assert probe.proc.calls[0][1] == 4242',
  ].join('\n'), { mode: 0o600 })
  try {
    const result = childProcess.spawnSync('python3', ['-I', '-S', '-B', runner], { encoding: 'utf8', timeout: 10000 })
    assert.equal(result.status, 0, result.stderr)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('Darwin wrapper accepts no environment-shaped output and validates closed result forms', () => {
  const live = darwin.parseResult('{"bootSessionUuid":"12345678-1234-1234-1234-123456789abc","executablePath":"/usr/bin/node","pgid":1,"pid":2,"ppid":1,"schemaVersion":1,"startSec":3,"startUsec":4,"status":"LIVE","uid":5}\n')
  assert.equal(live.status, 'LIVE')
  assert.throws(() => darwin.parseResult('{"schemaVersion":1,"status":"LIVE","pid":2,"ppid":1,"uid":5,"pgid":1,"startSec":3,"startUsec":4,"bootSessionUuid":"12345678-1234-1234-1234-123456789abc","executablePath":"/usr/bin/node","environment":"secret"}\n'), { code: 'PROCESS_IDENTITY_UNAVAILABLE' })
  assert.throws(() => darwin.parseResult('{"schemaVersion":1,"status":"UNKNOWN","reason":"PROCARGS_DENIED","argv":[]}\n'), { code: 'PROCESS_IDENTITY_UNAVAILABLE' })
})

test('Darwin reservation scans are observations and cannot assert complete absence', () => {
  const observed = darwin.parseResult('{"matches":[],"schemaVersion":1,"status":"OBSERVED"}\n')
  assert.equal(observed.status, 'OBSERVED')
  assert.deepEqual(observed.matches, [])
  assert.throws(() => darwin.parseResult('{"matches":[],"schemaVersion":1,"status":"COMPLETE"}\n'), { code: 'PROCESS_IDENTITY_UNAVAILABLE' })
})

test('fixed helper stays closed and reports non-Darwin observation as UNKNOWN without environment output', { skip: process.platform === 'darwin' }, () => {
  const result = childProcess.spawnSync('python3', ['-I', '-S', '-B', helper, '--request'], {
    encoding: 'utf8', input: JSON.stringify({ schemaVersion: 1, operation: 'observe', pid: process.pid }) + '\n', timeout: 10000,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { schemaVersion: 1, status: 'UNKNOWN', reason: 'DARWIN_UNAVAILABLE' })
})

test('fixed helper rejects extra request fields before platform observation', () => {
  const result = childProcess.spawnSync('python3', ['-I', '-S', '-B', helper, '--request'], {
    encoding: 'utf8', input: JSON.stringify({ schemaVersion: 1, operation: 'observe', pid: process.pid, environment: 'forbidden' }) + '\n', timeout: 10000,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { schemaVersion: 1, status: 'UNKNOWN', reason: 'REQUEST_INVALID' })
})

test('Darwin wrapper refuses use outside Darwin before resolving a helper or Python runtime', () => {
  if (process.platform === 'darwin') return
  assert.throws(() => darwin.createDarwinProcessObserver({ python: '/missing/python', helper: '/missing/helper.py' }), { code: 'PROCESS_IDENTITY_UNAVAILABLE' })
})

test('Darwin wrapper binds a bounded large Python executable without relaxing the helper limit', () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-process-size-')))
  const python = path.join(root, 'python')
  const oversizedHelper = path.join(root, 'oversized-helper.py')
  fs.writeFileSync(python, Buffer.alloc(4 * 1024 * 1024 + 1, 0x50), { mode: 0o700 })
  fs.writeFileSync(oversizedHelper, Buffer.alloc(4 * 1024 * 1024 + 1, 0x23), { mode: 0o600 })
  const runner = [
    "Object.defineProperty(process, 'platform', { value: 'darwin' })",
    `const observer = require(${JSON.stringify(path.resolve(__dirname, '../../agents/codex/workflow/darwin-process.js'))})`,
    `const python = ${JSON.stringify(python)}`,
    `const helper = ${JSON.stringify(fs.realpathSync.native(helper))}`,
    `const oversizedHelper = ${JSON.stringify(oversizedHelper)}`,
    "const bound = observer.createDarwinProcessObserver({ python, helper })",
    "if (bound.python.size <= 4 * 1024 * 1024 || bound.helper.size > 4 * 1024 * 1024) process.exit(2)",
    "try { observer.createDarwinProcessObserver({ python, helper: oversizedHelper }); process.exit(3) } catch (error) { if (error.code !== 'PROCESS_IDENTITY_UNAVAILABLE') process.exit(4) }",
  ].join(';')
  try {
    const result = childProcess.spawnSync(process.execPath, ['-e', runner], { encoding: 'utf8', timeout: 10000 })
    assert.equal(result.status, 0, result.stderr)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('actual Darwin observer binds an owned child and reports reservation membership only as OBSERVED', { skip: !runDarwinObserver }, async t => {
  const python = process.env.AUTOPROMPT_REAL_DARWIN_PYTHON
  assert.equal(typeof python, 'string', 'AUTOPROMPT_REAL_DARWIN_PYTHON must identify the physical signed Python executable')
  assert.ok(path.isAbsolute(python), 'AUTOPROMPT_REAL_DARWIN_PYTHON must be absolute')
  const observer = darwin.createDarwinProcessObserver({ python, helper, timeoutMs: 10000 })
  const reservation = `darwin-observer-${process.pid}-${Date.now()}`
  const child = childProcess.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: false,
    env: { AUTOPROMPT_OWNERSHIP_RESERVATION: reservation },
    stdio: 'ignore',
  })
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
  assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0, 'owned child must have a PID')
  const live = await waitFor(() => {
    const value = observer.observe(child.pid)
    return value.status === 'LIVE' ? value : null
  })
  assert.ok(live, 'owned child must become a live libproc identity')
  assert.equal(live.pid, child.pid)
  assert.equal(live.uid, process.getuid())
  assert.equal(fs.realpathSync(live.executablePath), fs.realpathSync(process.execPath))
  let lastReservationResult
  const scan = await waitFor(() => {
    const value = observer.findReservation(reservation)
    lastReservationResult = value
    return value.status === 'OBSERVED' && value.matches.some(match => match.pid === child.pid) ? value : null
  })
  assert.ok(scan, `reservation scan must observe the exact owned child marker; last result: ${JSON.stringify(lastReservationResult)}`)
  assert.equal(scan.status, 'OBSERVED')
  assert.ok(scan.matches.some(match => match.pid === child.pid && match.uid === process.getuid()))
  child.kill('SIGTERM')
  await waitForClose(child)
  const after = observer.observe(child.pid)
  assert.equal(after.status, 'DEAD')
})
