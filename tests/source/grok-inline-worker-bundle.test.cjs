'use strict'

const assert = require('node:assert/strict')
const cp = require('node:child_process')
const path = require('node:path')
const test = require('node:test')
const { buildClosedCommonJsBundle, buildGrokInlineWorker, buildGrokInlineMcpClient, windowsCommandLineUnits } = require('../../scripts/harness-v2-bridge/grok/inline-worker-bundle.cjs')

test('closed inline CommonJS bundle executes with cache, main and virtual filename semantics', () => {
  const bundle = buildClosedCommonJsBundle({
    entry: 'entry.cjs', allowedBuiltins: ['node:path'], modules: {
      'entry.cjs': `const a=require('./leaf.cjs'),b=require('./leaf.cjs');if(require.main===module)process.stdout.write(JSON.stringify({same:a===b,value:a.value,filename:__filename,dirname:__dirname,argv:process.argv.slice(1),workerArgs:process.argv.slice(2)}))`,
      'leaf.cjs': `const path=require('node:path');module.exports={value:path.basename(__filename),main:require.main===module}`,
    },
  })
  const result = cp.spawnSync(process.execPath, ['-e', bundle.bootstrap, '--', 'fixture-entry.cjs', 'one'], { encoding: 'utf8', timeout: 10000 })
  assert.equal(result.status, 0, result.stderr)
  const value = JSON.parse(result.stdout)
  assert.deepEqual({ same: value.same, value: value.value }, { same: true, value: 'leaf.cjs' })
  assert.match(value.filename, /autoprompt-inline[\\/]grok[\\/]entry\.cjs$/u)
  assert.match(value.dirname, /autoprompt-inline[\\/]grok$/u)
  assert.deepEqual(value.argv, ['fixture-entry.cjs', 'one'])
  assert.deepEqual(value.workerArgs, ['one'])
})

test('closed inline CommonJS loader rejects traversal and unexpected builtins at runtime', () => {
  const build = source => buildClosedCommonJsBundle({ entry: 'entry.cjs', allowedBuiltins: ['node:path'], modules: { 'entry.cjs': source } })
  const dynamic = build(`const value=process.env.INLINE_REQUIRE;require(value);process.stdout.write('loaded')`)
  const run = value => cp.spawnSync(process.execPath, ['-e', dynamic.bootstrap], { encoding: 'utf8', timeout: 10000, env: { INLINE_REQUIRE: value } })
  assert.notEqual(run('../escape.cjs').status, 0)
  assert.notEqual(run('node:fs').status, 0)
  assert.equal(run('node:path').status, 0)
  assert.throws(() => buildClosedCommonJsBundle({ entry: '../entry.cjs', modules: { '../entry.cjs': 'module.exports=1' }, allowedBuiltins: [] }), { code: 'GROK_INLINE_BUNDLE_INVALID' })
})

test('Grok inline worker contains exactly the five reviewed leaves within the Windows command bound', () => {
  const result = buildGrokInlineWorker({ nodeExecutable: path.resolve(process.execPath), nodeArgs: ['--no-warnings'], workerArgs: ['--model', 'fixture'] })
  assert.deepEqual(Object.keys(result.moduleSha256).sort(), ['mcp-loopback.cjs', 'model-proxy.cjs', 'sandbox-worker.cjs', 'tool-schema.cjs', 'unix-relay.cjs'])
  assert.deepEqual(result.argv.slice(-3), ['autoprompt-grok-inline-worker.cjs', '--model', 'fixture'])
  assert.equal(result.commandLineUtf16Units, windowsCommandLineUnits(result.executable, result.argv))
  assert.ok(result.commandLineUtf16Units < 30000)
  assert.match(result.payloadSha256, /^[a-f0-9]{64}$/u)
})

test('Grok inline worker accounts for node and worker arguments before refusing an oversized command', () => {
  assert.throws(() => buildGrokInlineWorker({ nodeExecutable: path.resolve(process.execPath), workerArgs: ['x'.repeat(30000)] }), { code: 'GROK_INLINE_BUNDLE_TOO_LARGE' })
  assert.throws(() => buildGrokInlineWorker({ nodeExecutable: path.resolve(process.execPath), nodeArgs: ['--require=host-file.cjs'] }), { code: 'GROK_INLINE_BUNDLE_INVALID' })
  assert.ok(windowsCommandLineUnits('C:\\Program Files\\node.exe', ['-e', 'a b']) > 'C:\\Program Files\\node.exe -e a b'.length)
})

test('Grok inline MCP client executes the reviewed closed bundle and round-trips a real socket', { timeout: 10000 }, async t => {
  const net = require('node:net')
  const server = net.createServer(socket => { socket.on('data', bytes => socket.write(bytes)) })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(() => new Promise(resolve => server.close(resolve)))
  const port = server.address().port
  const bundle = buildGrokInlineMcpClient({ nodeExecutable: path.resolve(process.execPath), port })
  assert.deepEqual(Object.keys(bundle.moduleSha256), ['mcp-loopback.cjs'])
  const child = cp.spawn(bundle.executable, bundle.argv, { stdio: ['pipe', 'pipe', 'pipe'] })
  const output = []; const errors = []
  child.stdout.on('data', bytes => output.push(bytes)); child.stderr.on('data', bytes => errors.push(bytes))
  child.stdin.end('{"roundtrip":true}\n')
  const [code, signal] = await new Promise(resolve => child.once('close', (value, reason) => resolve([value, reason])))
  assert.equal(code, 0, Buffer.concat(errors).toString())
  assert.equal(signal, null)
  assert.equal(Buffer.concat(output).toString(), '{"roundtrip":true}\n')
})
