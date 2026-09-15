#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { RootGuard, acquire, release } = require('./install/operation-lock.cjs')
const { ReasonixError, readBound, privateDirectory, sha256, writePrivate } = require('../agents/reasonix/workflow/native.js')
const removal = require('../agents/reasonix/workflow/package-removal.js')
const ROOT = path.resolve(__dirname, '..')
const RECEIPT = '.autoprompt-reasonix-v2.json'
const SHIM = '---\nname: autoprompt\ndescription: "Start explicitly requested Autoprompt v2 work in Reasonix."\ninvocation: manual\n---\n\nRun `autoprompt activate reasonix --target <absolute-project-path> -- <mission>` in a terminal. The launcher starts the private v2 controller. Loading this skill alone never starts or resumes work.\n'
const TREES = ['agents/reasonix', 'agents/codex', 'agents/contracts', 'node_modules/@iarna/toml']
const BUNDLE_PACKAGE = '{"name":"@autoprompt-skill/reasonix-runtime","version":"2.0.0","private":true,"type":"commonjs"}\n'
const FILES = ['scripts/local-only-safety.cjs', 'scripts/darwin-runtime-setup.cjs', 'scripts/reasonix-package.cjs', 'scripts/reasonix-configure.cjs', 'scripts/install/operation-lock.cjs',
  'scripts/harness-v2-tool-boundary.cjs', 'scripts/harness-v2-tool-server.cjs', 'scripts/harness-v2-controlled-tools.cjs',
  'scripts/harness-v2-conformance.cjs', 'scripts/harness-v2-local-admission.cjs', 'scripts/harness-v2-package.cjs', 'scripts/harness-v2-native.cjs', 'scripts/harness-v2-native-wire-projection.cjs', 'scripts/harness-v2-request-quota.cjs', 'scripts/harness-v2-quota-relay.cjs', 'scripts/harness-v2-quota-connection.cjs',
  'scripts/harness-v2-canary.cjs', 'scripts/harness-v2-closed-canary.cjs', 'scripts/harness-v2-trust/evidence.json',
  'scripts/harness-v2-trust/trusted-public-keys.json', 'scripts/harness-v2-admission.cjs',
  'scripts/harness-v2-prime-migration.cjs', 'scripts/install/harness-v2-legacy.json', 'scripts/install/prime-settings.cjs']
const CONFORMANCE_ASSETS = ['tests/source/reasonix-controlled-native.test.cjs', 'tests/source/harness-v2-reasonix-capability-native.test.cjs']

function absoluteRoot(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || /[\0\r\n]/.test(root) || path.resolve(root) === path.parse(root).root) {
    throw new ReasonixError('INSTALL_ROOT_INVALID', 'Use an absolute provider config root below the filesystem root')
  }
  return path.resolve(root)
}
function exists(file) { try { fs.lstatSync(file); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }
function launcher(root) {
  root = absoluteRoot(root)
  const posix = `'${root.replaceAll("'", "'\\''")}'`, powershell = `'${root.replaceAll("'", "''")}'`
  return `---\nname: autoprompt\ndescription: "Start explicitly requested Autoprompt v2 work in Reasonix."\ninvocation: manual\n---\n\nThis installation is bound to ${JSON.stringify(root)}. Pass that exact config root with --root; never substitute a default directory.\n\nBash:\n\n\`\`\`sh\nautoprompt activate reasonix --root ${posix} --target <absolute-project-path> -- <mission>\n\`\`\`\n\nPowerShell:\n\n\`\`\`powershell\nautoprompt activate reasonix --root ${powershell} --target <absolute-project-path> -- <mission>\n\`\`\`\n\nThe angle-bracket fields are placeholders. Preserve the exact user request as arguments after --, not executable shell text. The launcher starts the private v2 controller. Loading this skill alone never starts or resumes work.\n`
}
function assertPrivateDiscovery(root, guard) {
  const legacy = Object.keys(require('../agents/reasonix/legacy-v1-hashes.json'))
  const roles = Object.keys(require('../agents/reasonix/role-policy.json').physical_roles)
  const candidates = new Set([...legacy, ...roles.flatMap(role => [`skills/${role}/SKILL.md`, `skills/autoprompt/skills/${role}/SKILL.md`])])
  candidates.delete('skills/autoprompt/SKILL.md')
  for (const relative of candidates) {
    const file = path.join(root, relative)
    if (!exists(file)) continue
    guard.assertExisting(file)
    throw new ReasonixError('PAYLOAD_INVALID', `Public legacy or controller role was reintroduced: ${relative}`)
  }
}

function walk(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    const file = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new ReasonixError('PAYLOAD_INVALID', `Linked runtime entry: ${relative}`)
    if (entry.isDirectory()) return walk(file, relative)
    if (!entry.isFile()) throw new ReasonixError('PAYLOAD_INVALID', `Non-file runtime entry: ${relative}`)
    return [relative]
  })
}

