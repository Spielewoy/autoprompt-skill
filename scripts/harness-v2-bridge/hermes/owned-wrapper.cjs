#!/usr/bin/env node
'use strict'
// Streams bounded, journal-backed Hermes progress while the owned child is live,
// then emits one authoritative terminal receipt after it exits.
const fs = require('node:fs'), cp = require('node:child_process'), path = require('node:path')
const arg = process.argv[2] === '--spec' ? process.argv[3] : null
if (!arg || !path.isAbsolute(arg)) throw new Error('Use --spec <absolute-file>')
const spec = JSON.parse(fs.readFileSync(arg, 'utf8'))
const db = path.join(spec.home, 'state.db')
if (!path.isAbsolute(spec.toolProjectionPath || '')) throw new Error('Hermes tool projection path is invalid')
const boundary = require('../../harness-v2-tool-boundary.cjs')
const sql = `import json,sqlite3,sys
from pathlib import Path
try:
    p=Path(sys.argv[1]).resolve().as_uri()+'?mode=ro'; sid=sys.argv[2] if len(sys.argv)>2 else None
    c=sqlite3.connect(p,uri=True)
    ids=[r[0] for r in c.execute('select id from sessions order by started_at desc')]
    if sid is None and ids: sid=ids[0]
    r=c.execute('select input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,api_call_count,tool_call_count,estimated_cost_usd,actual_cost_usd,cost_status,cost_source from sessions where id=?',(sid,)).fetchone() if sid else None
    a=c.execute("select content from messages where session_id=? and role='assistant' and active=1 order by id desc limit 1",(sid,)).fetchone() if sid else None
    m=c.execute('select max(id) from messages where session_id=?',(sid,)).fetchone()[0] if sid else None
    print(json.dumps({'sessionId':sid,'sessionIds':ids,'usage':r,'answer':a[0] if a else None,'maxMessageId':m or 0}))
except sqlite3.Error as error:
    print(json.dumps({'__autoprompt_sqlite_error__': {'class': type(error).__name__, 'code': getattr(error, 'sqlite_errorcode', None)}}))
    raise SystemExit(17)`
