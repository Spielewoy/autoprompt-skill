'use strict'
const assert = require('node:assert/strict')
const exact = (value, keys) => assert.deepEqual(Object.keys(value).sort(), [...keys].sort())
function parseCapability(text, expectedSid) {
  assert.equal(typeof text, 'string'); assert.ok(Buffer.byteLength(text) <= 65536)
  const result = JSON.parse(text)
  exact(result, ['schemaVersion', 'packageSid', 'objectType', 'objectName', 'grantedAccess', 'originalFlags', 'duplicateFlags', 'distinctStdin', 'readError', 'readBytes', 'writtenBytes', 'strayEventInherited', 'startedMs', 'finishedMs'])
  assert.equal(result.schemaVersion, 1); assert.equal(result.packageSid, expectedSid)
  assert.equal(result.objectType, 'File'); assert.equal(result.objectName, '\\Device\\Null')
  assert.equal(result.grantedAccess, 0x12019f); assert.equal(result.originalFlags, 1); assert.equal(result.duplicateFlags, 0)
  assert.equal(result.distinctStdin, true); assert.equal(result.strayEventInherited, false)
  assert.ok([0, 38].includes(result.readError)); assert.equal(result.readBytes, 0); assert.equal(result.writtenBytes, 1)
  for (const key of ['startedMs', 'finishedMs']) assert.ok(Number.isSafeInteger(result[key]) && result[key] > 0)
  assert.ok(result.finishedMs >= result.startedMs + 2500 && result.finishedMs <= result.startedMs + 15000)
  return result
}
function parseController(text) {
  assert.equal(typeof text, 'string'); assert.ok(Buffer.byteLength(text) <= 200000)
  const proof = JSON.parse(text)
  exact(proof, ['schemaVersion', 'hostEventInheritable', 'results'])
  assert.equal(proof.schemaVersion, 1); assert.equal(proof.hostEventInheritable, true)
  assert.ok(Array.isArray(proof.results)); assert.equal(proof.results.length, 2)
  const children = proof.results.map(result => {
    exact(result, ['packageSid', 'drained', 'rootImageMatches', 'exitCode', 'observedJobMembers', 'stdoutBase64', 'stderrBase64'])
    assert.match(result.packageSid, /^S-1-15-2-(?:[0-9]+-){6}[0-9]+$/)
    assert.equal(result.drained, true); assert.equal(result.rootImageMatches, true); assert.equal(result.exitCode, 0); assert.equal(result.stderrBase64, '')
    assert.ok(Number.isSafeInteger(result.observedJobMembers) && result.observedJobMembers >= 1 && result.observedJobMembers <= 1024)
    assert.equal(typeof result.stdoutBase64, 'string'); assert.ok(result.stdoutBase64.length <= 90000)
    const bytes = Buffer.from(result.stdoutBase64, 'base64')
    assert.equal(bytes.toString('base64'), result.stdoutBase64); assert.ok(bytes.length <= 65536)
    const decoded = bytes.toString('utf8'); assert.equal(Buffer.from(decoded).equals(bytes), true)
    return parseCapability(decoded, result.packageSid)
  })
  assert.notEqual(children[0].packageSid, children[1].packageSid)
  assert.ok(Math.max(...children.map(child => child.startedMs)) < Math.min(...children.map(child => child.finishedMs)), 'The two actual AppContainer execution intervals must overlap')
  return { proof, children }
}
module.exports = { parseCapability, parseController }
