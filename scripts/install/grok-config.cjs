#!/usr/bin/env node
'use strict'

// Transactional `[mcp_servers.autoprompt]` registration for Grok Build.
//
// Autoprompt reaches Grok Build children through one stdio MCP server. That
// registration is the only line this package writes into the user's own
// `config.toml`, and it is written the same way the VS Code settings edit is:
// stage the exact desired bytes, keep a byte-exact backup of the prior file,
// refuse conflicting or unparsable state instead of overwriting it, and restore
// the original bytes on rollback or uninstall.

const fs = require('node:fs')
const path = require('node:path')

const SECTION = '[mcp_servers.autoprompt]'
const MANAGED_KEYS = Object.freeze(['command', 'args', 'enabled', 'startup_timeout_sec'])
const SERVER_BASENAME = 'grok-dispatch-server.js'
const INTERPRETER = 'node'

class ConfigError extends Error {
  constructor(reason) {
    super(reason)
    this.reason = reason
  }
}

function tomlString(value) {
  return JSON.stringify(String(value))
}

function decode(bytes) {
  const text = bytes.toString('utf8')
  if (Buffer.from(text, 'utf8').compare(bytes) !== 0) throw new ConfigError('config-not-utf8')
  return text
}

function newline(text) {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

function desiredBlock(serverPath, eol = '\n') {
  return [
    SECTION,
    `command = ${tomlString(INTERPRETER)}`,
    `args = [${tomlString(serverPath)}]`,
    'enabled = true',
    'startup_timeout_sec = 30',
  ].join(eol) + eol
}

function validatedServerPath(serverPath) {
  if (typeof serverPath !== 'string' || serverPath === '' || !path.isAbsolute(serverPath)) {
    throw new ConfigError('server-path-not-absolute')
  }
  if (path.basename(serverPath) !== SERVER_BASENAME) throw new ConfigError('server-path-unexpected')
  return serverPath
}

// Line-level section scan. A TOML parser is deliberately avoided: the file
// belongs to the user, so the edit only ever appends or replaces one exact
// block and refuses anything it cannot recognize byte for byte.
function locateSection(lines) {
  const matches = []
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() === SECTION) matches.push(index)
  }
  if (matches.length > 1) throw new ConfigError('duplicate-autoprompt-section')
  if (matches.length === 0) return null
  const start = matches[0]
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index])) {
      end = index
      break
    }
  }
  while (end > start + 1 && lines[end - 1].trim() === '') end -= 1
  return { start, end }
}

function sectionIsOurs(lines, section) {
  let sawCommand = false
  let sawManagedServer = false
  for (let index = section.start + 1; index < section.end; index += 1) {
    const line = lines[index].trim()
    if (line === '' || line.startsWith('#')) continue
    const key = /^([A-Za-z0-9_-]+)\s*=/.exec(line)
    if (!key || !MANAGED_KEYS.includes(key[1])) return false
    if (key[1] === 'command') sawCommand = true
    if (key[1] === 'args' && line.includes(SERVER_BASENAME)) sawManagedServer = true
  }
  return sawCommand && sawManagedServer
}

function splitLines(text) {
  const eol = newline(text)
  const trailing = text.endsWith(eol)
  const body = trailing ? text.slice(0, -eol.length) : text
  return { eol, trailing, lines: body === '' ? [] : body.split(eol) }
}

function renderRegistration(original, serverPath) {
  validatedServerPath(serverPath)
  const text = decode(original)
  const { eol, lines } = splitLines(text)
  const block = desiredBlock(serverPath, eol)
  const section = locateSection(lines)
  if (section === null) {
    const prefix = text === '' || text.endsWith(`${eol}${eol}`) ? text : `${text.endsWith(eol) ? text : `${text}${eol}`}${eol}`
    return { status: 'applied', prior: 'absent', bytes: Buffer.from(`${prefix}${block}`, 'utf8') }
  }
  if (!sectionIsOurs(lines, section)) throw new ConfigError('autoprompt-section-conflict')
  const before = lines.slice(0, section.start)
  const after = lines.slice(section.end)
  const rebuilt = [
    ...before.map(line => `${line}${eol}`),
    block,
    ...after.map(line => `${line}${eol}`),
  ].join('')
  const bytes = Buffer.from(rebuilt, 'utf8')
  if (bytes.compare(original) === 0) return { status: 'noop', prior: 'present', bytes }
  return { status: 'applied', prior: 'present', bytes }
}

function newConfigBytes(serverPath) {
  validatedServerPath(serverPath)
  return Buffer.from([
    '# Created by the Autoprompt installer for Grok Build.',
    desiredBlock(serverPath),
  ].join('\n'), 'utf8')
}

function writeAtomic(file, bytes) {
  const temporary = `${file}.autoprompt-tmp-${process.pid}`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  try {
    fs.writeFileSync(temporary, bytes)
    fs.renameSync(temporary, file)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

function registeredServerPath(text) {
  const { lines } = splitLines(text)
  const section = locateSection(lines)
  if (section === null) return null
  for (let index = section.start + 1; index < section.end; index += 1) {
    const match = /^\s*args\s*=\s*\[\s*"((?:[^"\\]|\\.)*)"\s*\]\s*$/.exec(lines[index])
    if (match) {
      try {
        return JSON.parse(`"${match[1]}"`)
      } catch {
        throw new ConfigError('autoprompt-section-conflict')
      }
    }
  }
  return null
}

