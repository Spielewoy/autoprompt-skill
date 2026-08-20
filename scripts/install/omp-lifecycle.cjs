#!/usr/bin/env node
'use strict'

// omp-lifecycle.cjs - install / uninstall / doctor for the oh-my-pi (omp)
// Autoprompt adapter. Mirrors the prime native-package adapter contract:
//
//   node omp-lifecycle.cjs install   --repo-root <root> [--omp-cli <path>]
//   node omp-lifecycle.cjs uninstall --repo-root <root>
//   node omp-lifecycle.cjs doctor    --repo-root <root> [--omp-cli <path>]
//
// Landing (all under the active omp agent dir, getAgentDir()):
//   skills/autoprompt/...          skill payload (SKILL.md + doctrine + workflow)
//   agents/ap-*.md                 the 25 registered personas
//   commands/autoprompt.md         the /autoprompt slash command
//   config.yml                     task.maxRecursionDepth set to >= 4 (backed up)
//
// Safety: the agent dir is resolved from the same environment omp itself honors
// (PI_CONFIG_DIR / PI_CODING_AGENT_DIR / OMP_PROFILE / PI_PROFILE), a lock file
// serializes concurrent operations, unowned collisions refuse loudly, every
// landing path is checked against symlinks/reparse points, and uninstall is
// receipt-scoped with content-identity checks so it never deletes user files.

const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ompSettings = require('./omp-settings.cjs')

const PROVIDER = 'omp'
const OMP_VERSION_FLOOR = '17.3.8'
const RECEIPT_NAME = '.autoprompt-omp-install.json'
const LOCK_NAME = '.autoprompt-omp-install.lock'
const VERSION_FILENAME = 'VERSION'
const HASH_PATTERN = /^[a-f0-9]{64}$/

class LifecycleError extends Error {
  constructor(reason, details = {}) {
    super(reason)
    this.name = 'LifecycleError'
    this.reason = reason
    this.details = details
  }
}

function normalizedIdentity(input) {
  const resolved = path.resolve(input)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function samePath(left, right) {
  return normalizedIdentity(left) === normalizedIdentity(right)
}

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === '' || (!relative.startsWith(`..${path.sep}`) &&
    relative !== '..' && !path.isAbsolute(relative))
}

function realpath(target) {
  return fs.realpathSync.native ? fs.realpathSync.native(target) : fs.realpathSync(target)
}

