'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const test = require('node:test')
const { parseHermesUvLauncher, crc32 } = require('../../scripts/harness-v2-bridge/hermes/windows-launcher.cjs')

function zip(script, { crc = crc32(script) } = {}) {
  const name = Buffer.from('__main__.py'), local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22)
  local.write('PK\x03\x04'); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(0, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(script.length, 18); local.writeUInt32LE(script.length, 22); local.writeUInt16LE(name.length, 26)
  central.write('PK\x01\x02'); central.writeUInt16LE(0x33f, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(0, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(script.length, 20); central.writeUInt32LE(script.length, 24); central.writeUInt16LE(name.length, 28)
  const centralOffset = local.length + name.length + script.length
  end.write('PK\x05\x06'); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(centralOffset, 16)
  return Buffer.concat([local, name, script, central, name, end])
}
function resourceName(buffer, offset, name) { buffer.writeUInt16LE(name.length, offset); buffer.write(name, offset + 2, 'utf16le') }
function synthetic({ machine = 0x8664, kind = 1, python = 'C:\\fixture\\venv\\Scripts\\python.exe', duplicateType = false, duplicateLanguage = false, corruptCrc = false } = {}) {
  const buffer = Buffer.alloc(0x1200), pe = 0x80, optional = pe + 24, resource = 0x200
  buffer.write('MZ'); buffer.writeUInt32LE(pe, 0x3c); buffer.write('PE\0\0', pe); buffer.writeUInt16LE(machine, pe + 4); buffer.writeUInt16LE(1, pe + 6); buffer.writeUInt16LE(0xf0, pe + 20); buffer.writeUInt16LE(2, pe + 22)
  buffer.writeUInt16LE(0x20b, optional); buffer.writeUInt32LE(16, optional + 108); buffer.writeUInt32LE(0x1000, optional + 128); buffer.writeUInt32LE(0x1000, optional + 132)
  const section = optional + 0xf0; buffer.write('.rsrc', section); buffer.writeUInt32LE(0x1000, section + 8); buffer.writeUInt32LE(0x1000, section + 12); buffer.writeUInt32LE(0x1000, section + 16); buffer.writeUInt32LE(resource, section + 20)
  const at = value => resource + value, directory = (relative, named, ids) => { buffer.writeUInt16LE(named, at(relative + 12)); buffer.writeUInt16LE(ids, at(relative + 14)) }
  directory(0, 0, duplicateType ? 2 : 1); buffer.writeUInt32LE(10, at(16)); buffer.writeUInt32LE(0x80000020, at(20)); if (duplicateType) { buffer.writeUInt32LE(10, at(24)); buffer.writeUInt32LE(0x80000020, at(28)) }
  directory(0x20, 3, 0)
  const names = ['UV_TRAMPOLINE_KIND', 'UV_PYTHON_PATH', 'UV_SCRIPT_DATA'], nameOffsets = [0x100, 0x150, 0x190], directories = [0x60, 0x80, 0xa0], data = [0xc0, 0xd0, 0xe0], payloads = [0x400, 0x410, 0x500]
  names.forEach((name, index) => { resourceName(buffer, at(nameOffsets[index]), name); buffer.writeUInt32LE(0x80000000 + nameOffsets[index], at(0x30 + index * 8)); buffer.writeUInt32LE(0x80000000 + directories[index], at(0x34 + index * 8)); directory(directories[index], 0, duplicateLanguage && index === 0 ? 2 : 1); buffer.writeUInt32LE(0x409, at(directories[index] + 16)); buffer.writeUInt32LE(data[index], at(directories[index] + 20)); if (duplicateLanguage && index === 0) { buffer.writeUInt32LE(0x40c, at(directories[index] + 24)); buffer.writeUInt32LE(data[index], at(directories[index] + 28)) } })
  const script = Buffer.from('#!ignored\nfrom hermes_cli.main import main\nsys.exit(main())\n'), archive = zip(script, { crc: corruptCrc ? crc32(script) ^ 1 : crc32(script) })
  const values = [Buffer.from([kind]), Buffer.from(python), archive]
  values.forEach((value, index) => { const rva = 0x1000 + payloads[index]; buffer.writeUInt32LE(rva, at(data[index])); buffer.writeUInt32LE(value.length, at(data[index] + 4)); value.copy(buffer, at(payloads[index])) })
  return buffer
}

test('uv launcher parser binds the resource-selected Python from a strict synthetic PE', () => {
  const binding = parseHermesUvLauncher(synthetic())
  assert.deepEqual({ architecture: binding.architecture, kind: binding.kind, pythonPath: binding.pythonPath }, { architecture: 'x64', kind: 'uv-script-trampoline', pythonPath: 'C:\\fixture\\venv\\Scripts\\python.exe' })
  assert.match(binding.scriptSha256, /^[a-f0-9]{64}$/)
})

test('uv launcher parser rejects malformed architecture/resource selections and payloads', () => {
  const overlapping = synthetic(), pe = 0x80, optional = pe + 24, section = optional + 0xf0
  overlapping.writeUInt16LE(2, pe + 6); overlapping.copy(overlapping, section + 40, section, section + 40)
  const nameRange = synthetic(); nameRange.writeUInt16LE(0xffff, 0x200 + 0x100)
  const localGap = synthetic(), script = 0x200 + 0x500, central = script + 30 + Buffer.byteLength('__main__.py') + Buffer.byteLength('#!ignored\nfrom hermes_cli.main import main\nsys.exit(main())\n')
  localGap.writeUInt32LE(1, central + 42)
  for (const [label, value] of [['arch', synthetic({ machine: 0x14c })], ['kind', synthetic({ kind: 2 })], ['type', synthetic({ duplicateType: true })], ['language', synthetic({ duplicateLanguage: true })], ['relative', synthetic({ python: 'venv\\Scripts\\python.exe' })], ['nul', synthetic({ python: 'C:\\fixture\\x\0python.exe' })], ['crc', synthetic({ corruptCrc: true })], ['overlap', overlapping], ['nameRange', nameRange], ['zipLocalGap', localGap], ['truncated', synthetic().subarray(0, 700)]]) assert.throws(() => parseHermesUvLauncher(value), { code: 'PROVIDER_IDENTITY_MISMATCH' }, label)
})

test('optional actual Hermes launcher fixture agrees with its resource binding', { skip: !process.env.AUTOPROMPT_HERMES_WINDOWS_LAUNCHER_FIXTURE }, () => {
  const file = process.env.AUTOPROMPT_HERMES_WINDOWS_LAUNCHER_FIXTURE
  assert.ok(fs.statSync(file).isFile())
  const binding = parseHermesUvLauncher(fs.readFileSync(file))
  assert.equal(binding.kind, 'uv-script-trampoline')
})
