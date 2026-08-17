#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { TextDecoder } = require('node:util')

const ACTIVATION_KEY = 'chat.subagents.allowInvocationsFromSubagents'
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])

class JsoncError extends Error {
  constructor(reason, position) {
    super(`${reason} at offset ${position}`)
    this.reason = reason
    this.position = position
  }
}

function decodeDocument(bytes) {
  const hasBom = bytes.subarray(0, 3).equals(UTF8_BOM)
  const body = hasBom ? bytes.subarray(3) : bytes
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch {
    throw new JsoncError('invalid-utf8', 0)
  }
  return { hasBom, text }
}

function encodeDocument(text, hasBom) {
  const body = Buffer.from(text, 'utf8')
  return hasBom ? Buffer.concat([UTF8_BOM, body]) : body
}

class Lexer {
  constructor(text) {
    this.text = text
    this.index = 0
    this.cached = null
  }

  skipTrivia() {
    while (this.index < this.text.length) {
      const ch = this.text[this.index]
      if (/\s/u.test(ch)) {
        this.index++
        continue
      }
      if (ch !== '/') return
      const next = this.text[this.index + 1]
      if (next === '/') {
        this.index += 2
        while (this.index < this.text.length &&
          this.text[this.index] !== '\n' && this.text[this.index] !== '\r') {
          this.index++
        }
        continue
      }
      if (next === '*') {
        const end = this.text.indexOf('*/', this.index + 2)
        if (end < 0) throw new JsoncError('unterminated-comment', this.index)
        this.index = end + 2
        continue
      }
      return
    }
  }

  readString() {
    const start = this.index++
    let escaped = false
    while (this.index < this.text.length) {
      const code = this.text.charCodeAt(this.index)
      const ch = this.text[this.index++]
      if (escaped) {
        if (ch === 'u') {
          const hex = this.text.slice(this.index, this.index + 4)
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            throw new JsoncError('invalid-string-escape', this.index - 2)
          }
          this.index += 4
        } else if (!'"\\/bfnrt'.includes(ch)) {
          throw new JsoncError('invalid-string-escape', this.index - 2)
        }
        escaped = false
        continue
      }
      if (ch === '\\') {
        escaped = true
        continue
      }
      if (ch === '"') {
        const raw = this.text.slice(start, this.index)
        let value
        try { value = JSON.parse(raw) } catch {
          throw new JsoncError('invalid-string', start)
        }
        return { type: 'string', start, end: this.index, value }
      }
      if (code < 0x20) throw new JsoncError('control-character-in-string', this.index - 1)
    }
    throw new JsoncError('unterminated-string', start)
  }

  readToken() {
    this.skipTrivia()
    const start = this.index
    if (start >= this.text.length) return { type: 'eof', start, end: start }
    const ch = this.text[this.index]
    if ('{}[]:,'.includes(ch)) {
      this.index++
      return { type: ch, start, end: this.index }
    }
    if (ch === '"') return this.readString()
    for (const [word, type, value] of [
      ['true', 'true', true],
      ['false', 'false', false],
      ['null', 'null', null],
    ]) {
      if (this.text.startsWith(word, start)) {
        const after = this.text[start + word.length]
        if (after && /[A-Za-z0-9_$]/.test(after)) break
        this.index += word.length
        return { type, start, end: this.index, value }
      }
    }
    const number = this.text.slice(start).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)
    if (number) {
      this.index += number[0].length
      return {
        type: 'number',
        start,
        end: this.index,
        value: Number(number[0]),
      }
    }
    throw new JsoncError('unexpected-token', start)
  }

  peek() {
    if (!this.cached) this.cached = this.readToken()
    return this.cached
  }

  next() {
    const token = this.peek()
    this.cached = null
    return token
  }
}

class Parser {
  constructor(text) {
    this.lexer = new Lexer(text)
  }

  expect(type) {
    const token = this.lexer.next()
    if (token.type !== type) throw new JsoncError(`expected-${type}`, token.start)
    return token
  }

  parse() {
    const root = this.parseValue()
    const final = this.lexer.next()
    if (final.type !== 'eof') throw new JsoncError('trailing-token', final.start)
    return root
  }

  parseValue() {
    const token = this.lexer.peek()
    if (token.type === '{') return this.parseObject()
    if (token.type === '[') return this.parseArray()
    if (['string', 'number', 'true', 'false', 'null'].includes(token.type)) {
      this.lexer.next()
      return {
        type: token.type === 'true' || token.type === 'false' ? 'boolean' : token.type,
        start: token.start,
        end: token.end,
        value: token.value,
      }
    }
    throw new JsoncError('expected-value', token.start)
  }

