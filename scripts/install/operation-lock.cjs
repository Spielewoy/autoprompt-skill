#!/usr/bin/env node
'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const LOCK_NAME = '.autoprompt-operation.lock'
const OWNER_NAME = 'owner.json'
const TOKEN_PATTERN = /^[a-f0-9]{32}$/

class OperationLockError extends Error {}

function fail(message) { throw new OperationLockError(message) }
function comparable(value) {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}
function isWithin(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}
function identity(stat) { return `${String(stat.dev)}:${String(stat.ino)}` }

class RootGuard {
  constructor(root) {
    this.root = path.resolve(root)
    const item = fs.lstatSync(this.root)
    if (!item.isDirectory() || item.isSymbolicLink()) fail(`physical root is not a real directory: ${this.root}`)
    this.rootReal = fs.realpathSync.native(this.root)
    this.rootIdentity = identity(fs.statSync(this.root))
  }

  assertRoot() {
    const item = fs.lstatSync(this.root)
    if (!item.isDirectory() || item.isSymbolicLink() ||
        comparable(fs.realpathSync.native(this.root)) !== comparable(this.rootReal) ||
        identity(fs.statSync(this.root)) !== this.rootIdentity) {
      fail(`physical root identity changed: ${this.root}`)
    }
  }

  assertExisting(candidate, kind = 'file') {
    this.assertRoot()
    const target = path.resolve(candidate)
    if (!isWithin(this.root, target)) fail(`path escapes physical root: ${target}`)
    const relative = path.relative(this.root, target)
    let current = this.root
    for (const component of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, component)
      const item = fs.lstatSync(current)
      if (item.isSymbolicLink()) fail(`symlink or reparse point refused: ${current}`)
      if (current !== target && !item.isDirectory()) fail(`ancestor is not a directory: ${current}`)
    }
    const item = fs.lstatSync(target)
    if (kind === 'file' && !item.isFile()) fail(`path is not a regular file: ${target}`)
    if (kind === 'directory' && !item.isDirectory()) fail(`path is not a directory: ${target}`)
    const physical = fs.realpathSync.native(target)
    if (!isWithin(this.rootReal, physical)) fail(`path escapes physical root: ${target}`)
    return target
  }

  assertParent(candidate) {
    const target = path.resolve(candidate)
    if (!isWithin(this.root, target) || target === this.root) fail(`mutation escapes physical root: ${target}`)
    this.assertExisting(path.dirname(target), 'directory')
    if (fs.existsSync(target)) this.assertExisting(target, fs.lstatSync(target).isDirectory() ? 'directory' : 'file')
    return target
  }
}

function parseOwner(bytes, ownerPath) {
  let owner
  try { owner = JSON.parse(bytes.toString('utf8')) } catch { fail(`operation lock owner is invalid: ${ownerPath}`) }
  if (!owner || owner.schemaVersion !== 1 || owner.hostname !== String(owner.hostname) ||
      !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !TOKEN_PATTERN.test(owner.token || '') ||
      typeof owner.operation !== 'string' || !owner.operation || typeof owner.startedAt !== 'string') {
    fail(`operation lock owner is invalid: ${ownerPath}`)
  }
  return owner
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true } catch (error) {
    if (error && error.code === 'EPERM') return true
    if (error && error.code === 'ESRCH') return false
    return true
  }
}

function removeStale(guard, lockPath, ownerPath, originalBytes, owner) {
  if (owner.hostname !== os.hostname() || processAlive(owner.pid)) return false
  guard.assertExisting(lockPath, 'directory')
  guard.assertExisting(ownerPath, 'file')
  if (!fs.readFileSync(ownerPath).equals(originalBytes)) fail('operation lock owner changed during stale-lock recovery')
  const entries = fs.readdirSync(lockPath)
  if (entries.length !== 1 || entries[0] !== OWNER_NAME) fail('operation lock contains unowned entries')
  fs.unlinkSync(ownerPath)
  fs.rmdirSync(lockPath)
  return true
}

function acquire(root, operation, options = {}) {
  const guard = options.guard || new RootGuard(root)
  const lockPath = path.join(guard.root, LOCK_NAME)
  const ownerPath = path.join(lockPath, OWNER_NAME)
  const pid = options.pid || process.pid
  const token = options.token || crypto.randomBytes(16).toString('hex')
  if (!Number.isSafeInteger(pid) || pid <= 0 || !TOKEN_PATTERN.test(token) || !operation) fail('operation lock arguments are invalid')
  for (let attempt = 0; attempt < 2; attempt += 1) {
    guard.assertRoot()
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 })
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error
      guard.assertExisting(lockPath, 'directory')
      guard.assertExisting(ownerPath, 'file')
      const bytes = fs.readFileSync(ownerPath)
      const owner = parseOwner(bytes, ownerPath)
      if (attempt === 0 && removeStale(guard, lockPath, ownerPath, bytes, owner)) continue
      fail(`operation lock is held by ${owner.operation} (pid ${owner.pid})`)
    }
    const owner = {
      schemaVersion: 1,
      hostname: os.hostname(),
      pid,
      token,
      operation: String(operation),
      startedAt: new Date().toISOString(),
    }
    try {
      fs.writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      return { guard, lockPath, ownerPath, owner }
    } catch (error) {
      try { fs.rmdirSync(lockPath) } catch {}
      throw error
    }
  }
  fail('operation lock could not be acquired')
}

function release(lease) {
  const { guard, lockPath, ownerPath, owner } = lease || {}
  if (!(guard instanceof RootGuard) || !owner) fail('operation lock lease is invalid')
  guard.assertExisting(lockPath, 'directory')
  guard.assertExisting(ownerPath, 'file')
  const current = parseOwner(fs.readFileSync(ownerPath), ownerPath)
  if (current.pid !== owner.pid || current.hostname !== owner.hostname || current.token !== owner.token) {
    fail('operation lock is no longer owned by this process')
  }
  const entries = fs.readdirSync(lockPath)
  if (entries.length !== 1 || entries[0] !== OWNER_NAME) fail('operation lock contains unowned entries')
  fs.unlinkSync(ownerPath)
  fs.rmdirSync(lockPath)
}

module.exports = { LOCK_NAME, OperationLockError, RootGuard, acquire, release }
