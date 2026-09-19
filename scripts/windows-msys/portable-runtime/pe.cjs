'use strict'
// Bounded dependency parser copied from this repository's windows-appcontainer-command.js.
function importedDlls(bytes) {
  const invalid = () => { throw new Error('Invalid PE dependency table') }
  const range = (offset, size) => { if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(size) || size < 0 || offset + size > bytes.length) invalid(); return offset }
  if (!Buffer.isBuffer(bytes) || bytes.length < 64 || bytes.readUInt16LE(0) !== 0x5a4d) invalid()
  const pe = bytes.readUInt32LE(60); range(pe, 24)
  if (bytes.readUInt32LE(pe) !== 0x00004550) invalid()
  const sections = bytes.readUInt16LE(pe + 6), optionalSize = bytes.readUInt16LE(pe + 20), optional = pe + 24
  range(optional, optionalSize)
  const magic = bytes.readUInt16LE(range(optional, 2)), directoryOffset = magic === 0x20b ? 112 : magic === 0x10b ? 96 : 0
  if (!directoryOffset || optionalSize < directoryOffset || !sections || sections > 96) invalid()
  const directoryCount = bytes.readUInt32LE(optional + directoryOffset - 4)
  if (directoryCount > 16 || optionalSize < directoryOffset + directoryCount * 8) invalid()
  const sectionTable = optional + optionalSize; range(sectionTable, sections * 40)
  const locate = (rva, length) => {
    const matches = []
    for (let index = 0; index < sections; index++) {
      const section = sectionTable + index * 40, base = bytes.readUInt32LE(section + 12), size = bytes.readUInt32LE(section + 16), raw = bytes.readUInt32LE(section + 20)
      if (rva >= base && rva - base + length <= size) matches.push(range(raw + rva - base, length))
    }
    if (matches.length !== 1) invalid()
    return matches[0]
  }
  const names = new Set()
  const nameAt = rva => {
    let name = ''
    for (let index = 0; index < 256; index++) {
      const byte = bytes[locate(rva + index, 1)]
      if (!byte) { if (!/^[A-Za-z0-9_+.-]+\.dll$/i.test(name) || name.includes('..')) invalid(); names.add(name.toLowerCase()); return }
      if (byte < 33 || byte > 126) invalid()
      name += String.fromCharCode(byte)
    }
    invalid()
  }
  for (const [directoryIndex, descriptorSize, nameOffset] of [[1, 20, 12], [13, 32, 4]]) {
    if (directoryCount <= directoryIndex) continue
    const address = optional + directoryOffset + directoryIndex * 8, rva = bytes.readUInt32LE(address), size = bytes.readUInt32LE(address + 4)
    if (!rva && !size) continue
    if (!rva || size < descriptorSize || size > 1024 * 1024) invalid()
    let terminated = false
    for (let offset = 0; offset + descriptorSize <= size; offset += descriptorSize) {
      const descriptor = locate(rva + offset, descriptorSize)
      if (bytes.subarray(descriptor, descriptor + descriptorSize).every(byte => byte === 0)) { terminated = true; break }
      // Delay imports must use RVAs. Old absolute-address descriptors cannot
      // be interpreted without relocating the image and are refused.
      if (directoryIndex === 13 && bytes.readUInt32LE(descriptor) !== 1) invalid()
      nameAt(bytes.readUInt32LE(descriptor + nameOffset))
      if (names.size > 128) invalid()
    }
    if (!terminated) invalid()
  }
  return [...names].sort()
}
module.exports = { importedDlls }
