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
