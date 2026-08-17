#!/usr/bin/env node
'use strict'

const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const primeSettings = require('./prime-settings.cjs')

const PROVIDER = 'prime'
const PRIME_VERSION = '0.7.2'
const RECEIPT_NAME = '.autoprompt-prime-install.json'
const LOCK_NAME = '.autoprompt-prime-install.lock'
const SETTINGS_NAME = 'settings.json'
const SETTINGS_BACKUP_NAME = '.autoprompt-prime-settings.backup'
const PACKAGE_RELATIVE = path.join('autoprompt', 'packages', 'prime')
const PACKAGE_BACKUP_NAME = '.autoprompt-prime-package.backup'
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
  throw new LifecycleError('prime-path-escape', { path: target, detail })
}

function statIdentity(stat) {
  return `${stat.dev}:${stat.ino}`
}

function anchorIsCurrent(anchor) {
  const stat = lstatIfPresent(anchor.path)
  if (!stat || statIdentity(stat) !== anchor.identity) return false
  try { return samePath(realpath(anchor.path), anchor.physical) } catch { return false }
}

function createdDirectoryIsCurrent(anchor, record) {
  if (!anchorIsCurrent(anchor) || !isWithin(anchor.path, record.path) ||
      !isWithin(anchor.physical, record.physical)) return false
  const stat = lstatIfPresent(record.path)
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory() ||
      statIdentity(stat) !== record.identity) return false
  try { return samePath(realpath(record.path), record.physical) } catch { return false }
}

function removeCreatedDirectories(anchor, createdPaths) {
  let removed = 0
  for (const record of [...createdPaths].reverse()) {
    if (!lstatIfPresent(record.path)) continue
    if (!createdDirectoryIsCurrent(anchor, record)) break
    if (fs.readdirSync(record.path).length !== 0) break
    if (!createdDirectoryIsCurrent(anchor, record)) break
    try {
      fs.rmdirSync(record.path)
      removed += 1
    } catch (error) {
      if (error.code === 'ENOENT') continue
      if (error.code === 'ENOTEMPTY' || error.code === 'EEXIST') break
      throw error
    }
  }
  return removed
}

function createDirectoryChain(configRoot) {
  const missing = []
  let anchorPath = configRoot
  let anchorStat = lstatIfPresent(anchorPath)
  while (!anchorStat) {
    missing.unshift(anchorPath)
    const parent = path.dirname(anchorPath)
    if (parent === anchorPath) pathEscape(configRoot, 'no-existing-ancestor')
    anchorPath = parent
    anchorStat = lstatIfPresent(anchorPath)
  }
  const followedAnchor = fs.statSync(anchorPath)
  if (!followedAnchor.isDirectory()) pathEscape(anchorPath, 'ancestor-not-directory')
  const anchor = {
    path: path.resolve(anchorPath),
    physical: realpath(anchorPath),
    identity: statIdentity(anchorStat),
  }
  const createdPaths = []
  try {
    for (const target of missing) {
      if (!anchorIsCurrent(anchor)) pathEscape(anchor.path, 'ancestor-changed')
      let made = false
      try {
        fs.mkdirSync(target, { recursive: false })
        made = true
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
      }
      const stat = lstatIfPresent(target)
      if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
        pathEscape(target, 'created-directory-invalid')
      }
      const physical = realpath(target)
      const relative = path.relative(anchor.path, target)
      const expected = path.join(anchor.physical, ...relative.split(path.sep))
      if (!isWithin(anchor.physical, physical) || !samePath(physical, expected)) {
        pathEscape(target, 'created-directory-redirected')
      }
      if (made) createdPaths.push({
        path: path.resolve(target),
        physical,
        identity: statIdentity(stat),
      })
    }
    return { anchor, createdPaths }
  } catch (error) {
    removeCreatedDirectories(anchor, createdPaths)
    throw error
  }
}

function createPathGuard(configRoot, create = false) {
  let stat = lstatIfPresent(configRoot)
  let creation = null
  if (create && !stat) {
    creation = createDirectoryChain(configRoot)
    stat = lstatIfPresent(configRoot)
  }
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    pathEscape(configRoot, 'config-root-invalid')
  }
  return {
    configRoot: path.resolve(configRoot),
    physicalRoot: realpath(configRoot),
    rootIdentity: statIdentity(stat),
    creation,
  }
}

function assertManagedPath(guard, target) {
  const absolute = path.resolve(target)
  if (!isWithin(guard.configRoot, absolute)) pathEscape(absolute, 'outside-config-root')
  const rootStat = lstatIfPresent(guard.configRoot)
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory() ||
      statIdentity(rootStat) !== guard.rootIdentity ||
      !samePath(realpath(guard.configRoot), guard.physicalRoot)) {
    pathEscape(guard.configRoot, 'config-root-changed')
  }
  const relative = path.relative(guard.configRoot, absolute)
  if (!relative) return absolute
  const parts = relative.split(path.sep)
  let current = guard.configRoot
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index])
    const stat = lstatIfPresent(current)
    if (!stat) break
    if (stat.isSymbolicLink()) pathEscape(current, 'link-forbidden')
    if (index < parts.length - 1 && !stat.isDirectory()) {
      pathEscape(current, 'ancestor-not-directory')
    }
    const expected = path.join(guard.physicalRoot, ...parts.slice(0, index + 1))
    if (!samePath(realpath(current), expected)) pathEscape(current, 'reparse-forbidden')
  }
  return absolute
}