function sourcePath(root, file) {
  const prefix = 'node_modules/@iarna/toml'
  return file.startsWith(prefix) ? path.join(path.dirname(require.resolve('@iarna/toml/package.json', { paths: [root] })), file.slice(prefix.length)) : path.join(root, file)
}

function sourceInventory(root = ROOT) {
  const assets = CONFORMANCE_ASSETS.filter(file => exists(sourcePath(root, file)))
  if (path.resolve(root) === ROOT && assets.length !== CONFORMANCE_ASSETS.length) {
    throw new ReasonixError('PAYLOAD_INVALID', 'Published Reasonix runtime is missing a required native conformance asset')
  }
  // Match npm's bundled dependency closure, which omits this non-runtime
  // changelog, so source and packed reviewed identities remain identical.
  const files = [...FILES, ...assets, ...TREES.flatMap(tree => walk(sourcePath(root, tree)).map(file => `${tree}/${file}`))]
    .filter(file => file !== 'node_modules/@iarna/toml/CHANGELOG.md').sort()
  const hashes = Object.fromEntries(files.map(file => [file, sha256(readBound(sourcePath(root, file)))]))
  const digest = sha256(JSON.stringify(hashes))
  return { schemaVersion: 2, provider: 'reasonix', contractVersion: '2.0.0', payloadGeneration: `reasonix-v2.0.0-${digest.slice(0, 16)}`, payloadDigest: digest, files: hashes }
}

function resolveRoot(env = process.env) {
  return path.resolve(env.AUTOPROMPT_INSTALL_ROOT || env.REASONIX_HOME ||
    (process.platform === 'win32' ? path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'reasonix') : path.join(env.HOME || os.homedir(), '.reasonix')))
}

function readReceipt(root) {
  const receipt = JSON.parse(readBound(path.join(root, RECEIPT)).toString('utf8'))
  if (receipt.schemaVersion !== 2 || receipt.provider !== 'reasonix' ||
      !/^reasonix-v2\.0\.0-[a-f0-9]{16}$/.test(receipt.payloadGeneration || '') ||
      !receipt.files || typeof receipt.files !== 'object' || Array.isArray(receipt.files) || !Object.keys(receipt.files).length || sha256(JSON.stringify(receipt.files)) !== receipt.payloadDigest ||
      receipt.payloadGeneration !== `reasonix-v2.0.0-${receipt.payloadDigest.slice(0, 16)}`) {
    throw new ReasonixError('PAYLOAD_INVALID', 'Reasonix installation receipt is invalid')
  }
  for (const [file, hash] of Object.entries(receipt.files)) {
    if (path.isAbsolute(file) || /[\\:\0\r\n]/.test(file) || file.split('/').some(part => !part || part === '.' || part === '..') || !/^[a-f0-9]{64}$/.test(hash)) {
      throw new ReasonixError('PAYLOAD_INVALID', 'Reasonix receipt path escapes the bundle')
    }
  }
  return receipt
}

function bundlePath(root, receipt) { return path.join(root, '.autoprompt-private', 'bundles', receipt.payloadGeneration) }

