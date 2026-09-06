'use strict'

const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  canonicalStringify,
  exactKeys,
  fail,
  isoDate,
  nonEmpty,
  sha256,
  writeChecksummedJson,
} = require('./core.cjs')

const ARM_ROLES = Object.freeze({
  base: 'single-agent-base',
  current: 'frozen-current-autoprompt',
  redesign: 'codex-redesign',
})
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u

function resolveContained(root, relative, code, label) {
  nonEmpty(relative, code, label)
  if (path.isAbsolute(relative) || relative.includes('\\')) fail(code, `${label} must be a portable repository-relative path`)
  const parts = relative.split('/')
  if (parts.some(part => !part || part === '.' || part === '..')) fail(code, `${label} must be a portable repository-relative path`)
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(resolvedRoot, ...parts)
  const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`
  if (!resolved.startsWith(prefix)) fail(code, `${label} escapes the repository root`)
  return resolved
}

function validateDefinition(definition) {
  exactKeys(definition, ['schemaVersion', 'evidenceClass', 'provider', 'repetitions', 'task', 'arms', 'realCodex'], 'MECHANISM_DEFINITION_INVALID', 'mechanism definition')
  if (definition.schemaVersion !== 'codex-mechanism-canary.v1' || definition.evidenceClass !== 'harness-mechanics-only') fail('MECHANISM_DEFINITION_INVALID', 'unsupported mechanism definition')
  if (definition.provider !== 'codex') fail('MECHANISM_PROVIDER_INVALID', 'the low-compute mechanism canary is Codex-only')
  if (definition.repetitions !== 1) fail('MECHANISM_REPETITIONS_INVALID', 'the mechanism canary must use exactly one repetition')
  exactKeys(definition.task, ['taskId', 'route', 'fixtureDir', 'focusedCheck'], 'MECHANISM_TASK_INVALID', 'task')
  nonEmpty(definition.task.taskId, 'MECHANISM_TASK_INVALID', 'taskId')
  if (definition.task.route !== 'DIRECT') fail('MECHANISM_TASK_INVALID', 'the low-compute task must be preregistered as DIRECT')
  nonEmpty(definition.task.fixtureDir, 'MECHANISM_TASK_INVALID', 'fixtureDir')
  exactKeys(definition.task.focusedCheck, ['argv', 'timeoutMs'], 'MECHANISM_TASK_INVALID', 'focusedCheck')
  if (!Array.isArray(definition.task.focusedCheck.argv) || !definition.task.focusedCheck.argv.length || definition.task.focusedCheck.argv.some(value => typeof value !== 'string' || !value)) fail('MECHANISM_TASK_INVALID', 'focusedCheck.argv must be a non-empty string array')
  if (!Number.isSafeInteger(definition.task.focusedCheck.timeoutMs) || definition.task.focusedCheck.timeoutMs < 1 || definition.task.focusedCheck.timeoutMs > 120000) fail('MECHANISM_TASK_INVALID', 'focusedCheck.timeoutMs must be between 1 and 120000')
  if (!Array.isArray(definition.arms) || definition.arms.length !== 3) fail('MECHANISM_ARMS_INVALID', 'exactly three arms are required')
  const expected = Object.entries(ARM_ROLES)
  definition.arms.forEach((arm, index) => {
    exactKeys(arm, ['armId', 'role', 'runner'], 'MECHANISM_ARMS_INVALID', `arm ${index}`)
    const [armId, role] = expected[index]
    if (arm.armId !== armId || arm.role !== role) fail('MECHANISM_ARMS_INVALID', 'arms must be ordered base, current, redesign with canonical roles')
    nonEmpty(arm.runner, 'MECHANISM_ARMS_INVALID', `runner for ${arm.armId}`)
  })
  exactKeys(definition.realCodex, ['status', 'phase', 'code', 'reason', 'evidencePath'], 'MECHANISM_REAL_CODEX_INVALID', 'realCodex')
  if (definition.realCodex.status !== 'BLOCKED' || definition.realCodex.phase !== 'pre-route') fail('MECHANISM_REAL_CODEX_INVALID', 'the carried observation must be a pre-route blocker')
  for (const field of ['code', 'reason', 'evidencePath']) nonEmpty(definition.realCodex[field], 'MECHANISM_REAL_CODEX_INVALID', `realCodex.${field}`)
  return definition
}

function resolveCommit(repoRoot, sha, label) {
  if (!COMMIT_PATTERN.test(sha)) fail('MECHANISM_COMMIT_INVALID', `${label} must be a full lowercase commit SHA`)
  const result = childProcess.spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: repoRoot, encoding: 'utf8', windowsHide: true, shell: false })
  if (result.status !== 0) fail('MECHANISM_COMMIT_INVALID', `${label} is not an available commit`, { stderr: result.stderr.trim() })
  return sha
}

function listFiles(root, current = root) {
  const result = []
  for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const filename = path.join(current, entry.name)
    if (entry.isSymbolicLink()) fail('MECHANISM_FIXTURE_INVALID', 'fixture symlinks are forbidden')
    if (entry.isDirectory()) result.push(...listFiles(root, filename))
    else if (entry.isFile()) result.push({ filename, relativePath: path.relative(root, filename).split(path.sep).join('/') })
    else fail('MECHANISM_FIXTURE_INVALID', 'fixture contains an unsupported filesystem entry')
  }
  return result
}

function treeDigest(root) {
  const records = listFiles(root).map(file => ({ relativePath: file.relativePath, sha256: sha256(fs.readFileSync(file.filename)), bytes: fs.statSync(file.filename).size }))
  return { sha256: sha256(canonicalStringify(records)), files: records.length }
}

function runProcess(argv, options) {
  const result = childProcess.spawnSync(argv[0], argv.slice(1), {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: options.timeoutMs,
    windowsHide: true,
    shell: false,
  })
  return {
    exitCode: result.status,
    signal: result.signal,
    errorCode: result.error && result.error.code ? result.error.code : null,
    stdoutObserved: Boolean(result.stdout),
    stderrObserved: Boolean(result.stderr),
  }
}

function childEnvironment(overrides = {}) {
  const environment = { ...process.env, ...overrides }
  delete environment.NODE_TEST_CONTEXT
  return environment
}

function verifyCarriedBlocker(repoRoot, realCodex) {
  const evidencePath = resolveContained(repoRoot, realCodex.evidencePath, 'MECHANISM_REAL_CODEX_INVALID', 'realCodex.evidencePath')
  let bytes
  try { bytes = fs.readFileSync(evidencePath, 'utf8') } catch (error) { fail('MECHANISM_REAL_CODEX_INVALID', 'real Codex blocker evidence cannot be opened', { cause: error.code }) }
  const typed = `${realCodex.code} provider=codex reason=${realCodex.reason}`
  if (!bytes.includes(typed)) fail('MECHANISM_REAL_CODEX_INVALID', 'real Codex blocker is not present verbatim in its cited evidence')
  return { ...realCodex, evidenceSha256: sha256(bytes), observationKind: 'carried-forward-not-rerun' }
}

function runMechanismCanary(options) {
  const repoRoot = path.resolve(options.repoRoot)
  const definition = validateDefinition(options.definition)
  const baselineSha = resolveCommit(repoRoot, options.baselineSha, 'baselineSha')
  const candidateSha = resolveCommit(repoRoot, options.candidateSha, 'candidateSha')
  if (baselineSha === candidateSha) fail('MECHANISM_COMMIT_INVALID', 'baselineSha and candidateSha must differ')
  const fixtureDir = resolveContained(repoRoot, definition.task.fixtureDir, 'MECHANISM_FIXTURE_INVALID', 'fixtureDir')
  let fixtureStat
  try { fixtureStat = fs.statSync(fixtureDir) } catch (error) { fail('MECHANISM_FIXTURE_INVALID', 'fixtureDir is missing or unreadable', { cause: error.code }) }
  if (!fixtureStat.isDirectory()) fail('MECHANISM_FIXTURE_INVALID', 'fixtureDir must be a directory')
  let fixtureDigest
  try { fixtureDigest = treeDigest(fixtureDir) } catch (error) {
    if (error && error.name === 'BenchmarkEvidenceError') throw error
    fail('MECHANISM_FIXTURE_INVALID', 'fixture tree is unreadable', { cause: error.code })
  }
  const generatedAt = options.generatedAt || new Date().toISOString()
  isoDate(generatedAt, 'MECHANISM_TIME_INVALID', 'generatedAt')
  const realCodex = verifyCarriedBlocker(repoRoot, definition.realCodex)
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-codex-mechanism-'))
  const attempts = []
  let baselineFocusedCheck
  try {
    const baselineWorkspace = path.join(temporaryRoot, 'baseline-red')
    fs.cpSync(fixtureDir, baselineWorkspace, { recursive: true, errorOnExist: true, force: false })
    const focusedArgv = definition.task.focusedCheck.argv.map(value => value === '{node}' ? process.execPath : value)
    baselineFocusedCheck = { argv: definition.task.focusedCheck.argv, ...runProcess(focusedArgv, { cwd: baselineWorkspace, timeoutMs: definition.task.focusedCheck.timeoutMs, env: childEnvironment() }) }
    if (baselineFocusedCheck.exitCode === 0 && baselineFocusedCheck.signal === null && baselineFocusedCheck.errorCode === null) fail('MECHANISM_BASELINE_NOT_RED', 'the preregistered focused check must fail before any arm runs')
    for (const arm of definition.arms) {
      const sourceSha = arm.armId === 'redesign' ? candidateSha : baselineSha
      const workspace = path.join(temporaryRoot, arm.armId)
      fs.cpSync(fixtureDir, workspace, { recursive: true, errorOnExist: true, force: false })
      const runner = resolveContained(repoRoot, arm.runner, 'MECHANISM_ARMS_INVALID', `runner for ${arm.armId}`)
      const producer = runProcess([process.execPath, runner], {
        cwd: repoRoot,
        timeoutMs: definition.task.focusedCheck.timeoutMs,
        env: childEnvironment({
          AUTOPROMPT_MECHANISM_ARM_ID: arm.armId,
          AUTOPROMPT_MECHANISM_EVIDENCE_CLASS: definition.evidenceClass,
          AUTOPROMPT_MECHANISM_SOURCE_SHA: sourceSha,
          AUTOPROMPT_MECHANISM_TASK_ID: definition.task.taskId,
          AUTOPROMPT_MECHANISM_WORKSPACE: workspace,
        }),
      })
      const focused = producer.exitCode === 0 && producer.signal === null && producer.errorCode === null
        ? runProcess(focusedArgv, { cwd: workspace, timeoutMs: definition.task.focusedCheck.timeoutMs, env: childEnvironment() })
        : { exitCode: null, signal: null, errorCode: 'ARM_RUNNER_FAILED', stdoutObserved: false, stderrObserved: false }
      const passed = producer.exitCode === 0 && producer.signal === null && producer.errorCode === null && focused.exitCode === 0 && focused.signal === null && focused.errorCode === null
      attempts.push({
        armId: arm.armId,
        role: arm.role,
        sourceSha,
        sourceBinding: 'declared-existing-commit-not-executed',
        executionKind: 'deterministic-fixture-runner',
        terminalState: passed ? 'PASS' : 'FAIL',
        producer,
        focusedCheck: { argv: definition.task.focusedCheck.argv, ...focused },
        outputTree: treeDigest(workspace),
      })
    }
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
  const record = {
    schemaVersion: 'codex-mechanism-evidence.v1',
    generatedAt,
    evidenceClass: definition.evidenceClass,
    provider: definition.provider,
    qualityClaimEligible: false,
    comparisonClaimEligible: false,
    reason: 'Deterministic fixture arms prove isolation, commit binding, and focused-check mechanics only; they do not measure agent quality, latency, or cost.',
    source: { baselineSha, candidateSha },
    task: { taskId: definition.task.taskId, route: definition.task.route, repetitions: definition.repetitions, fixture: fixtureDigest, baselineFocusedCheck },
    attempts,
    mechanismVerified: attempts.every(attempt => attempt.terminalState === 'PASS'),
    realCodex,
  }
  if (options.outputPath) return writeChecksummedJson(path.resolve(options.outputPath), record)
  return record
}

function loadDefinition(filename) {
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')) } catch (error) { fail('MECHANISM_DEFINITION_INVALID', 'cannot read mechanism definition', { cause: error.message }) }
}

module.exports = { ARM_ROLES, loadDefinition, resolveCommit, runMechanismCanary, treeDigest, validateDefinition }