function removeCreatedConfigRoot(guard) {
  if (!guard.creation) return false
  return removeCreatedDirectories(guard.creation.anchor, guard.creation.createdPaths) > 0
}

function safeMkdir(guard, target, options) {
  assertManagedPath(guard, target)
  fs.mkdirSync(target, options)
  assertManagedPath(guard, target)
}

function safeWriteFile(guard, target, bytes, options) {
  assertManagedPath(guard, target)
  fs.writeFileSync(target, bytes, options)
}

function safeOpen(guard, target, flags, mode) {
  assertManagedPath(guard, target)
  return fs.openSync(target, flags, mode)
}

function safeRename(guard, source, destination) {
  assertManagedPath(guard, source)
  assertManagedPath(guard, destination)
  fs.renameSync(source, destination)
  assertManagedPath(guard, destination)
}

function safeCopyFile(guard, source, destination, flags) {
  assertManagedPath(guard, destination)
  fs.copyFileSync(source, destination, flags)
}

function safeRm(guard, target, options) {
  assertManagedPath(guard, target)
  fs.rmSync(target, options)
}

function safeRmdir(guard, target) {
  assertManagedPath(guard, target)
  fs.rmdirSync(target)
}

function containsTraversal(input) {
  return input.split(/[\\/]+/).some(part => part === '..')
}

function homeDirectory(environment) {
  return environment.HOME || environment.USERPROFILE || os.homedir()
}

function resolveConfigRoot(options = {}) {
  const environment = options.env || process.env
  const raw = options.configRoot || environment.AUTOPROMPT_INSTALL_ROOT ||
    environment.PRIME_AGENT_CODING_AGENT_DIR ||
    path.join(homeDirectory(environment), '.prime', 'agent')
  if (typeof raw !== 'string' || raw.trim() === '' || raw.includes('\0')) {
    throw new LifecycleError('invalid-install-root')
  }
  if (!path.isAbsolute(raw) || containsTraversal(raw)) {
    throw new LifecycleError('invalid-install-root', { root: raw })
  }
  const resolved = path.resolve(raw)
  if (resolved === path.parse(resolved).root) {
    throw new LifecycleError('invalid-install-root', { root: resolved })
  }
  const stat = lstatIfPresent(resolved)
  if (stat) {
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new LifecycleError('invalid-install-root', { root: resolved })
    }
  }
  return resolved
}

function resolvePaths(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || path.join(__dirname, '..', '..'))
  const configRoot = resolveConfigRoot(options)
  const sourceRoot = path.join(repoRoot, 'agents', 'prime')
  const manifestPath = path.join(repoRoot, 'agents', 'manifests', 'prime-runtime.json')
  const packageRoot = path.join(configRoot, PACKAGE_RELATIVE)
  const settingsPath = path.join(configRoot, SETTINGS_NAME)
  const settingsBackupPath = path.join(configRoot, SETTINGS_BACKUP_NAME)
  const receiptPath = path.join(configRoot, RECEIPT_NAME)
  const lockPath = path.join(configRoot, LOCK_NAME)
  const packageBackupPath = path.join(configRoot, PACKAGE_BACKUP_NAME)

  if (isWithin(sourceRoot, configRoot) || isWithin(configRoot, sourceRoot)) {
    throw new LifecycleError('source-install-root-overlap')
  }
  return {
    repoRoot,
    configRoot,
    sourceRoot,
    manifestPath,
    packageRoot,
    settingsPath,
    settingsBackupPath,
    receiptPath,
    lockPath,
    packageBackupPath,
  }
}

function canonicalBytes(file) {
  const bytes = fs.readFileSync(file)
  return Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')
}

function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function sha256File(file) {
  return sha256Bytes(fs.readFileSync(file))
}

function canonicalSha256(file) {
  return sha256Bytes(canonicalBytes(file))
}

function listFiles(directory) {
  if (!fs.existsSync(directory)) return []
  const output = []
  function visit(current, prefix) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const target = path.join(current, entry.name)
      if (entry.isSymbolicLink()) throw new LifecycleError('package-symlink-forbidden', { path: target })
      if (entry.isDirectory()) visit(target, relative)
      else if (entry.isFile()) output.push(relative)
      else throw new LifecycleError('package-special-file-forbidden', { path: target })
    }
  }
  visit(directory, '')
  return output.sort()
}

function readManifest(manifestPath) {
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    throw new LifecycleError('prime-manifest-unreadable', { cause: error.message })
  }
  if (manifest.schemaVersion !== 1 || manifest.provider !== PROVIDER ||
      manifest.sourceRoot !== 'agents/prime' || !Array.isArray(manifest.files) ||
      manifest.files.length !== 48 || manifest.files.some(file =>
        typeof file !== 'string' || file === '' || path.isAbsolute(file) ||
        file.includes('\\') || containsTraversal(file))) {
    throw new LifecycleError('prime-manifest-invalid')
  }
  const sorted = [...manifest.files].sort()
  if (new Set(sorted).size !== sorted.length ||
      sorted.some((file, index) => file !== manifest.files[index])) {
    throw new LifecycleError('prime-manifest-noncanonical')
  }
  if (!manifest.sha256 || Object.keys(manifest.sha256).sort().join('\n') !== sorted.join('\n')) {
    throw new LifecycleError('prime-manifest-hashes-invalid')
  }
  for (const file of sorted) {
    if (!HASH_PATTERN.test(manifest.sha256[file])) {
      throw new LifecycleError('prime-manifest-hashes-invalid', { file })
    }
  }
  return manifest
}

