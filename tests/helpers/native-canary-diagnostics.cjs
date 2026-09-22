'use strict'

const fs = require('node:fs')
const path = require('node:path')

const MAX_STATUS_BYTES = 2 * 1024 * 1024
const MAX_OUTPUT_CHARS = 64 * 1024
const MAX_STATUSES = 4
const MAX_STREAM_BYTES = 4 * 1024 * 1024

function readDiagnostic(file, maximumBytes, partial = false) {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maximumBytes) {
    throw new Error('non-regular, linked, or oversized diagnostic')
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  try {
    const opened = fs.fstatSync(fd)
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size > maximumBytes) {
      throw new Error('diagnostic changed while opening')
    }
    const read = (length, position) => {
      const buffer = Buffer.alloc(length)
      return buffer.subarray(0, fs.readSync(fd, buffer, 0, length, position)).toString('utf8')
    }
    if (!partial || opened.size <= MAX_OUTPUT_CHARS) return read(opened.size, 0)
    return `${read(MAX_OUTPUT_CHARS / 2, 0)}\n[child output truncated]\n${read(MAX_OUTPUT_CHARS / 2, opened.size - MAX_OUTPUT_CHARS / 2)}`
  } finally { fs.closeSync(fd) }
}

function excerpt(value) {
  if (typeof value !== 'string') return ''
  if (value.length <= MAX_OUTPUT_CHARS) return value
  return `${value.slice(0, MAX_OUTPUT_CHARS / 2)}\n[child output truncated]\n${value.slice(-MAX_OUTPUT_CHARS / 2)}`
}

function diagnoseNativeCanary(activation, diagnostic) {
  // This is failure evidence, never proof of a passing native observation.
  // Read only the owned launcher's status, not request files containing env.
  try {
    const generation = activation.record.capability.generation
    if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('invalid canary generation')
    const activationRoot = fs.realpathSync.native(activation.activationRoot)
    const directory = path.join(activationRoot, 'reviewed-local-canary', `generation-${generation}`)
    if (fs.realpathSync.native(directory) !== directory) throw new Error('linked canary diagnostic directory')
    const entries = fs.readdirSync(directory)
    const names = entries.filter(name => /^outer-[a-f0-9-]{36}\.status\.json$/.test(name)).sort()
    const completeStatuses = new Set()
    if (!names.length) diagnostic('Native canary failure: no owned outer status was written')
    if (names.length > MAX_STATUSES) diagnostic(`Native canary failure: showing ${MAX_STATUSES} of ${names.length} owned statuses`)
    for (const name of names.slice(0, MAX_STATUSES)) {
      const file = path.join(directory, name), stat = fs.lstatSync(file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATUS_BYTES) {
        diagnostic(`Native canary status ${name}: skipped non-regular or oversized status`)
        continue
      }
      try {
        const status = JSON.parse(readDiagnostic(file, MAX_STATUS_BYTES))
        diagnostic(`Native canary status ${name}: ${JSON.stringify({ code: status.code, signal: status.signal, errorCode: excerpt(status.errorCode), error: excerpt(status.error) })}`)
        for (const stream of ['stdout', 'stderr']) if (typeof status[stream] === 'string' && status[stream]) {
          diagnostic(`Native canary ${name} ${stream}:\n${excerpt(status[stream])}`)
        }
        if (typeof status.stdout === 'string' && typeof status.stderr === 'string') completeStatuses.add(name.replace(/\.status\.json$/, ''))
      } catch (error) { diagnostic(`Native canary status ${name}: unreadable (${error.code || error.name})`) }
    }
    // These streams survive cancellation before the launcher can publish its
    // terminal status. They are incomplete failure evidence, never admission.
    const stems = [...new Set(entries.filter(name => /^outer-[a-f0-9-]{36}\.(?:stdout|stderr)\.log$/.test(name))
      .map(name => name.replace(/\.(?:stdout|stderr)\.log$/, '')))].sort()
    for (const stem of stems.slice(0, MAX_STATUSES)) {
      if (completeStatuses.has(stem)) continue
      for (const stream of ['stdout', 'stderr']) {
        const name = `${stem}.${stream}.log`
        if (!entries.includes(name)) continue
        try {
          const output = readDiagnostic(path.join(directory, name), MAX_STREAM_BYTES, true)
          if (output) diagnostic(`Native canary partial ${name}:\n${output}`)
        } catch (error) { diagnostic(`Native canary partial ${name}: unreadable (${error.code || error.message})`) }
      }
    }
  } catch (error) { diagnostic(`Native canary diagnostics unavailable: ${error.code || error.message}`) }
}

module.exports = { diagnoseNativeCanary, MAX_STATUS_BYTES, MAX_OUTPUT_CHARS, MAX_STATUSES, MAX_STREAM_BYTES }
