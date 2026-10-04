'use strict'
const fs = require('node:fs')
const cp = require('node:child_process')
const assert = require('node:assert/strict')
const mode = process.argv[2]
const emit = value => fs.writeSync(1, JSON.stringify(value) + '\n')
const execArgv = ['--preserve-symlinks', '--preserve-symlinks-main']
const parentOnly = 'AUTOPROMPT_NODE_PIPE_PARENT_ONLY'
const locator = 'AUTOPROMPT_PRIVATE_NUL_HANDLE'
const missingLocatorExitCode = 86
const missingLocatorCode = 'PRIVATE_NUL_LOCATOR_MISSING'
const wait = (child, expectedExit = 0, mapMissingLocator = false) => new Promise((resolve, reject) => {
  child.once('error', reject)
  child.once('close', (code, signal) => {
    try {
      assert.equal(signal, null); assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0)
      if (mapMissingLocator && code === missingLocatorExitCode) throw Object.assign(new Error('Private NUL locator did not propagate to the empty child environment'), { code: missingLocatorCode })
      assert.equal(code, expectedExit); resolve()
    } catch (error) { reject(error) }
  })
})
const input = () => new Promise((resolve, reject) => {
  let value = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', bytes => { value += bytes; if (value.length > 1024) reject(new Error('stdin bound')) })
  process.stdin.once('error', reject)
  process.stdin.once('end', () => resolve(value))
})
async function roundtrip(child, value, expectedStdout, expectedStderr, mapMissingLocator = false) {
  let stdout = '', stderr = ''
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  child.stdout.on('data', bytes => { stdout += bytes; assert.ok(stdout.length <= 1024) })
  child.stderr.on('data', bytes => { stderr += bytes; assert.ok(stderr.length <= 1024) })
  const completed = wait(child, 0, mapMissingLocator)
  child.stdin.on('error', error => { throw error })
  child.stdin.end(value)
  await completed
  assert.equal(stdout, expectedStdout)
  assert.equal(stderr, expectedStderr)
}
function emptyEnvironment(requireCapability) {
  assert.equal(process.env[parentOnly], undefined)
  if (requireCapability && process.env[locator] === undefined) {
    throw Object.assign(new Error('Private NUL locator is absent from the empty child environment'), { code: missingLocatorCode })
  }
  if (requireCapability) assert.match(process.env[locator], /^[0-9a-f]{16}$/)
}
async function nestedChild(kind, requireCapability) {
  assert.ok(['pipe', 'ignore'].includes(kind))
  emptyEnvironment(requireCapability)
  // The empty env deliberately excludes this child's ambient marker too.
  process.env[parentOnly] = 'child-only-witness'
  const incoming = await input()
  assert.equal(incoming, kind === 'pipe' ? 'stdin-witness\n' : '')
  const payload = 'grandchild:' + kind + ':' + incoming + '\u0000unicode-Ω'
  const prelude = `const assert=require('node:assert/strict');assert.equal(process.env[${JSON.stringify(parentOnly)}],undefined);if(${requireCapability})assert.match(process.env[${JSON.stringify(locator)}]||'',/^[0-9a-f]{16}$/);`
  const piped = cp.spawn(process.execPath, ['-e', prelude + "let value='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>{value+=x;assert.ok(value.length<=1024)});process.stdin.on('end',()=>{process.stdout.write('echo:'+value);process.stderr.write('grandchild-stderr\\n')})"], { env: {}, stdio: 'pipe' })
  await roundtrip(piped, payload, 'echo:' + payload, 'grandchild-stderr\n')
  const ignored = cp.spawn(process.execPath, ['-e', prelude + "const fs=require('node:fs');assert.equal(fs.readSync(0,Buffer.alloc(1),0,1,null),0);assert.equal(fs.writeSync(1,'ignored-write'),13);process.exit(23)"], { env: {}, stdio: 'ignore' })
  await wait(ignored, 23)
  if (kind === 'pipe') {
    process.stdout.write('pipe:' + incoming)
    process.stderr.write('pipe-stderr\n')
  } else process.exitCode = 17
}

if (mode === 'ipc-child') {
  process.once('message', message => {
    assert.deepEqual(message, { request: 'ping' })
    process.send({ reply: 'pong' }, error => {
      if (error) throw error
      process.disconnect()
    })
  })
} else if (mode === 'nested-child') {
  assert.ok(['0', '1'].includes(process.argv[4]))
  nestedChild(process.argv[3], process.argv[4] === '1').catch(error => {
    if (error?.code === missingLocatorCode) process.exitCode = missingLocatorExitCode
    else { console.error(error); process.exitCode = 1 }
  })
} else {
  let phase = 'before-spawn'
  // This inherited HANDLE is already open. Synchronous output survives a
  // libuv loop that blocks before spawn/fork can return to JavaScript.
  emit({ stage: phase, mode, node: process.version, uv: process.versions.uv })
  ;(async () => {
    phase = 'spawn'
    const requireCapability = process.argv[3] === '--require-private-null'
    if (requireCapability) assert.match(process.env[locator] || '', /^[0-9a-f]{16}$/)
    if (mode === 'inherit') {
      const child = cp.spawn(process.execPath, ['-e', "require('node:fs').writeSync(1,'inherit-child\\n');setTimeout(()=>{},100)"], { stdio: 'inherit' })
      await wait(child)
    } else if (mode === 'ignore' || mode === 'pipe') {
      // The native controller requires the capability independently of locator
      // presence, so missing injection cannot silently weaken this proof.
      process.env[parentOnly] = 'parent-only-witness'
      const child = cp.spawn(process.execPath, [...execArgv, __filename, 'nested-child', mode, requireCapability ? '1' : '0'], { env: {}, stdio: mode })
      if (mode === 'pipe') await roundtrip(child, 'stdin-witness\n', 'pipe:stdin-witness\n', 'pipe-stderr\n', requireCapability)
      else await wait(child, 17, requireCapability)
    } else if (mode === 'ipc') {
      const child = cp.fork(__filename, ['ipc-child'], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'], execArgv })
      const received = []
      child.on('message', message => { received.push(message); assert.ok(received.length <= 1) })
      child.send({ request: 'ping' })
      await wait(child)
      assert.deepEqual(received, [{ reply: 'pong' }])
    } else throw new Error('unknown mode')
    emit({ stage: 'passed', mode, children: 1, childExitCode: mode === 'ignore' ? 17 : 0, ...(mode === 'pipe' || mode === 'ignore' ? { grandchildren: 2, grandchildIgnoredExitCode: 23, emptyEnvironment: true } : {}) })
  })().catch(error => {
    emit({ stage: 'failed', mode, phase, code: String(error.code || error.name).slice(0, 80) })
    process.exitCode = 1
  })
}