function verify(root, { allowLegacyShim = false } = {}) {
  root = absoluteRoot(root)
  const guard = new RootGuard(root)
  assertPrivateDiscovery(root, guard)
  const receipt = readReceipt(root)
  const bundle = bundlePath(root, receipt)
  guard.assertExisting(bundle, 'directory')
  if (readBound(path.join(bundle, 'package.json')).toString('utf8') !== BUNDLE_PACKAGE) throw new ReasonixError('PAYLOAD_INVALID', 'Reasonix package metadata changed')
  const actual = walk(bundle).filter(file => file !== 'package.json')
  if (JSON.stringify(actual.sort()) !== JSON.stringify(Object.keys(receipt.files).sort())) throw new ReasonixError('PAYLOAD_INVALID', 'Reasonix bundle inventory drifted')
  for (const [file, hash] of Object.entries(receipt.files)) {
    const target = guard.assertExisting(path.join(bundle, file))
    if (sha256(readBound(target)) !== hash) throw new ReasonixError('PAYLOAD_INVALID', `Reasonix payload changed: ${file}`)
  }
  const shim = guard.assertExisting(path.join(root, 'skills', 'autoprompt', 'SKILL.md'))
  const bytes = readBound(shim).toString('utf8')
  const legacyShim = bytes === SHIM
  if (bytes !== launcher(root) && !(allowLegacyShim && legacyShim)) throw new ReasonixError('PAYLOAD_INVALID', 'Reasonix entry skill changed or lacks its config-root binding; reinstall to migrate the original v2 launcher')
  return { status: 'verified', root, bundle, ...receipt, ...(legacyShim ? { legacyShim: true } : {}) }
}

