'use strict'
// Executes only receipt-bound, named actual-native cases.  Cases sharing a
// source run once as an anchored TAP selection, then each exact named result
// is checked and committed to its own immutable observation artifact.  A TAP
// aggregate therefore cannot stand in for a capability result.
const cp = require('node:child_process'), crypto = require('node:crypto'), fs = require('node:fs'), path = require('node:path')
const { StringDecoder } = require('node:string_decoder')
const { ProcessOwner, createPlatformProcessAdapter, prepareProcessLaunchEnvironment } = require('../agents/codex/workflow/process-owner.js')
const { auditPrivatePermissions, ensureWindowsPrivateAcl, inspectPathNoFollow, createWindowsCompilerDirectory, windowsControllerEnvironment } = require('../agents/codex/workflow/safe-run-root.js')
const { atomicCreateJson, checksumRecord } = require('../agents/codex/workflow/event-log.js')
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const keys = Object.freeze({ claude:'AUTOPROMPT_CLAUDE_TEST_CLI',opencode:'AUTOPROMPT_OPENCODE_TEST_CLI',kilo:'AUTOPROMPT_KILO_TEST_CLI',prime:'AUTOPROMPT_PRIME_TEST_CLI',omp:'AUTOPROMPT_OMP_TEST_CLI',deepseek:'AUTOPROMPT_DEEPSEEK_TEST_CLI',vscode:'AUTOPROMPT_VSCODE_TEST_CLI',hermes:'AUTOPROMPT_HERMES_TEST_CLI',grok:'AUTOPROMPT_GROK_TEST_CLI',reasonix:'AUTOPROMPT_REASONIX_TEST_CLI' })
function fail(code, message) { const error = new Error(message); error.code = code; throw error }
function regular(file) { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) fail('LOCAL_CANARY_INVALID', 'canary artifact is not regular'); return fs.readFileSync(file) }
function boundedRegular(file, maximum, expectedIdentity, fsImpl = fs) {
  const before = fsImpl.lstatSync(file, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > maximum) fail('LOCAL_CANARY_INVALID', 'bounded canary artifact is invalid')
  const handle = fsImpl.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  try {
    const opened = fsImpl.fstatSync(handle, { bigint: true })
    if (!opened.isFile() || opened.nlink !== 1n || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > maximum) {
      fail('LOCAL_CANARY_INVALID', 'bounded canary artifact changed while opening')
    }
    if (expectedIdentity && !sameIdentity(opened, expectedIdentity)) fail('LOCAL_CANARY_INVALID', 'bounded canary artifact differs from its captured identity')
    const output = Buffer.alloc(maximum + 1)
    let offset = 0
    while (offset < output.length) {
      const count = fsImpl.readSync(handle, output, offset, output.length - offset, null)
      if (!count) break
      offset += count
    }
    if (offset > maximum) fail('LOCAL_CANARY_INVALID', 'bounded canary artifact exceeds its limit')
    const named = fsImpl.lstatSync(file, { bigint: true })
    if (named.isSymbolicLink() || !sameIdentity(named, opened) || named.nlink !== 1n) fail('LOCAL_CANARY_INVALID', 'bounded canary artifact was replaced during reading')
    return output.subarray(0, offset)
  } finally { fsImpl.closeSync(handle) }
}
function closedEnvironment(input = {}, provider, root, options = {}) {
  const windows = (options.platform || process.platform) === 'win32'
  if (windows) input = require('../agents/codex/workflow/process-owner.js').normalizeWindowsChildEnvironment(input)
  const env = {}
  for (const key of ['PATH',windows ? 'SYSTEMROOT' : 'SystemRoot','WINDIR','COMSPEC','PATHEXT','LANG','LC_ALL','TZ','TERM','SSL_CERT_FILE','SSL_CERT_DIR','NODE_EXTRA_CA_CERTS',...(windows ? ['AUTOPROMPT_WINDOWS_BASH'] : [])]) {
    if (typeof input[key] === 'string') env[key] = input[key]
  }
  if (typeof root === 'string') {
    let layout
    if (options.windowsShortEnvironment !== undefined) {
      if (!windows || provider !== 'opencode' || !options.windowsShortEnvironment || typeof options.windowsShortEnvironment !== 'object' ||
          !options.windowsShortEnvironment.record || typeof options.windowsShortEnvironment.root !== 'string') {
        fail('LOCAL_CANARY_INVALID', 'Windows short canary environment projection is invalid')
      }
      const record = exactShortEnvRecord(options.windowsShortEnvironment.record)
      if (!samePrivatePath(record.root, options.windowsShortEnvironment.root, 'win32')) fail('LOCAL_CANARY_INVALID', 'Windows short canary environment root differs from its record')
      layout = shortEnvironmentLayout(record.root)
    } else {
      const home = path.join(root, 'outer-home'), temporary = path.join(root, 'outer-tmp')
      layout = { root, home, temporary, config: path.join(home, 'config'), data: path.join(home, 'data'), state: path.join(home, 'state'), cache: path.join(home, 'cache') }
      for (const directory of [layout.home, layout.temporary, layout.config, layout.data, layout.state, layout.cache]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    }
    Object.assign(env, shortEnvironmentProjection(layout))
  }
  if (provider === 'vscode') {
    if (typeof input.DISPLAY === 'string' && /^:[0-9]+(?:\.[0-9]+)?$/.test(input.DISPLAY)) env.DISPLAY = input.DISPLAY
    if (typeof input.WAYLAND_DISPLAY === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(input.WAYLAND_DISPLAY)) env.WAYLAND_DISPLAY = input.WAYLAND_DISPLAY
    for (const key of ['XAUTHORITY', 'XDG_RUNTIME_DIR']) if (typeof input[key] === 'string' && path.isAbsolute(input[key])) {
      try { const stat = fs.lstatSync(input[key]); if (!stat.isSymbolicLink() && (key === 'XAUTHORITY' ? stat.isFile() : stat.isDirectory())) env[key] = input[key] } catch {}
    }
  }
  return env
}
function tapCases(output, cases) {
  const expected = new Map(cases.map(item => [item.testName, { count: 0, failed: false, skipped: false }]))
  for (const line of output.split(/\r?\n/)) {
    const match = /^(not )?ok \d+ - (.*?)(?:\s+#\s*(SKIP|TODO)\b.*)?$/.exec(line)
    if (!match || !expected.has(match[2])) continue
    const current = expected.get(match[2]); current.count += 1
    current.failed ||= Boolean(match[1]); current.skipped ||= Boolean(match[3])
  }
  for (const [name, result] of expected) {
    if (result.count !== 1 || result.failed || result.skipped) fail('LOCAL_CANARY_FAILED', `native TAP result is incomplete for ${name}`)
  }
}
function writeAtomic(file, value) { const temp = `${file}.${crypto.randomUUID()}`; fs.writeFileSync(temp, value, { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, file) }
const WINDOWS_OPENCODE_SHORT_ENV_RECORD = 'windows-opencode-short-env.json'
const WINDOWS_OPENCODE_SHORT_ENV_SCHEMA = 'harness-v2-windows-opencode-short-env.v1'
const WINDOWS_OPENCODE_SHORT_ENV_PREFIX = 'ap-canary-'
const SHORT_ENV_CHILDREN = ['home', 'temporary', 'config', 'data', 'state', 'cache']
function sameIdentity(left, right) { return Boolean(left && right && String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino)) }
function samePrivatePath(left, right, platform) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const normalizedLeft = path.resolve(left), normalizedRight = path.resolve(right)
  return platform === 'win32' ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase() : normalizedLeft === normalizedRight
}
function capturedShortEnvIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !/^(?:0|[1-9][0-9]*)$/u.test(String(value.dev)) || !/^(?:0|[1-9][0-9]*)$/u.test(String(value.ino))) {
    fail('LOCAL_CANARY_INVALID', 'Windows OpenCode short environment identity is invalid')
  }
  return { dev: String(value.dev), ino: String(value.ino) }
}
function storedShortEnvIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'dev,ino') {
    fail('LOCAL_CANARY_INVALID', 'Windows OpenCode short environment stored identity is invalid')
  }
  return capturedShortEnvIdentity(value)
}
function exactShortEnvRecord(value) {
  const expected = ['activationId','bindingSha256','challenge','checksum','children','generation','identity','journalRoot','journalRootIdentity','parent','parentIdentity','provider','root','schemaVersion']
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== expected.join(',') ||
      value.schemaVersion !== WINDOWS_OPENCODE_SHORT_ENV_SCHEMA || value.provider !== 'opencode' ||
      typeof value.activationId !== 'string' || !value.activationId || value.activationId.length > 256 ||
      !Number.isSafeInteger(value.generation) || value.generation < 1 || !/^[A-Za-z0-9_-]{43}$/u.test(value.challenge || '') ||
      typeof value.root !== 'string' || !path.isAbsolute(value.root) || typeof value.parent !== 'string' || !path.isAbsolute(value.parent) ||
      typeof value.journalRoot !== 'string' || !path.isAbsolute(value.journalRoot) ||
      !value.children || typeof value.children !== 'object' || Object.keys(value.children).sort().join(',') !== [...SHORT_ENV_CHILDREN].sort().join(',') ||
      !/^[a-f0-9]{64}$/u.test(value.bindingSha256 || '')) {
    fail('LOCAL_CANARY_INVALID', 'Windows OpenCode short environment record is invalid')
  }
  const identity = storedShortEnvIdentity(value.identity), parentIdentity = storedShortEnvIdentity(value.parentIdentity)
  const journalRootIdentity = storedShortEnvIdentity(value.journalRootIdentity)
  const children = Object.fromEntries(SHORT_ENV_CHILDREN.map(name => [name, storedShortEnvIdentity(value.children[name])]))
  const body = { schemaVersion: value.schemaVersion, provider: value.provider, activationId: value.activationId, generation: value.generation,
    challenge: value.challenge, root: value.root, identity, parent: value.parent, parentIdentity,
    journalRoot: value.journalRoot, journalRootIdentity, children }
  if (hash(JSON.stringify(body)) !== value.bindingSha256 || checksumRecord(value) !== value.checksum) fail('LOCAL_CANARY_INVALID', 'Windows OpenCode short environment record checksum differs')
  return Object.freeze({ ...body, bindingSha256: value.bindingSha256, checksum: value.checksum })
}
function shortEnvironmentLayout(root) {
  const home = path.join(root, 'home'), temporary = path.join(root, 'tmp')
  return Object.freeze({ root, home, temporary, config: path.join(home, 'config'), data: path.join(home, 'data'), state: path.join(home, 'state'), cache: path.join(home, 'cache') })
}
function shortEnvironmentProjection(layout) {
  return Object.freeze({ HOME: layout.home, USERPROFILE: layout.home, XDG_CONFIG_HOME: layout.config, XDG_DATA_HOME: layout.data,
    XDG_STATE_HOME: layout.state, XDG_CACHE_HOME: layout.cache, TMPDIR: layout.temporary, TMP: layout.temporary, TEMP: layout.temporary })
}
function reopenWindowsOpenCodeShortEnvironmentRecord(descriptor, options = {}) {
  if (!descriptor || typeof descriptor !== 'object' || typeof descriptor.recordPath !== 'string' || !path.isAbsolute(descriptor.recordPath) ||
      typeof descriptor.journalRoot !== 'string' || !path.isAbsolute(descriptor.journalRoot) ||
      path.resolve(descriptor.recordPath) !== path.join(path.resolve(descriptor.journalRoot), WINDOWS_OPENCODE_SHORT_ENV_RECORD)) {
    fail('LOCAL_CANARY_INVALID', 'Windows OpenCode short environment journal location is invalid')
  }
  const inspect = options.inspectPathNoFollow || inspectPathNoFollow, fsImpl = options.fsImpl || fs
  const expected = exactShortEnvRecord(descriptor.record || descriptor)
  const journalRoot = inspect(descriptor.journalRoot, { fsImpl }), journal = inspect(descriptor.recordPath, { fsImpl, mustBeDirectory: false })
  if (!journalRoot.exists || !samePrivatePath(journalRoot.realpath, expected.journalRoot, options.platform || process.platform) ||
      !sameIdentity(journalRoot.identity, expected.journalRootIdentity) || !journal.exists || !journal.realpath) fail('LOCAL_CANARY_INVALID', 'Windows OpenCode short environment journal parent changed or is absent')
  if (!journal.identity) fail('LOCAL_CANARY_INVALID', 'Windows OpenCode short environment journal identity is absent')
  const journalIdentity = capturedShortEnvIdentity(journal.identity)
  if (descriptor.journalIdentity && !sameIdentity(journalIdentity, descriptor.journalIdentity)) fail('LOCAL_CANARY_INVALID', 'Windows OpenCode short environment journal was replaced')
  let actual
  try { actual = exactShortEnvRecord(JSON.parse(boundedRegular(descriptor.recordPath, 4096, journalIdentity, fsImpl))) }
  catch (error) { if (error?.code) throw error; fail('LOCAL_CANARY_INVALID', 'Windows OpenCode short environment journal is unreadable') }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail('LOCAL_CANARY_INVALID', 'Windows OpenCode short environment journal changed')
  const parentAfter = inspect(descriptor.journalRoot, { fsImpl })
  if (!parentAfter.exists || !sameIdentity(parentAfter.identity, expected.journalRootIdentity)) fail('LOCAL_CANARY_INVALID', 'Windows OpenCode short environment journal parent changed during reading')
  return { record: actual, journalIdentity }
}
function validateWindowsOpenCodeShortEnvironment(descriptor, options = {}) {
  const platform = options.platform || process.platform, fsImpl = options.fsImpl || fs
  if (platform !== 'win32') fail('LOCAL_CANARY_INVALID', 'Windows OpenCode short environment was selected off Windows')
  const reopened = reopenWindowsOpenCodeShortEnvironmentRecord(descriptor, options)
  const record = reopened.record
  const inspect = options.inspectPathNoFollow || inspectPathNoFollow
  const controllerEnvironment = options.windowsControllerEnvironment || windowsControllerEnvironment
  const root = inspect(record.root, { fsImpl }), parent = inspect(record.parent, { fsImpl })
  const systemRoot = options.systemRoot || process.env.SystemRoot || process.env.WINDIR
  const controller = controllerEnvironment(systemRoot)
  const local = inspect(controller.LOCALAPPDATA, { fsImpl })
  if (!root.exists || !root.realpath || !samePrivatePath(root.realpath, record.root, platform) || !sameIdentity(root.identity, record.identity) ||
      !parent.exists || !parent.realpath || !samePrivatePath(parent.realpath, record.parent, platform) || !sameIdentity(parent.identity, record.parentIdentity) ||
      !local.exists || !local.realpath || !samePrivatePath(parent.realpath, local.realpath, platform) || !sameIdentity(parent.identity, local.identity) ||
      !samePrivatePath(path.dirname(root.realpath), parent.realpath, platform) || !new RegExp(`^${WINDOWS_OPENCODE_SHORT_ENV_PREFIX}[A-Za-z0-9]{6}$`).test(path.basename(root.realpath))) {
    fail('LOCAL_CANARY_INVALID', 'Windows OpenCode short environment physical binding changed')
  }
  const audit = options.auditPrivatePermissions || auditPrivatePermissions
  audit(root.realpath, { recurse: false })
  const layout = shortEnvironmentLayout(root.realpath)
  for (const name of SHORT_ENV_CHILDREN) {
    const child = inspect(layout[name], { fsImpl })
    if (!child.exists || !samePrivatePath(child.realpath, layout[name], platform) || !sameIdentity(child.identity, record.children[name])) {
      fail('LOCAL_CANARY_INVALID', 'Windows OpenCode short environment projected directory changed')
    }
  }
  return Object.freeze({ record, recordPath: descriptor.recordPath, journalRoot: descriptor.journalRoot, journalIdentity: reopened.journalIdentity, ...shortEnvironmentLayout(root.realpath) })
}
function removeShortEnvOwnedTarget(target, parentIdentity, targetIdentity, type, options) {
  const native = options.windowsFilesystem || require('../agents/codex/workflow/windows-filesystem.js').createWindowsFilesystemCapture()
  // The native helper holds the parent and complete bounded subtree, verifies
  // the captured identities, and deletes by HANDLE. A replaced path is refused.
  return native.removeOwnedTarget(target, parentIdentity, { type, ...targetIdentity })
}
async function removeWindowsOpenCodeShortEnvironment(descriptor, options = {}) {
  const fsImpl = options.fsImpl || fs
  const verified = validateWindowsOpenCodeShortEnvironment(descriptor, options)
  try { await removeShortEnvOwnedTarget(verified.root, verified.record.parentIdentity, verified.record.identity, 'directory', options) }
  catch (error) { fail('LOCAL_CANARY_CLEANUP_UNCERTAIN', `Windows OpenCode short environment could not be removed: ${error.code || 'failure'}`) }
  const inspect = options.inspectPathNoFollow || inspectPathNoFollow
  let remaining
  try { remaining = inspect(verified.root, { fsImpl }) } catch { fail('LOCAL_CANARY_CLEANUP_UNCERTAIN', 'Windows OpenCode short environment changed during removal') }
  if (remaining.exists) fail('LOCAL_CANARY_CLEANUP_UNCERTAIN', 'Windows OpenCode short environment remained after removal')
  // Reopen the exact journal after the external tree is absent so an attacker
  // cannot replace it between its first validation and unlink.
  const journalBeforeUnlink = reopenWindowsOpenCodeShortEnvironmentRecord(verified, options)
  if (!sameIdentity(journalBeforeUnlink.journalIdentity, verified.journalIdentity)) fail('LOCAL_CANARY_CLEANUP_UNCERTAIN', 'Windows OpenCode short environment journal changed before removal')
  try { await removeShortEnvOwnedTarget(verified.recordPath, verified.record.journalRootIdentity, verified.journalIdentity, 'file', options) }
  catch (error) { fail('LOCAL_CANARY_CLEANUP_UNCERTAIN', `Windows OpenCode short environment record could not be removed: ${error.code || 'failure'}`) }
  let journal
  try { journal = inspect(verified.recordPath, { fsImpl, mustBeDirectory: false }) } catch { fail('LOCAL_CANARY_CLEANUP_UNCERTAIN', 'Windows OpenCode short environment record changed during removal') }
  if (journal.exists) fail('LOCAL_CANARY_CLEANUP_UNCERTAIN', 'Windows OpenCode short environment record remained after removal')
}
async function stageWindowsOpenCodeShortEnvironment(input = {}, options = {}) {
  const platform = options.platform || process.platform, fsImpl = options.fsImpl || fs
  if (platform !== 'win32' || input.provider !== 'opencode') return null
  if (!input || typeof input !== 'object' || typeof input.root !== 'string' || !path.isAbsolute(input.root) ||
      typeof input.activationId !== 'string' || !input.activationId || !Number.isSafeInteger(input.generation) || input.generation < 1 ||
      !/^[A-Za-z0-9_-]{43}$/u.test(input.challenge || '')) fail('LOCAL_CANARY_INVALID', 'Windows OpenCode short environment input is invalid')
  const recordPath = path.join(input.root, WINDOWS_OPENCODE_SHORT_ENV_RECORD)
  const create = options.createWindowsCompilerDirectory || createWindowsCompilerDirectory
  const inspect = options.inspectPathNoFollow || inspectPathNoFollow
  const controllerEnvironment = options.windowsControllerEnvironment || windowsControllerEnvironment
  const audit = options.auditPrivatePermissions || auditPrivatePermissions
  const systemRoot = options.systemRoot || process.env.SystemRoot || process.env.WINDIR
  const journalRoot = inspect(input.root, { fsImpl })
  if (!journalRoot.exists || !samePrivatePath(journalRoot.realpath, input.root, platform)) fail('LOCAL_CANARY_INVALID', 'Windows OpenCode short environment journal parent is invalid')
  if (inspect(recordPath, { fsImpl, mustBeDirectory: false }).exists) fail('LOCAL_CANARY_INVALID', 'Windows OpenCode short environment record already exists')
  let created = null, createdBinding = null, published = false
  try {
    created = create(WINDOWS_OPENCODE_SHORT_ENV_PREFIX)
    const root = inspect(created, { fsImpl }), parent = inspect(path.dirname(created), { fsImpl })
    createdBinding = { root: root.realpath, identity: root.identity ? capturedShortEnvIdentity(root.identity) : null, parent: parent.realpath, parentIdentity: parent.identity ? capturedShortEnvIdentity(parent.identity) : null }
    const controller = controllerEnvironment(systemRoot), local = inspect(controller.LOCALAPPDATA, { fsImpl })
    if (!root.exists || !root.realpath || !root.identity || !parent.exists || !parent.realpath || !parent.identity || !local.exists || !local.realpath || !local.identity ||
        !samePrivatePath(parent.realpath, local.realpath, platform) || !sameIdentity(parent.identity, local.identity) ||
        !samePrivatePath(path.dirname(root.realpath), parent.realpath, platform) || !new RegExp(`^${WINDOWS_OPENCODE_SHORT_ENV_PREFIX}[A-Za-z0-9]{6}$`).test(path.basename(root.realpath))) {
      fail('LOCAL_CANARY_INVALID', 'Windows OpenCode short environment is outside the authenticated token profile')
    }
    audit(root.realpath, { recurse: false })
    const layout = shortEnvironmentLayout(root.realpath)
    for (const directory of [layout.home, layout.temporary, layout.config, layout.data, layout.state, layout.cache]) fsImpl.mkdirSync(directory, { recursive: true, mode: 0o700 })
    const children = Object.fromEntries(SHORT_ENV_CHILDREN.map(name => {
      const child = inspect(layout[name], { fsImpl })
      if (!child.exists || !samePrivatePath(child.realpath, layout[name], platform)) fail('LOCAL_CANARY_INVALID', 'Windows OpenCode short environment child is not physical')
      return [name, capturedShortEnvIdentity(child.identity)]
    }))
    const currentRoot = inspect(root.realpath, { fsImpl }), currentJournalRoot = inspect(journalRoot.realpath, { fsImpl })
    if (!currentRoot.exists || !sameIdentity(currentRoot.identity, root.identity) || !currentJournalRoot.exists || !sameIdentity(currentJournalRoot.identity, journalRoot.identity)) {
      fail('LOCAL_CANARY_INVALID', 'Windows OpenCode short environment allocation changed before publication')
    }
    const body = { schemaVersion: WINDOWS_OPENCODE_SHORT_ENV_SCHEMA, provider: 'opencode', activationId: input.activationId,
      generation: input.generation, challenge: input.challenge, root: root.realpath, identity: capturedShortEnvIdentity(root.identity),
      parent: parent.realpath, parentIdentity: capturedShortEnvIdentity(parent.identity),
      journalRoot: journalRoot.realpath, journalRootIdentity: capturedShortEnvIdentity(journalRoot.identity), children }
    const unsigned = { ...body, bindingSha256: hash(JSON.stringify(body)) }
    // Any failure after this point can follow a durable exclusive link. Retain
    // the external root and its journal rather than guessing whether publish won.
    published = true
    const record = exactShortEnvRecord(atomicCreateJson(recordPath, unsigned, { fsImpl, mode: 0o600 }))
    const journal = inspect(recordPath, { fsImpl, mustBeDirectory: false })
    if (!journal.exists || !journal.identity) fail('LOCAL_CANARY_INVALID', 'Windows OpenCode short environment journal disappeared after publication')
    return validateWindowsOpenCodeShortEnvironment(Object.freeze({ record, recordPath, journalRoot: input.root, journalIdentity: capturedShortEnvIdentity(journal.identity), ...layout }), options)
  } catch (error) {
    if (!published && createdBinding) {
      try {
        const root = inspect(createdBinding.root, { fsImpl }), parent = inspect(createdBinding.parent, { fsImpl })
        if (!root.exists || !root.realpath || !sameIdentity(root.identity, createdBinding.identity) || !parent.exists || !sameIdentity(parent.identity, createdBinding.parentIdentity)) {
          throw new Error('short environment changed before setup cleanup')
        }
        await removeShortEnvOwnedTarget(root.realpath, createdBinding.parentIdentity, createdBinding.identity, 'directory', options)
        const remaining = inspect(root.realpath, { fsImpl })
        if (remaining.exists) throw new Error('short environment remained after setup cleanup')
      } catch (cleanup) {
        error.cleanupConfirmed = false
        error.retainedShortEnvironment = created
        error.cleanupCode = String(cleanup.code || 'LOCAL_CANARY_CLEANUP_UNCERTAIN').slice(0, 64)
      }
    }
    if (created && (published || !createdBinding)) {
      error.cleanupConfirmed = false
      error.retainedShortEnvironment = created
      error.retainedShortEnvironmentRecord = recordPath
    }
    throw error
  }
}
function claimPrivateCanaryDirectory(directory, options = {}) {
  const fsImpl = options.fsImpl || fs
  let created = false
  try {
    fsImpl.mkdirSync(directory, { mode: 0o700 })
    created = true
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    if (options.allowExisting !== true) throw error
    const inspect = options.inspectPathNoFollow || inspectPathNoFollow
    const inspected = inspect(directory, { fsImpl })
    if (!inspected.exists) throw Object.assign(new Error(`Private canary directory disappeared during validation: ${directory}`), { code: 'RUN_RECORD_UNSAFE' })
    const audit = options.auditPrivatePermissions || auditPrivatePermissions
    audit(directory, { recurse: false })
  }
  if (created && (options.platform || process.platform) === 'win32') {
    const establish = options.ensureWindowsPrivateAcl || ensureWindowsPrivateAcl
    try { establish(directory) }
    catch (error) {
      try { fsImpl.rmdirSync(directory) } catch {}
      throw error
    }
  }
  return directory
}
function closedCanaryBatchTimeout(options = {}) {
  const { platform = process.platform, caseCount, approvalRemainingMs, activationRemainingMs } = options
  if (!Number.isSafeInteger(caseCount) || caseCount < 1 ||
      !Number.isFinite(approvalRemainingMs) || !Number.isFinite(activationRemainingMs)) {
    fail('LOCAL_CANARY_INVALID', 'closed canary batch timeout inputs are invalid')
  }
  // Windows starts a fresh owned Job for every sequential case. Keep the
  // shared execution budget and add only one bounded startup allowance per
  // case; review and activation authority remain the absolute deadlines.
  const workloadCeiling = platform === 'win32' ? 720000 + caseCount * 120000 : 720000
  if (!Number.isSafeInteger(workloadCeiling)) fail('LOCAL_CANARY_INVALID', 'closed canary batch workload is too large')
  return Math.min(workloadCeiling, approvalRemainingMs, activationRemainingMs)
}
function closedCanaryProcessAdapter(options = {}) {
  const { platform = process.platform, controlRoot, providerPrivateOwnershipRoot, trustedOwnershipRoots, createPlatformAdapter } = options
  if (!path.isAbsolute(controlRoot || '') || !path.isAbsolute(providerPrivateOwnershipRoot || '') ||
      !Array.isArray(trustedOwnershipRoots) || trustedOwnershipRoots.length < 1 || trustedOwnershipRoots.some(root => !path.isAbsolute(root || ''))) {
    fail('LOCAL_CANARY_INVALID', 'closed canary process ownership roots are invalid')
  }
  const factory = createPlatformAdapter || createPlatformProcessAdapter
  if (typeof factory !== 'function') fail('LOCAL_CANARY_INVALID', 'closed canary process adapter factory is invalid')
  return factory({ platform,
    ...(platform === 'win32' ? { windows: { controlRoot, providerPrivateOwnershipRoot, trustedOwnershipRoots } } : {}),
    ...(platform === 'darwin' ? { darwin: { controlRoot, providerPrivateOwnershipRoot } } : {}),
  })
}
async function drainRegistered(root, binding, options = {}) {
  if (!fs.existsSync(root)) return
  let failure = null
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    // Darwin command-owner pointers have their own authenticated schema and
    // drain path. They are never legacy nested ProcessOwner registrations.
    if (entry.name === 'darwin-command-discovery-v1' && entry.isDirectory() && !entry.isSymbolicLink()) continue
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    const directory = path.join(root, entry.name), metaPath = path.join(directory, 'registration.json'), registryPath = path.join(directory, 'processes.json')
    let meta
    try { meta = JSON.parse(regular(metaPath)) } catch { failure ||= Object.assign(new Error('nested ownership registration is invalid'), { code: 'LOCAL_CANARY_INVALID' }); continue }
    if (!meta || meta.schemaVersion !== 1 || meta.provider !== binding.provider || meta.activationId !== binding.activationId ||
        meta.generation !== binding.generation || meta.challenge !== binding.challenge || meta.registryPath !== registryPath ||
        !path.resolve(registryPath).startsWith(`${path.resolve(root)}${path.sep}`)) { failure ||= Object.assign(new Error('nested ownership registration differs from this canary'), { code: 'LOCAL_CANARY_INVALID' }); continue }
    if (!fs.existsSync(registryPath)) continue
    try {
      const adapter = closedCanaryProcessAdapter({ platform: options.platform || process.platform,
        controlRoot: path.join(directory, 'process-control'), providerPrivateOwnershipRoot: options.providerPrivateOwnershipRoot || root,
        trustedOwnershipRoots: options.trustedOwnershipRoots || [options.providerPrivateOwnershipRoot || root], createPlatformAdapter: options.createPlatformAdapter })
      const owner = new ProcessOwner({ adapter, registryPath, pollMs: 20 })
      await owner.cancelAll({ reason: 'closed canary nested recovery', graceMs: 500, killMs: 2000, waitForPending: true })
      if (owner.ownershipIdentities().length) throw Object.assign(new Error('nested canary ownership did not drain'), { code: 'PROCESS_DRAIN_TIMEOUT' })
    } catch (error) { failure ||= error }
  }
  if (failure) throw failure
}
async function drainDarwinCommandDiscovery(ownershipRoot, binding, options = {}) {
  if ((options.platform || process.platform) !== 'darwin') return { discovered: 0 }
  if (!path.isAbsolute(ownershipRoot || '') || !binding || typeof binding.provider !== 'string' ||
      typeof binding.activationId !== 'string' || !Number.isSafeInteger(binding.generation) || binding.generation < 1 ||
      typeof binding.challenge !== 'string') {
    fail('LOCAL_CANARY_INVALID', 'Darwin command recovery binding is invalid')
  }
  return require('./harness-v2-command-owner-discovery.cjs').drainCanaryDiscovery(ownershipRoot, {
    provider: binding.provider, activationId: binding.activationId, generation: binding.generation,
  }, binding.challenge, { platform: options.platform, createPlatformAdapter: options.createPlatformAdapter })
}

