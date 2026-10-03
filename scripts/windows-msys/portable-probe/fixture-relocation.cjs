'use strict'
// Deterministic test-only transformation of the pinned POSIX fixture.
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const ORIGINAL_SHA256 = '7842eaf72ea9b0f4fb22f7054ba27e458491f1956666a5adfe5464e82e908827'
const DERIVED_SHA256 = 'eb8bdecd843f1adc425fd0fd434f7850d7dc471dc91114b93cab3936fa2c4f67'
const LENGTH = 47495
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
function checksum(bytes, offset) {
  let sum = 0
  for (let at = 0; at < bytes.length; at += 2) {
    const word = at >= offset && at < offset + 4 ? 0 : bytes[at] | ((at + 1 < bytes.length ? bytes[at + 1] : 0) << 8)
    sum = (sum + word) >>> 0
    sum = ((sum & 0xffff) + (sum >>> 16)) >>> 0
  }
  sum = ((sum & 0xffff) + (sum >>> 16)) >>> 0
  return (sum + bytes.length) >>> 0
}
function peDynamicBase(original) {
  assert.ok(original.length >= 136, 'Complete PE headers required')
  assert.equal(original.readUInt16LE(0), 0x5a4d, 'DOS header required')
  const pe = original.readUInt32LE(0x3c)
  assert.ok(pe >= 64 && pe <= original.length - 96, 'Bounded PE header required')
  const optional = pe + 24
  assert.equal(original.readUInt32LE(pe), 0x4550, 'PE signature required')
  assert.equal(original.readUInt16LE(pe + 4), 0x8664, 'x64 fixture required')
  assert.equal(original.readUInt16LE(optional), 0x20b, 'PE32+ fixture required')
  return { pe, optional, characteristicsOffset:optional + 70,
    enabled:(original.readUInt16LE(optional + 70) & 0x40) === 0x40 }
}
function derive(original, authenticatedSha256) {
  assert.ok(Buffer.isBuffer(original), 'POSIX fixture bytes required')
  assert.match(authenticatedSha256, /^[a-f0-9]{64}$/, 'Authenticated POSIX fixture identity required')
  const originalSha256 = hash(original)
  assert.equal(originalSha256, authenticatedSha256, 'POSIX fixture differs from authenticated tuple')
  const header = peDynamicBase(original)
  if (originalSha256 !== ORIGINAL_SHA256) {
    assert.equal(header.enabled, true, 'Authenticated POSIX fixture must already enable DYNAMIC_BASE')
    return { bytes:Buffer.from(original), receipt:{ schema:1, transformation:'pe-dynamic-base-already-enabled',
      originalSha256, derivedSha256:originalSha256, length:original.length, changedOffsets:[] } }
  }
  assert.equal(original.length, LENGTH, 'Pinned POSIX fixture length required')
  const { pe, optional, characteristicsOffset } = header
  assert.equal(pe, 128)
  assert.equal(original.readBigUInt64LE(optional + 24), 0x100400000n)
  const checksumOffset = optional + 64
  assert.equal(checksumOffset, 216); assert.equal(characteristicsOffset, 222)
  assert.equal(original.readUInt16LE(characteristicsOffset), 0x8000)
  const bytes = Buffer.from(original)
  bytes.writeUInt16LE(0x8040, characteristicsOffset)
  bytes.writeUInt32LE(checksum(bytes, checksumOffset), checksumOffset)
  const allowed = new Set([checksumOffset, checksumOffset + 1, checksumOffset + 2, checksumOffset + 3, characteristicsOffset])
  const changedOffsets = []
  for (let at = 0; at < bytes.length; at++) if (bytes[at] !== original[at]) {
    assert.ok(allowed.has(at), 'Only DYNAMIC_BASE and checksum may change')
    changedOffsets.push(at)
  }
  assert.deepEqual(changedOffsets, [216, 217, 222])
  assert.equal(hash(bytes), DERIVED_SHA256, 'Derived POSIX fixture identity differs')
  return { bytes, receipt: { schema:1, transformation:'pe-dynamic-base-and-checksum', originalSha256:ORIGINAL_SHA256,
    derivedSha256:DERIVED_SHA256, length:LENGTH, changedOffsets } }
}
module.exports = { derive, ORIGINAL_SHA256, DERIVED_SHA256, LENGTH }
