'use strict'

const childProcess = require('node:child_process')
const path = require('node:path')

// Test-only runner for synchronous CLI phases, whose parent remains alive while
// its children run. Windows taskkill is not an orphan-safe Job Object boundary.
function runOwnedTestProcess(command, args, options) {
  const { binding, phase, signal, timeout, diagnostic = () => {}, warnAfter, progressPrefix,
    maxOutputBytes = 1024 * 1024, ...spawnOptions } = options
  if (progressPrefix !== undefined && (typeof progressPrefix !== 'string' ||
      progressPrefix.length === 0 || progressPrefix.length > 128 || /[\r\n]/u.test(progressPrefix))) {
    throw new TypeError('test progress prefix must be one bounded nonempty line prefix')
  }
  const started = performance.now()
  const owner = { phase, pid: null }
  let releaseOwner
  owner.settled = new Promise(resolve => { releaseOwner = resolve })
  binding.pendingProcesses.add(owner)
  return new Promise(resolve => {
    let child
    let closed = false
    let stopping = false
    let cleanupDone = false
    let settled = false
    let timer
    let warning
    let cleanupTimer
    let outputBytes = 0
    let progressBuffer = '', discardProgressLine = false, progressCount = 0
    const result = { phase, pid: null, timeoutMs: timeout, durationMs: 0, status: null,
      signal: null, errorCode: null, errorMessage: null, timedOut: false, aborted: false,
      cleanupConfirmed: false, cleanupError: null, stdout: '', stderr: '' }
    const finish = () => {
      if (settled || !closed || (stopping && !cleanupDone)) return
      settled = true
      clearTimeout(timer)
      clearTimeout(warning)
      clearTimeout(cleanupTimer)
      signal?.removeEventListener('abort', abort)
      result.durationMs = Math.round(performance.now() - started)
      if (!stopping) result.cleanupConfirmed = true
      if (result.cleanupConfirmed) binding.pendingProcesses.delete(owner)
      // A raced exit(0) must not turn timeout, abort, or overflow into success.
      if (stopping) result.status = null
      diagnostic(JSON.stringify({ ...result, stdout: undefined, stderr: undefined }))
      resolve(Object.freeze({ ...result }))
      releaseOwner()
    }
    const stop = code => {
      if (stopping || settled) return
      stopping = true
      result.errorCode = code
      result.timedOut = code === 'ETIMEDOUT'
      result.aborted = code === 'ABORT_ERR'
      clearTimeout(timer)
      clearTimeout(warning)
      const terminated = error => {
        if (settled) return
        cleanupDone = true
        result.cleanupConfirmed = !error
        result.cleanupError = error?.code || (error ? String(error.message).slice(0, 200) : null)
        finish()
      }
      // Never remove the fixture if killing/draining the owned tree fails.
      cleanupTimer = setTimeout(() => {
        result.cleanupConfirmed = false
        result.cleanupError ||= 'OWNED_TREE_DRAIN_TIMEOUT'
        cleanupDone = true
        child?.stdout?.destroy()
        child?.stderr?.destroy()
        child?.unref()
        closed = true
        finish()
      }, 10_000)
      if (!child?.pid) terminated(null)
      else if (process.platform === 'win32') {
        if (child.exitCode != null || child.signalCode != null) {
          // Do not address a possibly reused PID after the owned parent exited.
          terminated({ code: 'OWNED_PARENT_EXITED_BEFORE_TREE_CLEANUP' })
          return
        }
        const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe')
        childProcess.execFile(taskkill, ['/PID', String(child.pid), '/T', '/F'], {
          timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true,
        }, error => terminated(error))
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); terminated(null) }
        catch (error) { terminated(error.code === 'ESRCH' ? null : error) }
      }
    }
    const abort = () => stop('ABORT_ERR')
    if (signal?.aborted) {
      closed = true
      stop('ABORT_ERR')
      return
    }
    try {
      child = childProcess.spawn(command, args, {
        ...spawnOptions, detached: process.platform !== 'win32',
        shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      })
      owner.pid = child.pid || null
      result.pid = owner.pid
    } catch (error) {
      result.errorCode = error.code || 'SPAWN_ERROR'
      result.errorMessage = String(error.message).slice(0, 300)
      closed = true
      finish()
      return
    }
    for (const stream of ['stdout', 'stderr']) child[stream].on('data', chunk => {
      if (settled) return
      const available = Math.max(0, maxOutputBytes - outputBytes)
      result[stream] += chunk.subarray(0, available).toString('utf8')
      outputBytes += chunk.length
      if (stream === 'stderr' && progressPrefix && progressCount < 64) {
        const lines = (progressBuffer + chunk.toString('utf8')).split(/\r?\n/u)
        progressBuffer = lines.pop()
        for (const line of lines) {
          if (discardProgressLine) { discardProgressLine = false; continue }
          const label = line.startsWith(progressPrefix) ? line.slice(progressPrefix.length) : ''
          if (progressCount < 64 && /^[a-z][a-z0-9-]{0,63}$/u.test(label)) {
            progressCount += 1
            diagnostic(JSON.stringify({ phase, progress: label,
              elapsedMs: Math.round(performance.now() - started) }))
          }
        }
        // A CR may be the first half of CRLF at the exact 64-character limit.
        const pendingLength = progressBuffer.endsWith('\r') ? progressBuffer.length - 1 : progressBuffer.length
        if (pendingLength > progressPrefix.length + 64) {
          progressBuffer = ''
          discardProgressLine = true
        }
      }
      if (outputBytes > maxOutputBytes) stop('ENOBUFS')
    })
    child.on('error', error => {
      if (settled) return
      result.errorCode ||= error.code || 'SPAWN_ERROR'
      result.errorMessage = String(error.message).slice(0, 300)
    })
    child.on('close', (status, exitSignal) => {
      if (settled) return
      result.status = status
      result.signal = exitSignal
      closed = true
      finish()
    })
    signal?.addEventListener('abort', abort, { once: true })
    timer = setTimeout(() => stop('ETIMEDOUT'), timeout)
    if (warnAfter && warnAfter < timeout) warning = setTimeout(() => {
      diagnostic(JSON.stringify({ phase, elapsedMs: Math.round(performance.now() - started),
        priorDeadlineMs: warnAfter, timeoutMs: timeout, stillRunning: true }))
    }, warnAfter)
  })
}

function processFailureDetails(result) {
  return JSON.stringify({ ...result, stdout: result.stdout.slice(-16_384),
    stderr: result.stderr.slice(-16_384) }, null, 2)
}

module.exports = { runOwnedTestProcess, processFailureDetails }
