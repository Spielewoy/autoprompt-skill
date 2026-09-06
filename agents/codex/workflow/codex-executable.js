'use strict'

const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const HASH_PATTERN = /^[a-f0-9]{64}$/
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/
const admittedRuntimes = new WeakSet()

class CodexExecutableError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CodexExecutableError'
    this.code = 'PROVIDER_UNSUPPORTED'
  }
}

function fail(message) {
  throw new CodexExecutableError(message)
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function inside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' &&
    !relative.startsWith(`..${path.sep}`))
}

function sameFile(left, right) {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino)
}

function readRegularBound(candidate, options = {}) {
  let lexical
  let resolved
  try {
    lexical = fs.lstatSync(candidate, { bigint: true })
    if (lexical.isSymbolicLink() && options.allowLink !== true) return null
    if (!lexical.isFile() && !lexical.isSymbolicLink()) return null
    resolved = fs.realpathSync.native(candidate)
  } catch {
    return null
  }

  let descriptor
  try {
    const initial = fs.lstatSync(resolved, { bigint: true })
    if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1n) return null
    descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    const opened = fs.fstatSync(descriptor, { bigint: true })
    if (!opened.isFile() || opened.nlink !== 1n || !sameFile(initial, opened)) return null
    const bytes = fs.readFileSync(descriptor)
    const rebound = fs.lstatSync(resolved, { bigint: true })
    if (!rebound.isFile() || rebound.isSymbolicLink() || rebound.nlink !== 1n ||
        !sameFile(opened, rebound) || rebound.size !== BigInt(bytes.length)) return null
    return Object.freeze({ bytes, realpath: resolved })
  } catch {
    return null
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}

function regularRealFile(candidate, options = {}) {
  return readRegularBound(candidate, options)?.realpath || null
}

function packageMetadata(packageRoot) {
  const binding = readRegularBound(path.join(packageRoot, 'package.json'))
  if (!binding || !inside(packageRoot, binding.realpath)) return null
  try {
    const metadata = JSON.parse(binding.bytes.toString('utf8'))
    if (metadata.name !== '@openai/codex' ||
        typeof metadata.version !== 'string' || !VERSION_PATTERN.test(metadata.version) ||
        metadata.bin?.codex !== 'bin/codex.js') return null
    return Object.freeze({
      bytesSha256: sha256(binding.bytes),
      metadata: Object.freeze(metadata),
      metadataPath: binding.realpath,
      version: metadata.version,
    })
  } catch {
    return null
  }
}

function platformBinding(platform = process.platform, arch = process.arch) {
  const bindings = {
    'darwin:arm64': ['@openai/codex-darwin-arm64', 'aarch64-apple-darwin', 'codex'],
    'darwin:x64': ['@openai/codex-darwin-x64', 'x86_64-apple-darwin', 'codex'],
    'linux:arm64': ['@openai/codex-linux-arm64', 'aarch64-unknown-linux-musl', 'codex'],
    'linux:x64': ['@openai/codex-linux-x64', 'x86_64-unknown-linux-musl', 'codex'],
    'win32:arm64': ['@openai/codex-win32-arm64', 'aarch64-pc-windows-msvc', 'codex.exe'],
    'win32:x64': ['@openai/codex-win32-x64', 'x86_64-pc-windows-msvc', 'codex.exe'],
  }
  return bindings[`${platform}:${arch}`] || null
}

function normalizedExpectedVersion(value) {
  if (value == null) return null
  const version = String(value).trim()
  if (!version || version.length > 256 || /[\r\n\0]/.test(version)) {
    fail('Codex executable version pin is invalid')
  }
  return version
}

function executableRuntime(binding, options) {
  const digest = sha256(binding.bytes)
  if (options.expectedSha256 != null &&
      (!HASH_PATTERN.test(options.expectedSha256) || options.expectedSha256 !== digest)) {
    fail('Codex executable hash does not match its configured pin')
  }
  const identity = Object.freeze({
    realpath: binding.realpath,
    platform: options.platform,
    arch: options.arch,
    basename: path.basename(binding.realpath),
    sha256: digest,
    version: normalizedExpectedVersion(options.version),
  })
  const provenance = Object.freeze({ ...options.provenance })
  return Object.freeze({
    executable: binding.realpath,
    environmentOverlay: Object.freeze({ ...(options.environmentOverlay || {}) }),
    identity,
    packageRoot: options.packageRoot || null,
    provenance,
    provenanceSha256: sha256(Buffer.from(JSON.stringify(provenance), 'utf8')),
    source: options.source,
  })
}

