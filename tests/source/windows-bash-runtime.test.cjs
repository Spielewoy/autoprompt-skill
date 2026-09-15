'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const cp = require('node:child_process')
const { importedDlls, bindBashRuntime, windowsBashCandidates } = require('../../agents/codex/workflow/windows-appcontainer-command.js')
const { parseMsysSharedId } = require('../../agents/codex/workflow/windows-appcontainer.js')
const msysVersion = 'BEGIN_CYGWIN_VERSION_INFO\n%%% MSYS dll identifier: msys-2.0\n%%% MSYS dll identifier: cygwin1\n%%% MSYS shared data: 5\n%%% MSYS shared id: msys-2.0S5\nEND_CYGWIN_VERSION_INFO'
const ipcFixture = path.resolve(__dirname, '../fixtures/windows-msys/bash-ipc.sh')

test('Bash IPC fixture executes real pipelines, substitutions, coprocesses and background writes', { skip: process.platform === 'win32' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-ipc-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const witness = path.join(root, "space and ' quote")
  const bash = require('../helpers/resolve-bash.cjs').resolveBash()
  assert.ok(bash, 'Bash 4.3 or newer is required for the IPC fixture')
  const result = cp.spawnSync(bash, ['--noprofile', '--norc', ipcFixture, witness], { encoding: 'utf8', timeout: 15000 })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
  assert.equal(fs.readFileSync(witness, 'utf8'), 'shell-write\n')
})

test('MSYS namespace identity requires unique production DLL metadata and matching shared ABI', () => {
  const bytes = Buffer.concat([Buffer.alloc(64), Buffer.from(msysVersion), Buffer.alloc(64)])
  assert.equal(parseMsysSharedId(bytes), 'msys-2.0S5')
  for (const value of [Buffer.alloc(0), Buffer.alloc(32 * 1024 * 1024 + 1),
    Buffer.from(msysVersion + msysVersion), Buffer.from(msysVersion.replace('END_CYGWIN_VERSION_INFO', '')),
    Buffer.from(msysVersion.replace('msys-2.0S5', 'msys-2.0S5-debug-build')),
    Buffer.from(msysVersion.replace('shared data: 5', 'shared data: 6')),
    Buffer.from(msysVersion.replace('shared id: msys-2.0S5', 'shared id: msys-2.0S5\n%%% MSYS shared id: msys-2.0S5')),
    Buffer.from(msysVersion.replace('shared id: msys-2.0S5', 'shared id: msys-2.0S5\n%%% MSYS shared id: invalid')),
    Buffer.from(msysVersion.replace('shared data: 5', 'shared data: 5\n%%% MSYS shared data: 5')),
    Buffer.from(msysVersion.replace('shared id: msys-2.0S5', 'shared id: ../../outside')),
    Buffer.from(msysVersion.replace('shared data: 5', 'shared data: 5\0')),
    Buffer.from(msysVersion.replace('shared data: 5', 'shared data: 5\n%%% MSYS extra: \u00ff'), 'latin1'),
    Buffer.from(msysVersion.replace('shared data: 5', 'shared data: 5\n%%% MSYS padding: ' + 'x'.repeat(8192))),
  ]) assert.throws(() => parseMsysSharedId(value), { code: 'WINDOWS_MSYS_RUNTIME_INVALID' })
})

test('Windows Bash discovery includes custom-drive Git PATH installations and excludes System32 WSL stubs', () => {
  const candidates = windowsBashCandidates({ SystemRoot: 'C:\\Windows', Path: 'C:\\Windows\\System32;D:\\Tools\\Git\\cmd;E:\\PortableGit\\usr\\bin;relative;.' }, 'F:\\Custom\\bash.exe')
  assert.equal(candidates[0], 'F:\\Custom\\bash.exe')
  assert.ok(candidates.includes('D:\\Tools\\Git\\usr\\bin\\bash.exe'))
  assert.ok(candidates.includes('E:\\PortableGit\\usr\\bin\\bash.exe'))
  assert.equal(candidates.includes('C:\\Windows\\System32\\bash.exe'), false)
  assert.equal(candidates.some(candidate => candidate.startsWith('relative')), false)
})

