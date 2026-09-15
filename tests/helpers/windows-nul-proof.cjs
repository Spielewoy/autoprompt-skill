'use strict'
const assert = require('node:assert/strict')
const names = ['NUL', '\\\\.\\NUL', '\\\\?\\NUL', '\\\\?\\GLOBALROOT\\Device\\Null']
const accesses = [0x120089, 0x120196, 0x100001, 0x100002, 0]
const exact = (value, keys) => assert.deepEqual(Object.keys(value).sort(), [...keys].sort())
const uint = value => assert.ok(Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff)
function decode(value, max = 262144) {
  assert.equal(typeof value, 'string')
  assert.ok(value.length <= Math.ceil(max / 3) * 4)
  const bytes = Buffer.from(value, 'base64')
  assert.equal(bytes.toString('base64'), value, 'Canonical base64 required')
  assert.ok(bytes.length <= max)
  const text = bytes.toString('utf8')
  assert.equal(Buffer.from(text).equals(bytes), true, 'Exact UTF-8 required')
  return text
}
function parseCells(text, expectedPackage = null) {
  assert.equal(typeof text, 'string')
  assert.ok(Buffer.byteLength(text) <= 262144)
  const records = text.trimEnd().split(/\r?\n/).map(line => JSON.parse(line))
  const identity = records.shift()
  exact(identity, ['kind', 'appContainer', 'userSid', 'packageSid', 'osBuild', 'pointerBits'])
  assert.equal(identity.kind, 'identity')
  assert.equal(identity.appContainer, expectedPackage === null ? 0 : 1)
  assert.match(identity.userSid, /^S-1-[0-9]+(?:-[0-9]+)+$/)
  assert.equal(identity.packageSid, expectedPackage === null ? '' : expectedPackage)
  assert.ok(Number.isSafeInteger(identity.osBuild) && identity.osBuild > 0)
  assert.ok([32, 64].includes(identity.pointerBits))
  const cells = []
  for (let n = 0; n < names.length; n++) {
    assert.deepEqual(records.shift(), { kind: 'name', index: n, value: names[n] })
    for (let a = 0; a < accesses.length; a++) {
      const cell = records.shift()
      assert.equal(cell.kind, 'open'); assert.equal(cell.nameIndex, n); assert.equal(cell.accessIndex, a)
      assert.equal(cell.access, accesses[a]); uint(cell.error)
      if (cell.error !== 0) {
        exact(cell, ['kind', 'nameIndex', 'accessIndex', 'access', 'error'])
      } else {
        exact(cell, ['kind', 'nameIndex', 'accessIndex', 'access', 'error', 'handleFlags', 'flagsError', 'objectStatus', 'objectName', 'fileType', 'ioError', 'ioBytes'])
        uint(cell.handleFlags); uint(cell.flagsError); uint(cell.fileType); uint(cell.ioBytes)
        assert.ok(cell.ioBytes <= 1, 'The diagnostic performs at most one-byte I/O')
        assert.match(cell.objectStatus, /^[a-f0-9]{8}$/)
        assert.equal(typeof cell.objectName, 'string'); assert.ok(cell.objectName.length <= 256)
        assert.ok(cell.ioError === -1 || (Number.isSafeInteger(cell.ioError) && cell.ioError >= 0 && cell.ioError <= 0xffffffff))
        if (cell.objectStatus !== '00000000') assert.equal(cell.objectName, '')
        if (cell.objectStatus !== '00000000' || cell.objectName.toLowerCase() !== '\\device\\null' || cell.access === 0) {
          assert.equal(cell.ioError, -1); assert.equal(cell.ioBytes, 0)
        }
        const security = records.shift()
        exact(security, ['kind', 'nameIndex', 'accessIndex', 'status', 'convertError', 'sddlBase64'])
        assert.equal(security.kind, 'security'); assert.equal(security.nameIndex, n); assert.equal(security.accessIndex, a)
        uint(security.status); uint(security.convertError)
        if (security.status !== 0) assert.equal(security.convertError, 0)
        const sddl = decode(security.sddlBase64, 16384)
        assert.ok(sddl.length <= 4096)
        if (security.status !== 0 || security.convertError !== 0) assert.equal(sddl, '')
        else assert.ok(sddl.length > 0)
      }
      if (expectedPackage === null && n === 0 && a < 2) {
        // The host must open both exact libuv modes. I/O and security queries
        // remain observations; even NUL EOF may surface a platform-specific code.
        assert.equal(cell.error, 0, 'Host NUL control must open exact libuv access')
        assert.equal(cell.objectStatus, '00000000')
        assert.equal(cell.objectName.toLowerCase(), '\\device\\null')
        assert.equal(cell.fileType, 2)
        assert.equal(cell.flagsError, 0)
        assert.equal(cell.handleFlags & 1, 1)
      }
      cells.push(cell)
    }
  }
  assert.deepEqual(records, [{ kind: 'completed', cells: 20 }], 'Exactly twenty ordered cells and final completion required')
  return { identity, cells }
}
function parseController(text) {
  assert.equal(typeof text, 'string'); assert.ok(Buffer.byteLength(text) <= 400000)
  const proof = JSON.parse(text)
  exact(proof, ['schemaVersion', 'packageSid', 'drained', 'rootImageMatches', 'exitCode', 'timedOut', 'cancelled', 'outputLimit', 'observedJobMembers', 'stdoutBase64', 'stderrBase64'])
  assert.equal(proof.schemaVersion, 1)
  assert.match(proof.packageSid, /^S-1-15-2-(?:[0-9]+-){6}[0-9]+$/)
  for (const key of ['drained', 'rootImageMatches']) assert.equal(proof[key], true)
  for (const key of ['timedOut', 'cancelled', 'outputLimit']) assert.equal(proof[key], false)
  assert.equal(proof.exitCode, 0); assert.equal(proof.stderrBase64, '')
  assert.ok(Number.isSafeInteger(proof.observedJobMembers) && proof.observedJobMembers >= 1 && proof.observedJobMembers <= 1024)
  return { proof, child: parseCells(decode(proof.stdoutBase64), proof.packageSid) }
}
module.exports = { names, accesses, parseCells, parseController }
