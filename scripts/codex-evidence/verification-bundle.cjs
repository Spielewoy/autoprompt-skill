'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const {
  atomicWriteFile,
  canonicalStringify,
  exactKeys,
  fail,
  hashPattern,
  isoDate,
  nonEmpty,
  sha256,
} = require('../benchmark-evidence/core.cjs')

const EXECUTION_SCHEMA = 'codex-verification-execution.v1'
const REVIEW_SCHEMA = 'codex-verification-review.v1'
const BUNDLE_SCHEMA = 'codex-verification-bundle.v1'
const DEFAULT_EVIDENCE_ROOT = 'evidence/codex-verification-bundles'
const DEFAULT_GOVERNANCE_ROOT = 'evidence/codex-verification-indexes'
const COMMAND_OUTPUT_SCHEMA = 'codex-verification-command-output.v1'
const OUTPUT_SUMMARY_SCHEMA = 'codex-verification-output-summary.v1'
const MAX_CAPTURE_BYTES = 1024 * 1024
const MAX_CAPTURE_DURATION_MS = 120 * 1000
const MAX_DIAGNOSTIC_LINES = 8
const MAX_DIAGNOSTIC_CHARS = 240
const GOVERNANCE_OUTPUTS = new Set([
  'AUTOPROMPT-IMPLEMENTATION-COVERAGE.json',
  'CODEX-IMPLEMENTATION-EVIDENCE.json',
])
const SENSITIVE_NAME = /(?:^|_)(?:AUTH|BEARER|COOKIE|CREDENTIAL|KEY|PASS(?:WORD)?|PRIVATE|PWD|SECRET|SESSION|SIGNATURE|TOKEN)(?:_|$)/i
const SENSITIVE_OUTPUT_PATTERNS = [
  /-----BEGIN (?:ENCRYPTED |RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\bnpm_[A-Za-z0-9]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}={0,2}\b/i,
  /\b(?:api[_-]?key|auth[_-]?token|password|secret(?:[_-]?access[_-]?key)?|session[_-]?token|token)\s*[:=]\s*["']?[^\s'",}]{8,}/i,
  /(?:^|\s)(?:_authToken|always-auth)\s*=\s*[^\s'\"]{8,}/im,
]
const HOST_ENVIRONMENT_ALLOWLIST = new Set([
  'COMSPEC', 'LANG', 'LC_ALL', 'LC_CTYPE', 'NUMBER_OF_PROCESSORS', 'OS', 'PATH', 'PATHEXT',
  'PROCESSOR_ARCHITECTURE', 'SYSTEMROOT', 'TERM', 'TZ', 'WINDIR',
])
const SAFE_ENVIRONMENT_VALUES = new Set([
  'CI', 'LANG', 'LC_ALL', 'LC_CTYPE', 'NUMBER_OF_PROCESSORS', 'OS',
  'PROCESSOR_ARCHITECTURE', 'TERM', 'TZ',
])
const SYNTHETIC_ENVIRONMENT_NAMES = new Set([
  'APPDATA', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE', 'AZURE_CONFIG_DIR', 'CI', 'CODEX_HOME',
  'DOCKER_CONFIG', 'FORCE_COLOR', 'GH_CONFIG_DIR', 'GIT_CONFIG_GLOBAL', 'HOME', 'KUBECONFIG',
  'LOCALAPPDATA', 'NO_COLOR', 'NPM_CONFIG_CACHE', 'NPM_CONFIG_USERCONFIG', 'TEMP', 'TMP', 'TMPDIR',
  'USERPROFILE', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
])
const TELEMETRY_ENVIRONMENT_NAMES = /(?:^|_)(?:HOME|PROFILE|USER(?:NAME)?|LOGNAME|SESSION|THREAD|TRACE|REQUEST|APPDATA|CONFIG|CACHE|TEMP|TMP)(?:_|$)/i
const ALLOWED_LONG_OUTPUT_TOKENS = new Set([
  COMMAND_OUTPUT_SCHEMA,
  OUTPUT_SUMMARY_SCHEMA,
  'allowlisted-structured-json',
])
const HASH_FIELDS = [
  'bundle_hash', 'candidate_hash', 'post_candidate_hash', 'command_hash', 'environment_hash', 'execution_hash',
  'raw_output_sha256', 'stderr_sha256', 'candidate_manifest_sha256', 'environment_manifest_sha256',
  'execution_record_sha256', 'reviewer_verdict_sha256', 'finding_registry_sha256',
]

function canonicalBytes(value) {
  return Buffer.from(`${canonicalStringify(value)}\n`, 'utf8')
}

function normalizeRepositoryPath(value, label = 'repository path') {
  nonEmpty(value, 'CODEX_EVIDENCE_PATH_INVALID', label)
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '')
  if (!normalized || normalized === '.' || path.posix.isAbsolute(normalized) || normalized === '..' ||
      normalized.startsWith('../') || normalized.includes('/../')) {
    fail('CODEX_EVIDENCE_PATH_INVALID', `${label} must be a non-root repository-relative path`, { value })
  }
  return normalized
}

function canonicalEvidenceRoot(value) {
  const normalized = normalizeRepositoryPath(value || DEFAULT_EVIDENCE_ROOT, 'evidence root')
  if (normalized !== DEFAULT_EVIDENCE_ROOT) {
    fail('CODEX_EVIDENCE_PATH_INVALID', `evidence root is fixed at ${DEFAULT_EVIDENCE_ROOT}; candidate exclusions are not configurable`)
  }
  return normalized
}

function inside(root, target, label) {
  const relative = path.relative(root, target)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail('CODEX_EVIDENCE_PATH_INVALID', `${label} must stay inside the repository`, { target })
  }
  return relative.replaceAll('\\', '/') || '.'
}

function git(repo, args, options = {}) {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: options.encoding === undefined ? null : options.encoding,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (options.allowFailure) return result
  if (result.status !== 0) {
    fail('CODEX_EVIDENCE_GIT_FAILED', `git ${args[0]} failed`, {
      status: result.status,
      stderr: Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : result.stderr,
    })
  }
  return result
}

function gitRoot(repo) {
  const result = git(path.resolve(repo), ['rev-parse', '--show-toplevel'], { encoding: 'utf8' })
  return path.resolve(result.stdout.trim())
}

function decodeGitPaths(buffer, label) {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const paths = []
  for (const part of buffer.subarray(0, buffer.length && buffer.at(-1) === 0 ? -1 : undefined).toString('binary').split('\0')) {
    if (!part) continue
    try {
      paths.push(decoder.decode(Buffer.from(part, 'binary')))
    } catch {
      fail('CODEX_EVIDENCE_PATH_ENCODING_UNSUPPORTED', `${label} contains a non-UTF-8 path`)
    }
  }
  return paths
}

function governanceFailure(message, details = {}) {
  fail('CODEX_EVIDENCE_GOVERNANCE_INVALID', message, details)
}