test('Windows owned launch environment survives native and canary allowlists without leaking host settings', t => {
  const { prepareProcessLaunchEnvironment } = require('../../agents/codex/workflow/process-owner.js')
  const { isolatedEnvironment } = require('../../scripts/harness-v2-native.cjs')
  const { closedEnvironment } = require('../../scripts/harness-v2-closed-canary.cjs')
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'windows-env-closure-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const input = { Path: 'D:\\Tools\\Git\\cmd', SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe', PATHEXT: '.COM;.EXE;.CMD', AUTOPROMPT_WINDOWS_BASH: 'D:\\Custom\\usr\\bin\\bash.exe', NODE_OPTIONS: '--require hostile', ANTHROPIC_API_KEY: 'must-not-leak', BASH_ENV: 'hostile', USERPROFILE: 'C:\\host-profile' }
  const owned = prepareProcessLaunchEnvironment({ kind: 'windows-job-object' }, 'windows-env-test', input)
  assert.equal(owned.SYSTEMROOT, 'C:\\Windows')
  for (const environment of [input, owned]) {
    const native = isolatedEnvironment(path.join(root, 'native'), environment, {}, { platform: 'win32' })
    const canary = closedEnvironment(environment, 'claude', path.join(root, 'canary'), { platform: 'win32' })
    for (const result of [native, canary]) {
      assert.equal(result.SYSTEMROOT, input.SystemRoot); assert.equal(result.PATH, input.Path); assert.equal(result.COMSPEC, input.ComSpec)
      assert.equal(result.AUTOPROMPT_WINDOWS_BASH, input.AUTOPROMPT_WINDOWS_BASH)
      for (const key of ['NODE_OPTIONS', 'BASH_ENV', 'ANTHROPIC_API_KEY']) assert.equal(Object.hasOwn(result, key), false)
      assert.notEqual(result.USERPROFILE, input.USERPROFILE)
    }
  }
  assert.throws(() => closedEnvironment({ Path: 'trusted', PATH: 'other' }, 'claude', undefined, { platform: 'win32' }), { code: 'PROCESS_ENVIRONMENT_CONFLICT' })
})

function pe(imports = [], delayed = [], pe32 = false) {
  const bytes = Buffer.alloc(4096)
  bytes.writeUInt16LE(0x5a4d, 0); bytes.writeUInt32LE(128, 60)
  bytes.writeUInt32LE(0x4550, 128); bytes.writeUInt16LE(1, 134)
  const optional = 152, optionalSize = pe32 ? 224 : 240, directories = optional + (pe32 ? 96 : 112)
  bytes.writeUInt16LE(optionalSize, 148); bytes.writeUInt16LE(pe32 ? 0x10b : 0x20b, optional)
  bytes.writeUInt32LE(16, directories - 4)
  const section = optional + optionalSize
  bytes.writeUInt32LE(3584, section + 8); bytes.writeUInt32LE(4096, section + 12)
  bytes.writeUInt32LE(3584, section + 16); bytes.writeUInt32LE(512, section + 20)
  let nextName = 2048
  for (const [names, directoryIndex, raw, size, nameOffset] of [[imports, 1, 512, 20, 12], [delayed, 13, 1024, 32, 4]]) {
    if (!names.length) continue
    bytes.writeUInt32LE(raw - 512 + 4096, directories + directoryIndex * 8)
    bytes.writeUInt32LE((names.length + 1) * size, directories + directoryIndex * 8 + 4)
    names.forEach((name, index) => {
      if (directoryIndex === 13) bytes.writeUInt32LE(1, raw + index * size)
      bytes.writeUInt32LE(nextName - 512 + 4096, raw + index * size + nameOffset)
      bytes.write(name + '\0', nextName, 'ascii'); nextName += name.length + 1
    })
  }
  return bytes
}

test('Windows Bash closure reads PE32 and PE32+ imports and delay imports without executing them', () => {
  for (const pe32 of [true, false]) assert.deepEqual(importedDlls(pe(['KERNEL32.dll', 'msys-2.0.dll'], ['msys-intl-8.dll', 'KERNEL32.dll'], pe32)), ['kernel32.dll', 'msys-2.0.dll', 'msys-intl-8.dll'])
})

