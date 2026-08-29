'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const CLI = path.join(ROOT, 'scripts', 'codex-evidence-bundle.cjs')
const {
  REVIEW_SCHEMA,
  candidateSnapshot,
  captureExecution,
  sealBundle,
  verifyBundle,
} = require('../../scripts/codex-evidence/verification-bundle.cjs')

function runGit(repo, args) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

function directoryBytes(root) {
  const chunks = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name)
    if (entry.isDirectory()) chunks.push(directoryBytes(target))
    else if (entry.isFile()) chunks.push(fs.readFileSync(target))
  }
  return Buffer.concat(chunks)
}

function fixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-evidence-repo-'))
  runGit(repo, ['init', '--quiet'])
  runGit(repo, ['config', 'user.name', 'Codex Evidence Test'])
  runGit(repo, ['config', 'user.email', 'codex-evidence@example.invalid'])
  fs.writeFileSync(path.join(repo, 'AUTOPROMPT-TOTAL-FIX-MAP.md'), [
    '| ID | Severity | Description |',
    '| --- | --- | --- |',
    '| AP-ISO-001 | P0 | Exact proof row. |',
    '| AP-RUN-001 | P1 | Another exact proof row. |',
    '',
  ].join('\n'))
  fs.writeFileSync(path.join(repo, 'candidate.txt'), 'frozen candidate\n')
  fs.writeFileSync(path.join(repo, 'AUTOPROMPT-IMPLEMENTATION-COVERAGE.json'), '{"findings":[]}\n')
  fs.writeFileSync(path.join(repo, 'CODEX-IMPLEMENTATION-EVIDENCE.json'), '{"verifications":[]}\n')
  runGit(repo, ['add', '.'])
  runGit(repo, ['commit', '--quiet', '-m', 'fixture'])
  return repo
}

function reviewFor(execution, overrides = {}) {
  return {
    schema_version: REVIEW_SCHEMA,
    execution_hash: execution.execution_hash,
    candidate_hash: execution.candidate_hash,
    command_hash: execution.command_hash,
    exit_code: execution.exit_code,
    raw_output_sha256: execution.raw_output_sha256,
    stderr_sha256: execution.stderr_sha256,
    reviewer_id: 'agent:/independent-reviewer',
    independent: true,
    result: 'PASS',
    finding_reviews: [{
      finding_id: 'AP-ISO-001',
      justification: 'The focused command exercises the exact isolation acceptance asserted by this row.',
    }],
    reviewed_at: new Date(Date.now() + 1000).toISOString(),
    ...overrides,
  }
}

function passingCommand(summary = 'Focused verification check passed.') {
  const evidence = {
    schema_version: 'codex-verification-command-output.v1',
    result: 'PASS',
    checks: [{ id: 'focused-check', result: 'PASS', summary }],
  }
  return [process.execPath, '-e', `process.stdout.write(${JSON.stringify(JSON.stringify(evidence))}); process.stderr.write('bounded diagnostic\\n')`]
}

async function capturedFixture(repo, options = {}) {
  const executionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-evidence-execution-'))
  return captureExecution({
    repo,
    runnerId: 'agent:/focused-test-runner',
    executionRoot,
    commandArgv: options.commandArgv || passingCommand(),
  })
}

test('candidate identity binds HEAD, index stages, worktree bytes, and untracked bytes', () => {
  const repo = fixture()
  const clean = candidateSnapshot(repo)
  assert.equal(clean.snapshot.dirty, false)
  assert.throws(() => candidateSnapshot(repo, 'src'), /candidate exclusions are not configurable/)

  fs.writeFileSync(path.join(repo, 'candidate.txt'), 'unstaged bytes\n')
  const unstaged = candidateSnapshot(repo)
  assert.notEqual(unstaged.hash, clean.hash)
  assert.equal(unstaged.snapshot.dirty_kinds.unstaged, true)

  runGit(repo, ['add', 'candidate.txt'])
  const staged = candidateSnapshot(repo)
  assert.notEqual(staged.hash, unstaged.hash, 'same worktree bytes at a different index stage need a different identity')
  assert.equal(staged.snapshot.dirty_kinds.staged, true)

  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'untracked bytes\n')
  const untracked = candidateSnapshot(repo)
  assert.notEqual(untracked.hash, staged.hash)
  assert.equal(untracked.snapshot.dirty_kinds.untracked, true)
})

