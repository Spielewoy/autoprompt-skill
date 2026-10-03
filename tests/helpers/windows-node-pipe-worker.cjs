'use strict'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const cp = require('node:child_process')
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex')

function snapshot(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('Worker path must be absolute')
  const resolved = path.resolve(file)
  if (fs.realpathSync.native(resolved) !== resolved) throw new Error('Worker path must be canonical and physical')
  for (let current = resolved;; current = path.dirname(current)) {
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink()) throw new Error('Worker path must not contain symbolic links')
    if (current !== resolved && !stat.isDirectory()) throw new Error('Worker ancestor must be a directory')
    if (path.dirname(current) === current) break
  }
  const before = fs.lstatSync(resolved)
  if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > 512 * 1024 * 1024) throw new Error('Worker must be a bounded singly linked regular file')
  const bytes = fs.readFileSync(resolved), after = fs.lstatSync(resolved)
  for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) if (before[key] !== after[key]) throw new Error('Worker changed while reading')
  if (bytes.length !== before.size) throw new Error('Worker byte length changed')
  return { file: resolved, bytes, sha256: digest(bytes) }
}

function bindWorker(environment = process.env) {
  const file = environment.AUTOPROMPT_NODE_PIPE_WORKER
  const expected = environment.AUTOPROMPT_NODE_PIPE_WORKER_SHA256
  const required = environment.AUTOPROMPT_NODE_PIPE_REQUIRE_SUPPORT
  if (required !== undefined && required !== '1') throw new Error('Required-support mode must be exactly 1')
  if ((file === undefined) !== (expected === undefined)) throw new Error('Worker path and SHA256 must be supplied together')
  if (expected !== undefined && !/^[a-f0-9]{64}$/.test(expected)) throw new Error('Worker SHA256 must be lowercase hexadecimal')
  const bound = snapshot(file === undefined ? fs.realpathSync.native(process.execPath) : file)
  if (expected !== undefined && bound.sha256 !== expected) throw new Error('Worker SHA256 mismatch')
  return { ...bound, requiredSupport: required === '1' }
}

function hostEnvironment() {
  const environment = { ...process.env }
  for (const key of Object.keys(environment)) if (/^(NODE_OPTIONS|NODE_PATH)$/i.test(key)) delete environment[key]
  return environment
}

function unchanged(worker) {
  if (snapshot(worker.file).sha256 !== worker.sha256) throw new Error('Bound worker changed')
}

function identify(worker) {
  const result = cp.spawnSync(worker.file, ['-e', 'process.stdout.write(JSON.stringify({node:process.version,uv:process.versions.uv,arch:process.arch}))'], {
    env: hostEnvironment(), encoding: 'utf8', timeout: 5000, maxBuffer: 4096, windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0 || result.stderr !== '') throw new Error('Bound worker version query failed')
  const identity = JSON.parse(result.stdout)
  if (Object.keys(identity).sort().join(',') !== 'arch,node,uv' || !/^v\d+\.\d+\.\d+$/.test(identity.node) || !/^\d+\.\d+\.\d+$/.test(identity.uv) || identity.arch !== process.arch) throw new Error('Bound worker identity is invalid or has a different architecture')
  unchanged(worker)
  return identity
}

module.exports = { bindWorker, identify, unchanged, hostEnvironment }
