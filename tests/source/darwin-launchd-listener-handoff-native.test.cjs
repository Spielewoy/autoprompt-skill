'use strict'
const assert = require('node:assert/strict')
const cp = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '../..')
const PRODUCTION_SUPERVISOR = process.env.AUTOPROMPT_DARWIN_LISTENER_PRODUCTION === '1'
const SOURCE = path.join(ROOT, PRODUCTION_SUPERVISOR
  ? 'agents/codex/workflow/darwin-launchd-listener-supervisor.c'
  : 'tests/helpers/darwin-launchd-listener-handoff.c')
const COALITION_SOURCE = path.join(ROOT, 'agents/codex/workflow/darwin-coalition-helper.c')
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value && typeof value === 'object'
  ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}` : JSON.stringify(value)
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
const command = (file, args) => cp.spawnSync(file, args, { shell: false, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 })
const waitFor = async (predicate, timeout, message) => { const end = Date.now() + timeout; while (Date.now() < end) { const value = predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 25)) }; throw new Error(typeof message === 'function' ? message() : message) }
const reservePort = host => new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, host, () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)) }) })
const request = (port, text) => new Promise((resolve, reject) => { const socket = net.createConnection(port, '::1'); let value = ''; socket.setEncoding('utf8'); socket.setTimeout(10000, () => socket.destroy(new Error('listener timed out'))); socket.once('connect', () => socket.end(text)); socket.on('data', chunk => { value += chunk }); socket.once('error', reject); socket.once('close', hadError => { if (!hadError) resolve(value) }) })
const trigger = port => new Promise(resolve => { const socket = net.createConnection(port, '::1'); const done = outcome => { socket.destroy(); resolve(outcome) }; socket.setTimeout(2000, () => done('timeout')); socket.once('connect', () => done('connected')); socket.once('error', error => done(error.code || 'error')) })
const bind = (port, expectBusy) => new Promise((resolve, reject) => {
  const server = net.createServer()
  server.once('error', error => expectBusy && error.code === 'EADDRINUSE' ? resolve(null) : reject(error))
  server.listen({ host: '::1', port, ipv6Only: true }, () => {
    if (expectBusy) { server.close(); reject(new Error(`listener ${port} was unexpectedly bindable`)); return }
    resolve(server)
  })
})

function readGenerationRecords(directory, requestSha256) {
  const names = fs.readdirSync(directory).sort()
  if (!names.length || names.length > 8) throw new Error('listener generation inventory is incomplete or excessive')
  return names.map(name => {
    if (!/^generation-[1-9][0-9]*--?[0-9]+\.json$/.test(name)) throw new Error('listener generation record name is invalid')
    const file = path.join(directory, name), before = fs.lstatSync(file)
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 || before.size > 1024 ||
        (process.platform !== 'win32' && (before.mode & 0o777) !== 0o600)) throw new Error('listener generation record identity is invalid')
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    try {
      const opened = fs.fstatSync(fd)
      if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new Error('listener generation record changed while opening')
      const bytes = Buffer.alloc(opened.size)
      if (fs.readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length || fs.readSync(fd, Buffer.alloc(1), 0, 1, bytes.length) !== 0) throw new Error('listener generation record changed while reading')
      const value = JSON.parse(bytes.toString('utf8'))
      if (!value || Object.keys(value).sort().join(',') !== 'pid,pidVersion,requestSha256,resourceCoalitionId,schemaVersion,uid' ||
          value.schemaVersion !== 1 || value.requestSha256 !== requestSha256 || !Number.isSafeInteger(value.pid) || value.pid < 1 ||
          !Number.isSafeInteger(value.uid) || value.uid !== process.getuid() || !Number.isSafeInteger(value.pidVersion) ||
          typeof value.resourceCoalitionId !== 'string' || !/^[1-9][0-9]*$/.test(value.resourceCoalitionId) ||
          name !== `generation-${value.pid}-${value.pidVersion}.json`) throw new Error('listener generation record binding is invalid')
      return value
    } finally { fs.closeSync(fd) }
  })
}

function inspect(helper, pid) {
  const result = command(helper, ['inspect', String(pid)])
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const value = JSON.parse(result.stdout)
  assert.equal(value.schemaVersion, 1); assert.equal(value.ok, true); assert.equal(value.command, 'inspect'); assert.equal(value.pid, pid)
  return value
}

function usage(helper, coalition) {
  const result = command(helper, ['usage', coalition])
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const value = JSON.parse(result.stdout)
  assert.equal(value.schemaVersion, 1); assert.equal(value.ok, true); assert.equal(value.command, 'usage')
  assert.equal(value.resourceCoalitionId, coalition)
  assert.equal(typeof value.exists, 'boolean')
  assert.match(value.tasksStarted, /^(?:0|[1-9][0-9]*)$/); assert.match(value.tasksExited, /^(?:0|[1-9][0-9]*)$/)
  const started = BigInt(value.tasksStarted), exited = BigInt(value.tasksExited)
  assert.ok(exited <= started, 'coalition usage counters underflow')
  return { ...value, live: started - exited }
}

function plist({ label, wrapper, modelPort, mcpPort, node, script, requestPath, markerPath, requestHash, generationDirectory, stdout, stderr }) {
  const args = [wrapper, String(modelPort), String(mcpPort), node, script, requestPath, markerPath, requestHash, generationDirectory]
  const socket = (name, port) => `<key>${name}</key><dict><key>SockNodeName</key><string>::1</string><key>SockServiceName</key><string>${port}</string><key>SockFamily</key><string>IPv6</string><key>SockType</key><string>stream</string><key>SockProtocol</key><string>TCP</string></dict>`
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string><key>ProgramArguments</key><array>${args.map(value => `<string>${xml(value)}</string>`).join('')}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><false/><key>LaunchOnlyOnce</key><false/><key>AbandonProcessGroup</key><false/><key>StandardOutPath</key><string>${xml(stdout)}</string><key>StandardErrorPath</key><string>${xml(stderr)}</string><key>Sockets</key><dict>${socket('autoprompt.model', modelPort)}${socket('autoprompt.mcp', mcpPort)}</dict></dict></plist>`
}

