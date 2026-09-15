'use strict'
// Diagnostic-only physical capture. No runtime selection or materialization.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const cp = require('node:child_process')
const os = require('node:os')
const { ensureWindowsPrivateAcl } = require('../../../agents/codex/workflow/safe-run-root.js')

function need(ok, code) { if (!ok) throw Error(code) }
function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex') }
function readBounded(file, max) {
  const fd = fs.openSync(file, 'r')
  try {
    const bytes = Buffer.alloc(max + 1)
    let at = 0, count
    while (at < bytes.length && (count = fs.readSync(fd, bytes, at, bytes.length - at, null)) > 0) at += count
    need(at <= max, 'input-byte-bound')
    return bytes.subarray(0, at)
  } finally { fs.closeSync(fd) }
}
function relative(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.split('/').every(part =>
    part.length <= 96 && /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:$|\.)/.test(part))
}
function validateFiles(files) {
  need(Array.isArray(files) && files.length > 0 && files.length <= 129, 'inventory-bound')
  const seen = new Set()
  let total = 0
  const captured = files.map(file => {
    need(file && Object.keys(file).sort().join(',') === 'length,path,sha256', 'closed-file-record')
    need(relative(file.path) && !seen.has(file.path), 'inventory-path-refused')
    need(Number.isSafeInteger(file.length) && file.length >= 0 && file.length <= 16 * 1024 * 1024, 'proof-file-bound')
    need(typeof file.sha256 === 'string' && /^[a-f0-9]{64}$/.test(file.sha256), 'file-hash-required')
    total += file.length
    seen.add(file.path)
    return Object.freeze({ ...file })
  })
  need(total <= 32 * 1024 * 1024 && seen.has('manifest.json'), 'proof-total-or-manifest-bound')
  return Object.freeze(captured)
}

function helperEnvironment(systemRoot, helperRoot) {
  return Object.freeze({ SystemRoot: systemRoot, WINDIR: systemRoot, SystemDrive: systemRoot.slice(0, 2),
    PATH: path.win32.join(systemRoot, 'System32'), PSModulePath: '', TEMP: helperRoot, TMP: helperRoot })
}

class Session {
  constructor(root, child) {
    this.root = root
    this.child = child
    this.phase = 'starting'
    this.calls = 0
    this.closed = false
    this.code = null
  }
  outputLine(line) {
    if (line === 'bundle-lease-ready-v1' && this.phase === 'starting') this.phase = 'ready'
    else if (line === 'bundle-lease-finished-v1' && this.phase === 'finishing') this.phase = 'finished'
    else throw Error('lease-protocol')
  }
  audit(root) {
    need(this.phase === 'ready' && !this.closed && this.child.exitCode === null && root === this.root && ++this.calls <= 2, 'lease-not-held')
    return true
  }
  finish() {
    need(this.phase === 'ready' && this.calls === 2 && !this.closed, 'capture-incomplete')
    this.phase = 'finishing'
  }
  close(code) { this.closed = true; this.code = code }
  accepted() {
    need(this.phase === 'finished' && this.closed && this.code === 0 && this.calls === 2, 'native-lease-not-confirmed')
  }
}

function captureHeldFiles(root, files, audit) {
  audit(root)
  const captured = []
  for (const file of files) {
    const name = path.join(root, ...file.path.split('/'))
    const fd = fs.openSync(name, fs.constants.O_RDONLY)
    try {
      const before = fs.fstatSync(fd, { bigint: true })
      need(before.isFile() && before.nlink === 1n && before.size === BigInt(file.length), 'capture-file-identity')
      const bytes = Buffer.alloc(file.length)
      let at = 0
      while (at < bytes.length) {
        const count = fs.readSync(fd, bytes, at, bytes.length - at, at)
        need(count > 0, 'capture-truncated')
        at += count
      }
      need(fs.readSync(fd, Buffer.alloc(1), 0, 1, bytes.length) === 0, 'capture-grew')
      const after = fs.fstatSync(fd, { bigint: true }), current = fs.lstatSync(name, { bigint: true })
      for (const key of ['dev', 'ino', 'nlink', 'size', 'mtimeNs', 'ctimeNs']) {
        need(before[key] === after[key] && after[key] === current[key], 'capture-file-changed')
      }
      need(digest(bytes) === file.sha256, 'capture-digest-mismatch')
      captured.push(Object.freeze({ path: file.path, bytes }))
    } finally { fs.closeSync(fd) }
  }
  audit(root)
  return Object.freeze(captured)
}

