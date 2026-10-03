'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const cp = require('node:child_process')
const { scenarios, observation, quote } = require('./probe.cjs')
test('entropy comparison isolates shell invocation and optional System32 PATH', () => {
  const all = scenarios('C:\\owned\\usr\\bin', 'C:\\Windows')
  assert.deepEqual(all.slice(0, 2).map(c => c.name), ['minimal-direct-entropy', 'minimal-direct-node'])
  assert.ok(all.slice(0, 2).every(c => c.minimal))
  const list = all.slice(2)
  assert.deepEqual(list.map(c => c.name), ['direct-entropy', 'bash-entropy', 'direct-node', 'bash-node', 'direct-node-system-path', 'bash-node-system-path'])
  for (let i = 0; i < list.length; i += 2) assert.equal(list[i].path, list[i + 1].path)
  assert.equal(list[0].path, list[2].path)
  assert.ok(list[4].path.startsWith(list[2].path + ';'))
  assert.deepEqual(list[2].args, list[4].args)
  assert.deepEqual(list[3].args, list[5].args)
})
test('actual shell quoting preserves JS backslashes and apostrophes', { skip: process.platform === 'win32' }, () => {
  const code = "process.stdout.write(\"quoted'node\\n\")"
  const result = cp.spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', [process.execPath, '-e', code].map(quote).join(' ')], { encoding: 'utf8', timeout: 5000 })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, "quoted'node\n")
  assert.equal(result.stderr, '')
})
test('Node diagnostic requires exact success effect but preserves actual bounded failure', () => {
  const item = { name: 'direct-node' }, evidence = { stdout: Buffer.from('node-entropy-ok\n'), stderr: Buffer.alloc(0), exitCode: 0, launcherSessionId: 2 }
  assert.equal(observation(item, evidence, 'profile').status, 'observed-not-accepted')
  assert.throws(() => observation(item, { ...evidence, stdout: Buffer.from('other') }, 'profile'))
  const failed = observation(item, { ...evidence, stdout: Buffer.alloc(0), stderr: Buffer.from('actual startup failure'), exitCode: 134 }, 'profile')
  assert.equal(failed.exitCode, 134)
  assert.equal(Buffer.from(failed.stderrBase64, 'base64').toString(), 'actual startup failure')
})
for (const field of ['timedOut', 'truncated', 'cancelled']) test('incomplete observation refuses ' + field, () => {
  assert.throws(() => observation({ name: 'direct-node' }, { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 134, [field]: true }, 'profile'))
})