test('exact governance outputs do not create a promotion fixed point and similarly named files remain bound', () => {
  const repo = fixture()
  const before = candidateSnapshot(repo)
  fs.writeFileSync(path.join(repo, 'AUTOPROMPT-IMPLEMENTATION-COVERAGE.json'), '{"findings":["AP-ISO-001"]}\n')
  fs.writeFileSync(path.join(repo, 'CODEX-IMPLEMENTATION-EVIDENCE.json'), '{"verifications":["verification:abc"]}\n')
  const afterGovernance = candidateSnapshot(repo)
  assert.equal(afterGovernance.hash, before.hash, 'the two generated governance outputs must not invalidate their own bundle')

  fs.writeFileSync(path.join(repo, 'CODEX-IMPLEMENTATION-EVIDENCE.json.backup'), 'not governance metadata\n')
  const overbroad = candidateSnapshot(repo)
  assert.notEqual(overbroad.hash, before.hash, 'the exclusion must not match siblings, suffixes, or globs')
})

test('validated verification indexes do not create a promotion fixed point while hostile siblings fail closed', () => {
  const repo = fixture()
  const before = candidateSnapshot(repo)
  const governanceRoot = path.join(repo, 'evidence', 'codex-verification-indexes')
  fs.mkdirSync(governanceRoot, { recursive: true })
  const index = {
    schema_version: 'codex-verification-sealed-index.v1',
    scope: 'codex-only',
    status: 'SEALED_PASS_WITH_DECLARED_EXCLUSIONS',
    candidate_hash: '1'.repeat(64),
  }
  const indexPath = path.join(governanceRoot, 'FINAL1-SEALED-INDEX.json')
  fs.writeFileSync(indexPath, `${JSON.stringify(index)}\n`)
  const indexSha = require('node:crypto').createHash('sha256').update(fs.readFileSync(indexPath)).digest('hex')
  fs.writeFileSync(path.join(governanceRoot, 'FINAL1-HISTORICAL-NON-PROMOTABLE.json'), `${JSON.stringify({
    schema_version: 'codex-verification-historical-marker.v1',
    status: 'HISTORICAL_NON_PROMOTABLE',
    scope: 'codex-only',
    candidate_hash: '1'.repeat(64),
    promotion_forbidden: true,
    covered_sealed_index: {
      path: 'evidence/codex-verification-indexes/FINAL1-SEALED-INDEX.json',
      sha256: indexSha,
    },
  })}\n`)

  assert.equal(candidateSnapshot(repo).hash, before.hash, 'validated governance outputs must not invalidate the candidate they attest')

  fs.writeFileSync(path.join(governanceRoot, 'notes.json'), '{}\n')
  assert.throws(() => candidateSnapshot(repo), /unexpected verification governance entry/i)
  fs.rmSync(path.join(governanceRoot, 'notes.json'))

  fs.writeFileSync(indexPath, '{malformed\n')
  assert.throws(() => candidateSnapshot(repo), /verification governance JSON is invalid/i)
})