function runtimeFromPackage(packageRoot, options = {}) {
  const platform = options.platform || process.platform
  const arch = options.arch || process.arch
  let root
  try {
    const lexical = fs.lstatSync(packageRoot)
    if (!lexical.isDirectory() || lexical.isSymbolicLink()) return null
    root = fs.realpathSync.native(packageRoot)
    if (!fs.lstatSync(root).isDirectory()) return null
  } catch {
    return null
  }
  const packageRecord = packageMetadata(root)
  if (!packageRecord) return null
  const binding = platformBinding(platform, arch)
  if (!binding) return null
  const [packageName, targetTriple, executableName] = binding
  const expectedNativeVersion = `${packageRecord.version}-${platform}-${arch}`
  if (packageRecord.metadata.optionalDependencies?.[packageName] !==
      `npm:@openai/codex@${expectedNativeVersion}`) return null
  const packageParts = packageName.split('/')
  const candidates = [
    {
      executable: path.join(
        root, 'node_modules', ...packageParts, 'vendor', targetTriple, 'bin', executableName,
      ),
      nativeRoot: path.join(root, 'node_modules', ...packageParts),
    },
  ]
  // Local npm installs hoist the optional native package beside @openai/codex.
  // Limit this additional lookup to that exact node_modules scope; do not search
  // ancestor packages, NODE_PATH, or an unrelated ambient installation.
  const scopeRoot = path.dirname(root)
  if (path.basename(root) === 'codex' && path.basename(scopeRoot) === '@openai' &&
      path.basename(path.dirname(scopeRoot)) === 'node_modules') {
    const nativeRoot = path.join(scopeRoot, packageParts[1])
    candidates.push({
      executable: path.join(nativeRoot, 'vendor', targetTriple, 'bin', executableName),
      nativeRoot,
    })
  }
  candidates.push({
    executable: path.join(root, 'vendor', targetTriple, 'bin', executableName), nativeRoot: null,
  })
  for (const candidate of candidates) {
    const executableBinding = readRegularBound(candidate.executable)
    if (!executableBinding ||
        !inside(candidate.nativeRoot || root, executableBinding.realpath)) continue
    if (platform !== 'win32') {
      try { fs.accessSync(executableBinding.realpath, fs.constants.X_OK) } catch { continue }
    }
    let nativeMetadataSha256 = null
    if (candidate.nativeRoot) {
      const nativeBinding = readRegularBound(path.join(candidate.nativeRoot, 'package.json'))
      if (!nativeBinding || !inside(candidate.nativeRoot, nativeBinding.realpath)) continue
      let nativeMetadata
      try { nativeMetadata = JSON.parse(nativeBinding.bytes.toString('utf8')) } catch { continue }
      if (nativeMetadata.name !== '@openai/codex' ||
          nativeMetadata.version !== expectedNativeVersion ||
          JSON.stringify(nativeMetadata.os) !== JSON.stringify([platform]) ||
          JSON.stringify(nativeMetadata.cpu) !== JSON.stringify([arch])) continue
      nativeMetadataSha256 = sha256(nativeBinding.bytes)
    }
    return executableRuntime(executableBinding, {
      platform,
      arch,
      expectedSha256: options.expectedSha256,
      version: `codex-cli ${packageRecord.version}`,
      environmentOverlay: {
        CODEX_MANAGED_BY_NPM: '1',
        CODEX_MANAGED_PACKAGE_ROOT: root,
      },
      packageRoot: root,
      provenance: {
        kind: 'official-npm-package-v1',
        packageName: '@openai/codex',
        packageVersion: packageRecord.version,
        packageMetadataSha256: packageRecord.bytesSha256,
        nativePackageName: packageName,
        nativePackageMetadataSha256: nativeMetadataSha256,
        targetTriple,
      },
      source: 'official-package-runtime',
    })
  }
  return null
}