test('Windows Bash closure refuses escaping, truncated, ambiguous and unterminated PE import tables', () => {
  const valid = pe(['msys-2.0.dll'])
  const invalid = [Buffer.alloc(0), Buffer.from('#!/bin/bash'), valid.subarray(0, 530), pe(['../outside.dll']), pe(['C:\\secret.dll']), pe(['other/secret.dll'])]
  const badRva = Buffer.from(valid); badRva.writeUInt32LE(0xfffffff0, 524); invalid.push(badRva)
  const noTerminator = Buffer.from(valid); noTerminator.writeUInt32LE(20, 152 + 112 + 12); invalid.push(noTerminator)
  const ambiguous = Buffer.from(valid); ambiguous.writeUInt16LE(2, 134); ambiguous.copy(ambiguous, 432, 392, 432); invalid.push(ambiguous)
  const delayed = pe([], ['msys-2.0.dll']); delayed.writeUInt32LE(0, 1024); invalid.push(delayed)
  for (const input of invalid) assert.throws(() => importedDlls(input), { code: 'WINDOWS_RUNTIME_INVALID' })
})

test('Windows Bash closure binds transitive DLL bytes, tolerates cycles and excludes unrelated Git files', t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'windows-bash-closure-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const systemRoot = path.join(root, 'Windows'); fs.mkdirSync(path.join(systemRoot, 'System32'), { recursive: true })
  fs.writeFileSync(path.join(systemRoot, 'System32', 'kernel32.dll'), 'protected system runtime')
  fs.writeFileSync(path.join(root, 'bash.exe'), pe(['msys-2.0.dll', 'kernel32.dll', 'api-ms-win-core-file-l1-1-0.dll']))
  fs.writeFileSync(path.join(root, 'msys-2.0.dll'), Buffer.concat([pe(['msys-intl-8.dll']), Buffer.from(msysVersion)]))
  const intl = pe(['msys-2.0.dll']); fs.writeFileSync(path.join(root, 'msys-intl-8.dll'), intl)
  fs.writeFileSync(path.join(root, 'credentials.txt'), 'private')
  fs.writeFileSync(path.join(root, 'unrelated.exe'), 'do not execute or copy')
  const closure = bindBashRuntime(root, systemRoot)
  assert.deepEqual(closure.map(item => item.name).sort(), ['bash.exe', 'msys-2.0.dll', 'msys-intl-8.dll'])
  assert.equal(closure.find(item => item.name === 'msys-intl-8.dll').sha256, crypto.createHash('sha256').update(intl).digest('hex'))
  assert.equal(closure.find(item => item.name === 'msys-2.0.dll').sharedId, 'msys-2.0S5')
  fs.unlinkSync(path.join(root, 'msys-intl-8.dll'))
  assert.throws(() => bindBashRuntime(root, systemRoot), error => error.code === 'WINDOWS_RUNTIME_INVALID' && error.message.includes('msys-intl-8.dll'))
})

test('Windows Bash closure refuses linked dependencies instead of granting their parent directories', t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'windows-bash-linked-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'bash.exe'), pe(['msys-2.0.dll']))
  fs.writeFileSync(path.join(root, 'outside.dll'), pe())
  fs.linkSync(path.join(root, 'outside.dll'), path.join(root, 'msys-2.0.dll'))
  assert.throws(() => bindBashRuntime(root), { code: 'WINDOWS_RUNTIME_INVALID' })
})

