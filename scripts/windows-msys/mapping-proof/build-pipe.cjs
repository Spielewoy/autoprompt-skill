'use strict'
// Standalone diagnostic compiler only; never launches an AppContainer or selects a runtime.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto'), assert = require('node:assert/strict')
const { physical, bound } = require('../descriptor-proof/run.cjs')
// Diagnostic process output is observed by the mapping controller.
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
function pe(bytes, arch) {
  assert.ok(bytes.length >= 90 && bytes.readUInt16LE(0) === 0x5a4d)
  const at = bytes.readUInt32LE(60); assert.ok(at >= 64 && at + 26 <= bytes.length); assert.equal(bytes.readUInt32LE(at), 0x4550)
  assert.equal(bytes.readUInt16LE(at + 4), arch === 'arm64' ? 0xaa64 : 0x8664)
  const optional = bytes.readUInt16LE(at + 20), flags = bytes.readUInt16LE(at + 22)
  assert.ok(optional >= 112 && at + 24 + optional <= bytes.length); assert.equal(bytes.readUInt16LE(at + 24), 0x20b)
  assert.ok(flags & 2); assert.equal(flags & 0x2000, 0)
}
function main(args) {
  assert.equal(process.platform, 'win32', 'Actual Windows compiler required')
  assert.equal(args.length, 4, 'Usage: node build.cjs REPO TOOLCHAIN_JSON EXPECTED_TOOLCHAIN_SHA256 NEW_OUTPUT')
  const [repoArg, toolchainArg, expectedToolchain, outputArg] = args
  assert.match(expectedToolchain, /^[0-9a-f]{64}$/)
  const repo = physical(path.resolve(repoArg), true), toolchainFile = physical(path.resolve(toolchainArg))
  const toolchainBytes = bound(toolchainFile, 1048576); assert.equal(sha(toolchainBytes), expectedToolchain)
  const toolchain = JSON.parse(toolchainBytes)
  assert.deepEqual(Object.keys(toolchain).sort(), ['cl', 'link', 'include', 'lib', 'sdkVersion', 'arch'].sort())
  assert.equal(toolchain.arch, process.arch); assert.ok(['x64', 'arm64'].includes(toolchain.arch)); assert.match(toolchain.sdkVersion, /^10\.0\.[0-9]+\.0$/)
  const compiler = physical(toolchain.cl), linker = physical(toolchain.link)
  assert.equal(path.basename(compiler).toLowerCase(), 'cl.exe'); assert.equal(path.basename(linker).toLowerCase(), 'link.exe')
  for (const list of [toolchain.include, toolchain.lib]) { assert.ok(Array.isArray(list) && list.length > 0 && list.length <= 16); for (const item of list) physical(item, true) }
  const sourceFile = path.join(__dirname, 'source', 'pipe-write-probe.cpp'), source = bound(sourceFile, 1048576)
  const sourceHash = sha(source), builderHash = sha(bound(__filename, 1048576)), compilerHash = sha(bound(compiler)), linkerHash = sha(bound(linker))
  const output = path.resolve(outputArg); assert.equal(fs.existsSync(output), false); physical(path.dirname(output), true)
  fs.mkdirSync(output); require(path.join(repo, 'agents/codex/workflow/safe-run-root.js')).ensureWindowsPrivateAcl(output)
  const systemRoot = physical(process.env.SystemRoot, true)
  const env = { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: [...new Set([path.dirname(compiler), path.dirname(linker), path.join(systemRoot, 'System32')])].join(';'), INCLUDE: toolchain.include.join(';'), LIB: toolchain.lib.join(';'), TEMP: output, TMP: output }
  const copiedSource = path.join(output, 'pipe-write-probe.cpp'), object = path.join(output, 'pipe-write-probe.obj'), executable = path.join(output, 'pipe-write-probe.exe')
  fs.writeFileSync(copiedSource, source, { flag: 'wx' }); fs.writeFileSync(path.join(output, 'toolchain.json'), toolchainBytes, { flag: 'wx' })
  const commands = [], deadline = Date.now() + 240000
  function run(label, file, argv, maximum = 100000) {
    const timeout = Math.min(maximum, deadline - Date.now()); assert.ok(timeout > 0, 'Overall four-minute diagnostic build deadline')
    const result = cp.spawnSync(file, argv, { env, cwd: output, encoding: 'utf8', timeout, maxBuffer: 4 * 1048576, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    for (const stream of ['stdout', 'stderr']) fs.writeFileSync(path.join(output, label + '.' + stream + '.txt'), result[stream] || '', { flag: 'wx' })
    commands.push({ label, executable: file, argv, status: result.status, signal: result.signal, error: result.error?.code || null })
    fs.writeFileSync(path.join(output, 'commands.json'), JSON.stringify(commands, null, 2) + '\n')
    assert.ifError(result.error); assert.equal(result.status, 0, (result.stderr || result.stdout).slice(-16384)); return result
  }
  run('compile', compiler, ['/nologo', '/Bv', '/showIncludes', '/MT', '/EHsc', '/std:c++17', '/W4', '/D_WIN32_WINNT=0x0602', '/DWINVER=0x0602', '/DUNICODE', '/D_UNICODE', '/DNOMINMAX', '/c', copiedSource, '/Fo' + object])
  run('link', linker, ['/NOLOGO', '/INCREMENTAL:NO', '/SUBSYSTEM:CONSOLE', '/ENTRY:mainCRTStartup', '/MACHINE:' + toolchain.arch.toUpperCase(), '/OUT:' + executable, object, 'kernel32.lib'])
  const bytes = bound(executable, 16 * 1048576); pe(bytes, toolchain.arch)
  const { importedDlls } = require(path.join(repo, 'agents/codex/workflow/windows-appcontainer-command.js'))
  const imports = importedDlls(bytes)
  for (const dll of imports) assert.ok(/^(?:api-ms-win-|ext-ms-win-)/i.test(dll) || ['kernel32.dll'].includes(dll.toLowerCase()), 'Unexpected diagnostic dependency: ' + dll)
  const hostWitness = path.join(output, 'host-witness.txt'), host = run('host', executable, [hostWitness], 15000)
  assert.equal(host.stderr, ''); assert.equal(host.stdout, 'child'); const witness = bound(hostWitness, 4096).toString('ascii')
  assert.match(witness, /^probe_version=1\n/); assert.match(witness, /^ntwrite_final_status=0x00000000$/m); assert.match(witness, /^ntwrite_final_information=0x5$/m); assert.ok(witness.endsWith('complete=end\n'))
  for (const [file, digest] of [[sourceFile, sourceHash], [copiedSource, sourceHash], [__filename, builderHash], [toolchainFile, expectedToolchain], [compiler, compilerHash], [linker, linkerHash], [executable, sha(bytes)]]) assert.equal(sha(bound(file)), digest)
  const manifest = { schemaVersion: 1, purpose: 'native pipe-write observation; not sandbox or runtime acceptance', architecture: toolchain.arch, sourceSha256: sourceHash, buildScriptSha256: builderHash, toolchainSha256: expectedToolchain, compilerSha256: compilerHash, linkerSha256: linkerHash, executableSha256: sha(bytes), executable, systemImports: imports, hostWitnessSha256: sha(Buffer.from(witness, 'ascii')) }
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
  process.stdout.write(JSON.stringify({ executable, executableSha256: manifest.executableSha256, manifest: path.join(output, 'manifest.json') }) + '\n')
  return manifest
}
module.exports = { pe, main }
if (require.main === module) { try { main(process.argv.slice(2)) } catch (error) { process.stderr.write((error.stack || error) + '\n'); process.exitCode = 1 } }