function verifyPayload(directory, manifest) {
  const actual = listFiles(directory)
  if (actual.join('\n') !== manifest.files.join('\n')) {
    throw new LifecycleError('prime-package-inventory-mismatch', {
      expected: manifest.files.length,
      actual: actual.length,
    })
  }
  for (const relative of manifest.files) {
    const target = path.join(directory, ...relative.split('/'))
    const actualHash = canonicalSha256(target)
    if (actualHash !== manifest.sha256[relative]) {
      throw new LifecycleError('prime-package-hash-mismatch', { file: relative })
    }
  }
}

function copyPayload(sourceRoot, destination, manifest, guard) {
  safeMkdir(guard, destination, { recursive: false })
  for (const relative of manifest.files) {
    const source = path.join(sourceRoot, ...relative.split('/'))
    const target = path.join(destination, ...relative.split('/'))
    const sourceStat = fs.lstatSync(source)
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      throw new LifecycleError('prime-source-file-invalid', { file: relative })
    }
    if (canonicalSha256(source) !== manifest.sha256[relative]) {
      throw new LifecycleError('prime-source-hash-mismatch', { file: relative })
    }
    safeMkdir(guard, path.dirname(target), { recursive: true })
    safeCopyFile(guard, source, target, fs.constants.COPYFILE_EXCL)
  }
  verifyPayload(destination, manifest)
}

function writeAtomic(file, bytes, guard, mode = 0o600) {
  assertManagedPath(guard, file)
  if (fs.existsSync(file)) mode = fs.statSync(file).mode
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`
  const replacement = `${file}.replace-${process.pid}-${crypto.randomBytes(6).toString('hex')}`
  safeMkdir(guard, path.dirname(file), { recursive: true })
  let movedExisting = false
  try {
    safeWriteFile(guard, temporary, bytes, { flag: 'wx', mode })
    if (fs.existsSync(file)) {
      if (fs.existsSync(replacement)) throw new LifecycleError('atomic-backup-collision')
      safeRename(guard, file, replacement)
      movedExisting = true
    }
    safeRename(guard, temporary, file)
    if (movedExisting) safeRm(guard, replacement, { force: true })
  } catch (error) {
    safeRm(guard, temporary, { force: true })
    if (movedExisting && fs.existsSync(replacement)) {
      safeRm(guard, file, { force: true })
      safeRename(guard, replacement, file)
    }
    throw error
  } finally {
    safeRm(guard, temporary, { force: true })
    if (!movedExisting) safeRm(guard, replacement, { force: true })
  }
}

function acquireLock(lockPath, guard) {
  let descriptor
  try {
    descriptor = safeOpen(guard, lockPath, 'wx', 0o600)
    fs.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`)
  } catch (error) {
    if (error.code === 'EEXIST') throw new LifecycleError('prime-install-busy')
    throw error
  }
  return () => {
    try { fs.closeSync(descriptor) } catch {}
    safeRm(guard, lockPath, { force: true })
  }
}

function receiptBytes(receipt) {
  return Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
}

function readReceipt(paths, required = true, guard) {
  if (guard) assertManagedPath(guard, paths.receiptPath)
  if (!fs.existsSync(paths.receiptPath)) {
    if (required) throw new LifecycleError('prime-receipt-missing')
    return null
  }
  let receipt
  try {
    receipt = JSON.parse(fs.readFileSync(paths.receiptPath, 'utf8'))
  } catch (error) {
    throw new LifecycleError('prime-receipt-invalid', { cause: error.message })
  }
  const priorDepthValid = receipt.priorDepth?.kind === 'absent' ||
    (receipt.priorDepth?.kind === 'value' && typeof receipt.priorDepth.raw === 'string')
  if (receipt.schemaVersion !== 1 || receipt.provider !== PROVIDER ||
      receipt.targetVersion !== PRIME_VERSION ||
      !samePath(receipt.packageRoot || '', paths.packageRoot) ||
      !samePath(receipt.settingsPath || '', paths.settingsPath) ||
      !samePath(receipt.settingsBackupPath || '', paths.settingsBackupPath) ||
      typeof receipt.packageAdded !== 'boolean' ||
      typeof receipt.depthChanged !== 'boolean' ||
      typeof receipt.settingsInitiallyExisted !== 'boolean' ||
      typeof receipt.fullRestoreSafe !== 'boolean' ||
      !Array.isArray(receipt.priorPackages) || !priorDepthValid ||
      !HASH_PATTERN.test(receipt.manifestSha256 || '') ||
      !HASH_PATTERN.test(receipt.managedSettingsSha256 || '')) {
    throw new LifecycleError('prime-receipt-invalid')
  }
  return receipt
}