test('Windows Bash discovery never executes or falls back after invalid selected MSYS metadata', () => {
  const filename = path.resolve(__dirname, '../../agents/codex/workflow/windows-appcontainer-command.js')
  const localRequire = require('node:module').createRequire(filename), module = { exports: {} }, opened = []
  const buffers = new Map([['C:\\Selected\\bash.exe', pe(['msys-2.0.dll'])], ['C:\\Selected\\msys-2.0.dll', pe()]])
  const physicalFs = {
    realpathSync: { native: file => file },
    lstatSync: file => ({ isSymbolicLink: () => false, isDirectory: () => !buffers.has(file) }),
    openSync(file) { opened.push(file); assert.ok(buffers.has(file), 'metadata refusal must precede trying a different Bash installation'); return file },
    fstatSync: file => ({ isFile: () => true, nlink: 1n, size: BigInt(buffers.get(file).length), dev: 1n, ino: 2n, mtimeNs: 1n, ctimeNs: 1n }),
    readFileSync: file => buffers.get(file), closeSync() {}, existsSync: file => buffers.has(file),
  }
  require('node:vm').runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, Buffer,
    require: name => name === 'node:fs' ? physicalFs : name === 'node:path' ? path.win32 : name === 'node:child_process' ? { spawnSync() { assert.fail('Invalid MSYS metadata must never execute Bash') } } : localRequire(name),
  }, { filename })
  assert.throws(() => module.exports.resolveWindowsBash({ bashPath: 'C:\\Selected\\bash.exe', env: { SystemRoot: 'C:\\Windows' } }), { code: 'WINDOWS_MSYS_RUNTIME_INVALID' })
  assert.deepEqual(opened, ['C:\\Selected\\bash.exe', 'C:\\Selected\\bash.exe', 'C:\\Selected\\msys-2.0.dll'])
})

// This scenario performs two native launches plus bounded privacy/resource
// setup; each worker retains its separate 15s/30s execution deadline.
test('native Windows Bash copied closure permits scratch writes and denies candidate writes and controller reads', { skip: process.platform !== 'win32', timeout: 600000 }, async t => {
  const { probeWindowsAppContainer } = require('../../agents/codex/workflow/windows-appcontainer-probe.js')
  const probe = await probeWindowsAppContainer()
  assert.equal(probe.supported, true, JSON.stringify(probe))
  const { ensureWindowsPrivateAcl } = require('../../agents/codex/workflow/safe-run-root.js')
  const boundary = require('../../scripts/harness-v2-tool-boundary.cjs')
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'windows-bash-command-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  ensureWindowsPrivateAcl(root)
  const targetPath = path.join(root, 'target'), scratchPath = path.join(root, 'scratch'), controlRoot = path.join(root, 'controller')
  for (const directory of [targetPath, scratchPath, controlRoot]) { fs.mkdirSync(directory); ensureWindowsPrivateAcl(directory) }
  const candidate = path.join(targetPath, 'candidate'), secret = path.join(controlRoot, 'secret')
  fs.writeFileSync(candidate, 'preserved'); fs.writeFileSync(secret, 'controller-only')
  const shellWitness = path.join(scratchPath, 'shell-witness')
  const source = `const fs=require('node:fs'),assert=require('node:assert/strict');assert.equal(fs.readFileSync(${JSON.stringify(shellWitness)},'utf8'),'shell-write\\n');fs.writeFileSync(${JSON.stringify(path.join(scratchPath, 'witness'))},'native-node');for(const attempt of [()=>fs.writeFileSync(${JSON.stringify(candidate)},'forbidden'),()=>fs.readFileSync(${JSON.stringify(secret)})])assert.throws(attempt,error=>['EPERM','EACCES'].includes(error.code));process.stdout.write('node-ok')`
  const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`
  const command = [`set -- ${shellQuote(shellWitness)}`, fs.readFileSync(ipcFixture, 'utf8'),
    `printf 'bash-ok:'; node -e "eval(Buffer.from('${Buffer.from(source).toString('base64')}','base64').toString())"`].join('\n')
  const policy = { provider: 'claude', nestedDispatch: false, commandBoundary: true, externalWrites: false, readOnly: true, targetPath, scratchPath, readableRoots: [targetPath, scratchPath], writableRoots: [scratchPath] }
  const result = await boundary.executeTool(policy, 'bash', { command, timeoutMs: 30000 }, { controlRoot })
  assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(result.output, 'bash-ok:node-ok')
  assert.equal(fs.readFileSync(path.join(scratchPath, 'witness'), 'utf8'), 'native-node')
  assert.equal(fs.readFileSync(candidate, 'utf8'), 'preserved')
})