function install(root, sourceRoot = ROOT) {
  root = absoluteRoot(root)
  privateDirectory(root)
  const guard = new RootGuard(root)
  const lease = acquire(root, 'install-reasonix-v2', { guard })
  try {
    removal.recover(root)
    const receipt = sourceInventory(sourceRoot)
    const existing = exists(path.join(root, RECEIPT)) ? verify(root, { allowLegacyShim: true }) : null
    if (existing?.payloadDigest === receipt.payloadDigest && !existing.legacyShim) return existing
    assertNoResumableActivation(root)
    const shim = path.join(root, 'skills', 'autoprompt', 'SKILL.md')
    if (existing?.payloadDigest === receipt.payloadDigest && existing.legacyShim) {
      const temporary = `${shim}.migrate-${require('node:crypto').randomUUID()}`
      try {
        writePrivate(temporary, launcher(root))
        if (readBound(guard.assertExisting(shim)).toString('utf8') !== SHIM) throw new ReasonixError('INSTALL_CONFLICT', 'Legacy entry changed during migration')
        fs.renameSync(temporary, shim)
      } finally { if (exists(temporary)) fs.unlinkSync(guard.assertExisting(temporary)) }
      return verify(root)
    }
    const legacy = require('../agents/reasonix/legacy-v1-hashes.json')
    const migrate = []
    for (const [relative, hash] of Object.entries(legacy)) {
      const file = path.join(root, relative)
      if (!exists(file)) continue
      guard.assertExisting(file)
      const bytes = readBound(file).toString('utf8').replaceAll('\r\n', '\n')
      if (existing && file === shim && (bytes === SHIM || bytes === launcher(root))) continue
      if (sha256(bytes) !== hash && !(file === shim && bytes === SHIM)) throw new ReasonixError('INSTALL_CONFLICT', `Changed legacy file requires manual migration: ${file}`)
      const quarantined = path.join(root, '.autoprompt-private', 'legacy-v1', path.relative(root, file))
      if (fs.existsSync(quarantined)) throw new ReasonixError('INSTALL_CONFLICT', 'Legacy quarantine already exists')
      migrate.push(file)
    }
    const bundle = bundlePath(root, receipt)
    if (fs.existsSync(bundle)) throw new ReasonixError('INSTALL_CONFLICT', 'An unregistered Reasonix bundle already exists')
    const stage = `${bundle}.stage-${require('node:crypto').randomUUID()}`
    const temporary = path.join(root, `${RECEIPT}.tmp-${require('node:crypto').randomUUID()}`)
    const previousReceipt = existing ? readBound(path.join(root, RECEIPT)) : null
    const previousShim = existing ? readBound(shim) : null
    const temporaryShim = `${shim}.tmp-${require('node:crypto').randomUUID()}`
    const moved = []
    let published = false
    let shimCreated = false
    let shimReplaced = false
    let receiptPublished = false
    let verified
    try {
      privateDirectory(stage)
      for (const [file, hash] of Object.entries(receipt.files)) {
        const bytes = readBound(sourcePath(sourceRoot, file))
        if (sha256(bytes) !== hash) throw new ReasonixError('PAYLOAD_INVALID', 'Reasonix source changed during installation')
        writePrivate(path.join(stage, file), bytes)
      }
      writePrivate(path.join(stage, 'package.json'), BUNDLE_PACKAGE)
      guard.assertExisting(stage, 'directory')
      guard.assertParent(bundle)
      fs.renameSync(stage, bundle)
      published = true
      // Quarantine only byte-matched v1 files; preserve config and unrelated skills.
      const quarantine = path.join(root, '.autoprompt-private', 'legacy-v1')
      for (const file of migrate) {
        const destination = path.join(quarantine, path.relative(root, file))
        privateDirectory(path.dirname(destination))
        if (fs.existsSync(destination)) throw new ReasonixError('INSTALL_CONFLICT', 'Legacy quarantine already exists')
        guard.assertExisting(file)
        fs.renameSync(file, destination)
        moved.push({ file, destination })
      }
      if (existing) {
        if (!readBound(guard.assertExisting(shim)).equals(previousShim)) throw new ReasonixError('INSTALL_CONFLICT', 'Entry changed during upgrade')
        writePrivate(temporaryShim, launcher(root)); fs.renameSync(temporaryShim, shim); shimReplaced = true
      } else if (!exists(shim)) { writePrivate(shim, launcher(root)); shimCreated = true }
      writePrivate(temporary, `${JSON.stringify(receipt, null, 2)}\n`)
      fs.renameSync(temporary, path.join(root, RECEIPT))
      receiptPublished = true
      verified = verify(root)
    } catch (error) {
      try {
        if (receiptPublished) {
          if (previousReceipt) {
            writePrivate(temporary, previousReceipt)
            fs.renameSync(temporary, path.join(root, RECEIPT))
          } else fs.unlinkSync(guard.assertExisting(path.join(root, RECEIPT)))
        }
        if (fs.existsSync(temporary)) fs.unlinkSync(guard.assertExisting(temporary))
        if (exists(temporaryShim)) fs.unlinkSync(guard.assertExisting(temporaryShim))
        if (shimReplaced) { writePrivate(temporaryShim, previousShim); fs.renameSync(temporaryShim, shim) }
        if (shimCreated) fs.unlinkSync(guard.assertExisting(shim))
        for (const { file, destination } of moved.reverse()) {
          if (fs.existsSync(file)) throw new ReasonixError('INSTALL_CONFLICT', `Cannot restore legacy file over a new file: ${file}`)
          fs.renameSync(guard.assertExisting(destination), file)
        }
        const abandoned = published ? bundle : stage
        if (fs.existsSync(abandoned)) {
          guard.assertExisting(abandoned, 'directory')
          // Only remove our transaction's known files, never an unexpected entry.
          for (const file of walk(abandoned)) {
            if (file !== 'package.json' && !Object.hasOwn(receipt.files, file)) throw new ReasonixError('INSTALL_CONFLICT', `Unexpected staged file: ${file}`)
            guard.assertExisting(path.join(abandoned, file))
          }
          fs.rmSync(abandoned, { recursive: true })
        }
      } catch (rollbackError) {
        throw new ReasonixError('INSTALL_RECOVERY_REQUIRED', `Reasonix installation failed: ${error.message}; rollback needs attention: ${rollbackError.message}`)
      }
      throw error
    }
    if (existing) removal.retire(existing)
    return verified
  } finally { release(lease) }
}

function assertNoResumableActivation(root) {
  const activations = path.join(root, '.autoprompt-private', 'activations')
  if (!fs.existsSync(activations)) return
  const guard = new RootGuard(root)
  guard.assertExisting(activations, 'directory')
  for (const directory of fs.readdirSync(activations)) {
    const recordFile = path.join(activations, directory, 'activation.json')
    if (!fs.existsSync(recordFile)) continue
    guard.assertExisting(recordFile)
    const record = JSON.parse(readBound(recordFile))
    if ((record.providerId || record.provider) && (record.providerId || record.provider) !== 'reasonix') continue
    if (!record.status || ['active', 'running', 'waiting', 'resumable'].includes(record.status) || record.outcome === 'WAITING_USER') throw new ReasonixError('ACTIVE_RUN', 'Finish or cancel the resumable Reasonix run before replacing its runtime')
  }
}

