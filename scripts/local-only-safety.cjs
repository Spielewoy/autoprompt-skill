#!/usr/bin/env node
'use strict'

const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { fileURLToPath, pathToFileURL } = require('node:url')

const SCHEMA_VERSION = 2
const REJECT_TARGET_NAME = 'NO_REMOTE_PUSH'
const MANAGED_HOOK = '#!/bin/sh\n\necho "Push disabled: this Autoprompt redesign must remain local." >&2\nexit 1\n'
const MANAGED_HOOK_SHA256 = crypto.createHash('sha256').update(MANAGED_HOOK).digest('hex')
const EXIT = Object.freeze({
  SAFE: 0,
  UNSAFE: 2,
  REPAIR_INCOMPLETE: 3,
  USAGE: 64,
  OPERATIONAL_ERROR: 70,
})
const GIT_WRITE_AUTH_ENVIRONMENT_KEYS = Object.freeze([
  'GIT_ASKPASS',
  'GIT_HTTP_EXTRA_HEADER',
  'GIT_PROXY_COMMAND',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'SSH_ASKPASS',
  'SSH_AUTH_SOCK',
])
const GITHUB_FIXED_UNSET = Object.freeze([
  'GH_CONFIG_DIR',
  'GH_ENTERPRISE_TOKEN',
  'GH_HOST',
  'GH_PROMPT_DISABLED',
  'GH_REPO',
  'GH_TOKEN',
  'GITHUB_API_URL',
  'GITHUB_AUTH_HEADER',
  'GITHUB_AUTH_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GITHUB_GRAPHQL_URL',
  'GITHUB_HEADER',
  'GITHUB_PAT',
  'GITHUB_REPOSITORY',
  'GITHUB_SERVER_URL',
  'GITHUB_TOKEN',
])
const CHILD_ENVIRONMENT_UNSET = Object.freeze([
  ...GIT_WRITE_AUTH_ENVIRONMENT_KEYS,
  ...GITHUB_FIXED_UNSET,
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_DIR',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_EXEC_PATH',
  'GIT_INDEX_FILE',
  'GIT_NAMESPACE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PROTOCOL',
  'GIT_WORK_TREE',
])
const NETWORK_PUSH_PREFIXES = Object.freeze([
  'https://',
  'http://',
  'ssh://',
  'git+ssh://',
  'git://',
  'ftp://',
  'ftps://',
  'git@',
])

const USAGE = `Usage:
  node scripts/local-only-safety.cjs --expected-branch <branch-or-empty-for-detached-HEAD> [--repo <path>] [--enforcement-proof <json-file>] [--repair] [--json]
  node scripts/local-only-safety.cjs --expected-branch <branch-or-empty-for-detached-HEAD> [--repo <path>] --emit-child-env --gh-config-dir <empty-directory> [--config-isolation <empty-file>] [--json]

Exit codes:
  0   all local-only controls pass
  2   one or more controls fail in check mode
  3   repair mode completed but one or more controls still fail
  64  invalid command-line usage
  70  repository inspection or a local operation failed

The checker never runs push, fetch, ls-remote, GitHub CLI, or a hook. Repair only
changes repository-local Git configuration and the canonical pre-push hook.
Overall safety requires both repository controls and the emitted child environment.
An explicitly empty --expected-branch value requires an existing detached HEAD;
omitting --expected-branch remains invalid.`

function parseArgs(argv) {
  const parsed = {
    expectedBranch: null,
    configIsolation: null,
    enforcementProof: null,
    emitChildEnv: false,
    format: 'text',
    help: false,
    ghConfigDir: null,
    repair: false,
    repo: process.cwd(),
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--expected-branch') {
      parsed.expectedBranch = argv[++index]
    } else if (argument === '--config-isolation') {
      parsed.configIsolation = argv[++index]
    } else if (argument === '--enforcement-proof') {
      parsed.enforcementProof = argv[++index]
    } else if (argument === '--emit-child-env') {
      parsed.emitChildEnv = true
    } else if (argument === '--gh-config-dir') {
      parsed.ghConfigDir = argv[++index]
    } else if (argument === '--repo') {
      parsed.repo = argv[++index]
    } else if (argument === '--repair') {
      parsed.repair = true
    } else if (argument === '--json') {
      parsed.format = 'json'
    } else if (argument === '--help' || argument === '-h') {
      parsed.help = true
    } else {
      throw new UsageError(`Unknown argument: ${argument}`)
    }
  }

  if (parsed.help) return parsed
  if (parsed.expectedBranch === null) throw new UsageError('--expected-branch is required')
  if (parsed.expectedBranch === undefined) throw new UsageError('--expected-branch requires a value')
  if (!parsed.repo) throw new UsageError('--repo requires a path')
  if (parsed.configIsolation === undefined) throw new UsageError('--config-isolation requires a path')
  if (parsed.enforcementProof === undefined) throw new UsageError('--enforcement-proof requires a path')
  if (parsed.ghConfigDir === undefined) throw new UsageError('--gh-config-dir requires a path')
  if (parsed.emitChildEnv && !parsed.ghConfigDir) throw new UsageError('--emit-child-env requires --gh-config-dir')
  if (parsed.emitChildEnv && parsed.repair) throw new UsageError('--emit-child-env and --repair cannot be combined')
  if (/\0|[\r\n]/.test(parsed.expectedBranch)) {
    throw new UsageError('--expected-branch must be a single line')
  }
  return parsed
}

class UsageError extends Error {}
class OperationalError extends Error {}

function runGit(repo, args, options = {}) {
  const gitEnvironment = { ...(options.environment || process.env) }
  for (const key of [
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CEILING_DIRECTORIES', 'GIT_COMMON_DIR',
    'GIT_DIR', 'GIT_DISCOVERY_ACROSS_FILESYSTEM', 'GIT_EXEC_PATH', 'GIT_INDEX_FILE',
    'GIT_NAMESPACE', 'GIT_OBJECT_DIRECTORY', 'GIT_WORK_TREE',
  ]) delete gitEnvironment[key]
  if (options.excludeCommandConfig) {
    for (const key of Object.keys(gitEnvironment)) {
      if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/i.test(key)) delete gitEnvironment[key]
    }
  }
  const result = childProcess.spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: {
      ...gitEnvironment,
      GCM_INTERACTIVE: 'Never',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
    },
    maxBuffer: 4 * 1024 * 1024,
    timeout: 5_000,
    windowsHide: true,
  })

  if (result.error) {
    throw new OperationalError(`git ${args[0] || ''} could not run: ${result.error.message}`)
  }
  if (!options.allowFailure && result.status !== 0) {
    const reason = String(result.stderr || result.stdout || '').trim()
    throw new OperationalError(`git ${args[0] || ''} failed${reason ? `: ${reason}` : ''}`)
  }
  return result
}

