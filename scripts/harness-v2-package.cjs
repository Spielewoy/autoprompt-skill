#!/usr/bin/env node
'use strict'

// Provider discovery contains only a manual launcher. Everything executable, including
// generated native roles, lives in a receipt-bound, non-discoverable generation.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { RootGuard, acquire, release } = require('./install/operation-lock.cjs')
const { ReasonixError: PackageError, readBound, privateDirectory, sha256, writePrivate } = require('../agents/reasonix/workflow/native.js')
const LEGACY = require('./install/harness-v2-legacy.json').providers
const primeMigration = require('./harness-v2-prime-migration.cjs')
const ROOT = path.resolve(__dirname, '..')
const PROVIDERS = Object.freeze(['claude', 'opencode', 'kilo', 'vscode', 'prime', 'omp', 'deepseek', 'hermes', 'grok'])
const REQUIRED = ['scripts/harness-v2-package.cjs', 'scripts/harness-v2-configure.cjs', 'scripts/harness-v2-native.cjs', 'scripts/harness-v2-transport.cjs', 'scripts/harness-v2-native-wire-projection.cjs', 'scripts/harness-v2-request-quota.cjs', 'scripts/harness-v2-quota-relay.cjs', 'scripts/harness-v2-quota-connection.cjs', 'scripts/harness-v2-admission.cjs', 'scripts/harness-v2-trust/evidence.json', 'scripts/harness-v2-trust/trusted-public-keys.json', 'scripts/local-only-safety.cjs', 'scripts/windows-git-bootstrap-config.cjs', 'scripts/install/operation-lock.cjs', 'scripts/install/harness-v2-legacy.json']
// These are the closed actual-binary conformance suites invoked by the public
// diagnostic. They are runtime assets, not the general source test suite.
const CONFORMANCE_ASSETS = Object.freeze([
  'tests/source/harness-v2-adapter-native.test.cjs',
  'tests/source/harness-v2-claude-capability-native.test.cjs',
  'tests/source/harness-v2-deepseek-capability-native.test.cjs',
  'tests/source/harness-v2-hermes-capability-native.test.cjs',
  'tests/source/harness-v2-grok-capability-native.test.cjs',
  'tests/source/harness-v2-vscode-capability-native.test.cjs',
  'tests/source/harness-v2-opencode-capability-native.test.cjs',
  'tests/source/harness-v2-pi-capability-native.test.cjs',
  'tests/source/harness-v2-reasonix-capability-native.test.cjs',
  'tests/source/harness-v2-pi-adapter-native.test.cjs',
  'tests/source/harness-v2-vscode-owned-native.test.cjs',
  'tests/source/harness-v2-hermes-adapter-native.test.cjs',
  'tests/source/harness-v2-windows-shim.test.cjs',
  'tests/source/harness-v2-grok.test.cjs',
  'tests/source/harness-v2-grok-proxy.test.cjs',
  'tests/source/harness-v2-grok-sandbox.test.cjs',
  'tests/source/harness-v2-grok-adapter-native.test.cjs',
  'tests/source/reasonix-controlled-native.test.cjs',
  'tests/helpers/harness-native-service.cjs',
  'tests/helpers/harness-pi-native-service.cjs',
  'tests/helpers/native-platform.cjs',
])
const HASH = /^[a-f0-9]{64}$/
const DARWIN_EXECUTABLES = new Set([
  'agents/codex/workflow/darwin-coalition-runtime/coalition-helper-x64',
  'agents/codex/workflow/darwin-coalition-runtime/coalition-helper-arm64',
  'agents/codex/workflow/darwin-listener-runtime/listener-supervisor-x64',
  'agents/codex/workflow/darwin-listener-runtime/listener-supervisor-arm64',
])
function fail(code, message) { throw new PackageError(code, message) }
function setPackagedMode(relative, target) {
  if (process.platform !== 'win32' && DARWIN_EXECUTABLES.has(relative)) fs.chmodSync(target, 0o700)
}
function providerCheck(provider) { if (!PROVIDERS.includes(provider)) fail('INVALID_INPUT', `Unknown v2 provider: ${provider}`); return provider }
function exists(file) { try { fs.lstatSync(file); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }
function absoluteRoot(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || path.resolve(root) === path.parse(root).root) fail('INSTALL_ROOT_INVALID', 'Use an absolute provider config root below the filesystem root')
  return path.resolve(root)
}
function rootCandidate(provider, env = process.env, cwd = process.cwd()) {
  providerCheck(provider)
  if (Object.hasOwn(env, 'AUTOPROMPT_INSTALL_ROOT')) return env.AUTOPROMPT_INSTALL_ROOT
  const home = env.HOME || env.USERPROFILE || os.homedir()
  const xdg = env.XDG_CONFIG_HOME || path.join(home, '.config')
  let root
  switch (provider) {
    case 'claude': root = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'); break
    case 'opencode': root = path.join(xdg, 'opencode'); break
    case 'kilo': root = path.join(xdg, 'kilo'); break
    // Native personal skill discovery keeps controller state outside its target.
    case 'vscode': root = path.join(home, '.copilot'); break
    case 'prime': root = env.PRIME_AGENT_CODING_AGENT_DIR || path.join(home, '.prime', 'agent'); break
    case 'deepseek': root = env.DSH_HOME || path.join(home, '.dsh'); break
    case 'grok': root = env.GROK_HOME || path.join(home, '.grok'); break
    case 'hermes': root = env.HERMES_HOME || path.join(home, '.hermes'); break
    case 'omp': {
      const profile = String(env.OMP_PROFILE ?? env.PI_PROFILE ?? '').trim()
      if (profile && profile !== 'default' && (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(profile) || profile.endsWith('.') || /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/i.test(profile))) fail('INVALID_INPUT', 'Invalid OMP profile')
      const config = env.PI_CONFIG_DIR || '.omp'
      const base = path.isAbsolute(config) ? config : path.join(home, config)
      root = profile && profile !== 'default' ? path.join(base, 'profiles', profile, 'agent') : env.PI_CODING_AGENT_DIR || path.join(base, 'agent')
      break
    }
  }
  return root
}
function resolveRoot(provider, env = process.env) { return absoluteRoot(rootCandidate(provider, env)) }
function receiptName(provider) { return `.autoprompt-${providerCheck(provider)}-v2.json` }
function launcherRelative(provider) {
  providerCheck(provider)
  if (provider === 'opencode' || provider === 'kilo') return 'commands/autoprompt.md'
  if (provider === 'omp') return 'prompts/autoprompt.md'
  return 'skills/autoprompt/SKILL.md'
}
function launcherPath(provider, root) { return path.join(absoluteRoot(root), launcherRelative(provider)) }
function launcher(provider, root) {
  const description = `Start explicitly requested Autoprompt v2 work in ${provider}.`
  let header = `description: "${description}"\n`
  if (!['opencode', 'kilo', 'omp'].includes(provider)) header = `name: autoprompt\n${header}disable-model-invocation: true\nuser-invocable: true\n`
  let binding = ''
  if (root !== undefined) {
    root = absoluteRoot(root)
    const posix = `'${root.replaceAll("'", "'\\''")}'`
    const powershell = `'${root.replaceAll("'", "''")}'`
    binding = `\nThis installation is bound to the config root ${JSON.stringify(root)}. Pass it explicitly with --root; never substitute a default config directory.\n\nBash:\n\n\`\`\`sh\nautoprompt activate ${provider} --root ${posix} --target <absolute-project-path> -- <request>\n\`\`\`\n\nPowerShell:\n\n\`\`\`powershell\nautoprompt activate ${provider} --root ${powershell} --target <absolute-project-path> -- <request>\n\`\`\`\n\nThe angle-bracket fields are placeholders. Preserve the exact user request as arguments after --, not as executable shell text.\n`
  }
  return `---\n${header}---\n\nRun \`autoprompt activate ${provider} --target <absolute-project-path> -- <request>\` in a terminal, using the user's explicitly supplied request.${binding}\nThe command starts the private v2 controller. Loading this launcher never starts or resumes work. Internal roles and frameworks are private controller resources.\n`
}
function publicFiles(provider, root) {
  // Prime discovers this native global skill without installing an executable
  // package or enabling an automatic extension in the user's configuration.
  return { [launcherRelative(provider)]: launcher(provider, root) }
}
function bundleMetadata(provider) { return `${JSON.stringify({ name: `@autoprompt-skill/${provider}-runtime`, version: '2.0.0', private: true, type: 'commonjs' })}\n` }
function bundlePath(root, receipt) { return path.join(absoluteRoot(root), '.autoprompt-private', 'bundles', receipt.payloadGeneration) }
function walk(directory, prefix = '') {
  const stat = fs.lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('PAYLOAD_INVALID', `Linked or invalid directory: ${directory}`)
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) fail('PAYLOAD_INVALID', `Linked runtime entry: ${relative}`)
    if (entry.isDirectory()) return walk(path.join(directory, entry.name), relative)
    if (!entry.isFile()) fail('PAYLOAD_INVALID', `Non-file runtime entry: ${relative}`)
    return [relative]
  })
}
function sourcePath(root, file) {
  for (const dependency of ['@iarna/toml', 'yaml']) {
    const prefix = `node_modules/${dependency}`
    if (file === prefix || file.startsWith(`${prefix}/`)) return path.join(path.dirname(require.resolve(`${dependency}/package.json`, { paths: [root] })), file.slice(prefix.length))
  }
  return path.join(root, file)
}
function sourceInventory(provider, sourceRoot = ROOT) {
  providerCheck(provider)
  const trees = ['agents/codex', 'agents/contracts', `agents/${provider}`, 'agents/reasonix/workflow', 'node_modules/@iarna/toml', 'node_modules/yaml']
  const scriptEntries = fs.readdirSync(path.join(sourceRoot, 'scripts'), { withFileTypes: true })
  const helpers = scriptEntries.filter(entry => /^harness-v2-.*\.cjs$/.test(entry.name)).map(entry => `scripts/${entry.name}`)
  // New dependencies extend the next generation without invalidating older
  // receipts before their transactional upgrade can run.
  helpers.push('scripts/install/prime-settings.cjs')
  if (path.resolve(sourceRoot) === ROOT || fs.existsSync(path.join(sourceRoot, 'scripts/darwin-runtime-setup.cjs'))) helpers.push('scripts/darwin-runtime-setup.cjs')
  if (path.resolve(sourceRoot) === ROOT || fs.existsSync(path.join(sourceRoot, 'scripts/darwin-command-sandbox.cjs'))) {
    helpers.push('scripts/darwin-command-sandbox.cjs', 'scripts/darwin-command-probe.cjs')
  }
  for (const entry of scriptEntries) if (entry.isDirectory() && entry.name.startsWith('harness-v2-')) trees.push(`scripts/${entry.name}`)
  // Lifecycle fault fixtures intentionally contain only the runtime closure.
  // Only those explicit alternate source roots may omit diagnostic assets;
  // the published source root must always package the closed test closure.
  const availableConformanceAssets = CONFORMANCE_ASSETS.filter(file => fs.existsSync(sourcePath(sourceRoot, file)))
  if (path.resolve(sourceRoot) === ROOT && availableConformanceAssets.length !== CONFORMANCE_ASSETS.length) {
    fail('PAYLOAD_INVALID', 'Published v2 runtime is missing a required native conformance asset')
  }
  // npm omits this dependency changelog from its bundled package. It is not
  // executable runtime content; exclude it from source installs as well so a
  // reviewed source closure has the same identity after packing/installing.
  const names = [...new Set([...REQUIRED, ...availableConformanceAssets, ...helpers, ...trees.flatMap(tree => walk(sourcePath(sourceRoot, tree)).map(file => `${tree}/${file}`))])]
    .filter(file => file !== 'node_modules/@iarna/toml/CHANGELOG.md').sort()
  const files = Object.fromEntries(names.map(file => {
    const source = sourcePath(sourceRoot, file)
    // Check ancestors as well as the final file; readBound refuses hard links.
    privateSourceDirectory(path.dirname(source))
    return [file, sha256(readBound(source))]
  }))
  const payloadDigest = sha256(JSON.stringify(files))
  return { schemaVersion: 2, provider, contractVersion: '2.0.0', payloadGeneration: `${provider}-v2.0.0-${payloadDigest.slice(0, 16)}`, payloadDigest, files }
}
function privateSourceDirectory(directory) {
  const stat = fs.lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('PAYLOAD_INVALID', `Linked source directory: ${directory}`)
  if (path.dirname(directory) !== directory) privateSourceDirectory(path.dirname(directory))
}
function readReceipt(provider, root) {
  providerCheck(provider); root = absoluteRoot(root)
  const guard = new RootGuard(root)
  const receipt = JSON.parse(readBound(guard.assertExisting(path.join(root, receiptName(provider)))).toString('utf8'))
  if (receipt.schemaVersion !== 2 || receipt.provider !== provider || receipt.contractVersion !== '2.0.0' || !HASH.test(receipt.payloadDigest || '') ||
      receipt.payloadGeneration !== `${provider}-v2.0.0-${receipt.payloadDigest.slice(0, 16)}` || !receipt.files || Array.isArray(receipt.files) ||
      sha256(JSON.stringify(receipt.files)) !== receipt.payloadDigest) fail('PAYLOAD_INVALID', 'Installation receipt is invalid')
  for (const [file, hash] of Object.entries(receipt.files)) {
    if (path.isAbsolute(file) || file.includes('\\') || file.includes(':') || file.split('/').some(part => !part || part === '.' || part === '..') || !HASH.test(hash)) fail('PAYLOAD_INVALID', 'Invalid receipt file or hash')
  }
  for (const file of REQUIRED) if (!Object.hasOwn(receipt.files, file)) fail('PAYLOAD_INVALID', `Missing runtime closure: ${file}`)
  return receipt
}
function legacyCandidates(provider) {
  const originals = LEGACY[provider]
  const candidates = { ...originals }
  // Old explicit roots and old home/XDG-root installs are both recognized.
  const prefixes = { claude: ['.claude'], opencode: ['opencode'], kilo: ['kilo', '.kilo'], vscode: ['.copilot', '.github'], omp: [], deepseek: [], hermes: [], grok: [], prime: [] }[provider]
  for (const prefix of prefixes) for (const [relative, hashes] of Object.entries(originals)) candidates[`${prefix}/${relative}`] = hashes
  return candidates
}
function isVerifiedForeignLauncher(provider, root, relative, bytes) {
  // Shared config roots may hold distinct v2 manual entries. Never exempt a
  // collision with this provider's own entry, or trust launcher text alone.
  if (Object.hasOwn(publicFiles(provider, root), relative)) return false
  for (const other of PROVIDERS) {
    if (other === provider || !Object.hasOwn(publicFiles(other, root), relative) || !exists(path.join(root, receiptName(other)))) continue
    const expected = Buffer.from(publicFiles(other, root)[relative])
    if (!bytes.equals(expected)) continue
    const receipt = readReceipt(other, root)
    verifyBundle(other, root, receipt)
    return true
  }
  return false
}
function migrationPlan(provider, root, existing) {
  const guard = new RootGuard(root)
  const plan = []
  for (const [relative, hashes] of Object.entries(legacyCandidates(provider))) {
    const file = path.join(root, relative)
    if (!exists(file)) continue
    const bytes = readBound(guard.assertExisting(file))
    if (existing && Object.hasOwn(publicFiles(provider, root), relative) && bytes.equals(Buffer.from(publicFiles(provider, root)[relative]))) continue
    if (isVerifiedForeignLauncher(provider, root, relative, bytes)) continue
    if (!hashes.includes(sha256(bytes))) fail('INSTALL_CONFLICT', `Changed legacy file requires manual migration: ${file}`)
    const destination = path.join(root, '.autoprompt-private', 'legacy-v1', provider, relative)
    if (exists(destination)) fail('INSTALL_CONFLICT', `Legacy quarantine already exists: ${destination}`)
    plan.push({ file, destination, hash: sha256(bytes) })
  }
  return plan
}
function assertNoLegacyDiscovery(provider, root) {
  const guard = new RootGuard(root)
  for (const relative of Object.keys(legacyCandidates(provider))) {
    if (Object.hasOwn(publicFiles(provider, root), relative)) continue
    const file = path.join(root, relative)
    if (!exists(file)) continue
    if (isVerifiedForeignLauncher(provider, root, relative, readBound(guard.assertExisting(file)))) continue
    fail('PAYLOAD_INVALID', `Legacy managed discovery remains: ${relative}`)
  }
}
function verifyBundle(provider, root, receipt) {
  const guard = new RootGuard(root)
  const bundle = guard.assertExisting(bundlePath(root, receipt), 'directory')
  if (readBound(guard.assertExisting(path.join(bundle, 'package.json'))).toString() !== bundleMetadata(provider)) fail('PAYLOAD_INVALID', 'Bundle package metadata changed')
  const actual = walk(bundle).filter(file => file !== 'package.json').sort()
  if (JSON.stringify(actual) !== JSON.stringify(Object.keys(receipt.files).sort())) fail('PAYLOAD_INVALID', 'Bundle inventory drifted')
  for (const [file, hash] of Object.entries(receipt.files)) if (sha256(readBound(guard.assertExisting(path.join(bundle, file)))) !== hash) fail('PAYLOAD_INVALID', `Payload changed: ${file}`)
  return bundle
}
function verify(provider, root) {
  root = absoluteRoot(root)
  privateSourceDirectory(root)
  const receipt = readReceipt(provider, root)
  const bundle = verifyBundle(provider, root, receipt)
  const guard = new RootGuard(root)
  for (const [relative, bytes] of Object.entries(publicFiles(provider, root))) if (!readBound(guard.assertExisting(path.join(root, relative))).equals(Buffer.from(bytes))) fail('PAYLOAD_INVALID', `Public launcher changed: ${relative}`)
  assertNoLegacyDiscovery(provider, root)
  return { status: 'verified', root, bundle, launcher: launcherPath(provider, root), ...receipt }
}
function assertNoResumableActivation(provider, root) {
  const guard = new RootGuard(root)
  const activations = path.join(root, '.autoprompt-private', 'activations')
  if (!exists(activations)) return
  guard.assertExisting(activations, 'directory')
  // Fail closed on linked, corrupt, or unknown activation state. Providers may share a root.
  for (const file of walk(activations).filter(file => path.basename(file) === 'activation.json')) {
    const record = JSON.parse(readBound(guard.assertExisting(path.join(activations, file))))
    if ((record.providerId || record.provider) && (record.providerId || record.provider) !== provider) continue
    if (record.status === 'active' || record.status === 'running' || record.status === 'waiting' || record.status === 'resumable' || record.outcome === 'WAITING_USER') fail('ACTIVE_RUN', `Finish or cancel the resumable ${provider} run before replacing its runtime`)
    if (!record.status) fail('ACTIVE_RUN', 'Unresolved activation record requires recovery')
  }
}

