'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { ensureWindowsPrivateAcl } = require('./safe-run-root.js')
const { createWindowsFilesystemCapture } = require('./windows-filesystem.js')
const FILES = Object.freeze(['windows-appcontainer.ps1', 'windows-appcontainer-native.cs',
  'windows-appcontainer-resources.ps1', 'windows-appcontainer-resources-native.cs'])
function fail(message) { const error = new Error(message); error.code = 'WINDOWS_RUNTIME_MISMATCH'; throw error }
function same(a, b) { return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]) }
function readHelper(file) {
  if (fs.realpathSync.native(file).toLowerCase() !== path.resolve(file).toLowerCase()) fail('Native helper source must be canonical')
  for (let cursor = file; ; cursor = path.dirname(cursor)) {
    const stat = fs.lstatSync(cursor)
    if (stat.isSymbolicLink() || (cursor !== file && !stat.isDirectory())) fail('Native helper source ancestry must be physical')
    if (cursor === path.parse(cursor).root) break
  }
  const before = fs.lstatSync(file, { bigint: true })
  if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > 4n * 1024n * 1024n) fail('Native helper source must be bounded and singly linked')
  const fd = fs.openSync(file, 'r')
  try {
    if (!same(before, fs.fstatSync(fd, { bigint: true }))) fail('Native helper source changed while opening')
    const bytes = fs.readFileSync(fd)
    if (BigInt(bytes.length) !== before.size || !same(before, fs.fstatSync(fd, { bigint: true })) || !same(before, fs.lstatSync(file, { bigint: true }))) fail('Native helper source changed while reading')
    return bytes
  } finally { fs.closeSync(fd) }
}
function stageWindowsHelperDeployment(controlRoot) {
  if (process.platform !== 'win32') fail('Private Windows helper deployment requires Windows')
  const capture = createWindowsFilesystemCapture()
  // Ordinary npm/source installs inherit their directory ACLs. Never relabel
  // those shared paths: copy the exact helper closure into controller storage.
  capture.assertRecordParent(path.join(controlRoot, 'native-helper-parent-check'))
  const root = fs.mkdtempSync(path.join(controlRoot, 'native-helpers-'))
  try {
    ensureWindowsPrivateAcl(root)
    capture.assertRecordParent(path.join(root, 'native-helper-parent-check'))
    for (const name of FILES) {
      const bytes = readHelper(path.join(__dirname, name))
      const destination = path.join(root, name)
      fs.writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 })
      if (!crypto.timingSafeEqual(crypto.createHash('sha256').update(readHelper(destination)).digest(), crypto.createHash('sha256').update(bytes).digest())) fail('Staged native helper bytes changed')
    }
    return Object.freeze({ root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) })
  } catch (error) { fs.rmSync(root, { recursive: true, force: true }); throw error }
}
module.exports = { stageWindowsHelperDeployment }
