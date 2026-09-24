'use strict'

const assert = require('node:assert/strict')
const cp = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const { createRequire } = require('node:module')

const ROOT = path.resolve(__dirname, '../..')
const HELPER_SOURCE = path.join(ROOT, 'agents/codex/workflow/darwin-coalition-helper.c')
const ADAPTER_SOURCE = path.join(ROOT, 'agents/codex/workflow/darwin-launchd-process.js')
const LOADER = require('../../agents/codex/workflow/darwin-coalition-loader.js')
const { createPlatformProcessAdapter, ProcessOwner } = require('../../agents/codex/workflow/process-owner.js')
const { buildDarwinGrokProfile } = require('../../scripts/harness-v2-bridge/grok/darwin-profile.cjs')
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const reservePort = () => new Promise((resolve, reject) => {
  const server = net.createServer()
  server.once('error', reject)
  server.listen({ host: '::1', port: 0, ipv6Only: true }, () => {
    const port = server.address().port
    server.close(error => error ? reject(error) : resolve(port))
  })
})
const reserveDistinctPorts = () => new Promise((resolve, reject) => {
  const first = net.createServer(), second = net.createServer()
  const closeAll = callback => first.close(() => second.close(callback))
  first.once('error', reject)
  second.once('error', reject)
  first.listen({ host: '::1', port: 0, ipv6Only: true }, () => {
    const firstPort = first.address().port
    second.listen({ host: '::1', port: 0, ipv6Only: true }, () => {
      const secondPort = second.address().port
      closeAll(error => error ? reject(error) : resolve([firstPort, secondPort]))
    })
  })
})
const assertIPv6PortHeld = port => new Promise((resolve, reject) => {
  const server = net.createServer()
  server.once('error', error => {
    if (error?.code === 'EADDRINUSE') resolve()
    else reject(error)
  })
  server.listen({ host: '::1', port, ipv6Only: true }, () => {
    server.close(() => reject(new Error(`listener port ${port} unexpectedly rebound while launchd service remained live`)))
  })
})
const assertIPv6PortReleased = port => new Promise((resolve, reject) => {
  const server = net.createServer()
  server.once('error', reject)
  server.listen({ host: '::1', port, ipv6Only: true }, () => server.close(error => error ? reject(error) : resolve()))
})
const connectEcho = (port, value) => new Promise((resolve, reject) => {
  const socket = net.createConnection({ host: '::1', port, family: 6 })
  let received = ''
  socket.setTimeout(10000, () => socket.destroy(new Error('listener echo timed out')))
  socket.once('error', reject)
  socket.on('data', bytes => { received += bytes.toString('utf8') })
  socket.once('connect', () => socket.end(value))
  socket.once('close', hadError => hadError ? undefined : resolve(received))
})

function command(executable, argv, options = {}) {
  return cp.spawnSync(executable, argv, {
    shell: false,
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  })
}

function requireSuccess(result, description) {
  assert.equal(result.error, undefined, `${description}: ${result.error?.message}`)
  assert.equal(result.signal, null, `${description}: signal ${result.signal}`)
  assert.equal(result.status, 0, `${description}: ${result.stderr || result.stdout}`)
  return result
}

function helperJson(helper, argv) {
  const result = requireSuccess(command(helper, argv), `helper ${argv.join(' ')}`)
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean)
  assert.equal(lines.length, 1)
  const value = JSON.parse(lines[0])
  assert.equal(value.schemaVersion, 1)
  assert.equal(value.ok, true)
  return value
}

function alive(pid) {
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
}

async function waitFor(predicate, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs
  let value
  while (Date.now() < deadline) {
    value = await predicate()
    if (value) return value
    await sleep(50)
  }
  assert.fail(`${description}; last=${JSON.stringify(value)}`)
}

