'use strict'
// Independent native boundary proof; does not admit or install a runtime.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto'), assert = require('node:assert/strict')
const { bound, physical } = require('../descriptor-proof/run.cjs')
const { readBounded, stagedDigest, closureRecords } = require('../probe-built-runtime.cjs')
const { parseProof } = require('./parse.cjs')
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
function main(args) {
  assert.equal(process.platform, 'win32'); assert.equal(args.length, 5, 'Usage: node run.cjs REPO MSYS_BUILD_WORK TOOLCHAIN_JSON EXPECTED_TOOLCHAIN_SHA256 NEW_OUTPUT')
  const [repoArg, workArg, toolchain, expectedToolchain, outputArg] = args
  const repo = physical(path.resolve(repoArg), true), work = physical(path.resolve(workArg), true)
  const payload = path.join(work, 'sdk', 'issue27-build'), smokeBytes = readBounded(path.join(payload, 'built-runtime-manifest.json'))
  const adaptationBytes = readBounded(path.join(payload, 'adaptation.sha256'), 1024)
  const patchHash = sha(bound(path.join(repo, 'scripts/windows-msys/pipe-security.patch')))
  assert.equal(adaptationBytes.toString('utf8'), patchHash + '  adaptation.patch\n', 'Compiled MSYS adaptation must match the reviewed patch')
  const smoke = JSON.parse(smokeBytes)
  assert.equal(path.dirname(smoke.runtimeDirectory).toLowerCase(), payload.toLowerCase())
  assert.match(path.basename(smoke.runtimeDirectory), /^proof-runtime-[a-f0-9-]+$/)
  const source = require(path.join(repo, 'agents/codex/workflow/windows-appcontainer-command.js')).bindBashRuntime(smoke.runtimeDirectory, process.env.SystemRoot)
  assert.deepEqual(closureRecords(source), smoke.copied)
  assert.equal(stagedDigest(readBounded(path.join(payload, 'stage.sha256'))), smoke.stageSha256)
  const dll = source.find(file => file.name === 'msys-2.0.dll'), bash = source.find(file => file.name === 'bash.exe')
  assert.equal(dll.sha256, smoke.stageSha256)
  const built = require('./build.cjs').main([repo, toolchain, expectedToolchain, outputArg])
  const output = physical(path.resolve(outputArg), true)
  const manifest = { schemaVersion: 1, status: 'pending', purpose: 'compiled MSYS process/thread isolation proof; not complete runtime acceptance', fixture: built,
    runtimeManifestSha256: sha(smokeBytes), runtimeClosure: closureRecords(source), patchSha256: patchHash, adaptationManifestSha256: sha(adaptationBytes),
    controllerSha256: sha(bound(path.join(__dirname, 'controller.cs'))), nativeSha256: sha(bound(path.join(repo, 'agents/codex/workflow/windows-appcontainer-native.cs'))), runnerSha256: sha(bound(__filename)) }
  const manifestPath = path.join(output, 'native-manifest.json')
  const save = () => fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  save()
  const privateAcl = require(path.join(repo, 'agents/codex/workflow/safe-run-root.js')).ensureWindowsPrivateAcl
  const mkdir = (...parts) => { const directory = path.join(output, ...parts); fs.mkdirSync(directory); privateAcl(directory); return directory }
  const owned = mkdir('work'), control = mkdir('work', 'control'), runtime = mkdir('work', 'runtime')
  mkdir('work', 'runtime', 'usr'); const bin = mkdir('work', 'runtime', 'usr', 'bin'), etc = mkdir('work', 'runtime', 'etc')
  const cwdA = mkdir('work', 'cwd-A'), cwdB = mkdir('work', 'cwd-B')
  for (const file of source) fs.writeFileSync(path.join(bin, file.name), file.bytes, { flag: 'wx' })
  const fixture = bound(built.executable); assert.equal(sha(fixture), built.executableSha256)
  const executable = path.join(bin, 'process-security.exe'); fs.writeFileSync(executable, fixture, { flag: 'wx' })
  fs.writeFileSync(path.join(etc, 'fstab'), 'none /tmp usertemp binary,posix=0,noacl 0 0\n', { flag: 'wx' })
  const native = path.join(control, 'native.cs'), controllerSource = path.join(control, 'controller.cs')
  fs.writeFileSync(native, bound(path.join(repo, 'agents/codex/workflow/windows-appcontainer-native.cs')), { flag: 'wx' })
  fs.writeFileSync(controllerSource, bound(path.join(__dirname, 'controller.cs')), { flag: 'wx' })
  assert.equal(sha(bound(native)), manifest.nativeSha256); assert.equal(sha(bound(controllerSource)), manifest.controllerSha256)
  const system = physical(process.env.SystemRoot, true), controller = path.join(control, 'controller.exe')
  const env = { SystemRoot: system, WINDIR: system, SystemDrive: system.slice(0, 2), PATH: path.join(system, 'System32'), TEMP: control, TMP: control }
  function run(label, file, argv, environment, timeout) {
    const result = cp.spawnSync(file, argv, { env: environment, cwd: control, encoding: 'utf8', timeout, maxBuffer: 256 * 1024, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    for (const stream of ['stdout', 'stderr']) fs.writeFileSync(path.join(output, label + '.' + stream + '.txt'), result[stream] || '', { flag: 'wx' })
    assert.ifError(result.error); assert.equal(result.status, 0, (result.stderr || result.stdout).slice(-16384)); assert.equal(result.stderr, ''); return result.stdout
  }
  run('compile-controller', path.join(system, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '[Environment]::SetEnvironmentVariable("PSModulePath",[IO.Path]::Combine($PSHOME,"Modules"),[EnvironmentVariableTarget]::Process);$ErrorActionPreference="Stop";$ProgressPreference="SilentlyContinue";Add-Type -Path @($env:AP_NATIVE,$env:AP_SOURCE) -OutputAssembly $env:AP_OUTPUT -OutputType ConsoleApplication'], { ...env, AP_NATIVE: native, AP_SOURCE: controllerSource, AP_OUTPUT: controller }, 60000)
  manifest.controllerExecutableSha256 = sha(bound(controller)); save()
  const sharedId = require(path.join(repo, 'agents/codex/workflow/windows-appcontainer.js')).parseMsysSharedId(dll.bytes)
  const raw = run('native-controller', controller, [executable, built.executableSha256, path.join(bin, 'bash.exe'), bash.sha256, path.join(bin, 'msys-2.0.dll'), dll.sha256, sharedId, control, cwdA, cwdB], env, 80000)
  manifest.proof = parseProof(raw)
  assert.equal(sha(bound(native)), manifest.nativeSha256); assert.equal(sha(bound(controllerSource)), manifest.controllerSha256)
  assert.equal(sha(bound(controller)), manifest.controllerExecutableSha256)
  assert.equal(sha(bound(path.join(repo, 'scripts/windows-msys/pipe-security.patch'))), patchHash)
  manifest.status = 'native-passed-cleanup-pending'; save()
  // Only successful controller completion plus strict three-drain proof permits cleanup.
  // Every failure leaves the complete owned tree for inspection and recovery.
  fs.rmSync(owned, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  manifest.status = 'passed'; save()
  process.stdout.write(JSON.stringify({ status: 'passed', proof: manifest.proof, manifest: manifestPath }) + '\n')
}
module.exports = { main }
if (require.main === module) { try { main(process.argv.slice(2)) } catch (error) { process.stderr.write((error.stack || error) + '\n'); process.exitCode = 1 } }