function gitText(repo, args) {
  return runGit(repo, args).stdout.trim()
}

function resolveGitPath(worktreeRoot, value) {
  return path.resolve(worktreeRoot, value)
}

function discoverRepository(requestedRepo) {
  const requestedRoot = path.resolve(requestedRepo)
  let requestedStat
  try {
    requestedStat = fs.statSync(requestedRoot)
  } catch (error) {
    throw new OperationalError(`Repository path cannot be opened: ${error.message}`)
  }
  if (!requestedStat.isDirectory()) throw new OperationalError('Repository path is not a directory')

  const worktreeResult = runGit(requestedRoot, ['rev-parse', '--show-toplevel'], { allowFailure: true })
  if (worktreeResult.status !== 0) throw new OperationalError('Repository path is not inside a Git worktree')
  const worktreeRoot = fs.realpathSync.native(path.resolve(worktreeResult.stdout.trim()))
  const gitDir = resolveGitPath(worktreeRoot, gitText(worktreeRoot, ['rev-parse', '--git-dir']))
  const commonGitDir = resolveGitPath(worktreeRoot, gitText(worktreeRoot, ['rev-parse', '--git-common-dir']))
  const rejectTarget = path.join(commonGitDir, REJECT_TARGET_NAME)
  const hookPath = path.join(commonGitDir, 'hooks', 'pre-push')

  return { commonGitDir, gitDir, hookPath, rejectTarget, requestedRoot, worktreeRoot }
}

function parseConfigRecords(stdout) {
  const records = []
  for (const record of stdout.split('\0')) {
    if (!record) continue
    const separator = record.indexOf('\n')
    const key = separator === -1 ? record : record.slice(0, separator)
    const value = separator === -1 ? '' : record.slice(separator + 1)
    records.push({ key, keyLower: key.toLowerCase(), value })
  }
  return records
}

function readConfig(repo, scope = null, options = {}) {
  const args = ['config']
  if (scope) args.push(`--${scope}`)
  args.push('--null', '--list')
  return parseConfigRecords(runGit(repo, args, options).stdout)
}

function configValues(config, key) {
  const lower = key.toLowerCase()
  return config.filter(entry => entry.keyLower === lower).map(entry => entry.value)
}

function networkRemoteUrls(config) {
  const urls = []
  for (const entry of config) {
    if (!/^remote\..*\.(url|pushurl)$/.test(entry.keyLower)) continue
    if (!NETWORK_PUSH_PREFIXES.some(prefix => entry.value.toLowerCase().startsWith(prefix))) continue
    try {
      const parsed = new URL(entry.value)
      if (parsed.username || parsed.password || parsed.search || parsed.hash) continue
    } catch {
      if (/^[^/\\]+@[^:]+:/.test(entry.value)) continue
    }
    urls.push(entry.value)
  }
  return [...new Set(urls)].sort()
}

function defaultConfigIsolation(repository) {
  return path.join(repository.rejectTarget, 'EMPTY_CONFIG')
}

function pathWithin(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function assertGithubConfigDirectory(repository, ghConfigDir) {
  if (!ghConfigDir) throw new OperationalError('ghConfigDir is required for child GitHub CLI isolation')
  const resolved = fs.realpathSync.native(path.resolve(ghConfigDir))
  const stat = fs.lstatSync(resolved)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new OperationalError('GH_CONFIG_DIR must be a regular non-symlink directory')
  }
  if (fs.readdirSync(resolved).length !== 0) {
    throw new OperationalError('GH_CONFIG_DIR must be empty before child launch')
  }
  if (pathEqual(resolved, repository.worktreeRoot)
    || pathWithin(repository.worktreeRoot, resolved)
    || pathEqual(resolved, repository.commonGitDir)
    || pathWithin(repository.commonGitDir, resolved)) {
    throw new OperationalError('GH_CONFIG_DIR must be activation-private and outside the target worktree')
  }
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new OperationalError('GH_CONFIG_DIR must not grant group or other permissions')
  }
  return resolved
}

function assertConfigIsolation(configIsolationPath, allowedMissingRoot = null) {
  const requested = path.resolve(configIsolationPath)
  try {
    const resolved = fs.realpathSync.native(requested)
    const stat = fs.lstatSync(resolved)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 0) {
      throw new OperationalError('Config isolation path must be an empty regular non-symlink file')
    }
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      throw new OperationalError('Config isolation file must not grant group or other permissions')
    }
    return resolved
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    if (allowedMissingRoot
      && !fs.existsSync(allowedMissingRoot)
      && pathEqual(path.dirname(requested), allowedMissingRoot)) return requested
    throw new OperationalError('Config isolation path is missing outside the protected reject target')
  }
}

function buildGitConfigPolicy(repository, config) {
  const rejectBase = `${pathToFileURL(repository.rejectTarget).href.replace(/\/$/, '')}/`
  const pushPrefixes = [...new Set([
    ...NETWORK_PUSH_PREFIXES,
    ...networkRemoteUrls(config),
  ])]
  const configEntries = [
    ['protocol.allow', 'never'],
    ['protocol.file.allow', 'always'],
    ['credential.helper', ''],
    ['credential.username', ''],
    ['core.askPass', ''],
    ['http.extraHeader', ''],
    ['http.cookieFile', ''],
    ['http.sslCert', ''],
    ['http.sslKey', ''],
    ...pushPrefixes.map(prefix => [`url.${rejectBase}.pushInsteadOf`, prefix]),
  ]
  return { configEntries, pushPrefixes, rejectBase }
}

function buildGitEnvironmentSet(policy, configIsolationPath) {
  const set = {
    GCM_INTERACTIVE: 'Never',
    GIT_ALLOW_PROTOCOL: 'file',
    GIT_CONFIG_GLOBAL: configIsolationPath,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: configIsolationPath,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PROTOCOL_FROM_USER: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: String(policy.configEntries.length),
  }
  policy.configEntries.forEach(([key, value], index) => {
    set[`GIT_CONFIG_KEY_${index}`] = key
    set[`GIT_CONFIG_VALUE_${index}`] = value
  })
  return set
}

