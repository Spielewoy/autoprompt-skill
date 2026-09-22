'use strict'
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const test = require('node:test')
function stat(identity, size = 0, directory = false) { return { dev: BigInt('0x' + identity.slice(0, 8)).toString(), ino: BigInt('0x' + identity.slice(9)).toString(), mode: directory ? 0o040666 : 0o100666, nlink: 1, size } }
const { parseCapture, parseRecordResult, parseTransactionResult } = require('../../agents/codex/workflow/windows-filesystem.js')

test('Windows capture parser binds returned bytes to the declared digest', () => {
  const content = Buffer.from('capture')
  const value = { schemaVersion: 1, status: 'CAPTURED', operation: 'read', identity: '1234abcd:0000000100000002', length: content.length, sha256: crypto.createHash('sha256').update(content).digest('hex'), dataBase64: content.toString('base64'), stat: stat('1234abcd:0000000100000002', content.length) }
  assert.deepEqual(parseCapture(JSON.stringify(value), 'read').content, content)
  assert.throws(() => parseCapture(JSON.stringify({ ...value, sha256: '0'.repeat(64) }), 'read'), { code: 'FILESYSTEM_BACKEND_UNAVAILABLE' })
})

test('Windows capture parser preserves only closed helper refusals', () => {
  assert.throws(() => parseCapture(JSON.stringify({ schemaVersion: 1, status: 'REFUSED', code: 'PREIMAGE_UNSAFE' }), 'hash'), { code: 'PREIMAGE_UNSAFE' })
  assert.throws(() => parseCapture('{}', 'hash'), { code: 'FILESYSTEM_BACKEND_UNAVAILABLE' })
})

function treeFixture() {
  const content = Buffer.from([0, 255, 97, 10])
  return { schemaVersion: 1, status: 'TREE_CAPTURED', operation: 'tree', bytes: content.length, entries: [
    { type: 'directory', path: '', identity: '1234abcd:0000000000000001', attributes: 16, stat: stat('1234abcd:0000000000000001', 0, true) },
    { type: 'directory', path: 'nested', identity: '1234abcd:0000000000000002', attributes: 16, stat: stat('1234abcd:0000000000000002', 0, true) },
    { type: 'file', path: 'nested/data', identity: '1234abcd:0000000000000003', attributes: 32, stat: stat('1234abcd:0000000000000003', content.length), length: content.length, sha256: crypto.createHash('sha256').update(content).digest('hex'), dataBase64: content.toString('base64') },
  ] }
}

test('Windows tree capture hashes exact returned bytes and directory metadata', () => {
  const value = treeFixture()
  const parsed = parseCapture(JSON.stringify(value), 'tree')
  const expected = crypto.createHash('sha256').update('directory\0nested\0' + 0o666 + '\0').update('file\0nested/data\0' + 0o666 + '\0' + value.bytes + '\0').update(Buffer.from([0, 255, 97, 10])).update('\0').digest('hex')
  assert.equal(parsed.hash, expected)
  assert.equal(parsed.bytes, 4)
  assert.deepEqual(parsed.entries[2].content, Buffer.from([0, 255, 97, 10]))
  assert.ok(Object.isFrozen(parsed.entries))
  assert.equal(parseCapture(JSON.stringify({ ...value, bytes: 0, entries: value.entries.slice(0, 1) }), 'tree').hash, crypto.createHash('sha256').digest('hex'))
})

