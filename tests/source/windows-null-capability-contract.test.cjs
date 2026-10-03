'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cp = require('node:child_process')

test('private NUL capability verifies bounded native identity and preserves the closed environment protocol', { timeout: 90000 }, t => {
  const powershell = process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'pwsh'
  const available = cp.spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8', timeout: 15000 })
  if (available.error?.code === 'ENOENT' && process.platform !== 'win32') { t.skip('PowerShell is unavailable'); return }
  assert.ifError(available.error)
  assert.equal(available.status, 0, available.stderr)
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'null-capability-contract-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let source = fs.readFileSync(path.resolve(__dirname, '../../agents/codex/workflow/windows-appcontainer-native.cs'), 'utf8')
  const boundaries = { GetFileType: 'handle', GetHandleInformation: 'handle,out flags', NtQueryObject: 'handle,information,buffer,length,out required' }
  for (const [name, args] of Object.entries(boundaries)) {
    const expression = new RegExp(' \\[DllImport\\([^\\n]+\\)\\] static extern (\\w+) ' + name + '\\(([^;]+)\\);', 'g')
    assert.equal([...source.matchAll(expression)].length, 1, `Replace exactly the native ${name} boundary`)
    source = source.replace(expression, (_, returns, parameters) => ` static ${returns} ${name}(${parameters}){return NullCapabilityMock.${name}(${args});}`)
  }
  const copied = path.join(directory, 'native.cs')
  fs.writeFileSync(copied, source)
  const result = cp.spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference="Stop";Add-Type -Path @($env:AUTOPROMPT_NULL_NATIVE,$env:AUTOPROMPT_NULL_CONTRACT);[NullCapabilityContract]::Run()'], {
    encoding: 'utf8', timeout: 60000, windowsHide: true,
    env: { ...process.env, AUTOPROMPT_NULL_NATIVE: copied, AUTOPROMPT_NULL_CONTRACT: path.resolve(__dirname, '../fixtures/windows-appcontainer/null-capability-contract.cs') },
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(result.stderr, '')
  const proof = JSON.parse(result.stdout)
  assert.deepEqual(proof, { contractCases: 79, nativeApiBoundaries: 3 })
  t.diagnostic(`${proof.contractCases} actual-source adversarial contracts; native API results are mocked, not Windows execution`)
})

test('AppContainer profile environment uses the token profile without relaxing caller protocol bounds', { timeout: 90000 }, t => {
  const powershell = process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : (process.env.AUTOPROMPT_TEST_PWSH || 'pwsh')
  const directory = process.platform === 'win32' ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'profile-environment-contract-'))
  if (directory) t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const profile = process.platform === 'win32' ? os.userInfo().homedir : path.join(directory, 'profile')
  const local = path.join(profile, 'AppData', 'Local')
  if (process.platform !== 'win32') fs.mkdirSync(local, { recursive: true })
  let native = path.resolve(__dirname, '../../agents/codex/workflow/windows-appcontainer-native.cs')
  const environment = { ...process.env, AUTOPROMPT_PROFILE_EXPECTED: profile }
  if (process.platform !== 'win32') {
    native = path.join(directory, 'native.cs')
    const source = fs.readFileSync(path.resolve(__dirname, '../../agents/codex/workflow/windows-appcontainer-native.cs'), 'utf8')
    const pattern = / static String CurrentTokenProfile\(\)\{[\s\S]*?\}\n static IntPtr EnvironmentBlock/
    assert.equal([...source.matchAll(new RegExp(pattern.source, 'g'))].length, 1, 'replace exactly one token profile boundary')
    fs.writeFileSync(native, source.replace(pattern, ' static String CurrentTokenProfile(){return Environment.GetEnvironmentVariable("AUTOPROMPT_TEST_PROFILE");}\n static IntPtr EnvironmentBlock'))
    environment.AUTOPROMPT_TEST_PROFILE = profile
    environment.AUTOPROMPT_PROFILE_NATIVE_MOCK = '1'
  }
  if (process.platform === 'win32') environment.AUTOPROMPT_PROFILE_NATIVE_MOCK = ''
  const result = cp.spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference="Stop";Add-Type -Path @($env:AUTOPROMPT_PROFILE_NATIVE,$env:AUTOPROMPT_PROFILE_CONTRACT);[ProfileEnvironmentContract]::Run()'], {
    encoding: 'utf8', timeout: 60000, windowsHide: true,
    env: { ...environment, AUTOPROMPT_PROFILE_NATIVE: native, AUTOPROMPT_PROFILE_CONTRACT: path.resolve(__dirname, '../fixtures/windows-appcontainer/profile-environment-contract.cs') },
  })
  if (result.error?.code === 'ENOENT' && process.platform !== 'win32') { t.skip('PowerShell is unavailable'); return }
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(result.stderr, '')
  assert.deepEqual(JSON.parse(result.stdout), { contractCases: 28, tokenProfileApi: process.platform === 'win32', nativeLaunch: false })
})

test('MSYS launch policy verifies effective ASLR before allowing execution', { timeout: 90000 }, t => {
  const powershell = process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'pwsh'
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'msys-aslr-contract-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const source = fs.readFileSync(path.resolve(__dirname, '../../agents/codex/workflow/windows-appcontainer-native.cs'), 'utf8')
  const pattern = / \[DllImport\([^\n]+\)\] static extern Boolean QueryMsysAslr\(IntPtr process,UInt32 policy,out MSYS_ASLR_POLICY information,UIntPtr length\);/g
  assert.equal([...source.matchAll(pattern)].length, 1)
  const native = path.join(directory, 'native.cs')
  fs.writeFileSync(native, source.replace(pattern, ' static Boolean QueryMsysAslr(IntPtr process,UInt32 policy,out MSYS_ASLR_POLICY information,UIntPtr length){MsysAslrMock.Process=process;MsysAslrMock.Policy=policy;MsysAslrMock.Length=length;information=new MSYS_ASLR_POLICY{Flags=MsysAslrMock.Flags};return MsysAslrMock.Success;}'))
  const result = cp.spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference="Stop";Add-Type -Path @($env:AP_NATIVE,$env:AP_CONTRACT);[MsysAslrContract]::Run()'], {
    encoding: 'utf8', timeout: 60000, windowsHide: true,
    env: { ...process.env, AP_NATIVE: native, AP_CONTRACT: path.resolve(__dirname, '../fixtures/windows-appcontainer/msys-aslr-contract.cs') },
  })
  if (result.error?.code === 'ENOENT' && process.platform !== 'win32') { t.skip('PowerShell is unavailable'); return }
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(result.stderr, '')
  assert.deepEqual(JSON.parse(result.stdout), { contractCases: 33, nativeApiBoundaries: 1 })
  t.diagnostic('Actual compiled verifier; Windows query results mocked, native launch tested separately')
})