function assertManagedTopology(paths, guard) {
  for (const target of [
    paths.packageRoot,
    paths.settingsPath,
    paths.settingsBackupPath,
    paths.receiptPath,
    paths.lockPath,
    paths.packageBackupPath,
  ]) assertManagedPath(guard, target)
}

function ensureNoUnsafeCollision(paths, receipt, guard) {
  assertManagedTopology(paths, guard)
  if (!receipt && fs.existsSync(paths.packageRoot)) {
    throw new LifecycleError('prime-package-collision', { path: paths.packageRoot })
  }
  if (!receipt && fs.existsSync(paths.settingsBackupPath)) {
    throw new LifecycleError('prime-settings-backup-collision', { path: paths.settingsBackupPath })
  }
  if (fs.existsSync(paths.packageBackupPath)) {
    throw new LifecycleError('prime-package-backup-collision', { path: paths.packageBackupPath })
  }
  if (fs.existsSync(paths.packageRoot) && fs.lstatSync(paths.packageRoot).isSymbolicLink()) {
    throw new LifecycleError('prime-package-symlink-forbidden')
  }
}

function removeDirectoryIfEmpty(directory, stop, guard) {
  let current = directory
  const stopIdentity = normalizedIdentity(stop)
  while (isWithin(stop, current) && normalizedIdentity(current) !== stopIdentity) {
    assertManagedPath(guard, current)
    if (!fs.existsSync(current) || fs.readdirSync(current).length !== 0) return
    safeRmdir(guard, current)
    current = path.dirname(current)
  }
}

function packageManifestChecks(packageRoot) {
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
  } catch (error) {
    throw new LifecycleError('prime-package-json-invalid', { cause: error.message })
  }
  const expectedResources = {
    extensions: ['./extensions/autoprompt.ts'],
    skills: ['./skills/autoprompt'],
    prompts: ['./prompts/frameworks'],
  }
  if (manifest.name !== 'autoprompt-prime-agent-adapter' || manifest.type !== 'module' ||
      JSON.stringify(manifest.pi) !== JSON.stringify(expectedResources) ||
      manifest.peerDependencies?.['@earendil-works/pi-coding-agent'] !== '*') {
    throw new LifecycleError('prime-package-resources-invalid')
  }
  const promptFiles = fs.readdirSync(path.join(packageRoot, 'prompts', 'frameworks'))
    .filter(file => file.endsWith('.md'))
  const personaFiles = fs.readdirSync(path.join(packageRoot, 'personas'))
    .filter(file => /^ap-.*\.md$/.test(file))
  if (promptFiles.length !== 18 || personaFiles.length !== 25) {
    throw new LifecycleError('prime-package-resource-count-invalid')
  }
  return { extensions: 1, skills: 1, prompts: 18, personas: 25 }
}

function normalizeWindowsChildPath(rawPath, environment = process.env) {
  if (process.platform !== 'win32' || typeof rawPath !== 'string') return rawPath
  const gitRoot = path.join(environment.ProgramFiles || 'C:\\Program Files', 'Git')
  const converted = rawPath.split(';').flatMap(segment => segment.split(/:(?=\/)/)).map(segment => {
    const match = segment.match(/^\/([A-Za-z])(?:\/(.*))?$/)
    if (match) {
      return `${match[1].toUpperCase()}:\\${(match[2] || '').replaceAll('/', '\\')}`
    }
    if (segment === '/usr/bin' || segment === '/bin') return path.join(gitRoot, 'usr', 'bin')
    return segment
  }).filter(Boolean)
  return [...new Map(converted.map(entry => [entry.toLowerCase(), entry])).values()]
    .join(path.delimiter)
}

function childEnvironment(environment = process.env, additions = {}) {
  const result = Object.fromEntries(Object.entries(environment).filter(([key]) =>
    !/(?:API[_-]?KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD|AUTH)/i.test(key)))
  if (process.platform === 'win32') {
    const pathEntry = Object.entries(result).find(([key]) => key.toUpperCase() === 'PATH')
    for (const key of Object.keys(result)) {
      if (key.toUpperCase() === 'PATH') delete result[key]
    }
    if (pathEntry) result.PATH = normalizeWindowsChildPath(pathEntry[1], environment)
  }
  return { ...result, ...additions }
}

function pythonCandidates(environment = process.env) {
  if (process.platform !== 'win32') return [['python3', []], ['python', []]]
  const candidates = []
  const add = (command, prefix = []) => {
    if (!command) return
    const identity = `${String(command).toLowerCase()}\0${prefix.join('\0')}`
    if (!candidates.some(candidate => candidate.identity === identity)) {
      candidates.push({ command, prefix, identity })
    }
  }
  add(environment.AUTOPROMPT_PRIME_PYTHON)
  if (environment.LOCALAPPDATA) {
    add(path.join(environment.LOCALAPPDATA, 'Python', 'bin', 'python.exe'))
    const programsRoot = path.join(environment.LOCALAPPDATA, 'Programs', 'Python')
    if (fs.existsSync(programsRoot)) {
      for (const name of fs.readdirSync(programsRoot).sort().reverse()) {
        const executable = path.join(programsRoot, name, 'python.exe')
        if (fs.existsSync(executable)) add(executable)
      }
    }
  }
  add('python')
  add('py', ['-3'])
  return candidates.map(({ command, prefix }) => [command, prefix])
}