async function ownedTest(owner, root, env, argv, timeoutMs = 300000, signal, options = {}) {
  const postStatusDelayMs = options.postStatusDelayMs === undefined ? 0 : options.postStatusDelayMs
  const failFastTap = options.failFastTap === true
  const wallNowMs = options.wallNowMs || Date.now
  if (!Number.isSafeInteger(postStatusDelayMs) || postStatusDelayMs < 0 || postStatusDelayMs > 5000) {
    fail('LOCAL_CANARY_INVALID', 'closed owned-test post-status delay is invalid')
  }
  const id = crypto.randomUUID(), stem = path.join(root, `outer-${id}`)
  const request = `${stem}.json`, status = `${stem}.status.json`
  const stdoutPath = `${stem}.stdout.log`, stderrPath = `${stem}.stderr.log`
  const failureMarker = `${stem}.failure.json`
  writeAtomic(request, JSON.stringify({ argv, cwd: root, env, status, stdoutPath, stderrPath, failureMarker, failFastTap, postStatusDelayMs }))
  const reservationId = `closed-canary-${id}`
  const launchEnv = prepareProcessLaunchEnvironment(owner.adapter, reservationId, env)
  const deadline = wallNowMs() + timeoutMs
  const owned = await owner.launch({ executable: process.execPath, argv: [__filename, '--closed-owned-test', request], cwd: root, env: launchEnv,
    sessionId: `closed-canary-${id}`, reservationId, targetKey: `closed-canary:${path.basename(root)}`, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', forWork: false })
  let value = null
  let emptyGroupObservations = 0
  const cleanFailedRun = async reason => {
    await owner.cancelAll({ reason, graceMs: 500, killMs: 2000, waitForPending: true })
    await drainRegistered(env.AUTOPROMPT_CLOSED_CANARY_OWNERSHIP_ROOT, { provider: env.AUTOPROMPT_CLOSED_CANARY_PROVIDER, activationId: env.AUTOPROMPT_CLOSED_CANARY_ACTIVATION_ID, generation: Number(env.AUTOPROMPT_CLOSED_CANARY_GENERATION), challenge: env.AUTOPROMPT_CLOSED_CANARY_CHALLENGE }, {
      platform: options.platform, providerPrivateOwnershipRoot: options.providerPrivateOwnershipRoot,
      trustedOwnershipRoots: options.trustedOwnershipRoots, createPlatformAdapter: options.createPlatformAdapter,
    })
  }
  while (wallNowMs() < deadline && !value) {
    if (signal?.aborted) {
      await owner.cancelAll({ reason: 'closed native canary cancelled', graceMs: 500, killMs: 2000, waitForPending: true })
      fail('CHILD_CANCELLED', 'closed native canary was cancelled')
    }
    if (failFastTap && fs.existsSync(failureMarker)) {
      let failure
      try { failure = JSON.parse(boundedRegular(failureMarker, 4096)) } catch { failure = null }
      if (!failure || failure.schemaVersion !== 1 || typeof failure.case !== 'string' || !failure.case || failure.case.length > 512 ||
          typeof failure.message !== 'string' || !failure.message || failure.message.length > 1024 || /[\r\n]/u.test(failure.case + failure.message) ||
          Object.keys(failure).sort().join(',') !== 'case,message,schemaVersion') {
        await cleanFailedRun('closed native canary emitted an invalid TAP failure marker')
        fail('LOCAL_CANARY_FAILED', 'owned native test emitted an invalid TAP failure marker')
      }
      await cleanFailedRun('closed native canary reported a failing TAP case')
      fail('LOCAL_CANARY_FAILED', `owned native test failed: ${failure.case}`)
    }
    try { value = JSON.parse(regular(status)) } catch {}
    if (!value && typeof owner.adapter?.listOwned === 'function') {
      const live = await owner.adapter.listOwned(owned.groupIdentity)
      if (signal?.aborted) {
        await owner.cancelAll({ reason: 'closed native canary cancelled', graceMs: 500, killMs: 2000, waitForPending: true })
        fail('CHILD_CANCELLED', 'closed native canary was cancelled')
      }
      if (wallNowMs() >= deadline) break
      if (Array.isArray(live) && live.length === 0) {
        emptyGroupObservations += 1
        if (emptyGroupObservations >= 2) {
          try { value = JSON.parse(regular(status)) } catch {}
          if (!value) {
            await cleanFailedRun('closed native canary launcher exited without status')
            fail('LOCAL_CANARY_FAILED', 'owned native test launcher exited before writing status')
          }
        }
      } else emptyGroupObservations = 0
    }
    if (!value) await new Promise(resolve => setTimeout(resolve, 20))
  }
  if (!value) {
    await cleanFailedRun('closed native canary timed out')
    fail('LOCAL_CANARY_TIMEOUT', 'owned native test exceeded its deadline')
  }
  // The child status is written by the owned launcher.  It is not root-exit
  // evidence by itself: the launcher can still be flushing its callback after
  // publishing the payload result.  Await the actual owned root's absence
  // before persisting rootExit, then let ProcessOwner's normal group drain
  // reconcile any real descendants.
  try {
    await owner.awaitRootExit(owned.ownershipId, Math.min(5000, Math.max(0, deadline - wallNowMs())))
    await owner.observeRootExit(owned.ownershipId, { code: value.code, signal: value.signal, terminalEnvelope: { status: value.code === 0 && !value.signal ? 'DONE' : 'FAILED' } })
  } catch (error) {
    await owner.cancelAll({ reason: 'closed native canary root completion did not drain', graceMs: 500, killMs: 2000, waitForPending: true }).catch(() => {})
    throw error
  }
  return value
}
async function finalizeClosedCanary(options = {}) {
  const cleanupFailures = []
  const { owner, env, provider, activationId, generation, challenge, platform = process.platform, shortEnvironment, primaryError } = options
  const binding = { provider, activationId, generation, challenge }
  const registered = options.drainRegistered || drainRegistered
  const darwinDiscovery = options.drainDarwinCommandDiscovery || drainDarwinCommandDiscovery
  const removeShortEnvironment = options.removeWindowsOpenCodeShortEnvironment || removeWindowsOpenCodeShortEnvironment
  if (owner) try { await owner.cancelAll({ reason: 'closed canary finished', graceMs: 500, killMs: 2000, waitForPending: true }) }
  catch (error) { cleanupFailures.push(error) }
  if (env) try { await registered(env.AUTOPROMPT_CLOSED_CANARY_OWNERSHIP_ROOT, binding, { platform, providerPrivateOwnershipRoot: options.providerPrivateOwnershipRoot, trustedOwnershipRoots: options.trustedOwnershipRoots, createPlatformAdapter: options.createPlatformAdapter }) }
  catch (error) { cleanupFailures.push(error) }
  if (env) try { await darwinDiscovery(env.AUTOPROMPT_CLOSED_CANARY_OWNERSHIP_ROOT, binding, { platform, createPlatformAdapter: options.createPlatformAdapter }) }
  catch (error) { cleanupFailures.push(error) }
  if (!cleanupFailures.length && shortEnvironment) {
    try { await removeShortEnvironment(shortEnvironment, { platform, systemRoot: options.systemRoot }) }
    catch (error) { cleanupFailures.push(error) }
  }
  if (!cleanupFailures.length) return Object.freeze({ cleanupConfirmed: true })
  const [first, ...secondary] = cleanupFailures
  if (secondary.length) first.secondaryCleanupFailures = secondary
  if (primaryError) {
    primaryError.cleanupConfirmed = false
    primaryError.cleanupFailure = first
    return Object.freeze({ cleanupConfirmed: false, failure: first })
  }
  throw first
}
async function run(options = {}) {
  const { activation, pending, executable, provider } = options
  if (!activation?.installed?.bundle || !activation?.activationRoot || !pending || !keys[provider] || executable?.path !== activation.executable?.path) fail('LOCAL_CANARY_INVALID', 'closed canary binding is incomplete')
  if (Date.parse(pending.expiresAt) <= Date.now()) fail('LOCAL_CANARY_EXPIRED', 'reviewed-local approval expired before execution')
  const generation = activation.record?.capability?.generation
  if (!Number.isSafeInteger(generation) || generation < 1) fail('LOCAL_CANARY_INVALID', 'canary generation is invalid')
  const activationDeadline = Date.parse(activation.record?.capability?.expiresAt)
  if (!Number.isFinite(activationDeadline)) fail('LOCAL_CANARY_INVALID', 'canary activation deadline is invalid')
  if (activationDeadline <= Date.now()) fail('LOCAL_CANARY_EXPIRED', 'activation expired before native canary')
  const canaryRoot = path.join(activation.activationRoot, 'reviewed-local-canary')
  const root = path.join(canaryRoot, `generation-${generation}`)
  const platform = options.platform || process.platform
  claimPrivateCanaryDirectory(canaryRoot, { platform, allowExisting: true })
  claimPrivateCanaryDirectory(root, { platform, allowExisting: true })
  const challenge = crypto.randomBytes(32).toString('base64url')
  const signal = options.signal
  let env = null, owner = null, cancel = null, abortListenerInstalled = false, shortEnvironment = null, primaryError = null
  const results = [], artifacts = []
  const groups = new Map()
  for (const capability of Object.keys(pending.capabilityCases).sort()) {
    const item = pending.capabilityCases[capability], group = groups.get(item.source) || []
    group.push({ capability, ...item }); groups.set(item.source, group)
  }
  try {
    shortEnvironment = await stageWindowsOpenCodeShortEnvironment({ provider, root, activationId: activation.activationId, generation, challenge }, {
      platform, systemRoot: process.env.SystemRoot || process.env.WINDIR,
    })
    env = { ...closedEnvironment(options.environment || process.env, provider, root, { platform, ...(shortEnvironment ? { windowsShortEnvironment: shortEnvironment } : {}) }), [keys[provider]]: executable.path,
      AUTOPROMPT_NATIVE_TEST_EVIDENCE_ROOT: path.join(root, 'native-wire'), AUTOPROMPT_CLOSED_CANARY_CHALLENGE: challenge,
      AUTOPROMPT_CLOSED_CANARY_OWNERSHIP_ROOT: path.join(root, 'nested-owners'), AUTOPROMPT_CLOSED_CANARY_PROVIDER: provider,
      AUTOPROMPT_CLOSED_CANARY_ACTIVATION_ID: activation.activationId, AUTOPROMPT_CLOSED_CANARY_GENERATION: String(generation) }
    claimPrivateCanaryDirectory(env.AUTOPROMPT_CLOSED_CANARY_OWNERSHIP_ROOT, { platform })
    const adapter = closedCanaryProcessAdapter({ platform, controlRoot: path.join(root, 'outer-process-control'),
      providerPrivateOwnershipRoot: activation.activationRoot, trustedOwnershipRoots: [activation.activationRoot], createPlatformAdapter: options.createPlatformAdapter })
    owner = new ProcessOwner({ adapter, registryPath: path.join(root, 'outer-processes.json'), pollMs: 20 })
    cancel = () => { owner.cancelAll({ reason: 'closed native canary cancelled', graceMs: 500, killMs: 2000, waitForPending: true }).catch(() => {}) }
    signal?.addEventListener('abort', cancel, { once: true }); abortListenerInstalled = Boolean(signal)
    for (const [relativeSource, cases] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      if (signal?.aborted) fail('CHILD_CANCELLED', 'closed native canary was cancelled')
      const source = path.join(activation.installed.bundle, relativeSource)
      if (!path.resolve(source).startsWith(`${path.resolve(activation.installed.bundle)}${path.sep}`)) fail('LOCAL_CANARY_INVALID', `case source escaped bundle: ${relativeSource}`)
      if (cases.some(item => item.sha256 !== hash(regular(source)))) fail('LOCAL_CANARY_INVALID', `case source drifted: ${relativeSource}`)
      const pattern = `^(?:${cases.map(item => escape(item.testName)).join('|')})$`
      const now = Date.now()
      const timeoutMs = closedCanaryBatchTimeout({ platform, caseCount: cases.length,
        approvalRemainingMs: Date.parse(pending.expiresAt) - now, activationRemainingMs: activationDeadline - now })
      if (timeoutMs <= 0) fail('LOCAL_CANARY_EXPIRED', 'review approval expired before native batch')
      if (shortEnvironment) shortEnvironment = validateWindowsOpenCodeShortEnvironment(shortEnvironment, { platform, systemRoot: process.env.SystemRoot || process.env.WINDIR })
      const result = await ownedTest(owner, root, env, ['--test','--test-concurrency=1','--test-reporter=tap','--test-name-pattern',pattern,source], timeoutMs, signal, {
        platform, providerPrivateOwnershipRoot: activation.activationRoot, trustedOwnershipRoots: [activation.activationRoot], createPlatformAdapter: options.createPlatformAdapter,
        failFastTap: true,
      })
      const output = `${result.stdout || ''}\n${result.stderr || ''}`
      if (result.error || result.code !== 0 || result.signal || /^not ok /m.test(output)) fail('LOCAL_CANARY_FAILED', `native case batch did not pass: ${relativeSource}`)
      tapCases(output, cases)
      for (const { capability, ...item } of cases) {
        if (Date.now() >= Math.min(activationDeadline, Date.parse(pending.expiresAt))) fail('LOCAL_CANARY_EXPIRED', 'canary authority expired before observation persistence')
        const artifact = { schemaVersion:'harness-v2-closed-canary-observation.v1', capability, caseSha256:item.sha256, testName:item.testName,
          activationId:activation.activationId, generation, challenge, requestSha256:activation.record.request.sha256,
          target:activation.record.target.realpath, executableSha256:executable.sha256, executableRuntimeIdentity:executable.runtimeIdentity || null,
          connectionSha256:activation.record.connectionSha256, payloadDigest:activation.installed.payloadDigest,
          enforcementProofSha256:activation.enforcementProof.sha256, reviewDigest:pending.reviewDigest, outputSha256:hash(output) }
        const bytes = Buffer.from(JSON.stringify(artifact)); const file = path.join(root, `${capability}.json`); fs.writeFileSync(file, bytes, { flag:'wx', mode:0o600 }); const reopened = regular(file)
        const observationSha256 = hash(reopened)
        results.push({ capability, status:'passed', caseSha256:item.sha256, observationSha256 })
        artifacts.push({ capability, path:file, sha256:observationSha256 })
      }
    }
    return { challenge, observations:results, artifacts }
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    if (abortListenerInstalled) signal.removeEventListener('abort', cancel)
    await finalizeClosedCanary({ owner, env, provider, activationId: activation.activationId, generation, challenge, platform, shortEnvironment, primaryError,
      providerPrivateOwnershipRoot: activation.activationRoot, trustedOwnershipRoots: [activation.activationRoot], createPlatformAdapter: options.createPlatformAdapter,
      systemRoot: process.env.SystemRoot || process.env.WINDIR })
  }
}
async function closedOwnedTest(requestPath) {
  const absoluteRequest = path.resolve(requestPath), parent = path.dirname(absoluteRequest)
  const match = /^(outer-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/.exec(path.basename(absoluteRequest))
  const parentBefore = inspectPathNoFollow(parent)
  const request = JSON.parse(regular(absoluteRequest))
  const stem = match && path.join(parent, match[1])
  const expected = stem && { status: `${stem}.status.json`, stdoutPath: `${stem}.stdout.log`, stderrPath: `${stem}.stderr.log`, failureMarker: `${stem}.failure.json` }
  if (!match || !expected || request.status !== expected.status || request.stdoutPath !== expected.stdoutPath || request.stderrPath !== expected.stderrPath ||
      request.failureMarker !== expected.failureMarker || typeof request.failFastTap !== 'boolean' ||
      typeof request.cwd !== 'string' || !path.isAbsolute(request.cwd) || !Array.isArray(request.argv) || request.argv.some(value => typeof value !== 'string') ||
      !request.env || typeof request.env !== 'object' || Array.isArray(request.env) || Object.entries(request.env).some(([key, value]) => !key || typeof value !== 'string') ||
      !Number.isSafeInteger(request.postStatusDelayMs) || request.postStatusDelayMs < 0 || request.postStatusDelayMs > 5000) {
    fail('LOCAL_CANARY_INVALID', 'closed owned-test request is invalid')
  }
  let stdoutHandle, stderrHandle
  try {
    stdoutHandle = fs.openSync(request.stdoutPath, 'wx', 0o600)
    stderrHandle = fs.openSync(request.stderrPath, 'wx', 0o600)
    const parentAfter = inspectPathNoFollow(parent)
    if (!parentBefore.exists || !parentAfter.exists || JSON.stringify(parentBefore.identity) !== JSON.stringify(parentAfter.identity)) {
      fail('LOCAL_CANARY_INVALID', 'closed owned-test output parent changed during binding')
    }
  } catch (error) {
    if (stdoutHandle !== undefined) try { fs.closeSync(stdoutHandle) } catch {}
    if (stderrHandle !== undefined) try { fs.closeSync(stderrHandle) } catch {}
    throw error
  }
  const maximum = 4 * 1024 * 1024
  const stdout = { bytes: 0, chunks: [] }, stderr = { bytes: 0, chunks: [] }
  let child = null, childError = null, settled = false, effectiveCwd = request.cwd
  let tapPending = '', tapDiscarding = false, pendingTapFailure = null, failureMarkerWritten = false, failureMarkerTimer = null
  const tapDecoder = new StringDecoder('utf8')
  const publishTapFailure = () => {
    if (!pendingTapFailure || failureMarkerWritten) return
    if (failureMarkerTimer) { clearTimeout(failureMarkerTimer); failureMarkerTimer = null }
    try { fs.writeFileSync(request.failureMarker, JSON.stringify(pendingTapFailure), { flag: 'wx', mode: 0o600 }); failureMarkerWritten = true }
    catch (error) {
      childError ||= Object.assign(new Error('owned native test could not publish its TAP failure marker'), { code: 'LOCAL_CANARY_INVALID', cause: error.code })
      try { child?.kill('SIGKILL') } catch {}
    }
  }
  const inspectTap = chunk => {
    if (!request.failFastTap || pendingTapFailure || failureMarkerWritten) return
    const text = tapDecoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    const lines = text.split('\n')
    lines[0] = tapPending + lines[0]
    tapPending = lines.pop()
    for (const raw of lines) {
      if (tapDiscarding) { tapDiscarding = false; continue }
      if (raw.length > 4096) continue
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
      const match = /^not ok \d+ - (.+)$/.exec(line)
      if (!match) continue
      const caseName = match[1].replace(/\s+#\s*(?:SKIP|TODO)\b.*$/u, '').slice(0, 512)
      pendingTapFailure = { schemaVersion: 1, case: caseName || 'unnamed TAP case', message: line.slice(0, 1024) }
      failureMarkerTimer = setTimeout(publishTapFailure, 250)
      break
    }
    if (!pendingTapFailure && tapPending.length > 4096) { tapPending = ''; tapDiscarding = true }
  }
  const append = (state, handle, chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    const retained = bytes.subarray(0, Math.max(0, maximum - state.bytes))
    if (retained.length) { fs.writeSync(handle, retained); state.chunks.push(retained); state.bytes += retained.length }
    if (retained.length !== bytes.length) { childError ||= Object.assign(new Error('owned native test output exceeded its bound'), { code: 'LOCAL_CANARY_OUTPUT_LIMIT' }); try { child?.kill('SIGKILL') } catch {} }
  }
  const boundedError = error => error ? { code: String(error.code || 'RUNTIME_FAILURE').slice(0, 64),
    message: String(error.message || error).replace(/[\r\n]+/gu, ' ').slice(0, 512),
    requestedCwdLength: request.cwd.length, effectiveCwdLength: effectiveCwd.length } : null
  const finish = async (code, signal, error = null) => {
    if (settled) return
    settled = true
    publishTapFailure()
    error ||= childError
    const failure = boundedError(error)
    if (failure) append(stderr, stderrHandle, Buffer.from(`CLOSED_OWNED_TEST_FAILED:${JSON.stringify(failure)}\n`))
    for (const handle of [stdoutHandle, stderrHandle]) { try { fs.fsyncSync(handle) } catch {}; try { fs.closeSync(handle) } catch {} }
    writeAtomic(request.status, JSON.stringify({ code: error && (code === null || code === 0) ? 1 : code, signal: signal || null,
      error: failure ? failure.message : null, errorCode: failure ? failure.code : null,
      stdout: Buffer.concat(stdout.chunks, stdout.bytes).toString('utf8'), stderr: Buffer.concat(stderr.chunks, stderr.bytes).toString('utf8') }))
    if (request.postStatusDelayMs) await new Promise(resolve => setTimeout(resolve, request.postStatusDelayMs))
  }
  try {
    if (process.platform === 'win32') {
      const before = inspectPathNoFollow(request.cwd)
      effectiveCwd = process.cwd()
      const inherited = fs.lstatSync(effectiveCwd), inheritedReal = fs.realpathSync.native(effectiveCwd)
      const after = inspectPathNoFollow(request.cwd)
      if (!before.exists || !after.exists || JSON.stringify(before.identity) !== JSON.stringify(after.identity) ||
          (!inherited.isDirectory() && !inherited.isSymbolicLink()) || inheritedReal.toLowerCase() !== before.realpath.toLowerCase() || effectiveCwd.length >= 260) {
        fail('LOCAL_CANARY_INVALID', 'closed owned-test inherited cwd does not bind its requested physical directory')
      }
    }
    child = cp.spawn(process.execPath, request.argv, { cwd: effectiveCwd, env: request.env, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
  } catch (error) { await finish(1, null, error); throw error }
  if (!child.stdout || !child.stderr) {
    const error = Object.assign(new Error('closed owned-test child lacks output streams'), { code: 'LOCAL_CANARY_INVALID' })
    childError = error; child.once('error', () => {}); child.once('close', (code, signal) => finish(code, signal, error)); try { child.kill('SIGKILL') } catch {}; return
  }
  child.stdout.on('data', chunk => { append(stdout, stdoutHandle, chunk); inspectTap(chunk) })
  child.stderr.on('data', chunk => append(stderr, stderrHandle, chunk))
  child.once('error', error => { childError = error })
  child.once('close', async (code, signal) => {
    await finish(code, signal, childError)
  })
}
if (require.main === module && process.argv[2] === '--closed-owned-test') closedOwnedTest(process.argv[3]).catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1 })
module.exports = { run, closedEnvironment, tapCases, ownedTest, drainRegistered, drainDarwinCommandDiscovery, closedCanaryProcessAdapter, claimPrivateCanaryDirectory, closedCanaryBatchTimeout, finalizeClosedCanary, stageWindowsOpenCodeShortEnvironment, validateWindowsOpenCodeShortEnvironment, removeWindowsOpenCodeShortEnvironment, reopenWindowsOpenCodeShortEnvironmentRecord, WINDOWS_OPENCODE_SHORT_ENV_RECORD }