test('two-party seal preserves safe structured evidence and rejects tamper, replay, and batch-wide inference', async () => {
  const repo = fixture()
  const captured = await capturedFixture(repo)
  assert.equal(captured.execution.exit_code, 0)
  assert.equal(captured.execution.candidate_unchanged, true)
  const stdout = JSON.parse(fs.readFileSync(path.join(captured.path, 'stdout.bin'), 'utf8'))
  const stderr = JSON.parse(fs.readFileSync(path.join(captured.path, 'stderr.bin'), 'utf8'))
  assert.equal(stdout.schema_version, 'codex-verification-output-summary.v1')
  assert.equal(stdout.structured_evidence.result, 'PASS')
  assert.deepEqual(stderr.diagnostics, ['bounded diagnostic'])
  assert.doesNotMatch(fs.readFileSync(path.join(captured.path, 'stderr.bin'), 'utf8'), /bounded diagnostic\n/)

  const verdict = path.join(os.tmpdir(), `codex-review-${process.pid}-${Date.now()}.json`)
  fs.writeFileSync(verdict, `${JSON.stringify(reviewFor(captured.execution))}\n`)
  const sealed = sealBundle({ repo, execution: captured.path, verdict })
  assert.match(sealed.bundle.id, /^verification:[a-f0-9]{64}$/)
  assert.deepEqual(sealed.bundle.finding_ids, ['AP-ISO-001'])
  assert.equal(verifyBundle({ repo, bundle: sealed.path }).id, sealed.bundle.id)
  assert.equal(sealBundle({ repo, execution: captured.path, verdict }).bundle.id, sealed.bundle.id, 'same bytes are idempotent')

  fs.writeFileSync(path.join(repo, 'AUTOPROMPT-IMPLEMENTATION-COVERAGE.json'), '{"findings":["AP-ISO-001"]}\n')
  fs.writeFileSync(path.join(repo, 'CODEX-IMPLEMENTATION-EVIDENCE.json'), `{\"verifications\":[\"${sealed.bundle.id}\"]}\n`)
  assert.equal(verifyBundle({ repo, bundle: sealed.path }).id, sealed.bundle.id, 'promotion metadata must preserve current-candidate proof')

  const unrelated = reviewFor(captured.execution, {
    finding_reviews: [
      reviewFor(captured.execution).finding_reviews[0],
      { finding_id: 'AP-RUN-001', justification: 'short' },
    ],
  })
  const unrelatedVerdict = `${verdict}.unrelated`
  fs.writeFileSync(unrelatedVerdict, `${JSON.stringify(unrelated)}\n`)
  assert.throws(() => sealBundle({ repo, execution: captured.path, verdict: unrelatedVerdict }), /substantive, explicit proof justification/)

  const stdoutPath = path.join(sealed.path, 'stdout.bin')
  const original = fs.readFileSync(stdoutPath)
  fs.writeFileSync(stdoutPath, 'tampered\n')
  assert.throws(() => verifyBundle({ repo, bundle: sealed.path, integrityOnly: true }), /differs from its bundle record/)
  fs.writeFileSync(stdoutPath, original)

  const mapPath = path.join(repo, 'AUTOPROMPT-TOTAL-FIX-MAP.md')
  const originalMap = fs.readFileSync(mapPath)
  fs.writeFileSync(mapPath, [
    '| ID | Severity | Description |',
    '| --- | --- | --- |',
    '| AP-RUN-001 | P1 | Another exact proof row. |',
    '',
  ].join('\n'))
  assert.equal(verifyBundle({ repo, bundle: sealed.path, integrityOnly: true }).id, sealed.bundle.id, 'historical integrity must use the sealed finding authority')
  assert.throws(() => verifyBundle({ repo, bundle: sealed.path }), /proves different candidate bytes or Git state/)
  fs.writeFileSync(mapPath, originalMap)

  fs.writeFileSync(path.join(repo, 'candidate.txt'), 'different candidate\n')
  assert.throws(() => verifyBundle({ repo, bundle: sealed.path }), /proves different candidate bytes or Git state/)
  assert.equal(verifyBundle({ repo, bundle: sealed.path, integrityOnly: true }).id, sealed.bundle.id)
})

test('review identity and every replay-sensitive execution field are fail-closed', async () => {
  const repo = fixture()
  const captured = await capturedFixture(repo)
  const verdict = path.join(os.tmpdir(), `codex-review-bindings-${process.pid}-${Date.now()}.json`)

  fs.writeFileSync(verdict, `${JSON.stringify(reviewFor(captured.execution, { reviewer_id: captured.execution.runner_id }))}\n`)
  assert.throws(() => sealBundle({ repo, execution: captured.path, verdict }), /reviewer must explicitly be independent/)

  fs.writeFileSync(verdict, `${JSON.stringify(reviewFor(captured.execution, { raw_output_sha256: '0'.repeat(64) }))}\n`)
  assert.throws(() => sealBundle({ repo, execution: captured.path, verdict }), /does not bind this execution/)
})