function buildChildEnvironmentSpec(repository, config, options = {}) {
  const configIsolationPath = assertConfigIsolation(
    options.configIsolationPath || defaultConfigIsolation(repository),
    repository.rejectTarget,
  )
  const ghConfigDir = assertGithubConfigDirectory(repository, options.ghConfigDir)
  const policy = buildGitConfigPolicy(repository, config)
  const set = {
    ...buildGitEnvironmentSet(policy, configIsolationPath),
    GH_CONFIG_DIR: ghConfigDir,
    GH_PROMPT_DISABLED: '1',
  }
  return {
    configEntries: policy.configEntries,
    configIsolationPath,
    ghConfigDir,
    pushPrefixes: policy.pushPrefixes,
    rejectBase: policy.rejectBase,
    set,
    unset: [...new Set([
      ...CHILD_ENVIRONMENT_UNSET,
      ...Object.keys(options.baseEnvironment || {}).filter(key => /^(GH|GITHUB)_/i.test(key)),
    ])].sort(),
  }
}

function applyChildEnvironment(baseEnvironment, spec) {
  const environment = { ...baseEnvironment }
  for (const key of Object.keys(environment)) {
    if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+|GLOBAL|SYSTEM)$/i.test(key)) delete environment[key]
    if (/^(GH|GITHUB)_/i.test(key)) delete environment[key]
  }
  for (const key of spec.unset) delete environment[key]
  Object.assign(environment, spec.set)
  return environment
}

function createSafeChildGitEnvironment(repoPath, baseEnvironment = process.env, options = {}) {
  const repository = discoverRepository(repoPath)
  const config = readConfig(repository.worktreeRoot, null, { excludeCommandConfig: true })
  return applyChildEnvironment(baseEnvironment, buildChildEnvironmentSpec(repository, config, {
    ...options,
    baseEnvironment,
  }))
}

function environmentConfig(environment) {
  const countText = environment.GIT_CONFIG_COUNT
  if (!/^\d+$/.test(countText || '')) return { entries: [], valid: false }
  const count = Number(countText)
  if (!Number.isSafeInteger(count) || count > 256) return { entries: [], valid: false }
  const entries = []
  for (let index = 0; index < count; index += 1) {
    const key = environment[`GIT_CONFIG_KEY_${index}`]
    const value = environment[`GIT_CONFIG_VALUE_${index}`]
    if (typeof key !== 'string' || typeof value !== 'string') return { entries: [], valid: false }
    entries.push([key, value])
  }
  const unexpected = Object.keys(environment).some(key => {
    const match = /^GIT_CONFIG_(KEY|VALUE)_(\d+)$/i.exec(key)
    return match && Number(match[2]) >= count
  })
  return { entries, valid: !unexpected }
}

function currentBranch(repo) {
  const result = runGit(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true })
  if (result.status === 0) return result.stdout.trim()
  if (result.status === 1) return null
  throw new OperationalError('HEAD branch state could not be inspected')
}

function currentHead(repo) {
  const branch = currentBranch(repo)
  const oidResult = runGit(repo, ['rev-parse', '--verify', 'HEAD'], { allowFailure: true })
  if (oidResult.status !== 0 && branch === null) {
    throw new OperationalError('Detached HEAD does not resolve to an object')
  }
  return {
    branch,
    oid: oidResult.status === 0 ? oidResult.stdout.trim() : null,
    state: branch === null ? 'detached' : 'branch',
  }
}

function expectedHead(expectedBranch) {
  return expectedBranch === ''
    ? { branch: null, state: 'detached' }
    : { branch: expectedBranch, state: 'branch' }
}

function headMatchesExpectation(head, expectation) {
  return expectation.state === 'detached'
    ? head.state === 'detached'
    : head.state === 'branch' && head.branch === expectation.branch
}

function pathEqual(left, right) {
  const normalizedLeft = path.resolve(left)
  const normalizedRight = path.resolve(right)
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight
}

function check(id, ok, passSummary, failSummary, details = {}) {
  return {
    id,
    status: ok ? 'pass' : 'fail',
    summary: ok ? passSummary : failSummary,
    details,
  }
}

function urlRewriteRules(config) {
  const rules = []
  for (const entry of config) {
    const match = /^url\.(.*)\.(pushinsteadof|insteadof)$/i.exec(entry.key)
    if (!match || !entry.value) continue
    rules.push({ base: match[1], key: entry.key, prefix: entry.value, type: match[2].toLowerCase() })
  }
  return rules
}

function applyPushRewrite(rawUrl, rules) {
  const pushRules = rules.filter(rule => rule.type === 'pushinsteadof' && rawUrl.startsWith(rule.prefix))
  const ordinaryRules = rules.filter(rule => rule.type === 'insteadof' && rawUrl.startsWith(rule.prefix))
  const candidates = pushRules.length > 0 ? pushRules : ordinaryRules
  if (candidates.length === 0) return { ambiguity: false, rewritten: rawUrl, rule: null }

  const longest = Math.max(...candidates.map(rule => rule.prefix.length))
  const selected = candidates.filter(rule => rule.prefix.length === longest)
  const outputs = [...new Set(selected.map(rule => `${rule.base}${rawUrl.slice(rule.prefix.length)}`))]
  return {
    ambiguity: outputs.length !== 1,
    rewritten: outputs.length === 1 ? outputs[0] : null,
    rule: selected.map(rule => rule.key).sort(),
  }
}

function localPathFromUrl(rawUrl, worktreeRoot) {
  if (!rawUrl || /\0|[\r\n]/.test(rawUrl)) return null
  if (/^\\\\/.test(rawUrl) || /^\/\//.test(rawUrl)) return null
  if (/^[A-Za-z]:[\\/]/.test(rawUrl)) return path.resolve(rawUrl)

  if (/^file:/i.test(rawUrl)) {
    try {
      const parsed = new URL(rawUrl)
      if (parsed.hostname && parsed.hostname.toLowerCase() !== 'localhost') return null
      return path.resolve(fileURLToPath(parsed))
    } catch {
      return null
    }
  }

  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(rawUrl) || /^[^/\\]+@[^:]+:/.test(rawUrl)) return null
  if (rawUrl.startsWith('~')) return null
  return path.resolve(worktreeRoot, rawUrl)
}

