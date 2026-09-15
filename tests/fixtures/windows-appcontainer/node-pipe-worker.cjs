'use strict'
const fs = require('node:fs')
const cp = require('node:child_process')
const assert = require('node:assert/strict')
const mode = process.argv[2]
const emit = value => fs.writeSync(1, JSON.stringify(value) + '\n')
const execArgv = ['--preserve-symlinks', '--preserve-symlinks-main']
if (mode === 'ipc-child') {
  process.once('message', message => {
    assert.deepEqual(message, { request: 'ping' })
    process.send({ reply: 'pong' }, error => {
      if (error) throw error
      process.disconnect()
    })
  })
} else {
  let phase = 'before-spawn'
  // This inherited HANDLE is already open. Synchronous output survives a
  // libuv loop that blocks before spawn/fork can return to JavaScript.
  emit({ stage: phase, mode, node: process.version, uv: process.versions.uv })
  const wait = child => new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => {
      try { assert.equal(code, 0); assert.equal(signal, null); resolve() } catch (error) { reject(error) }
    })
  })
  ;(async () => {
    phase = 'spawn'
    if (mode === 'inherit') {
      const child = cp.spawn(process.execPath, ['-e', "require('node:fs').writeSync(1,'inherit-child\\n');setTimeout(()=>{},100)"], { stdio: 'inherit' })
      await wait(child)
    } else if (mode === 'pipe') {
      const child = cp.spawn(process.execPath, ['-e', "let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{process.stdout.write('pipe:'+input);process.stderr.write('pipe-stderr\\n')})"], { stdio: 'pipe' })
      let stdout = '', stderr = ''
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
      child.stdout.on('data', bytes => { stdout += bytes; assert.ok(stdout.length <= 1024) })
      child.stderr.on('data', bytes => { stderr += bytes; assert.ok(stderr.length <= 1024) })
      child.stdin.on('error', error => { throw error })
      child.stdin.end('stdin-witness\n')
      await wait(child)
      assert.equal(stdout, 'pipe:stdin-witness\n')
      assert.equal(stderr, 'pipe-stderr\n')
    } else if (mode === 'ipc') {
      const child = cp.fork(__filename, ['ipc-child'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], execArgv })
      const received = []
      child.on('message', message => { received.push(message); assert.ok(received.length <= 1) })
      child.send({ request: 'ping' })
      await wait(child)
      assert.deepEqual(received, [{ reply: 'pong' }])
    } else throw new Error('unknown mode')
    emit({ stage: 'passed', mode })
  })().catch(error => {
    emit({ stage: 'failed', mode, phase, code: String(error.code || error.name).slice(0, 80) })
    process.exitCode = 1
  })
}