test('child environment uses synthetic private homes and output retains only hashes and redacted bounded diagnostics', async () => {
  const repo = fixture()
  const secret = `high-value-secret-${Date.now()}`
  const allowedNameSecret = `ghp_${'A'.repeat(32)}`
  const previous = process.env.AUTOPROMPT_TEST_TOKEN
  const previousGeneric = process.env.INTERNAL_BLOB
  const previousHome = process.env.HOME
  process.env.AUTOPROMPT_TEST_TOKEN = secret
  process.env.INTERNAL_BLOB = `${secret}-generic`
  process.env.HOME = allowedNameSecret
  try {
    const captured = await capturedFixture(repo, {
      commandArgv: [process.execPath, '-e', "process.stdout.write(`${String(process.env.AUTOPROMPT_TEST_TOKEN)}|${String(process.env.INTERNAL_BLOB)}|${String(process.env.HOME)}`)"],
    })
    const stdout = JSON.parse(fs.readFileSync(path.join(captured.path, 'stdout.bin'), 'utf8'))
    assert.equal(stdout.source_bytes > 0, true)
    assert.match(stdout.source_sha256, /^[a-f0-9]{64}$/)
    assert.deepEqual(stdout.diagnostics, ['undefined|undefined|<redacted-host-value>'])
    const environmentBytes = fs.readFileSync(path.join(captured.path, 'environment.json'), 'utf8')
    assert.doesNotMatch(environmentBytes, new RegExp(secret))
    const environment = JSON.parse(environmentBytes)
    assert.equal(environment.variables.AUTOPROMPT_TEST_TOKEN, '<redacted-sensitive-value>')
    assert.equal(environment.variables.INTERNAL_BLOB, '<redacted-value>')
    assert.equal(environment.variables.HOME, '<redacted-sensitive-value>')
    assert.ok(environment.removed_variable_names.includes('INTERNAL_BLOB'))
    assert.equal(environment.redaction_policy.redacted_values_are_not_hashed_individually, true)
    assert.equal(environment.execution_isolation.network, 'restricted-by-codex-sandbox')
    assert.equal(environment.execution_isolation.synthetic_private_home, true)
    assert.equal(environment.passed_variable_names.includes('CODEX_SESSION_ID'), false)
    assert.equal(directoryBytes(captured.path).includes(Buffer.from(secret)), false, 'secret bytes must be absent from every persisted artifact')
    assert.equal(directoryBytes(captured.path).includes(Buffer.from(allowedNameSecret)), false, 'credential-shaped values under allowed names must be absent')

    process.env.HOME = previousHome || os.homedir()
    const ordinaryHome = process.env.HOME
    const ordinaryUser = process.env.USER || process.env.LOGNAME || os.userInfo().username
    const ordinary = await capturedFixture(repo, {
      commandArgv: [process.execPath, '-e', "process.stdout.write(`${process.argv[1]}|${process.argv[2]}`)", ordinaryHome, ordinaryUser],
    })
    const ordinaryOutput = fs.readFileSync(path.join(ordinary.path, 'stdout.bin'), 'utf8')
    assert.equal(ordinaryOutput.includes(ordinaryHome), false)
    assert.equal(ordinaryOutput.includes(ordinaryUser), false)

    fs.writeFileSync(path.join(repo, 'leak.txt'), secret)
    await assert.rejects(capturedFixture(repo, {
      commandArgv: [process.execPath, '-e', "process.stdout.write(require('node:fs').readFileSync('leak.txt'))"],
    }), /command output contains a sensitive inherited value/)
  } finally {
    if (previous === undefined) delete process.env.AUTOPROMPT_TEST_TOKEN
    else process.env.AUTOPROMPT_TEST_TOKEN = previous
    if (previousGeneric === undefined) delete process.env.INTERNAL_BLOB
    else process.env.INTERNAL_BLOB = previousGeneric
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
  }
})

test('file-sourced npm, AWS, generic config credentials, binary output, and opaque tokens fail before persistence', async () => {
  const cases = [
    ['npm', `npm_${'aB9'.repeat(16)}`],
    ['aws', `A9b/${'cD7+'.repeat(10)}`],
    ['config', `service_session_token=${'Zx8'.repeat(14)}`],
  ]
  for (const [name, secret] of cases) {
    const repo = fixture()
    const secretFile = path.join(repo, `${name}.private`)
    fs.writeFileSync(secretFile, secret)
    const executionRoot = fs.mkdtempSync(path.join(os.tmpdir(), `codex-evidence-${name}-`))
    await assert.rejects(captureExecution({
      repo,
      runnerId: `agent:/${name}-leak-runner`,
      executionRoot,
      commandArgv: [process.execPath, '-e', "process.stdout.write(require('node:fs').readFileSync(process.argv[1]))", `${name}.private`],
    }), error => error.code === 'CODEX_EVIDENCE_SECRET_OUTPUT')
    assert.equal(fs.readdirSync(executionRoot).length, 0)
  }

  const binaryRepo = fixture()
  const binaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-evidence-binary-'))
  await assert.rejects(captureExecution({
    repo: binaryRepo,
    runnerId: 'agent:/binary-runner',
    executionRoot: binaryRoot,
    commandArgv: [process.execPath, '-e', 'process.stdout.write(Buffer.from([0xff,0x00,0x81]))'],
  }), /binary|UTF-8/i)
  assert.equal(fs.readdirSync(binaryRoot).length, 0)
})

