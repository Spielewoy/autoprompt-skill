'use strict'

// Hermes' official POSIX installer publishes a small bash wrapper rather than
// a Python shebang. Parse only the installer-generated form; never run a
// caller-supplied shell script to discover its interpreter.
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

class HermesPosixLauncherBindingError extends Error {
  constructor(message) { super(message); this.code = 'PROVIDER_IDENTITY_MISMATCH' }
}
function fail(message) { throw new HermesPosixLauncherBindingError(message) }
function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex') }
function safeAbsolutePosix(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') &&
    !/[\0\r\n"\\$`]/u.test(value) && !value.slice(1).split('/').some(part => part === '.' || part === '..' || !part)
}
function inside(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function parseHermesPosixLauncher(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 64 || bytes.length > 8192) fail('Hermes POSIX launcher is not a bounded script')
  const text = bytes.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(bytes)) fail('Hermes POSIX launcher is not exact UTF-8')
  const match = /^#!\/usr\/bin\/env bash\nunset PYTHONPATH\nunset PYTHONHOME\nexec "([^"\r\n]+)" "([^"\r\n]+)" "\$@"\n$/u.exec(text)
  if (!match) fail('Hermes POSIX launcher does not match the official wrapper form')
  const [, interpreterPath, entrypointPath] = match
  if (!safeAbsolutePosix(interpreterPath) || !safeAbsolutePosix(entrypointPath)) fail('Hermes POSIX launcher uses an unsafe quoted path')
  const suffix = '/venv/bin/python'
  if (!interpreterPath.endsWith(suffix)) fail('Hermes POSIX launcher does not bind the official venv Python path')
  const root = interpreterPath.slice(0, -suffix.length)
  if (!safeAbsolutePosix(root) || entrypointPath !== `${root}/hermes`) fail('Hermes POSIX launcher entrypoint differs from its installed root')
  return Object.freeze({
    schemaVersion: 1,
    kind: 'official-hermes-posix-launcher-v1',
    launcherSha256: sha256(bytes),
    root,
    interpreterPath,
    entrypointPath,
    authenticatingConfigPaths: Object.freeze([`${root}/venv/pyvenv.cfg`]),
  })
}

function physicalRegular(file, label) {
  let item
  try { item = fs.lstatSync(file) } catch { fail(`Hermes POSIX ${label} is unavailable`) }
  if (!item.isFile() || item.isSymbolicLink()) fail(`Hermes POSIX ${label} is not a physical regular file`)
  return fs.readFileSync(file)
}

function canonicalConfig(binding, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 64 * 1024) fail('Hermes POSIX venv configuration is not bounded')
  const text = bytes.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(bytes) || text.includes('\0') || !text.endsWith('\n')) fail('Hermes POSIX venv configuration is not exact UTF-8')
  const lines = text.slice(0, -1).split('\n'), fields = new Map()
  for (const line of lines) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*) = ([^\r\n]*)$/u.exec(line)
    if (!match || fields.has(match[1])) fail('Hermes POSIX venv configuration has an invalid field')
    fields.set(match[1], match[2])
  }
  const home = fields.get('home')
  if (!home || !safeAbsolutePosix(home)) fail('Hermes POSIX venv configuration has no absolute interpreter home')
  let physicalHome
  try { physicalHome = fs.realpathSync.native(home) } catch { fail('Hermes POSIX venv configuration interpreter home is unavailable') }
  if (physicalHome !== path.dirname(binding.interpreter.physicalPath)) fail('Hermes POSIX venv configuration selects a different interpreter home')
  const executable = fields.get('executable')
  if (executable !== undefined) {
    if (!safeAbsolutePosix(executable)) fail('Hermes POSIX venv configuration executable is invalid')
    let physicalExecutable
    try { physicalExecutable = fs.realpathSync.native(executable) } catch { fail('Hermes POSIX venv configuration executable is unavailable') }
    if (physicalExecutable !== binding.interpreter.physicalPath) fail('Hermes POSIX venv configuration selects a different executable')
  }
  // Only the two fields whose complete values were validated above are
  // generated path metadata. Root-like text in every other field remains an
  // exact byte-bound part of the portable identity.
  const canonical = lines.map(line => {
    if (line.startsWith('home = ')) return 'home = @autoprompt-hermes/python/home'
    if (line.startsWith('executable = ')) return 'executable = @autoprompt-hermes/python/interpreter'
    return line
  }).join('\n') + '\n'
  return Buffer.from(canonical, 'utf8')
}