  parseObject() {
    const open = this.expect('{')
    const properties = []
    const keys = new Set()
    if (this.lexer.peek().type === '}') {
      const close = this.lexer.next()
      return { type: 'object', start: open.start, end: close.end, close: close.start, properties }
    }
    while (true) {
      const key = this.expect('string')
      if (keys.has(key.value)) throw new JsoncError(`duplicate-key:${key.value}`, key.start)
      keys.add(key.value)
      this.expect(':')
      const value = this.parseValue()
      const property = { key: key.value, keyToken: key, value, comma: null }
      properties.push(property)
      const next = this.lexer.next()
      if (next.type === '}') {
        return { type: 'object', start: open.start, end: next.end, close: next.start, properties }
      }
      if (next.type !== ',') throw new JsoncError('expected-comma-or-object-end', next.start)
      property.comma = next
      if (this.lexer.peek().type === '}') {
        const close = this.lexer.next()
        return { type: 'object', start: open.start, end: close.end, close: close.start, properties }
      }
    }
  }

  parseArray() {
    const open = this.expect('[')
    const values = []
    if (this.lexer.peek().type === ']') {
      const close = this.lexer.next()
      return { type: 'array', start: open.start, end: close.end, values }
    }
    while (true) {
      values.push(this.parseValue())
      const next = this.lexer.next()
      if (next.type === ']') return { type: 'array', start: open.start, end: next.end, values }
      if (next.type !== ',') throw new JsoncError('expected-comma-or-array-end', next.start)
      if (this.lexer.peek().type === ']') {
        const close = this.lexer.next()
        return { type: 'array', start: open.start, end: close.end, values }
      }
    }
  }
}

function parseSettings(bytes) {
  const decoded = decodeDocument(bytes)
  const root = new Parser(decoded.text).parse()
  if (root.type !== 'object') throw new JsoncError('root-not-object', root.start)
  const property = root.properties.find(item => item.key === ACTIVATION_KEY)
  if (property && property.value.type !== 'boolean') {
    throw new JsoncError('activation-value-not-boolean', property.value.start)
  }
  return { ...decoded, root, property }
}

function applyTextEdits(text, edits) {
  let output = text
  const ordered = [...edits].sort((left, right) => right.start - left.start)
  for (const edit of ordered) {
    output = output.slice(0, edit.start) + edit.value + output.slice(edit.end)
  }
  return output
}

