'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process')
const { readyRecord, fixtureDigest, SOURCE_SHA, MODES, BASH_WRAPPER } = require('./probe-posix-runtime.cjs')
const ready = { status: 'ready', mode: 'blocked-fifo', phase: 'reader-open-no-completion', childPid: 2345, observationMs: 100 }
test('readiness requires exact bounded owned operation and real positive pid', () => {
  assert.deepEqual(readyRecord(Buffer.from(JSON.stringify(ready) + '\n')), ready)
  assert.equal(readyRecord(Buffer.from(JSON.stringify(ready))), null)
  assert.equal(readyRecord(Buffer.alloc(0)), null)
  for (const value of [{ ...ready, childPid: 0 }, { ...ready, childPid: 1.5 }, { ...ready, childPid: 2 ** 32 }, { ...ready, mode: 'fifo' }, { ...ready, observationMs: 0 }, { ...ready, extra: true }]) assert.throws(() => readyRecord(Buffer.from(JSON.stringify(value) + '\n')))
  for (const bytes of [Buffer.alloc(4097), Buffer.from(JSON.stringify(ready) + '\n{}\n'), Buffer.from(JSON.stringify(ready) + '\n\n')]) assert.throws(() => readyRecord(bytes))
})
test('fixture receipt binds exact source and executable without extra or aliased entries', () => {
  assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'posix-proof.c'))).digest('hex'), SOURCE_SHA)
  const compiler = fs.readFileSync(path.join(__dirname, 'compile-posix-fixture.sh'), 'utf8')
  assert.equal([...compiler.matchAll(/([a-f0-9]{64}) "\$(?:source_file|output\/posix-proof\.c)"/g)].map(match => match[1]).join(','), [SOURCE_SHA, SOURCE_SHA].join(','))
  const correct = SOURCE_SHA + '  posix-proof.c\n' + 'a'.repeat(64) + '  posix-proof.exe\n'
  assert.equal(fixtureDigest(Buffer.from(correct)), 'a'.repeat(64))
  assert.equal(fixtureDigest(Buffer.from(correct.replaceAll('  ', ' *'))), 'a'.repeat(64))
  for (const text of [correct.replaceAll('\n', '\r\n'), correct.replace(SOURCE_SHA, 'b'.repeat(64)), correct.replace('  posix-proof.exe', '  ../posix-proof.exe'), correct.replaceAll('  ', ' x'), correct.replaceAll('  ', '**'), correct + '\n', correct.slice(0, -1)]) assert.throws(() => fixtureDigest(Buffer.from(text)))
  const highBit = Buffer.from(correct); highBit[0] |= 128
  assert.throws(() => fixtureDigest(highBit), /ASCII/)
  assert.equal(MODES.includes('mqueue'), false)
  assert.ok(MODES.indexOf('null') >= 0 && MODES.indexOf('null') < MODES.indexOf('af-local'))
})
test('literal Bash wrapper passes hostile-looking paths as data and executes real host fixture', { skip: process.platform !== 'linux' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "posix proof $literal ' "))
  try {
    const executable = path.join(root, 'fixture $data'), scratch = path.join(root, 'scratch'), output = path.join(scratch, 'output $value')
    const compile = cp.spawnSync('gcc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', path.join(__dirname, 'posix-proof.c'), '-o', executable, '-lrt'], { encoding: 'utf8', timeout: 30000 })
    assert.ifError(compile.error); assert.equal(compile.status, 0, compile.stderr)
    fs.mkdirSync(scratch)
    for (const mode of ['pipe-fork', 'null']) {
      const result = cp.spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', BASH_WRAPPER, '--', output, executable, mode, scratch], { encoding: 'utf8', timeout: 25000 })
      assert.ifError(result.error); assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, ''); assert.equal(result.stderr, '')
      const expected = { status: 'passed', mode, supported: true }
      if (mode === 'null') expected.capabilityRefusals = 0 // Linux cannot prove Win32 locator handling.
      assert.equal(fs.readFileSync(output, 'utf8'), JSON.stringify(expected) + '\n')
    }
    assert.deepEqual(fs.readdirSync(scratch), [path.basename(output)])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
