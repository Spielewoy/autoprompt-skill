'use strict'
// Source-bound native component proof. Never selects/replaces a runtime.
const fs = require('node:fs')
const path = require('node:path')
const cp = require('node:child_process')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const expected = JSON.parse(fs.readFileSync(path.join(__dirname, 'binding.json'), 'utf8'))
function exact(value, keys) { assert.deepEqual(Object.keys(value).sort(), [...keys].sort()) }
function physical(file, directory = false) {
  assert.ok(path.isAbsolute(file) && !/[\0;]/.test(file))
  const canonical = fs.realpathSync.native(file)
  assert.equal(canonical.toLowerCase(), path.resolve(file).toLowerCase(), 'Aliased input refused')
  for (let cursor = canonical; ; cursor = path.dirname(cursor)) {
    const stat = fs.lstatSync(cursor)
    assert.equal(stat.isSymbolicLink(), false, 'Linked input refused')
    if (directory || cursor !== canonical) assert.equal(stat.isDirectory(), true)
    if (cursor === path.parse(cursor).root) break
  }
  return canonical
}
function bound(file, max = 128 * 1024 * 1024) {
  physical(file)
  const fd = fs.openSync(file, 'r')
  try {
    const before = fs.fstatSync(fd, { bigint: true })
    assert.ok(before.isFile() && before.nlink === 1n && before.size > 0n && before.size <= BigInt(max))
    const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd, { bigint: true })
    assert.equal(bytes.length, Number(before.size))
    for (const field of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']) assert.equal(after[field], before[field])
    return bytes
  } finally { fs.closeSync(fd) }
}
function parseProof(stdout) {
  const proof = JSON.parse(stdout)
  exact(proof, ['schemaVersion', 'objects', 'sameProfileOpens', 'otherProfileDenied', 'drainedJobs', 'namespaceCount', 'creatorBase64', 'sameBase64', 'otherBase64'])
  assert.equal(proof.schemaVersion, 1)
  for (const key of ['objects', 'sameProfileOpens', 'otherProfileDenied']) assert.equal(proof[key], 16)
  assert.equal(proof.drainedJobs, 3)
  assert.ok(proof.namespaceCount === 1 || proof.namespaceCount === 2)
  for (const [key, prefix, end] of [
    ['creatorBase64', 'created', 'creator:16:descriptor-and-peer-effects-passed'],
    ['sameBase64', 'same', 'same-profile:16:passed'],
    ['otherBase64', 'other', 'other-profile:16:passed'],
  ]) {
    const encoded = proof[key]; assert.equal(typeof encoded, 'string'); assert.ok(encoded.length <= 21848)
    const bytes = Buffer.from(encoded, 'base64'); assert.equal(bytes.toString('base64'), encoded)
    const lines = bytes.toString('utf8').trimEnd().split(/\r?\n/)
    assert.equal(lines.length, 17)
    for (let variant = 0; variant < 4; variant++) for (let kind = 0; kind < 4; kind++) {
      const expected = prefix === 'created' ? `created:variant=${variant}:kind=${kind}:effective-descriptor=passed`
        : `open:variant=${variant}:kind=${kind}:status=${prefix === 'same' ? '00000000' : 'c0000022'}:allowed=${prefix === 'same' ? 1 : 0}`
      assert.equal(lines[variant * 4 + kind], expected)
    }
    assert.equal(lines[16], end)
  }
  return proof
}
function main(args) {
  assert.equal(process.platform, 'win32', 'Actual Windows is required')
  assert.equal(args.length, 7, 'Usage: node run.cjs REPO PREPARED BASH BUILT_DLL NEW_OUTPUT TOOLCHAIN_JSON EXPECTED_DLL_SHA256')
  const [repoArg, preparedArg, bashArg, dllArg, outputArg, toolchainArg, expectedDllHash] = args
  const repo = physical(path.resolve(repoArg), true), prepared = physical(path.resolve(preparedArg), true)
  const bash = physical(path.resolve(bashArg)), dll = physical(path.resolve(dllArg)), toolchainFile = physical(path.resolve(toolchainArg))
  assert.match(expectedDllHash, /^[a-f0-9]{64}$/)
  const dllBytes = bound(dll, 32 * 1024 * 1024), bashBytes = bound(bash, 16 * 1024 * 1024)
  assert.equal(sha(dllBytes), expectedDllHash, 'Built DLL differs from independently admitted build digest')
  const binding = JSON.parse(bound(path.join(prepared, 'source-binding.json'), 1024 * 1024))
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(binding[key], value, `Source binding ${key} drift`)
  assert.equal(sha(bound(path.join(repo, 'scripts/windows-msys/pipe-security.patch'))), expected.patchSha256)
  const lock = JSON.parse(bound(path.join(repo, 'scripts/windows-msys/build-lock.json'), 1024 * 1024))
  assert.equal(lock.source.commit, expected.sourceCommit); assert.equal(lock.sdk.commit, expected.sdkCommit)
  const sourceDigests = { 'appcontainer_pipe.cc': expected.standaloneHelperSha256, 'appcontainer_pipe_security.h': expected.headerSha256, 'descriptor-proof.cc': expected.fixtureSha256 }
  const captured = {}
  for (const [name, digest] of Object.entries(sourceDigests)) { captured[name] = bound(path.join(prepared, name)); assert.equal(sha(captured[name]), digest) }
  const toolchain = JSON.parse(bound(toolchainFile, 1024 * 1024))
  exact(toolchain, ['cl', 'link', 'include', 'lib', 'sdkVersion', 'arch'])
  assert.equal(toolchain.arch, process.arch, 'Proof executable must run natively on this architecture')
  assert.ok(['x64', 'arm64'].includes(toolchain.arch)); assert.match(toolchain.sdkVersion, /^10\.0\.[0-9]+\.0$/)
  const cl = physical(toolchain.cl), linker = physical(toolchain.link)
  assert.equal(path.basename(cl).toLowerCase(), 'cl.exe'); assert.equal(path.basename(linker).toLowerCase(), 'link.exe')
  for (const list of [toolchain.include, toolchain.lib]) { assert.ok(Array.isArray(list) && list.length > 0 && list.length <= 16); for (const directory of list) physical(directory, true) }
  const output = path.resolve(outputArg); assert.equal(fs.existsSync(output), false, 'Fresh proof output required')
  physical(path.dirname(output), true); fs.mkdirSync(output)
  const { ensureWindowsPrivateAcl } = require(path.join(repo, 'agents/codex/workflow/safe-run-root.js'))
  ensureWindowsPrivateAcl(output)
  const artifacts = path.join(output, 'artifacts'), work = path.join(output, 'work')
  for (const directory of [artifacts, work]) { fs.mkdirSync(directory); ensureWindowsPrivateAcl(directory) }
  const systemRoot = physical(process.env.SystemRoot, true)
  const environment = { SystemRoot: systemRoot, WINDIR: systemRoot, SystemDrive: systemRoot.slice(0, 2), PATH: [...new Set([path.dirname(cl), path.dirname(linker), path.join(systemRoot, 'System32')])].join(';'), INCLUDE: toolchain.include.join(';'), LIB: toolchain.lib.join(';'), TEMP: artifacts, TMP: artifacts }
  const commands = []
  function run(label, executable, argv, env = environment, timeout = 120000, cwd = artifacts) {
    const result = cp.spawnSync(executable, argv, { env, cwd, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    fs.writeFileSync(path.join(artifacts, label + '.stdout.txt'), result.stdout || '', { flag: 'wx' }); fs.writeFileSync(path.join(artifacts, label + '.stderr.txt'), result.stderr || '', { flag: 'wx' })
    commands.push({ label, executable, argv, status: result.status, signal: result.signal, error: result.error?.code || null })
    fs.writeFileSync(path.join(artifacts, 'commands.json'), JSON.stringify(commands, null, 2) + '\n')
    assert.ifError(result.error); assert.equal(result.status, 0, `${label}: ${(result.stderr || result.stdout).slice(-16384)}`)
    return result
  }
  for (const [name, bytes] of Object.entries(captured)) fs.writeFileSync(path.join(artifacts, name), bytes, { flag: 'wx' })
  const nativeSource = bound(path.join(repo, 'agents/codex/workflow/windows-appcontainer-native.cs'), 4 * 1024 * 1024)
  const controllerSource = bound(path.join(__dirname, 'controller.cs'), 4 * 1024 * 1024)
  fs.writeFileSync(path.join(artifacts, 'windows-appcontainer-native.cs'), nativeSource, { flag: 'wx' }); fs.writeFileSync(path.join(artifacts, 'controller.cs'), controllerSource, { flag: 'wx' })
  const compilerHash = sha(bound(cl)), linkerHash = sha(bound(linker))
  const manifest = { schemaVersion: 1, sourceBinding: binding, toolchain, compilerSha256: compilerHash, linkerSha256: linkerHash, toolchainFileSha256: sha(bound(toolchainFile)), productionNativeSha256: sha(nativeSource), controllerSha256: sha(controllerSource), bashSha256: sha(bashBytes), dllSha256: expectedDllHash, nativeExecution: 'pending' }
  fs.writeFileSync(path.join(artifacts, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
  const objects = []
  for (const source of ['descriptor-proof.cc', 'appcontainer_pipe.cc']) {
    const object = path.join(artifacts, source.replace('.cc', '.obj')); objects.push(object)
    run('compile-' + source, cl, ['/nologo', '/Bv', '/showIncludes', '/MT', '/EHsc', '/std:c++17', '/W4', '/D_WIN32_WINNT=0x0602', '/DWINVER=0x0602', '/DUNICODE', '/D_UNICODE', '/DNOMINMAX', '/c', path.join(artifacts, source), '/Fo' + object])
  }
  const executable = path.join(artifacts, 'descriptor-proof.exe')
  run('link', linker, ['/NOLOGO', '/INCREMENTAL:NO', '/SUBSYSTEM:CONSOLE', '/ENTRY:wmainCRTStartup', '/MACHINE:' + toolchain.arch.toUpperCase(), '/OUT:' + executable, ...objects, 'advapi32.lib', 'kernel32.lib'])
  assert.equal(sha(bound(cl)), compilerHash); assert.equal(sha(bound(linker)), linkerHash)
  for (const [name, digest] of Object.entries(sourceDigests)) assert.equal(sha(bound(path.join(artifacts, name))), digest)
  const pe = bound(executable), offset = pe.readUInt32LE(60)
  assert.equal(pe.readUInt32LE(offset), 0x4550); assert.equal(pe.readUInt16LE(offset + 4), toolchain.arch === 'x64' ? 0x8664 : 0xaa64)
  const { importedDlls } = require(path.join(repo, 'agents/codex/workflow/windows-appcontainer-command.js'))
  const imports = importedDlls(pe)
  for (const dll of imports) assert.ok(/^(?:api-ms-win-|ext-ms-win-)/i.test(dll) || fs.existsSync(path.join(systemRoot, 'System32', dll)), `Non-system dependency refused: ${dll}`)
  const host = run('host-check', executable, ['host-check'], environment, 10000)
  assert.equal(host.stdout.trim(), 'host-check:passed'); assert.equal(host.stderr, '')
  const control = path.join(work, 'control'), child = path.join(work, 'child'), pair = path.join(work, 'pair'), cwdA = path.join(work, 'cwd-A'), cwdB = path.join(work, 'cwd-B')
  for (const directory of [control, child, pair, cwdA, cwdB]) { fs.mkdirSync(directory); ensureWindowsPrivateAcl(directory) }
  const childExe = path.join(child, 'descriptor-proof.exe'), copiedBash = path.join(pair, 'bash.exe'), copiedDll = path.join(pair, 'msys-2.0.dll')
  fs.writeFileSync(childExe, pe, { flag: 'wx' }); fs.writeFileSync(copiedBash, bashBytes, { flag: 'wx' }); fs.writeFileSync(copiedDll, dllBytes, { flag: 'wx' })
  const { parseMsysSharedId } = require(path.join(repo, 'agents/codex/workflow/windows-appcontainer.js'))
  const sharedId = parseMsysSharedId(dllBytes)
  const controller = path.join(control, 'controller.exe'), powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  run('compile-controller', powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "[Environment]::SetEnvironmentVariable('PSModulePath',[IO.Path]::Combine($PSHOME,'Modules'),[EnvironmentVariableTarget]::Process);$ErrorActionPreference='Stop';Add-Type -Path @($env:AP_DESCRIPTOR_NATIVE,$env:AP_DESCRIPTOR_CONTROLLER) -OutputAssembly $env:AP_DESCRIPTOR_EXE -OutputType ConsoleApplication"], { SystemRoot: systemRoot, WINDIR: systemRoot, SystemDrive: systemRoot.slice(0, 2), PATH: path.join(systemRoot, 'System32'), TEMP: control, TMP: control, AP_DESCRIPTOR_NATIVE: path.join(artifacts, 'windows-appcontainer-native.cs'), AP_DESCRIPTOR_CONTROLLER: path.join(artifacts, 'controller.cs'), AP_DESCRIPTOR_EXE: controller }, 60000)
  const result = run('native-controller', controller, [childExe, sha(pe), copiedBash, sha(bashBytes), copiedDll, expectedDllHash, sharedId, control, cwdA, cwdB], { SystemRoot: systemRoot, WINDIR: systemRoot, SystemDrive: systemRoot.slice(0, 2), PATH: path.join(systemRoot, 'System32'), TEMP: control, TMP: control }, 60000, control)
  assert.equal(result.stderr, '')
  const proof = parseProof(result.stdout)
  manifest.nativeExecution = 'passed'; manifest.executableSha256 = sha(pe); manifest.systemImports = imports; manifest.proof = proof
  fs.writeFileSync(path.join(artifacts, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  fs.rmSync(work, { recursive: true, force: true })
  process.stdout.write(JSON.stringify({ status: 'passed', artifacts, objects: 16, sameProfileOpens: 16, otherProfileDenied: 16, drainedJobs: 3 }) + '\n')
}
module.exports = { parseProof, physical, bound }
if (require.main === module) { try { main(process.argv.slice(2)) } catch (error) { process.stderr.write(String(error.stack || error) + '\n'); process.exitCode = 1 } }
