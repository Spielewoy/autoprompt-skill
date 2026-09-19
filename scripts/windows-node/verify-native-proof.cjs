'use strict'
// Verify retained native observations; this does not execute or install a worker.
const assert = require('node:assert/strict')
const fs = require('node:fs'), crypto = require('node:crypto')
const NAMES = Object.freeze([
  'Node pipe worker selection binds an explicit physical file and rejects incomplete or changed bindings',
  'Node pipe diagnostic fixture proves exact host stdio and fork IPC roundtrips',
  'native-only Node requirement refuses a missing locator instead of relaxing the proof',
  'nested Node worker refuses a locator that does not propagate through an empty child environment',
  'native Windows Node pipe diagnostic records stdio and fork IPC support with owned job drain',
])
const MODES = Object.freeze(['inherit', 'pipe', 'ipc', 'ignore'])
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
function expectedPass(mode) {
  return { stage: 'passed', mode, children: 1, childExitCode: mode === 'ignore' ? 17 : 0,
    ...(mode === 'pipe' || mode === 'ignore' ? { grandchildren: 2, grandchildIgnoredExitCode: 23, emptyEnvironment: true } : {}) }
}
function verifyNativeProof(bytes, identity) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 256 * 1024, 'Bounded native TAP required')
  assert.ok(identity && /^v24\.20\.0$/.test(identity.node) && identity.uv === '1.52.1' && identity.platform === 'win32' && ['x64', 'arm64'].includes(identity.arch), 'Exact candidate identity required')
  const raw = bytes.toString('utf8'); assert.ok(Buffer.from(raw).equals(bytes), 'UTF-8 TAP required')
  const text = raw.replaceAll('\r\n', '\n'); assert.ok(!text.includes('\r') && text.endsWith('\n'), 'Complete TAP records required')
  const lines = text.split('\n')
  assert.equal(lines[0], 'TAP version 13', 'Exact TAP header required')
  assert.equal(lines.filter(line => line === 'TAP version 13').length, 1, 'One TAP stream required')
  assert.ok(!lines.some(line => /^\s*Bail out!/.test(line) || line.includes('Retained owned fixture after unconfirmed controller outcome:')), 'Incomplete native cleanup or TAP bailout refused')
  assert.deepEqual(lines.filter(line => /^(?:not ok|ok)\b/.test(line)), NAMES.map((name, index) => `ok ${index + 1} - ${name}`), 'Exactly five passing native tests without SKIP/TODO required')
  assert.deepEqual(lines.filter(line => /^\d+\.\.\d+/.test(line)), ['1..5'], 'Exact native TAP plan required')
  for (const [field, value] of Object.entries({ tests: 5, suites: 0, pass: 5, fail: 0, cancelled: 0, skipped: 0, todo: 0 })) {
    assert.deepEqual(lines.filter(line => line.startsWith(`# ${field} `)), [`# ${field} ${value}`], 'Complete zero-failure native totals required')
  }
  assert.ok(!lines.some(line => line.startsWith('# stderr:')), 'Native stderr must be empty')
  const chunks = lines.filter(line => line.startsWith('# stdout: ')).map(line => line.slice(10))
  assert.ok(chunks.length >= 4 && chunks.every(chunk => chunk.length > 0 && chunk.length <= 480), 'Bounded native diagnostic records required')
  // The actual controller emits flat objects; only Base64 strings carry worker
  // output. Rejoin the test's 480-character chunks without accepting new syntax.
  const joined = chunks.join(''), records = joined.match(/\{[^{}]*\}/g) || []
  assert.equal(records.join(''), joined, 'Unframed native observations refused')
  assert.equal(records.length, 4, 'All four native modes must execute exactly once')
  for (const [index, record] of records.entries()) {
    const value = JSON.parse(record), mode = MODES[index]
    assert.deepEqual(Object.keys(value).sort(), ['drained', 'exitCode', 'mode', 'observedJobMembers', 'stderrBase64', 'stdoutBase64', 'timedOut'])
    assert.equal(record, JSON.stringify(value), 'Native record serialization changed')
    assert.equal(value.mode, mode); assert.equal(value.exitCode, 0); assert.equal(value.timedOut, false); assert.equal(value.drained, true); assert.equal(value.stderrBase64, '')
    assert.ok(Number.isSafeInteger(value.observedJobMembers) && value.observedJobMembers >= 1 && value.observedJobMembers <= 1024)
    assert.ok(typeof value.stdoutBase64 === 'string' && value.stdoutBase64.length <= 21848)
    const output = Buffer.from(value.stdoutBase64, 'base64'); assert.equal(output.toString('base64'), value.stdoutBase64)
    const expected = JSON.stringify({ stage: 'before-spawn', mode, node: identity.node, uv: identity.uv }) + '\n' +
      (mode === 'inherit' ? 'inherit-child\n' : '') + JSON.stringify(expectedPass(mode)) + '\n'
    assert.ok(output.equals(Buffer.from(expected)), `Exact ${mode} subprocess effects required`)
  }
  assert.deepEqual(lines.filter(line => /^# Node /.test(line)), MODES.map(mode => `# Node ${identity.node} libuv ${identity.uv} ${mode}: exact roundtrip passed; owned job drained`))
  return Object.freeze({ tests: 5, nativeModes: 4, skipped: 0, proofSha256: sha(bytes), architecture: identity.arch })
}
function readBounded(file, limit) {
  const fd = fs.openSync(file, 'r')
  try {
    const before = fs.fstatSync(fd, { bigint: true })
    assert.ok(before.isFile() && before.nlink === 1n && before.size > 0n && before.size <= BigInt(limit))
    const bytes = Buffer.alloc(Number(before.size)); let offset = 0
    while (offset < bytes.length) { const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset); assert.ok(count > 0); offset += count }
    assert.equal(fs.readSync(fd, Buffer.alloc(1), 0, 1, bytes.length), 0)
    const after = fs.fstatSync(fd, { bigint: true })
    for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink']) assert.equal(before[key], after[key])
    return bytes
  } finally { fs.closeSync(fd) }
}
function verifyStage(proofBytes, provenanceBytes, nodeBytes, expectedNodeSha256) {
  assert.ok(Buffer.isBuffer(nodeBytes) && nodeBytes.length >= 90 && nodeBytes.length <= 128 * 1024 * 1024)
  assert.ok(Buffer.isBuffer(provenanceBytes) && provenanceBytes.length > 0 && provenanceBytes.length <= 1024 * 1024)
  assert.match(expectedNodeSha256, /^[a-f0-9]{64}$/)
  assert.equal(sha(nodeBytes), expectedNodeSha256)
  assert.ok(provenanceBytes.length <= 1024 * 1024)
  const provenance = JSON.parse(provenanceBytes), lock = require('./build-lock.json')
  assert.equal(provenance.schema, 1); assert.equal(provenance.nodeSha256, expectedNodeSha256)
  for (const key of ['source', 'patch', 'nulPatch']) assert.deepEqual(provenance[key], lock[key])
  assert.ok(['x64', 'arm64'].includes(provenance.architecture))
  assert.equal(provenance.osArchitecture.toLowerCase(), provenance.architecture)
  assert.equal(provenance.processArchitecture.toLowerCase(), provenance.architecture)
  assert.equal(provenance.identity.arch, provenance.architecture)
  assert.ok(nodeBytes.length >= 90 && nodeBytes.readUInt16LE(0) === 0x5a4d)
  const pe = nodeBytes.readUInt32LE(60); assert.ok(pe >= 64 && pe <= nodeBytes.length - 26)
  assert.equal(nodeBytes.readUInt32LE(pe), 0x4550)
  assert.equal(nodeBytes.readUInt16LE(pe + 4), provenance.architecture === 'x64' ? 0x8664 : 0xaa64)
  const flags = nodeBytes.readUInt16LE(pe + 22); assert.ok((flags & 2) !== 0 && (flags & 0x2000) === 0)
  assert.equal(nodeBytes.readUInt16LE(pe + 24), 0x20b)
  return Object.freeze({ ...verifyNativeProof(proofBytes, provenance.identity), nodeSha256: expectedNodeSha256, provenanceSha256: sha(provenanceBytes) })
}
if (require.main === module) {
  assert.equal(process.argv.length, 6, 'Usage: node verify-native-proof.cjs TAP PROVENANCE NODE EXPECTED_NODE_SHA256')
  const result = verifyStage(readBounded(process.argv[2], 256 * 1024), readBounded(process.argv[3], 1024 * 1024), readBounded(process.argv[4], 128 * 1024 * 1024), process.argv[5])
  process.stdout.write(JSON.stringify(result) + '\n')
}
module.exports = { verifyNativeProof, verifyStage, NAMES, MODES, expectedPass }
