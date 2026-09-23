'use strict'

const assert = require('node:assert/strict')
const cp = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const PIN = '2237be355906fbe6065ce1815711eee52b2d646e'
const ARCHIVE_SHA256 = '9ba535365d459300692a4275f28f4ca716770372eac8f9296a6733669d3c9cd7'
const INSTALLER_SHA256 = '53a077364aa28bbd6e8d987cdec11a4552e22ff2c5137845725a1c99770f392f'
const PYPROJECT_SHA256 = '1f0d8d7e9e19c3a1cc25521a5cf56f3c885e4604d3081246cd42d9924a983174'
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex')
const required = name => {
  const value = process.env[name]
  assert.ok(value && path.isAbsolute(value), `${name} must be an absolute path from the pinned installer helper`)
  return fs.realpathSync.native(value)
}
const inside = (root, file) => {
  const relative = path.relative(root, file)
  return relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)
}
function physicalFile(file) {
  const item = fs.lstatSync(file)
  assert.equal(item.isFile(), true, `${file} is not a file`)
  assert.equal(item.isSymbolicLink(), false, `${file} is linked`)
  return fs.readFileSync(file)
}
function occurrences(bytes, needle) {
  const result = []
  for (let offset = 0; (offset = bytes.indexOf(needle, offset)) !== -1; offset += Math.max(1, needle.length)) result.push(offset)
  return result
}
function utf16le(value) {
  return Buffer.from([...value].map(character => `${character}\0`).join(''), 'binary')
}
function inspectLauncher(bytes) {
  const observation = {
    bytes: bytes.length,
    sha256: sha256(bytes),
    headerHex: bytes.subarray(0, Math.min(64, bytes.length)).toString('hex'),
    peOffset: null,
    peMachine: null,
    zipEocd: null,
    zipStartCandidate: null,
    zipStartMagic: null,
    shebangCandidates: [],
  }
  if (bytes.length >= 0x40 && bytes.subarray(0, 2).toString('ascii') === 'MZ') {
    const peOffset = bytes.readUInt32LE(0x3c)
    observation.peOffset = peOffset
    if (peOffset <= bytes.length - 6 && bytes.subarray(peOffset, peOffset + 4).toString('binary') === 'PE\0\0') {
      observation.peMachine = `0x${bytes.readUInt16LE(peOffset + 4).toString(16)}`
    }
  }
  const eocd = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (eocd >= 0 && eocd <= bytes.length - 22) {
    observation.zipEocd = eocd
    const centralSize = bytes.readUInt32LE(eocd + 12)
    const centralOffset = bytes.readUInt32LE(eocd + 16)
    const zipStart = eocd - centralSize - centralOffset
    observation.zipStartCandidate = zipStart
    if (zipStart >= 0 && zipStart <= bytes.length - 4) observation.zipStartMagic = bytes.subarray(zipStart, zipStart + 4).toString('hex')
  }
  const searchStart = Math.max(0, (observation.zipStartCandidate ?? bytes.length) - 8192)
  const searchEnd = Math.min(bytes.length, observation.zipStartCandidate ?? bytes.length)
  observation.shebangCandidates = occurrences(bytes.subarray(searchStart, searchEnd), Buffer.from('#!')).slice(0, 16).map(offset => {
    const absolute = searchStart + offset
    const newline = bytes.indexOf(0x0a, absolute)
    const boundedEnd = newline >= absolute && newline - absolute <= 4096 ? newline : Math.min(bytes.length, absolute + 4096)
    return { offset: absolute, bytes: boundedEnd - absolute, sha256: sha256(bytes.subarray(absolute, boundedEnd)) }
  })
  return observation
}

