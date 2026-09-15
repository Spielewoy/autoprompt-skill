'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const cp = require('node:child_process')
const lock = require('./build-lock.json')
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')

test('Node candidate patch matches its reviewed lock and exact source identity', () => {
  assert.equal(lock.version, '24.20.0')
  assert.equal(lock.source.sha256, '2732fc3f588dd335cd6779c06864f7cd424bb1b5ff9a1743059a66c54f9ca4a1')
  assert.equal(lock.source.commit, '71b8b174857e25106d39b61a9e6f30d927da8b01')
  assert.equal(lock.nasm.sha256, '3ee4782247bcb874378d02f7eab4e294a84d3d15f3f6ee2de2f47a46aa7226e6')
  const patch = fs.readFileSync(path.join(__dirname, lock.patch.file))
  assert.equal(hash(patch), lock.patch.sha256)
  assert.deepEqual(patch.toString().split('\n').filter(line => line.startsWith('--- ') || line.startsWith('+++ ')),
    ['--- a/deps/uv/src/win/pipe.c', '+++ b/deps/uv/src/win/pipe.c'])
})

test('actual compiler process helper drains logs, propagates failures and bounds timeouts', { timeout: 45000 }, t => {
  const pwsh = process.platform === 'win32' ? 'pwsh.exe' : 'pwsh'
  const available = cp.spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8', timeout: 10000 })
  if (available.error?.code === 'ENOENT' && process.platform !== 'win32') { t.skip('PowerShell is unavailable'); return }
  assert.ifError(available.error); assert.equal(available.status, 0, available.stderr)
  assert.ok(Number(available.stdout.trim()) >= 7)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-builder-contract-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const result = cp.spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'process-contract.ps1')], {
    encoding: 'utf8', timeout: 30000, env: { ...process.env, PROOF_BUILD_SCRIPT: path.join(__dirname, 'build.ps1'), PROOF_WORK: root, PROOF_NODE: process.execPath },
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.deepEqual(JSON.parse(result.stdout), { processCases: 3 })
})