function canonicalHermesPosixIdentity(subject) {
  const captured = typeof subject === 'string' ? null : subject
  const launcherPath = typeof subject === 'string' ? subject : subject?.launcherPath
  if (typeof launcherPath !== 'string' || !path.isAbsolute(launcherPath)) fail('Hermes POSIX canonical identity requires an exact launcher binding')
  const binding = bindHermesPosixLauncher(launcherPath)
  if (captured) {
    const shape = value => JSON.stringify({
      kind: value?.kind, launcherPath: value?.launcherPath, launcherSha256: value?.launcherSha256,
      declaredRoot: value?.declaredRoot, root: value?.root, entrypointPath: value?.entrypointPath,
      authenticatingConfigPaths: value?.authenticatingConfigPaths,
      interpreter: value?.interpreter,
      authenticatingFiles: value?.authenticatingFiles,
    })
    if (shape(captured) !== shape(binding)) fail('Hermes POSIX launcher binding changed before canonicalization')
  }
  const launcher = Buffer.from('#!/usr/bin/env bash\nunset PYTHONPATH\nunset PYTHONHOME\nexec "@autoprompt-hermes/hermes/venv/bin/python" "@autoprompt-hermes/hermes/entrypoint" "$@"\n', 'utf8')
  const configPath = binding.authenticatingConfigPaths[0]
  const configBytes = physicalRegular(configPath, 'venv configuration')
  const rawConfigSha256 = sha256(configBytes)
  const capturedConfig = binding.authenticatingFiles.find(item => fs.realpathSync.native(item.path) === fs.realpathSync.native(configPath))
  if (!capturedConfig || capturedConfig.sha256 !== rawConfigSha256) fail('Hermes POSIX venv configuration changed before canonicalization')
  const config = canonicalConfig(binding, configBytes)
  return Object.freeze({
    schemaVersion: 1,
    kind: 'official-hermes-posix-portable-identity-v1',
    canonicalFiles: Object.freeze([
      Object.freeze({ path: binding.launcherPath, sha256: sha256(launcher), rawSha256: binding.launcherSha256 }),
      Object.freeze({ path: fs.realpathSync.native(configPath), sha256: sha256(config), rawSha256: rawConfigSha256 }),
    ]),
  })
}
function bindHermesPosixLauncher(launcherPath) {
  if (typeof launcherPath !== 'string' || !path.isAbsolute(launcherPath)) fail('Hermes POSIX launcher path is not absolute')
  const launcher = fs.realpathSync.native(launcherPath)
  const parsed = parseHermesPosixLauncher(physicalRegular(launcherPath, 'public launcher'))
  let rootItem, root
  try { rootItem = fs.lstatSync(parsed.root); root = fs.realpathSync.native(parsed.root) } catch { fail('Hermes POSIX installed root is unavailable') }
  // macOS canonically rewrites /var to /private/var. The root path itself
  // must be physical, but an ancestor's canonical spelling is not authority
  // to reject an otherwise identical installation.
  if (!rootItem.isDirectory() || rootItem.isSymbolicLink()) fail('Hermes POSIX installed root is not physical')
  const entrypoint = fs.realpathSync.native(parsed.entrypointPath)
  const interpreter = fs.realpathSync.native(parsed.interpreterPath)
  if (!inside(root, entrypoint)) fail('Hermes POSIX launcher entrypoint escaped its installed root')
  const entrypointBytes = physicalRegular(parsed.entrypointPath, 'entrypoint')
  const configFiles = parsed.authenticatingConfigPaths.map(file => {
    const resolved = fs.realpathSync.native(file)
    if (!inside(root, resolved)) fail('Hermes POSIX venv configuration escaped its installed root')
    const bytes = physicalRegular(file, 'venv configuration')
    return Object.freeze({ path: file, sha256: sha256(bytes) })
  })
  let interpreterItem
  try { interpreterItem = fs.statSync(parsed.interpreterPath) } catch { fail('Hermes POSIX interpreter is unavailable') }
  if (!interpreterItem.isFile()) fail('Hermes POSIX interpreter is not a file')
  return Object.freeze({
    ...parsed,
    launcherPath: launcher,
    declaredRoot: parsed.root,
    root,
    interpreter: Object.freeze({ path: parsed.interpreterPath, physicalPath: interpreter, sha256: sha256(fs.readFileSync(interpreter)) }),
    authenticatingFiles: Object.freeze([
      Object.freeze({ path: launcher, sha256: parsed.launcherSha256 }),
      Object.freeze({ path: entrypoint, sha256: sha256(entrypointBytes) }),
      ...configFiles,
    ]),
  })
}

module.exports = { HermesPosixLauncherBindingError, parseHermesPosixLauncher, bindHermesPosixLauncher, canonicalHermesPosixIdentity }