function verifyPythonImport(packageRoot) {
  const modulePath = path.join(packageRoot, 'skills', 'autoprompt', 'src', 'autoprompt', '__init__.py')
  const script = [
    'import importlib.util, json, sys',
    'sys.dont_write_bytecode = True',
    'target = sys.argv[1]',
    'spec = importlib.util.spec_from_file_location("autoprompt_prime_doctor", target)',
    'module = importlib.util.module_from_spec(spec)',
    'sys.modules[spec.name] = module',
    'spec.loader.exec_module(module)',
    'print(json.dumps({"depth": module.MAX_DEPTH, "personas": len(module.PERSONAS), "frameworks": len(module.FRAMEWORKS)}))',
  ].join('; ')
  let last
  const environment = childEnvironment(process.env, { PYTHONDONTWRITEBYTECODE: '1' })
  for (const [command, prefix] of pythonCandidates(environment)) {
    if (path.isAbsolute(command) && !fs.existsSync(command)) continue
    const completed = childProcess.spawnSync(command, [...prefix, '-I', '-c', script, modulePath], {
      encoding: 'utf8',
      timeout: 30000,
      env: environment,
    })
    if (completed.error?.code === 'ENOENT') {
      last = completed
      continue
    }
    if (completed.status !== 0) {
      throw new LifecycleError('prime-python-import-failed', {
        output: completed.stderr || completed.stdout,
      })
    }
    let result
    try { result = JSON.parse(completed.stdout.trim()) } catch {
      throw new LifecycleError('prime-python-import-output-invalid')
    }
    if (result.depth !== 4 || result.personas !== 25 || result.frameworks !== 18) {
      throw new LifecycleError('prime-python-import-contract-invalid', result)
    }
    return result
  }
  throw new LifecycleError('prime-python-missing', { cause: last?.error?.message })
}

function credentialFreeEnvironment(paths, environment = process.env) {
  return childEnvironment(environment, {
    CI: '1',
    NO_COLOR: '1',
    PRIME_AGENT_CODING_AGENT_DIR: paths.configRoot,
  })
}

function configSnapshot(directory) {
  const entries = []
  function visit(current, prefix) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const target = path.join(current, entry.name)
      if (entry.isSymbolicLink()) throw new LifecycleError('prime-path-escape', {
        path: target,
        detail: 'link-forbidden',
      })
      if (entry.isDirectory()) {
        entries.push(`d ${relative}`)
        visit(target, relative)
      } else if (entry.isFile()) {
        entries.push(`f ${relative} ${sha256File(target)}`)
      } else {
        throw new LifecycleError('prime-path-escape', {
          path: target,
          detail: 'special-file-forbidden',
        })
      }
    }
  }
  visit(directory, '')
  return sha256Bytes(Buffer.from(entries.join('\n'), 'utf8'))
}

