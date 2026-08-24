'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { exactKeys, fail, hashPattern, nonEmpty, sha256 } = require('./core.cjs')

function normalizeEvidencePath(relativePath) {
  nonEmpty(relativePath, 'EVIDENCE_PATH_INVALID', 'relativePath')
  if (relativePath.includes('\\') || /[\u0000-\u001f\u007f:]/.test(relativePath)) fail('EVIDENCE_PATH_INVALID', 'evidence paths must be portable relative paths without controls, drive syntax, or alternate streams')
  const parts = relativePath.split('/')
  const reserved = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9]|lpt[1-9])(?:\..*)?$/i
  if (path.isAbsolute(relativePath) || relativePath.startsWith('/') || parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || reserved.test(part))) {
    fail('EVIDENCE_PATH_INVALID', `unsafe evidence path: ${relativePath}`)
  }
  return parts.join('/')
}

function resolveContained(evidenceRoot, relativePath, options = {}) {
  const relative = normalizeEvidencePath(relativePath)
  const root = path.resolve(evidenceRoot)
  let rootReal
  try { rootReal = fs.realpathSync.native(root) } catch (error) {
    fail('EVIDENCE_ROOT_INVALID', `evidence root is unavailable: ${root}`, { cause: error.code })
  }
  let cursor = root
  for (const part of relative.split('/')) {
    cursor = path.join(cursor, part)
    let stats
    try { stats = fs.lstatSync(cursor) } catch (error) {
      fail('EVIDENCE_FILE_MISSING', `evidence path is unavailable: ${relative}`, { cause: error.code })
    }
    if (stats.isSymbolicLink()) fail('EVIDENCE_PATH_INVALID', `evidence path contains a symbolic link: ${relative}`)
  }
  const resolved = fs.realpathSync.native(cursor)
  const prefix = rootReal.endsWith(path.sep) ? rootReal : `${rootReal}${path.sep}`
  if (resolved !== rootReal && !resolved.startsWith(prefix)) fail('EVIDENCE_PATH_INVALID', `evidence path escapes its root: ${relative}`)
  const stats = fs.statSync(resolved)
  if (options.directory ? !stats.isDirectory() : !stats.isFile()) {
    fail('EVIDENCE_PATH_INVALID', `evidence path has the wrong type: ${relative}`)
  }
  return { relativePath: relative, resolved, stats, root: rootReal }
}

function validateBlobDescriptor(descriptor, code = 'EVIDENCE_BLOB_INVALID') {
  exactKeys(descriptor, ['relativePath', 'sha256', 'bytes'], code, 'evidence blob')
  normalizeEvidencePath(descriptor.relativePath)
  if (!hashPattern(descriptor.sha256) || !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 0) {
    fail(code, `invalid evidence blob: ${descriptor.relativePath}`)
  }
  return descriptor
}

function describeEvidenceFile(evidenceRoot, relativePath) {
  const file = resolveContained(evidenceRoot, relativePath)
  const bytes = fs.readFileSync(file.resolved)
  return Object.freeze({ relativePath: file.relativePath, sha256: sha256(bytes), bytes: bytes.length })
}

function verifyEvidenceFile(evidenceRoot, descriptor, code = 'EVIDENCE_BLOB_INVALID') {
  validateBlobDescriptor(descriptor, code)
  const file = resolveContained(evidenceRoot, descriptor.relativePath)
  const bytes = fs.readFileSync(file.resolved)
  if (bytes.length !== descriptor.bytes || sha256(bytes) !== descriptor.sha256) {
    fail(code, `evidence bytes do not match their descriptor: ${descriptor.relativePath}`)
  }
  return { ...file, bytes }
}

function readVerifiedJson(evidenceRoot, descriptor, code = 'EVIDENCE_JSON_INVALID') {
  const verified = verifyEvidenceFile(evidenceRoot, descriptor, code)
  let parsed
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(verified.bytes)) } catch (error) {
    fail(code, `evidence JSON is invalid: ${descriptor.relativePath}`, { cause: error.message })
  }
  return parsed
}

module.exports = {
  describeEvidenceFile,
  normalizeEvidencePath,
  readVerifiedJson,
  resolveContained,
  validateBlobDescriptor,
  verifyEvidenceFile,
}