function readGovernanceJson(filename, name) {
  try {
    const value = JSON.parse(fs.readFileSync(filename, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('root must be an object')
    return value
  } catch (error) {
    governanceFailure(`verification governance JSON is invalid: ${name}`, { cause: error.message })
  }
}

function validateGovernanceCommon(record, name) {
  if (record.scope !== 'codex-only' || !hashPattern(record.candidate_hash)) {
    governanceFailure(`verification governance record has invalid scope or candidate hash: ${name}`)
  }
}

function governanceEntries(root) {
  const governanceRoot = path.join(root, ...DEFAULT_GOVERNANCE_ROOT.split('/'))
  if (!fs.existsSync(governanceRoot)) return []
  const rootStat = fs.lstatSync(governanceRoot)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    governanceFailure('verification governance root must be a regular directory')
  }
  const indexes = new Map()
  const historical = []
  const entries = []
  for (const name of fs.readdirSync(governanceRoot).sort()) {
    const indexMatch = /^(FINAL\d+)-SEALED-INDEX\.json$/.exec(name)
    const historicalMatch = /^(FINAL\d+)-HISTORICAL-NON-PROMOTABLE\.json$/.exec(name)
    if (!indexMatch && !historicalMatch) {
      governanceFailure(`unexpected verification governance entry: ${name}`)
    }
    const absolute = path.join(governanceRoot, name)
    const stat = fs.lstatSync(absolute)
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
      governanceFailure(`verification governance entry must be a regular file: ${name}`)
    }
    const bytes = fs.readFileSync(absolute)
    const record = readGovernanceJson(absolute, name)
    validateGovernanceCommon(record, name)
    if (indexMatch) {
      if (record.schema_version !== 'codex-verification-sealed-index.v1' ||
          record.status !== 'SEALED_PASS_WITH_DECLARED_EXCLUSIONS') {
        governanceFailure(`verification governance sealed index has invalid schema or status: ${name}`)
      }
      indexes.set(indexMatch[1], { name, record, sha256: sha256(bytes) })
    } else {
      if (record.schema_version !== 'codex-verification-historical-marker.v1' ||
          record.status !== 'HISTORICAL_NON_PROMOTABLE' || record.promotion_forbidden !== true) {
        governanceFailure(`verification governance historical marker has invalid schema or status: ${name}`)
      }
      historical.push({ generation: historicalMatch[1], name, record })
    }
    entries.push(`${DEFAULT_GOVERNANCE_ROOT}/${name}`)
  }
  for (const marker of historical) {
    const index = indexes.get(marker.generation)
    if (!index) governanceFailure(`verification governance historical marker has no matching sealed index: ${marker.name}`)
    const references = [marker.record.covered_sealed_index, marker.record.sealed_index]
      .filter(value => value !== undefined)
    if (references.length !== 1 || !references[0] || typeof references[0] !== 'object' || Array.isArray(references[0])) {
      governanceFailure(`verification governance historical marker has invalid sealed-index binding: ${marker.name}`)
    }
    const reference = references[0]
    const normalizedPath = typeof reference.path === 'string' ? reference.path.replaceAll('\\', '/') : ''
    const canonicalPath = `${DEFAULT_GOVERNANCE_ROOT}/${index.name}`
    const preservedLegacyPath = `${DEFAULT_EVIDENCE_ROOT}/${index.name}`
    if (![canonicalPath, preservedLegacyPath].includes(normalizedPath) || reference.sha256 !== index.sha256 ||
        marker.record.candidate_hash !== index.record.candidate_hash) {
      governanceFailure(`verification governance historical marker does not bind its matching sealed index: ${marker.name}`)
    }
  }
  return entries
}

function verificationGovernanceEntries(repo) {
  return governanceEntries(gitRoot(repo))
}

function excluded(relative, evidenceRoot) {
  return GOVERNANCE_OUTPUTS.has(relative) || relative === evidenceRoot || relative.startsWith(`${evidenceRoot}/`) ||
    relative === DEFAULT_GOVERNANCE_ROOT || relative.startsWith(`${DEFAULT_GOVERNANCE_ROOT}/`)
}

function parseIndex(repo, evidenceRoot) {
  const records = decodeGitPaths(git(repo, ['ls-files', '--stage', '-z']).stdout, 'git index')
  return records.map(record => {
    const match = /^(\d{6}) ([0-9a-f]+) ([0-3])\t([\s\S]+)$/.exec(record)
    if (!match) fail('CODEX_EVIDENCE_INDEX_INVALID', 'git returned an unsupported index record')
    const [, mode, object_id, stage, filePath] = match
    if (mode === '160000') fail('CODEX_EVIDENCE_GITLINK_UNSUPPORTED', 'submodules cannot be bound as exact candidate bytes', { path: filePath })
    return { path: filePath, mode, object_id, stage: Number(stage) }
  }).filter(record => !excluded(record.path, evidenceRoot))
    .sort((left, right) => left.path.localeCompare(right.path) || left.stage - right.stage)
}

function worktreeEntry(repo, relative, indexed) {
  const absolute = path.join(repo, ...relative.split('/'))
  let stat
  try { stat = fs.lstatSync(absolute) } catch (error) {
    if (error.code === 'ENOENT') return { path: relative, kind: 'missing', mode: null, bytes: 0, sha256: null, indexed }
    throw error
  }
  if (stat.isSymbolicLink()) {
    const target = Buffer.from(fs.readlinkSync(absolute), 'utf8')
    return { path: relative, kind: 'symlink', mode: stat.mode & 0o7777, bytes: target.length, sha256: sha256(target), indexed }
  }
  if (!stat.isFile()) fail('CODEX_EVIDENCE_FILE_TYPE_UNSUPPORTED', 'candidate paths must be files or symlinks', { path: relative })
  const bytes = fs.readFileSync(absolute)
  return { path: relative, kind: 'file', mode: stat.mode & 0o7777, bytes: bytes.length, sha256: sha256(bytes), indexed }
}

function candidateSnapshot(repo, evidenceRoot = DEFAULT_EVIDENCE_ROOT) {
  const root = gitRoot(repo)
  const normalizedEvidenceRoot = canonicalEvidenceRoot(evidenceRoot)
  governanceEntries(root)
  const index = parseIndex(root, normalizedEvidenceRoot)
  const candidatePaths = new Set(index.map(record => record.path))
  const otherPaths = decodeGitPaths(git(root, ['ls-files', '--others', '--exclude-standard', '-z']).stdout, 'untracked files')
  for (const item of otherPaths) if (!excluded(item, normalizedEvidenceRoot)) candidatePaths.add(item)
  const indexByPath = new Map()
  for (const record of index) {
    if (!indexByPath.has(record.path)) indexByPath.set(record.path, [])
    indexByPath.get(record.path).push({ mode: record.mode, object_id: record.object_id, stage: record.stage })
  }
  const worktree = [...candidatePaths].sort().map(filePath => worktreeEntry(root, filePath, indexByPath.get(filePath) || []))
  const headResult = git(root, ['rev-parse', '--verify', 'HEAD'], { encoding: 'utf8', allowFailure: true })
  const head = headResult.status === 0 ? headResult.stdout.trim() : null
  const exclusions = [
    `:(exclude)${normalizedEvidenceRoot}/**`,
    `:(exclude)${DEFAULT_GOVERNANCE_ROOT}/**`,
    ...[...GOVERNANCE_OUTPUTS].sort().map(item => `:(exclude)${item}`),
  ]
  const stagedResult = git(root, ['diff', '--cached', '--quiet', '--', '.', ...exclusions], { allowFailure: true })
  const unstagedResult = git(root, ['diff', '--quiet', '--', '.', ...exclusions], { allowFailure: true })
  if (![0, 1].includes(stagedResult.status) || ![0, 1].includes(unstagedResult.status)) {
    fail('CODEX_EVIDENCE_GIT_FAILED', 'git could not classify the candidate dirty state')
  }
  const staged = stagedResult.status === 1
  const unstaged = unstagedResult.status === 1
  const untracked = worktree.some(entry => entry.indexed.length === 0)
  const snapshot = {
    schema_version: 'codex-candidate-snapshot.v1',
    hash_algorithm: 'sha256-canonical-json-v1',
    repository_object_format: git(root, ['rev-parse', '--show-object-format'], { encoding: 'utf8' }).stdout.trim(),
    head,
    dirty: head === null || staged || unstaged || untracked,
    dirty_kinds: { staged, unstaged, untracked },
    excluded_paths: [...GOVERNANCE_OUTPUTS].sort().concat(`${normalizedEvidenceRoot}/`, `${DEFAULT_GOVERNANCE_ROOT}/`),
    excluded_kinds: ['fixed-governance-outputs', 'evidence-bundle-root', 'validated-verification-governance', 'git-metadata', 'gitignored-files'],
    index,
    worktree,
  }
  return { root, snapshot, hash: sha256(canonicalStringify(snapshot)) }
}

