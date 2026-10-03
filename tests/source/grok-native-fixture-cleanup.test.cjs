'use strict'

const assert = require('node:assert/strict')
const cp = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

test('Grok native fixture retires its listening server after pre-owner setup failure', { skip: process.platform === 'win32', timeout: 15000 }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-fixture-failure-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const preload = path.join(root, 'refuse-runtime.cjs')
  const nativeModule = require.resolve('../../scripts/harness-v2-native.cjs')
  fs.writeFileSync(preload, `require(${JSON.stringify(nativeModule)}).probeExecutable = () => { throw Object.assign(new Error('FIXTURE_SETUP_REFUSED'), {code:'FIXTURE_SETUP_REFUSED'}) }\n`)
  const environment = { ...process.env, AUTOPROMPT_GROK_TEST_CLI: process.execPath, TMPDIR: root, TMP: root, TEMP: root }
  delete environment.NODE_TEST_CONTEXT
  for (const key of Object.keys(environment)) if (key.startsWith('AUTOPROMPT_CLOSED_CANARY_')) delete environment[key]
  const result = cp.spawnSync(process.execPath, ['--require', preload, '--test',
    '--test-name-pattern=^grok closed native capability: model and effort',
    path.join(__dirname, 'harness-v2-grok-capability-native.test.cjs')], {
    env: environment, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
  })
  assert.equal(result.error, undefined, 'a failed fixture left a listener keeping the child alive')
  assert.equal(result.signal, null)
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stdout + result.stderr, /FIXTURE_SETUP_REFUSED/)
})
