'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const crypto = require('node:crypto')
const { phaseJournal, errorCode, JOURNAL_BASENAME } = require('../../scripts/harness-v2-bridge/vscode/session-driver.cjs')

function withRequest(t, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-vscode-session-driver-'))
  fs.chmodSync(root, 0o700)
  const request = path.join(root, 'owned-session.json')
  const requestBytes = Buffer.from('{}')
  fs.writeFileSync(request, requestBytes, { flag: 'wx', mode: 0o600 })
  const previous = process.env.AUTOPROMPT_VSCODE_OWNED_REQUEST
  const previousHash = process.env.AUTOPROMPT_VSCODE_OWNED_REQUEST_SHA256
  process.env.AUTOPROMPT_VSCODE_OWNED_REQUEST = request
  process.env.AUTOPROMPT_VSCODE_OWNED_REQUEST_SHA256 = crypto.createHash('sha256').update(requestBytes).digest('hex')
  t.after(() => {
    if (previous === undefined) delete process.env.AUTOPROMPT_VSCODE_OWNED_REQUEST
    else process.env.AUTOPROMPT_VSCODE_OWNED_REQUEST = previous
    if (previousHash === undefined) delete process.env.AUTOPROMPT_VSCODE_OWNED_REQUEST_SHA256
    else process.env.AUTOPROMPT_VSCODE_OWNED_REQUEST_SHA256 = previousHash
    fs.rmSync(root, { recursive: true, force: true })
  })
  return fn({ root, request })
}

test('VS Code session driver writes fixed phases beneath the byte-bound request parent', t => withRequest(t, ({ root }) => {
  const journal = phaseJournal()
  journal.stage('entry')
  journal.stage('beforeactivation')
  journal.stage('before-model-request')
  for (let i = 0; i < 1000; i++) journal.stage('before-model-request')
  assert.throws(() => journal.stage('request-secret'), error => error.code === 'PROFILE_INVALID')
  journal.error({ code: 'VSCODE_EVENT_CHANNEL_FAILED' })
  journal.close()
  assert.throws(() => phaseJournal(), error => error?.code === 'EEXIST')
  const file = path.join(root, JOURNAL_BASENAME)
  const stat = fs.lstatSync(file)
  assert.equal(stat.isFile(), true)
  assert.equal(stat.isSymbolicLink(), false)
  if (process.platform !== 'win32') assert.equal(stat.mode & 0o077, 0)
  assert.deepEqual(fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse), [
    { stage: 'entry' }, { stage: 'beforeactivation' }, { stage: 'before-model-request' }, { stage: 'error', code: 'VSCODE_EVENT_CHANNEL_FAILED' },
  ])
}))

test('VS Code session driver refuses unbound request paths and bounds error codes', t => {
  const previous = process.env.AUTOPROMPT_VSCODE_OWNED_REQUEST
  delete process.env.AUTOPROMPT_VSCODE_OWNED_REQUEST
  t.after(() => { if (previous !== undefined) process.env.AUTOPROMPT_VSCODE_OWNED_REQUEST = previous })
  assert.throws(() => phaseJournal(), error => error?.code === 'PROFILE_INVALID')
  assert.equal(errorCode({ code: 'BAD\nCODE' }), 'CHILD_RUNTIME_FAILURE')
  assert.equal(errorCode({ code: 'OWNED_SESSION_FAILED' }), 'OWNED_SESSION_FAILED')
})