test('Windows tree protocol refuses unsafe, ambiguous, missing, and unbound entries', () => {
  const mutations = [
    value => { value.extra = true },
    value => { value.bytes++ },
    value => { value.entries[0].path = 'root' },
    value => { value.entries[1].attributes |= 0x400 },
    value => { value.entries[2].attributes |= 0x10 },
    value => { value.entries[2].path = '../data' },
    value => { value.entries[2].path = 'nested/data:stream' },
    value => { value.entries[2].path = 'nested/data.' },
    value => { value.entries[2].path = 'missing/data' },
    value => { value.entries[2].path = 'NESTED/data' },
    value => { value.entries[2].identity = value.entries[1].identity },
    value => { value.entries[2].identity = '9876abcd:0000000000000003' },
    value => { value.entries[2].length++ },
    value => { value.entries[2].sha256 = '0'.repeat(64) },
    value => { value.entries[2].dataBase64 = 'AP9hCh==' }, // noncanonical pad bits
    value => { value.entries[2].dataBase64 += '\n' },
    value => { value.entries[2].extra = false },
    value => { value.entries[2].stat.nlink = 2 },
    value => { value.entries[2].stat.ino = '999' },
    value => { value.entries[2].stat.dev = '999' },
    value => { value.entries[2].stat.size++ },
    value => { value.entries[2].stat.mode = 0o100777 },
    value => { value.entries.push({ ...value.entries[2], path: 'nested/DATA', identity: '1234abcd:0000000000000004' }) },
    value => { value.entries = [] },
    value => { value.entries[1].path = Array(129).fill('deep').join('/') },
    value => { value.entries = Array(16385).fill(value.entries[0]) },
    value => { value.bytes = 67108865 },
  ]
  for (const mutate of mutations) {
    const value = treeFixture(); mutate(value)
    assert.throws(() => parseCapture(JSON.stringify(value), 'tree'), { code: 'FILESYSTEM_BACKEND_UNAVAILABLE' }, String(mutate))
  }
  assert.throws(() => parseCapture('{}', 'enumerate'), { code: 'FILESYSTEM_BACKEND_INVALID' })
})

