'use strict'

const fs = require('node:fs')
const path = require('node:path')

const MAX_STATUS_BYTES = 2 * 1024 * 1024
const MAX_OUTPUT_CHARS = 64 * 1024
const MAX_STATUSES = 4

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
    const names = fs.readdirSync(directory).filter(name => /^outer-[a-f0-9-]{36}\.status\.json$/.test(name)).sort()
    if (!names.length) diagnostic('Native canary failure: no owned outer status was written')
    if (names.length > MAX_STATUSES) diagnostic(`Native canary failure: showing ${MAX_STATUSES} of ${names.length} owned statuses`)
    for (const name of names.slice(0, MAX_STATUSES)) {
      const file = path.join(directory, name), stat = fs.lstatSync(file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATUS_BYTES) {
        diagnostic(`Native canary status ${name}: skipped non-regular or oversized status`)
        continue
      }
      try {
        const status = JSON.parse(fs.readFileSync(file, 'utf8'))
        diagnostic(`Native canary status ${name}: ${JSON.stringify({ code: status.code, signal: status.signal, error: excerpt(status.error) })}`)
        for (const stream of ['stdout', 'stderr']) if (typeof status[stream] === 'string' && status[stream]) {
          diagnostic(`Native canary ${name} ${stream}:\n${excerpt(status[stream])}`)
        }
      } catch (error) { diagnostic(`Native canary status ${name}: unreadable (${error.code || error.name})`) }
    }
  } catch (error) { diagnostic(`Native canary diagnostics unavailable: ${error.code || error.message}`) }
}

module.exports = { diagnoseNativeCanary, MAX_STATUS_BYTES, MAX_OUTPUT_CHARS, MAX_STATUSES }