function environmentSnapshot(environment, privateRoot = path.join(os.tmpdir(), 'autoprompt-codex-evidence-private')) {
  const variables = {}
  const removedVariables = []
  const passedVariables = []
  const childEnvironment = {}
  const sensitiveValues = []
  const sensitiveArgumentValues = []
  const telemetryValues = []
  for (const name of Object.keys(environment).sort()) {
    const raw = environment[name]
    const value = raw === undefined ? '' : String(raw)
    const sensitive = SENSITIVE_NAME.test(name)
    const credentialShaped = SENSITIVE_OUTPUT_PATTERNS.some(pattern => pattern.test(value))
    const upperName = name.toUpperCase()
    const allowed = !sensitive && !credentialShaped &&
      (HOST_ENVIRONMENT_ALLOWLIST.has(upperName) || /^LC_[A-Z0-9_]+$/.test(upperName))
    if (!allowed) {
      variables[name] = sensitive || credentialShaped ? '<redacted-sensitive-value>' : '<redacted-value>'
      removedVariables.push(name)
      if ((sensitive || credentialShaped) && value.length >= 4) {
        sensitiveValues.push(Buffer.from(value, 'utf8'))
        sensitiveArgumentValues.push(Buffer.from(value, 'utf8'))
      }
      if (TELEMETRY_ENVIRONMENT_NAMES.test(name) && value.length >= 3) telemetryValues.push(value)
      continue
    }
    childEnvironment[name] = value
    passedVariables.push(name)
    variables[name] = SAFE_ENVIRONMENT_VALUES.has(upperName) ? value : '<redacted-value>'
  }

  const privateHome = path.join(privateRoot, 'home')
  const privateConfig = path.join(privateHome, 'config')
  const privateCache = path.join(privateHome, 'cache')
  const privateTemporary = path.join(privateHome, 'tmp')
  for (const directory of [privateHome, privateConfig, privateCache, privateTemporary]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  }
  const synthetic = {
    APPDATA: path.join(privateConfig, 'appdata'),
    AWS_CONFIG_FILE: path.join(privateConfig, 'aws', 'config'),
    AWS_SHARED_CREDENTIALS_FILE: path.join(privateConfig, 'aws', 'credentials'),
    AZURE_CONFIG_DIR: path.join(privateConfig, 'azure'),
    CI: '1',
    CODEX_HOME: path.join(privateConfig, 'codex'),
    DOCKER_CONFIG: path.join(privateConfig, 'docker'),
    FORCE_COLOR: '0',
    GH_CONFIG_DIR: path.join(privateConfig, 'gh'),
    GIT_CONFIG_GLOBAL: path.join(privateConfig, 'gitconfig'),
    HOME: privateHome,
    KUBECONFIG: path.join(privateConfig, 'kube', 'config'),
    LOCALAPPDATA: path.join(privateConfig, 'localappdata'),
    NO_COLOR: '1',
    NPM_CONFIG_CACHE: path.join(privateCache, 'npm'),
    NPM_CONFIG_USERCONFIG: path.join(privateConfig, 'npmrc'),
    TEMP: privateTemporary,
    TMP: privateTemporary,
    TMPDIR: privateTemporary,
    USERPROFILE: privateHome,
    XDG_CACHE_HOME: path.join(privateCache, 'xdg'),
    XDG_CONFIG_HOME: path.join(privateConfig, 'xdg'),
    XDG_DATA_HOME: path.join(privateHome, 'data'),
  }
  for (const directory of [
    synthetic.APPDATA,
    synthetic.AZURE_CONFIG_DIR,
    synthetic.CODEX_HOME,
    synthetic.DOCKER_CONFIG,
    synthetic.GH_CONFIG_DIR,
    synthetic.LOCALAPPDATA,
    synthetic.NPM_CONFIG_CACHE,
    synthetic.XDG_CACHE_HOME,
    synthetic.XDG_CONFIG_HOME,
    synthetic.XDG_DATA_HOME,
    path.dirname(synthetic.AWS_CONFIG_FILE),
    path.dirname(synthetic.KUBECONFIG),
  ]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  for (const [name, value] of Object.entries(synthetic)) {
    childEnvironment[name] = value
    if (!passedVariables.includes(name)) passedVariables.push(name)
    if (!Object.hasOwn(variables, name)) variables[name] = name === 'CI' ? value : '<synthetic-private-value>'
    if (!['CI', 'FORCE_COLOR', 'NO_COLOR'].includes(name)) telemetryValues.push(value)
  }
  passedVariables.sort()
  const snapshot = {
    schema_version: 'codex-redacted-environment.v1',
    hash_algorithm: 'sha256-canonical-json-v1',
    redaction_policy: {
      sensitive_name_pattern: SENSITIVE_NAME.source,
      non_allowlisted_values_removed_from_child: true,
      redacted_values_are_not_hashed_individually: true,
      safe_value_allowlist: [...SAFE_ENVIRONMENT_VALUES].sort(),
      child_environment_name_allowlist: [...HOST_ENVIRONMENT_ALLOWLIST, ...SYNTHETIC_ENVIRONMENT_NAMES].sort(),
    },
    execution_isolation: {
      host_home_and_config_inherited: false,
      network: 'restricted-by-codex-sandbox',
      permission_profile: ':workspace',
      sandbox_launcher: 'codex-cli',
      synthetic_private_home: true,
    },
    runtime: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
    },
    variables,
    removed_variable_names: removedVariables,
    passed_variable_names: passedVariables,
  }
  return {
    snapshot,
    hash: sha256(canonicalStringify(snapshot)),
    childEnvironment,
    sensitiveValues,
    sensitiveArgumentValues,
    telemetryValues: [...new Set(telemetryValues)].sort((left, right) => right.length - left.length),
  }
}

function assertNoSecretArguments(argv, sensitiveValues) {
  for (const argument of argv) {
    if (/^--?(?:auth|bearer|cookie|credential|key|pass(?:word)?|private|pwd|secret|session|signature|token)(?:(?:=|:).*)?$/i.test(argument)) {
      fail('CODEX_EVIDENCE_SECRET_ARGUMENT', 'secret-bearing command arguments are forbidden')
    }
    const bytes = Buffer.from(argument, 'utf8')
    if (sensitiveValues.some(secret => bytes.includes(secret))) {
      fail('CODEX_EVIDENCE_SECRET_ARGUMENT', 'a command argument contains a sensitive environment value')
    }
    if (SENSITIVE_OUTPUT_PATTERNS.some(pattern => pattern.test(argument))) {
      fail('CODEX_EVIDENCE_SECRET_ARGUMENT', 'a command argument resembles a credential')
    }
    // Treat separators in absolute paths as token boundaries. Otherwise a
    // normal deep path can look like one high-entropy Base64 token even when
    // every individual path component is ordinary prose.
    const opaqueTokenInput = path.isAbsolute(argument) || /^[A-Za-z]:[\\/]/.test(argument) || /^\\\\/.test(argument)
      ? argument.replace(/[\\/]+/g, ' ')
      : argument
    for (const match of opaqueTokenInput.matchAll(/[A-Za-z0-9_+\/=.-]{24,}/g)) {
      const token = match[0]
      if (ALLOWED_LONG_OUTPUT_TOKENS.has(token) || /^[a-f0-9]{64}$/i.test(token) || /^process\.env\.[A-Z0-9_]+$/i.test(token)) continue
      const classes = [/[a-z]/.test(token), /[A-Z]/.test(token), /\d/.test(token), /[_+\/=.-]/.test(token)]
        .filter(Boolean).length
      if (classes >= 2 && (token.length >= 40 || tokenEntropy(token) >= 3.25)) {
        fail('CODEX_EVIDENCE_SECRET_ARGUMENT', 'a command argument contains an unrecognized credential-shaped token')
      }
    }
  }
}

function decodedOutput(bytes, stream) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (/\u0000|[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
      fail('CODEX_EVIDENCE_BINARY_OUTPUT', 'binary or control-character command output is forbidden', { stream })
    }
    return text
  } catch (error) {
    if (error && error.code) throw error
    fail('CODEX_EVIDENCE_BINARY_OUTPUT', 'command output is not canonical UTF-8 text', { stream })
  }
}

function tokenEntropy(value) {
  const counts = new Map()
  for (const character of value) counts.set(character, (counts.get(character) || 0) + 1)
  let entropy = 0
  for (const count of counts.values()) {
    const probability = count / value.length
    entropy -= probability * Math.log2(probability)
  }
  return entropy
}

function assertNoCredentialOutput(bytes, text, sensitiveValues, telemetryValues, stream) {
  if (sensitiveValues.some(secret => bytes.includes(secret))) {
    fail('CODEX_EVIDENCE_SECRET_OUTPUT', 'command output contains a sensitive inherited value; no evidence was persisted', { stream })
  }
  const inspected = sanitizeDiagnostic(text, telemetryValues)
  if (SENSITIVE_OUTPUT_PATTERNS.some(pattern => pattern.test(inspected))) {
    fail('CODEX_EVIDENCE_SECRET_OUTPUT', 'command output resembles a credential; no evidence was persisted', { stream })
  }
  for (const match of inspected.matchAll(/[A-Za-z0-9_+\/=.-]{24,}/g)) {
    const token = match[0]
    if (ALLOWED_LONG_OUTPUT_TOKENS.has(token) || /^[a-f0-9]{64}$/i.test(token)) continue
    const classes = [/[a-z]/.test(token), /[A-Z]/.test(token), /\d/.test(token), /[_+\/=.-]/.test(token)]
      .filter(Boolean).length
    const opaqueBase64 = token.length >= 40 && classes >= 2 && /^[A-Za-z0-9_+\/=.-]+$/.test(token)
    if (opaqueBase64 || (token.length >= 32 && classes >= 2 && tokenEntropy(token) >= 3.25)) {
      fail('CODEX_EVIDENCE_SECRET_OUTPUT', 'command output contains an unrecognized credential-shaped token; no evidence was persisted', { stream })
    }
  }
}

