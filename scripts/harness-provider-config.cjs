#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const PROVIDERS = new Set(['omp', 'reasonix', 'hermes'])

function fail (message, code = 2) {
  process.stderr.write(`error=harness-provider-config detail=${message}\n`)
  process.exit(code)
}

function parseArgs (argv) {
  const command = argv[0]
  const options = {}
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!flag?.startsWith('--') || value === undefined) fail('invalid-arguments')
    options[flag.slice(2)] = value
  }
  if (!['plan', 'inspect', 'restore'].includes(command)) fail('unknown-command')
  if (!PROVIDERS.has(options.provider)) fail('unknown-provider')
  if (!options.file) fail('missing-file')
  return { command, options }
}

function requireInteger (value, label) {
  if (!/^\d+$/.test(String(value))) fail(`invalid-${label}`)
  return Number(value)
}

function fileState (file) {
  if (!fs.existsSync(file)) return { exists: false, text: '' }
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`unsafe-file:${file}`, 51)
  return { exists: true, text: fs.readFileSync(file, 'utf8') }
}

function document (text) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const trailing = /\r?\n$/.test(text)
  const lines = text === '' ? [] : text.split(/\r?\n/)
  if (trailing) lines.pop()
  return { lines, newline, trailing }
}

function serialize (doc, isNew = false) {
  if (doc.lines.length === 0) return ''
  return doc.lines.join(doc.newline) + ((doc.trailing || isNew) ? doc.newline : '')
}

function lineIndent (line) {
  return line.match(/^[ \t]*/)[0].length
}

