'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cp = require('node:child_process')
const native = path.resolve(__dirname, '../../agents/codex/workflow/windows-appcontainer-native.cs')
const fixtures = path.resolve(__dirname, '../fixtures/windows-appcontainer')
function powershell() { return process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'pwsh' }

test('member image reconciliation bounds shared grace and rejects unconfirmed exits', { timeout: 90000 }, t => {
  const available = cp.spawnSync(powershell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8', timeout: 15000 })
  if (available.error?.code === 'ENOENT' && process.platform !== 'win32') { t.skip('PowerShell is unavailable'); return }
  assert.ifError(available.error)
  assert.equal(available.status, 0, available.stderr)
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'member-image-contract-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let source = fs.readFileSync(native, 'utf8')
  const declaration = '[DllImport("kernel32.dll",SetLastError=true)] static extern UInt32 WaitForSingleObject(IntPtr handle,UInt32 milliseconds);'
  assert.equal(source.split(declaration).length, 2, 'Replace exactly the native wait boundary, retaining the complete production helper')
  source = source.replace(declaration, 'static UInt32 WaitForSingleObject(IntPtr handle,UInt32 milliseconds){return MemberImageWaitMock.Wait(handle,milliseconds);}')
  const copied = path.join(directory, 'native.cs')
  fs.writeFileSync(copied, source)
  const result = cp.spawnSync(powershell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop";Add-Type -Path @($env:AUTOPROMPT_MEMBER_NATIVE,$env:AUTOPROMPT_MEMBER_CONTRACT);[MemberImageContract]::Run()'], {
    encoding: 'utf8', timeout: 60000, windowsHide: true,
    env: { ...process.env, AUTOPROMPT_MEMBER_NATIVE: copied, AUTOPROMPT_MEMBER_CONTRACT: path.join(fixtures, 'member-image-contract.cs') },
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(result.stderr, '')
  assert.deepEqual(JSON.parse(result.stdout), { contractCases: 10 })
})

test('native Windows member image verification reconciles only confirmed exits and preserves live denial', { skip: process.platform !== 'win32', timeout: 600000 }, t => {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'member-image-native-')))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { ensureWindowsPrivateAcl } = require('../../agents/codex/workflow/safe-run-root.js')
  ensureWindowsPrivateAcl(directory)
  const control = path.join(directory, 'control'), child = path.join(directory, 'child')
  for (const folder of [control, child]) { fs.mkdirSync(folder); ensureWindowsPrivateAcl(folder) }
  const source = path.join(control, 'native.cs'), fixture = path.join(control, 'member-image-proof.cs')
  fs.copyFileSync(native, source, fs.constants.COPYFILE_EXCL)
  fs.copyFileSync(path.join(fixtures, 'member-image-proof.cs'), fixture, fs.constants.COPYFILE_EXCL)
  const controller = path.join(control, 'controller.exe'), executable = path.join(child, 'child.exe')
  const systemRoot = process.env.SystemRoot
  const environment = { SystemRoot: systemRoot, WINDIR: systemRoot, SystemDrive: systemRoot.slice(0, 2), PATH: path.join(systemRoot, 'System32'), TEMP: control, TMP: control }
  const compiled = cp.spawnSync(powershell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop";Add-Type -Path @($env:AUTOPROMPT_MEMBER_NATIVE,$env:AUTOPROMPT_MEMBER_FIXTURE) -OutputAssembly $env:AUTOPROMPT_MEMBER_EXE -OutputType ConsoleApplication'], {
    encoding: 'utf8', timeout: 60000, windowsHide: true,
    env: { ...environment, AUTOPROMPT_MEMBER_NATIVE: source, AUTOPROMPT_MEMBER_FIXTURE: fixture, AUTOPROMPT_MEMBER_EXE: controller },
  })
  assert.ifError(compiled.error)
  assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)
  fs.copyFileSync(controller, executable, fs.constants.COPYFILE_EXCL)
  const result = cp.spawnSync(controller, [executable], { encoding: 'utf8', timeout: 60000, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'], cwd: control, env: environment,
  })
  for (const stream of ['stdout', 'stderr']) for (const line of String(result[stream] || '').slice(0, 16384).split(/\r?\n/)) {
    for (let offset = 0; offset < line.length; offset += 480) t.diagnostic(`${stream}: ${line.slice(offset, offset + 480)}`)
  }
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(result.stderr, '')
  const proof = JSON.parse(result.stdout)
  assert.deepEqual(Object.keys(proof).sort(), ['children', 'drained', 'liveDenied', 'nonAccessDeniedRefused', 'observedJobMembers', 'terminatedReconciled'])
  for (const key of ['drained', 'liveDenied', 'nonAccessDeniedRefused', 'terminatedReconciled']) assert.equal(proof[key], true)
  assert.equal(proof.children, 12)
  // This aggregate job membership is independent of explicit child count. The
  // fixture separately requires exactly 12 token-checked child completions.
  assert.ok(Number.isSafeInteger(proof.observedJobMembers) && proof.observedJobMembers >= 2 && proof.observedJobMembers <= 1024)
})