test('session and path telemetry are redacted, raw arbitrary output cannot support PASS', async () => {
  const repo = fixture()
  const session = `session-${Date.now()}`
  const privatePath = path.join(os.tmpdir(), 'ordinary-private', 'nested-telemetry', 'u', 'c.json')
  const captured = await capturedFixture(repo, {
    commandArgv: [process.execPath, '-e', "process.stdout.write('ordinary raw output'); process.stderr.write(`${process.argv[1]}|${process.argv[2]}`)", session, privatePath],
  })
  const allBytes = directoryBytes(captured.path)
  assert.equal(allBytes.includes(Buffer.from(session)), false)
  assert.equal(allBytes.includes(Buffer.from(privatePath)), false)
  const summary = JSON.parse(fs.readFileSync(path.join(captured.path, 'stdout.bin'), 'utf8'))
  assert.notEqual(fs.readFileSync(path.join(captured.path, 'stdout.bin'), 'utf8'), 'ordinary raw output')
  assert.equal(summary.source_bytes, Buffer.byteLength('ordinary raw output'))
  assert.equal(summary.structured_evidence, null)

  const verdict = path.join(os.tmpdir(), `codex-review-unstructured-${process.pid}-${Date.now()}.json`)
  fs.writeFileSync(verdict, `${JSON.stringify(reviewFor(captured.execution))}\n`)
  assert.throws(() => sealBundle({ repo, execution: captured.path, verdict }), /structured PASS evidence/i)
})

test('exit-zero verification with no observable result fails closed', async () => {
  const repo = fixture()
  const executionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-evidence-no-result-'))
  await assert.rejects(captureExecution({
    repo,
    runnerId: 'agent:/no-result-runner',
    executionRoot,
    commandArgv: [process.execPath, '-e', 'process.exit(0)'],
  }), error => error.code === 'CODEX_EVIDENCE_TRANSPORT_NO_RESULT')
  assert.equal(fs.readdirSync(executionRoot).length, 0)
})

test('split-form secret options are rejected before any secret bytes are persisted', async () => {
  const repo = fixture()
  const executionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-evidence-secret-argv-'))
  const secret = `split-secret-${Date.now()}`
  await assert.rejects(captureExecution({
    repo,
    runnerId: 'agent:/secret-argv-runner',
    executionRoot,
    commandArgv: [process.execPath, '--token', secret],
  }), /secret-bearing command arguments are forbidden/)
  const persisted = fs.readdirSync(executionRoot, { recursive: true }).map(item => String(item)).join('\n')
  assert.doesNotMatch(persisted, new RegExp(secret))
  assert.equal(fs.readdirSync(executionRoot).length, 0)
})

test('published schemas expose the frozen execution, independent review, and bundle contracts', () => {
  const schemas = [
    'codex-verification-execution.schema.json',
    'codex-verification-review.schema.json',
    'codex-verification-finding-registry.schema.json',
    'codex-verification-bundle.schema.json',
  ].map(name => JSON.parse(fs.readFileSync(path.join(ROOT, 'agents', 'contracts', 'schemas', name), 'utf8')))
  assert.equal(schemas[0].properties.schema_version.const, 'codex-verification-execution.v1')
  assert.equal(schemas[1].properties.independent.const, true)
  assert.equal(schemas[2].properties.map_path.const, 'AUTOPROMPT-TOTAL-FIX-MAP.md')
  assert.equal(schemas[3].properties.scope.const, 'codex-only')
  assert.match(schemas[3].properties.id.pattern, /verification:/)
})

test('CLI captures, seals, and verifies the frozen repo-local bundle format', () => {
  const repo = fixture()
  const executionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-evidence-cli-'))
  const captured = spawnSync(process.execPath, [
    CLI, 'capture', '--repo', repo, '--runner-id', 'agent:/cli-runner', '--execution-root', executionRoot,
    '--', ...passingCommand('CLI verification check passed.'),
  ], { encoding: 'utf8' })
  assert.equal(captured.status, 0, captured.stderr)
  const captureSummary = JSON.parse(captured.stdout)
  const execution = JSON.parse(fs.readFileSync(path.join(captureSummary.path, 'execution.json'), 'utf8'))
  const verdict = path.join(executionRoot, 'verdict.json')
  fs.writeFileSync(verdict, `${JSON.stringify(reviewFor(execution, { reviewer_id: 'agent:/cli-reviewer' }))}\n`)

  const sealed = spawnSync(process.execPath, [
    CLI, 'seal', '--repo', repo, '--execution', captureSummary.path, '--verdict', verdict,
  ], { encoding: 'utf8' })
  assert.equal(sealed.status, 0, sealed.stderr)
  const sealSummary = JSON.parse(sealed.stdout)
  assert.match(sealSummary.id, /^verification:[a-f0-9]{64}$/)

  const verified = spawnSync(process.execPath, [CLI, 'verify', '--repo', repo, '--bundle', sealSummary.path], { encoding: 'utf8' })
  assert.equal(verified.status, 0, verified.stderr)
  assert.equal(JSON.parse(verified.stdout).id, sealSummary.id)
})