function getNewline(text) {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

function lineStart(text, offset) {
  const lf = text.lastIndexOf('\n', offset - 1)
  return lf < 0 ? 0 : lf + 1
}

function enableExisting(bytes) {
  const parsed = parseSettings(bytes)
  if (parsed.property?.value.value === true) {
    return { status: 'noop', prior: 'true', bytes }
  }
  if (parsed.property) {
    const text = applyTextEdits(parsed.text, [{
      start: parsed.property.value.start,
      end: parsed.property.value.end,
      value: 'true',
    }])
    return { status: 'applied', prior: 'false', bytes: encodeDocument(text, parsed.hasBom) }
  }

  const newline = getNewline(parsed.text)
  const close = parsed.root.close
  const closeLineStart = lineStart(parsed.text, close)
  const closePrefix = parsed.text.slice(closeLineStart, close)
  const closeIsIndentedLine = /^[\t ]*$/.test(closePrefix)
  const insertAt = closeIsIndentedLine ? closeLineStart : close
  const closingIndent = closeIsIndentedLine ? closePrefix : ''
  let indent = `${closingIndent}  `
  if (parsed.root.properties.length > 0) {
    const firstKey = parsed.root.properties[0].keyToken.start
    const firstLineStart = lineStart(parsed.text, firstKey)
    const candidate = parsed.text.slice(firstLineStart, firstKey)
    if (/^[\t ]+$/.test(candidate)) indent = candidate
  }
  const before = parsed.text.slice(0, insertAt)
  const needsNewline = before.length > 0 && !/[\r\n]$/.test(before)
  const insertion = `${needsNewline ? newline : ''}${indent}${JSON.stringify(ACTIVATION_KEY)}: true${newline}${closingIndent}`
  const edits = [{ start: insertAt, end: insertAt, value: insertion }]
  const last = parsed.root.properties.at(-1)
  if (last && !last.comma) {
    edits.push({ start: last.value.end, end: last.value.end, value: ',' })
  }
  const text = applyTextEdits(parsed.text, edits)
  return { status: 'applied', prior: 'absent', bytes: encodeDocument(text, parsed.hasBom) }
}

function newSettingsBytes() {
  return Buffer.from(`{\n  ${JSON.stringify(ACTIVATION_KEY)}: true\n}\n`, 'utf8')
}

function buffersEqual(left, right) {
  return left.length === right.length && left.equals(right)
}

function writeAtomic(file, bytes) {
  const temporary = `${file}.autoprompt.tmp-${process.pid}`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx' })
    fs.renameSync(temporary, file)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

function inspect(file) {
  if (!fs.existsSync(file)) {
    process.stdout.write('status=activation-missing reason=settings-file-absent\n')
    return 2
  }
  const parsed = parseSettings(fs.readFileSync(file))
  if (parsed.property?.value.value === true) {
    process.stdout.write('status=enabled\n')
    return 0
  }
  const reason = parsed.property ? 'setting-disabled' : 'setting-absent'
  process.stdout.write(`status=activation-missing reason=${reason}\n`)
  return 2
}

function stage(file, output, originalOutput) {
  if (!fs.existsSync(file)) {
    writeAtomic(output, newSettingsBytes())
    process.stdout.write('status=applied prior=absent original=none\n')
    return 0
  }
  const original = fs.readFileSync(file)
  const enabled = enableExisting(original)
  if (enabled.status === 'noop') {
    process.stdout.write('status=noop prior=true original=none\n')
    return 0
  }
  writeAtomic(originalOutput, original)
  try {
    writeAtomic(output, enabled.bytes)
  } catch (error) {
    fs.rmSync(originalOutput, { force: true })
    throw error
  }
  process.stdout.write(`status=applied prior=${enabled.prior} original=${originalOutput}\n`)
  return 0
}

function edit(file, backup) {
  if (!fs.existsSync(file)) {
    if (fs.existsSync(backup)) throw new Error('backup-collision')
    writeAtomic(file, newSettingsBytes())
    process.stdout.write('status=applied prior=absent backup=none\n')
    return 0
  }
  const original = fs.readFileSync(file)
  const enabled = enableExisting(original)
  if (enabled.status === 'noop') {
    process.stdout.write('status=noop prior=true backup=none\n')
    return 0
  }
  if (fs.existsSync(backup)) throw new Error('backup-collision')
  fs.mkdirSync(path.dirname(backup), { recursive: true })
  fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL)
  try {
    writeAtomic(file, enabled.bytes)
  } catch (error) {
    writeAtomic(file, original)
    fs.rmSync(backup, { force: true })
    throw error
  }
  process.stdout.write(`status=applied prior=${enabled.prior} backup=${backup}\n`)
  return 0
}

function restore(file, backup, prior) {
  if (fs.existsSync(backup)) {
    const original = fs.readFileSync(backup)
    const expected = enableExisting(original).bytes
    if (!fs.existsSync(file) || !buffersEqual(fs.readFileSync(file), expected)) {
      throw new Error('settings-diverged-since-install')
    }
    writeAtomic(file, original)
    fs.rmSync(backup)
    process.stdout.write('status=restored via=backup\n')
    return 0
  }
  if (prior !== 'absent') throw new Error('required-backup-missing')
  if (!fs.existsSync(file) || !buffersEqual(fs.readFileSync(file), newSettingsBytes())) {
    throw new Error('settings-diverged-since-install')
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
    if (!option?.startsWith('--') || value === undefined) throw new Error('invalid-arguments')
    options[option.slice(2)] = value
  }
  if (!['inspect', 'stage', 'edit', 'restore'].includes(operation) || !options.file) {
    throw new Error('invalid-arguments')
  }
  return { operation, options }
}

function main() {
  let parsed
  try {
    parsed = parseArguments(process.argv)
    if (parsed.operation === 'inspect') return inspect(parsed.options.file)
    if (parsed.operation === 'stage') {
      if (!parsed.options.output || !parsed.options.original) {
        throw new Error('stage-output-required')
      }
      return stage(parsed.options.file, parsed.options.output, parsed.options.original)
    }
    if (!parsed.options.backup) throw new Error('backup-required')
    if (parsed.operation === 'edit') return edit(parsed.options.file, parsed.options.backup)
    return restore(parsed.options.file, parsed.options.backup, parsed.options.prior)
  } catch (error) {
    const reason = error instanceof JsoncError ? error.reason : error.message
    process.stderr.write(`status=activation-missing reason=${reason}\n`)
    return 3
  }
}

process.exitCode = main()