function inspect(file, serverPath) {
  validatedServerPath(serverPath)
  if (!fs.existsSync(file)) {
    process.stdout.write('status=activation-missing reason=config-file-absent\n')
    return 2
  }
  const registered = registeredServerPath(decode(fs.readFileSync(file)))
  if (registered === null) {
    process.stdout.write('status=activation-missing reason=mcp-server-absent\n')
    return 2
  }
  if (path.resolve(registered) !== path.resolve(serverPath)) {
    process.stdout.write('status=activation-missing reason=mcp-server-stale\n')
    return 2
  }
  process.stdout.write('status=enabled\n')
  return 0
}

function stage(file, output, originalOutput, serverPath) {
  validatedServerPath(serverPath)
  if (!fs.existsSync(file)) {
    writeAtomic(output, newConfigBytes(serverPath))
    process.stdout.write('status=applied prior=absent original=none\n')
    return 0
  }
  const original = fs.readFileSync(file)
  const rendered = renderRegistration(original, serverPath)
  if (rendered.status === 'noop') {
    process.stdout.write('status=noop prior=present original=none\n')
    return 0
  }
  writeAtomic(originalOutput, original)
  try {
    writeAtomic(output, rendered.bytes)
  } catch (error) {
    fs.rmSync(originalOutput, { force: true })
    throw error
  }
  process.stdout.write(`status=applied prior=${rendered.prior} original=${originalOutput}\n`)
  return 0
}

function edit(file, backup, serverPath) {
  validatedServerPath(serverPath)
  if (!fs.existsSync(file)) {
    if (fs.existsSync(backup)) throw new ConfigError('backup-collision')
    writeAtomic(file, newConfigBytes(serverPath))
    process.stdout.write('status=applied prior=absent backup=none\n')
    return 0
  }
  const original = fs.readFileSync(file)
  const rendered = renderRegistration(original, serverPath)
  if (rendered.status === 'noop') {
    process.stdout.write('status=noop prior=present backup=none\n')
    return 0
  }
  if (fs.existsSync(backup)) throw new ConfigError('backup-collision')
  fs.mkdirSync(path.dirname(backup), { recursive: true })
  fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL)
  try {
    writeAtomic(file, rendered.bytes)
  } catch (error) {
    writeAtomic(file, original)
    fs.rmSync(backup, { force: true })
    throw error
  }
  process.stdout.write(`status=applied prior=${rendered.prior} backup=${backup}\n`)
  return 0
}

function restore(file, backup, prior, serverPath) {
  validatedServerPath(serverPath)
  if (fs.existsSync(backup)) {
    const original = fs.readFileSync(backup)
    const expected = renderRegistration(original, serverPath).bytes
    if (!fs.existsSync(file) || fs.readFileSync(file).compare(expected) !== 0) {
      throw new ConfigError('config-diverged-since-install')
    }
    writeAtomic(file, original)
    fs.rmSync(backup)
    process.stdout.write('status=restored via=backup\n')
    return 0
  }
  if (prior !== 'absent') throw new ConfigError('required-backup-missing')
  if (!fs.existsSync(file) || fs.readFileSync(file).compare(newConfigBytes(serverPath)) !== 0) {
    throw new ConfigError('config-diverged-since-install')
  }
  fs.rmSync(file)
  process.stdout.write('status=restored via=remove-created\n')
  return 0
}

function parseArguments(argv) {
  const operation = argv[2]
  const options = {}
  for (let index = 3; index < argv.length; index += 2) {
    const option = argv[index]
    const value = argv[index + 1]
    if (!option?.startsWith('--') || value === undefined) throw new ConfigError('invalid-arguments')
    options[option.slice(2)] = value
  }
  if (!['inspect', 'stage', 'edit', 'restore'].includes(operation) || !options.file || !options.server) {
    throw new ConfigError('invalid-arguments')
  }
  return { operation, options }
}

function main() {
  let parsed
  try {
    parsed = parseArguments(process.argv)
    const { file, server } = parsed.options
    if (parsed.operation === 'inspect') return inspect(file, server)
    if (parsed.operation === 'stage') {
      if (!parsed.options.output || !parsed.options.original) throw new ConfigError('stage-output-required')
      return stage(file, parsed.options.output, parsed.options.original, server)
    }
    if (!parsed.options.backup) throw new ConfigError('backup-required')
    if (parsed.operation === 'edit') return edit(file, parsed.options.backup, server)
    return restore(file, parsed.options.backup, parsed.options.prior, server)
  } catch (error) {
    const reason = error instanceof ConfigError ? error.reason : error.message
    process.stderr.write(`status=activation-missing reason=${reason}\n`)
    return 3
  }
}

if (require.main === module) process.exitCode = main()

module.exports = {
  ConfigError,
  SECTION,
  desiredBlock,
  edit,
  inspect,
  newConfigBytes,
  registeredServerPath,
  renderRegistration,
  restore,
  stage,
}
