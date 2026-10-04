'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const p = require('./portable.cjs')
const cli = require('./cli.cjs')
const repository = path.resolve(__dirname, '../../..')

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'portable-cli-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const observedTools = { linkerSha256: '1'.repeat(64), bootstrapRuntimeSha256: '2'.repeat(64) }
  const producer = { repository: 'example/repository', headSha: 'a'.repeat(40),
    runId: '123', runAttempt: 1, jobId: '456', architecture: 'x64' }
  const exported = { schema: 1, producer, observedTools }
  const expected = cli.exportAuthority(repository, exported)
  const archivePath = path.join(root, 'download.zip')
  fs.writeFileSync(archivePath, 'synthetic archive bytes; never extracted or executed')
  const imported = { schema: 1, expected, transport: {
    artifactId: '789', archivePath, archiveSha256: p.hash(fs.readFileSync(archivePath)),
    manifestSha256: '3'.repeat(64),
  } }
  return { root, exported, imported }
}

test('trusted checkout supplies source pins while observed tools remain explicit external inputs', t => {
  const { exported } = fixture(t)
  const expected = cli.exportAuthority(repository, exported)
  assert.equal(expected.bindings.bashSha256, cli.PINNED_BASH)
  assert.equal(expected.bindings.linkerSha256, exported.observedTools.linkerSha256)
  assert.equal(expected.bindings.bootstrapRuntimeSha256, exported.observedTools.bootstrapRuntimeSha256)
  assert.equal(expected.bindings.patchSha256, p.hash(fs.readFileSync(path.join(repository, 'scripts/windows-msys/pipe-security.patch'))))
  assert.deepEqual(expected.producer, exported.producer)
})

test('compiler text normalization matches LF and CRLF inputs but refuses bare CR and invalid UTF8', () => {
  assert.deepEqual(cli.compiledText(Buffer.from('\uFEFFone\r\ntwo\r\n')), Buffer.from('one\ntwo\n'))
  assert.deepEqual(cli.compiledText(Buffer.from('one\ntwo\n')), Buffer.from('one\ntwo\n'))
  assert.throws(() => cli.compiledText(Buffer.from('one\rtwo')))
  assert.throws(() => cli.compiledText(Buffer.from([0xff])))
})

for (const [name, mutate] of [
  ['packet-provided bindings', c => { c.bindings = {} }],
  ['missing observed linker', c => { delete c.observedTools.linkerSha256 }],
  ['native acceptance field', c => { c.accepted = true }],
  ['wrong producer architecture', c => { c.producer.architecture = 'arm64' }],
  ['unbounded run identifier', c => { c.producer.runId = '1'.repeat(21) }],
  ['invalid observed digest', c => { c.observedTools.bootstrapRuntimeSha256 = 'unknown' }],
]) test('export context refuses ' + name, t => {
  const { exported } = fixture(t)
  mutate(exported)
  assert.throws(() => cli.exportAuthority(repository, exported))
})

test('import requires exact externally supplied archive bytes and preserves transport identity', t => {
  const { imported } = fixture(t)
  const result = cli.importAuthority(repository, imported)
  assert.deepEqual(result.expected, imported.expected)
  assert.deepEqual(result.transport, imported.transport)
  assert.equal(Object.isFrozen(result.transport), true)
  fs.appendFileSync(imported.transport.archivePath, 'changed')
  assert.throws(() => cli.importAuthority(repository, imported), /archive digest mismatch/)
})

for (const [name, mutate] of [
  ['different reviewed patch', c => { c.expected.bindings.patchSha256 = 'f'.repeat(64) }],
  ['different pinned Bash', c => { c.expected.bindings.bashSha256 = 'f'.repeat(64) }],
  ['missing artifact ID', c => { delete c.transport.artifactId }],
  ['missing manifest authority', c => { delete c.transport.manifestSha256 }],
  ['relative archive path', c => { c.transport.archivePath = 'download.zip' }],
  ['extra acceptance field', c => { c.nativeAcceptance = 'passed' }],
]) test('import context refuses ' + name, t => {
  const { imported } = fixture(t)
  mutate(imported)
  assert.throws(() => cli.importAuthority(repository, imported))
})

test('context canonicalization refuses duplicate keys and does not discover context from packet', t => {
  const { root, exported } = fixture(t)
  const file = path.join(root, 'context.json')
  fs.writeFileSync(file, p.canonical(exported))
  assert.deepEqual(cli.readContext(file), exported)
  fs.writeFileSync(file, p.canonical(exported).toString().replace('{', '{"schema":1,'))
  assert.throws(() => cli.readContext(file), /Noncanonical or duplicate-key/)
})

test('CLI fails usage with nonzero status and no acceptance-shaped stdout', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'cli.cjs')], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /Candidate transport refused: Usage/)
})

// Exercise the full CLI import route up to its native boundary. Git and the
// native adapter are explicit seams; this is not a Windows execution proof.
for (const scenario of ['replay', 'same-head', 'wrong-checkout', 'wrong-workflow', 'dirty', 'source-drift', 'invalid-head']) {
  test('actual import entry enforces consumer identity: ' + scenario, async t => {
    const { root, imported } = fixture(t)
    const consumer = 'b'.repeat(40), replay = scenario !== 'same-head'
    if (replay) imported.consumerHeadSha = scenario === 'invalid-head' ? 'latest' : consumer
    if (scenario === 'source-drift') imported.expected.bindings.patchSha256 = 'f'.repeat(64)
    const contextPath = path.join(root, 'context.json')
    fs.writeFileSync(contextPath, p.canonical(imported))
    const calls = [], sentinel = new Error('native boundary reached; execution deliberately omitted')
    const module = { exports: {} }, { createRequire } = require('node:module')
    const localRequire = createRequire(path.join(__dirname, 'cli.cjs'))
    const execute = new Function('module', 'exports', 'Buffer', 'process', 'require', fs.readFileSync(path.join(__dirname, 'cli.cjs'), 'utf8'))
    execute(module, module.exports, Buffer, { platform: 'win32', arch: 'x64', env: {
        SystemRoot: path.resolve(root, 'Windows'),
        GITHUB_SHA: scenario === 'wrong-workflow' ? 'c'.repeat(40) : consumer,
      } }, function (name) {
        if (name === 'node:child_process') return { execFileSync(command, args) {
          calls.push(args)
          assert.equal(command, 'git')
          if (args[2] === 'rev-parse') return (scenario === 'wrong-checkout' ? 'c'.repeat(40) : replay ? consumer : imported.expected.producer.headSha) + '\n'
          assert.equal(args[2], 'diff')
          if (scenario === 'dirty') throw new Error('dirty checkout')
          return ''
        } }
        if (name === './native-adapter.cjs') return { nativeAdapter() { throw sentinel } }
        return localRequire(name)
      })
    const expected = ['replay', 'same-head'].includes(scenario) ? sentinel
      : scenario === 'wrong-checkout' ? /Trusted checkout must match/
      : scenario === 'wrong-workflow' ? /Workflow SHA must match/
      : scenario === 'dirty' ? /dirty checkout/
      : scenario === 'source-drift' ? /Consumer checkout differs/
      : /Expected a recorded consumer head/
    await assert.rejects(module.exports.main(['import', repository, root, contextPath, path.join(root, 'output')]), expected)
    assert.equal(fs.existsSync(path.join(root, 'output')), false)
    if (['replay', 'same-head'].includes(scenario)) assert.deepEqual(calls.map(args => args[2]), ['rev-parse', 'diff'])
  })
}