function runtimeFromStandalonePackage(packageRoot, options = {}) {
  const platform = options.platform || process.platform
  const arch = options.arch || process.arch
  const binding = platformBinding(platform, arch)
  if (!binding) return null
  const [, targetTriple, executableName] = binding
  let root
  try {
    const lexical = fs.lstatSync(packageRoot)
    if (!lexical.isDirectory() || lexical.isSymbolicLink()) return null
    root = fs.realpathSync.native(packageRoot)
  } catch {
    return null
  }
  const metadataBinding = readRegularBound(path.join(root, 'codex-package.json'))
  if (!metadataBinding || !inside(root, metadataBinding.realpath)) return null
  let metadata
  try { metadata = JSON.parse(metadataBinding.bytes.toString('utf8')) } catch { return null }
  if (!metadata || metadata.layoutVersion !== 1 ||
      typeof metadata.version !== 'string' || !VERSION_PATTERN.test(metadata.version) ||
      metadata.target !== targetTriple || metadata.variant !== 'codex' ||
      metadata.entrypoint !== `bin/${executableName}` ||
      metadata.resourcesDir !== 'codex-resources' || metadata.pathDir !== 'codex-path') return null
  const executableBinding = readRegularBound(path.join(root, 'bin', executableName))
  if (!executableBinding || !inside(root, executableBinding.realpath)) return null
  if (platform !== 'win32') {
    try { fs.accessSync(executableBinding.realpath, fs.constants.X_OK) } catch { return null }
  }
  // Package layout identifies an inert candidate, not an authentic or admitted
  // executable. Signed provider trust must still bind its exact version and hash.
  return executableRuntime(executableBinding, {
    platform,
    arch,
    expectedSha256: options.expectedSha256,
    version: `codex-cli ${metadata.version}`,
    packageRoot: root,
    provenance: {
      kind: 'standalone-package-layout-v1',
      packageVersion: metadata.version,
      packageMetadataSha256: sha256(metadataBinding.bytes),
      targetTriple,
    },
    source: 'standalone-package-runtime',
  })
}

function pathDirectories(environment) {
  return String(environment.PATH || environment.Path || '')
    .split(path.delimiter)
    .map(value => value.replace(/^"|"$/g, ''))
    .filter(Boolean)
}

function discoverPackageRuntime(name, environment, options) {
  const { platform, arch } = options
  for (const directory of pathDirectories(environment)) {
    const nativeName = platform === 'win32' ? `${name}.exe` : name
    const resolvedNative = regularRealFile(path.join(directory, nativeName), { allowLink: true })
    if (resolvedNative && path.basename(resolvedNative) === nativeName &&
        path.basename(path.dirname(resolvedNative)) === 'bin') {
      const runtime = runtimeFromStandalonePackage(path.dirname(path.dirname(resolvedNative)), {
        platform, arch, expectedSha256: options.expectedSha256,
      })
      if (runtime && runtime.executable === resolvedNative) return runtime
    }
    if (platform === 'win32') {
      for (const wrapperName of [`${name}.cmd`, `${name}.ps1`]) {
        if (!regularRealFile(path.join(directory, wrapperName))) continue
        const runtime = runtimeFromPackage(
          path.join(directory, 'node_modules', '@openai', 'codex'),
          { platform, arch, expectedSha256: options.expectedSha256 },
        )
        if (runtime) return runtime
      }
      continue
    }
    const resolvedWrapper = regularRealFile(path.join(directory, name), { allowLink: true })
    if (!resolvedWrapper || path.basename(resolvedWrapper) !== 'codex.js' ||
        path.basename(path.dirname(resolvedWrapper)) !== 'bin') continue
    const runtime = runtimeFromPackage(path.dirname(path.dirname(resolvedWrapper)), {
      platform, arch, expectedSha256: options.expectedSha256,
    })
    if (runtime) return runtime
  }
  return null
}

function resolveCodexExecutable(requested = 'codex', options = {}) {
  const name = String(requested || '').trim()
  if (!name || name.includes('\0')) fail('Codex executable name is invalid')
  const environment = options.environment || process.env
  const platform = options.platform || process.platform
  const arch = options.arch || process.arch

  if (path.isAbsolute(name)) {
    const binding = readRegularBound(name)
    if (!binding) fail(`Configured Codex executable is not a unique regular file: ${name}`)
    if (platform !== 'win32') {
      try { fs.accessSync(binding.realpath, fs.constants.X_OK) } catch {
        fail(`Configured Codex executable is not executable: ${name}`)
      }
    }
    return executableRuntime(binding, {
      platform,
      arch,
      expectedSha256: options.expectedSha256,
      version: options.expectedVersion,
      provenance: { kind: 'explicit-absolute-path-v1', configuredPath: binding.realpath },
      source: 'explicit-configured-runtime',
    })
  }

  if (name.includes('/') || name.includes('\\') || name !== 'codex') {
    fail('Codex executable must be an explicit absolute path or the packaged codex command')
  }
  const runtime = discoverPackageRuntime(name, environment, {
    platform, arch, expectedSha256: options.expectedSha256,
  })
  if (runtime) return runtime
  fail(`Codex executable cannot be resolved safely: ${name}`)
}