function lstatIfPresent(target) {
  try {
    return fs.lstatSync(target)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function pathEscape(target, detail) {
  throw new LifecycleError('omp-path-escape', { path: target, detail })
}

function statIdentity(stat) {
  return `${stat.dev}:${stat.ino}`
}

function anchorIsCurrent(anchor) {
  const stat = lstatIfPresent(anchor.path)
  if (!stat || statIdentity(stat) !== anchor.identity) return false
  try { return samePath(realpath(anchor.path), anchor.physical) } catch { return false }
}

// Walk every existing ancestor of `target` up to and including `root`; refuse
// any symlink/reparse point in the chain (anchor recorded by the caller).
function assertNoLinkInChain(root, target) {
  const rootReal = realpath(root)
  let current = path.resolve(target)
  const rootDir = path.resolve(root)
  while (true) {
    if (samePath(current, rootReal) || samePath(current, rootDir)) break
    const stat = lstatIfPresent(current)
    if (stat && (stat.isSymbolicLink() || (stat.isDirectory() === false && !stat.isFile()))) {
      throw new LifecycleError('omp-symlink-refused', { path: current })
    }
    const parent = path.dirname(current)
    if (samePath(parent, current)) break
    current = parent
  }
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function readText(file) {
  return fs.readFileSync(file, 'utf8')
}

function writeFileAtomic(file, bytes) {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, bytes)
  fs.renameSync(tmp, file)
}

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function emptyDir(dir) {
  try {
    return fs.readdirSync(dir).length === 0
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Root resolution (mirrors omp's own config discovery)
// ---------------------------------------------------------------------------

function normalizeProfile(name) {
  if (name == null) return undefined
  const trimmed = String(name).trim()
  return trimmed === '' || /^(default|null|none)$/i.test(trimmed) ? undefined : trimmed
}

function ompAgentDir() {
  // OMP_PROFILE wins when defined, including when explicitly empty (= default).
  const profileEnv = Object.prototype.hasOwnProperty.call(process.env, 'OMP_PROFILE')
    ? process.env.OMP_PROFILE
    : process.env.PI_PROFILE
  const profile = normalizeProfile(profileEnv)
  const baseName = process.env.PI_CONFIG_DIR || '.omp'
  const home = os.homedir()
  const base = path.isAbsolute(baseName) ? baseName : path.join(home, baseName)
  if (profile) return path.join(base, 'profiles', profile, 'agent')
  if (process.env.PI_CODING_AGENT_DIR) return path.resolve(process.env.PI_CODING_AGENT_DIR)
  return path.join(base, 'agent')
}

function resolveRoot(root) {
  if (root == null || root === '') {
    return path.resolve(ompAgentDir())
  }
  const resolved = path.resolve(root)
  if (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(resolved)) {
    throw new LifecycleError('omp-root-not-absolute', { path: resolved })
  }
  if (!path.isAbsolute(resolved)) {
    throw new LifecycleError('omp-root-not-absolute', { path: resolved })
  }
  return resolved
}

// ---------------------------------------------------------------------------
// Payload inventory
// ---------------------------------------------------------------------------

// All files shipped from agents/omp/ for the skill payload (everything except
// the 25 personas and the command file, which land in omp-native locations).
function payloadFiles(repoRoot) {
  const source = path.join(repoRoot, 'agents', 'omp')
  const out = []
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      const relPath = rel ? path.join(rel, entry.name) : entry.name
      if (entry.isDirectory()) walk(full, relPath)
      else out.push(relPath)
    }
  }
  walk(source, '')
  return out.filter((rel) => {
    const norm = rel.split(path.sep)
    return !(norm[0] === 'agents' && norm.length === 2 && /^ap-.*\.md$/.test(norm[1])) &&
      !(norm[0] === 'commands' && norm.length === 2)
  })
}

function personaFiles(repoRoot) {
  const dir = path.join(repoRoot, 'agents', 'omp', 'agents')
  return fs.readdirSync(dir)
    .filter((name) => /^ap-.*\.md$/.test(name))
    .sort()
}

function commandFiles(repoRoot) {
  const dir = path.join(repoRoot, 'agents', 'omp', 'commands')
  return fs.readdirSync(dir).filter((name) => /\.md$/.test(name))
}

// ---------------------------------------------------------------------------
// Receipt
// ---------------------------------------------------------------------------

function receiptPath(root) {
  return path.join(root, RECEIPT_NAME)
}

function lockPath(root) {
  return path.join(root, LOCK_NAME)
}

function readReceipt(root) {
  const file = receiptPath(root)
  if (!fs.existsSync(file)) return null
  let value
  try {
    value = JSON.parse(readText(file))
  } catch (error) {
    throw new LifecycleError('omp-corrupt-receipt', { path: file, message: error.message })
  }
  if (value.provider !== PROVIDER || !Array.isArray(value.files) || !Array.isArray(value.createdDirectories)) {
    throw new LifecycleError('omp-corrupt-receipt', { path: file })
  }
  return value
}

function writeReceipt(root, receipt) {
  writeFileAtomic(receiptPath(root), `${JSON.stringify(receipt, null, 2)}\n`)
}

function acquireLock(root) {
  const file = lockPath(root)
  try {
    const fd = fs.openSync(file, 'wx')
    fs.writeSync(fd, `${process.pid}\n`)
    fs.closeSync(fd)
  } catch (error) {
    if (error.code === 'EEXIST') throw new LifecycleError('omp-operation-locked', { path: file })
    throw error
  }
}

function releaseLock(root) {
  try {
    fs.unlinkSync(lockPath(root))
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Version detection
// ---------------------------------------------------------------------------

function detectCliVersion(ompCli) {
  const candidates = ompCli ? [ompCli] : ['omp']
  for (const candidate of candidates) {
    try {
      const output = childProcess.execFileSync(candidate, ['--version'], {
        encoding: 'utf8',
        timeout: 10000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim()
      const match = output.match(/(\d+(?:\.\d+){1,3})/)
      if (match) return { cli: candidate, version: match[1] }
    } catch {
      // try next candidate
    }
  }
  return null
}

function versionAtLeast(found, floor) {
  const seg = (v) => v.split('.').map((n) => parseInt(n, 10) || 0)
  const a = seg(found)
  const b = seg(floor)
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] || 0
    const y = b[i] || 0
    if (x !== y) return x > y
  }
  return true
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

function install(root, repoRoot, ompCli) {
  const agentDir = resolveRoot(root)
  const skillRoot = path.join(agentDir, 'skills', 'autoprompt')
  const agentsDir = path.join(agentDir, 'agents')
  const commandsDir = path.join(agentDir, 'commands')
  const configFile = path.join(agentDir, 'config.yml')
  const configYaml = path.join(agentDir, 'config.yaml')
  const configPath = fs.existsSync(configYaml) && !fs.existsSync(configFile) ? configYaml : configFile

  const prior = readReceipt(agentDir)

  // Collision contract: an unowned landing file refuses install; a prior receipt
  // means the tree is ours (repair/update) and is overwritten.
  const owned = new Set(prior ? prior.files.map((f) => f.path) : [])
  const ownedNormalized = new Set([...owned].map((p) => normalizedIdentity(p)))
  const checkCollision = (target) => {
    const stat = lstatIfPresent(target)
    if (!stat) return
    if (ownedNormalized.has(normalizedIdentity(target))) return
    throw new LifecycleError('omp-unowned-collision', { path: target })
  }

  // Symlink/reparse safety for the landing tree and config file.
  assertNoLinkInChain(agentDir, agentDir)
  for (const dir of [skillRoot, agentsDir, commandsDir]) {
    if (fs.existsSync(dir)) assertNoLinkInChain(agentDir, dir)
  }
  if (fs.existsSync(configPath)) assertNoLinkInChain(agentDir, configPath)

  // Enumerate the landing plan.
  const plan = []
  const addFile = (source, target) => {
    checkCollision(target)
    plan.push({ source, target, hash: sha256(fs.readFileSync(source)) })
  }
  const addDir = (sourceDir, targetDir) => {
    const walk = (dir, rel) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        const relPath = rel ? path.join(rel, entry.name) : entry.name
        if (entry.isDirectory()) walk(full, relPath)
        else addFile(full, path.join(targetDir, relPath))
      }
    }
    walk(sourceDir, '')
  }

  const sourceRoot = path.join(repoRoot, 'agents', 'omp')
  addFile(path.join(sourceRoot, 'SKILL.md'), path.join(skillRoot, 'SKILL.md'))
  for (const rel of payloadFiles(repoRoot)) {
    if (rel === 'SKILL.md') continue
    addFile(path.join(sourceRoot, rel), path.join(skillRoot, rel))
  }
  for (const name of personaFiles(repoRoot)) {
    addFile(path.join(sourceRoot, 'agents', name), path.join(agentsDir, name))
  }
  for (const name of commandFiles(repoRoot)) {
    addFile(path.join(sourceRoot, 'commands', name), path.join(commandsDir, name))
  }

  // Write every file, recording created directories for uninstall.
  const createdDirectories = []
  const written = []
  const recordDir = (dir) => {
    const rel = path.relative(agentDir, dir)
    if (rel === '' || rel.startsWith('..')) return
    createdDirectories.push(rel)
  }
  for (const item of plan) {
    const parent = path.dirname(item.target)
    if (!fs.existsSync(parent)) {
      mkdirp(parent)
      recordDir(parent)
      for (const ancestor of dirsFrom(agentDir, parent)) recordDir(ancestor)
    }
    writeFileAtomic(item.target, fs.readFileSync(item.source))
    written.push({ path: item.target, hash: item.hash })
  }

  // Config edit: task.maxRecursionDepth >= 4, backed up for rollback.
  let configEdit = null
  let settingsApplied = null
  try {
    settingsApplied = ompSettings.install(configPath)
  } catch (error) {
    throw new LifecycleError('omp-config-edit-failed', { path: configPath, message: error.message })
  }
  if (settingsApplied && settingsApplied.changed) {
    configEdit = {
      file: configPath,
      created: settingsApplied.created === true,
      previous: settingsApplied.previous ? settingsApplied.previous.toString('base64') : null,
      applied: settingsApplied.applied ? settingsApplied.applied.toString('base64') : null,
      backup: `${configPath}.autoprompt.backup`,
    }
    // Only back up a pre-existing config's bytes; a freshly created config has
    // no prior content and is deleted (not restored) on uninstall.
    if (!configEdit.created) {
      fs.writeFileSync(configEdit.backup, settingsApplied.previous || Buffer.alloc(0))
    } else {
      configEdit.backup = null
    }
  }

  const versionInfo = detectCliVersion(ompCli)
  const receipt = {
    provider: PROVIDER,
    nonce: `OMP-${Date.now()}-${process.pid}`,
    root: agentDir,
    version: readText(path.join(sourceRoot, VERSION_FILENAME)).trim(),
    cli: versionInfo,
    files: written,
    createdDirectories,
    configEdit,
    installedAt: new Date().toISOString(),
  }
  writeReceipt(agentDir, receipt)
  return receipt
}

function dirsFrom(agentDir, target) {
  const out = []
  let current = path.dirname(target)
  const root = path.resolve(agentDir)
  while (isWithin(root, current) && !samePath(current, root)) {
    out.push(path.relative(root, current))
    const parent = path.dirname(current)
    if (samePath(parent, current)) break
    current = parent
  }
  return out
}

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

function uninstall(root) {
  const agentDir = resolveRoot(root)
  const receipt = readReceipt(agentDir)
  if (!receipt) {
    return { removed: 0, reason: 'no-receipt' }
  }
  if (!samePath(receipt.root, agentDir)) {
    throw new LifecycleError('omp-receipt-root-mismatch', { receipt: receipt.root, root: agentDir })
  }
  if (receipt.files.some((f) => !isWithin(agentDir, f.path))) {
    throw new LifecycleError('omp-receipt-path-escape', { root: agentDir })
  }

  let removed = 0
  // Remove files newest-first, only when content still matches what we wrote.
  for (const record of [...receipt.files].reverse()) {
    const current = lstatIfPresent(record.path)
    if (!current) continue
    if (current.isSymbolicLink()) {
      throw new LifecycleError('omp-uninstall-symlink-refused', { path: record.path })
    }
    let currentHash
    try {
      currentHash = sha256(fs.readFileSync(record.path))
    } catch {
      continue
    }
    if (currentHash !== record.hash) {
      throw new LifecycleError('omp-uninstall-content-mismatch', { path: record.path })
    }
    fs.unlinkSync(record.path)
    removed += 1
  }

  // Reverse the config edit only when the current file still matches applied:
  // a created config is deleted, an edited config is restored to its prior bytes.
  if (receipt.configEdit) {
    const previous = Buffer.from(receipt.configEdit.previous || '', 'base64')
    const applied = Buffer.from(receipt.configEdit.applied || '', 'base64')
    ompSettings.uninstall(receipt.configEdit.file, previous, applied, receipt.configEdit.created === true)
    try {
      if (receipt.configEdit.backup && fs.existsSync(receipt.configEdit.backup)) {
        fs.unlinkSync(receipt.configEdit.backup)
      }
    } catch {
      // best-effort
    }
  }

  // Remove created directories (deepest first, empty only).
  for (const rel of [...receipt.createdDirectories].reverse()) {
    const dir = path.join(agentDir, rel)
    if (!isWithin(agentDir, dir)) continue
    if (!emptyDir(dir)) continue
    try {
      fs.rmdirSync(dir)
    } catch (error) {
      if (error.code !== 'ENOENT') break
    }
  }

  fs.unlinkSync(receiptPath(agentDir))
  return { removed }
}

// ---------------------------------------------------------------------------
// Doctor
// ---------------------------------------------------------------------------

function doctor(root, repoRoot, ompCli) {
  const agentDir = resolveRoot(root)
  const receipt = readReceipt(agentDir)
  const issues = []

  if (!receipt) {
    throw new LifecycleError('omp-not-installed', { root: agentDir })
  }
  if (receipt.files.some((f) => !isWithin(agentDir, f.path))) {
    throw new LifecycleError('omp-receipt-path-escape', { root: agentDir })
  }

  for (const record of receipt.files) {
    const stat = lstatIfPresent(record.path)
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
      issues.push(`missing:${record.path}`)
      continue
    }
    let currentHash
    try {
      currentHash = sha256(fs.readFileSync(record.path))
    } catch {
      issues.push(`unreadable:${record.path}`)
      continue
    }
    if (currentHash !== record.hash) issues.push(`hash-mismatch:${record.path}`)
  }

  // Persona count and naming contract.
  const agentsDir = path.join(agentDir, 'agents')
  const personas = fs.existsSync(agentsDir)
    ? fs.readdirSync(agentsDir).filter((name) => /^ap-.*\.md$/.test(name))
    : []
  if (personas.length !== 25) issues.push(`personas=${personas.length}`)

  // Config depth contract.
  const configFile = path.join(agentDir, 'config.yml')
  const configYaml = path.join(agentDir, 'config.yaml')
  const configPath = fs.existsSync(configFile) ? configFile : configYaml
  if (fs.existsSync(configPath)) {
    const depth = ompSettings.currentDepth(configPath)
    if (depth === null || depth < 4) issues.push(`maxRecursionDepth=${depth === null ? 'absent' : depth}`)
  } else {
    issues.push('maxRecursionDepth=absent')
  }

  // CLI version floor (when resolvable).
  const versionInfo = detectCliVersion(ompCli)
  if (versionInfo) {
    if (!versionAtLeast(versionInfo.version, OMP_VERSION_FLOOR)) {
      issues.push(`version=${versionInfo.version}<${OMP_VERSION_FLOOR}`)
    }
  }

  if (issues.length > 0) {
    throw new LifecycleError('omp-doctor-invalid', { issues })
  }
  return { ok: true, version: versionInfo ? versionInfo.version : null }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function runCli(argv) {
  const command = argv[0]
  const args = {}
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--repo-root') args.repoRoot = argv[++index]
    else if (arg === '--omp-cli') args.ompCli = argv[++index]
    else throw new LifecycleError(`unknown-argument: ${arg}`)
  }
  if (args.repoRoot == null) throw new LifecycleError('repo-root-required')
  const repoRoot = path.resolve(args.repoRoot)
  if (!fs.existsSync(path.join(repoRoot, 'agents', 'omp'))) {
    throw new LifecycleError('repo-root-invalid', { path: repoRoot })
  }

  let result
  switch (command) {
    case 'install': {
      const root = resolveRoot(null)
      acquireLock(root)
      try {
        result = install(root, repoRoot, args.ompCli)
      } finally {
        releaseLock(root)
      }
      // install.sh / install.ps1 parse value.health.packageRoot from the output.
      process.stdout.write(`${JSON.stringify({
        status: 'installed',
        receipt: result.nonce,
        health: { packageRoot: result.root, files: result.files.length, maxRecursionDepth: 4 },
      })}\n`)
      return 0
    }
    case 'uninstall': {
      const root = resolveRoot(null)
      acquireLock(root)
      try {
        result = uninstall(root)
      } finally {
        releaseLock(root)
      }
      process.stdout.write(`${JSON.stringify(result)}\n`)
      return 0
    }
    case 'doctor': {
      result = doctor(resolveRoot(null), repoRoot, args.ompCli)
      process.stdout.write(`${JSON.stringify(result)}\n`)
      return 0
    }
    default:
      throw new LifecycleError(`unknown-command: ${command}`)
  }
}

if (require.main === module) {
  try {
    const code = runCli(process.argv.slice(2))
    process.exitCode = code
  } catch (error) {
    const reason = error.reason || 'omp-lifecycle-error'
    const details = error.details || {}
    process.stderr.write(`${JSON.stringify({ reason, ...details })}\n`)
    process.exitCode = 1
  }
}

module.exports = {
  install,
  uninstall,
  doctor,
  ompAgentDir,
  resolveRoot,
  RECEIPT_NAME,
}