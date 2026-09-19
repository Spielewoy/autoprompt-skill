'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { verifyNativeProof, verifyStage, NAMES, MODES, expectedPass } = require('./verify-native-proof.cjs')
const identity = { node: 'v24.20.0', uv: '1.52.1', platform: 'win32', arch: 'arm64' }
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
function observation(mode) {
  const output = JSON.stringify({ stage: 'before-spawn', mode, node: identity.node, uv: identity.uv }) + '\n' +
    (mode === 'inherit' ? 'inherit-child\n' : '') + JSON.stringify(expectedPass(mode)) + '\n'
  return { mode, exitCode: 0, timedOut: false, drained: true, observedJobMembers: mode === 'pipe' || mode === 'ignore' ? 4 : 3, stdoutBase64: Buffer.from(output).toString('base64'), stderrBase64: '' }
}
function log(records = MODES.map(observation)) {
  const lines = ['TAP version 13', ...NAMES.map((name, i) => `ok ${i + 1} - ${name}`)]
  for (const record of records) {
    const text = JSON.stringify(record)
    for (let offset = 0; offset < text.length; offset += 480) lines.push('# stdout: ' + text.slice(offset, offset + 480))
  }
  lines.push(...MODES.map(mode => `# Node ${identity.node} libuv ${identity.uv} ${mode}: exact roundtrip passed; owned job drained`),
    '1..5', '# tests 5', '# suites 0', '# pass 5', '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0', '')
  return Buffer.from(lines.join('\n'))
}
test('strict proof parser accepts complete synthetic framing on LF and CRLF without claiming native execution', () => {
  for (const bytes of [log(), Buffer.from(log().toString().replaceAll('\n', '\r\n'))]) {
    assert.deepEqual(verifyNativeProof(bytes, identity), { tests: 5, nativeModes: 4, skipped: 0, architecture: 'arm64', proofSha256: hash(bytes) })
  }
})
for (const field of ['drained', 'timedOut', 'exitCode', 'observedJobMembers', 'stderrBase64', 'stdoutBase64', 'mode']) {
  test('refuses altered native observation ' + field, () => {
    const records = MODES.map(observation)
    records[1][field] = { drained: false, timedOut: true, exitCode: 1, observedJobMembers: 0, stderrBase64: 'eA==', stdoutBase64: Buffer.from('{}\n').toString('base64'), mode: 'inherit' }[field]
    assert.throws(() => verifyNativeProof(log(records), identity))
  })
}
test('refuses cleanup failure, skipped native case, duplicate/missing modes and incomplete totals', () => {
  for (const change of [text => text.replace('ok 5 -', 'not ok 5 -'), text => text.replace(NAMES[4], NAMES[4] + ' # SKIP'),
    text => text.replace('# pass 5', '# pass 4'), text => text.replace('# fail 0', '# fail 1'), text => text.replace('# skipped 0\n', ''),
    text => text.replace('1..5', '1..4'), text => text.replace('# todo 0', '# todo 0\n# todo 0'), text => text.slice(0, -1),
    text => text.replace('# Node v24', '# stderr: error\n# Node v24'),
    text => text + 'Bail out! native execution interrupted\n',
    text => text + '# Retained owned fixture after unconfirmed controller outcome: C:\\bad\n',
    text => text.replace('TAP version 13\n', ''), text => text + 'TAP version 13\n']) assert.throws(() => verifyNativeProof(Buffer.from(change(log().toString())), identity))
  for (const records of [MODES.slice(1).map(observation), [...MODES.map(observation), observation('pipe')], MODES.toReversed().map(observation)]) {
    assert.throws(() => verifyNativeProof(log(records), identity))
  }
})
test('stage verifier joins exact executable hash and source patch provenance to native proof', () => {
  const lock = require('./build-lock.json'), node = Buffer.alloc(256)
  node.writeUInt16LE(0x5a4d); node.writeUInt32LE(64, 60); node.writeUInt32LE(0x4550, 64); node.writeUInt16LE(0xaa64, 68); node.writeUInt16LE(2, 86); node.writeUInt16LE(0x20b, 88)
  const digest = hash(node), provenance = { schema: 1, nodeSha256: digest, source: lock.source, patch: lock.patch, nulPatch: lock.nulPatch, architecture: 'arm64', processArchitecture: 'Arm64', osArchitecture: 'Arm64', identity }
  const bytes = () => Buffer.from(JSON.stringify(provenance))
  assert.equal(verifyStage(log(), bytes(), node, digest).nodeSha256, digest)
  for (const field of ['architecture', 'processArchitecture', 'osArchitecture', 'nodeSha256']) {
    const saved = provenance[field]; provenance[field] = 'wrong'; assert.throws(() => verifyStage(log(), bytes(), node, digest)); provenance[field] = saved
  }
  const changed = Buffer.from(node); changed[128] = 1
  assert.throws(() => verifyStage(log(), bytes(), changed, digest))
  provenance.patch = { ...lock.patch, sha256: '0'.repeat(64) }
  assert.throws(() => verifyStage(log(), bytes(), node, digest))
})