test('Windows wrapper exposes absolute file and tree captures with bounded closed requests', () => {
  const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path')
  const filename = path.resolve(__dirname, '../../agents/codex/workflow/windows-filesystem.js')
  const calls = [], descriptors = new Map(); let nextDescriptor = 1, invocationOverride, clock = 0n
  const physicalStat = { isFile: () => true, isSymbolicLink: () => false, dev: 123, ino: 456, mode: 0o100666, nlink: 1, size: 1, mtimeMs: 1, ctimeMs: 1 }
  const fakeFs = { mkdtempSync: () => 'C:\\private-temp', rmSync: () => {}, constants: { O_RDONLY: 0 }, lstatSync: () => physicalStat, realpathSync: { native: value => value },
    openSync: value => { const fd = nextDescriptor++; descriptors.set(fd, value); return fd }, fstatSync: () => physicalStat,
    readSync: (fd, buffer) => { buffer[0] = 97; return 1 }, closeSync: fd => descriptors.delete(fd) }

  const sandbox = { Buffer, process: { platform: 'win32', hrtime: { bigint: () => { clock += 30000000000n; return clock } }, env: { SystemRoot: 'C:\\Windows', MALICIOUS: 'omitted' } }, __dirname: path.dirname(filename), module: { exports: {} }, require: name => name === 'node:child_process' ? { spawnSync: (...args) => {
    calls.push(args)
    if (invocationOverride) return invocationOverride
    const request = JSON.parse(args[2].input)
    if (['fsync-directory', 'fsync-tree', 'mkdir-exclusive', 'write-exclusive', 'copy-tree-exclusive', 'rename-tree-no-replace'].includes(request.operation)) {
      const wire = transactionFixture(request.operation, request.operation !== 'write-exclusive', request.bytesBase64 ? Buffer.from(request.bytesBase64, 'base64') : Buffer.alloc(0))
      if (wire.result.stat && request.mode !== undefined && !(request.mode & 0o222)) wire.result.stat.mode = (wire.result.type === 'directory' ? 0o040000 : 0o100000) | 0o444
      return { status: 0, stderr: '', stdout: JSON.stringify(wire) }
    }
    if (request.operation === 'inspect-owned-target') return { status: 0, stderr: '', stdout: JSON.stringify({ schemaVersion: 1, status: 'INSPECTED', parentIdentity: { dev: '123', ino: '1' }, targetIdentity: { type: 'directory', dev: '123', ino: '2' } }) }
    if (request.operation === 'remove-owned-target') return { status: 0, stderr: '', stdout: JSON.stringify({ schemaVersion: 1, status: 'REMOVED', removed: true }) }
    if (request.operation === 'recover-record-publication') return { status: 0, stderr: '', stdout: JSON.stringify({ schemaVersion: 1, status: 'RECOVERED', removed: [] }) }
    if (request.operation === 'publish-record-exclusive' || request.operation === 'assert-record-parent') {
      const published = request.operation === 'publish-record-exclusive', bytes = published ? Buffer.from(request.bytesBase64, 'base64') : null
      const value = { schemaVersion: 1, status: published ? 'PUBLISHED' : 'PARENT_VERIFIED', identity: '1234abcd:0000000000000001', stat: stat('1234abcd:0000000000000001', bytes?.length || 0, !published), ...(published ? { length: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') } : {}) }
      return { status: 0, stdout: JSON.stringify(value), stderr: '' }
    }
    const value = request.operation === 'tree' ? treeFixture() : { schemaVersion: 1, status: 'CAPTURED', operation: request.operation, identity: '1234abcd:0000000000000001', length: 0, stat: stat('1234abcd:0000000000000001'), sha256: crypto.createHash('sha256').digest('hex'), ...(request.operation === 'read' ? { dataBase64: '' } : {}) }
    return { status: 0, stdout: JSON.stringify(value), stderr: '' }
  } } : name === 'node:fs' ? fakeFs
    : name === './safe-run-root.js' ? { createWindowsCompilerDirectory: prefix => { assert.equal(prefix, 'autoprompt-windows-capture-'); return 'C:\\private-temp' }, windowsControllerEnvironment: (systemRoot, temp) => ({ SystemRoot: systemRoot, WINDIR: systemRoot, SystemDrive: 'C:', PATH: 'C:\\Windows\\System32', PSModulePath: '', TEMP: temp, TMP: temp }) }
    : require(name) }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename })
  const capture = sandbox.module.exports.createWindowsFilesystemCapture({ helper: 'C:\\trusted\\windows-filesystem.ps1' })
  assert.equal(capture.captureTree('C:\\project').bytes, 4)
  assert.equal(capture.captureFile('C:\\project\\empty').bytes, 0)
  assert.equal(capture.captureFileBytes('C:\\', ['project', 'empty'], 1).content.length, 0)
  assert.deepEqual(JSON.parse(calls[0][2].input), { schemaVersion: 1, operation: 'tree', root: 'C:\\', components: ['project'], maxBytes: 67108864 })
  assert.equal(calls[0][2].shell, false)
  assert.equal(calls[0][2].timeout, 30000)
  assert.equal(calls[0][0], 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  assert.equal(calls[0][2].env.MALICIOUS, undefined)
  assert.equal(calls[0][2].env.AUTOPROMPT_CAPTURE_PHASES, '1')
  assert.equal(calls[0][2].env.TEMP, 'C:\\private-temp')
  assert.equal(calls[0][2].env.TMP, 'C:\\private-temp')
  assert.equal(descriptors.size, 0)
  assert.ok(calls[0][2].maxBuffer >= Math.ceil(67108864 / 3) * 4)
  for (const target of ['C:\\project\\..\\escape', 'C:\\project\\', '\\\\server\\share', 'C:\\project\\CON', 'C:\\project\\a:b']) {
    assert.throws(() => capture.captureTree(target), { code: 'FILESYSTEM_BACKEND_INVALID' })
  }
  assert.throws(() => capture.captureTree('C:\\', ['project'], 3), { code: 'FILESYSTEM_BACKEND_UNAVAILABLE' })
  assert.throws(() => capture.captureTree('C:\\', ['project'], 67108865), { code: 'FILESYSTEM_BACKEND_INVALID' })
  assert.equal(capture.assertRecordParent('C:\\project\\terminal').stat.mode, 0o040666)
  assert.equal(capture.recoverRecordPublication('C:\\project\\terminal').length, 0)
  assert.equal(capture.publishRecordExclusive('C:\\project\\terminal', Buffer.from('record')).stat.size, 6)
  const publication = JSON.parse(calls.at(-1)[2].input)
  assert.deepEqual(publication, { schemaVersion: 1, operation: 'publish-record-exclusive', root: 'C:\\', components: ['project', 'terminal'], bytesBase64: Buffer.from('record').toString('base64') })
  assert.throws(() => capture.publishRecordExclusive('C:\\project\\terminal', Buffer.alloc(8388610)), { code: 'FILESYSTEM_BACKEND_INVALID' })
  assert.equal(descriptors.size, 0)
  const owned = capture.inspectOwnedTarget('C:\\project\\scratch')
  assert.equal(owned.targetIdentity.type, 'directory')
  assert.equal(capture.removeOwnedTarget('C:\\project\\scratch', owned.parentIdentity, owned.targetIdentity).removed, true)
  assert.deepEqual(JSON.parse(calls.at(-1)[2].input), { schemaVersion: 1, operation: 'remove-owned-target', root: 'C:\\', components: ['project', 'scratch'], parentIdentity: { dev: '123', ino: '1' }, targetIdentity: { type: 'directory', dev: '123', ino: '2' } })
  assert.throws(() => capture.removeOwnedTarget('C:\\project\\scratch', { dev: '123', ino: '1', extra: true }, owned.targetIdentity), { code: 'FILESYSTEM_BACKEND_INVALID' })
  assert.equal(capture.fsyncDirectory('C:\\project').flushed, true)
  assert.equal(capture.fsyncTree('C:\\project').flushed, true)
  assert.equal(capture.mkdirExclusive('C:\\project\\created', 0o400).stat.mode, 0o040444)
  assert.equal(capture.writeExclusive('C:\\project\\bytes', Buffer.from('exact'), 0o600).stat.size, 5)
  assert.deepEqual(JSON.parse(calls.at(-1)[2].input), { schemaVersion: 1, operation: 'write-exclusive', root: 'C:\\', components: ['project', 'bytes'], mode: 0o600, bytesBase64: Buffer.from('exact').toString('base64') })
  capture.copyTreeExclusive('C:\\project\\source', 'D:\\private\\copy')
  assert.deepEqual(JSON.parse(calls.at(-1)[2].input).destination, { root: 'D:\\', components: ['private', 'copy'] })
  assert.equal(calls.at(-1)[2].timeout, 120000)
  capture.renameTreeNoReplace('C:\\project\\source', 'C:\\project\\moved')
  assert.equal(calls.at(-1)[2].timeout, 30000)
  for (const call of calls) assert.equal(call[2].timeout, JSON.parse(call[2].input).operation === 'copy-tree-exclusive' ? 120000 : 30000)
  assert.equal(JSON.parse(calls.at(-1)[2].input).operation, 'rename-tree-no-replace')
  assert.throws(() => capture.mkdirExclusive('C:\\project\\bad', 0o10000), { code: 'FILESYSTEM_BACKEND_INVALID' })
  assert.throws(() => capture.writeExclusive('C:\\project\\bad', Buffer.alloc(8388610), 0o600), { code: 'FILESYSTEM_BACKEND_INVALID' })
  invocationOverride = { error: { code: 'ETIMEDOUT' }, signal: 'SIGTERM', status: null,
    stderr: ['input', 'input-encoding-created', 'input-encoding-set', 'input-initialized', 'input-reading', 'input-eof', 'compile'].map((phase, index) => `AUTOPROMPT_CAPTURE_PHASE:${phase}:${index * 2}\r\n`).join(''), stdout: 'private captured data must not be copied into errors' }
  assert.throws(() => capture.captureTree('C:\\project'), error => {
    assert.equal(error.code, 'FILESYSTEM_BACKEND_UNAVAILABLE')
    assert.match(error.message, /compile: ETIMEDOUT/)
    assert.equal(error.details.helperPhase, 'compile')
    assert.match(error.message, /totalMs=30000; phaseMs=input=0,.*compile=12; unaccountedMs=29988/)
    assert.equal(error.details.timeoutMs, 30000)
    assert.equal(error.details.invocationElapsedMs, 30000)
    assert.equal(error.details.phaseElapsedMs.compile, 12)
    assert.equal(error.details.unaccountedMs, 29988)
    assert.equal(error.details.cause, 'ETIMEDOUT')
    assert.equal(error.details.stderr, '')
    assert.doesNotMatch(JSON.stringify(error), /private captured data/)
    return true
  })
  assert.throws(() => capture.copyTreeExclusive('C:\\project\\source', 'C:\\private\\copy'), error => {
    assert.equal(error.details.timeoutMs, 120000); assert.equal(error.details.cause, 'ETIMEDOUT'); return true
  })
  assert.equal(descriptors.size, 0)
  invocationOverride = undefined
  const invoked = calls.length
  fakeFs.readSync = (fd, buffer) => { buffer[0] = 98; return 1 }
  assert.throws(() => capture.captureTree('C:\\project'), { code: 'FILESYSTEM_BACKEND_MISMATCH' })
  assert.equal(calls.length, invoked)
  assert.equal(descriptors.size, 0)
})

test('Windows capture phases accept only bounded monotonic contiguous timing and preserve unexpected stderr', () => {
  const { invocationDiagnostics } = require('../../agents/codex/workflow/windows-filesystem.js')
  const phases = ['input', 'input-encoding-created', 'input-encoding-set', 'input-initialized', 'input-reading', 'input-eof', 'compile', 'compiled', 'dispatch', 'completed']
  const marker = (phase, time) => `AUTOPROMPT_CAPTURE_PHASE:${phase}:${time}\r\n`
  for (let count = 0; count <= phases.length; count++) {
    const selected = phases.slice(0, count), trace = selected.map((phase, index) => marker(phase, index * 10)).join('')
    assert.deepEqual(invocationDiagnostics(trace), {
      helperPhase: count ? phases[count - 1] : 'startup',
      phaseElapsedMs: Object.fromEntries(selected.map((phase, index) => [phase, index * 10])), stderr: '',
    })
    assert.equal(invocationDiagnostics(trace + 'compiler error').stderr, 'compiler error')
  }
  for (const invalid of ['-1', '1.5', 'NaN', 'Infinity', '1e3', '01', '300001', '9999999999999999999', '', '0:extra', ' 1', '1 ']) {
    const trace = marker('input', invalid)
    assert.equal(invocationDiagnostics(trace).stderr, trace, 'Malformed elapsed time must remain a refusal')
  }
  assert.equal(invocationDiagnostics(marker('input', 300000)).phaseElapsedMs.input, 300000)
  assert.equal(invocationDiagnostics(marker('input', 3) + marker('input-encoding-created', 3)).stderr, '')
  const descending = marker('input-encoding-created', 2)
  assert.deepEqual(invocationDiagnostics(marker('input', 3) + descending), {
    helperPhase: 'input', phaseElapsedMs: { input: 3 }, stderr: descending,
  })
  for (const trace of [marker('native', 0), marker('compiled', 0), marker('input', 0) + marker('input', 1),
    'AUTOPROMPT_CAPTURE_PHASE:input:0', '\n', '\r\n', marker('input', 0) + '\n',
    marker('input', 0) + 'noise\n' + marker('compile', 1),
    marker('input', 0) + marker('compile', 1), marker('input', 0) + marker('input-reading', 1),
    marker('input', 0) + marker('completed', 1), marker('input', 0).replace('\r\n', '\0\n')]) {
    assert.notEqual(invocationDiagnostics(trace).stderr, '', 'Malformed phase output must still refuse the invocation')
  }
  assert.deepEqual(invocationDiagnostics(marker('input', 0) + '\n' + marker('compile', 1)),
    { helperPhase: 'input', phaseElapsedMs: { input: 0 }, stderr: '\n' + marker('compile', 1) })
})


test('Windows publication parser binds the immutable record and maps only explicit collision refusals', () => {
  const content = Buffer.from('terminal record'), identity = '1234abcd:0000000000000001'
  const value = { schemaVersion: 1, status: 'PUBLISHED', identity, stat: stat(identity, content.length), length: content.length, sha256: crypto.createHash('sha256').update(content).digest('hex') }
  assert.equal(parseRecordResult(JSON.stringify(value), 'publish-record-exclusive', content).stat.size, content.length)
  for (const mutate of [value => { value.sha256 = '0'.repeat(64) }, value => { value.stat.nlink = 2 }, value => { value.length++ }, value => { value.extra = true }]) {
    const changed = JSON.parse(JSON.stringify(value)); mutate(changed)
    assert.throws(() => parseRecordResult(JSON.stringify(changed), 'publish-record-exclusive', content), { code: 'FILESYSTEM_BACKEND_UNAVAILABLE' })
  }
  assert.throws(() => parseRecordResult(JSON.stringify({ schemaVersion: 1, status: 'REFUSED', code: 'FILESYSTEM_ALREADY_EXISTS' }), 'publish-record-exclusive', content), { code: 'EEXIST' })
  assert.throws(() => parseRecordResult(JSON.stringify({ schemaVersion: 1, status: 'REFUSED', code: 'FILESYSTEM_ALREADY_EXISTS', extra: true }), 'publish-record-exclusive', content), { code: 'FILESYSTEM_BACKEND_UNAVAILABLE' })
})


test('Windows recovery parser accepts only bound per-leaf residue names', () => {
  const name = '.terminal.json.1234.0123456789abcdef.create'
  assert.deepEqual(parseRecordResult(JSON.stringify({ schemaVersion: 1, status: 'RECOVERED', removed: [name] }), 'recover-record-publication', undefined, 'terminal.json'), [name])
  for (const removed of [[name, name], ['.other.json.1234.0123456789abcdef.create'], ['../terminal.json'], ['.terminal.json.0.0123456789abcdef.create'], ['.terminal.json.4294967296.0123456789abcdef.create']]) {
    assert.throws(() => parseRecordResult(JSON.stringify({ schemaVersion: 1, status: 'RECOVERED', removed }), 'recover-record-publication', undefined, 'terminal.json'), { code: 'FILESYSTEM_BACKEND_UNAVAILABLE' })
  }
})


test('Windows owned cleanup parser closes identity and removal framing', () => {
  const value = { schemaVersion: 1, status: 'INSPECTED', parentIdentity: { dev: '123', ino: '1' }, targetIdentity: { type: 'directory', dev: '123', ino: '2' } }
  assert.equal(parseRecordResult(JSON.stringify(value), 'inspect-owned-target').targetIdentity.ino, '2')
  for (const mutate of [value => { value.targetIdentity.dev = '456' }, value => { value.parentIdentity.ino = '01' }, value => { value.targetIdentity.type = 'link' }, value => { value.parentIdentity.extra = 1 }, value => { value.targetIdentity.ino = '18446744073709551616' }]) {
    const changed = JSON.parse(JSON.stringify(value)); mutate(changed)
    assert.throws(() => parseRecordResult(JSON.stringify(changed), 'inspect-owned-target'), { code: 'FILESYSTEM_BACKEND_UNAVAILABLE' })
  }
  assert.equal(parseRecordResult(JSON.stringify({ schemaVersion: 1, status: 'REMOVED', removed: false }), 'remove-owned-target').removed, false)
  assert.throws(() => parseRecordResult(JSON.stringify({ schemaVersion: 1, status: 'REMOVED', removed: 'false' }), 'remove-owned-target'), { code: 'FILESYSTEM_BACKEND_UNAVAILABLE' })
  assert.throws(() => parseCapture(JSON.stringify({ schemaVersion: 1, status: 'REFUSED', code: 'FILESYSTEM_NOT_FOUND' }), 'read'), { code: 'ENOENT' })
})

function transactionFixture(operation, directory = false, content = Buffer.alloc(0)) {
  const identity = '1234abcd:0000000000000001'
  const result = operation.startsWith('fsync-') ? { flushed: true } : { identity, stat: stat(identity, content.length, directory), type: directory ? 'directory' : 'file', ...(operation === 'write-exclusive' ? { length: content.length, sha256: crypto.createHash('sha256').update(content).digest('hex') } : {}) }
  return { schemaVersion: 1, status: 'TRANSACTED', operation, result }
}
test('Windows transaction results bind exclusive bytes, readonly projection, and closed operation identity', () => {
  const bytes = Buffer.from([0, 255, 1]), wire = transactionFixture('write-exclusive', false, bytes)
  assert.equal(parseTransactionResult(JSON.stringify(wire), 'write-exclusive', bytes, 0o600).stat.size, bytes.length)
  assert.throws(() => parseTransactionResult(JSON.stringify(wire), 'write-exclusive', Buffer.from('bad'), 0o600), { code: 'FILESYSTEM_BACKEND_UNAVAILABLE' })
  assert.throws(() => parseTransactionResult(JSON.stringify(wire), 'write-exclusive', bytes, 0o400), { code: 'FILESYSTEM_BACKEND_UNAVAILABLE' })
  wire.result.stat.mode = 0o100444
  assert.equal(parseTransactionResult(JSON.stringify(wire), 'write-exclusive', bytes, 0o400).stat.mode, 0o100444)
  for (const operation of ['mkdir-exclusive', 'copy-tree-exclusive', 'rename-tree-no-replace']) {
    const value = transactionFixture(operation, true)
    assert.equal(parseTransactionResult(JSON.stringify(value), operation, undefined, 0o700).stat.mode, 0o040666)
    assert.throws(() => parseTransactionResult(JSON.stringify({ ...value, extra: 1 }), operation, undefined, 0o700), { code: 'FILESYSTEM_BACKEND_UNAVAILABLE' })
    assert.throws(() => parseTransactionResult(JSON.stringify({ ...value, operation: 'fsync-tree' }), operation, undefined, 0o700), { code: 'FILESYSTEM_BACKEND_UNAVAILABLE' })
  }
})
test('Windows transaction protocol distinguishes missing tree, required directory, collisions, and cross-device refusal', () => {
  assert.deepEqual(parseTransactionResult(JSON.stringify(transactionFixture('fsync-directory')), 'fsync-directory'), { flushed: true })
  const absent = transactionFixture('fsync-tree'); absent.result.flushed = false
  assert.deepEqual(parseTransactionResult(JSON.stringify(absent), 'fsync-tree'), { flushed: false })
  absent.operation = 'fsync-directory'
  assert.throws(() => parseTransactionResult(JSON.stringify(absent), 'fsync-directory'), { code: 'FILESYSTEM_BACKEND_UNAVAILABLE' })
  for (const [native, code] of [['FILESYSTEM_ALREADY_EXISTS', 'EEXIST'], ['FILESYSTEM_CROSS_DEVICE', 'EXDEV'], ['FILESYSTEM_NOT_FOUND', 'ENOENT'], ['FILESYSTEM_DURABILITY_UNAVAILABLE', 'FILESYSTEM_DURABILITY_UNAVAILABLE']]) {
    assert.throws(() => parseTransactionResult(JSON.stringify({ schemaVersion: 1, status: 'REFUSED', code: native }), 'rename-tree-no-replace'), { code })
  }
})


test('Windows tree parser accepts the full 16384-entry boundary and refuses overflow without truncation', () => {
  const root = treeFixture().entries[0]
  const entries = [root]
  const expected = crypto.createHash('sha256')
  for (let index = 1; index < 16384; index++) {
    const identity = '1234abcd:' + (index + 1).toString(16).padStart(16, '0')
    const name = 'd' + String(index).padStart(5, '0')
    entries.push({ type: 'directory', path: name, identity, attributes: 16, stat: stat(identity, 0, true) })
    expected.update('directory\0' + name + '\0' + 0o666 + '\0')
  }
  const value = { schemaVersion: 1, status: 'TREE_CAPTURED', operation: 'tree', bytes: 0, entries }
  const parsed = parseCapture(JSON.stringify(value), 'tree')
  assert.equal(parsed.entries.length, 16384)
  assert.equal(parsed.hash, expected.digest('hex'))
  const identity = '1234abcd:0000000000004001'
  entries.push({ type: 'directory', path: 'overflow', identity, attributes: 16, stat: stat(identity, 0, true) })
  assert.throws(() => parseCapture(JSON.stringify(value), 'tree'), { code: 'FILESYSTEM_BACKEND_UNAVAILABLE' })
})

test('Windows record recovery retains its independent 4096-name boundary', () => {
  const removed = Array.from({ length: 4096 }, (_, index) => '.terminal.json.1234.' + index.toString(16).padStart(16, '0') + '.create')
  const result = () => parseRecordResult(JSON.stringify({ schemaVersion: 1, status: 'RECOVERED', removed }), 'recover-record-publication', undefined, 'terminal.json')
  assert.deepEqual(result(), removed)
  removed.push('.terminal.json.1234.0000000000001000.create')
  assert.throws(result, { code: 'FILESYSTEM_BACKEND_UNAVAILABLE' })
})