function displayUrl(rawUrl) {
  if (!rawUrl) return '(empty)'
  if (/^[A-Za-z]:[\\/]/.test(rawUrl)) return rawUrl
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol === 'file:') return rawUrl
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`
  } catch {
    return rawUrl.replace(/^[^/@:]+@/, '')
  }
}

function remoteNames(config) {
  const names = new Set()
  for (const entry of config) {
    const match = /^remote\.(.+)\.(?:url|pushurl)$/i.exec(entry.key)
    if (match) names.add(match[1])
  }
  return [...names].sort()
}

function inspectPushTargets(repository, config) {
  const rewrites = urlRewriteRules(config)
  const remotes = []
  let safe = true

  let rejectTargetExists = false
  try {
    fs.lstatSync(repository.rejectTarget)
    rejectTargetExists = true
  } catch (error) {
    if (error.code !== 'ENOENT') throw new OperationalError(`Reject target cannot be inspected: ${error.message}`)
  }

  for (const remote of remoteNames(config)) {
    const configured = configValues(config, `remote.${remote}.pushurl`)
    const targets = []
    if (configured.length === 0) safe = false

    for (const rawUrl of configured) {
      const rewrite = applyPushRewrite(rawUrl, rewrites)
      const localPath = rewrite.ambiguity ? null : localPathFromUrl(rewrite.rewritten, repository.worktreeRoot)
      const canonical = localPath !== null && pathEqual(localPath, repository.rejectTarget)
      const targetSafe = !rewrite.ambiguity && canonical && !rejectTargetExists
      if (!targetSafe) safe = false
      targets.push({
        configured: displayUrl(rawUrl),
        resolved: rewrite.ambiguity ? '(ambiguous URL rewrite)' : displayUrl(rewrite.rewritten),
        rewriteKeys: rewrite.rule || [],
        status: targetSafe ? 'rejected-local-target' : 'unsafe',
      })
    }
    remotes.push({ name: remote, targets })
  }

  if (rejectTargetExists) safe = false
  return { rejectTargetExists, remotes, safe }
}

function inspectHook(repository) {
  const configuredPath = resolveGitPath(
    repository.worktreeRoot,
    gitText(repository.worktreeRoot, ['rev-parse', '--git-path', 'hooks/pre-push']),
  )
  const details = {
    expectedSha256: MANAGED_HOOK_SHA256,
    path: configuredPath,
    verification: 'exact managed bytes; arbitrary hook code is never executed',
  }

  if (!pathEqual(configuredPath, repository.hookPath)) {
    return { details, safe: false, reason: 'The effective hooks path is outside the canonical repository hook directory.' }
  }

  let stat
  try {
    stat = fs.lstatSync(configuredPath)
  } catch (error) {
    if (error.code === 'ENOENT') return { details, safe: false, reason: 'The pre-push hook is missing.' }
    throw new OperationalError(`Pre-push hook cannot be inspected: ${error.message}`)
  }

  if (stat.isSymbolicLink() || !stat.isFile()) {
    return { details, safe: false, reason: 'The pre-push hook must be a regular non-symlink file.' }
  }
  const bytes = fs.readFileSync(configuredPath)
  const actualSha256 = crypto.createHash('sha256').update(bytes).digest('hex')
  details.actualSha256 = actualSha256
  if (actualSha256 !== MANAGED_HOOK_SHA256 || !bytes.equals(Buffer.from(MANAGED_HOOK))) {
    return { details, safe: false, reason: 'The pre-push hook is not the exact managed rejecting hook.' }
  }
  if (process.platform !== 'win32' && (stat.mode & 0o111) === 0) {
    return { details, safe: false, reason: 'The pre-push hook is not executable.' }
  }
  return { details, safe: true, reason: null }
}

function writeAuthConfiguration(config, environment) {
  let activeHelpers = []
  let activeAuthorizationHeaders = []
  let activeCredentialFields = []
  let activeAskPass = []
  const transportWriteKeys = new Set()
  for (const entry of config) {
    const key = entry.keyLower
    const urlRule = /^url\.(.*)\.(pushinsteadof|insteadof)$/.exec(key)
    if (/^credential(?:\..*)?\.helper$/.test(key)) {
      activeHelpers = entry.value === '' ? [] : [...activeHelpers, entry.key]
    }
    if (/^http(?:\..*)?\.extraheader$/.test(key)) {
      if (entry.value === '') activeAuthorizationHeaders = []
      else if (/^\s*(proxy-)?authorization\s*:/i.test(entry.value)) {
        activeAuthorizationHeaders.push(entry.key)
      }
    }
    if (/^credential(?:\..*)?\.username$/.test(key)) {
      activeCredentialFields = entry.value === '' ? [] : [...activeCredentialFields, entry.key]
    }
    if (key === 'core.askpass') {
      activeAskPass = entry.value === '' ? [] : [entry.key]
    }
    if (/^http(?:\..*)?\.(cookiefile|sslcert|sslkey)$/.test(key)) {
      activeCredentialFields = entry.value === '' ? [] : [...activeCredentialFields, entry.key]
    }
    if (/^remote\..*\.receivepack$/.test(key)) transportWriteKeys.add(entry.key)
    if (urlRule && /^(https?|ssh|git(?:\+ssh)?):|^[^/\\]+@/i.test(urlRule[1])) {
      transportWriteKeys.add(entry.key)
    }
  }
  const environmentKeys = GIT_WRITE_AUTH_ENVIRONMENT_KEYS.filter(key => Boolean(environment[key]))
  const riskyKeys = [...new Set([
    ...activeHelpers,
    ...activeAuthorizationHeaders,
    ...activeCredentialFields,
    ...activeAskPass,
    ...transportWriteKeys,
  ])].sort()
  return { environmentKeys, riskyKeys, safe: riskyKeys.length === 0 && environmentKeys.length === 0 }
}

function inspectCommandBoundary(repository, repositoryConfig, effectiveConfig, environment) {
  let isolationSafe = false
  let isolationPath = environment.GIT_CONFIG_GLOBAL || defaultConfigIsolation(repository)
  try {
    const globalPath = assertConfigIsolation(isolationPath, repository.rejectTarget)
    const systemPath = assertConfigIsolation(
      environment.GIT_CONFIG_SYSTEM || defaultConfigIsolation(repository),
      repository.rejectTarget,
    )
    isolationSafe = Boolean(environment.GIT_CONFIG_GLOBAL)
      && Boolean(environment.GIT_CONFIG_SYSTEM)
      && globalPath === systemPath
      && environment.GIT_CONFIG_NOSYSTEM === '1'
    isolationPath = globalPath
  } catch {
    isolationSafe = false
    isolationPath = defaultConfigIsolation(repository)
  }

  const policy = buildGitConfigPolicy(repository, repositoryConfig)
  const expectedSet = buildGitEnvironmentSet(policy, isolationPath)
  const actualConfig = environmentConfig(environment)
  const configExact = actualConfig.valid
    && JSON.stringify(actualConfig.entries) === JSON.stringify(policy.configEntries)
  const mismatchedEnvironment = Object.entries(expectedSet)
    .filter(([key, value]) => key === 'GIT_CONFIG_GLOBAL'
      || key === 'GIT_CONFIG_SYSTEM'
      || !/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(key)
        ? environment[key] !== value
        : false)
    .map(([key]) => key)
  const inheritedDangerousEnvironment = [
    ...GIT_WRITE_AUTH_ENVIRONMENT_KEYS,
    ...CHILD_ENVIRONMENT_UNSET.filter(key => key.startsWith('GIT_')),
  ].filter(key => Boolean(environment[key]) && !(key in expectedSet))
  const auth = writeAuthConfiguration(effectiveConfig, environment)
  const safe = isolationSafe
    && configExact
    && mismatchedEnvironment.length === 0
    && inheritedDangerousEnvironment.length === 0
    && auth.safe

  return {
    check: check(
      'command_boundary',
      safe,
      'This process has the complete local-only Git command boundary.',
      'Repository guards may pass, but this process lacks the complete child Git boundary.',
      {
        configInjectionExact: configExact,
        configIsolationSafe: isolationSafe,
        defensePushPrefixes: policy.pushPrefixes,
        effectiveWriteAuthEnvironment: auth.environmentKeys,
        effectiveWriteAuthKeys: auth.riskyKeys,
        inheritedDangerousEnvironment,
        mismatchedEnvironment,
        requiredProtocol: 'file',
      },
    ),
    enforced: safe,
    emitted: { set: expectedSet, unset: [...CHILD_ENVIRONMENT_UNSET] },
  }
}

function residual(code, message) {
  return { code, message }
}

function channel(applicable, enforced, evidence, residuals = []) {
  return { applicable, enforced, evidence, residuals }
}

function inspectGithubCliBoundary(repository, environment) {
  const sensitiveEnvironment = Object.keys(environment)
    .filter(key => /^(GH|GITHUB)_/i.test(key)
      && key !== 'GH_CONFIG_DIR'
      && key !== 'GH_PROMPT_DISABLED'
      && Boolean(environment[key]))
    .sort()
  let configDirectorySafe = false
  let configDirectory = environment.GH_CONFIG_DIR || null
  let directoryReason = null
  try {
    configDirectory = assertGithubConfigDirectory(repository, configDirectory)
    configDirectorySafe = true
  } catch (error) {
    directoryReason = error.message
  }
  const promptDisabled = environment.GH_PROMPT_DISABLED === '1'
  const residuals = []
  if (!configDirectorySafe) residuals.push(residual('GH_CONFIG_DIR_UNSAFE', directoryReason))
  if (!promptDisabled) residuals.push(residual('GH_PROMPT_NOT_DISABLED', 'GH_PROMPT_DISABLED must equal 1'))
  if (sensitiveEnvironment.length > 0) {
    residuals.push(residual('GITHUB_AUTH_ENV_PRESENT', 'GitHub authentication or selector environment remains'))
  }
  return channel(true, residuals.length === 0, {
    configDirectory,
    configDirectoryEmptyPrivate: configDirectorySafe,
    promptDisabled,
    strippedEnvironmentKeys: GITHUB_FIXED_UNSET,
    unexpectedEnvironmentKeys: sensitiveEnvironment,
  }, residuals)
}

function parseProofToml(bytes) {
  const values = new Map()
  let section = ''
  for (const rawLine of bytes.toString('utf8').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const sectionMatch = /^\[([A-Za-z0-9_.-]+)\]$/.exec(line)
    if (sectionMatch) {
      section = sectionMatch[1]
      continue
    }
    const qualifiedAgentSection = /^\[agents\."(autoprompt-codex-v[0-9]+-[0-9]+-[0-9]+-[a-f0-9]{16}-ap-[a-z0-9-]+)"\]$/.exec(line)
    if (qualifiedAgentSection) {
      section = `agents."${qualifiedAgentSection[1]}"`
      continue
    }
    if (line.startsWith('[')) {
      throw new OperationalError(`Unsupported enforcement profile section: ${line}`)
    }
    const assignment = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(line)
    if (!assignment) continue
    const identity = `${section || 'root'}.${assignment[1]}`
    if (values.has(identity)) throw new OperationalError(`Duplicate enforcement profile key: ${identity}`)
    const encoded = assignment[2].trim()
    let value
    if (encoded === 'true' || encoded === 'false') value = encoded === 'true'
    else if (/^"(?:[^"\\]|\\.)*"$/.test(encoded)) value = JSON.parse(encoded)
    else value = encoded
    values.set(identity, value)
  }
  return values
}

function verifyCodexEnforcementProof(repository, environment, proof) {
  const baseEvidence = { profilePath: proof?.profilePath || null, provider: proof?.provider || null }
  if (!proof) {
    const missing = [residual('ENFORCEMENT_PROOF_MISSING', 'No Codex private-profile proof was supplied')]
    return {
      provider: channel(true, false, { ...baseEvidence, status: 'missing' }, missing),
      shell: channel(true, false, { ...baseEvidence, status: 'missing' }, missing),
    }
  }
  if (proof.schemaVersion !== 1 || proof.provider !== 'codex') {
    const unsupported = [residual('ENFORCEMENT_PROOF_UNSUPPORTED', 'Proof schema or provider is unsupported')]
    return {
      provider: channel(true, false, { ...baseEvidence, status: 'unsupported' }, unsupported),
      shell: channel(true, false, { ...baseEvidence, status: 'unsupported' }, unsupported),
    }
  }

  let profilePath
  let actualSha256
  let values
  const commonResiduals = []
  try {
    profilePath = fs.realpathSync.native(path.resolve(proof.profilePath))
    const stat = fs.lstatSync(profilePath)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new OperationalError('Profile is not a regular non-symlink file')
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      throw new OperationalError('Private profile must not grant group or other permissions')
    }
    if (path.basename(profilePath) !== 'autoprompt.config.toml') {
      throw new OperationalError('Proof must bind the selected autoprompt.config.toml profile')
    }
    if (pathEqual(profilePath, repository.worktreeRoot) || pathWithin(repository.worktreeRoot, profilePath)) {
      throw new OperationalError('Private profile must be outside the target worktree')
    }
    const bytes = fs.readFileSync(profilePath)
    actualSha256 = crypto.createHash('sha256').update(bytes).digest('hex')
    if (!/^[a-f0-9]{64}$/.test(proof.profileSha256 || '') || proof.profileSha256 !== actualSha256) {
      throw new OperationalError('Private profile hash does not match proof')
    }
    if (proof.selectedProfile !== 'autoprompt' || proof.strictConfig !== true) {
      throw new OperationalError('Proof does not bind --strict-config --profile autoprompt')
    }
    const activationRoot = path.dirname(profilePath)
    if (!environment.GH_CONFIG_DIR || !environment.GIT_CONFIG_GLOBAL
      || !pathEqual(path.dirname(environment.GH_CONFIG_DIR), activationRoot)
      || !pathEqual(path.dirname(environment.GIT_CONFIG_GLOBAL), activationRoot)) {
      throw new OperationalError('Profile, GH_CONFIG_DIR, and isolated Git config do not share one activation root')
    }
    values = parseProofToml(bytes)
  } catch (error) {
    commonResiduals.push(residual('ENFORCEMENT_PROOF_INVALID', error.message))
  }

  const evidence = {
    ...baseEvidence,
    actualSha256: actualSha256 || null,
    selectedProfile: proof.selectedProfile || null,
    status: commonResiduals.length === 0 ? 'verified-bytes' : 'invalid',
    strictConfig: proof.strictConfig === true,
  }
  if (commonResiduals.length > 0) {
    return {
      provider: channel(true, false, evidence, commonResiduals),
      shell: channel(true, false, evidence, commonResiduals),
    }
  }

  const shellFields = {
    networkAccess: values.get('sandbox_workspace_write.network_access'),
    sandboxMode: values.get('root.sandbox_mode'),
  }
  const shellResiduals = []
  if (shellFields.sandboxMode !== 'workspace-write' || shellFields.networkAccess !== false) {
    shellResiduals.push(residual(
      'SHELL_NETWORK_SANDBOX_UNPROVEN',
      'Profile must set sandbox_mode=workspace-write and sandbox_workspace_write.network_access=false',
    ))
  }

  const requiredDisabledFeatures = [
    'apps', 'enable_mcp_apps', 'plugins', 'remote_plugin', 'browser_use',
    'browser_use_external', 'in_app_browser', 'computer_use', 'image_generation',
  ]
  const featureEvidence = Object.fromEntries(
    requiredDisabledFeatures.map(name => [name, values.get(`features.${name}`)]),
  )
  const providerResiduals = []
  if (values.get('root.web_search') !== 'disabled'
    || Object.values(featureEvidence).some(value => value !== false)) {
    providerResiduals.push(residual(
      'PROVIDER_WRITE_TOOLS_UNPROVEN',
      'Profile must disable web search, apps/connectors, plugins, browser/computer, and image-generation tools',
    ))
  }

  return {
    shell: channel(true, shellResiduals.length === 0, {
      ...evidence,
      fields: shellFields,
    }, shellResiduals),
    provider: channel(true, providerResiduals.length === 0, {
      ...evidence,
      features: featureEvidence,
      webSearch: values.get('root.web_search'),
    }, providerResiduals),
  }
}

function inspect(repository, expectedBranch, environment = process.env, options = {}) {
  const config = readConfig(repository.worktreeRoot, null, {
    environment,
    excludeCommandConfig: true,
  })
  const effectiveConfig = readConfig(repository.worktreeRoot, null, { environment })
  const localConfig = readConfig(repository.worktreeRoot, 'local', {
    environment,
    excludeCommandConfig: true,
  })
  const head = currentHead(repository.worktreeRoot)
  const actualBranch = head.branch
  const headExpectation = expectedHead(expectedBranch)
  const expectedHeadMatches = headMatchesExpectation(head, headExpectation)
  const upstreamRemote = actualBranch ? configValues(config, `branch.${actualBranch}.remote`) : []
  const upstreamMerge = actualBranch ? configValues(config, `branch.${actualBranch}.merge`) : []
  const pushDefaultValues = configValues(config, 'push.default')
  const effectivePushDefault = pushDefaultValues.at(-1) || null
  const pushTargets = inspectPushTargets(repository, config)
  const hook = inspectHook(repository)
  const repositoryAuth = writeAuthConfiguration(localConfig, {})
  const commandBoundary = inspectCommandBoundary(repository, config, effectiveConfig, environment)

  const checks = [
    check(
      'expected_branch',
      expectedHeadMatches,
      headExpectation.state === 'detached'
        ? 'HEAD is detached as explicitly required.'
        : `Current branch is ${expectedBranch}.`,
      headExpectation.state === 'detached'
        ? `Expected detached HEAD, found branch ${actualBranch}.`
        : `Expected branch ${expectedBranch}, found ${actualBranch || 'detached HEAD'}.`,
      { actual: actualBranch, actualState: head.state, expected: expectedBranch, expectedState: headExpectation.state },
    ),
    check(
      'no_upstream',
      upstreamRemote.length === 0 && upstreamMerge.length === 0,
      'Current branch has no upstream association.',
      'Current branch still has upstream configuration.',
      { merge: upstreamMerge, remote: upstreamRemote },
    ),
    check(
      'push_default_nothing',
      effectivePushDefault === 'nothing',
      'Effective push.default is nothing.',
      `Effective push.default is ${effectivePushDefault || 'unset'}, not nothing.`,
      { actual: effectivePushDefault, expected: 'nothing' },
    ),
    check(
      'remote_push_targets',
      pushTargets.safe,
      'Every remote push URL resolves to the nonexistent canonical local reject target.',
      'At least one remote lacks a canonical rejected local push target, is rewritten, or the reject target exists.',
      {
        rejectTarget: repository.rejectTarget,
        rejectTargetExists: pushTargets.rejectTargetExists,
        remotes: pushTargets.remotes,
      },
    ),
    check(
      'pre_push_hook',
      hook.safe,
      'The exact managed pre-push hook rejects unconditionally.',
      hook.reason,
      hook.details,
    ),
    check(
      'repository_write_auth_configuration',
      repositoryAuth.safe,
      'No repository-local credential helper, authorization header, or write transport override was detected.',
      'Repository-local write-authentication or write-transport configuration is present.',
      { riskyKeys: repositoryAuth.riskyKeys },
    ),
  ]

  const repositoryOk = checks.every(item => item.status === 'pass')
  const githubCli = inspectGithubCliBoundary(repository, environment)
  const proof = verifyCodexEnforcementProof(repository, environment, options.enforcementProof)
  const channels = {
    repositoryGitBarrier: channel(true, repositoryOk, {
      checks: checks.map(item => ({ id: item.id, status: item.status })),
      worktreeRoot: repository.worktreeRoot,
    }, repositoryOk ? [] : [residual('REPOSITORY_GIT_BARRIER_FAILED', 'One or more repository Git controls failed')]),
    gitCommandNetworkBarrier: channel(true, commandBoundary.enforced, {
      check: commandBoundary.check,
      protocol: environment.GIT_ALLOW_PROTOCOL || null,
    }, commandBoundary.enforced ? [] : [residual('GIT_COMMAND_BOUNDARY_FAILED', commandBoundary.check.summary)]),
    githubCliCredentialIsolation: githubCli,
    shellOutboundNetworkSandbox: proof.shell,
    providerConnectorApiWriteToolDenial: proof.provider,
  }
  const applicableChannels = Object.values(channels).filter(item => item.applicable)
  const mechanicallyEnforced = applicableChannels.length === 5
    && applicableChannels.every(item => item.enforced && item.residuals.length === 0)
  const residuals = Object.entries(channels).flatMap(([channelName, item]) =>
    item.residuals.map(entry => ({ ...entry, channel: channelName })))
  return {
    actualBranch,
    channels,
    checks,
    commandBoundary,
    expectedHead: headExpectation,
    gitEnforced: repositoryOk && commandBoundary.enforced,
    head,
    headExpectationMatched: expectedHeadMatches,
    mechanicallyEnforced,
    ok: mechanicallyEnforced,
    residuals,
    repositoryOk,
  }
}

function unsetLocal(repo, key) {
  const result = runGit(repo, ['config', '--local', '--unset-all', key], { allowFailure: true })
  if (result.status !== 0 && result.status !== 5) {
    throw new OperationalError(`Could not unset local Git key ${key}`)
  }
}

function setLocal(repo, key, value) {
  runGit(repo, ['config', '--local', '--replace-all', key, value])
}

function repair(repository, expectedBranch, initial) {
  const changes = []
  const refusals = []
  if (!initial.headExpectationMatched) {
    refusals.push(expectedBranch === ''
      ? 'Detached HEAD expectation mismatch is never repaired automatically; no changes were made.'
      : 'Branch mismatch is never repaired automatically; no changes were made.')
    return { changes, refusals }
  }

  const repo = repository.worktreeRoot
  const effectiveHookPath = resolveGitPath(repo, gitText(repo, ['rev-parse', '--git-path', 'hooks/pre-push']))
  if (!pathEqual(effectiveHookPath, repository.hookPath)) {
    refusals.push(
      `Foreign core.hooksPath was not deactivated or modified: ${effectiveHookPath}. `
      + 'Provenance-safe hook composition is not implemented, so repair made zero changes.',
    )
    return { changes, refusals }
  }
  const localConfig = readConfig(repo, 'local', { excludeCommandConfig: true })

  if (expectedBranch !== '') {
    const remoteKey = `branch.${expectedBranch}.remote`
    const mergeKey = `branch.${expectedBranch}.merge`
    if (configValues(localConfig, remoteKey).length > 0) {
      unsetLocal(repo, remoteKey)
      changes.push(`unset ${remoteKey}`)
    }
    if (configValues(localConfig, mergeKey).length > 0) {
      unsetLocal(repo, mergeKey)
      changes.push(`unset ${mergeKey}`)
    }
  }

  setLocal(repo, 'push.default', 'nothing')
  changes.push('set push.default=nothing')

  let rejectTargetExists = false
  try {
    fs.lstatSync(repository.rejectTarget)
    rejectTargetExists = true
  } catch (error) {
    if (error.code !== 'ENOENT') throw new OperationalError(`Reject target cannot be inspected: ${error.message}`)
  }
  if (rejectTargetExists) {
    refusals.push(`Existing reject-target path was not removed: ${repository.rejectTarget}`)
  } else {
    for (const remote of remoteNames(localConfig)) {
      unsetLocal(repo, `remote.${remote}.pushurl`)
      runGit(repo, ['config', '--local', '--add', `remote.${remote}.pushurl`, repository.rejectTarget])
      changes.push(`redirected ${remote} push URL to the local reject target`)
    }
  }

  fs.mkdirSync(path.dirname(repository.hookPath), { recursive: true })
  let hookStat = null
  try {
    hookStat = fs.lstatSync(repository.hookPath)
  } catch (error) {
    if (error.code !== 'ENOENT') throw new OperationalError(`Pre-push hook cannot be inspected: ${error.message}`)
  }
  if (hookStat) {
    const current = hookStat.isFile() && !hookStat.isSymbolicLink()
      ? fs.readFileSync(repository.hookPath)
      : null
    if (!current || !current.equals(Buffer.from(MANAGED_HOOK))) {
      refusals.push(`Existing non-managed hook was not overwritten: ${repository.hookPath}`)
    } else if (process.platform !== 'win32') {
      fs.chmodSync(repository.hookPath, 0o755)
      changes.push('restored managed pre-push hook executable mode')
    }
  } else {
    fs.writeFileSync(repository.hookPath, MANAGED_HOOK, { encoding: 'utf8', flag: 'wx', mode: 0o755 })
    changes.push('installed the managed rejecting pre-push hook')
  }

  const refreshedLocalConfig = readConfig(repo, 'local', { excludeCommandConfig: true })
  const riskyLocalKeys = writeAuthConfiguration(refreshedLocalConfig, {}).riskyKeys
  for (const key of riskyLocalKeys) {
    unsetLocal(repo, key)
    changes.push(`removed local write-capable Git key ${key}`)
  }

  return { changes, refusals }
}

function buildResult(mode, repository, expectedBranch, inspection, repairs = null) {
  const exitCode = inspection.ok
    ? EXIT.SAFE
    : mode === 'repair' ? EXIT.REPAIR_INCOMPLETE : EXIT.UNSAFE
  return {
    schemaVersion: SCHEMA_VERSION,
    tool: 'local-only-safety',
    mode,
    ok: inspection.ok,
    repositoryOk: inspection.repositoryOk,
    gitEnforced: inspection.gitEnforced,
    mechanicallyEnforced: inspection.mechanicallyEnforced,
    exitCode,
    networkContactAttempted: false,
    repository: {
      commonGitDir: repository.commonGitDir,
      gitDir: repository.gitDir,
      requestedRoot: repository.requestedRoot,
      worktreeRoot: repository.worktreeRoot,
    },
    expectedBranch,
    actualBranch: inspection.actualBranch,
    expectedHead: inspection.expectedHead,
    actualHead: inspection.head,
    checks: inspection.checks,
    channels: inspection.channels,
    commandBoundary: inspection.commandBoundary,
    residuals: inspection.residuals,
    repairs,
  }
}

function formatText(result) {
  const expectedHead = result.expectedHead.state === 'detached'
    ? 'detached HEAD'
    : `branch ${result.expectedHead.branch}`
  const actualHead = result.actualHead.state === 'detached'
    ? `detached HEAD at ${result.actualHead.oid}`
    : `branch ${result.actualHead.branch}`
  const headLine = result.expectedHead.state === 'detached'
    ? `HEAD: ${actualHead} (expected ${expectedHead})`
    : `branch: ${result.actualBranch || 'detached HEAD'} (expected ${result.expectedBranch})`
  const lines = [
    result.mechanicallyEnforced ? 'LOCAL_ONLY_MECHANICALLY_ENFORCED' : 'LOCAL_ONLY_NOT_MECHANICALLY_ENFORCED',
    `repository: ${result.repository.worktreeRoot}`,
    headLine,
    `repository controls: ${result.repositoryOk ? 'pass' : 'fail'}`,
    `Git controls: ${result.gitEnforced ? 'pass' : 'fail'}`,
  ]
  for (const item of result.checks) lines.push(`[${item.status.toUpperCase()}] ${item.id}: ${item.summary}`)
  for (const [name, item] of Object.entries(result.channels)) {
    lines.push(`[${item.enforced ? 'PASS' : 'FAIL'}] ${name}`)
  }
  if (result.repairs) {
    for (const change of result.repairs.changes) lines.push(`[CHANGED] ${change}`)
    for (const refusal of result.repairs.refusals) lines.push(`[REFUSED] ${refusal}`)
  }
  lines.push('network contact attempted: no')
  return `${lines.join('\n')}\n`
}

function errorResult(error, exitCode) {
  return {
    schemaVersion: SCHEMA_VERSION,
    tool: 'local-only-safety',
    ok: false,
    exitCode,
    networkContactAttempted: false,
    error: { message: error.message, type: error.constructor.name },
  }
}

function loadEnforcementProof(proofPath) {
  if (!proofPath) return null
  const resolved = path.resolve(proofPath)
  const stat = fs.lstatSync(resolved)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new OperationalError('Enforcement proof must be a regular non-symlink JSON file')
  let proof
  try { proof = JSON.parse(fs.readFileSync(resolved, 'utf8')) } catch {
    throw new OperationalError('Enforcement proof JSON is invalid')
  }
  return proof
}

function main(argv = process.argv.slice(2)) {
  let args
  try {
    args = parseArgs(argv)
  } catch (error) {
    const result = errorResult(error, EXIT.USAGE)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    process.stderr.write(`${USAGE}\n`)
    return EXIT.USAGE
  }

  if (args.help) {
    process.stdout.write(`${USAGE}\n`)
    return EXIT.SAFE
  }

  try {
    const repository = discoverRepository(args.repo)
    if (args.emitChildEnv) {
      const config = readConfig(repository.worktreeRoot, null, { excludeCommandConfig: true })
      const spec = buildChildEnvironmentSpec(repository, config, {
        configIsolationPath: args.configIsolation || defaultConfigIsolation(repository),
        ghConfigDir: args.ghConfigDir,
        baseEnvironment: process.env,
      })
      const emitted = {
        schemaVersion: SCHEMA_VERSION,
        tool: 'local-only-safety',
        mode: 'emit-child-env',
        ok: true,
        exitCode: EXIT.SAFE,
        networkContactAttempted: false,
        set: spec.set,
        unset: spec.unset,
      }
      process.stdout.write(`${JSON.stringify(emitted, null, 2)}\n`)
      return EXIT.SAFE
    }
    const enforcementProof = loadEnforcementProof(args.enforcementProof)
    const inspectionOptions = { enforcementProof }
    const initial = inspect(repository, args.expectedBranch, process.env, inspectionOptions)
    const repairs = args.repair ? repair(repository, args.expectedBranch, initial) : null
    const finalInspection = args.repair
      ? inspect(repository, args.expectedBranch, process.env, inspectionOptions)
      : initial
    const result = buildResult(args.repair ? 'repair' : 'check', repository, args.expectedBranch, finalInspection, repairs)
    process.stdout.write(args.format === 'json' ? `${JSON.stringify(result, null, 2)}\n` : formatText(result))
    return result.exitCode
  } catch (error) {
    const result = errorResult(error, EXIT.OPERATIONAL_ERROR)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return EXIT.OPERATIONAL_ERROR
  }
}

if (require.main === module) process.exitCode = main()

module.exports = {
  EXIT,
  MANAGED_HOOK,
  MANAGED_HOOK_SHA256,
  REJECT_TARGET_NAME,
  applyChildEnvironment,
  applyPushRewrite,
  buildChildEnvironmentSpec,
  createSafeChildGitEnvironment,
  discoverRepository,
  inspect,
  loadEnforcementProof,
  localPathFromUrl,
  main,
  parseArgs,
  verifyCodexEnforcementProof,
}
