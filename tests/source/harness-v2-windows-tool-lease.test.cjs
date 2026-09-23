'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const test = require('node:test')
const leaseModule = require('../../scripts/harness-v2-windows-tool-lease.cjs')

function fakeFilesystem() {
  const files = new Map()
  const directories = new Set(['C:\\Windows', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'])
  return {
    files, directories,
    lstatSync(file) {
      if (directories.has(file)) return { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, nlink: 1 }
      if (!files.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return { isFile: () => true, isSymbolicLink: () => false, nlink: 1 }
    },
    readFileSync: file => Buffer.from(files.get(file)),
    existsSync: file => files.has(file) || directories.has(file),
    unlinkSync: file => files.delete(file),
  }
}

test('Windows tool lease binds exact bytes and releases only through its delete-on-close holder', async () => {
  const filesystem = fakeFilesystem(), lockPath = 'C:\\private\\server.lock', lockBytes = Buffer.from('{"exact":true}')
  let invocation
  const spawn = (executable, argv, options) => {
    invocation = { executable, argv, options }
    const child = new EventEmitter()
    child.pid = 42; child.stderr = new EventEmitter(); child.kill = () => true
    child.stdin = Object.assign(new EventEmitter(), { end() { filesystem.files.delete(lockPath); queueMicrotask(() => child.emit('close', 0, null)) }, destroy() {} })
    filesystem.files.set(lockPath, lockBytes)
    const readyPath = Buffer.from(options.env.AUTOPROMPT_TOOL_LEASE_READY_PATH_B64, 'base64').toString('utf8')
    filesystem.files.set(readyPath, Buffer.from(options.env.AUTOPROMPT_TOOL_LEASE_READY_BYTES_B64, 'base64'))
    return child
  }
  const lease = leaseModule.createWindowsToolLease({ platform: 'win32', fs: filesystem, spawn, wait() {},
    environment: { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', SECRET: 'must-not-cross' }, lockPath, lockBytes })
  lease.assertHeld()
  assert.equal(invocation.executable, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  assert.equal(invocation.options.detached, false)
  assert.equal(invocation.options.env.SECRET, undefined)
  assert.deepEqual(Object.keys(invocation.options.env).filter(name => !name.startsWith('AUTOPROMPT_')).sort(), ['PATH', 'SystemDrive', 'SystemRoot', 'TEMP', 'TMP', 'WINDIR'])
  assert.match(Buffer.from(invocation.argv.at(-1), 'base64').toString('utf16le'), /DeleteOnClose/)
  filesystem.files.set(lockPath, Buffer.from('foreign'))
  assert.throws(() => lease.assertHeld(), { code: 'TOOL_LEASE_LOST' })
  filesystem.files.set(lockPath, lockBytes)
  await lease.release()
  assert.equal(filesystem.existsSync(lockPath), false)
})

test('Windows tool lease fails closed when the exact kernel-held file is not established', () => {
  const filesystem = fakeFilesystem()
  const spawn = () => {
    const child = new EventEmitter()
    child.pid = 43; child.stderr = new EventEmitter(); child.stdin = Object.assign(new EventEmitter(), { end() {}, destroy() {} }); child.kill = () => true
    return child
  }
  assert.throws(() => leaseModule.createWindowsToolLease({ platform: 'win32', fs: filesystem, spawn, wait() {}, startTimeoutMs: 1,
    environment: { SystemRoot: 'C:\\Windows' }, lockPath: 'C:\\private\\server.lock', lockBytes: Buffer.from('exact') }),
  { code: 'TOOL_LEASE_UNAVAILABLE' })
})

test('Windows tool lease rejects a preexisting exact-looking lock before spawning its holder', () => {
  const filesystem = fakeFilesystem(), lockPath = 'C:\\private\\server.lock', lockBytes = Buffer.from('exact')
  filesystem.files.set(lockPath, lockBytes)
  let spawned = false
  assert.throws(() => leaseModule.createWindowsToolLease({ platform: 'win32', fs: filesystem, spawn() { spawned = true },
    environment: { SystemRoot: 'C:\\Windows' }, lockPath, lockBytes }), { code: 'TOOL_LEASE_INVALID' })
  assert.equal(spawned, false)
})

test('Windows tool lease consumes an asynchronous spawn error and fails startup closed', () => {
  const filesystem = fakeFilesystem()
  let emitted = false
  const spawn = () => {
    const child = new EventEmitter()
    child.pid = undefined; child.stderr = new EventEmitter(); child.kill = () => true
    child.stdin = Object.assign(new EventEmitter(), { end() {}, destroy() {} })
    child.emitFailure = () => child.emit('error', Object.assign(new Error('async spawn failure'), { code: 'ENOENT' }))
    return child
  }
  let child
  assert.throws(() => leaseModule.createWindowsToolLease({ platform: 'win32', fs: filesystem,
    spawn(...args) { child = spawn(...args); return child }, wait() { if (!emitted) { emitted = true; child.emitFailure() } },
    environment: { SystemRoot: 'C:\\Windows' }, lockPath: 'C:\\private\\server.lock', lockBytes: Buffer.from('exact') }),
  error => error.code === 'TOOL_LEASE_UNAVAILABLE' && /ENOENT/.test(error.message))
})

test('Windows tool lease retains one failed release promise for every retry', async () => {
  const filesystem = fakeFilesystem(), lockPath = 'C:\\private\\server.lock', lockBytes = Buffer.from('exact')
  const spawn = (_executable, _argv, options) => {
    const child = new EventEmitter()
    child.pid = 44; child.stderr = new EventEmitter(); child.kill = () => true
    child.stdin = Object.assign(new EventEmitter(), { end() { queueMicrotask(() => child.emit('error', Object.assign(new Error('holder failure'), { code: 'EIO' }))) }, destroy() {} })
    filesystem.files.set(lockPath, lockBytes)
    const readyPath = Buffer.from(options.env.AUTOPROMPT_TOOL_LEASE_READY_PATH_B64, 'base64').toString('utf8')
    filesystem.files.set(readyPath, Buffer.from(options.env.AUTOPROMPT_TOOL_LEASE_READY_BYTES_B64, 'base64'))
    return child
  }
  const lease = leaseModule.createWindowsToolLease({ platform: 'win32', fs: filesystem, spawn, wait() {},
    environment: { SystemRoot: 'C:\\Windows' }, lockPath, lockBytes })
  const first = lease.release(), second = lease.release()
  assert.strictEqual(second, first)
  await assert.rejects(first, error => error.code === 'TOOL_LEASE_RELEASE_FAILED' && /EIO/.test(error.message))
  assert.strictEqual(lease.release(), first)
  await assert.rejects(lease.release(), { code: 'TOOL_LEASE_RELEASE_FAILED' })
})
