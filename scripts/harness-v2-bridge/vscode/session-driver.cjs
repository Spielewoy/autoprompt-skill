'use strict'

// Supported extension-host runner entry. This starts a fresh owned VS Code
// process for each assignment; its durable conversations belong to Autoprompt,
// not the user's built-in Chat history. The host exits and drains afterward.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const REQUEST_BASENAME = 'owned-session.json'
const JOURNAL_BASENAME = 'session-driver-phase.jsonl'
const STAGES = new Set(['entry', 'beforeactivation', 'afteractivation', 'channelconnected', 'runSession', 'complete',
  'before-session-setup', 'after-session-persist', 'before-model-select', 'after-model-select', 'before-model-request', 'after-model-request',
  'after-tool-event', 'after-tool-persist',
  'first-before-model-request', 'first-after-model-request', 'next-before-model-request', 'next-after-model-request',
  'first-provider-enter', 'first-provider-before-fetch', 'first-provider-after-headers', 'first-provider-after-body',
  'next-provider-enter', 'next-provider-before-fetch', 'next-provider-after-headers', 'next-provider-after-body'])
const MAX_STAGES = 32

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex') }

function readBoundRequest(file) {
  const before = fs.lstatSync(file)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw Object.assign(new Error('Owned VS Code phase journal request is invalid'), { code: 'PROFILE_INVALID' })
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  try {
    const opened = fs.fstatSync(fd)
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw Object.assign(new Error('Owned VS Code phase journal request changed while opening'), { code: 'PROFILE_INVALID' })
    const bytes = fs.readFileSync(fd)
    const after = fs.lstatSync(file)
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== bytes.length ||
        after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      throw Object.assign(new Error('Owned VS Code phase journal request changed while reading'), { code: 'PROFILE_INVALID' })
    }
    return bytes
  } finally { fs.closeSync(fd) }
}

function errorCode(error) {
  const value = typeof error?.code === 'string' ? error.code : 'CHILD_RUNTIME_FAILURE'
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : 'CHILD_RUNTIME_FAILURE'
}

// The request path is established and byte-bound by the production launch
// descriptor. Its fixed parent is the only place this diagnostic may write;
// it accepts no journal path from the environment or request payload.
function phaseJournal() {
  const requestPath = process.env.AUTOPROMPT_VSCODE_OWNED_REQUEST
  const requestSha256 = process.env.AUTOPROMPT_VSCODE_OWNED_REQUEST_SHA256
  if (typeof requestPath !== 'string' || !path.isAbsolute(requestPath) ||
      path.resolve(requestPath) !== requestPath || path.basename(requestPath) !== REQUEST_BASENAME ||
      typeof requestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(requestSha256)) {
    throw Object.assign(new Error('Owned VS Code phase journal has no bound request parent'), { code: 'PROFILE_INVALID' })
  }
  const parent = fs.lstatSync(path.dirname(requestPath))
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    throw Object.assign(new Error('Owned VS Code phase journal request parent is invalid'), { code: 'PROFILE_INVALID' })
  }
  const bytes = readBoundRequest(requestPath)
  if (sha256(bytes) !== requestSha256) {
    throw Object.assign(new Error('Owned VS Code phase journal request changed before launch'), { code: 'PROFILE_INVALID' })
  }
  const journalPath = path.join(path.dirname(requestPath), JOURNAL_BASENAME)
  const fd = fs.openSync(journalPath, 'wx', 0o600)
  let closed = false
  const recorded = new Set()
  const append = value => {
    if (closed) throw Object.assign(new Error('Owned VS Code phase journal is closed'), { code: 'PROFILE_INVALID' })
    const stage = value?.stage
    if (!(STAGES.has(stage) || stage === 'error') || (stage === 'error' && !/^[A-Z][A-Z0-9_]{0,63}$/.test(value.code || ''))) {
      throw Object.assign(new Error('Owned VS Code phase journal stage is invalid'), { code: 'PROFILE_INVALID' })
    }
    if (recorded.has(stage)) return
    if (recorded.size >= MAX_STAGES) throw Object.assign(new Error('Owned VS Code phase journal exceeds its bounded stage set'), { code: 'PROFILE_INVALID' })
    recorded.add(stage)
    const bytes = Buffer.from(`${JSON.stringify(stage === 'error' ? { stage, code: value.code } : { stage })}\n`, 'utf8')
    fs.writeSync(fd, bytes, 0, bytes.length)
    fs.fsyncSync(fd)
  }
  return Object.freeze({
    path: journalPath,
    stage: name => append({ stage: name }),
    error: error => append({ stage: 'error', code: errorCode(error) }),
    close: () => { if (!closed) { closed = true; fs.closeSync(fd) } },
  })
}

exports.run = async function run() {
  const journal = phaseJournal()
  journal.stage('entry')
  // Fixed non-protocol markers distinguish VS Code test-runner startup from
  // extension activation without exposing request or credential material.
  console.log('AUTOPROMPT_SESSION_DRIVER_ENTERED')
  try {
    const vscode = require('vscode')
    const extension = vscode.extensions.getExtension('autoprompt.autoprompt-native-bridge')
    if (!extension) throw new Error('Owned Autoprompt extension was not discovered')
    journal.stage('beforeactivation')
    console.log('AUTOPROMPT_SESSION_DRIVER_BEFORE_EXTENSION_ACTIVATE')
    const api = await extension.activate()
    journal.stage('afteractivation')
    console.log('AUTOPROMPT_SESSION_DRIVER_AFTER_EXTENSION_ACTIVATE')
    if (!api || typeof api.runOwnedSession !== 'function') throw new Error('Owned Autoprompt extension did not provide a session API')
    const events = require('./event-channel.cjs').connect(api.eventChannel)
    journal.stage('channelconnected')
    let sessionError = null
    try {
      journal.stage('runSession')
      await api.runOwnedSession(event => events.emit(event), stage => journal.stage(stage))
    } catch (error) { sessionError = error }
    await events.complete()
    if (sessionError) throw sessionError
    journal.stage('complete')
  } catch (error) {
    try { journal.error(error) } catch {}
    throw error
  } finally { journal.close() }
}

module.exports = { run: exports.run, phaseJournal, errorCode, JOURNAL_BASENAME }
