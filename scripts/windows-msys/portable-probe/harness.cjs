'use strict'
// Portable diagnostic composition. Transport/observations never admit a worker.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const cp = require('node:child_process'), assert = require('node:assert/strict')
const crypto = require('node:crypto')
const slots = new WeakMap(), smokeSlots = new WeakMap()
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const exact = (value, keys) => assert.deepEqual(Object.keys(value).sort(), [...keys].sort())
const closedHash = value => { assert.match(value, /^[a-f0-9]{64}$/); return value }
const canonical = value => Buffer.from(JSON.stringify(value) + '\n')
function transport(repo) { return require(path.join(repo, 'scripts/windows-msys/portable-runtime/portable.cjs')) }
function source(repo, name) { return transport(repo).read(path.join(repo, name), 4 * 1024 * 1024) }
function copy(value) { return JSON.parse(JSON.stringify(value)) }
function validateImported(repo, entries, expected) {
  const p = transport(repo)
  exact(expected, ['authority','manifestSha256','receiptSha256'])
  const authority = p.authority(expected.authority)
  const captured = new Map()
  for (const entry of entries) {
    exact(entry, ['path','bytes']); p.relative(entry.path)
    assert.ok(Buffer.isBuffer(entry.bytes) && entry.bytes.length > 0 && entry.bytes.length <= p.MAX_FILE)
    assert.ok(!captured.has(entry.path)); captured.set(entry.path, Buffer.from(entry.bytes))
  }
  assert.deepEqual([...captured.keys()].sort(), [...Object.keys(p.MAP), 'manifest.json', 'import.json'].sort())
  assert.ok([...captured.values()].reduce((sum, value) => sum + value.length, 0) <= p.MAX_TOTAL)
  const manifestBytes = captured.get('manifest.json'), receiptBytes = captured.get('import.json')
  assert.equal(p.hash(manifestBytes), closedHash(expected.manifestSha256))
  assert.equal(p.hash(receiptBytes), closedHash(expected.receiptSha256))
  const manifest = p.parseCanonical(manifestBytes), receipt = p.parseCanonical(receiptBytes)
  exact(manifest, ['schema','kind','status','authority','architecture','files'])
  assert.equal(manifest.schema, 1); assert.equal(manifest.kind, 'msys-candidate-transport')
  assert.equal(manifest.status, 'not-native-accepted'); assert.deepEqual(p.authority(manifest.authority), authority)
  assert.deepEqual(manifest.architecture, { bash:'x64', msys:'x64', posixFixture:'x64' })
  assert.equal(manifest.files.length, Object.keys(p.MAP).length)
  const data = new Map(captured); data.delete('manifest.json'); data.delete('import.json')
  const inventory = [...data].map(([name, bytes]) => ({ path:name, length:bytes.length, sha256:hash(bytes) })).sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  assert.deepEqual(manifest.files, inventory)
  p.validate(data, authority)
  exact(receipt, ['schema','kind','status','manifestSha256','producer','consumer','files','nativeAcceptance'])
  assert.equal(receipt.schema, 1); assert.equal(receipt.kind, 'msys-candidate-import')
  assert.equal(receipt.status, 'not-native-accepted'); assert.equal(receipt.nativeAcceptance, 'not-performed')
  assert.equal(receipt.manifestSha256, expected.manifestSha256); assert.deepEqual(receipt.producer, authority.producer)
  exact(receipt.consumer, ['platform','processArchitecture'])
  assert.equal(receipt.consumer.platform, 'win32'); assert.ok(['x64','arm64'].includes(receipt.consumer.processArchitecture))
  assert.deepEqual(receipt.files, inventory)
  return { data, manifest, receipt }
}
function nodeIdentity(repo, expected) {
  exact(expected, ['architecture','executableSha256','provenanceSha256','nativeProofSha256'])
  assert.ok(['x64','arm64'].includes(expected.architecture)); assert.equal(expected.architecture, process.arch)
  for (const key of ['executableSha256','provenanceSha256','nativeProofSha256']) closedHash(expected[key])
  // These proof digests originate in the independently authenticated Node importer.
  // The current process rechecks its own executable, not candidate self-reported identity.
  const bytes = transport(repo).read(fs.realpathSync.native(process.execPath), 128 * 1024 * 1024)
  assert.equal(hash(bytes), expected.executableSha256, 'Current Node differs from verified adapted worker')
  assert.equal(bytes.readUInt16LE(0), 0x5a4d)
  const pe = bytes.readUInt32LE(60)
  assert.ok(pe >= 64 && pe + 26 <= bytes.length); assert.equal(bytes.readUInt32LE(pe), 0x4550)
  assert.equal(bytes.readUInt16LE(pe + 4), expected.architecture === 'x64' ? 0x8664 : 0xaa64)
  return Object.freeze({ ...expected, version:process.version, processArchitecture:process.arch })
}
function privateDirectory(repo, destination) {
  destination = path.resolve(destination)
  assert.equal(fs.existsSync(destination), false, 'Fresh diagnostic directory required')
  assert.equal(fs.realpathSync.native(path.dirname(destination)), path.dirname(destination))
  fs.mkdirSync(destination, { mode:0o700 })
  require(path.join(repo, 'agents/codex/workflow/safe-run-root.js')).ensureWindowsPrivateAcl(destination)
  return destination
}
function nativeArchitecture(repo, helper, parent) {
  exact(helper, ['executable','executableSha256','configSha256','systemRoot'])
  assert.match(helper.systemRoot, /^[a-z]:\\windows$/i)
  assert.equal(path.resolve(helper.systemRoot).toLowerCase(), path.resolve(process.env.SystemRoot).toLowerCase(), 'Helper and worker system root must match')
  const exe = transport(repo).read(helper.executable, 1024 * 1024)
  const config = transport(repo).read(helper.executable + '.config', 1024)
  assert.equal(hash(exe), closedHash(helper.executableSha256)); assert.equal(hash(config), closedHash(helper.configSha256))
  const directory = privateDirectory(repo, path.join(parent, 'identity-' + crypto.randomUUID()))
  const executable = path.join(directory, 'bundle-lease.exe')
  fs.writeFileSync(executable, exe, { flag:'wx' }); fs.writeFileSync(executable + '.config', config, { flag:'wx' })
  const result = cp.spawnSync(executable, ['--identity'], { shell:false, windowsHide:true, cwd:directory,
    env:{ SystemRoot:helper.systemRoot, WINDIR:helper.systemRoot, PATH:path.join(helper.systemRoot,'System32'), TEMP:directory, TMP:directory },
    encoding:'utf8', timeout:15000, maxBuffer:1024, stdio:['ignore','pipe','pipe'] })
  // Failed execution retains the private helper for diagnosis.
  assert.ifError(result.error); assert.equal(result.status, 0); assert.equal(result.signal, null); assert.equal(result.stderr, '')
  const found = /^bundle-lease-helper-v1:(x64|arm64)\r?\n$/.exec(result.stdout); assert.ok(found)
  assert.equal(found[1], process.arch, 'Node process must match native OS; emulated Node is refused')
  fs.rmSync(directory, { recursive:true, force:true, maxRetries:10, retryDelay:100 })
  return found[1]
}
async function captureImported({ repo, root, expected, node, helper, captureAdapterSha256, workParent }) {
  assert.equal(process.platform, 'win32', 'A native Windows capture cannot be simulated')
  repo = fs.realpathSync.native(path.resolve(repo)); root = fs.realpathSync.native(path.resolve(root))
  const p = transport(repo)
  expected = JSON.parse(p.canonical(expected)); node = JSON.parse(p.canonical(node)); helper = JSON.parse(p.canonical(helper))
  const authority = p.authority(expected.authority)
  const { sourceBindings } = require(path.join(repo, 'scripts/windows-msys/portable-runtime/cli.cjs'))
  assert.deepEqual(authority.bindings, sourceBindings(repo, { linkerSha256:authority.bindings.linkerSha256, bootstrapRuntimeSha256:authority.bindings.bootstrapRuntimeSha256 }), 'Consumer checkout source differs from captured candidate')
  const manifest = p.parseCanonical(p.read(path.join(root,'manifest.json')))
  assert.equal(hash(p.read(path.join(root,'manifest.json'))), expected.manifestSha256)
  const receipt = p.read(path.join(root,'import.json'))
  assert.equal(hash(receipt), expected.receiptSha256)
  // Names/lengths remain untrusted until the native capture and closed validation.
  const entries = [...manifest.files, { path:'manifest.json', length:p.canonical(manifest).length, sha256:expected.manifestSha256 },
    { path:'import.json', length:receipt.length, sha256:expected.receiptSha256 }]
  const adapterPath = 'scripts/windows-runtime/precompiled-proof/adapter.cjs'
  assert.equal(hash(source(repo, adapterPath)), closedHash(captureAdapterSha256))
  const ownedNode = nodeIdentity(repo, node)
  const osArchitecture = nativeArchitecture(repo, helper, fs.realpathSync.native(path.resolve(workParent)))
  const records = await require(path.join(repo,adapterPath)).capturePrecompiledForProof(root, entries, { ...helper })
  assert.equal(hash(source(repo, adapterPath)), captureAdapterSha256)
  const verified = validateImported(repo, records, expected)
  const capability = Object.freeze({ status:'captured-candidate-not-accepted' })
  const tuple = Object.freeze({ manifestSha256:expected.manifestSha256, receiptSha256:expected.receiptSha256,
    nodeSha256:ownedNode.executableSha256, nodeProvenanceSha256:ownedNode.provenanceSha256,
    nodeNativeProofSha256:ownedNode.nativeProofSha256, nativeArchitecture:osArchitecture,
    bashArchitecture:'x64', msysArchitecture:'x64', bashSha256:hash(verified.data.get('runtime/bash.exe')),
    msysSha256:hash(verified.data.get('runtime/msys-2.0.dll')), fixtureSha256:hash(verified.data.get('fixture/posix-proof.exe')),
    producer:copy(verified.manifest.authority.producer), sourceBindings:copy(verified.manifest.authority.bindings), accepted:false })
  slots.set(capability, { repo, root, expected:copy(expected), node:ownedNode, tuple, data:verified.data })
  return capability
}
function slot(capability) { const found = slots.get(capability); assert.ok(found, 'Authentic captured capability required'); return found }
function tupleIdentity(capability) { return Object.freeze(copy(slot(capability).tuple)) }
function smokeEnvironment(environment, bashPath) {
  const controlled = Object.fromEntries(Object.entries(environment).filter(([key]) =>
    !['AUTOPROMPT_WINDOWS_BASH','NODE_OPTIONS','NODE_PATH','NODE_TEST_CONTEXT'].includes(key.toUpperCase())))
  return controlled
}
function diagnosticContextBytes(context) {
  return require('../diagnostic-smoke/binding.cjs').canonical(context)
}
function materialize(capability, destination) {
  const value = slot(capability), { repo, data } = value
  const root = privateDirectory(repo, destination), bin = path.join(root,'usr/bin')
  fs.mkdirSync(bin, { recursive:true }); fs.mkdirSync(path.join(root,'etc'))
  fs.writeFileSync(path.join(root,'etc/fstab'), 'none /tmp usertemp binary,posix=0,noacl 0 0\n', { flag:'wx', mode:0o400 })
  for (const [packet, name] of [['runtime/bash.exe','bash.exe'],['runtime/msys-2.0.dll','msys-2.0.dll'],['fixture/posix-proof.exe','posix-proof.exe']]) {
    fs.writeFileSync(path.join(bin,name), Buffer.from(data.get(packet)), { flag:'wx', mode:0o500 })
  }
  const { bindBashRuntime, resolveWindowsBash } = require(path.join(repo,'scripts/windows-msys/diagnostic-smoke/command.cjs'))
  const expected = ['bash.exe','msys-2.0.dll'].map(name => ({ name, sha256:hash(data.get('runtime/'+name)), bytes:data.get('runtime/'+name).length }))
  const { closureRecords } = require(path.join(repo,'scripts/windows-msys/probe-built-runtime.cjs'))
  const files = bindBashRuntime(bin, process.env.SystemRoot)
  assert.deepEqual(closureRecords(files), expected)
  const context = {schema:1,purpose:'compiler-output-smoke-not-runtime-acceptance',node:{architecture:value.node.architecture,sha256:value.node.executableSha256,kind:'adapted-worker'},bash:{path:path.join(bin,'bash.exe'),files:expected}}
  const selected = resolveWindowsBash({ diagnosticTuple:context })
  assert.equal(selected.bash.path.toLowerCase(), path.join(bin,'bash.exe').toLowerCase())
  assert.deepEqual(closureRecords(selected.files), expected)
  return Object.freeze({ root, bin, bash:path.join(bin,'bash.exe'), fixture:path.join(bin,'posix-proof.exe'), tuple:tupleIdentity(capability) })
}
function runSmoke(capability, outputRoot) {
  const value = slot(capability), { repo, data } = value
  nodeIdentity(repo, { architecture:value.node.architecture, executableSha256:value.node.executableSha256,
    provenanceSha256:value.node.provenanceSha256, nativeProofSha256:value.node.nativeProofSha256 })
  const output = privateDirectory(repo, outputRoot)
  const runtime = materialize(capability, path.join(output,'runtime'))
  const testFile = 'scripts/windows-msys/diagnostic-smoke/native.cjs'
  const testPaths = [testFile,'scripts/windows-msys/diagnostic-smoke/binding.cjs','scripts/windows-msys/diagnostic-smoke/command.cjs','scripts/windows-msys/diagnostic-smoke/probe.cjs','tests/helpers/windows-bash-native-smoke.cjs','tests/fixtures/windows-msys/bash-ipc.sh']
  const testSources = Object.fromEntries(testPaths.map(name=>[name,hash(source(repo,name))]))
  const testSha256 = hash(canonical(testSources))
  const { TEST_NAME, selectedTestPassed, closureRecords } = require(path.join(repo,'scripts/windows-msys/probe-built-runtime.cjs'))
  const environment = smokeEnvironment(process.env, runtime.bash)
  const context={schema:1,purpose:'compiler-output-smoke-not-runtime-acceptance',node:{architecture:value.node.architecture,sha256:value.node.executableSha256,kind:'adapted-worker'},bash:{path:runtime.bash,files:['bash.exe','msys-2.0.dll'].map(name=>({name,sha256:hash(data.get('runtime/'+name)),bytes:data.get('runtime/'+name).length}))}}
  const contextBytes=diagnosticContextBytes(context),contextPath=path.join(output,'diagnostic-context.json')
  fs.writeFileSync(contextPath,contextBytes,{flag:'wx',mode:0o400})
  const result = cp.spawnSync(process.execPath, ['--test-reporter=tap',path.join(repo,testFile),contextPath,hash(contextBytes)],
    { cwd:repo, env:environment, encoding:'utf8', timeout:615000, maxBuffer:8*1024*1024, shell:false, windowsHide:true, stdio:['ignore','pipe','pipe'] })
  const transcripts = {}
  for (const stream of ['stdout','stderr']) {
    const bytes = Buffer.from(result[stream] || '')
    transcripts[stream] = { observedBytes:bytes.length, retainedBytes:Math.min(bytes.length,8*1024*1024), truncated:bytes.length>8*1024*1024 }
    fs.writeFileSync(path.join(output,stream+'.txt'), bytes.subarray(0,8*1024*1024), { flag:'wx' })
  }
  fs.writeFileSync(path.join(output,'transcripts.json'),canonical(transcripts),{flag:'wx'})
  assert.ok(!transcripts.stdout.truncated && !transcripts.stderr.truncated,'Native smoke transcript exceeded bound')
  assert.ifError(result.error); assert.equal(result.signal,null); assert.equal(result.status,0,'Actual copied-closure Bash isolation test failed')
  selectedTestPassed(result.stdout)
  assert.deepEqual(Object.fromEntries(testPaths.map(name=>[name,hash(source(repo,name))])),testSources)
  const { bindBashRuntime } = require(path.join(repo,'scripts/windows-msys/diagnostic-smoke/command.cjs'))
  assert.deepEqual(closureRecords(bindBashRuntime(runtime.bin,process.env.SystemRoot)), ['bash.exe','msys-2.0.dll'].map(name=>({name,sha256:hash(data.get('runtime/'+name)),bytes:data.get('runtime/'+name).length})))
  const record = { schema:1, status:'consumer-native-bash-smoke-passed-not-accepted', tuple:value.tuple,
    testName:TEST_NAME, testSha256, testSources, stdoutSha256:hash(Buffer.from(result.stdout)), stderrSha256:hash(Buffer.from(result.stderr)),
    nativeTestAssertions:'exact-existing-test-including-probe-and-owned-tool-completion', accepted:false }
  fs.writeFileSync(path.join(output,'portable-bash-smoke.json'),canonical(record),{flag:'wx'})
  const smoke = Object.freeze({status:record.status})
  smokeSlots.set(smoke,{candidate:capability,record,output,runtime})
  return smoke
}
function inputsAfterSmoke(capability, smoke) {
  const value=slot(capability), completed=smokeSlots.get(smoke)
  assert.ok(completed && completed.candidate===capability,'Exact consumer-native smoke capability required')
  return { repo:value.repo, tuple:tupleIdentity(capability), smoke:copy(completed.record),
    original:['bash.exe','msys-2.0.dll'].map(name=>({name,bytes:Buffer.from(value.data.get('runtime/'+name)),sha256:hash(value.data.get('runtime/'+name))})),
    fixture:Buffer.from(value.data.get('fixture/posix-proof.exe')), fixtureSource:Buffer.from(value.data.get('fixture/posix-proof.c')) }
}
module.exports={validateImported,captureImported,tupleIdentity,materialize,runSmoke,inputsAfterSmoke,smokeEnvironment,diagnosticContextBytes}