function locateOmp (text) {
  const doc = document(text)
  const taskHeaders = []
  for (let index = 0; index < doc.lines.length; index++) {
    const line = doc.lines[index]
    if (/^(?:"task"|'task')\s*:/.test(line) ||
        (lineIndent(line) === 0 && /^[{[]/.test(line.trim()))) {
      fail('unsafe-omp-task-shape', 52)
    }
    if (/^task\s*:/.test(line) && !/^task:\s*(?:#.*)?$/.test(line)) {
      fail('unsafe-omp-task-shape', 52)
    }
    if (/^task:\s*(?:#.*)?$/.test(line)) taskHeaders.push(index)
  }
  if (taskHeaders.length > 1) fail('duplicate-omp-task-section', 52)
  if (taskHeaders.length === 0) {
    return { doc, header: -1, end: doc.lines.length, key: -1, value: null }
  }
  const header = taskHeaders[0]
  let end = doc.lines.length
  let key = -1
  let value = null
  let keyPrefix = ''
  let keySuffix = ''
  for (let index = header + 1; index < doc.lines.length; index++) {
    const line = doc.lines[index]
    const stripped = line.trim()
    if (stripped !== '' && !stripped.startsWith('#') && lineIndent(line) === 0) {
      end = index
      break
    }
    if (!/^\s+maxRecursionDepth\s*:/.test(line)) continue
    if (key !== -1) fail('duplicate-omp-depth-key', 52)
    const match = line.match(/^(\s+maxRecursionDepth:\s*)(\d+)(\s*(?:#.*)?)$/)
    if (!match) fail('unsafe-omp-depth-value', 52)
    key = index
    value = Number(match[2])
    keyPrefix = match[1]
    keySuffix = match[3]
  }
  return { doc, header, end, key, value, keyPrefix, keySuffix }
}

function ensureOmp (text, minimum) {
  const found = locateOmp(text)
  if (found.value !== null && found.value >= minimum) {
    return { changed: false, value: found.value, text }
  }
  if (found.key >= 0) {
    found.doc.lines[found.key] = `${found.keyPrefix}${minimum}${found.keySuffix}`
  } else if (found.header >= 0) {
    found.doc.lines.splice(found.header + 1, 0, `  maxRecursionDepth: ${minimum}`)
  } else {
    if (found.doc.lines.length > 0 && found.doc.lines.at(-1) !== '') {
      found.doc.lines.push('')
    }
    found.doc.lines.push('task:', `  maxRecursionDepth: ${minimum}`)
  }
  return {
    changed: true,
    value: found.value,
    text: serialize(found.doc, text === '')
  }
}

function restoreOmpPrior (text, prior, preserveSection = false) {
  const found = locateOmp(text)
  if (found.key < 0) return text
  if (/^\d+$/.test(prior)) {
    found.doc.lines[found.key] = `${found.keyPrefix}${prior}${found.keySuffix}`
  } else {
    found.doc.lines.splice(found.key, 1)
    const refreshed = locateOmp(serialize(found.doc))
    if (refreshed.header >= 0) {
      const meaningful = refreshed.doc.lines.slice(refreshed.header + 1, refreshed.end)
        .some(line => line.trim() !== '')
      if (!preserveSection && !meaningful) {
        refreshed.doc.lines.splice(refreshed.header, refreshed.end - refreshed.header)
        while (refreshed.doc.lines.at(-1) === '') refreshed.doc.lines.pop()
        return serialize(refreshed.doc)
      }
    }
  }
  return serialize(found.doc)
}

function locateReasonix (text) {
  const doc = document(text)
  const headers = []
  let atRoot = true
  for (let index = 0; index < doc.lines.length; index++) {
    const stripped = doc.lines[index].trim()
    if (/^\[\[\s*(?:agent|"agent"|'agent')\s*\]\]$/.test(stripped)) {
      fail('unsafe-reasonix-agent-array', 52)
    }
    if (/^\[\s*(?:"agent"|'agent')\s*\]$/.test(stripped)) {
      fail('unsafe-reasonix-agent-shape', 52)
    }
    if (/^\[\s*agent\s*\]$/.test(stripped)) {
      headers.push(index)
      atRoot = false
      continue
    }
    if (/^\[.*\]$/.test(stripped)) {
      atRoot = false
      continue
    }
    if (atRoot && /^(?:agent|"agent"|'agent')\s*(?:=|\.)/.test(stripped)) {
      fail('unsafe-reasonix-agent-shape', 52)
    }
  }
  if (headers.length > 1) fail('duplicate-reasonix-agent-section', 52)
  if (headers.length === 0) {
    return { doc, header: -1, end: doc.lines.length, key: -1, value: null }
  }
  const header = headers[0]
  let end = doc.lines.length
  let key = -1
  let value = null
  let keyPrefix = ''
  let keySuffix = ''
  for (let index = header + 1; index < doc.lines.length; index++) {
    const line = doc.lines[index]
    const stripped = line.trim()
    if (/^\[.*\]$/.test(stripped)) {
      end = index
      break
    }
    if (!/^\s*max_subagent_depth\s*=/.test(line)) continue
    if (key !== -1) fail('duplicate-reasonix-depth-key', 52)
    const match = line.match(/^(\s*max_subagent_depth\s*=\s*)(\d+)(\s*(?:#.*)?)$/)
    if (!match) fail('unsafe-reasonix-depth-value', 52)
    key = index
    value = Number(match[2])
    keyPrefix = match[1]
    keySuffix = match[3]
  }
  return { doc, header, end, key, value, keyPrefix, keySuffix }
}

function ensureReasonix (text, minimum) {
  const found = locateReasonix(text)
  if (found.value !== null && found.value >= minimum) {
    return { changed: false, value: found.value, text }
  }
  if (found.key >= 0) {
    found.doc.lines[found.key] = `${found.keyPrefix}${minimum}${found.keySuffix}`
  } else if (found.header >= 0) {
    found.doc.lines.splice(found.end, 0, `max_subagent_depth = ${minimum}`)
  } else {
    if (found.doc.lines.length > 0 && found.doc.lines.at(-1) !== '') {
      found.doc.lines.push('')
    }
    found.doc.lines.push('[agent]', `max_subagent_depth = ${minimum}`)
  }
  return {
    changed: true,
    value: found.value,
    text: serialize(found.doc, text === '')
  }
}

function restoreReasonixPrior (text, prior, preserveSection = false) {
  const found = locateReasonix(text)
  if (found.key < 0) return text
  if (/^\d+$/.test(prior)) {
    found.doc.lines[found.key] = `${found.keyPrefix}${prior}${found.keySuffix}`
  } else {
    found.doc.lines.splice(found.key, 1)
    const refreshed = locateReasonix(serialize(found.doc))
    if (refreshed.header >= 0) {
      const meaningful = refreshed.doc.lines.slice(refreshed.header + 1, refreshed.end)
        .some(line => line.trim() !== '')
      if (!preserveSection && !meaningful) {
        refreshed.doc.lines.splice(refreshed.header, refreshed.end - refreshed.header)
        while (refreshed.doc.lines.at(-1) === '') refreshed.doc.lines.pop()
        return serialize(refreshed.doc)
      }
    }
  }
  return serialize(found.doc)
}

function locateHermes (text) {
  return locateReasonix(text)
}

function ensureHermes (text, minimum) {
  return ensureReasonix(text, minimum)
}

function restoreHermesPrior (text, prior, preserveSection = false) {
  return restoreReasonixPrior(text, prior, preserveSection)
}

function ensureProvider (provider, text, minimum) {
  if (provider === 'omp') return ensureOmp(text, minimum)
  if (provider === 'reasonix') return ensureReasonix(text, minimum)
  return ensureHermes(text, minimum)
}

function restoreProviderPrior (provider, text, prior, preserveSection = false) {
  if (provider === 'omp') return restoreOmpPrior(text, prior, preserveSection)
  if (provider === 'reasonix') return restoreReasonixPrior(text, prior, preserveSection)
  return restoreHermesPrior(text, prior, preserveSection)
}

function providerValue (provider, text) {
  if (provider === 'omp') return locateOmp(text).value
  if (provider === 'reasonix') return locateReasonix(text).value
  return locateHermes(text).value
}

function providerHasSection (provider, text) {
  if (provider === 'omp') return locateOmp(text).header >= 0
  if (provider === 'reasonix') return locateReasonix(text).header >= 0
  return locateHermes(text).header >= 0
}

function writeOutput (file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, 'utf8')
}

function atomicWrite (file, text) {
  const temporary = `${file}.autoprompt.tmp`
  writeOutput(temporary, text)
  try {
    fs.renameSync(temporary, file)
  } catch {
    fs.copyFileSync(temporary, file)
    fs.rmSync(temporary, { force: true })
  }
}

function removeBackup (backup) {
  if (fs.existsSync(backup)) fs.rmSync(backup, { force: true })
}

function runPlan (options) {
  if (!options.desired || !options.original) fail('missing-plan-output')
  const minimum = requireInteger(options.minimum, 'minimum')
  const live = fileState(options.file)
  const planned = ensureProvider(options.provider, live.text, minimum)
  if (!planned.changed) {
    process.stdout.write(`status=noop provider=${options.provider} value=${planned.value}\n`)
    return
  }
  writeOutput(options.desired, planned.text)
  if (live.exists) writeOutput(options.original, live.text)
  const prior = !live.exists
    ? 'absent-file'
    : (planned.value === null ? 'absent-key' : String(planned.value))
  process.stdout.write(
    `status=applied provider=${options.provider} prior=${prior} value=${minimum}\n`
  )
}

function runInspect (options) {
  const minimum = requireInteger(options.minimum, 'minimum')
  const live = fileState(options.file)
  if (!live.exists) {
    process.stdout.write(`status=missing provider=${options.provider}\n`)
    process.exitCode = 1
    return
  }
  const planned = ensureProvider(options.provider, live.text, minimum)
  if (planned.changed) {
    process.stdout.write(`status=insufficient provider=${options.provider}\n`)
    process.exitCode = 1
    return
  }
  process.stdout.write(`status=complete provider=${options.provider} value=${planned.value}\n`)
}

function runRestore (options) {
  if (!options.backup || !options.prior) fail('missing-restore-input')
  const expected = requireInteger(options.expected, 'expected')
  const live = fileState(options.file)
  const backup = fileState(options.backup)
  if (!['absent-file', 'absent-key'].includes(options.prior) &&
      !/^\d+$/.test(options.prior)) {
    fail('invalid-prior', 52)
  }
  if (!live.exists) {
    removeBackup(options.backup)
    process.stdout.write(
      `configrestore=${options.file} via=preserve-user-missing ` +
      'note=ownership-relinquished keys=0\n'
    )
    return
  }
  if (backup.exists) {
    const installedFromBackup = ensureProvider(options.provider, backup.text, expected).text
    if (live.text === installedFromBackup) {
      atomicWrite(options.file, backup.text)
      removeBackup(options.backup)
      process.stdout.write(`configrestore=${options.file} via=bak keys=1\n`)
      return
    }
  }
  if (options.prior === 'absent-file') {
    const installedFromEmpty = ensureProvider(options.provider, '', expected).text
    if (live.text === installedFromEmpty) {
      fs.rmSync(options.file, { force: true })
      removeBackup(options.backup)
      process.stdout.write(`configrestore=${options.file} via=remove-created-file keys=1\n`)
      return
    }
  }
  if (providerValue(options.provider, live.text) !== expected) {
    removeBackup(options.backup)
    process.stdout.write(
      `configrestore=${options.file} via=preserve-user-diverged ` +
      'note=ownership-relinquished keys=0\n'
    )
    return
  }
  const preserveSection = backup.exists && providerHasSection(options.provider, backup.text)
  const restored = restoreProviderPrior(
    options.provider,
    live.text,
    options.prior,
    preserveSection
  )
  atomicWrite(options.file, restored)
  removeBackup(options.backup)
  process.stdout.write(
    `configrestore=${options.file} via=surgical-diverged note=user-modified-since-install keys=1\n`
  )
}

const { command, options } = parseArgs(process.argv.slice(2))
if (command === 'plan') runPlan(options)
if (command === 'inspect') runInspect(options)
if (command === 'restore') runRestore(options)