function validCounter(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Hermes ${label} counter is invalid`)
}
function validUsage(usage) {
  if (!Array.isArray(usage) || usage.length !== 11) throw new Error('Hermes usage journal row has an unexpected shape')
  for (const [index, label] of [[0, 'input'], [1, 'output'], [2, 'cached input'], [3, 'cached write'], [4, 'reasoning'], [5, 'API'], [6, 'tool']]) validCounter(usage[index], label)
  for (const index of [7, 8]) if (usage[index] !== null && (typeof usage[index] !== 'number' || !Number.isFinite(usage[index]) || usage[index] < 0)) throw new Error('Hermes cost journal value is invalid')
  for (const index of [9, 10]) if (usage[index] !== null && typeof usage[index] !== 'string') throw new Error('Hermes cost journal source is invalid')
}
function snapshotDiagnostic(result) {
  let sqlite = null
  const sqliteClasses = new Set(['DatabaseError', 'OperationalError', 'IntegrityError', 'ProgrammingError', 'InterfaceError', 'NotSupportedError', 'Warning', 'Error'])
  try {
    const value = JSON.parse(String(result.stdout || ''))
    const candidate = value && value.__autoprompt_sqlite_error__
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate) &&
        sqliteClasses.has(candidate.class) &&
        (candidate.code === null || (Number.isSafeInteger(candidate.code) && candidate.code >= 0 && candidate.code <= 0x7fffffff))) {
      sqlite = { class: candidate.class, code: candidate.code }
    }
  } catch {}
  return JSON.stringify({
    status: result.status,
    signal: result.signal,
    errorCode: result.error?.code || null,
    sqlite,
  })
}
function snapshot(id) {
  if (!fs.existsSync(db)) {
    if (id) throw new Error('Hermes continuation session journal is missing')
    return { sessionId: null, sessionIds: [], usage: null, answer: null }
  }
  const r = cp.spawnSync(spec.pythonExecutable, ['-c', sql, db, ...(id ? [id] : [])], { encoding: 'utf8', timeout: 2000, maxBuffer: 1024 * 1024 })
  if (r.error || r.status !== 0) throw new Error(`Hermes SQLite journal snapshot failed: ${snapshotDiagnostic(r)}`)
  let value
  try { value = JSON.parse(r.stdout) } catch { throw new Error('Hermes SQLite journal snapshot is invalid') }
  if (!Array.isArray(value.sessionIds) || !Number.isSafeInteger(value.maxMessageId) || value.maxMessageId < 0) throw new Error('Hermes SQLite session inventory is invalid')
  if (value.sessionId !== null) {
    if (typeof value.sessionId !== 'string' || !value.sessionId) throw new Error('Hermes session identity is invalid')
    validUsage(value.usage)
  } else if (id) throw new Error('Hermes continuation session does not exist')
  return value
}
function messageSnapshot(sessionId, afterId) {
  if (!identity(sessionId) || !Number.isSafeInteger(afterId) || afterId < 0) throw new Error('Hermes message observer identity is invalid')
  const source = `import json,sqlite3,sys
from pathlib import Path
try:
    p,sid,after=Path(sys.argv[1]).resolve().as_uri()+'?mode=ro',sys.argv[2],int(sys.argv[3])
    c=sqlite3.connect(p,uri=True)
    r=c.execute("select id,role,content from messages where session_id=? and active=1 and role in ('assistant','tool') and id>? order by id asc",(sid,after)).fetchall()
    print(json.dumps(r))
except sqlite3.Error as error:
    print(json.dumps({'__autoprompt_sqlite_error__': {'class': type(error).__name__, 'code': getattr(error, 'sqlite_errorcode', None)}}))
    raise SystemExit(17)`
  const result = cp.spawnSync(spec.pythonExecutable, ['-c', source, db, sessionId, String(afterId)], { encoding: 'utf8', timeout: 2000, maxBuffer: 4 * 1024 * 1024 })
  if (result.error || result.status !== 0) throw new Error(`Hermes SQLite message observer failed: ${snapshotDiagnostic(result)}`)
  let rows; try { rows = JSON.parse(result.stdout) } catch { throw new Error('Hermes SQLite message observer is invalid') }
  if (!Array.isArray(rows) || rows.length > 1024) throw new Error('Hermes SQLite message observer is invalid')
  let last = afterId
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== 3 || !Number.isSafeInteger(row[0]) || row[0] <= last || !['assistant', 'tool'].includes(row[1]) || typeof row[2] !== 'string' || Buffer.byteLength(row[2]) > 1024 * 1024) throw new Error('Hermes SQLite message observer is invalid')
    last = row[0]
  }
  return rows
}
function identity(value) { return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(value) }
function receipts(live = false) {
  if (!fs.existsSync(spec.receiptPath)) return []
  let source
  try { source = fs.readFileSync(spec.receiptPath, 'utf8') } catch { throw new Error('Hermes receipt journal could not be read') }
  if (source && !source.endsWith('\n')) {
    if (!live) throw new Error('Hermes receipt journal has an incomplete append')
    source = source.slice(0, source.lastIndexOf('\n') + 1)
  }
  const lines = source.split('\n').filter(Boolean)
  try {
    return lines.map(line => {
      const hash = JSON.parse(line).hash
      if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('invalid hash')
      return hash
    })
  } catch { throw new Error('Hermes receipt journal is invalid') }
}
function projections(live = false) {
  let stat
  try { stat = fs.lstatSync(spec.toolProjectionPath) } catch { throw new Error('Hermes tool projection journal is missing') }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 32 * 2 * 1024 * 1024) throw new Error('Hermes tool projection journal is invalid')
  let source
  try { source = fs.readFileSync(spec.toolProjectionPath, 'utf8') } catch { throw new Error('Hermes tool projection journal could not be read') }
  if (source && !source.endsWith('\n')) {
    if (!live) throw new Error('Hermes tool projection journal has an incomplete append')
    source = source.slice(0, source.lastIndexOf('\n') + 1)
  }
  const lines = source.split('\n').filter(Boolean)
  if (lines.length > 1024) throw new Error('Hermes tool projection journal exceeds its bounded record count')
  let previous = null
  return lines.map((line, index) => {
    let record
    try { record = JSON.parse(line) } catch { throw new Error('Hermes tool projection journal is invalid') }
    const { hash, ...body } = record || {}
    if (!record || Object.keys(record).length !== 7 || body.sequence !== index + 1 || body.previous !== previous ||
        !/^[a-f0-9]{64}$/.test(body.receiptHash || '') || !['read', 'list', 'search', 'write', 'edit', 'bash'].includes(body.name) ||
        !body.args || typeof body.args !== 'object' || Array.isArray(body.args) || typeof body.output !== 'string' ||
        Buffer.byteLength(body.output) > 4 * 1024 * 1024 || hash !== boundary.sha256(boundary.canonicalJson(body))) {
      throw new Error('Hermes tool projection journal is invalid')
    }
    previous = hash
    return record
  })
}
function failRun(message, output = '') {
  if (done) return
  done = true
  process.stderr.write(`${message}${output ? `\n${output}` : ''}`)
  process.exitCode = 1
}
const before = spec.continuationId ? snapshot(spec.continuationId) : snapshot(null)
const beforeReceipts = receipts()
const knownReceiptHashes = [...beforeReceipts]
const knownProjections = projections()
if (knownProjections.length !== beforeReceipts.length || knownProjections.some((record, index) => record.receiptHash !== beforeReceipts[index])) throw new Error('Hermes prior tool projection journal differs from receipt ledger')
let out = '', err = '', done = false, observerError = null, observed = false
let observedSession = spec.continuationId || null, observedMessageId = before.maxMessageId || 0
let observedUsage = null
const priorUsage = before?.usage || [0, 0, 0, 0, 0, 0, 0, null, null, null, null]
const usageDelta = current => {
  validUsage(current)
  const fields = ['input', 'output', 'cachedInput', 'cachedWrite', 'reasoning', 'apiCalls', 'toolCalls']
  return Object.fromEntries(fields.map((key, index) => { const value = current[index] - (priorUsage[index] ?? 0); validCounter(value, `${key} delta`); return [key, value] }))
}
const failObserver = error => {
  if (observerError || done) return
  observerError = error instanceof Error ? error : new Error(String(error))
  try { process.kill(child.pid, 'SIGTERM') } catch {}
}
const poll = () => {
  try {
    const current = snapshot(observedSession || null)
    if (!observedSession && current.sessionId) {
      if (before.sessionIds.includes(current.sessionId)) throw new Error('Hermes live observer reused an existing session')
      observedSession = current.sessionId; observedMessageId = 0
    }
    if (!observedSession) return
    if (current.sessionId && current.sessionId !== observedSession) throw new Error('Hermes live observer session changed')
    if (current.usage) {
      const usage = usageDelta(current.usage)
      if (JSON.stringify(usage) !== JSON.stringify(observedUsage)) {
        process.stdout.write(JSON.stringify({ type: 'hermes', event: 'usage', sessionId: observedSession, usage }) + '\n')
        observedUsage = usage; observed = true
      }
    }
    const currentReceiptHashes = receipts(true)
    if (currentReceiptHashes.length < knownReceiptHashes.length || knownReceiptHashes.some((hash, index) => currentReceiptHashes[index] !== hash)) {
      throw new Error('Hermes controller receipt journal regressed')
    }
    const currentProjections = projections(true)
    if (currentProjections.length < knownProjections.length || knownProjections.some((record, index) => currentProjections[index].hash !== record.hash)) {
      throw new Error('Hermes controller tool projection journal regressed')
    }
    const common = Math.min(currentReceiptHashes.length, currentProjections.length)
    if (currentProjections.slice(0, common).some((record, index) => record.receiptHash !== currentReceiptHashes[index])) throw new Error('Hermes controller tool projection differs from receipt ledger')
    if (knownReceiptHashes.length !== knownProjections.length || common < knownReceiptHashes.length) throw new Error('Hermes controller tool projection journal regressed')
    const newProjections = currentProjections.slice(knownProjections.length, common)
    const newReceiptHashes = currentReceiptHashes.slice(knownReceiptHashes.length, common)
    for (const projection of newProjections) {
      process.stdout.write(JSON.stringify({ type: 'hermes', event: 'tool_projection', sessionId: observedSession, projection }) + '\n')
      knownProjections.push(projection); observed = true
    }
    if (newReceiptHashes.length) {
      process.stdout.write(JSON.stringify({ type: 'hermes', event: 'tool_receipts', sessionId: observedSession, receiptStart: knownReceiptHashes.length, toolReceiptHashes: newReceiptHashes }) + '\n')
      knownReceiptHashes.push(...newReceiptHashes); observed = true
    }
    const rows = messageSnapshot(observedSession, observedMessageId)
    for (const [id, role, content] of rows) {
      process.stdout.write(JSON.stringify({ type: 'hermes', event: 'intermediate', sessionId: observedSession, id, role, content }) + '\n')
      observedMessageId = id; observed = true
    }
  } catch (error) {
    // SQLite and its tables do not exist until Hermes initializes. Once any
    // valid live snapshot has been observed, a later failure is tampering or a
    // broken observer and must terminate the owned child.
    if (observed || observedSession) failObserver(error)
  }
}
const child = cp.spawn(spec.hermesExecutable, spec.argv, { cwd: spec.sessionRoot, env: process.env, detached: false, stdio: ['ignore', 'pipe', 'pipe'] })
const observer = setInterval(poll, 300); observer.unref?.()
poll()
for (const stream of [child.stdout, child.stderr]) stream.on('data', b => { const s = b.toString(); if (stream === child.stdout) out = (out + s).slice(-1048576); else err = (err + s).slice(-1048576) })
// The wrapper is itself the process-owner's group root. Keep Hermes in that
// same group so owner-level TERM/KILL cannot orphan a detached descendant;
// forward a graceful signal to the direct child as well for prompt shutdown.
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  // A cancellation can arrive after Hermes committed an upstream request but
  // before its child has emitted a terminal answer. Read the authoritative
  // journal once before forwarding the signal so already-paid usage is not
  // silently discarded. poll() emits nothing unless the SQLite row validates.
  poll()
  try { process.kill(child.pid, signal) } catch {}
})
child.on('error', error => failRun(`Hermes child spawn failed: ${error.message}`, err || out))
child.on('close', (status, signal) => {
  if (status === 0 && !signal) poll()
  clearInterval(observer)
  if (done) return
  if (observerError) return failRun(observerError.message, err || out)
  if (status !== 0 || signal) return failRun('Hermes child exited unsuccessfully', err || out)
  try {
    const after = snapshot(spec.continuationId || null)
    if (!after.sessionId || after.answer === null) throw new Error('Hermes child produced no completed journal answer')
    if (!spec.continuationId && before.sessionIds.includes(after.sessionId)) throw new Error('Hermes initial launch reused an existing session')
    if (spec.continuationId && after.sessionId !== spec.continuationId) throw new Error('Hermes continuation session identity changed')
    const prior = priorUsage
    if (before?.usage) validUsage(prior)
    const delta = usageDelta(after.usage)
    const terminalReceiptHashes = receipts()
    if (terminalReceiptHashes.length !== knownReceiptHashes.length || terminalReceiptHashes.some((hash, index) => knownReceiptHashes[index] !== hash)) throw new Error('Hermes controller receipt journal changed after observation')
    const toolReceiptHashes = terminalReceiptHashes.slice(beforeReceipts.length)
    const terminalProjections = projections()
    if (terminalProjections.length !== terminalReceiptHashes.length || terminalProjections.some((record, index) => record.receiptHash !== terminalReceiptHashes[index])) throw new Error('Hermes controller tool projection differs from receipt ledger')
    if (terminalProjections.length !== knownProjections.length || terminalProjections.some((record, index) => record.hash !== knownProjections[index].hash)) throw new Error('Hermes controller tool projection changed after observation')
    if (toolReceiptHashes.length !== delta.toolCalls) throw new Error('Hermes tool journal differs from controller receipts')
    const money = index => {
      if (after.usage[index] === null || after.usage[index] === undefined || prior[index] === null || prior[index] === undefined) return null
      const value = after.usage[index] - prior[index]
      if (!Number.isFinite(value) || value < 0) throw new Error('Hermes cost journal regressed')
      return value
    }
    done = true
    process.stdout.write(JSON.stringify({ type: 'hermes', event: 'final', status, signal, sessionId: after.sessionId, answer: after.answer, receiptStart: beforeReceipts.length, toolReceiptHashes, usage: { ...delta, estimatedCostUsd: money(7), actualCostUsd: money(8), costStatus: after.usage[9], costSource: after.usage[10] } }) + '\n')
    process.exitCode = 0
  } catch (error) { failRun(error.message, err || out) }
})
