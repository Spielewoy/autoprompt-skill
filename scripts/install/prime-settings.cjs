#!/usr/bin/env node
'use strict'

const path = require('node:path')
const { TextDecoder } = require('node:util')

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])
const DEPTH_KEY = 'rlmMaxDepth'
const PACKAGES_KEY = 'packages'

class JsoncError extends Error {
  constructor(reason, position) {
    super(`${reason} at offset ${position}`)
    this.name = 'JsoncError'
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
      const character = this.text[this.index]
      if (/\s/u.test(character)) {
        this.index++
        continue
      }
      if (character !== '/') return
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
      const character = this.text[this.index++]
      if (escaped) {
        if (character === 'u') {
          const hexadecimal = this.text.slice(this.index, this.index + 4)
          if (!/^[0-9a-fA-F]{4}$/.test(hexadecimal)) {
            throw new JsoncError('invalid-string-escape', this.index - 2)
          }
          this.index += 4
        } else if (!'"\\/bfnrt'.includes(character)) {
          throw new JsoncError('invalid-string-escape', this.index - 2)
        }
        escaped = false
        continue
      }
      if (character === '\\') {
        escaped = true
        continue
      }
      if (character === '"') {
        const raw = this.text.slice(start, this.index)
        try {
          return { type: 'string', start, end: this.index, value: JSON.parse(raw) }
        } catch {
          throw new JsoncError('invalid-string', start)
        }
      }
      if (code < 0x20) throw new JsoncError('control-character-in-string', this.index - 1)
    }
    throw new JsoncError('unterminated-string', start)
  }

  readToken() {
    this.skipTrivia()
    const start = this.index
    if (start >= this.text.length) return { type: 'eof', start, end: start }
    const character = this.text[this.index]
    if ('{}[]:,'.includes(character)) {
      this.index++
      return { type: character, start, end: this.index }
    }
    if (character === '"') return this.readString()
    for (const [word, type, value] of [
      ['true', 'boolean', true],
      ['false', 'boolean', false],
      ['null', 'null', null],
    ]) {
      if (!this.text.startsWith(word, start)) continue
      const after = this.text[start + word.length]
      if (after && /[A-Za-z0-9_$]/.test(after)) break
      this.index += word.length
      return { type, start, end: this.index, value }
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
    if (['string', 'number', 'boolean', 'null'].includes(token.type)) {
      this.lexer.next()
      return token
    }
    throw new JsoncError('expected-value', token.start)
  }

  parseObject() {
    const open = this.expect('{')
    const properties = []
    const keys = new Set()
    if (this.lexer.peek().type === '}') {
      const close = this.lexer.next()
      return {
        type: 'object', start: open.start, openEnd: open.end,
        end: close.end, close: close.start, properties,
      }
    }
    while (true) {
      const keyToken = this.expect('string')
      if (keys.has(keyToken.value)) {
        throw new JsoncError(`duplicate-key:${keyToken.value}`, keyToken.start)
      }
      keys.add(keyToken.value)
      this.expect(':')
      const value = this.parseValue()
      const property = { key: keyToken.value, keyToken, value, comma: null }
      properties.push(property)
      const next = this.lexer.next()
      if (next.type === '}') {
        return {
          type: 'object', start: open.start, openEnd: open.end,
          end: next.end, close: next.start, properties,
        }
      }
      if (next.type !== ',') throw new JsoncError('expected-comma-or-object-end', next.start)
      property.comma = next
      if (this.lexer.peek().type === '}') {
        const close = this.lexer.next()
        return {
          type: 'object', start: open.start, openEnd: open.end,
          end: close.end, close: close.start, properties,
        }
      }
    }
  }

  parseArray() {
    const open = this.expect('[')
    const values = []
    if (this.lexer.peek().type === ']') {
      const close = this.lexer.next()
      return {
        type: 'array', start: open.start, openEnd: open.end,
        end: close.end, close: close.start, values,
      }
    }
    while (true) {
      const value = this.parseValue()
      const item = { value, comma: null }
      values.push(item)
      const next = this.lexer.next()
      if (next.type === ']') {
        return {
          type: 'array', start: open.start, openEnd: open.end,
          end: next.end, close: next.start, values,
        }
      }
      if (next.type !== ',') throw new JsoncError('expected-comma-or-array-end', next.start)
      item.comma = next
      if (this.lexer.peek().type === ']') {
        const close = this.lexer.next()
        return {
          type: 'array', start: open.start, openEnd: open.end,
          end: close.end, close: close.start, values,
        }
      }
    }
  }
}

function nodeValue(node) {
  if (node.type === 'array') return node.values.map(item => nodeValue(item.value))
  if (node.type === 'object') {
    return Object.fromEntries(node.properties.map(property => [property.key, nodeValue(property.value)]))
  }
  return node.value
}