function sanitizeDiagnostic(value, telemetryValues) {
  let text = value.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, '')
  for (const telemetry of telemetryValues) {
    if (telemetry) text = text.replaceAll(telemetry, '<redacted-host-value>')
  }
  text = text
    .replace(/<redacted-host-value>(?:[\\/][^\s|"']+)+/g, '<redacted-path>')
    .replace(/\b(?:session|thread|trace|request)[_-]?id\s*[:=]\s*[^\s|]+/ig, '<redacted-session>')
    .replace(/\b(?:session|thread|trace|request)-[A-Za-z0-9._-]{8,}/ig, '<redacted-session>')
    .replace(/file:\/\/\/[^\s|"']+/ig, '<redacted-path>')
    .replace(/[A-Za-z]:\\[^\r\n|"']+/g, '<redacted-path>')
    .replace(/(^|[\s|])\/[^\s|"']+/g,
      (_match, prefix) => `${prefix}<redacted-path>`)
  if (text.length > MAX_DIAGNOSTIC_CHARS) text = `${text.slice(0, MAX_DIAGNOSTIC_CHARS - 14)}<truncated>`
  return text
}

function recordedCommandArguments(argv, telemetryValues) {
  return argv.map((argument, index) => {
    let recorded = sanitizeDiagnostic(argument, telemetryValues)
    if (path.isAbsolute(argument)) {
      recorded = index === 0
        ? `<absolute-executable>/${path.basename(argument)}`
        : '<redacted-path>'
    }
    return recorded
  })
}

function structuredEvidence(text, telemetryValues) {
  let value
  try { value = JSON.parse(text) } catch { return null }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  exactKeys(value, ['schema_version', 'result', 'checks'], 'CODEX_EVIDENCE_OUTPUT_INVALID', 'structured command output')
  if (value.schema_version !== COMMAND_OUTPUT_SCHEMA || !['PASS', 'FAIL'].includes(value.result) ||
      !Array.isArray(value.checks) || value.checks.length === 0 || value.checks.length > 128) {
    fail('CODEX_EVIDENCE_OUTPUT_INVALID', 'structured command output has an unsupported schema, result, or check list')
  }
  const seen = new Set()
  const checks = value.checks.map(check => {
    exactKeys(check, ['id', 'result', 'summary'], 'CODEX_EVIDENCE_OUTPUT_INVALID', 'structured command check')
    if (!check || typeof check !== 'object' || Array.isArray(check) ||
        typeof check.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(check.id) || seen.has(check.id) ||
        !['PASS', 'FAIL'].includes(check.result) || typeof check.summary !== 'string' ||
        check.summary.trim().length === 0 || check.summary.length > 512) {
      fail('CODEX_EVIDENCE_OUTPUT_INVALID', 'structured command output contains a malformed or duplicate check')
    }
    seen.add(check.id)
    return { id: check.id, result: check.result, summary: sanitizeDiagnostic(check.summary.trim(), telemetryValues) }
  })
  if ((value.result === 'PASS') !== checks.every(check => check.result === 'PASS')) {
    fail('CODEX_EVIDENCE_OUTPUT_INVALID', 'structured command result must agree with every check result')
  }
  return { schema_version: COMMAND_OUTPUT_SCHEMA, result: value.result, checks }
}

function outputSummary(bytes, stream, sensitiveValues, telemetryValues) {
  const text = decodedOutput(bytes, stream)
  assertNoCredentialOutput(bytes, text, sensitiveValues, telemetryValues, stream)
  const evidence = stream === 'stdout' && text.trim() ? structuredEvidence(text.trim(), telemetryValues) : null
  const diagnostics = evidence ? [] : text.split(/\r?\n/)
    .map(line => sanitizeDiagnostic(line, telemetryValues).trim())
    .filter(Boolean)
    .slice(0, MAX_DIAGNOSTIC_LINES)
  return canonicalBytes({
    schema_version: OUTPUT_SUMMARY_SCHEMA,
    stream,
    source_bytes: bytes.length,
    source_sha256: sha256(bytes),
    content_kind: evidence ? 'allowlisted-structured-json' : 'redacted-diagnostics',
    structured_evidence: evidence,
    diagnostics,
  })
}

function fileRecord(filename) {
  const stat = fs.lstatSync(filename)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    fail('CODEX_EVIDENCE_ARTIFACT_TYPE_INVALID', 'bundle artifacts must be regular, non-hardlinked files', { filename })
  }
  const bytes = fs.readFileSync(filename)
  return { bytes: bytes.length, sha256: sha256(bytes) }
}

function safeId(value, label) {
  nonEmpty(value, 'CODEX_EVIDENCE_ID_INVALID', label)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]{2,255}$/.test(value)) fail('CODEX_EVIDENCE_ID_INVALID', `${label} has unsupported characters`)
  return value
}

function executionDigest(record) {
  const copy = { ...record }
  delete copy.execution_hash
  return sha256(canonicalStringify(copy))
}

function bundleDigest(record) {
  const copy = { ...record }
  for (const field of [
    'id', 'bundle_hash', 'bundle_path', 'raw_output_path', 'stderr_path', 'candidate_manifest_path',
    'environment_manifest_path', 'execution_record_path', 'reviewer_verdict_path', 'finding_registry_path',
  ]) delete copy[field]
  return sha256(canonicalStringify(copy))
}

function artifactRelativePaths(bundleHash, evidenceRoot) {
  const base = `${evidenceRoot}/${bundleHash}`
  return {
    bundle_path: `${base}/bundle.json`,
    raw_output_path: `${base}/stdout.bin`,
    stderr_path: `${base}/stderr.bin`,
    candidate_manifest_path: `${base}/candidate.json`,
    environment_manifest_path: `${base}/environment.json`,
    execution_record_path: `${base}/execution.json`,
    reviewer_verdict_path: `${base}/reviewer-verdict.json`,
    finding_registry_path: `${base}/finding-registry.json`,
  }
}

function appendOnlyDirectory(target, files) {
  if (fs.existsSync(target)) {
    const expectedNames = Object.keys(files).sort()
    const actualNames = fs.readdirSync(target).sort()
    if (canonicalStringify(expectedNames) !== canonicalStringify(actualNames)) {
      fail('CODEX_EVIDENCE_APPEND_ONLY_CONFLICT', 'content-addressed directory already exists with different entries', { target })
    }
    for (const [name, bytes] of Object.entries(files)) {
      if (!fs.readFileSync(path.join(target, name)).equals(bytes)) {
        fail('CODEX_EVIDENCE_APPEND_ONLY_CONFLICT', 'content-addressed directory already exists with different bytes', { target, name })
      }
    }
    return false
  }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const temporary = path.join(path.dirname(target), `.tmp-${path.basename(target)}-${process.pid}-${crypto.randomBytes(8).toString('hex')}`)
  fs.mkdirSync(temporary, { mode: 0o700 })
  try {
    for (const [name, bytes] of Object.entries(files)) atomicWriteFile(path.join(temporary, name), bytes)
    fs.renameSync(temporary, target)
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
  return true
}

function resolveCwd(repo, value = '.') {
  const absolute = path.resolve(repo, value)
  const relative = inside(repo, absolute, 'command cwd')
  if (!fs.statSync(absolute).isDirectory()) fail('CODEX_EVIDENCE_PATH_INVALID', 'command cwd must be a directory')
  return { absolute, relative }
}

function regularFile(filename) {
  try {
    const stat = fs.lstatSync(filename)
    return stat.isFile() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

function codexSandboxLauncher(environment = process.env) {
  const packageRoots = []
  if (environment.CODEX_MANAGED_PACKAGE_ROOT) packageRoots.push(path.resolve(environment.CODEX_MANAGED_PACKAGE_ROOT))
  if (process.platform === 'win32' && environment.APPDATA) {
    packageRoots.push(path.join(environment.APPDATA, 'npm', 'node_modules', '@openai', 'codex'))
  }
  for (const root of packageRoots) {
    const cli = path.join(root, 'bin', 'codex.js')
    if (regularFile(cli)) return { command: process.execPath, prefix: [cli] }
  }

  const lookup = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['codex'], {
    encoding: 'utf8',
    env: environment,
    windowsHide: true,
  })
  if (lookup.status === 0) {
    for (const candidate of lookup.stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
      if (!regularFile(candidate)) continue
      const directory = path.dirname(candidate)
      const npmCli = path.join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
      if (regularFile(npmCli)) return { command: process.execPath, prefix: [npmCli] }
      if (!/\.(?:cmd|ps1)$/i.test(candidate)) return { command: candidate, prefix: [] }
    }
  }
  fail('CODEX_EVIDENCE_NETWORK_ISOLATION_UNAVAILABLE', 'Codex command sandbox is unavailable; network isolation cannot be claimed')
}

async function runBounded(command, args, options) {
  return new Promise((resolve, reject) => {
    const captureRoot = path.resolve(options.captureRoot)
    const stdoutPath = path.join(captureRoot, 'stdout.raw')
    const stderrPath = path.join(captureRoot, 'stderr.raw')
    const stdoutFd = fs.openSync(stdoutPath, 'wx', 0o600)
    const stderrFd = fs.openSync(stderrPath, 'wx', 0o600)
    let exceeded = null
    let timedOut = false
    let settled = false
    const closeDescriptors = () => {
      for (const descriptor of [stdoutFd, stderrFd]) {
        try { fs.closeSync(descriptor) } catch {}
      }
    }
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      // Codex sandbox 0.149 does not reliably relay an inner process through
      // Node-created pipe streams. Inheritable private file descriptors keep
      // the exact stdout/stderr bytes across that process boundary.
      stdio: ['ignore', stdoutFd, stderrFd],
    })
    const monitor = setInterval(() => {
      for (const [stream, descriptor] of [['stdout', stdoutFd], ['stderr', stderrFd]]) {
        try {
          if (fs.fstatSync(descriptor).size > MAX_CAPTURE_BYTES) {
            exceeded = exceeded || stream
            child.kill('SIGKILL')
          }
        } catch {}
      }
    }, 25)
    monitor.unref()
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, options.timeoutMs || MAX_CAPTURE_DURATION_MS)
    timeout.unref()
    const clearBounds = () => {
      clearInterval(monitor)
      clearTimeout(timeout)
    }
    child.once('error', error => {
      if (settled) return
      settled = true
      clearBounds()
      closeDescriptors()
      reject(Object.assign(error, { evidenceSandboxLaunch: true }))
    })
    child.once('close', (code, signal) => {
      if (settled) return
      settled = true
      clearBounds()
      closeDescriptors()
      const stdout = fs.readFileSync(stdoutPath)
      const stderr = fs.readFileSync(stderrPath)
      if (stdout.length > MAX_CAPTURE_BYTES) exceeded = exceeded || 'stdout'
      if (stderr.length > MAX_CAPTURE_BYTES) exceeded = exceeded || 'stderr'
      resolve({ code, signal, exceeded, timedOut, stdout, stderr })
    })
  })
}

async function captureExecution(options) {
  const repo = gitRoot(options.repo || process.cwd())
  const evidenceRoot = canonicalEvidenceRoot(options.evidenceRoot)
  const runnerId = safeId(options.runnerId, 'runner_id')
  if (!Array.isArray(options.commandArgv) || options.commandArgv.length === 0) fail('CODEX_EVIDENCE_COMMAND_INVALID', 'command argv must not be empty')
  const commandArgv = options.commandArgv.map(value => String(value))
  const cwd = resolveCwd(repo, options.cwd || '.')
  const before = candidateSnapshot(repo, evidenceRoot)
  const executionRoot = path.resolve(options.executionRoot || path.join(os.tmpdir(), 'autoprompt-codex-evidence-executions'))
  const executionRootRelative = path.relative(repo, executionRoot)
  if (executionRootRelative === '' || (!executionRootRelative.startsWith(`..${path.sep}`) && executionRootRelative !== '..' && !path.isAbsolute(executionRootRelative))) {
    fail('CODEX_EVIDENCE_PATH_INVALID', 'execution root must stay outside the repository so raw command bytes never enter repository evidence')
  }
  fs.mkdirSync(executionRoot, { recursive: true })
  const temporary = fs.mkdtempSync(path.join(executionRoot, '.capture-'))
  const startedAt = new Date().toISOString()
  let outcome
  try {
    const environment = environmentSnapshot(process.env, path.join(temporary, 'private'))
    assertNoSecretArguments(commandArgv, environment.sensitiveArgumentValues)
    const launcher = codexSandboxLauncher(process.env)
    const sandboxArgs = [
      ...launcher.prefix,
      'sandbox',
      '--permission-profile', ':workspace',
      '--sandbox-state-disable-network',
      '-C', cwd.absolute,
      '--',
      ...commandArgv,
    ]
    try {
      outcome = await runBounded(launcher.command, sandboxArgs, {
        cwd: cwd.absolute,
        captureRoot: temporary,
        env: environment.childEnvironment,
      })
    } catch (error) {
      fail('CODEX_EVIDENCE_NETWORK_ISOLATION_UNAVAILABLE', 'Codex command sandbox could not be launched; network isolation cannot be claimed', {
        cause: error.message,
      })
    }
    if (outcome.exceeded) {
      fail('CODEX_EVIDENCE_OUTPUT_LIMIT', `command ${outcome.exceeded} exceeded the fail-closed ${MAX_CAPTURE_BYTES}-byte capture limit`)
    }
    if (outcome.timedOut) {
      fail('CODEX_EVIDENCE_EXECUTION_TIMEOUT', `command exceeded the fail-closed ${MAX_CAPTURE_DURATION_MS}ms execution limit`)
    }
    if (outcome.code === 0 && outcome.stdout.length === 0 && outcome.stderr.length === 0) {
      fail('CODEX_EVIDENCE_TRANSPORT_NO_RESULT', 'exit-zero verification produced no observable stdout or stderr evidence')
    }
    const stdoutBytes = outputSummary(outcome.stdout, 'stdout', environment.sensitiveValues, environment.telemetryValues)
    const stderrBytes = outputSummary(outcome.stderr, 'stderr', environment.sensitiveValues, environment.telemetryValues)
    const after = candidateSnapshot(repo, evidenceRoot)
    const stdoutRecord = { bytes: stdoutBytes.length, sha256: sha256(stdoutBytes) }
    const stderrRecord = { bytes: stderrBytes.length, sha256: sha256(stderrBytes) }
    const candidateBytes = canonicalBytes(before.snapshot)
    const environmentBytes = canonicalBytes(environment.snapshot)
    const recordedCommandArgv = recordedCommandArguments(commandArgv, environment.telemetryValues)
    const commandHash = sha256(canonicalStringify({ command_argv: recordedCommandArgv, cwd: cwd.relative }))
    const execution = {
      schema_version: EXECUTION_SCHEMA,
      execution_hash: null,
      runner_id: runnerId,
      command_argv: recordedCommandArgv,
      command_hash: commandHash,
      cwd: cwd.relative,
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      exit_code: Number.isInteger(outcome.code) ? outcome.code : null,
      signal: outcome.signal || null,
      candidate_hash: before.hash,
      post_candidate_hash: after.hash,
      candidate_unchanged: before.hash === after.hash,
      candidate_manifest_path: 'candidate.json',
      candidate_manifest_sha256: sha256(candidateBytes),
      environment_hash: environment.hash,
      environment_manifest_path: 'environment.json',
      environment_manifest_sha256: sha256(environmentBytes),
      raw_output_path: 'stdout.bin',
      raw_output_sha256: stdoutRecord.sha256,
      raw_output_bytes: stdoutRecord.bytes,
      stderr_path: 'stderr.bin',
      stderr_sha256: stderrRecord.sha256,
      stderr_bytes: stderrRecord.bytes,
      redaction: {
        sensitive_variables_removed: environment.snapshot.removed_variable_names,
        secret_output_scan: 'PASS',
        raw_output_truncated: false,
      },
    }
    execution.execution_hash = executionDigest(execution)
    const files = {
      'candidate.json': candidateBytes,
      'environment.json': environmentBytes,
      'execution.json': canonicalBytes(execution),
      'stderr.bin': stderrBytes,
      'stdout.bin': stdoutBytes,
    }
    const target = path.join(executionRoot, execution.execution_hash)
    appendOnlyDirectory(target, files)
    return { execution, path: target }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
}

function readJson(filename, code) {
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')) } catch (error) {
    fail(code, `cannot parse ${filename}`, { cause: error.message })
  }
}

function executionDirectory(value) {
  const absolute = path.resolve(value)
  const stat = fs.lstatSync(absolute)
  if (stat.isSymbolicLink()) fail('CODEX_EVIDENCE_ARTIFACT_TYPE_INVALID', 'execution path cannot be a symlink')
  const directory = stat.isDirectory() ? absolute : path.dirname(absolute)
  if (fs.lstatSync(directory).isSymbolicLink()) fail('CODEX_EVIDENCE_ARTIFACT_TYPE_INVALID', 'execution directory cannot be a symlink')
  return directory
}

function validateOutputSummary(directory, name, expectedStream) {
  const filename = path.join(directory, name)
  const summary = readJson(filename, 'CODEX_EVIDENCE_OUTPUT_INVALID')
  const fields = [
    'schema_version', 'stream', 'source_bytes', 'source_sha256', 'content_kind', 'structured_evidence', 'diagnostics',
  ]
  exactKeys(summary, fields, 'CODEX_EVIDENCE_OUTPUT_INVALID', `${expectedStream} output summary`)
  if (summary.schema_version !== OUTPUT_SUMMARY_SCHEMA || summary.stream !== expectedStream ||
      !Number.isInteger(summary.source_bytes) || summary.source_bytes < 0 || summary.source_bytes > MAX_CAPTURE_BYTES ||
      !hashPattern(summary.source_sha256) || !['allowlisted-structured-json', 'redacted-diagnostics'].includes(summary.content_kind) ||
      !Array.isArray(summary.diagnostics) || summary.diagnostics.length > MAX_DIAGNOSTIC_LINES ||
      summary.diagnostics.some(line => typeof line !== 'string' || line.length > MAX_DIAGNOSTIC_CHARS)) {
    fail('CODEX_EVIDENCE_OUTPUT_INVALID', `${expectedStream} output summary is malformed`)
  }
  if (summary.structured_evidence === null) {
    if (summary.content_kind !== 'redacted-diagnostics') fail('CODEX_EVIDENCE_OUTPUT_INVALID', 'unstructured output must be diagnostic-only')
  } else {
    if (expectedStream !== 'stdout' || summary.content_kind !== 'allowlisted-structured-json' || summary.diagnostics.length !== 0) {
      fail('CODEX_EVIDENCE_OUTPUT_INVALID', 'structured evidence is allowed only as canonical stdout without diagnostics')
    }
    const validated = structuredEvidence(JSON.stringify(summary.structured_evidence), [])
    if (canonicalStringify(validated) !== canonicalStringify(summary.structured_evidence)) {
      fail('CODEX_EVIDENCE_OUTPUT_INVALID', 'structured evidence is not canonical or contains telemetry')
    }
  }
  for (const diagnostic of summary.diagnostics) {
    assertNoCredentialOutput(Buffer.from(diagnostic), diagnostic, [], [], expectedStream)
  }
  if (summary.structured_evidence !== null) {
    const structuredBytes = Buffer.from(canonicalStringify(summary.structured_evidence))
    assertNoCredentialOutput(structuredBytes, structuredBytes.toString('utf8'), [], [], expectedStream)
  }
  return summary
}

function validateExecution(directory, options = {}) {
  const filename = path.join(directory, 'execution.json')
  const execution = readJson(filename, 'CODEX_EVIDENCE_EXECUTION_INVALID')
  const required = [
    'schema_version', 'execution_hash', 'runner_id', 'command_argv', 'command_hash', 'cwd', 'started_at', 'ended_at',
    'exit_code', 'signal', 'candidate_hash', 'post_candidate_hash', 'candidate_unchanged', 'candidate_manifest_path',
    'candidate_manifest_sha256', 'environment_hash', 'environment_manifest_path', 'environment_manifest_sha256',
    'raw_output_path', 'raw_output_sha256', 'raw_output_bytes', 'stderr_path', 'stderr_sha256', 'stderr_bytes', 'redaction',
  ]
  exactKeys(execution, required, 'CODEX_EVIDENCE_EXECUTION_INVALID', 'execution record')
  if (required.some(field => !Object.hasOwn(execution, field)) || execution.schema_version !== EXECUTION_SCHEMA) {
    fail('CODEX_EVIDENCE_EXECUTION_INVALID', 'execution record has missing fields or unsupported schema')
  }
  for (const field of ['execution_hash', 'command_hash', 'candidate_hash', 'post_candidate_hash', 'candidate_manifest_sha256', 'environment_hash', 'environment_manifest_sha256', 'raw_output_sha256', 'stderr_sha256']) {
    if (!hashPattern(execution[field])) fail('CODEX_EVIDENCE_EXECUTION_INVALID', `${field} must be sha256`)
  }
  if (execution.execution_hash !== executionDigest(execution) ||
      (options.requireAddressedPath !== false && path.basename(directory) !== execution.execution_hash)) {
    fail('CODEX_EVIDENCE_EXECUTION_TAMPERED', 'execution hash or content-addressed path is invalid')
  }
  safeId(execution.runner_id, 'runner_id')
  if (!Array.isArray(execution.command_argv) || execution.command_argv.length === 0 || execution.command_argv.some(value => typeof value !== 'string')) {
    fail('CODEX_EVIDENCE_EXECUTION_INVALID', 'command_argv must be a nonempty string array')
  }
  if (execution.command_hash !== sha256(canonicalStringify({ command_argv: execution.command_argv, cwd: execution.cwd }))) {
    fail('CODEX_EVIDENCE_EXECUTION_TAMPERED', 'command hash does not match argv and cwd')
  }
  isoDate(execution.started_at, 'CODEX_EVIDENCE_EXECUTION_INVALID', 'started_at')
  isoDate(execution.ended_at, 'CODEX_EVIDENCE_EXECUTION_INVALID', 'ended_at')
  if (Date.parse(execution.ended_at) < Date.parse(execution.started_at)) fail('CODEX_EVIDENCE_EXECUTION_INVALID', 'execution ended before it started')
  for (const [pathField, hashField, bytesField] of [
    ['raw_output_path', 'raw_output_sha256', 'raw_output_bytes'],
    ['stderr_path', 'stderr_sha256', 'stderr_bytes'],
    ['candidate_manifest_path', 'candidate_manifest_sha256', null],
    ['environment_manifest_path', 'environment_manifest_sha256', null],
  ]) {
    const expected = pathField === 'raw_output_path' ? 'stdout.bin' : pathField === 'stderr_path' ? 'stderr.bin' :
      pathField === 'candidate_manifest_path' ? 'candidate.json' : 'environment.json'
    if (execution[pathField] !== expected) fail('CODEX_EVIDENCE_EXECUTION_INVALID', `${pathField} is not canonical`)
    const record = fileRecord(path.join(directory, expected))
    if (record.sha256 !== execution[hashField] || (bytesField && record.bytes !== execution[bytesField])) {
      fail('CODEX_EVIDENCE_EXECUTION_TAMPERED', `${expected} differs from its execution record`)
    }
  }
  const candidate = readJson(path.join(directory, 'candidate.json'), 'CODEX_EVIDENCE_CANDIDATE_INVALID')
  const environment = readJson(path.join(directory, 'environment.json'), 'CODEX_EVIDENCE_ENVIRONMENT_INVALID')
  if (sha256(canonicalStringify(candidate)) !== execution.candidate_hash || sha256(canonicalStringify(environment)) !== execution.environment_hash) {
    fail('CODEX_EVIDENCE_EXECUTION_TAMPERED', 'candidate or environment semantic hash differs')
  }
  const isolation = environment && environment.execution_isolation
  if (!isolation || isolation.host_home_and_config_inherited !== false ||
      isolation.network !== 'restricted-by-codex-sandbox' || isolation.permission_profile !== ':workspace' ||
      isolation.sandbox_launcher !== 'codex-cli' || isolation.synthetic_private_home !== true) {
    fail('CODEX_EVIDENCE_ENVIRONMENT_INVALID', 'environment does not prove the required private-home and Codex network sandbox boundary')
  }
  const stdoutSummary = validateOutputSummary(directory, 'stdout.bin', 'stdout')
  const stderrSummary = validateOutputSummary(directory, 'stderr.bin', 'stderr')
  exactKeys(execution.redaction, ['sensitive_variables_removed', 'secret_output_scan', 'raw_output_truncated'], 'CODEX_EVIDENCE_EXECUTION_INVALID', 'redaction record')
  if (!Array.isArray(execution.redaction.sensitive_variables_removed) || execution.redaction.secret_output_scan !== 'PASS' || execution.redaction.raw_output_truncated !== false) {
    fail('CODEX_EVIDENCE_EXECUTION_INVALID', 'redaction record does not prove complete scanned output')
  }
  return { execution, candidate, environment, stdoutSummary, stderrSummary }
}

function validateReview(review, execution, knownFindingIds, stdoutSummary) {
  const fields = [
    'schema_version', 'execution_hash', 'candidate_hash', 'command_hash', 'exit_code', 'raw_output_sha256',
    'stderr_sha256', 'reviewer_id', 'independent', 'result', 'finding_reviews', 'reviewed_at',
  ]
  exactKeys(review, fields, 'CODEX_EVIDENCE_REVIEW_INVALID', 'review verdict')
  if (fields.some(field => !Object.hasOwn(review, field)) || review.schema_version !== REVIEW_SCHEMA) {
    fail('CODEX_EVIDENCE_REVIEW_INVALID', 'review verdict has missing fields or unsupported schema')
  }
  for (const field of ['execution_hash', 'candidate_hash', 'command_hash', 'raw_output_sha256', 'stderr_sha256']) {
    if (review[field] !== execution[field]) fail('CODEX_EVIDENCE_REVIEW_REPLAY', `review ${field} does not bind this execution`)
  }
  if (review.exit_code !== execution.exit_code) fail('CODEX_EVIDENCE_REVIEW_REPLAY', 'review exit_code does not bind this execution')
  const reviewerId = safeId(review.reviewer_id, 'reviewer_id')
  if (review.independent !== true || reviewerId === execution.runner_id) {
    fail('CODEX_EVIDENCE_REVIEW_NOT_INDEPENDENT', 'reviewer must explicitly be independent and differ from the runner')
  }
  if (!['PASS', 'FAIL'].includes(review.result)) fail('CODEX_EVIDENCE_REVIEW_INVALID', 'review result must be PASS or FAIL')
  isoDate(review.reviewed_at, 'CODEX_EVIDENCE_REVIEW_INVALID', 'reviewed_at')
  if (Date.parse(review.reviewed_at) < Date.parse(execution.ended_at)) fail('CODEX_EVIDENCE_REVIEW_INVALID', 'review predates the captured result')
  if (!Array.isArray(review.finding_reviews) || review.finding_reviews.length === 0) {
    fail('CODEX_EVIDENCE_REVIEW_INVALID', 'review must justify at least one exact finding id')
  }
  const seen = new Set()
  for (const finding of review.finding_reviews) {
    exactKeys(finding, ['finding_id', 'justification'], 'CODEX_EVIDENCE_REVIEW_INVALID', 'finding review')
    if (!/^AP-[A-Z]+-\d{3}$/.test(finding.finding_id) || !knownFindingIds.has(finding.finding_id)) {
      fail('CODEX_EVIDENCE_REVIEW_INVALID', 'review contains an unknown finding id', { finding_id: finding.finding_id })
    }
    if (seen.has(finding.finding_id)) fail('CODEX_EVIDENCE_REVIEW_INVALID', 'review contains duplicate finding ids')
    seen.add(finding.finding_id)
    if (typeof finding.justification !== 'string' || finding.justification.trim().length < 24) {
      fail('CODEX_EVIDENCE_REVIEW_INVALID', 'every finding needs a substantive, explicit proof justification', { finding_id: finding.finding_id })
    }
  }
  if (review.result === 'PASS' && (execution.exit_code !== 0 || execution.signal !== null || execution.candidate_unchanged !== true)) {
    fail('CODEX_EVIDENCE_FALSE_PASS', 'PASS cannot seal a failed, signaled, or candidate-mutating execution')
  }
  if (review.result === 'PASS' && (!stdoutSummary || !stdoutSummary.structured_evidence ||
      stdoutSummary.structured_evidence.result !== 'PASS' ||
      !stdoutSummary.structured_evidence.checks.every(check => check.result === 'PASS'))) {
    fail('CODEX_EVIDENCE_FALSE_PASS', 'PASS requires canonical allowlisted structured PASS evidence; redacted diagnostics and raw output hashes are insufficient')
  }
  return review
}

function findingRegistry(repo) {
  const bytes = fs.readFileSync(path.join(repo, 'AUTOPROMPT-TOTAL-FIX-MAP.md'))
  const text = bytes.toString('utf8')
  const findings = [...text.matchAll(/^(\| (AP-[A-Z]+-\d{3}) \| (P[0-3]) \|.*)$/gm)].map(match => ({
    id: match[2],
    severity: match[3],
    row_sha256: sha256(Buffer.from(match[1], 'utf8')),
  }))
  if (findings.length === 0 || new Set(findings.map(item => item.id)).size !== findings.length) {
    fail('CODEX_EVIDENCE_FINDING_REGISTRY_INVALID', 'fix map must contain unique finding rows')
  }
  return {
    schema_version: 'codex-verification-finding-registry.v1',
    map_path: 'AUTOPROMPT-TOTAL-FIX-MAP.md',
    map_sha256: sha256(bytes),
    findings,
  }
}

function validateFindingRegistry(registry) {
  exactKeys(registry, ['schema_version', 'map_path', 'map_sha256', 'findings'], 'CODEX_EVIDENCE_FINDING_REGISTRY_INVALID', 'finding registry')
  if (registry.schema_version !== 'codex-verification-finding-registry.v1' ||
      registry.map_path !== 'AUTOPROMPT-TOTAL-FIX-MAP.md' || !hashPattern(registry.map_sha256) ||
      !Array.isArray(registry.findings) || registry.findings.length === 0) {
    fail('CODEX_EVIDENCE_FINDING_REGISTRY_INVALID', 'sealed finding registry has missing or invalid fields')
  }
  const seen = new Set()
  for (const finding of registry.findings) {
    exactKeys(finding, ['id', 'severity', 'row_sha256'], 'CODEX_EVIDENCE_FINDING_REGISTRY_INVALID', 'finding registry row')
    if (!/^AP-[A-Z]+-\d{3}$/.test(finding.id) || !/^P[0-3]$/.test(finding.severity) || !hashPattern(finding.row_sha256) || seen.has(finding.id)) {
      fail('CODEX_EVIDENCE_FINDING_REGISTRY_INVALID', 'sealed finding registry has malformed or duplicate rows')
    }
    seen.add(finding.id)
  }
  return registry
}

function sealBundle(options) {
  const repo = gitRoot(options.repo || process.cwd())
  const evidenceRoot = canonicalEvidenceRoot(options.evidenceRoot)
  const evidenceAbsolute = path.resolve(repo, ...evidenceRoot.split('/'))
  inside(repo, evidenceAbsolute, 'evidence root')
  const directory = executionDirectory(options.execution)
  const { execution, stdoutSummary } = validateExecution(directory)
  const registry = validateFindingRegistry(findingRegistry(repo))
  const review = validateReview(
    readJson(path.resolve(options.verdict), 'CODEX_EVIDENCE_REVIEW_INVALID'),
    execution,
    new Set(registry.findings.map(item => item.id)),
    stdoutSummary,
  )
  const reviewBytes = canonicalBytes(review)
  const registryBytes = canonicalBytes(registry)
  const executionBytes = fs.readFileSync(path.join(directory, 'execution.json'))
  const candidateBytes = fs.readFileSync(path.join(directory, 'candidate.json'))
  const environmentBytes = fs.readFileSync(path.join(directory, 'environment.json'))
  const stdoutBytes = fs.readFileSync(path.join(directory, 'stdout.bin'))
  const stderrBytes = fs.readFileSync(path.join(directory, 'stderr.bin'))
  const bundle = {
    schema_version: BUNDLE_SCHEMA,
    id: null,
    bundle_hash: null,
    bundle_hash_algorithm: 'sha256-canonical-json-derived-paths-v1',
    scope: 'codex-only',
    result: review.result,
    independent: true,
    finding_ids: review.finding_reviews.map(item => item.finding_id).sort(),
    finding_reviews: [...review.finding_reviews].sort((a, b) => a.finding_id.localeCompare(b.finding_id)),
    runner_id: execution.runner_id,
    reviewer_id: review.reviewer_id,
    reviewed_at: review.reviewed_at,
    execution_hash: execution.execution_hash,
    command_argv: execution.command_argv,
    command_hash: execution.command_hash,
    cwd: execution.cwd,
    started_at: execution.started_at,
    ended_at: execution.ended_at,
    exit_code: execution.exit_code,
    signal: execution.signal,
    candidate_hash: execution.candidate_hash,
    post_candidate_hash: execution.post_candidate_hash,
    candidate_unchanged: execution.candidate_unchanged,
    environment_hash: execution.environment_hash,
    raw_output_sha256: execution.raw_output_sha256,
    raw_output_bytes: execution.raw_output_bytes,
    stderr_sha256: execution.stderr_sha256,
    stderr_bytes: execution.stderr_bytes,
    candidate_manifest_sha256: execution.candidate_manifest_sha256,
    environment_manifest_sha256: execution.environment_manifest_sha256,
    execution_record_sha256: sha256(executionBytes),
    reviewer_verdict_sha256: sha256(reviewBytes),
    finding_registry_sha256: sha256(registryBytes),
    redaction: execution.redaction,
    bundle_path: null,
    raw_output_path: null,
    stderr_path: null,
    candidate_manifest_path: null,
    environment_manifest_path: null,
    execution_record_path: null,
    reviewer_verdict_path: null,
    finding_registry_path: null,
  }
  bundle.bundle_hash = bundleDigest(bundle)
  bundle.id = `verification:${bundle.bundle_hash}`
  Object.assign(bundle, artifactRelativePaths(bundle.bundle_hash, evidenceRoot))
  const files = {
    'bundle.json': canonicalBytes(bundle),
    'candidate.json': candidateBytes,
    'environment.json': environmentBytes,
    'execution.json': executionBytes,
    'reviewer-verdict.json': reviewBytes,
    'finding-registry.json': registryBytes,
    'stderr.bin': stderrBytes,
    'stdout.bin': stdoutBytes,
  }
  const target = path.join(evidenceAbsolute, bundle.bundle_hash)
  appendOnlyDirectory(target, files)
  return { bundle, path: target }
}

function bundleDirectory(value) {
  const absolute = path.resolve(value)
  const stat = fs.lstatSync(absolute)
  if (stat.isSymbolicLink()) fail('CODEX_EVIDENCE_ARTIFACT_TYPE_INVALID', 'bundle path cannot be a symlink')
  const directory = stat.isDirectory() ? absolute : path.dirname(absolute)
  if (fs.lstatSync(directory).isSymbolicLink()) fail('CODEX_EVIDENCE_ARTIFACT_TYPE_INVALID', 'bundle directory cannot be a symlink')
  return directory
}

function validateBundleShape(bundle) {
  const fields = [
    'schema_version', 'id', 'bundle_hash', 'bundle_hash_algorithm', 'scope', 'result', 'independent', 'finding_ids',
    'finding_reviews', 'runner_id', 'reviewer_id', 'reviewed_at', 'execution_hash', 'command_argv', 'command_hash', 'cwd',
    'started_at', 'ended_at', 'exit_code', 'signal', 'candidate_hash', 'post_candidate_hash', 'candidate_unchanged',
    'environment_hash', 'raw_output_sha256', 'raw_output_bytes', 'stderr_sha256', 'stderr_bytes',
    'candidate_manifest_sha256', 'environment_manifest_sha256', 'execution_record_sha256', 'reviewer_verdict_sha256',
    'finding_registry_sha256',
    'redaction', 'bundle_path', 'raw_output_path', 'stderr_path', 'candidate_manifest_path', 'environment_manifest_path',
    'execution_record_path', 'reviewer_verdict_path',
    'finding_registry_path',
  ]
  exactKeys(bundle, fields, 'CODEX_EVIDENCE_BUNDLE_INVALID', 'verification bundle')
  if (fields.some(field => !Object.hasOwn(bundle, field)) || bundle.schema_version !== BUNDLE_SCHEMA || bundle.scope !== 'codex-only') {
    fail('CODEX_EVIDENCE_BUNDLE_INVALID', 'bundle has missing fields, wrong scope, or unsupported schema')
  }
  for (const field of HASH_FIELDS) if (!hashPattern(bundle[field])) fail('CODEX_EVIDENCE_BUNDLE_INVALID', `${field} must be sha256`)
  if (bundle.bundle_hash !== bundleDigest(bundle) || bundle.id !== `verification:${bundle.bundle_hash}`) {
    fail('CODEX_EVIDENCE_BUNDLE_TAMPERED', 'bundle digest or stable verification id is invalid')
  }
  if (canonicalStringify(bundle.finding_ids) !== canonicalStringify(bundle.finding_reviews.map(item => item.finding_id).sort())) {
    fail('CODEX_EVIDENCE_BUNDLE_TAMPERED', 'finding_ids must exactly equal the individually justified rows')
  }
}

function verifyBundle(options) {
  const repo = gitRoot(options.repo || process.cwd())
  const directory = bundleDirectory(options.bundle)
  inside(repo, directory, 'bundle')
  const bundle = readJson(path.join(directory, 'bundle.json'), 'CODEX_EVIDENCE_BUNDLE_INVALID')
  validateBundleShape(bundle)
  if (path.basename(directory) !== bundle.bundle_hash) fail('CODEX_EVIDENCE_BUNDLE_TAMPERED', 'bundle is not stored in its content-addressed directory')
  const evidenceRoot = inside(repo, path.dirname(directory), 'evidence root')
  canonicalEvidenceRoot(evidenceRoot)
  const expectedPaths = artifactRelativePaths(bundle.bundle_hash, evidenceRoot)
  for (const [field, expected] of Object.entries(expectedPaths)) {
    if (bundle[field] !== expected) fail('CODEX_EVIDENCE_BUNDLE_TAMPERED', `${field} is not the derived repository-local path`)
  }
  const expectedNames = ['bundle.json', 'candidate.json', 'environment.json', 'execution.json', 'finding-registry.json', 'reviewer-verdict.json', 'stderr.bin', 'stdout.bin']
  if (canonicalStringify(fs.readdirSync(directory).sort()) !== canonicalStringify(expectedNames)) {
    fail('CODEX_EVIDENCE_BUNDLE_TAMPERED', 'bundle directory contains missing or unexpected artifacts')
  }
  const artifactChecks = [
    ['stdout.bin', 'raw_output_sha256', 'raw_output_bytes'],
    ['stderr.bin', 'stderr_sha256', 'stderr_bytes'],
    ['candidate.json', 'candidate_manifest_sha256', null],
    ['environment.json', 'environment_manifest_sha256', null],
    ['execution.json', 'execution_record_sha256', null],
    ['reviewer-verdict.json', 'reviewer_verdict_sha256', null],
    ['finding-registry.json', 'finding_registry_sha256', null],
  ]
  for (const [name, hashField, bytesField] of artifactChecks) {
    const record = fileRecord(path.join(directory, name))
    if (record.sha256 !== bundle[hashField] || (bytesField && record.bytes !== bundle[bytesField])) {
      fail('CODEX_EVIDENCE_BUNDLE_TAMPERED', `${name} differs from its bundle record`)
    }
  }
  const validatedExecution = validateExecution(directory, { requireAddressedPath: false })
  const execution = validatedExecution.execution
  const registry = validateFindingRegistry(readJson(path.join(directory, 'finding-registry.json'), 'CODEX_EVIDENCE_FINDING_REGISTRY_INVALID'))
  const review = validateReview(
    readJson(path.join(directory, 'reviewer-verdict.json'), 'CODEX_EVIDENCE_REVIEW_INVALID'),
    execution,
    new Set((registry.findings || []).map(item => item.id)),
    validatedExecution.stdoutSummary,
  )
  for (const field of [
    'execution_hash', 'runner_id', 'command_argv', 'command_hash', 'cwd', 'started_at', 'ended_at', 'exit_code', 'signal',
    'candidate_hash', 'post_candidate_hash', 'candidate_unchanged', 'environment_hash', 'raw_output_sha256',
    'raw_output_bytes', 'stderr_sha256', 'stderr_bytes', 'candidate_manifest_sha256', 'environment_manifest_sha256', 'redaction',
  ]) {
    if (canonicalStringify(bundle[field]) !== canonicalStringify(execution[field])) fail('CODEX_EVIDENCE_BUNDLE_TAMPERED', `bundle ${field} differs from execution`)
  }
  if (bundle.result !== review.result || bundle.reviewer_id !== review.reviewer_id || bundle.independent !== true ||
      canonicalStringify(bundle.finding_reviews) !== canonicalStringify([...review.finding_reviews].sort((a, b) => a.finding_id.localeCompare(b.finding_id)))) {
    fail('CODEX_EVIDENCE_BUNDLE_TAMPERED', 'bundle verdict differs from independent review')
  }
  if (!options.integrityOnly) {
    const current = candidateSnapshot(repo, evidenceRoot)
    if (current.hash !== bundle.candidate_hash) {
      fail('CODEX_EVIDENCE_CANDIDATE_REPLAY', 'bundle proves different candidate bytes or Git state', {
        expected: bundle.candidate_hash,
        actual: current.hash,
      })
    }
  }
  return bundle
}

module.exports = {
  BUNDLE_SCHEMA,
  DEFAULT_EVIDENCE_ROOT,
  DEFAULT_GOVERNANCE_ROOT,
  EXECUTION_SCHEMA,
  REVIEW_SCHEMA,
  bundleDigest,
  candidateSnapshot,
  captureExecution,
  environmentSnapshot,
  sealBundle,
  validateExecution,
  verificationGovernanceEntries,
  verifyBundle,
}