function writeEvidence(value) {
  const output = process.env.AUTOPROMPT_DARWIN_PROCESS_EVIDENCE
  if (output) fs.writeFileSync(output, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

function preserveTestedHelper(helper, evidence) {
  const output = process.env.AUTOPROMPT_DARWIN_PROCESS_EVIDENCE
  if (!output) return
  const artifact = path.join(path.dirname(output), 'darwin-coalition-helper')
  if (fs.existsSync(artifact)) {
    assert.equal(sha256(fs.readFileSync(artifact)), sha256(fs.readFileSync(helper)))
  } else {
    fs.copyFileSync(helper, artifact, fs.constants.COPYFILE_EXCL)
  }
  fs.chmodSync(artifact, 0o500)
  evidence.helperArtifact = {
    file: path.basename(artifact),
    sha256: sha256(fs.readFileSync(artifact)),
    sourceSha256: sha256(fs.readFileSync(HELPER_SOURCE)),
    architecture: process.arch,
  }
}

test('Darwin coalition production sources retain exact-token and atomic-usage boundaries', () => {
  const helper = fs.readFileSync(HELPER_SOURCE, 'utf8')
  const adapter = fs.readFileSync(ADAPTER_SOURCE, 'utf8')
  assert.match(helper, /bind_process\(pids\[index\], &bound/)
  assert.match(helper, /signal_function\(&bound\.token, signal_number\)/)
  assert.match(helper, /coalition_info_resource_usage/)
  assert.match(helper, /struct ap_coalition_usage_prefix/)
  assert.doesNotMatch(adapter, /process\.kill\s*\(/)
  assert.match(adapter, /remaining\.status === reference\.status/)
  assert.match(adapter, /launchd-absent-without-published-identity/)
})

test('Darwin missing-service proof rejects arbitrary failures and mismatched live domains', () => {
  const { sameMissingServiceResponse } = require('../../agents/codex/workflow/darwin-launchd-process.js')
  const missing = name => ({ status: 113, stdout: '', stderr: `Bad request.\nCould not find service "${name}" in domain for user gui: 501\n`, error: undefined, signal: null })
  const reference = missing('never-created'), actual = missing('owned')
  assert.equal(sameMissingServiceResponse(actual, 'owned', reference, 'never-created'), true)
  for (const changed of [
    { ...actual, status: 0 }, { ...actual, status: 3 }, { ...actual, signal: 'SIGTERM' },
    { ...actual, error: new Error('timeout') }, { ...actual, stdout: 'still running' },
    { ...actual, stderr: 'Operation not permitted' },
    { ...actual, stderr: actual.stderr.replace('501', '502') }, missing('other-owner'),
  ]) assert.equal(sameMissingServiceResponse(changed, 'owned', reference, 'never-created'), false)
  assert.equal(sameMissingServiceResponse(actual, 'owned', { ...reference, stderr: 'domain unavailable' }, 'never-created'), false)
})

test('Darwin launchd absence polling waits for the exact owned service to leave a live domain', () => {
  const { waitForAbsentService } = require('../../agents/codex/workflow/darwin-launchd-process.js')
  const request = { domain: 'gui/501', label: 'com.autoprompt.owned.fixture' }
  const missing = name => ({ status: 113, stdout: '', stderr: `Bad request.\nCould not find service "${name}" in domain for user gui: 501\n`, error: undefined, signal: null })
  let ownedPrints = 0, clock = 0, pauses = 0
  const launchctl = argv => {
    const target = argv[1]
    if (target === request.domain) return { status: 0, stdout: 'live domain', stderr: '', error: undefined, signal: null }
    const label = target.slice(request.domain.length + 1)
    if (label !== request.label) return missing(label)
    ownedPrints++
    return ownedPrints === 1
      ? { status: 0, stdout: 'still registered', stderr: '', error: undefined, signal: null }
      : missing(label)
  }
  const observed = waitForAbsentService(request, launchctl, {
    timeoutMs: 100, pollMs: 10, now: () => clock,
    pause(milliseconds) { pauses++; clock += milliseconds },
  })
  assert.equal(observed.absent, true)
  assert.equal(ownedPrints, 2)
  assert.equal(pauses, 1)

  const denied = waitForAbsentService(request, () => ({ status: 1, stdout: '', stderr: 'Operation not permitted', error: undefined, signal: null }), {
    timeoutMs: 0, pollMs: 10, now: () => 0, pause() { assert.fail('zero-bound proof must not pause') },
  })
  assert.equal(denied.absent, false)
  assert.equal(denied.diagnostic.phase, 'domain')
  assert.equal(denied.diagnostic.domain.stderr, 'Operation not permitted')
})

test('Darwin launchd plist uses the explicitly bound controller Node executable', () => {
  const { launchPlist } = require('../../agents/codex/workflow/darwin-launchd-process.js')
  const node = '/private/controller/node<&'
  const plist = launchPlist('com.autoprompt.fixture', '/private/control/request.json', node)
  assert.ok(plist.includes(`<string>${node.replace('&', '&amp;').replace('<', '&lt;')}</string>`))
  assert.equal(plist.includes(`<string>${process.execPath}</string>`), node === process.execPath)
})

test('Darwin retained listener descriptor requires the exact FD3 and FD4 IPv6 pair', () => {
  const { validateDarwinListeners } = require('../../agents/codex/workflow/darwin-launchd-process.js')
  const descriptor = { proxy: { fd: 3, host: '::1', port: 19777 }, mcp: { fd: 4, host: '::1', port: 19778 } }
  const validated = validateDarwinListeners(descriptor)
  assert.deepEqual(validated, descriptor)
  assert.equal(Object.isFrozen(validated), true)
  assert.equal(Object.isFrozen(validated.proxy), true)
  for (const changed of [
    { proxy: descriptor.proxy },
    { ...descriptor, extra: true },
    { ...descriptor, proxy: { ...descriptor.proxy, fd: 4 } },
    { ...descriptor, mcp: { ...descriptor.mcp, host: '127.0.0.1' } },
    { ...descriptor, mcp: { ...descriptor.mcp, port: descriptor.proxy.port } },
    { ...descriptor, proxy: { ...descriptor.proxy, extra: true } },
  ]) assert.throws(() => validateDarwinListeners(changed), { code: 'LAUNCH_SPEC_INVALID' })
})

test('production Darwin listener supervisor publishes generation authority before socket activation', () => {
  const source = fs.readFileSync(path.join(ROOT, 'agents/codex/workflow/darwin-launchd-listener-supervisor.c'), 'utf8')
  assert.match(source, /publish_generation\(argv\[8\], argv\[7\]\)/)
  assert.ok(source.indexOf('publish_generation(argv[8], argv[7])') < source.indexOf('acquire(MODEL_SOCKET'))
  assert.match(source, /dup2\(model_copy, 3\)/)
  assert.match(source, /dup2\(mcp_copy, 4\)/)
  assert.match(source, /POSIX_SPAWN_CLOEXEC_DEFAULT/)
  assert.doesNotMatch(source, /closed-fd|forbidden/)
})

test('Darwin generation inventory rejects permissive records and linked directory replacement', { skip: process.platform === 'win32' }, t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ap-darwin-generation-reader-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.chmodSync(root, 0o700)
  const generationDirectory = path.join(root, 'generations'), foreignDirectory = path.join(root, 'foreign')
  fs.mkdirSync(generationDirectory, { mode: 0o700 }); fs.mkdirSync(foreignDirectory, { mode: 0o700 })
  const requestSha256 = 'a'.repeat(64), record = { schemaVersion: 1, requestSha256, pid: 41,
    uid: process.getuid(), pidVersion: 7, resourceCoalitionId: '91' }
  const recordPath = path.join(generationDirectory, 'generation-41-7.json')
  fs.writeFileSync(recordPath, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 })
  const module = { exports: {} }, localRequire = createRequire(ADAPTER_SOURCE)
  vm.runInNewContext(`${fs.readFileSync(ADAPTER_SOURCE, 'utf8')}\nmodule.exports.readGenerationRecordsForTest=readGenerationRecords`, {
    module, exports: module.exports, require: localRequire, __filename: ADAPTER_SOURCE, __dirname: path.dirname(ADAPTER_SOURCE),
    process, Buffer, setTimeout, clearTimeout, SharedArrayBuffer, Atomics,
  }, { filename: ADAPTER_SOURCE })
  const read = module.exports.readGenerationRecordsForTest
  assert.equal(read(generationDirectory, requestSha256, process.getuid()).length, 1)
  fs.chmodSync(recordPath, 0o644)
  assert.throws(() => read(generationDirectory, requestSha256, process.getuid()), { code: 'PROCESS_IDENTITY_INVALID' })
  fs.chmodSync(recordPath, 0o600)
  let recordStats = 0
  const replacingRecordFs = { ...fs, lstatSync(pathname, ...args) {
    if (pathname === recordPath && ++recordStats === 2) {
      const bytes = fs.readFileSync(recordPath), held = `${recordPath}.held`
      fs.renameSync(recordPath, held)
      fs.writeFileSync(recordPath, bytes, { flag: 'wx', mode: 0o600 })
    }
    return fs.lstatSync(pathname, ...args)
  } }
  const recordModule = { exports: {} }
  vm.runInNewContext(`${fs.readFileSync(ADAPTER_SOURCE, 'utf8')}\nmodule.exports.readGenerationRecordsForTest=readGenerationRecords`, {
    module: recordModule, exports: recordModule.exports,
    require: name => name === 'node:fs' ? replacingRecordFs : localRequire(name),
    __filename: ADAPTER_SOURCE, __dirname: path.dirname(ADAPTER_SOURCE), process, Buffer, setTimeout, clearTimeout, SharedArrayBuffer, Atomics,
  }, { filename: ADAPTER_SOURCE })
  assert.throws(() => recordModule.exports.readGenerationRecordsForTest(generationDirectory, requestSha256, process.getuid()), { code: 'PROCESS_IDENTITY_CHANGED' })
  fs.unlinkSync(recordPath)
  fs.renameSync(`${recordPath}.held`, recordPath)
  fs.renameSync(generationDirectory, path.join(root, 'held-generations'))
  fs.symlinkSync(foreignDirectory, generationDirectory, 'dir')
  assert.throws(() => read(generationDirectory, requestSha256, process.getuid()), { code: 'PROCESS_IDENTITY_INVALID' })
  fs.unlinkSync(generationDirectory)
  fs.renameSync(path.join(root, 'held-generations'), generationDirectory)
  let directoryStats = 0
  const replacingFs = { ...fs, lstatSync(pathname, ...args) {
    if (pathname === generationDirectory && ++directoryStats === 2) {
      fs.renameSync(generationDirectory, path.join(root, 'replaced-generations'))
      fs.mkdirSync(generationDirectory, { mode: 0o700 })
    }
    return fs.lstatSync(pathname, ...args)
  } }
  const replacedModule = { exports: {} }
  vm.runInNewContext(`${fs.readFileSync(ADAPTER_SOURCE, 'utf8')}\nmodule.exports.readGenerationRecordsForTest=readGenerationRecords`, {
    module: replacedModule, exports: replacedModule.exports,
    require: name => name === 'node:fs' ? replacingFs : localRequire(name),
    __filename: ADAPTER_SOURCE, __dirname: path.dirname(ADAPTER_SOURCE), process, Buffer, setTimeout, clearTimeout, SharedArrayBuffer, Atomics,
  }, { filename: ADAPTER_SOURCE })
  assert.throws(() => replacedModule.exports.readGenerationRecordsForTest(generationDirectory, requestSha256, process.getuid()), { code: 'PROCESS_IDENTITY_CHANGED' })
})

test('Darwin adapter hands retained listeners through FD3 and FD4 and drains the final generation inventory', {
  skip: process.platform !== 'darwin' && 'requires native macOS',
  timeout: 120000,
}, async t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join('/private/tmp', 'ap-darwin-listener-adapter-')))
  fs.chmodSync(root, 0o700)
  const controlRoot = path.join(root, 'control'), supervisor = path.join(root, 'listener-supervisor')
  const script = path.join(root, 'listener-child.cjs'), observed = path.join(root, 'observed.json')
  const compiler = requireSuccess(command('/usr/bin/xcrun', ['--find', 'clang']), 'locate clang').stdout.trim()
  const sdk = requireSuccess(command('/usr/bin/xcrun', ['--show-sdk-path']), 'read SDK path').stdout.trim()
  requireSuccess(command(compiler, ['-isysroot', sdk, '-mmacosx-version-min=13.5', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2',
    path.join(ROOT, 'agents/codex/workflow/darwin-launchd-listener-supervisor.c'), '-o', supervisor]), 'compile listener supervisor')
  const node = fs.realpathSync.native(process.execPath)
  fs.writeFileSync(script, String.raw`'use strict'
const fs=require('node:fs'),net=require('node:net')
const values=[]
Promise.all([[3,'proxy'],[4,'mcp']].map(([fd,name])=>new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen({fd,exclusive:true},()=>{const address=server.address();values.push({name,address});resolve(server)})}))).then(servers=>{
  fs.writeFileSync(process.argv[2],JSON.stringify(values),{flag:'wx',mode:0o600})
  setTimeout(()=>Promise.all(servers.map(server=>new Promise(resolve=>server.close(resolve)))).then(()=>process.exit(0)),100)
}).catch(error=>{console.error(error.stack||error);process.exit(70)})
`, { mode: 0o600 })
  const helper = LOADER.loadDarwinCoalitionHelper()
  const { createDarwinCoalitionAdapter } = require('../../agents/codex/workflow/darwin-launchd-process.js')
  const adapter = createDarwinCoalitionAdapter({ controlRoot, providerPrivateOwnershipRoot: root, helper,
    listenerSupervisor: { path: supervisor, sha256: sha256(fs.readFileSync(supervisor)) } })
  const reservationId = `listener-${crypto.randomUUID()}`
  const record = { reservationId, reservationIdentity: adapter.reservationIdentity(reservationId),
    startupDeadlineAt: new Date(Date.now() + 60000).toISOString(), targetKey: 'darwin-listener-adapter' }
  record.reservationBinding = adapter.prepareReservation(record)
  const [proxyPort, mcpPort] = await reserveDistinctPorts()
  const listeners = { proxy: { fd: 3, host: '::1', port: proxyPort }, mcp: { fd: 4, host: '::1', port: mcpPort } }
  let owned = null, drained = false, spawnAttempted = false
  t.after(async () => {
    if (owned && !drained) {
      try {
        await adapter.signalOwned(owned.groupIdentity, 'KILL')
        await waitFor(async () => (await adapter.listOwned(owned.groupIdentity)).length === 0, 30000,
          'fixture cleanup did not drain its exact retained listener service')
        drained = true
      } catch {
        // An uncertain listener service retains the full authenticated control
        // tree for recovery; root PID death alone is not cleanup authority.
      }
    }
    if (drained || !spawnAttempted) fs.rmSync(root, { recursive: true, force: true })
    else t.diagnostic?.('retained listener fixture root because spawn ownership was uncertain')
  })
  spawnAttempted = true
  owned = await adapter.spawnOwned({ ...record, executable: node, argv: [script, observed], cwd: root,
    env: { AUTOPROMPT_OWNERSHIP_RESERVATION: reservationId, AUTOPROMPT_GROK_PROXY_LISTENER_FD: '3',
      AUTOPROMPT_GROK_MCP_LISTENER_FD: '4', AUTOPROMPT_GROK_PROXY_PORT: String(proxyPort), AUTOPROMPT_GROK_MCP_PORT: String(mcpPort) },
    shell: false, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', darwinListeners: listeners })
  const addresses = await waitFor(() => fs.existsSync(observed) && JSON.parse(fs.readFileSync(observed, 'utf8')), 30000,
    'listener child did not publish inherited endpoints')
  assert.deepEqual(addresses.map(value => [value.name, value.address.address, value.address.family, value.address.port]).sort(), [
    ['mcp', '::1', 'IPv6', mcpPort], ['proxy', '::1', 'IPv6', proxyPort],
  ])
  const reservationDirectory = path.join(controlRoot, sha256(reservationId))
  const request = JSON.parse(fs.readFileSync(path.join(reservationDirectory, 'request.json'), 'utf8'))
  await waitFor(() => fs.existsSync(path.join(reservationDirectory, 'exit.json')), 30000,
    'C supervisor did not reap the completed Node job')
  const liveService = command('/bin/launchctl', ['print', `${request.domain}/${request.label}`])
  assert.equal(liveService.status, 0, liveService.stderr)
  await assertIPv6PortHeld(proxyPort)
  await assertIPv6PortHeld(mcpPort)
  await waitFor(async () => (await adapter.listOwned(owned.groupIdentity)).length === 0, 30000,
    'authenticated child exit did not boot out and drain listener generations')
  drained = true
  const absentService = command('/bin/launchctl', ['print', `${request.domain}/${request.label}`])
  assert.equal(absentService.status, 113, absentService.stderr)
  await assertIPv6PortReleased(proxyPort)
  await assertIPv6PortReleased(mcpPort)
  assert.deepEqual(request.listeners, listeners)
  assert.equal(request.listenerSupervisor.sha256, sha256(fs.readFileSync(supervisor)))
  const generations = fs.readdirSync(path.join(reservationDirectory, 'generations')).filter(name => name.startsWith('generation-'))
  assert.ok(generations.length >= 1)
})

test('Darwin Grok Seatbelt profile adopts only the retained IPv6 FD3/FD4 listeners', {
  skip: process.platform !== 'darwin' && 'requires native macOS',
  timeout: 120000,
}, async t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join('/private/tmp', 'ap-darwin-grok-profile-')))
  fs.chmodSync(root, 0o700)
  const home = path.join(root, 'home'), cwd = path.join(root, 'cwd'), scratch = path.join(root, 'scratch')
  const controlRoot = path.join(root, 'control'), supervisor = path.join(root, 'listener-supervisor')
  for (const directory of [home, cwd, scratch, controlRoot]) fs.mkdirSync(directory, { mode: 0o700 })
  const script = path.join(cwd, 'listener-child.cjs'), observed = path.join(home, 'observed.json')
  const secret = path.join(root, 'controller-secret'), profilePath = path.join(home, 'grok.sb'), errorPath = path.join(home, 'child-error.json')
  fs.writeFileSync(secret, 'controller-only-secret', { mode: 0o600 })
  const compiler = requireSuccess(command('/usr/bin/xcrun', ['--find', 'clang']), 'locate clang').stdout.trim()
  const sdk = requireSuccess(command('/usr/bin/xcrun', ['--show-sdk-path']), 'read SDK path').stdout.trim()
  requireSuccess(command(compiler, ['-isysroot', sdk, '-mmacosx-version-min=13.5', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2',
    path.join(ROOT, 'agents/codex/workflow/darwin-launchd-listener-supervisor.c'), '-o', supervisor]), 'compile listener supervisor')
  const node = fs.realpathSync.native(process.execPath)
  const [proxyPort, mcpPort] = await reserveDistinctPorts()
  const listeners = { proxy: { fd: 3, host: '::1', port: proxyPort }, mcp: { fd: 4, host: '::1', port: mcpPort } }
  fs.writeFileSync(profilePath, buildDarwinGrokProfile({ nodeExecutable: node, grokExecutable: '/usr/bin/true', home, cwd, scratch, proxyPort, mcpPort }), { mode: 0o600 })
  // Report profile/parser and Node startup errors directly; the owned job's
  // ignored stdio cannot expose a failure that happens before the child runs.
  const preflight = requireSuccess(command('/usr/bin/sandbox-exec', ['-f', profilePath, node, '-e', 'process.stdout.write("profile-ready")'], { cwd, env: {} }), 'validate Grok Seatbelt profile and Node startup')
  assert.equal(preflight.stdout, 'profile-ready')
  fs.writeFileSync(script, String.raw`'use strict'
const fs=require('node:fs'),net=require('node:net')
const observed=process.argv[2], secret=process.argv[3], errorPath=process.argv[4]
const fail=error=>{try{fs.writeFileSync(errorPath,JSON.stringify({code:String(error&&error.code||'ERROR').slice(0,64),message:String(error&&error.message||error).replace(/[\r\n]+/g,' ').slice(0,256)}),{flag:'wx',mode:0o600})}catch{};process.exit(70)}
let secretCode='READABLE'
try{
 try{fs.readFileSync(secret)}catch(error){secretCode=String(error.code||'ERROR')}
 if(!['EACCES','EPERM'].includes(secretCode))throw Object.assign(new Error('controller secret was not denied'),{code:secretCode})
 const values=[],servers=[];let completed=0
 for(const [fd,name] of [[3,'proxy'],[4,'mcp']]){
  const server=net.createServer(socket=>{let text='';socket.on('error',fail);socket.on('data',b=>text+=b);socket.on('end',()=>{socket.end(name+':'+text);if(++completed===2)Promise.all(servers.map(s=>new Promise(resolve=>s.close(resolve)))).catch(fail)})})
  server.once('error',fail)
  server.listen({fd,exclusive:true},()=>{try{const address=server.address();values.push({name,address});servers.push(server);if(values.length===2)fs.writeFileSync(observed,JSON.stringify({values,secretCode,ready:true}),{flag:'wx',mode:0o600})}catch(error){fail(error)}})
 }
}catch(error){fail(error)}
`, { mode: 0o600 })
  const helper = LOADER.loadDarwinCoalitionHelper()
  const { createDarwinCoalitionAdapter } = require('../../agents/codex/workflow/darwin-launchd-process.js')
  const adapter = createDarwinCoalitionAdapter({ controlRoot, providerPrivateOwnershipRoot: root, helper,
    listenerSupervisor: { path: supervisor, sha256: sha256(fs.readFileSync(supervisor)) } })
  const reservationId = `grok-profile-${crypto.randomUUID()}`
  const record = { reservationId, reservationIdentity: adapter.reservationIdentity(reservationId),
    startupDeadlineAt: new Date(Date.now() + 60000).toISOString(), targetKey: 'darwin-grok-profile' }
  record.reservationBinding = adapter.prepareReservation(record)
  let owned = null, drained = false, spawnAttempted = false
  t.after(async () => {
    if (owned && !drained) {
      try {
        await adapter.signalOwned(owned.groupIdentity, 'KILL')
        await waitFor(async () => (await adapter.listOwned(owned.groupIdentity)).length === 0, 30000,
          'profile fixture cleanup did not drain its exact retained listener service')
        drained = true
      } catch {}
    }
    if (drained || !spawnAttempted) fs.rmSync(root, { recursive: true, force: true })
    else t.diagnostic?.('retained Grok profile fixture root because spawn ownership was uncertain')
  })
  spawnAttempted = true
  owned = await adapter.spawnOwned({ ...record, executable: '/usr/bin/sandbox-exec', argv: ['-f', profilePath, node, script, observed, secret, errorPath], cwd,
    env: { AUTOPROMPT_OWNERSHIP_RESERVATION: reservationId, AUTOPROMPT_GROK_PROXY_LISTENER_FD: '3',
      AUTOPROMPT_GROK_MCP_LISTENER_FD: '4', AUTOPROMPT_GROK_PROXY_PORT: String(proxyPort), AUTOPROMPT_GROK_MCP_PORT: String(mcpPort) },
    shell: false, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', darwinListeners: listeners })
  const ready = await waitFor(() => {
    if (fs.existsSync(observed)) {
      const value = JSON.parse(fs.readFileSync(observed, 'utf8'))
      if (value.ready === true) return value
    }
    if (fs.existsSync(errorPath)) throw new Error(`Seatbelt child failed: ${fs.readFileSync(errorPath, 'utf8')}`)
    return false
  }, 30000,
    'Seatbelt Grok listener child did not publish its FD adoption receipt')
  assert.deepEqual(ready.values.map(value => [value.name, value.address.address, value.address.family, value.address.port]).sort(), [
    ['mcp', '::1', 'IPv6', mcpPort], ['proxy', '::1', 'IPv6', proxyPort],
  ])
  assert.ok(['EACCES', 'EPERM'].includes(ready.secretCode), `Seatbelt child did not receive a permission denial for the controller secret: ${ready.secretCode}`)
  assert.equal(await connectEcho(proxyPort, 'proxy-request'), 'proxy:proxy-request')
  assert.equal(await connectEcho(mcpPort, 'mcp-request'), 'mcp:mcp-request')
  await waitFor(async () => (await adapter.listOwned(owned.groupIdentity)).length === 0, 30000,
    'profile child completion did not drain the exact retained listener service')
  drained = true
  await assertIPv6PortReleased(proxyPort)
  await assertIPv6PortReleased(mcpPort)
})

