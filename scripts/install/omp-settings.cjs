#!/usr/bin/env node
'use strict'

// omp-settings.cjs - minimal YAML editor for omp's global config.yml.
//
// The only setting Autoprompt requires on the host is the subagent recursion
// depth: the L0->L1->L2->L3->L4 hierarchy needs task.maxRecursionDepth >= 4
// (omp's default is 2, which collapses at L2). The editor is line-preserving:
// comments, ordering, and every unrelated key stay byte-identical. A BOM and a
// trailing newline are preserved. The pre-edit bytes are returned so the caller
// can back them up for rollback; uninstall restores them only when the current
// file still matches what this editor wrote.

const fs = require('node:fs')

const DEPTH_KEY = 'maxRecursionDepth'
const REQUIRED_DEPTH = 4

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])

class SettingsError extends Error {
  constructor(reason, details = {}) {
    super(reason)
    this.name = 'SettingsError'
    this.reason = reason
    this.details = details
  }
}

function decodeConfig(bytes) {
  const hasBom = bytes.subarray(0, 3).equals(UTF8_BOM)
  const body = hasBom ? bytes.subarray(3) : bytes
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch {
    throw new SettingsError('config-invalid-utf8')
  }
  return { hasBom, text }
}

function encodeConfig(text, hasBom) {
  const body = Buffer.from(text, 'utf8')
  return hasBom ? Buffer.concat([UTF8_BOM, body]) : body
}

function ensureTrailingNewline(text) {
  return text.endsWith('\n') ? text : `${text}\n`
}

// Line-based YAML surgery for the one nested key. Returns the new text or null
// when the required value is already present.
function applyDepthEdit(text) {
  const lines = text.split(/(?<=\n)/) // keep line endings
  const lineEnding = text.includes('\r\n') ? '\r\n' : '\n'
  const content = lines.map((line) => line.replace(/\r?\n$/, ''))
  const join = (items) => `${items.join(lineEnding)}${lineEnding}`

  let taskIndex = -1
  for (let index = 0; index < content.length; index += 1) {
    const trimmed = content[index].trim()
    if (trimmed.startsWith('#')) continue
    if (/^task:\s*(#.*)?$/.test(content[index])) {
      taskIndex = index
      break
    }
    if (/^[A-Za-z0-9_.-]+:/.test(content[index])) {
      // A different top-level key before any `task:` block.
      continue
    }
  }

  // No task block: append one.
  if (taskIndex === -1) {
    return `${ensureTrailingNewline(text)}task:\n  maxRecursionDepth: ${REQUIRED_DEPTH}\n`
  }

  // Locate the task block: following lines indented with whitespace.
  let blockEnd = taskIndex + 1
  while (blockEnd < content.length) {
    const line = content[blockEnd]
    if (line.trim() === '' || line.trim().startsWith('#')) {
      // Blank/comment lines stay inside the block if followed by indentation.
      if (blockEnd + 1 < content.length && /^[ \t]/.test(content[blockEnd + 1])) {
        blockEnd += 1
        continue
      }
      break
    }
    if (/^[ \t]/.test(line)) {
      blockEnd += 1
      continue
    }
    break
  }

  // Find maxRecursionDepth inside the block.
  for (let index = taskIndex + 1; index < blockEnd; index += 1) {
    const match = content[index].match(/^(\s*)maxRecursionDepth:\s*([^\s#]*)/)
    if (!match) continue
    const current = Number(match[2])
    if (Number.isFinite(current) && current >= REQUIRED_DEPTH) return null
    // Update in place, preserving indentation and any trailing comment.
    const indent = match[1]
    const trailing = content[index].slice(match[0].length)
    content[index] = `${indent}maxRecursionDepth: ${REQUIRED_DEPTH}${trailing}`
    return join(content)
  }

  // Block exists but the key is missing: insert inside the block, before any
  // trailing blank/comment lines.
  let insertAt = blockEnd
  while (insertAt > taskIndex + 1 && content[insertAt - 1].trim() === '') insertAt -= 1
  content.splice(insertAt, 0, `  maxRecursionDepth: ${REQUIRED_DEPTH}`)
  return join(content)
}

function readConfig(configPath) {
  let bytes
  try {
    bytes = fs.readFileSync(configPath)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  return decodeConfig(bytes)
}

function currentDepth(configPath) {
  const decoded = readConfig(configPath)
  if (!decoded) return null
  const match = decoded.text.match(/^task:\s*(?:#.*)?(?:\r?\n|$)((?:\s[^\n]*\n?)*)/m)
  if (!match) return null
  const depthMatch = match[1].match(/^\s*maxRecursionDepth:\s*([^\s#]*)/m)
  if (!depthMatch) return null
  const value = Number(depthMatch[1])
  return Number.isFinite(value) ? value : null
}

// install: return { changed, previous, applied } where previous/applied are
// byte buffers (or null when unchanged). Never throws for a missing file.
function install(configPath) {
  const decoded = readConfig(configPath)
  if (decoded === null) {
    const applied = encodeConfig(`task:\n  maxRecursionDepth: ${REQUIRED_DEPTH}\n`, false)
    fs.writeFileSync(configPath, applied)
    return { changed: true, previous: null, applied }
  }
  const edited = applyDepthEdit(decoded.text)
  if (edited === null) return { changed: false, previous: null, applied: null }
  const applied = encodeConfig(edited, decoded.hasBom)
  fs.writeFileSync(configPath, applied)
  return { changed: true, previous: Buffer.concat([UTF8_BOM, Buffer.from(decoded.text, 'utf8')]), applied }
}

// uninstall: restore the previous bytes only when the current file still matches
// the applied bytes (the user may have edited it since). Returns { restored }.
function uninstall(configPath, previous, applied) {
  if (!previous) return { restored: false }
  let current
  try {
    current = fs.readFileSync(configPath)
  } catch {
    return { restored: false }
  }
  if (applied && !current.equals(applied)) return { restored: false }
  fs.writeFileSync(configPath, previous)
  return { restored: true }
}

function runCli(argv) {
  const [op, configPath] = argv
  if (op === 'inspect') {
    const depth = currentDepth(configPath)
    process.stdout.write(`${depth === null ? 'absent' : depth}\n`)
    return 0
  }
  if (op === 'install') {
    const result = install(configPath)
    process.stdout.write(`${JSON.stringify({
      changed: result.changed,
      previous: result.previous ? result.previous.toString('base64') : null,
      applied: result.applied ? result.applied.toString('base64') : null,
    })}\n`)
    return 0
  }
  if (op === 'uninstall') {
    const previous = Buffer.from(argv[2] || '', 'base64')
    const applied = Buffer.from(argv[3] || '', 'base64')
    const result = uninstall(configPath, previous, applied)
    process.stdout.write(`${JSON.stringify(result)}\n`)
    return 0
  }
  throw new SettingsError(`unknown-omp-settings-op: ${op}`)
}

if (require.main === module) {
  try {
    runCli(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`omp-settings: ${error.message}\n`)
    process.exitCode = 1
  }
}

module.exports = {
  applyDepthEdit,
  currentDepth,
  install,
  uninstall,
}