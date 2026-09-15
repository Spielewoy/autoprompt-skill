'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cp = require('node:child_process')
const crypto = require('node:crypto')

test('native Windows MSYS namespace isolates event and section leaves across profiles and releases owned names', { skip: process.platform !== 'win32', timeout: 600000 }, t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'native-msys-namespace-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const { ensureWindowsPrivateAcl } = require('../../agents/codex/workflow/safe-run-root.js')
  const { bindBashRuntime, windowsBashCandidates } = require('../../agents/codex/workflow/windows-appcontainer-command.js')
  const { parseMsysSharedId } = require('../../agents/codex/workflow/windows-appcontainer.js')
  ensureWindowsPrivateAcl(root)
  const runtime = path.join(root, 'copied-runtime'), child = path.join(root, 'child'), control = path.join(root, 'control')
  for (const directory of [runtime, child, control]) { fs.mkdirSync(directory); ensureWindowsPrivateAcl(directory) }
  const sourceBash = windowsBashCandidates(process.env, process.env.AUTOPROMPT_WINDOWS_BASH).find(file => fs.existsSync(file))
  assert.ok(sourceBash, 'The native namespace test requires an installed physical Git Bash')
  const closure = bindBashRuntime(path.dirname(fs.realpathSync.native(sourceBash)), process.env.SystemRoot)
  // The namespace is derived from a real copied and bound DLL. Neither Bash
  // nor a version probe is executed to discover its shared namespace.
  for (const binding of closure) fs.copyFileSync(binding.path, path.join(runtime, binding.name), fs.constants.COPYFILE_EXCL)
  const dll = path.join(runtime, 'msys-2.0.dll'), bytes = fs.readFileSync(dll)
  const dllHash = crypto.createHash('sha256').update(bytes).digest('hex'), sharedId = parseMsysSharedId(bytes)
  const nativeSource = path.join(control, 'windows-appcontainer-native.cs'), fixtureSource = path.join(control, 'namespace-proof.cs')
  fs.copyFileSync(path.resolve(__dirname, '../../agents/codex/workflow/windows-appcontainer-native.cs'), nativeSource, fs.constants.COPYFILE_EXCL)
  fs.copyFileSync(path.resolve(__dirname, '../fixtures/windows-msys/namespace-proof.cs'), fixtureSource, fs.constants.COPYFILE_EXCL)
  const executable = path.join(child, 'namespace-proof.exe'), controller = path.join(control, 'namespace-controller.exe')
  const systemRoot = process.env.SystemRoot
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const environment = { SystemRoot: systemRoot, WINDIR: systemRoot, SystemDrive: systemRoot.slice(0, 2),
    PATH: path.join(systemRoot, 'System32'), TEMP: control, TMP: control,
    AUTOPROMPT_NAMESPACE_NATIVE: nativeSource, AUTOPROMPT_NAMESPACE_FIXTURE: fixtureSource, AUTOPROMPT_NAMESPACE_EXE: controller }
  const compiled = cp.spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop";Add-Type -Path @($env:AUTOPROMPT_NAMESPACE_NATIVE,$env:AUTOPROMPT_NAMESPACE_FIXTURE) -OutputAssembly $env:AUTOPROMPT_NAMESPACE_EXE -OutputType ConsoleApplication'], {
    encoding: 'utf8', timeout: 60000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: environment,
  })
  assert.ifError(compiled.error)
  assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)
  fs.copyFileSync(controller, executable, fs.constants.COPYFILE_EXCL)
  // Keep the running controller image separate: Windows can refuse ACL
  // updates to an image that is already mapped for execution.
  // The controller grants only this fixture executable and its containing
  // empty working directory to the two profiles, then uses the production
  // launcher to prove each child's exact token, image and job drain.
  const result = cp.spawnSync(controller, [executable, path.join(runtime, 'bash.exe'), dll, dllHash, sharedId], {
    encoding: 'utf8', timeout: 90000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    cwd: control, env: { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: path.join(systemRoot, 'System32'), TEMP: control, TMP: control },
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(result.stderr, '')
  const proof = JSON.parse(result.stdout)
  assert.ok(proof.namespaceCount === 1 || proof.namespaceCount === 2)
  // Each namespace has real event and section leaves with all three MSYS
  // descriptor shapes: explicit WORLD, explicit NULL DACL and default SD.
  assert.deepEqual(proof, { sameProfileOpens: proof.namespaceCount * 6, wrongProfileDenied: proof.namespaceCount * 6,
    namespaceCount: proof.namespaceCount, collisionRefused: true, released: true })
})