// Every publication is a rename with an inverse. Only this transaction's exact
// bytes are eligible for cleanup; concurrent custom entries are never removed.
function transaction(root, provider) {
  const guard = new RootGuard(root)
  const directory = path.join(root, '.autoprompt-private', 'transactions', `${provider}-${crypto.randomUUID()}`)
  privateDirectory(directory)
  const undo = []
  const owned = new Map()
  function put(relative, bytes) {
    const target = path.join(directory, relative)
    writePrivate(target, bytes); owned.set(target, sha256(bytes)); return target
  }
  function move(from, to) {
    guard.assertExisting(from, fs.lstatSync(from).isDirectory() ? 'directory' : 'file')
    privateDirectory(path.dirname(to)); guard.assertParent(to)
    if (exists(to)) fail('INSTALL_CONFLICT', `Destination already exists: ${to}`)
    fs.renameSync(from, to)
    undo.push({ from, to })
  }
  function cleanup() {
    const files = walk(directory)
    for (const relative of files) {
      const file = guard.assertExisting(path.join(directory, relative))
      if (!owned.has(file) || sha256(readBound(file)) !== owned.get(file)) fail('INSTALL_RECOVERY_REQUIRED', `Unexpected transaction entry retained: ${file}`)
    }
    for (const relative of files) fs.unlinkSync(guard.assertExisting(path.join(directory, relative)))
    removeEmpty(guard, directory)
  }
  function retain(from, relative) {
    const target = path.join(directory, relative)
    if (fs.lstatSync(from).isDirectory()) for (const file of walk(from)) owned.set(path.join(target, file), sha256(readBound(guard.assertExisting(path.join(from, file)))))
    else owned.set(target, sha256(readBound(guard.assertExisting(from))))
    move(from, target)
  }
  function rollback(error) {
    try {
      for (const { from, to } of undo.reverse()) {
        if (exists(from)) fail('INSTALL_RECOVERY_REQUIRED', `Cannot restore over a new file: ${from}`)
        guard.assertExisting(to, fs.lstatSync(to).isDirectory() ? 'directory' : 'file')
        privateDirectory(path.dirname(from)); fs.renameSync(to, from)
      }
      cleanup()
    } catch (rollbackError) { fail('INSTALL_RECOVERY_REQUIRED', `${error.message}; rollback retained recovery state: ${rollbackError.message}`) }
    throw error
  }
  return { directory, put, move, retain, cleanup, rollback }
}
function removeEmpty(guard, directory) {
  if (!exists(directory)) return
  guard.assertExisting(directory, 'directory')
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) if (entry.isDirectory()) removeEmpty(guard, path.join(directory, entry.name))
  if (!fs.readdirSync(directory).length) fs.rmdirSync(directory)
}
function install(provider, root, sourceRoot = ROOT) {
  providerCheck(provider); root = absoluteRoot(root)
  // Validate source before creating installation state.
  const receipt = sourceInventory(provider, sourceRoot)
  privateDirectory(root)
  const guard = new RootGuard(root)
  const lease = acquire(root, `install-${provider}-v2`, { guard })
  try {
    const existing = exists(path.join(root, receiptName(provider))) ? verify(provider, root) : null
    if (existing?.payloadDigest === receipt.payloadDigest) {
      // A prior migration may have quarantined Prime's package while leaving
      // its registration. Repair that recognized state even without an update.
      const repair = primeMigration.plan(provider, root, [], LEGACY[provider])
      if (!repair) return existing
      assertNoResumableActivation(provider, root)
      const tx = transaction(root, provider)
      let legacySettingsBackup
      try { legacySettingsBackup = primeMigration.apply(repair, tx) }
      catch (error) { tx.rollback(error) }
      tx.cleanup()
      return { ...existing, legacySettingsBackup }
    }
    assertNoResumableActivation(provider, root)
    const migration = migrationPlan(provider, root, existing)
    const legacySettings = primeMigration.plan(provider, root, migration, LEGACY[provider])
    const publicPayload = publicFiles(provider, root)
    for (const relative of Object.keys(publicPayload)) {
      const file = path.join(root, relative)
      if (exists(file) && !existing && !migration.some(item => item.file === file)) fail('INSTALL_CONFLICT', `Unowned launcher target: ${file}`)
    }
    const bundle = bundlePath(root, receipt)
    if (exists(bundle)) fail('INSTALL_CONFLICT', 'An unregistered bundle already exists')
    const tx = transaction(root, provider)
    let result
    let legacySettingsBackup
    try {
      for (const [file, hash] of Object.entries(receipt.files)) {
        const bytes = readBound(sourcePath(sourceRoot, file))
        if (sha256(bytes) !== hash) fail('PAYLOAD_INVALID', 'Source changed during installation')
        const staged = tx.put(`bundle/${file}`, bytes)
        setPackagedMode(file, staged)
      }
      tx.put('bundle/package.json', bundleMetadata(provider))
      const stagedReceipt = tx.put('receipt.json', `${JSON.stringify(receipt, null, 2)}\n`)
      for (const [relative, bytes] of Object.entries(publicPayload)) tx.put(`public/${relative}`, bytes)
      legacySettingsBackup = primeMigration.apply(legacySettings, tx)
      for (const item of migration) {
        if (sha256(readBound(guard.assertExisting(item.file))) !== item.hash) fail('INSTALL_CONFLICT', 'Legacy file changed during migration')
        tx.move(item.file, item.destination)
      }
      tx.move(path.join(tx.directory, 'bundle'), bundle)
      for (const relative of Object.keys(publicPayload)) {
        const destination = path.join(root, relative)
        if (existing) tx.retain(destination, `previous-public/${relative}`)
        tx.move(path.join(tx.directory, 'public', relative), destination)
      }
      if (existing) tx.retain(path.join(root, receiptName(provider)), 'previous-receipt.json')
      tx.move(stagedReceipt, path.join(root, receiptName(provider)))
      result = verify(provider, root)
      if (existing) {
        verifyBundle(provider, root, existing)
        tx.retain(existing.bundle, 'previous-bundle')
      }
    } catch (error) { tx.rollback(error) }
    tx.cleanup()
    return { ...result, migrated: migration.map(item => path.relative(root, item.file)), ...(legacySettingsBackup ? { legacySettingsBackup } : {}) }
  } finally { release(lease) }
}
function uninstall(provider, root) {
  providerCheck(provider); root = absoluteRoot(root)
  if (!exists(root)) return { status: 'not-installed', provider, root }
  privateSourceDirectory(root)
  if (!exists(path.join(root, receiptName(provider)))) return { status: 'not-installed', provider, root }
  const lease = acquire(root, `uninstall-${provider}-v2`)
  try {
    const installed = verify(provider, root)
    assertNoResumableActivation(provider, root)
    const tx = transaction(root, provider)
    try {
      tx.retain(installed.bundle, 'bundle')
      for (const relative of Object.keys(publicFiles(provider, root))) tx.retain(path.join(root, relative), `public/${relative}`)
      tx.retain(path.join(root, receiptName(provider)), 'receipt.json')
    } catch (error) { tx.rollback(error) }
    tx.cleanup()
    // Leave custom content, provider config, quarantined v1 bytes and run history intact.
    return { status: 'uninstalled', provider, root, runHistoryRetained: true, legacyQuarantineRetained: true }
  } finally { release(lease) }
}
// Payload integrity and activation readiness are different checks. This probe
// uses the same exact native identity and admission precedence as activation,
// but never creates an activation, runs a canary, or contacts a model.
function doctorPrerequisites(provider, root, options = {}) {
  const installed = verify(provider, root)
  const result = { ...installed, payload: 'verified', detected: false, activation: 'unavailable', reason: 'activation-prerequisites-unavailable' }
  try {
    const native = require('./harness-v2-native.cjs')
    const admission = require('./harness-v2-admission.cjs')
    const executable = native.probeExecutable({ provider, env: options.env || process.env, executable: options.executable })
    result.detected = true; result.nativeVersion = executable.version
    if (native.descriptor(provider).blockers.length) fail('PROVIDER_UNSUPPORTED', `${provider} has unresolved native capabilities`)
    const imported = require('./harness-v2-configure.cjs').importedAdmission(root, provider)
    let pending = null
    try { admission.verifyAdmission(provider, installed, executable, imported || {}) }
    catch (error) {
      if (imported) throw error
      const evidence = JSON.parse(readBound(path.join(installed.bundle, admission.EVIDENCE)))
      const ring = JSON.parse(readBound(path.join(installed.bundle, admission.KEY_RING)))
      if (ring.schemaVersion !== 'harness-v2-trusted-keys.v1' || !Array.isArray(ring.keys) ||
          evidence.schemaVersion !== 'harness-v2-live-conformance.v1' || !Array.isArray(evidence.records) ||
          evidence.records.some(record => record?.provider === provider)) throw error
      pending = admission.reviewedLocalPending(provider, installed, executable, { now: options.now })
      if (!pending) throw error
    }
    require('./harness-v2-tool-boundary.cjs').assertCommandSandboxPrerequisites({ env: options.env || process.env })
    return { ...result, activation: pending ? 'local-canary-required' : 'static-ready;dynamic-preflight-required', reason: '-', nativeVersion: executable.version }
  } catch (error) {
    return { ...result, reason: String(error.code || 'RUNTIME_FAILURE').toLowerCase().replaceAll('_', '-'), message: error.message }
  }
}
function run(argv = process.argv.slice(2), options = {}) {
  const [action, provider, flag, value] = argv
  if (!['install', 'verify', 'doctor', 'uninstall', 'plan'].includes(action) || !PROVIDERS.includes(provider) ||
      (argv.length !== 2 && (argv.length !== 4 || flag !== '--root' || !path.isAbsolute(value || '')))) fail('INVALID_INPUT', 'Use harness-v2-package.cjs <install|verify|doctor|uninstall|plan> PROVIDER [--root ABSOLUTE]')
  const root = value ? absoluteRoot(value) : resolveRoot(provider, options.env)
  if (action === 'plan') return { status: 'planned', root, launcher: launcherPath(provider, root), ...sourceInventory(provider, options.sourceRoot) }
  if (action === 'install') return install(provider, root, options.sourceRoot)
  if (action === 'uninstall') return uninstall(provider, root)
  if (action === 'doctor') return doctorPrerequisites(provider, root, options)
  return verify(provider, root)
}
if (require.main === module) {
  try { const result = run(); process.stdout.write(`${JSON.stringify({ status: result.status, provider: result.provider, root: result.root, bundle: result.bundle, launcher: result.launcher, payloadGeneration: result.payloadGeneration, legacySettingsBackup: result.legacySettingsBackup, payload: result.payload, detected: result.detected, activation: result.activation, reason: result.reason, message: result.message, nativeVersion: result.nativeVersion })}\n`); if (result.activation === 'unavailable') process.exitCode = 1 }
  catch (error) { process.stderr.write(`${error.code || 'RUNTIME_FAILURE'}: ${error.message}\n`); process.exitCode = 1 }
}
module.exports = { PROVIDERS, ROOT, PackageError, CONFORMANCE_ASSETS, rootCandidate, resolveRoot, receiptName, launcherPath, launcherRelative, launcher, publicFiles, bundlePath, sourceInventory, readReceipt, install, verify, doctor: doctorPrerequisites, doctorPrerequisites, uninstall, run, walk, assertNoResumableActivation }