test('Hermes official Windows installer binds its generated launcher to the exact Python runtime', {
  skip: process.platform !== 'win32', timeout: 120000,
}, () => {
  const source = required('AUTOPROMPT_HERMES_WINDOWS_SOURCE_ROOT')
  const home = required('AUTOPROMPT_HERMES_WINDOWS_HOME')
  const install = required('AUTOPROMPT_HERMES_WINDOWS_INSTALL_ROOT')
  const launcher = required('AUTOPROMPT_HERMES_WINDOWS_CLI')
  const venvLauncher = required('AUTOPROMPT_HERMES_WINDOWS_VENV_CLI')
  const python = required('AUTOPROMPT_HERMES_WINDOWS_PYTHON')
  assert.equal(inside(home, install), true)
  for (const file of [launcher, venvLauncher, python]) assert.equal(inside(home, file), true)
  assert.equal(sha256(physicalFile(path.join(source, 'scripts/install.ps1'))), INSTALLER_SHA256)
  assert.equal(sha256(physicalFile(path.join(source, 'pyproject.toml'))), PYPROJECT_SHA256)

  const git = cp.spawnSync('git', ['-C', install, 'rev-parse', 'HEAD'], { encoding: 'utf8', shell: false, windowsHide: true, timeout: 10000 })
  assert.equal(git.status, 0, git.stderr)
  assert.equal(git.stdout.trim(), PIN)
  const version = cp.spawnSync(launcher, ['--version'], { encoding: 'utf8', shell: false, windowsHide: true, timeout: 30000 })
  assert.equal(version.status, 0, version.stderr)
  assert.match(`${version.stdout}\n${version.stderr}`, /(?:^|\D)0\.21\.1(?:$|\D)/)

  const metadataScript = String.raw`import base64,csv,importlib.metadata as m,json,sys
d=m.distribution('hermes-agent')
eps=[{'name':e.name,'value':e.value,'group':e.group} for e in d.entry_points]
record=d._path/'RECORD'
rows=[]
with record.open(newline='',encoding='utf-8') as f:
 for r in csv.reader(f):
  if len(r)==3:
   try: resolved=str(d.locate_file(r[0]).resolve())
   except Exception: continue
   rows.append({'relative':r[0],'resolved':resolved,'hash':r[1],'size':r[2]})
print(json.dumps({'executable':str(__import__('pathlib').Path(sys.executable).resolve()),'version':d.version,'distInfo':str(d._path.resolve()),'record':str(record.resolve()),'entryPoints':eps,'rows':rows}))`
  const metadataRun = cp.spawnSync(python, ['-I', '-B', '-c', metadataScript], { encoding: 'utf8', shell: false, windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024 })
  assert.equal(metadataRun.status, 0, metadataRun.stderr)
  const metadata = JSON.parse(metadataRun.stdout)
  assert.equal(path.resolve(metadata.executable).toLowerCase(), python.toLowerCase())
  assert.equal(metadata.version, '0.21.1')
  assert.equal(inside(install, fs.realpathSync.native(metadata.distInfo)), true)
  assert.ok(metadata.entryPoints.some(item => item.group === 'console_scripts' && item.name === 'hermes' && /^hermes_cli\.main:/.test(item.value)), JSON.stringify(metadata.entryPoints))
  const recordRow = metadata.rows.find(row => path.resolve(row.resolved).toLowerCase() === venvLauncher.toLowerCase()) || null
  const venvBytes = physicalFile(venvLauncher), publicBytes = physicalFile(launcher)
  const pythonBytes = physicalFile(python)
  const launcherObservation = inspectLauncher(publicBytes)
  const evidence = {
    schemaVersion: 1, releaseCommit: PIN, version: '0.21.1', architecture: process.arch,
    archiveSha256: ARCHIVE_SHA256, installerSha256: INSTALLER_SHA256, pyprojectSha256: PYPROJECT_SHA256,
    launcher: launcherObservation,
    venvLauncher: inspectLauncher(venvBytes),
    interpreter: { bytes: pythonBytes.length, sha256: sha256(pythonBytes), headerHex: pythonBytes.subarray(0, Math.min(64, pythonBytes.length)).toString('hex'), pathLength: python.length,
      pathOccurrences: { utf8: occurrences(publicBytes, Buffer.from(python, 'utf8')).slice(0, 16), utf16le: occurrences(publicBytes, utf16le(python)).slice(0, 16) } },
    record: recordRow && { relative: recordRow.relative, sha256: recordRow.hash, size: Number(recordRow.size) },
    entryPoint: metadata.entryPoints.find(item => item.group === 'console_scripts' && item.name === 'hermes'),
  }
  const output = process.env.AUTOPROMPT_HERMES_WINDOWS_EVIDENCE
  if (output) {
    const evidencePath = path.resolve(output)
    const evidenceDirectory = path.dirname(evidencePath)
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    fs.copyFileSync(launcher, path.join(evidenceDirectory, 'hermes-public-launcher.exe'), fs.constants.COPYFILE_EXCL)
    fs.copyFileSync(venvLauncher, path.join(evidenceDirectory, 'hermes-venv-launcher.exe'), fs.constants.COPYFILE_EXCL)
  }

  assert.ok(recordRow, 'Hermes RECORD does not bind venv/Scripts/hermes.exe')
  assert.equal(sha256(publicBytes), sha256(venvBytes), 'public and venv Hermes launchers differ')
  assert.equal(Number(recordRow.size), venvBytes.length)
  assert.equal(recordRow.hash, `sha256=${Buffer.from(sha256(venvBytes), 'hex').toString('base64url')}`)
  assert.equal(publicBytes.subarray(0, 2).toString('ascii'), 'MZ')
  assert.notEqual(launcherObservation.peMachine, null, 'Hermes launcher has no valid PE header')
  const expectedMachine = { x64: '0x8664', arm64: '0xaa64' }[process.arch]
  assert.ok(expectedMachine, `unsupported Windows runner architecture ${process.arch}`)
  assert.equal(launcherObservation.peMachine, expectedMachine, 'Hermes launcher PE machine differs from the native runner architecture')
})
