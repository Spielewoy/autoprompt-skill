'use strict'
// Trusted caller configuration only. Never loads helpers from the candidate packet.
const assert = require('node:assert/strict'), path = require('node:path')
const { read, hash } = require('./portable.cjs')
function nativeAdapter({ repoRoot, expected }) {
  assert.equal(process.platform, 'win32', 'Native Windows adapter cannot be simulated as acceptance')
  assert.ok(path.isAbsolute(repoRoot))
  assert.deepEqual(Object.keys(expected).sort(), ['adapterSha256','aclSha256','sourceSha256','driverSha256','systemRoot'].sort())
  for (const field of ['adapterSha256','aclSha256','sourceSha256','driverSha256']) assert.match(expected[field], /^[a-f0-9]{64}$/)
  const adapterPath = path.join(repoRoot, 'scripts/windows-runtime/physical-proof/adapter.cjs')
  const aclPath = path.join(repoRoot, 'agents/codex/workflow/safe-run-root.js')
  const pairs = [[adapterPath, expected.adapterSha256], [aclPath, expected.aclSha256],
    [path.join(repoRoot, 'scripts/windows-runtime/physical-proof/audit.cs'), expected.sourceSha256],
    [path.join(repoRoot, 'scripts/windows-runtime/physical-proof/driver.ps1'), expected.driverSha256]]
  const unchanged = () => { for (const [file, digest] of pairs) assert.equal(hash(read(file)), digest, 'Trusted native helper source changed') }
  unchanged()
  const { captureForProof } = require(adapterPath), { ensureWindowsPrivateAcl } = require(aclPath)
  unchanged()
  // Capture authority by value. No test hooks, fake completion callbacks or
  // packet-supplied code paths are forwarded to the native lease controller.
  const authority = Object.freeze({ sourceSha256: expected.sourceSha256, driverSha256: expected.driverSha256, systemRoot: expected.systemRoot })
  return Object.freeze({
    privateAcl(directory) { unchanged(); ensureWindowsPrivateAcl(directory); unchanged() },
    async capture(root, entries) { unchanged(); const captured = await captureForProof(root, entries, authority); unchanged(); return captured },
  })
}
module.exports = { nativeAdapter }