function sameIdentity(actual, expected) {
  return actual && expected &&
    actual.realpath === expected.realpath && actual.platform === expected.platform &&
    actual.arch === expected.arch && actual.basename === expected.basename &&
    actual.sha256 === expected.sha256 && actual.version === expected.version
}

function refreshedRuntime(runtime) {
  if (runtime.source === 'standalone-package-runtime') {
    return runtimeFromStandalonePackage(runtime.packageRoot, {
      platform: runtime.identity.platform,
      arch: runtime.identity.arch,
      expectedSha256: runtime.identity.sha256,
    })
  }
  if (runtime.source === 'official-package-runtime') {
    return runtimeFromPackage(runtime.packageRoot, {
      platform: runtime.identity.platform,
      arch: runtime.identity.arch,
      expectedSha256: runtime.identity.sha256,
    })
  }
  if (runtime.source === 'explicit-configured-runtime') {
    return resolveCodexExecutable(runtime.executable, {
      platform: runtime.identity.platform,
      arch: runtime.identity.arch,
      expectedSha256: runtime.identity.sha256,
      expectedVersion: runtime.identity.version,
    })
  }
  return null
}

function runtimeUnchanged(runtime, refreshed) {
  return refreshed && sameIdentity(runtime.identity, refreshed.identity) &&
    runtime.source === refreshed.source &&
    runtime.provenanceSha256 === refreshed.provenanceSha256
}

function bindingKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
}

function admitCodexExecutable(runtime, expectedIdentity) {
  if (!runtime || !sameIdentity(runtime.identity, expectedIdentity)) {
    fail('Codex executable does not match the trusted runtime identity')
  }
  const refreshed = refreshedRuntime(runtime)
  if (!runtimeUnchanged(runtime, refreshed)) fail('Codex executable changed before admission')
  const admitted = Object.freeze({ ...refreshed, admitted: true })
  admittedRuntimes.add(admitted)
  return admitted
}

function bindAdmittedCodexExecutable(runtime, runtimeIdentityHash) {
  if (!runtime || !admittedRuntimes.has(runtime) || !HASH_PATTERN.test(runtimeIdentityHash || '')) {
    fail('Codex executable binding requires an admitted runtime identity')
  }
  return Object.freeze({
    schemaVersion: 1,
    runtimeIdentityHash,
    executable: runtime.executable,
    source: runtime.source,
    packageRoot: runtime.packageRoot,
    identity: Object.freeze({ ...runtime.identity }),
    provenanceSha256: runtime.provenanceSha256,
  })
}

function openCodexExecutableAdmission(binding, expectedRuntimeIdentityHash) {
  if (!bindingKeys(binding, [
    'schemaVersion', 'runtimeIdentityHash', 'executable', 'source', 'packageRoot',
    'identity', 'provenanceSha256',
  ]) || binding.schemaVersion !== 1 ||
      binding.runtimeIdentityHash !== expectedRuntimeIdentityHash ||
      !HASH_PATTERN.test(expectedRuntimeIdentityHash || '') ||
      !path.isAbsolute(binding.executable || '') ||
      !HASH_PATTERN.test(binding.provenanceSha256 || '') ||
      !bindingKeys(binding.identity, [
        'realpath', 'platform', 'arch', 'basename', 'sha256', 'version',
      ]) || binding.identity.realpath !== binding.executable ||
      !HASH_PATTERN.test(binding.identity.sha256 || '') ||
      typeof binding.identity.version !== 'string' || !binding.identity.version ||
      !['official-package-runtime', 'standalone-package-runtime',
        'explicit-configured-runtime'].includes(binding.source)) {
    fail('Signed Codex executable binding is invalid or belongs to different provider trust')
  }
  let runtime
  if (['official-package-runtime', 'standalone-package-runtime'].includes(binding.source)) {
    if (typeof binding.packageRoot !== 'string' || !path.isAbsolute(binding.packageRoot)) {
      fail('Signed Codex package root is invalid')
    }
    const fromPackage = binding.source === 'standalone-package-runtime'
      ? runtimeFromStandalonePackage : runtimeFromPackage
    runtime = fromPackage(binding.packageRoot, {
      platform: binding.identity.platform,
      arch: binding.identity.arch,
      expectedSha256: binding.identity.sha256,
    })
  } else {
    if (binding.packageRoot !== null) fail('Explicit Codex executable binding has package provenance')
    runtime = resolveCodexExecutable(binding.executable, {
      platform: binding.identity.platform,
      arch: binding.identity.arch,
      expectedSha256: binding.identity.sha256,
      expectedVersion: binding.identity.version,
    })
  }
  if (!runtime || !sameIdentity(runtime.identity, binding.identity) ||
      runtime.source !== binding.source || runtime.packageRoot !== binding.packageRoot ||
      runtime.provenanceSha256 !== binding.provenanceSha256) {
    fail('Signed Codex executable binding drifted before supervisor admission')
  }
  return admitCodexExecutable(runtime, binding.identity)
}

