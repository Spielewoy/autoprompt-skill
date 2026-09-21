'use strict'
// Diagnostic-only derived runtime; never exports or admits a production candidate.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto'), assert = require('node:assert/strict')
const mapping = require('../mapping-proof/run.cjs')
const { physical, bound } = require('../descriptor-proof/run.cjs')
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
function main(args) {
  assert.equal(process.platform, 'win32'); assert.equal(process.arch, 'x64'); assert.equal(args.length, 4, 'REPO PACKET OUTPUT BUILD_PAYLOAD')
  const [repo, packet, output, payload] = args.map(value => physical(path.resolve(value), true))
  const input = mapping.packetInputs(repo, packet), inputs = path.join(output, 'pipe-trace-inputs')
  const combined = bound(path.join(inputs, 'combined.patch'), 4 * 1048576), manifest = bound(path.join(inputs, 'manifest.json'), 4 * 1048576)
  const declaration = JSON.parse(manifest)
  assert.equal(declaration.schema, 1); assert.equal(declaration.status, 'diagnostic-only'); assert.equal(declaration.sourceCommit, '270ba2980700e6e2a0813944d506eecea0f86402')
  assert.equal(declaration.basePatchSha256, '8bc01e2694245b271699128399aba48777fa44b878376ee9d84b82b8929eea87'); assert.equal(declaration.combinedPatchSha256, sha(combined))
  assert.equal(declaration.generatorSha256, sha(bound(path.join(__dirname, 'generate.py'), 1048576))); assert.equal(declaration.headerSha256, sha(bound(path.join(__dirname, 'trace.h'), 1048576)))
  assert.ok(Array.isArray(declaration.records) && declaration.records.length > 2 && declaration.records.length <= 128)
  const seen = new Set()
  for (const record of declaration.records) {
    assert.match(record.path, /^winsup\/cygwin\/[A-Za-z0-9_./-]+$/); assert.ok(!record.path.split('/').includes('..') && !seen.has(record.path)); seen.add(record.path)
    assert.equal(sha(bound(path.join(payload, 'source', record.path), 4 * 1048576)), record.resultSha256, 'compiled source identity: ' + record.path)
  }
  assert.equal(sha(bound(path.join(payload, 'adaptation.patch'), 4 * 1048576)), sha(combined), 'compiled adaptation identity')
  assert.equal(sha(bound(path.join(repo, 'scripts/windows-msys/pipe-security.patch'), 4 * 1048576)), '8bc01e2694245b271699128399aba48777fa44b878376ee9d84b82b8929eea87')
  assert.equal(sha(bound(path.join(payload, 'source.tar.gz'))), '0571ad83f965bf7682a446a874830a560c8b12431e7d54e55f414a3851ba1146')
  const toolchainBefore = bound(path.join(payload, 'toolchain-inputs.sha256'), 65536), toolchainAfter = bound(path.join(payload, 'toolchain-outputs.sha256'), 65536)
  assert.deepEqual(toolchainBefore, toolchainAfter, 'compiler/linker unchanged')
  const dll = bound(path.join(payload, 'stage/usr/bin/msys-2.0.dll'), 32 * 1048576), dllVariant = mapping.dynamicBaseOnly(dll, 0), bashVariant = mapping.dynamicBaseOnly(input.bash, 0x8000, false)
  const work = mapping.privateDirectory(repo, fs.mkdtempSync(path.join(output, 'pipe-io-diagnostic-'))), controller = mapping.compileController(repo, work)
  const sharedId = require(path.join(repo, 'agents/codex/workflow/windows-appcontainer.js')).parseMsysSharedId(dllVariant.patched)
  const trial = mapping.arm(repo, path.join(work, 'pipe-io-trace'), 'pipe-io-trace', bashVariant.patched, dllVariant.patched, sharedId, dllVariant.info)
  const launched = cp.spawnSync(controller, trial.args, { cwd: trial.root, encoding: 'utf8', timeout: 150000, maxBuffer: 1048576, windowsHide: true, shell: false, env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot, SystemDrive: process.env.SystemRoot.slice(0, 2), PATH: path.join(process.env.SystemRoot, 'System32'), TEMP: trial.root, TMP: trial.root } })
  fs.writeFileSync(path.join(work, 'controller.stdout.txt'), launched.stdout || ''); fs.writeFileSync(path.join(work, 'controller.stderr.txt'), launched.stderr || '')
  assert.ifError(launched.error); assert.equal(launched.status, 0, launched.stderr || launched.stdout)
  const result = JSON.parse(fs.readFileSync(path.join(trial.root, 'pipe-io-trace.json'), 'utf8'))
  const sources = {}
  for (const name of ['.github/workflows/native-platform.yml', 'scripts/windows-msys/pipe-io-trace/generate.py', 'scripts/windows-msys/pipe-io-trace/trace.h', 'scripts/windows-msys/pipe-io-trace/run.cjs', 'scripts/windows-msys/build.ps1', 'scripts/windows-msys/build.sh', 'scripts/windows-msys/build-lock.json', 'scripts/windows-msys/mapping-proof/run.cjs', 'scripts/windows-msys/mapping-proof/source/mapping-controller.cs', 'agents/codex/workflow/windows-appcontainer-native.cs']) sources[name] = sha(bound(path.join(repo, name), 4 * 1048576))
  const report = { schema: 1, status: 'observed-not-accepted', scope: 'one traced x64 build, not runtime acceptance', packetManifestSha256: sha(input.manifestBytes), combinedPatchSha256: sha(combined), traceManifestSha256: sha(manifest), traceManifest: JSON.parse(manifest), toolchainRecordsSha256: sha(toolchainBefore), sources, originalBuiltDllSha256: sha(dll), derivedDllSha256: sha(dllVariant.patched), dllChangedOffsets: dllVariant.changed, derivedBashSha256: sha(bashVariant.patched), bashChangedOffsets: bashVariant.changed, result }
  fs.writeFileSync(path.join(work, 'summary.json'), JSON.stringify(report, null, 2) + '\n')
  process.stdout.write(JSON.stringify(report) + '\n')
}
if (require.main === module) { try { main(process.argv.slice(2)) } catch (error) { process.stderr.write(String(error.stack || error) + '\n'); process.exitCode = 1 } }
