'use strict'
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { helperCall } = require('../../agents/codex/workflow/darwin-launchd-process.js')

function helper(t, responses) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-helper-query-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'helper'), counter = path.join(root, 'counter')
  const bytes = `#!${fs.realpathSync.native(process.execPath)}\nconst fs=require('node:fs');const counter=${JSON.stringify(counter)},responses=${JSON.stringify(responses)};const n=fs.existsSync(counter)?Number(fs.readFileSync(counter)):0;fs.writeFileSync(counter,String(n+1));const response=responses[Math.min(n,responses.length-1)];process.stdout.write(JSON.stringify(response));process.exitCode=response.ok?0:74;\n`
  fs.writeFileSync(file, bytes, { mode: 0o700 })
  return { binding: { path: file, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }, calls: () => Number(fs.readFileSync(counter)) }
}
const bootUuid = '12345678-1234-1234-1234-123456789abc'
const failed = { schemaVersion: 1, ok: false, bootUuid, command: 'census', resourceCoalitionId: '100', complete: false,
  members: [], errors: [{ pid: 99, phase: 'bind-before', result: 0, errno: 3 }] }
const complete = { ...failed, ok: true, complete: true, errors: [], members: [{ pid: 101, pidVersion: 8 }] }

test('Darwin census retries an exited snapshot member and returns only a complete fresh census', { skip: process.platform === 'win32' }, t => {
  const f = helper(t, [failed, complete])
  assert.deepEqual(helperCall(f.binding, ['census', '100']), complete)
  assert.equal(f.calls(), 2)
})
test('Darwin census keeps permission failure and persistent churn fail-closed', { skip: process.platform === 'win32' }, t => {
  const denied = helper(t, [{ ...failed, errors: [{ ...failed.errors[0], errno: 1 }] }])
  assert.throws(() => helperCall(denied.binding, ['census', '100']), { code: 'PROCESS_OBSERVATION_FAILED' })
  assert.equal(denied.calls(), 1)
  const churn = helper(t, [failed])
  const started = Date.now()
  assert.throws(() => helperCall(churn.binding, ['census', '100']), { code: 'PROCESS_OBSERVATION_FAILED' })
  assert.ok(churn.calls() > 1 && churn.calls() <= 40)
  assert.ok(Date.now() - started >= 1800, 'transient reaping retries must use the bounded observation interval')
})
test('Darwin census retries cannot cross a boot session or accept a foreign coalition', { skip: process.platform === 'win32' }, t => {
  const changed = helper(t, [failed, { ...complete, bootUuid: '12345678-1234-1234-1234-123456789abd' }])
  assert.throws(() => helperCall(changed.binding, ['census', '100']), { code: 'PROCESS_IDENTITY_CHANGED' })
  const foreign = helper(t, [{ ...failed, resourceCoalitionId: '101' }])
  assert.throws(() => helperCall(foreign.binding, ['census', '100']), { code: 'PROCESS_OBSERVATION_FAILED' })
  assert.equal(foreign.calls(), 1)
})