// testHooks are only for this diagnostic: they can interrupt or corrupt its
// protocol but cannot grant authority or replace the real native audit.
async function captureForProof(root, files, authority, testHooks = {}) {
  need(process.platform === 'win32', 'native-windows-required')
  files = validateFiles(files)
  need(authority && Object.keys(authority).sort().join(',') === 'driverSha256,sourceSha256,systemRoot', 'helper-authority-required')
  need(Object.keys(testHooks).every(key => ['atReady', 'afterCapture', 'finishLine'].includes(key)), 'unknown-proof-hook')
  const sourceBytes = readBounded(path.join(__dirname, 'audit.cs'), 24000)
  const driverBytes = readBounded(path.join(__dirname, 'driver.ps1'), 8000)
  for (const [bytes, hash] of [[sourceBytes, authority.sourceSha256], [driverBytes, authority.driverSha256]]) {
    need(typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash) && digest(bytes) === hash, 'helper-authority-mismatch')
  }
  const win = authority.systemRoot
  need(typeof win === 'string' && /^[a-z]:\\windows$/i.test(win), 'system-root-required')
  const powershell = path.join(win, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  // Add-Type/csc must not fall back to WINDIR for temporary output. This root
  // is exclusively created for the controller and never part of its bundle.
  const helperRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-lease-control-')))
  try {
    const inside = path.relative(root, helperRoot)
    need(inside && (inside === '..' || inside.startsWith('..' + path.sep) || path.isAbsolute(inside)), 'helper-temp-inside-bundle')
    ensureWindowsPrivateAcl(helperRoot)
  } catch (problem) {
    problem.retainedHelperRoot = helperRoot
    problem.cleanupConfirmed = false
    throw problem
  }
  const child = cp.spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(driverBytes.toString('utf8'), 'utf16le').toString('base64')], {
    windowsHide: true, shell: false,
    env: helperEnvironment(win, helperRoot), cwd: helperRoot,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const session = new Session(root, child)
  let pending = '', error = null, stderr = 0, readyResolve, readyReject, closeResolve, closeTimer, stopReject
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  const closed = new Promise(resolve => { closeResolve = resolve })
  const stopped = new Promise((_, reject) => { stopReject = reject })
  stopped.catch(() => {}) // The first failure can precede an optional hook.
  function fail(problem) {
    if (error) return
    error = problem
    readyReject(problem)
    stopReject(problem)
    try { child.kill() } catch {}
  }
  const timer = setTimeout(() => fail(Error('lease-deadline')), 60000)
  child.on('error', fail)
  child.stdin.on('error', fail)
  child.stderr.on('data', bytes => { stderr += bytes.length; if (stderr > 1024) fail(Error('lease-stderr-bound')) })
  child.stdout.on('data', bytes => {
    try {
      need(bytes.every(value => value < 128) && bytes.length + pending.length <= 256, 'lease-stdout-bound')
      pending += bytes.toString('ascii')
      let at
      while ((at = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, at).replace(/\r$/, '')
        pending = pending.slice(at + 1)
        session.outputLine(line)
        if (session.phase === 'ready') readyResolve()
      }
    } catch (problem) { fail(problem) }
  })
  child.on('close', code => {
    session.close(code)
    if (session.phase === 'starting') readyReject(Error('lease-closed-before-ready'))
    closeResolve()
  })
  child.stdin.write(sourceBytes.toString('base64') + '\n' + JSON.stringify({ root, files: files.map(file => file.path) }) + '\n')
  // Hooks have no ability to synthesize native output or callback success.
  const control = Object.freeze({ terminate: () => child.kill(), closed, helperRoot })
  try {
    await ready
    if (error) throw error
    if (testHooks.atReady) await Promise.race([testHooks.atReady(control), stopped])
    const captured = captureHeldFiles(root, files, value => session.audit(value))
    if (testHooks.afterCapture) await Promise.race([testHooks.afterCapture(control), stopped])
    session.finish()
    child.stdin.end((testHooks.finishLine === undefined ? 'finish' : testHooks.finishLine) + '\n')
    await Promise.race([closed, stopped, new Promise((_, reject) => { closeTimer = setTimeout(() => reject(Error('lease-close-unconfirmed')), 65000) })])
    if (error) throw error
    need(stderr === 0 && pending === '', 'lease-output-refused')
    session.accepted()
    return captured
  } catch (problem) {
    try { child.kill() } catch {}
    let cleanupTimer
    await Promise.race([closed, new Promise(resolve => { cleanupTimer = setTimeout(resolve, 5000) })])
    clearTimeout(cleanupTimer)
    problem.cleanupConfirmed = session.closed
    if (!session.closed) problem.retainedHelperRoot = helperRoot
    if (!session.closed) {
      child.unref()
      for (const stream of [child.stdin, child.stdout, child.stderr]) if (stream.unref) stream.unref()
    }
    throw problem
  } finally {
    clearTimeout(timer)
    clearTimeout(closeTimer)
    if (session.closed) fs.rmSync(helperRoot, { recursive: true, force: true })
  }
}
module.exports = { Session, validateFiles, helperEnvironment, captureForProof }
