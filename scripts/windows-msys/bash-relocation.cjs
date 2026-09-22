'use strict'
// Deterministic transformation of the pinned SDK Bash; never modifies its input.
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const ORIGINAL_SHA256 = '5490d0da5e7cf9d92068cc48fcc590f2bcf8564add8ff91c3b5fe541eb2d72e3'
const DERIVED_SHA256 = '9b88ee446e1f9ddf67106526068e37e3a983ea1e327d47ca08bb5d1fdbe914c3'
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
function derive(original) {
  assert.ok(Buffer.isBuffer(original), 'Bash bytes required')
  assert.equal(hash(original), ORIGINAL_SHA256, 'Pinned SDK Bash required')
  const pe = original.readUInt32LE(0x3c), optional = pe + 24
  assert.equal(original.readUInt32LE(pe), 0x4550)
  assert.equal(original.readUInt16LE(pe + 4), 0x8664)
  assert.equal(original.readUInt16LE(optional), 0x20b)
  const checksumOffset = optional + 64, characteristicsOffset = optional + 70
  assert.equal(original.readUInt16LE(characteristicsOffset), 0x8000)
  const bytes = Buffer.from(original)
  bytes.writeUInt16LE(0x8040, characteristicsOffset)
  bytes.writeUInt32LE(checksum(bytes, checksumOffset), checksumOffset)
  const allowed = new Set([characteristicsOffset, checksumOffset, checksumOffset + 1, checksumOffset + 2, checksumOffset + 3])
  const changedOffsets = []
  for (let at = 0; at < bytes.length; at++) if (bytes[at] !== original[at]) {
    assert.ok(allowed.has(at), 'Only DYNAMIC_BASE and checksum may change')
    changedOffsets.push(at)
  }
  assert.equal(hash(bytes), DERIVED_SHA256, 'Derived Bash identity differs')
  return { bytes, receipt: { schema:1, transformation:'pe-dynamic-base-and-checksum', originalSha256:ORIGINAL_SHA256, derivedSha256:DERIVED_SHA256, length:bytes.length, changedOffsets } }
}
module.exports = { derive, ORIGINAL_SHA256, DERIVED_SHA256 }