function executeAdmittedCodex(runtime, argv, options = {}) {
  if (!runtime || !admittedRuntimes.has(runtime) || !Array.isArray(argv) ||
      argv.some(value => typeof value !== 'string')) {
    fail('Codex command cannot execute without an admitted runtime and exact argv')
  }
  const refreshed = refreshedRuntime(runtime)
  if (!runtimeUnchanged(runtime, refreshed)) fail('Codex executable drifted before command execution')
  const execFileSync = options.execFileSync || childProcess.execFileSync
  let output
  let commandError
  try {
    output = execFileSync(runtime.executable, argv, {
      cwd: options.cwd || process.cwd(),
      env: withCodexManagedEnvironment(options.environment || process.env, runtime),
      encoding: options.encoding || 'utf8',
      shell: false,
      windowsHide: true,
      ...(options.timeout ? { timeout: options.timeout } : {}),
    })
  } catch (error) {
    commandError = error
  }
  const rebound = refreshedRuntime(runtime)
  if (!runtimeUnchanged(runtime, rebound)) fail('Codex executable drifted during command execution')
  if (commandError) throw commandError
  return output
}

function queryAdmittedCodexVersion(runtime, options = {}) {
  if (!runtime || !admittedRuntimes.has(runtime)) {
    fail('Codex executable version cannot be queried before runtime admission')
  }
  const refreshed = refreshedRuntime(runtime)
  if (!runtimeUnchanged(runtime, refreshed)) fail('Codex executable drifted after admission')
  const spawn = options.spawnSync || childProcess.spawnSync
  const result = spawn(runtime.executable, ['--version'], {
    cwd: options.cwd || process.cwd(),
    env: withCodexManagedEnvironment(options.environment || process.env, runtime),
    encoding: 'utf8',
    shell: false,
    timeout: options.timeout || 15_000,
    windowsHide: true,
  })
  const version = String(result?.stdout || '').trim()
  if (!result || result.error || result.status !== 0 || !version || /[\r\n]/.test(version) ||
      version !== runtime.identity.version) {
    fail('Admitted Codex executable version does not match the trusted runtime identity')
  }
  const rebound = refreshedRuntime(runtime)
  if (!runtimeUnchanged(runtime, rebound)) fail('Codex executable drifted during version query')
  return version
}

function withCodexManagedEnvironment(environment, runtime) {
  const result = { ...environment }
  const managedKeys = new Set([
    'codex_managed_by_bun', 'codex_managed_by_npm', 'codex_managed_by_pnpm',
    'codex_managed_package_root',
  ])
  for (const key of Object.keys(result)) {
    if (managedKeys.has(key.toLowerCase())) delete result[key]
  }
  return Object.assign(result, runtime?.environmentOverlay || {})
}

module.exports = {
  CodexExecutableError,
  admitCodexExecutable,
  bindAdmittedCodexExecutable,
  executeAdmittedCodex,
  openCodexExecutableAdmission,
  platformBinding,
  queryAdmittedCodexVersion,
  resolveCodexExecutable,
  runtimeFromPackage,
  runtimeFromStandalonePackage,
  withCodexManagedEnvironment,
}