test('Darwin launchd wrapper hands two exact IPv6 listeners to fixed descriptors', { skip: process.platform !== 'darwin', timeout: 120000 }, async t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join('/private/tmp', 'ap-fd-handoff-')))
  fs.chmodSync(root, 0o700)
  const wrapper = path.join(root, 'listener-handoff'), coalitionHelper = path.join(root, 'coalition-helper'), script = path.join(root, 'job.cjs'), requestPath = path.join(root, 'request.json')
  const ready = path.join(root, 'ready.json'), startupMarker = path.join(root, 'startup-marker.json'), startupAttempts = path.join(root, 'startup-attempts.log'), startedMarker = path.join(root, 'started.marker')
  const stdout = path.join(root, 'stdout.log'), stderr = path.join(root, 'stderr.log'), generationDirectory = path.join(root, 'generations')
  fs.mkdirSync(generationDirectory, { mode: 0o700 })
  const plistPath = path.join(root, 'job.plist'), domain = `gui/${process.getuid()}`
  const label = `com.autoprompt.listenerhandoff.${process.pid}.${crypto.randomBytes(6).toString('hex')}`
  let submitted = false
  const rebound = []
  const launchctl = args => command('/bin/launchctl', args)
  t.after(() => {
    for (const server of rebound) server.close()
    // Capture the post-launch state before bootout removes launchd's exit
    // status. Reading stderr before waiting hides every startup failure.
    if (submitted) t.diagnostic(JSON.stringify({ handoffState: launchctl(['print', `${domain}/${label}`]),
      stdout: fs.existsSync(stdout) ? fs.readFileSync(stdout, 'utf8').slice(-8192) : null,
      stderr: fs.existsSync(stderr) ? fs.readFileSync(stderr, 'utf8').slice(-8192) : null }))
    if (submitted) launchctl(['bootout', `${domain}/${label}`])
    const absent = launchctl(['print', `${domain}/${label}`])
    assert.ok(absent.status === 113 && /Could not find service/.test(absent.stderr), `launchd listener cleanup is unconfirmed: ${absent.stderr}`)
    fs.rmSync(root, { recursive: true, force: true })
  })
  const sdk = command('/usr/bin/xcrun', ['--show-sdk-path']); assert.equal(sdk.status, 0, sdk.stderr)
  const build = command('/usr/bin/clang', ['-isysroot', sdk.stdout.trim(), '-mmacosx-version-min=13.5', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', SOURCE, '-o', wrapper])
  assert.equal(build.status, 0, build.stderr)
  const helperBuild = command('/usr/bin/clang', ['-isysroot', sdk.stdout.trim(), '-mmacosx-version-min=13.5', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', COALITION_SOURCE, '-o', coalitionHelper])
  assert.equal(helperBuild.status, 0, helperBuild.stderr)
  const node = fs.realpathSync.native(process.execPath)
  if (process.env.AUTOPROMPT_DARWIN_LISTENER_HANDOFF_EVIDENCE) {
    const evidencePath = path.resolve(process.env.AUTOPROMPT_DARWIN_LISTENER_HANDOFF_EVIDENCE)
    const binaryPath = path.join(path.dirname(evidencePath), 'darwin-launchd-listener-handoff')
    fs.copyFileSync(wrapper, binaryPath, fs.constants.COPYFILE_EXCL)
    fs.writeFileSync(evidencePath, `${JSON.stringify({ schemaVersion: 1, platform: process.platform, architecture: process.arch,
      deploymentTarget: '13.5', sourceSha256: sha256(fs.readFileSync(SOURCE)), binarySha256: sha256(fs.readFileSync(binaryPath)),
      node: { path: node, sha256: sha256(fs.readFileSync(node)) }, socketNames: ['autoprompt.model', 'autoprompt.mcp'], inheritedDescriptors: [3, 4],
      generationRecord: { schemaVersion: 1, requestBound: true, fields: ['pid', 'uid', 'pidVersion', 'resourceCoalitionId'] } })}\n`, { flag: 'wx', mode: 0o600 })
  }
  const modelPort = await reservePort('::1'), mcpPort = await reservePort('::1')
  assert.notEqual(modelPort, mcpPort)
  const body = { schemaVersion: 1, sockets: { model: { name: 'autoprompt.model', fd: 3, host: '::1', port: modelPort }, mcp: { name: 'autoprompt.mcp', fd: 4, host: '::1', port: mcpPort } }, node: { path: node, sha256: sha256(fs.readFileSync(node)) } }
  body.checksum = sha256(stable(body))
  fs.writeFileSync(requestPath, `${JSON.stringify(body)}\n`, { flag: 'wx', mode: 0o600 })
  fs.writeFileSync(script, String.raw`'use strict'
const crypto=require('node:crypto'),fs=require('node:fs'),net=require('node:net'),path=require('node:path')
const stable=v=>Array.isArray(v)?'['+v.map(stable).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}':JSON.stringify(v)
const hash=b=>crypto.createHash('sha256').update(b).digest('hex')
const refuse=(code,message)=>{console.error(message);process.exit(code)}
const production=${JSON.stringify(PRODUCTION_SUPERVISOR)}
if(process.argv[2]!=='--job'||(production?process.argv.length!==4:process.argv.length!==6||process.argv[4]!=='--closed-fd'||!/^\d+$/.test(process.argv[5])))refuse(64,'Node listener arguments invalid')
const request=JSON.parse(fs.readFileSync(process.argv[3],'utf8')),copy={...request};delete copy.checksum
if(request.checksum!==hash(stable(copy))||request.node.path!==fs.realpathSync.native(process.execPath)||request.node.sha256!==hash(fs.readFileSync(process.execPath)))refuse(65,'Node listener request binding invalid')
if(!production){const requestIdentity=fs.statSync(process.argv[3]);try{const leaked=fs.fstatSync(Number(process.argv[5]));if(leaked.dev===requestIdentity.dev&&leaked.ino===requestIdentity.ino)refuse(68,'Unexpected request descriptor survived CLOEXEC child spawn')}catch(error){if(error.code!=='EBADF')throw error}}
fs.appendFileSync(${JSON.stringify(startupAttempts)},String(process.pid)+'\n',{encoding:'utf8',mode:0o600})
fs.writeFileSync(${JSON.stringify(startupMarker)},JSON.stringify({pid:process.pid,ppid:process.ppid}),{flag:'wx',mode:0o600})
const servers=[]
for(const key of ['model','mcp']){const item=request.sockets[key];if(item.name!=='autoprompt.'+key||item.fd!==(key==='model'?3:4)||item.host!=='::1')process.exit(66);const server=net.createServer(socket=>socket.end(key+'\n'));server.listen({fd:item.fd,exclusive:true});servers.push([key,item,server])}
Promise.all(servers.map(([key,item,server])=>new Promise((resolve,reject)=>{server.once('error',reject);server.once('listening',()=>{const address=server.address();if(address.address!=='::1'||address.family!=='IPv6'||address.port!==item.port)return reject(new Error('listener mismatch'));resolve()})}))).then(()=>fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,ports:servers.map(([,item])=>item.port)}),{flag:'wx',mode:0o600})).catch(error=>refuse(67,error.stack||error.message))
`, { flag: 'wx', mode: 0o600 })
  fs.writeFileSync(plistPath, plist({ label, wrapper, modelPort, mcpPort, node, script, requestPath, markerPath: startedMarker, requestHash: body.checksum, generationDirectory, stdout, stderr }), { flag: 'wx', mode: 0o600 })
  submitted = true
  const bootstrap = launchctl(['bootstrap', domain, plistPath]); assert.equal(bootstrap.status, 0, bootstrap.stderr)
  const receipt = await waitFor(() => fs.existsSync(ready) && JSON.parse(fs.readFileSync(ready, 'utf8')), 30000,
    () => `listener handoff did not become ready: ${fs.existsSync(stderr) ? fs.readFileSync(stderr, 'utf8').slice(-2048) : ''}`)
  assert.deepEqual(receipt.ports, [modelPort, mcpPort])
  const supervisorMatch = /^SUPERVISOR_PID:([1-9][0-9]*)$/m.exec(fs.readFileSync(stdout, 'utf8'))
  assert.ok(supervisorMatch, 'supervisor did not publish its stable root PID')
  const supervisorPid = Number(supervisorMatch[1])
  assert.notEqual(supervisorPid, receipt.pid, 'Node child must not replace the launchd supervisor')
  assert.equal(await request(modelPort, 'model'), 'model\n')
  assert.equal(await request(mcpPort, 'mcp'), 'mcp\n')
  assert.deepEqual(JSON.parse(fs.readFileSync(startupMarker, 'utf8')), { pid: receipt.pid, ppid: supervisorPid })
  assert.deepEqual(fs.readFileSync(startupAttempts, 'utf8').trim().split('\n'), [String(receipt.pid)])
  assert.equal(fs.readFileSync(startedMarker, 'utf8'), `v1\n${body.checksum}\n`)
  let generations = readGenerationRecords(generationDirectory, body.checksum)
  assert.equal(generations.length, 1)
  const supervisorGeneration = generations.find(item => item.pid === supervisorPid)
  assert.ok(supervisorGeneration, 'supervisor generation was not durably published')
  const supervisorInspection = inspect(coalitionHelper, supervisorPid)
  assert.equal(supervisorGeneration.uid, supervisorInspection.uid)
  assert.equal(supervisorGeneration.pidVersion, supervisorInspection.pidVersion)
  assert.equal(supervisorGeneration.resourceCoalitionId, supervisorInspection.resourceCoalitionId)
  assert.equal(inspect(coalitionHelper, receipt.pid).resourceCoalitionId, supervisorGeneration.resourceCoalitionId,
    'Node worker must remain inside the recorded supervisor coalition')
  process.kill(receipt.pid, 'SIGKILL')
  await waitFor(() => command('/bin/kill', ['-0', String(receipt.pid)]).status !== 0, 10000, 'launchd listener root survived SIGKILL')
  await waitFor(() => fs.readFileSync(stdout, 'utf8').includes(`CHILD_REAPED:${receipt.pid}`), 10000, 'supervisor did not reap the killed Node child')
  assert.equal(command('/bin/kill', ['-0', String(supervisorPid)]).status, 0, 'supervisor did not remain after child exit')
  const retainedService = launchctl(['print', `${domain}/${label}`]); assert.equal(retainedService.status, 0, retainedService.stderr)
  await bind(modelPort, true); await bind(mcpPort, true)
  // A hostile supervisor death must not release the launchd-held endpoints or
  // authorize another child. Demand activation starts only the marker guard.
  process.kill(supervisorPid, 'SIGKILL')
  await waitFor(() => command('/bin/kill', ['-0', String(supervisorPid)]).status !== 0, 10000, 'supervisor survived SIGKILL')
  const triggered = await Promise.all([trigger(modelPort), trigger(mcpPort)])
  // launchd's documented default ThrottleInterval is ten seconds; leave a
  // bounded margin after the deliberate supervisor crash before judging the
  // demand-triggered marker guard.
  await waitFor(() => /^GUARD_PID:([1-9][0-9]*)$/m.test(fs.readFileSync(stdout, 'utf8')), 30000, 'marker guard did not retain the relaunched service')
  const guardPid = Number(/^GUARD_PID:([1-9][0-9]*)$/m.exec(fs.readFileSync(stdout, 'utf8'))[1])
  assert.notEqual(guardPid, supervisorPid)
  assert.equal(command('/bin/kill', ['-0', String(guardPid)]).status, 0, 'marker guard did not remain until bootout')
  const guardedService = launchctl(['print', `${domain}/${label}`]); assert.equal(guardedService.status, 0, guardedService.stderr)
  await bind(modelPort, true); await bind(mcpPort, true)
  assert.deepEqual(fs.readFileSync(startupAttempts, 'utf8').trim().split('\n'), [String(receipt.pid)],
    `marker guard admitted another worker after socket activity: ${JSON.stringify(triggered)}`)
  assert.deepEqual(JSON.parse(fs.readFileSync(startupMarker, 'utf8')), { pid: receipt.pid, ppid: supervisorPid })
  generations = readGenerationRecords(generationDirectory, body.checksum)
  assert.equal(generations.length, 2)
  const guardGeneration = generations.find(item => item.pid === guardPid)
  assert.ok(guardGeneration, 'marker guard generation was not durably published')
  const guardInspection = inspect(coalitionHelper, guardPid)
  assert.equal(guardGeneration.uid, guardInspection.uid)
  assert.equal(guardGeneration.pidVersion, guardInspection.pidVersion)
  assert.equal(guardGeneration.resourceCoalitionId, guardInspection.resourceCoalitionId)
  assert.notEqual(`${guardGeneration.pid}:${guardGeneration.pidVersion}`, `${supervisorGeneration.pid}:${supervisorGeneration.pidVersion}`,
    'restarted launchd guard must have a separately recorded native process identity')
  const bootout = launchctl(['bootout', `${domain}/${label}`]); assert.equal(bootout.status, 0, bootout.stderr)
  await waitFor(() => command('/bin/kill', ['-0', String(guardPid)]).status !== 0, 10000, 'exact bootout did not terminate the marker guard')
  await waitFor(() => { const absent = launchctl(['print', `${domain}/${label}`]); return absent.status === 113 && /Could not find service/.test(absent.stderr) }, 10000,
    'launchd listener service remained after exact bootout')
  // launchd may retain one resource coalition for successive executions of
  // the same submitted job. Generation authority is the authenticated
  // pid/pidVersion record; drain each distinct recorded kernel cohort once.
  const recordedCoalitions = [...new Set([supervisorGeneration, guardGeneration].map(generation => generation.resourceCoalitionId))]
  assert.ok(recordedCoalitions.length >= 1 && recordedCoalitions.length <= 2)
  for (const resourceCoalitionId of recordedCoalitions) {
    await waitFor(() => {
      const state = usage(coalitionHelper, resourceCoalitionId)
      return state.live === 0n && state
    }, 10000, `generation coalition ${resourceCoalitionId} retained live tasks after exact bootout`)
  }
  submitted = false
  // Service absence and guard death precede asynchronous socket retirement;
  // accepted connections can also leave TCP TIME_WAIT state. Require both
  // exact ports to become bindable, keeping successful probes registered for
  // cleanup even if the other port remains busy.
  const releaseDeadline = Date.now() + 65000
  for (const port of [modelPort, mcpPort]) {
    for (;;) {
      try { rebound.push(await bind(port, false)); break } catch (error) {
        if (error.code !== 'EADDRINUSE' || Date.now() >= releaseDeadline) throw error
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    }
  }
  await Promise.all(rebound.map(server => new Promise(resolve => server.close(resolve))))
  rebound.length = 0
})

test('Darwin listener handoff source fixes socket keys and publishes only FD3 and FD4', () => {
  const source = fs.readFileSync(SOURCE, 'utf8')
  assert.match(source, /"autoprompt\.model"/)
  assert.match(source, /"autoprompt\.mcp"/)
  assert.match(source, /dup2\(model_copy, 3\)/)
  assert.match(source, /dup2\(mcp_copy, 4\)/)
  assert.match(source, /POSIX_SPAWN_CLOEXEC_DEFAULT/)
  assert.doesNotMatch(source, /POSIX_SPAWN_SETEXEC/)
  assert.match(source, /posix_spawn_file_actions_addinherit_np\(&actions, descriptor\)/)
  assert.match(source, /started_marker/)
  assert.match(source, /GUARD_PID/)
  assert.match(source, /publish_generation\(argv\[8\], argv\[7\]\)/)
  assert.ok(source.indexOf('publish_generation(argv[8], argv[7])') < source.indexOf('acquire(MODEL_SOCKET'),
    'generation authority must be durable before launchd listener activation')
  assert.match(plist({ label: 'com.autoprompt.test', wrapper: '/private/w', modelPort: 1, mcpPort: 2, node: '/private/n', script: '/private/s', requestPath: '/private/r', markerPath: '/private/m', requestHash: 'a'.repeat(64), generationDirectory: '/private/g', stdout: '/private/o', stderr: '/private/e' }), /<key>LaunchOnlyOnce<\/key><false\/>/)
})

test('listener generation inventory rejects truncated and foreign request records', { skip: process.platform === 'win32' }, t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ap-listener-generation-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  if (process.platform !== 'win32') fs.chmodSync(root, 0o700)
  const requestSha = 'a'.repeat(64), name = 'generation-41-7.json', file = path.join(root, name)
  fs.writeFileSync(file, '{', { flag: 'wx', mode: 0o600 })
  assert.throws(() => readGenerationRecords(root, requestSha))
  fs.unlinkSync(file)
  fs.writeFileSync(file, `${JSON.stringify({ schemaVersion: 1, requestSha256: 'b'.repeat(64), pid: 41, uid: process.getuid(),
    pidVersion: 7, resourceCoalitionId: '91' })}\n`, { flag: 'wx', mode: 0o600 })
  assert.throws(() => readGenerationRecords(root, requestSha), /binding is invalid/)
  fs.unlinkSync(file)
  fs.writeFileSync(path.join(root, '.generation-41-7.json.tmp'), '{', { flag: 'wx', mode: 0o600 })
  assert.throws(() => readGenerationRecords(root, requestSha), /record name is invalid/)
})