function uninstall(root) {
  root = absoluteRoot(root)
  if (!exists(root)) return { status: 'not-installed', root }
  const lease = acquire(root, 'uninstall-reasonix-v2')
  try {
    removal.recover(root)
    if (!exists(path.join(root, RECEIPT))) return { status: 'not-installed', root }
    const installed = verify(root)
    assertNoResumableActivation(root)
    removal.retire(installed, { includePublic: true })
    return { status: 'uninstalled', root, runHistoryRetained: true }
  } finally { release(lease) }
}

function doctorPrerequisites(root, options = {}) {
  const installed = verify(root)
  const result = { ...installed, payload: 'verified', detected: false, activation: 'unavailable', reason: 'activation-prerequisites-unavailable' }
  try {
    const native = require('../agents/reasonix/workflow/native.js')
    const admission = require('../agents/reasonix/workflow/admission.js')
    const environment = options.env || process.env
    const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-reasonix-doctor-'))
    let executable
    try {
      const probeEnv = require('./harness-v2-native.cjs').isolatedEnvironment(probeRoot, environment)
      executable = native.probeExecutable({ env: environment, executable: options.executable,
        spawnSync(file, argv, settings) {
          return require('node:child_process').spawnSync(file, argv, { ...settings, env: probeEnv, cwd: probeRoot, windowsHide: true })
        } })
    } finally { fs.rmSync(probeRoot, { recursive: true, force: true }) }
    result.detected = true; result.nativeVersion = executable.version
    const imported = require('./reasonix-configure.cjs').importedAdmission(root)
    let pending = null
    try { admission.verifyAdmission(installed, executable, imported || {}) }
    catch (error) {
      if (imported || !admission.awaitingIndependentConformance(installed)) throw error
      pending = admission.reviewedLocalPending(installed, executable, { now: options.now })
      if (!pending) throw error
    }
    require('./harness-v2-tool-boundary.cjs').assertCommandSandboxPrerequisites({ env: environment })
    return { ...result, activation: pending ? 'local-canary-required' : 'static-ready;dynamic-preflight-required', reason: '-', nativeVersion: executable.version }
  } catch (error) {
    return { ...result, reason: String(error.code || 'RUNTIME_FAILURE').toLowerCase().replaceAll('_', '-'), message: error.message }
  }
}

function run(argv = process.argv.slice(2), options = {}) {
  const [action, flag, value] = argv
  if (!['install', 'verify', 'doctor', 'uninstall', 'plan'].includes(action) ||
      (flag !== undefined && (flag !== '--root' || !path.isAbsolute(value || '') || argv.length !== 3))) {
    throw new ReasonixError('INVALID_INPUT', 'Use reasonix-package.cjs <install|verify|doctor|uninstall|plan> [--root <absolute-path>]')
  }
  const root = value || resolveRoot(options.env)
  if (action === 'plan') return sourceInventory(options.sourceRoot)
  if (action === 'install') return install(root, options.sourceRoot)
  if (action === 'uninstall') return uninstall(root)
  if (action === 'doctor') return doctorPrerequisites(root, options)
  return verify(root)
}

if (require.main === module) {
  try { const result = run(); process.stdout.write(`${JSON.stringify({ status: result.status, root: result.root, payloadGeneration: result.payloadGeneration, payload: result.payload, detected: result.detected, activation: result.activation, reason: result.reason, message: result.message, nativeVersion: result.nativeVersion })}\n`); if (result.activation === 'unavailable') process.exitCode = 1 }
  catch (error) { process.stderr.write(`${error.code || 'RUNTIME_FAILURE'}: ${error.message}\n`); process.exitCode = 1 }
}
module.exports = { RECEIPT, ROOT, SHIM, launcher, bundlePath, install, readReceipt, resolveRoot, run, sourceInventory, uninstall, verify, doctor: doctorPrerequisites, doctorPrerequisites, walk }