test('native packaged Darwin launchd coalition factory survives root death and a fresh adapter drains detached children', {
  skip: process.platform !== 'darwin' && 'requires native macOS',
  timeout: 150000,
}, async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'ap-darwin-owner-'))
  fs.chmodSync(temporaryRoot, 0o700)
  const controlRoot = path.join(temporaryRoot, 'control')
  const helper = path.join(temporaryRoot, 'darwin-coalition-helper')
  const fixtureSource = path.join(temporaryRoot, 'detached-fixture.c')
  const fixture = path.join(temporaryRoot, 'detached-fixture')
  const slowHelperSource = path.join(temporaryRoot, 'slow-helper.c')
  const slowHelper = path.join(temporaryRoot, 'slow-helper')
  const stateFile = path.join(temporaryRoot, 'children.txt')
  const registryPath = path.join(temporaryRoot, 'processes.json')
  const compilerProbe = requireSuccess(command('/usr/bin/xcrun', ['--find', 'clang']), 'locate clang')
  const compiler = fs.realpathSync.native(compilerProbe.stdout.trim())
  assert.equal(path.isAbsolute(compiler), true)
  const compilerVersion = requireSuccess(command(compiler, ['--version']), 'read clang version').stdout.trim()
  const sdkPath = requireSuccess(command('/usr/bin/xcrun', ['--show-sdk-path']), 'read SDK path').stdout.trim()
  const sdkVersion = requireSuccess(command('/usr/bin/xcrun', ['--show-sdk-version']), 'read SDK version').stdout.trim()
  requireSuccess(command(compiler, [
    '-isysroot', sdkPath, '-mmacosx-version-min=13.5', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', HELPER_SOURCE, '-o', helper,
  ]), 'compile coalition helper')
  const loadCommands = requireSuccess(command('/usr/bin/otool', ['-l', helper]), 'read helper load commands').stdout
  const buildVersion = /cmd LC_BUILD_VERSION[\s\S]*?platform\s+(\S+)[\s\S]*?minos\s+(\S+)[\s\S]*?sdk\s+(\S+)/.exec(loadCommands)
  assert.ok(buildVersion, 'compiled helper must publish LC_BUILD_VERSION')
  // Keep the source-built helper as an independent compiler/ABI proof. Actual
  // ProcessOwner lifecycle coverage below uses only the packaged loader.
  const sourceHelperBinding = { path: fs.realpathSync.native(helper), sha256: sha256(fs.readFileSync(helper)) }
  const sourceBoot = helperJson(helper, ['boot'])
  const packagedHelper = LOADER.loadDarwinCoalitionHelper()
  assert.ok(path.isAbsolute(packagedHelper.path))
  assert.match(packagedHelper.sha256, /^[a-f0-9]{64}$/)
  const packagedBoot = helperJson(packagedHelper.path, ['boot'])
  assert.equal(packagedBoot.bootUuid, sourceBoot.bootUuid, 'packaged and source-built helpers must observe the same kernel boot identity')
  const fixtureText = String.raw`#define _DARWIN_C_SOURCE
#include <crt_externs.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
static void finish(int signal_number) { (void)signal_number; _exit(0); }
static void hold(int clear_environment) {
  if (setsid() < 0) _exit(91);
  if (clear_environment) { static char *empty[] = { NULL }; *_NSGetEnviron() = empty; }
  signal(SIGTERM, finish); signal(SIGALRM, finish); alarm(90);
  for (;;) pause();
}
int main(int argc, char **argv) {
  if (argc != 2) return 64;
  pid_t first = fork(); if (first < 0) return 70; if (first == 0) hold(0);
  pid_t second = fork(); if (second < 0) return 71; if (second == 0) hold(1);
  int descriptor = open(argv[1], O_WRONLY | O_CREAT | O_EXCL, 0600); if (descriptor < 0) return 72;
  if (dprintf(descriptor, "%d %d\n", first, second) < 0 || fsync(descriptor) != 0 || close(descriptor) != 0) return 73;
  return 23;
}
`
  fs.writeFileSync(fixtureSource, fixtureText, { mode: 0o600 })
  requireSuccess(command(compiler, [
    '-isysroot', sdkPath, '-mmacosx-version-min=13.5', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', fixtureSource, '-o', fixture,
  ]), 'compile detached fixture')
  fs.writeFileSync(slowHelperSource, [
    '#include <string.h>',
    '#include <unistd.h>',
    `static const char *helper = ${JSON.stringify(packagedHelper.path)};`,
    'int main(int argc, char **argv) {',
    '  if (argc > 1 && strcmp(argv[1], "inspect") == 0) sleep(3);',
    '  execv(helper, argv);',
    '  return 71;',
    '}',
    '',
  ].join('\n'), { mode: 0o600 })
  requireSuccess(command(compiler, [
    '-isysroot', sdkPath, '-mmacosx-version-min=13.5', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', slowHelperSource, '-o', slowHelper,
  ]), 'compile delayed helper shim')

  const helperBinding = sourceHelperBinding
  const { createDarwinCoalitionAdapter } = require('../../agents/codex/workflow/darwin-launchd-process.js')
  assert.throws(() => createDarwinCoalitionAdapter({
    controlRoot,
    providerPrivateOwnershipRoot: temporaryRoot,
    helper: { ...helperBinding, sha256: '0'.repeat(64) },
  }), { code: 'PROCESS_IDENTITY_CHANGED' })

  const adapter = createPlatformProcessAdapter({ platform: 'darwin', darwin: { controlRoot, providerPrivateOwnershipRoot: temporaryRoot } })
  const reservationId = `native-${crypto.randomUUID()}`
  const owner = new ProcessOwner({
    adapter,
    registryPath,
    pollMs: 50,
    startupTimeoutMs: 60000,
    adapterCallTimeoutMs: 70000,
  })
  let ownership = null
  let children = []
  let fresh = null
  const evidence = {
    schemaVersion: 1,
    platform: `${process.platform}-${process.arch}`,
    helperSha256: packagedHelper.sha256,
    packagedHelperPath: packagedHelper.path,
    sourceBuiltHelperSha256: sourceHelperBinding.sha256,
    packagedBootUuid: packagedBoot.bootUuid,
    sourceBuiltBootUuid: sourceBoot.bootUuid,
    helperSourceSha256: sha256(fs.readFileSync(HELPER_SOURCE)),
    compiler: { path: compiler, version: compilerVersion },
    sdkVersion,
    sdkPath,
    deploymentTarget: '13.5',
    sourceBuiltBinaryBuildVersion: { platform: buildVersion[1], minimumOs: buildVersion[2], sdk: buildVersion[3] },
  }
  try {
    const launched = await owner.launch({
      reservationId,
      executable: fixture,
      argv: [stateFile],
      cwd: temporaryRoot,
      env: { AUTOPROMPT_OWNERSHIP_RESERVATION: reservationId },
      shell: false,
      targetKey: 'darwin-native-coalition',
    })
    ownership = { rootPid: launched.rootPid, groupIdentity: launched.groupIdentity }
    children = await waitFor(() => {
      if (!fs.existsSync(stateFile)) return null
      const values = fs.readFileSync(stateFile, 'utf8').trim().split(/\s+/).map(Number)
      return values.length === 2 && values.every(value => Number.isSafeInteger(value) && value > 0) ? values : null
    }, 20000, 'detached children did not publish')
    await waitFor(() => !alive(ownership.rootPid), 20000, 'trusted launchd root did not exit')

    fresh = createPlatformProcessAdapter({ platform: 'darwin', darwin: { controlRoot, providerPrivateOwnershipRoot: temporaryRoot } })
    const freshOwner = new ProcessOwner({
      adapter: fresh,
      registryPath,
      pollMs: 50,
      startupTimeoutMs: 60000,
      adapterCallTimeoutMs: 70000,
    })
    await freshOwner.recoverReservations()
    const recoveredRecord = freshOwner.listRecords().find(value => value.reservationId === reservationId)
    assert.ok(recoveredRecord)
    assert.equal(recoveredRecord.rootPid, ownership.rootPid)
    assert.equal(recoveredRecord.groupIdentity, ownership.groupIdentity)
    const coalitionId = ownership.groupIdentity.split(':').at(-1)
    const before = helperJson(packagedHelper.path, ['usage', coalitionId])
    assert.equal(before.exists, true)
    assert.equal(BigInt(before.tasksStarted) - BigInt(before.tasksExited) >= 2n, true)
    const members = await fresh.listOwned(ownership.groupIdentity)
    for (const pid of children) assert.equal(members.includes(pid), true)

    await freshOwner.cancelAll({ graceMs: 500, killMs: 30000, reason: 'native crash recovery proof' })
    assert.equal(await freshOwner.assertDrained(), true)
    await waitFor(async () => (await fresh.listOwned(ownership.groupIdentity)).length === 0, 30000, 'coalition did not drain')
    const zeroOne = helperJson(packagedHelper.path, ['usage', coalitionId])
    await sleep(100)
    const zeroTwo = helperJson(packagedHelper.path, ['usage', coalitionId])
    for (const usage of [zeroOne, zeroTwo]) {
      if (usage.exists) assert.equal(usage.tasksStarted, usage.tasksExited)
    }

    const reservationDirectory = path.join(controlRoot, sha256(reservationId))
    const requestPath = path.join(reservationDirectory, 'request.json')
    const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'))
    assert.equal(request.helper.sha256, packagedHelper.sha256, 'production factory must bind the packaged helper digest into the durable request')
    assert.equal(sha256(fs.readFileSync(request.helper.path)), packagedHelper.sha256, 'materialized request helper must retain the packaged helper digest')
    const absent = command('/bin/launchctl', ['print', `${request.domain}/${request.label}`])
    assert.equal(absent.error, undefined)
    assert.equal(absent.signal, null)
    assert.notEqual(absent.status, 0)
    assert.ok(absent.stderr.includes(`Could not find service "${request.label}" in domain for `))

    const slowControlRoot = path.join(temporaryRoot, 'slow-control')
    const slowBinding = { path: fs.realpathSync.native(slowHelper), sha256: sha256(fs.readFileSync(slowHelper)) }
    const slowAdapter = createDarwinCoalitionAdapter({ controlRoot: slowControlRoot, providerPrivateOwnershipRoot: temporaryRoot, helper: slowBinding })
    const slowReservationId = `slow-${crypto.randomUUID()}`
    const slowRecord = {
      reservationId: slowReservationId,
      reservationIdentity: slowAdapter.reservationIdentity(slowReservationId),
      startupDeadlineAt: new Date(Date.now() + 500).toISOString(),
      targetKey: 'darwin-paused-startup',
    }
    slowRecord.reservationBinding = slowAdapter.prepareReservation(slowRecord)
    await assert.rejects(slowAdapter.spawnOwned({
      ...slowRecord,
      executable: fixture,
      argv: [path.join(temporaryRoot, 'must-not-spawn.txt')],
      cwd: temporaryRoot,
      env: { AUTOPROMPT_OWNERSHIP_RESERVATION: slowReservationId },
      shell: false,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    }), { code: 'PROCESS_RESERVATION_FAILURE' })
    const expired = await slowAdapter.probeReservation(slowRecord)
    assert.equal(expired.state, 'DEAD')
    const slowDirectory = path.join(slowControlRoot, sha256(slowReservationId))
    const slowRequest = JSON.parse(fs.readFileSync(path.join(slowDirectory, 'request.json'), 'utf8'))
    const slowAbsent = command('/bin/launchctl', ['print', `${slowRequest.domain}/${slowRequest.label}`])
    assert.equal(slowAbsent.status, absent.status)
    assert.ok(slowAbsent.stderr.includes(`Could not find service "${slowRequest.label}" in domain for `))
    await sleep(3500)
    assert.equal(fs.existsSync(path.join(slowDirectory, 'ready.json')), false)
    assert.equal(fs.existsSync(path.join(temporaryRoot, 'must-not-spawn.txt')), false)

    fs.writeFileSync(requestPath, `${JSON.stringify({ ...request, label: `${request.label}.changed` })}\n`, { mode: 0o600 })
    await assert.rejects(fresh.listOwned(ownership.groupIdentity), { code: 'PROCESS_IDENTITY_INVALID' })
    evidence.ownership = ownership
    evidence.terminalRecord = freshOwner.listRecords().find(value => value.reservationId === reservationId)
    evidence.children = children
    evidence.usageBefore = before
    evidence.usageAfter = [zeroOne, zeroTwo]
    evidence.launchctlAbsentStatus = absent.status
    evidence.pausedStartup = { state: expired.state, launchctlAbsentStatus: slowAbsent.status, lateReady: false }
    evidence.checksumRefused = true
    evidence.survivors = children.filter(alive)
    assert.deepEqual(evidence.survivors, [])
  } catch (error) {
    evidence.failure = { code: error.code, message: error.message, details: error.details }
    console.error(JSON.stringify(evidence.failure))
    throw error
  } finally {
    if (ownership && fresh) {
      try { await fresh.signalOwned(ownership.groupIdentity, 'KILL') } catch {}
    }
    if (fs.existsSync(packagedHelper.path)) preserveTestedHelper(packagedHelper.path, evidence)
    if (children.every(pid => !alive(pid))) fs.rmSync(temporaryRoot, { recursive: true, force: true })
    else evidence.retainedRoot = temporaryRoot
    writeEvidence(evidence)
  }
})