function resolvePrimeCliInvocation(cli) {
  if (typeof cli !== 'string' || cli.trim() === '' || cli.includes('\0')) {
    throw new LifecycleError('prime-cli-invalid')
  }
  const requested = path.resolve(cli)
  const requestedStat = lstatIfPresent(requested)
  if (!requestedStat || (!requestedStat.isFile() && !requestedStat.isSymbolicLink())) {
    throw new LifecycleError('prime-cli-missing')
  }
  const resolved = realpath(requested)
  const stat = fs.statSync(resolved)
  if (!stat.isFile()) throw new LifecycleError('prime-cli-invalid')
  const extension = path.extname(resolved).toLowerCase()
  if (['.js', '.cjs', '.mjs'].includes(extension)) {
    return { command: process.execPath, prefix: [resolved], resolved }
  }
  if (stat.size > 1024 * 1024) {
    if (extension === '.exe') return { command: resolved, prefix: [], resolved }
    throw new LifecycleError('prime-cli-shim-unsupported')
  }
  const source = fs.readFileSync(resolved, 'utf8')
  const patterns = [
    /%~dp0[\\/]?([^"\r\n%]+?\.(?:cjs|mjs|js))/ig,
    /%dp0%[\\/]?([^"\r\n%]+?\.(?:cjs|mjs|js))/ig,
    /\$\{?basedir\}?[\\/]([^"'\s]+?\.(?:cjs|mjs|js))/ig,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(source)
    if (!match) continue
    const target = path.resolve(path.dirname(resolved),
      ...match[1].replaceAll('\\', '/').split('/'))
    if (!isWithin(path.dirname(resolved), target)) {
      throw new LifecycleError('prime-cli-shim-unsafe')
    }
    const targetStat = lstatIfPresent(target)
    if (!targetStat || (!targetStat.isFile() && !targetStat.isSymbolicLink())) {
      throw new LifecycleError('prime-cli-shim-target-missing')
    }
    const executable = realpath(target)
    if (!fs.statSync(executable).isFile() ||
        !['.js', '.cjs', '.mjs'].includes(path.extname(executable).toLowerCase())) {
      throw new LifecycleError('prime-cli-shim-target-invalid')
    }
    return { command: process.execPath, prefix: [executable], resolved }
  }
  if (extension === '.exe' || (process.platform !== 'win32' && (stat.mode & 0o111))) {
    return { command: resolved, prefix: [], resolved }
  }
  throw new LifecycleError('prime-cli-shim-unsupported')
}

function verifyOfficialCli(cli, paths, environment = process.env) {
  if (!cli) return null
  const invocation = resolvePrimeCliInvocation(cli)
  const before = configSnapshot(paths.configRoot)
  const invoke = (...arguments_) => childProcess.spawnSync(invocation.command,
    [...invocation.prefix, ...arguments_], {
    cwd: paths.configRoot,
    encoding: 'utf8',
    timeout: 60000,
    env: credentialFreeEnvironment(paths, environment),
  })
  const version = invoke('--version')
  const versionOutput = `${version.stdout}${version.stderr}`.trim()
  if (version.status !== 0 || versionOutput !== PRIME_VERSION) {
    throw new LifecycleError('prime-version-mismatch', {
      output: version.stderr || version.stdout,
    })
  }
  const listed = invoke('package', 'list')
  const listOutput = `${listed.stdout}${listed.stderr}`
  if (listed.status !== 0 || !listOutput.includes(paths.packageRoot)) {
    throw new LifecycleError('prime-official-discovery-failed', {
      output: listed.stderr || listed.stdout,
    })
  }
  if (configSnapshot(paths.configRoot) !== before) {
    throw new LifecycleError('prime-official-discovery-mutated-config')
  }
  return { version: PRIME_VERSION, listed: true }
}

function doctor(options = {}) {
  const paths = resolvePaths(options)
  const guard = createPathGuard(paths.configRoot)
  assertManagedTopology(paths, guard)
  const manifest = readManifest(paths.manifestPath)
  const receipt = readReceipt(paths, true, guard)
  const manifestHash = sha256File(paths.manifestPath)
  if (receipt.manifestSha256 !== manifestHash) {
    throw new LifecycleError('prime-receipt-manifest-mismatch')
  }
  verifyPayload(paths.packageRoot, manifest)
  const resources = packageManifestChecks(paths.packageRoot)
  if (!fs.existsSync(paths.settingsPath)) throw new LifecycleError('prime-settings-missing')
  const settingsBytes = fs.readFileSync(paths.settingsPath)
  const settings = primeSettings.inspect(settingsBytes, paths.packageRoot, paths.configRoot)
  if (settings.depth !== 4) throw new LifecycleError('prime-depth-invalid', { actual: settings.depth })
  if (settings.packageMatches.length !== 1) {
    throw new LifecycleError('prime-package-not-discoverable', { matches: settings.packageMatches.length })
  }
  const python = verifyPythonImport(paths.packageRoot)
  const official = verifyOfficialCli(options.primeCli ||
    (options.env || process.env).AUTOPROMPT_PRIME_CLI,
    paths, options.env)
  return {
    status: 'healthy',
    provider: PROVIDER,
    version: PRIME_VERSION,
    configRoot: paths.configRoot,
    packageRoot: paths.packageRoot,
    files: manifest.files.length,
    resources,
    python,
    official,
  }
}

function createStage(paths, manifest, guard) {
  const stage = path.join(paths.configRoot,
    `.autoprompt-prime-stage-${process.pid}-${crypto.randomBytes(6).toString('hex')}`)
  if (fs.existsSync(stage)) throw new LifecycleError('prime-stage-collision')
  try {
    copyPayload(paths.sourceRoot, stage, manifest, guard)
    return stage
  } catch (error) {
    safeRm(guard, stage, { recursive: true, force: true })
    throw error
  }
}

function maybeFault(options, point) {
  if (typeof options.fault === 'function') options.fault(point)
}

function restoreSettingsAfterFailure(paths, existed, originalBytes, guard) {
  if (existed) writeAtomic(paths.settingsPath, originalBytes, guard)
  else safeRm(guard, paths.settingsPath, { force: true })
}

function firstInstall(options, paths, manifest, guard) {
  ensureNoUnsafeCollision(paths, null, guard)
  verifyPayload(paths.sourceRoot, manifest)
  const settingsInitiallyExisted = fs.existsSync(paths.settingsPath)
  const originalSettings = settingsInitiallyExisted
    ? fs.readFileSync(paths.settingsPath)
    : Buffer.from('{}\n', 'utf8')
  const settingsPlan = primeSettings.installSettings(
    originalSettings,
    paths.packageRoot,
    paths.configRoot,
  )
  const stage = createStage(paths, manifest, guard)
  let packageLanded = false
  let settingsWritten = false
  let backupWritten = false
  try {
    if (settingsPlan.changed && settingsInitiallyExisted) {
      safeWriteFile(guard, paths.settingsBackupPath, originalSettings, { flag: 'wx', mode: 0o600 })
      backupWritten = true
    }
    safeMkdir(guard, path.dirname(paths.packageRoot), { recursive: true })
    safeRename(guard, stage, paths.packageRoot)
    packageLanded = true
    maybeFault(options, 'after-package-swap')
    if (settingsPlan.changed || !settingsInitiallyExisted) {
      writeAtomic(paths.settingsPath, settingsPlan.bytes, guard)
      settingsWritten = true
    }
    maybeFault(options, 'after-settings-write')
    const receipt = {
      schemaVersion: 1,
      provider: PROVIDER,
      targetVersion: PRIME_VERSION,
      packageRoot: paths.packageRoot,
      settingsPath: paths.settingsPath,
      settingsBackupPath: paths.settingsBackupPath,
      settingsInitiallyExisted,
      packageAdded: settingsPlan.packageAdded,
      depthChanged: settingsPlan.depthChanged,
      priorDepth: settingsPlan.priorDepth,
      priorPackages: settingsPlan.priorPackages,
      manifestSha256: sha256File(paths.manifestPath),
      managedSettingsSha256: sha256Bytes(settingsPlan.bytes),
      fullRestoreSafe: true,
      installedAt: new Date().toISOString(),
    }
    writeAtomic(paths.receiptPath, receiptBytes(receipt), guard)
    maybeFault(options, 'after-receipt-write')
    const health = doctor({
      ...options,
      configRoot: paths.configRoot,
      primeCli: options.primeCli,
    })
    return { receipt, health }
  } catch (error) {
    safeRm(guard, paths.receiptPath, { force: true })
    if (settingsWritten) restoreSettingsAfterFailure(
      paths, settingsInitiallyExisted, originalSettings, guard)
    if (packageLanded) safeRm(guard, paths.packageRoot, { recursive: true, force: true })
    if (backupWritten) safeRm(guard, paths.settingsBackupPath, { force: true })
    removeDirectoryIfEmpty(path.dirname(paths.packageRoot), paths.configRoot, guard)
    throw error
  } finally {
    safeRm(guard, stage, { recursive: true, force: true })
  }
}

function repairInternal(options, paths, manifest, receipt, guard) {
  ensureNoUnsafeCollision(paths, receipt, guard)
  const stage = createStage(paths, manifest, guard)
  const settingsExisted = fs.existsSync(paths.settingsPath)
  const originalSettings = settingsExisted
    ? fs.readFileSync(paths.settingsPath)
    : Buffer.from('{}\n', 'utf8')
  const settingsWasManaged = settingsExisted &&
    sha256Bytes(originalSettings) === receipt.managedSettingsSha256
  const settingsPlan = primeSettings.installSettings(
    originalSettings,
    paths.packageRoot,
    paths.configRoot,
  )
  let oldPackageMoved = false
  let newPackageLanded = false
  let settingsWritten = false
  try {
    if (fs.existsSync(paths.packageRoot)) {
      safeRename(guard, paths.packageRoot, paths.packageBackupPath)
      oldPackageMoved = true
    }
    safeMkdir(guard, path.dirname(paths.packageRoot), { recursive: true })
    safeRename(guard, stage, paths.packageRoot)
    newPackageLanded = true
    maybeFault(options, 'after-package-swap')
    if (settingsPlan.changed || !settingsExisted) {
      writeAtomic(paths.settingsPath, settingsPlan.bytes, guard)
      settingsWritten = true
    }
    maybeFault(options, 'after-settings-write')
    const updated = {
      ...receipt,
      manifestSha256: sha256File(paths.manifestPath),
      managedSettingsSha256: sha256Bytes(settingsPlan.bytes),
      fullRestoreSafe: receipt.fullRestoreSafe && settingsWasManaged,
      repairedAt: new Date().toISOString(),
    }
    writeAtomic(paths.receiptPath, receiptBytes(updated), guard)
    maybeFault(options, 'after-receipt-write')
    const health = doctor({
      ...options,
      configRoot: paths.configRoot,
      primeCli: options.primeCli,
    })
    if (oldPackageMoved) safeRm(guard, paths.packageBackupPath, { recursive: true, force: true })
    return { receipt: updated, health }
  } catch (error) {
    if (settingsWritten) restoreSettingsAfterFailure(paths, settingsExisted, originalSettings, guard)
    if (newPackageLanded) safeRm(guard, paths.packageRoot, { recursive: true, force: true })
    if (oldPackageMoved && fs.existsSync(paths.packageBackupPath)) {
      safeRename(guard, paths.packageBackupPath, paths.packageRoot)
    }
    writeAtomic(paths.receiptPath, receiptBytes(receipt), guard)
    throw error
  } finally {
    safeRm(guard, stage, { recursive: true, force: true })
  }
}

function install(options = {}) {
  const paths = resolvePaths(options)
  const guard = createPathGuard(paths.configRoot, true)
  let releaseLock
  let succeeded = false
  try {
    assertManagedTopology(paths, guard)
    releaseLock = acquireLock(paths.lockPath, guard)
    const manifest = readManifest(paths.manifestPath)
    const receipt = readReceipt(paths, false, guard)
    if (receipt) {
      try {
        const health = doctor({ ...options, configRoot: paths.configRoot, primeCli: options.primeCli })
        succeeded = true
        return { status: 'noop', receipt, health }
      } catch {
        // A receipt-owned install is repairable. Repair revalidates every file
        // and setting before it commits a replacement.
      }
    }
    const result = receipt
      ? repairInternal(options, paths, manifest, receipt, guard)
      : firstInstall(options, paths, manifest, guard)
    const output = {
      status: receipt ? 'repaired' : 'installed',
      receipt: result.receipt,
      health: result.health,
    }
    succeeded = true
    return output
  } finally {
    try {
      if (releaseLock) releaseLock()
    } finally {
      if (!succeeded) removeCreatedConfigRoot(guard)
    }
  }
}

function repair(options = {}) {
  const paths = resolvePaths(options)
  const guard = createPathGuard(paths.configRoot, true)
  let releaseLock
  let succeeded = false
  try {
    assertManagedTopology(paths, guard)
    releaseLock = acquireLock(paths.lockPath, guard)
    const manifest = readManifest(paths.manifestPath)
    const receipt = readReceipt(paths, true, guard)
    const result = repairInternal(options, paths, manifest, receipt, guard)
    const output = { status: 'repaired', receipt: result.receipt, health: result.health }
    succeeded = true
    return output
  } finally {
    try {
      if (releaseLock) releaseLock()
    } finally {
      if (!succeeded) removeCreatedConfigRoot(guard)
    }
  }
}

function uninstall(options = {}) {
  const paths = resolvePaths(options)
  if (!fs.existsSync(paths.configRoot)) return { status: 'not-installed' }
  const guard = createPathGuard(paths.configRoot)
  assertManagedTopology(paths, guard)
  const releaseLock = acquireLock(paths.lockPath, guard)
  try {
    assertManagedTopology(paths, guard)
    const receipt = readReceipt(paths, false, guard)
    if (!receipt) {
      if (fs.existsSync(paths.packageRoot)) throw new LifecycleError('prime-receipt-missing')
      return { status: 'not-installed' }
    }
    let settingsResult = {
      packageRemoved: false,
      packageDrift: false,
      depthRestored: false,
      depthDrift: false,
    }
    if (fs.existsSync(paths.settingsPath)) {
      const current = fs.readFileSync(paths.settingsPath)
      const settingsOwned = receipt.packageAdded || receipt.depthChanged
      if (settingsOwned && receipt.fullRestoreSafe &&
          sha256Bytes(current) === receipt.managedSettingsSha256) {
        if (receipt.settingsInitiallyExisted) {
          if (!fs.existsSync(paths.settingsBackupPath)) {
            throw new LifecycleError('prime-settings-backup-missing')
          }
          writeAtomic(paths.settingsPath, fs.readFileSync(paths.settingsBackupPath), guard)
        } else {
          safeRm(guard, paths.settingsPath)
        }
        settingsResult = {
          packageRemoved: receipt.packageAdded,
          packageDrift: false,
          depthRestored: receipt.depthChanged,
          depthDrift: false,
        }
      } else {
        const scoped = primeSettings.uninstallSettings(
          current,
          paths.packageRoot,
          paths.configRoot,
          receipt,
        )
        if (!scoped.bytes.equals(current)) writeAtomic(paths.settingsPath, scoped.bytes, guard)
        settingsResult = scoped
      }
    } else if (receipt.packageAdded || receipt.depthChanged) {
      settingsResult.packageDrift = receipt.packageAdded
      settingsResult.depthDrift = receipt.depthChanged
    }

    safeRm(guard, paths.packageRoot, { recursive: true, force: true })
    safeRm(guard, paths.settingsBackupPath, { force: true })
    safeRm(guard, paths.receiptPath, { force: true })
    removeDirectoryIfEmpty(path.dirname(paths.packageRoot), paths.configRoot, guard)
    return { status: 'uninstalled', settings: settingsResult }
  } finally {
    releaseLock()
  }
}

function parseArguments(argv) {
  const operation = argv[2]
  if (!['install', 'repair', 'doctor', 'uninstall', 'paths'].includes(operation)) {
    throw new LifecycleError('invalid-arguments')
  }
  const options = {}
  for (let index = 3; index < argv.length; index += 2) {
    const option = argv[index]
    const value = argv[index + 1]
    if (!option?.startsWith('--') || value === undefined) throw new LifecycleError('invalid-arguments')
    const name = option.slice(2)
    if (!['repo-root', 'config-root', 'prime-cli'].includes(name)) {
      throw new LifecycleError('invalid-arguments')
    }
    options[name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value
  }
  return { operation, options }
}

function main() {
  try {
    const parsed = parseArguments(process.argv)
    const result = parsed.operation === 'install'
      ? install(parsed.options)
      : parsed.operation === 'repair'
        ? repair(parsed.options)
        : parsed.operation === 'doctor'
          ? doctor(parsed.options)
          : parsed.operation === 'uninstall'
            ? uninstall(parsed.options)
            : resolvePaths(parsed.options)
    process.stdout.write(`${JSON.stringify(result)}\n`)
    return 0
  } catch (error) {
    const reason = error instanceof LifecycleError || error instanceof primeSettings.JsoncError
      ? error.reason
      : error.message
    process.stderr.write(`${JSON.stringify({ status: 'error', reason })}\n`)
    return error instanceof LifecycleError && error.reason.startsWith('prime-') ? 2 : 3
  }
}

module.exports = {
  LOCK_NAME,
  PACKAGE_RELATIVE,
  PRIME_VERSION,
  RECEIPT_NAME,
  SETTINGS_BACKUP_NAME,
  LifecycleError,
  credentialFreeEnvironment,
  doctor,
  install,
  repair,
  resolveConfigRoot,
  resolvePaths,
  uninstall,
  verifyOfficialCli,
}

if (require.main === module) process.exitCode = main()