function parseDocument(bytes) {
  const decoded = decodeDocument(bytes)
  const root = new Parser(decoded.text).parse()
  if (root.type !== 'object') throw new JsoncError('root-not-object', root.start)
  return { ...decoded, root, value: nodeValue(root) }
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

function indentationAt(text, offset) {
  const start = lineStart(text, offset)
  const indentation = text.slice(start, offset)
  return /^[\t ]*$/.test(indentation) ? indentation : ''
}

function propertyOf(parsed, key) {
  return parsed.root.properties.find(property => property.key === key)
}

function replaceRange(bytes, start, end, value) {
  const parsed = decodeDocument(bytes)
  return encodeDocument(applyTextEdits(parsed.text, [{ start, end, value }]), parsed.hasBom)
}

function insertProperty(bytes, key, rawValue) {
  const parsed = parseDocument(bytes)
  if (propertyOf(parsed, key)) throw new Error(`property-already-exists:${key}`)
  const newline = getNewline(parsed.text)
  const close = parsed.root.close
  const closeLineStart = lineStart(parsed.text, close)
  const closePrefix = parsed.text.slice(closeLineStart, close)
  const closeOnIndentedLine = /^[\t ]*$/.test(closePrefix)
  const insertAt = closeOnIndentedLine ? closeLineStart : close
  const closingIndent = closeOnIndentedLine ? closePrefix : ''
  let indent = `${closingIndent}  `
  if (parsed.root.properties.length > 0) {
    const candidate = indentationAt(parsed.text, parsed.root.properties[0].keyToken.start)
    if (candidate) indent = candidate
  }
  const before = parsed.text.slice(0, insertAt)
  const needsNewline = before.length > 0 && !/[\r\n]$/.test(before)
  const insertion = `${needsNewline ? newline : ''}${indent}${JSON.stringify(key)}: ${rawValue}${newline}${closingIndent}`
  const edits = [{ start: insertAt, end: insertAt, value: insertion }]
  const last = parsed.root.properties.at(-1)
  if (last && !last.comma) edits.push({ start: last.value.end, end: last.value.end, value: ',' })
  return encodeDocument(applyTextEdits(parsed.text, edits), parsed.hasBom)
}

function setProperty(bytes, key, rawValue) {
  const parsed = parseDocument(bytes)
  const property = propertyOf(parsed, key)
  if (!property) return insertProperty(bytes, key, rawValue)
  return replaceRange(bytes, property.value.start, property.value.end, rawValue)
}

function removeProperty(bytes, key) {
  const parsed = parseDocument(bytes)
  const index = parsed.root.properties.findIndex(property => property.key === key)
  if (index < 0) return bytes
  const property = parsed.root.properties[index]
  let start = property.keyToken.start
  let end = property.value.end
  if (property.comma) {
    end = property.comma.end
  } else if (index > 0) {
    const previous = parsed.root.properties[index - 1]
    if (!previous.comma) throw new Error('invalid-property-comma-state')
    start = previous.comma.start
  }
  const output = replaceRange(bytes, start, end, '')
  parseDocument(output)
  return output
}

function normalizeComparablePath(value) {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function packageSource(value) {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.source === 'string') {
    return value.source
  }
  return null
}

function packageMatches(value, packageRoot, settingsDirectory) {
  const source = packageSource(value)
  if (source === null) return false
  const resolvedSource = path.isAbsolute(source)
    ? source
    : path.resolve(settingsDirectory, source)
  return normalizeComparablePath(resolvedSource) === normalizeComparablePath(packageRoot)
}

function inspect(bytes, packageRoot, settingsDirectory) {
  const parsed = parseDocument(bytes)
  const depthProperty = propertyOf(parsed, DEPTH_KEY)
  const packagesProperty = propertyOf(parsed, PACKAGES_KEY)
  if (packagesProperty && packagesProperty.value.type !== 'array') {
    throw new JsoncError('packages-not-array', packagesProperty.value.start)
  }
  const packages = packagesProperty ? nodeValue(packagesProperty.value) : []
  const matches = packages
    .map((value, index) => ({ index, value }))
    .filter(item => packageMatches(item.value, packageRoot, settingsDirectory))
  return {
    parsed,
    depth: depthProperty ? nodeValue(depthProperty.value) : undefined,
    depthPresent: Boolean(depthProperty),
    packages,
    packageMatches: matches,
  }
}

function appendPackage(bytes, packageRoot, settingsDirectory) {
  const state = inspect(bytes, packageRoot, settingsDirectory)
  if (state.packageMatches.length > 0) return { bytes, added: false }
  const packagesProperty = propertyOf(state.parsed, PACKAGES_KEY)
  const rawPackage = JSON.stringify(path.resolve(packageRoot))
  if (!packagesProperty) {
    return {
      bytes: insertProperty(bytes, PACKAGES_KEY, `[${rawPackage}]`),
      added: true,
    }
  }

  const array = packagesProperty.value
  const text = state.parsed.text
  const edits = []
  if (array.values.length === 0) {
    const interior = text.slice(array.openEnd, array.close)
    if (/\r|\n/.test(interior)) {
      const newline = getNewline(text)
      const closingIndent = indentationAt(text, array.close)
      const propertyIndent = indentationAt(text, packagesProperty.keyToken.start)
      const indent = `${propertyIndent}  `
      edits.push({
        start: array.close,
        end: array.close,
        value: `${indent}${rawPackage}${newline}${closingIndent}`,
      })
    } else {
      edits.push({ start: array.close, end: array.close, value: rawPackage })
    }
  } else {
    const last = array.values.at(-1)
    const multiline = /\r|\n/.test(text.slice(array.openEnd, array.close))
    if (multiline) {
      const newline = getNewline(text)
      const indent = indentationAt(text, array.values[0].value.start) ||
        `${indentationAt(text, packagesProperty.keyToken.start)}  `
      const closeStart = lineStart(text, array.close)
      const insertAt = /^[\t ]*$/.test(text.slice(closeStart, array.close))
        ? closeStart
        : array.close
      if (!last.comma) edits.push({ start: last.value.end, end: last.value.end, value: ',' })
      edits.push({ start: insertAt, end: insertAt, value: `${indent}${rawPackage}${newline}` })
    } else {
      const separator = last.comma ? ' ' : ', '
      edits.push({ start: array.close, end: array.close, value: `${separator}${rawPackage}` })
    }
  }
  const output = encodeDocument(applyTextEdits(text, edits), state.parsed.hasBom)
  parseDocument(output)
  return { bytes: output, added: true }
}

function removeArrayItem(bytes, propertyKey, index) {
  const parsed = parseDocument(bytes)
  const property = propertyOf(parsed, propertyKey)
  if (!property || property.value.type !== 'array') return bytes
  const items = property.value.values
  if (index < 0 || index >= items.length) throw new Error('array-index-out-of-range')
  const item = items[index]
  let start = item.value.start
  let end = item.value.end
  if (item.comma) {
    end = item.comma.end
  } else if (index > 0) {
    const previous = items[index - 1]
    if (!previous.comma) throw new Error('invalid-array-comma-state')
    start = previous.comma.start
  }
  const output = replaceRange(bytes, start, end, '')
  parseDocument(output)
  return output
}

function installSettings(existingBytes, packageRoot, settingsDirectory) {
  const initial = inspect(existingBytes, packageRoot, settingsDirectory)
  if (initial.packageMatches.length > 1) throw new Error('duplicate-autoprompt-package-entry')
  const depthProperty = propertyOf(initial.parsed, DEPTH_KEY)
  const priorDepth = depthProperty
    ? {
        kind: 'value',
        raw: initial.parsed.text.slice(depthProperty.value.start, depthProperty.value.end),
        value: initial.depth,
      }
    : { kind: 'absent' }

  let bytes = existingBytes
  let depthChanged = false
  if (initial.depth !== 4 || !initial.depthPresent) {
    bytes = setProperty(bytes, DEPTH_KEY, '4')
    depthChanged = true
  }
  const appended = appendPackage(bytes, packageRoot, settingsDirectory)
  bytes = appended.bytes
  const final = inspect(bytes, packageRoot, settingsDirectory)
  if (final.depth !== 4 || final.packageMatches.length !== 1) {
    throw new Error('settings-postcondition-failed')
  }
  return {
    bytes,
    changed: depthChanged || appended.added,
    depthChanged,
    packageAdded: appended.added,
    priorDepth,
    priorPackages: initial.packages,
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value)
}

function uninstallSettings(existingBytes, packageRoot, settingsDirectory, receipt) {
  const initial = inspect(existingBytes, packageRoot, settingsDirectory)
  let bytes = existingBytes
  let packageRemoved = false
  let packageDrift = false
  if (receipt.packageAdded) {
    if (initial.packageMatches.length === 1) {
      bytes = removeArrayItem(bytes, PACKAGES_KEY, initial.packageMatches[0].index)
      packageRemoved = true
    } else {
      packageDrift = true
    }
  }

  const afterPackage = inspect(bytes, packageRoot, settingsDirectory)
  const packagesReturnedToPrior = stableJson(afterPackage.packages) === stableJson(receipt.priorPackages)
  let depthRestored = false
  let depthDrift = false
  if (receipt.depthChanged) {
    const safe = initial.depth === 4 && packageRemoved && packagesReturnedToPrior
    if (safe) {
      bytes = receipt.priorDepth.kind === 'absent'
        ? removeProperty(bytes, DEPTH_KEY)
        : setProperty(bytes, DEPTH_KEY, receipt.priorDepth.raw)
      depthRestored = true
    } else {
      depthDrift = true
    }
  }
  parseDocument(bytes)
  return { bytes, packageRemoved, packageDrift, depthRestored, depthDrift }
}

module.exports = {
  DEPTH_KEY,
  PACKAGES_KEY,
  JsoncError,
  inspect,
  installSettings,
  parseDocument,
  stableJson,
  uninstallSettings,
}
