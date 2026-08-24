'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'fix-map-coverage.cjs');
const MAP = path.join(ROOT, 'AUTOPROMPT-TOTAL-FIX-MAP.md');
const COVERAGE = path.join(ROOT, 'AUTOPROMPT-IMPLEMENTATION-COVERAGE.json');
const {
  HISTORICAL_NON_PROMOTABLE,
  VERIFICATION_CURRENTNESS_SCHEMA,
  legacySchemaGaps,
  verificationCurrentness,
  verificationCurrentnessErrors,
} = require('../../scripts/fix-map-coverage.cjs');

const MIGRATED_GOVERNANCE_HASHES = new Map([
  ['FINAL10-HISTORICAL-NON-PROMOTABLE.json', '1d6dc01700bf95484e9ac61dcebdc53c8a3a14d3dca6e4f12c19ffc4525f64e4'],
  ['FINAL10-SEALED-INDEX.json', '873b06705dc279bf5be17ca46243299605c28c5920ad94adcdef46dc2e227406'],
  ['FINAL4-HISTORICAL-NON-PROMOTABLE.json', '664d1db9fd5e205ca3f7a2be7d10ac17ecf351739ba3c7399f4de76bb3a6b48d'],
  ['FINAL4-SEALED-INDEX.json', 'c202c9230566386fce70f1f7fdd93c035e0995dd074227e11810140d506c4e32'],
]);

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });
}

function passBundle(candidateHash = 'a'.repeat(64)) {
  return {
    id: `verification:${'b'.repeat(64)}`,
    candidate_hash: candidateHash,
    result: 'PASS',
    independent: true,
    exit_code: 0,
  };
}

test('current verification candidates cannot use the historical schema exception', () => {
  const bundle = passBundle();
  assert.throws(
    () => verificationCurrentness(bundle, bundle.candidate_hash, false, ['historical-schema-missing-private-home-boundary']),
    /current verification bundle is missing the required private-home, Codex network sandbox, or output-summary schema/,
  );
});

test('historical bundles with missing security fields are retained but explicitly nonpromotable', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-historical-bundle-'));
  fs.writeFileSync(path.join(temporary, 'environment.json'), '{}\n');
  fs.writeFileSync(path.join(temporary, 'stdout.bin'), 'legacy TAP output\n');
  fs.writeFileSync(path.join(temporary, 'stderr.bin'), '');
  const gaps = legacySchemaGaps(temporary);
  assert.deepEqual(gaps, [
    'historical-schema-missing-private-home-boundary',
    'historical-schema-missing-codex-network-sandbox-boundary',
    'historical-schema-missing-output-summary',
  ]);

  const currentness = verificationCurrentness(passBundle('a'.repeat(64)), 'c'.repeat(64), false, gaps);
  assert.equal(currentness.validation_schema_version, VERIFICATION_CURRENTNESS_SCHEMA);
  assert.equal(currentness.validation_status, HISTORICAL_NON_PROMOTABLE);
  assert.equal(currentness.current_candidate_match, false);
  assert.equal(currentness.schema_current, false);
  assert.equal(currentness.promotion_forbidden, true);
  assert.deepEqual(currentness.historical_invalidation_reasons, [
    'candidate-does-not-match-current-repository',
    ...gaps,
  ]);
});

test('a historical verification record cannot be relabeled as current', () => {
  const scanned = {
    id: `verification:${'b'.repeat(64)}`,
    ...verificationCurrentness(
      passBundle('a'.repeat(64)),
      'c'.repeat(64),
      false,
      ['historical-schema-missing-output-summary'],
    ),
  };
  const relabeled = {
    ...scanned,
    validation_status: 'CURRENT_SCHEMA_VALID',
    schema_current: true,
    current_candidate_match: true,
    promotion_forbidden: false,
    historical_invalidation_reasons: [],
  };
  assert.match(
    verificationCurrentnessErrors(relabeled, scanned).join('\n'),
    /historical verification cannot be relabeled as current/,
  );
});

test('verification bundles and governance indexes have disjoint canonical roots with preserved bytes', () => {
  const bundleRoot = path.join(ROOT, 'evidence', 'codex-verification-bundles');
  const governanceRoot = path.join(ROOT, 'evidence', 'codex-verification-indexes');
  for (const entry of fs.readdirSync(bundleRoot, { withFileTypes: true })) {
    assert.equal(entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name), true, `mixed bundle-root entry: ${entry.name}`);
  }
  assert.deepEqual(fs.readdirSync(governanceRoot).sort(), [...MIGRATED_GOVERNANCE_HASHES.keys()].sort());
  for (const [name, expectedHash] of MIGRATED_GOVERNANCE_HASHES) {
    const actualHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(governanceRoot, name))).digest('hex');
    assert.equal(actualHash, expectedHash, `${name} changed during migration`);
  }
});

test('initializes one coverage entry for every unique fix-map finding', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-coverage-'));
  const ledger = path.join(temporary, 'coverage.json');
  const result = run(['--map', MAP, '--ledger', ledger, '--init']);
  assert.equal(result.status, 0, result.stderr);
  const contents = JSON.parse(fs.readFileSync(ledger, 'utf8'));
  assert.equal(contents.findings.length, 305);
  assert.equal(new Set(contents.findings.map(({ id }) => id)).size, 305);
  assert.ok(contents.findings.every(({ status }) => status === 'not_started'));
});

test('requires code and independent evidence before verified status is accepted', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-coverage-'));
  const ledger = path.join(temporary, 'coverage.json');
  assert.equal(run(['--map', MAP, '--ledger', ledger, '--init']).status, 0);
  let result = run(['--map', MAP, '--ledger', ledger, '--mark', 'AP-DESIGN-029', '--status', 'verified']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires code_refs/);
  assert.match(result.stderr, /requires independent verification_refs/);

  result = run([
    '--map', MAP,
    '--ledger', ledger,
    '--mark', 'AP-DESIGN-029',
    '--status', 'verified',
    '--code', '.git/config',
    '--verify', 'local safety preflight: PASS',
  ]);
  assert.equal(result.status, 0, result.stderr);
});

test('full implementation coverage fails while any finding remains below verified', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-coverage-'));
  const ledger = path.join(temporary, 'coverage.json');
  assert.equal(run(['--map', MAP, '--ledger', ledger, '--init']).status, 0);
  const result = run(['--map', MAP, '--ledger', ledger, '--require', 'verified']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /AP-ISO-001: not_started, requires verified/);
});

test('coverage entries name the focused executable suites that close their test findings', () => {
  const coverage = JSON.parse(fs.readFileSync(COVERAGE, 'utf8'));
  const findings = new Map(coverage.findings.map(finding => [finding.id, finding]));
  const expectedRefs = new Map([
    ['AP-TEST-018', 'tests/source/npm-package.test.cjs'],
    ['AP-TEST-010', 'tests/source/benchmark-evidence-test-closures.test.cjs'],
    ['AP-TEST-020', 'tests/source/benchmark-evidence-test-closures.test.cjs'],
    ['AP-TEST-022', 'tests/source/benchmark-evidence-test-closures.test.cjs'],
    ['AP-TEST-025', 'tests/source/codex-runtime-evidence-gates-r5.test.cjs'],
    ['AP-TEST-026', 'tests/source/codex-runtime-evidence-gates-r5.test.cjs'],
    ['AP-TEST-027', 'tests/source/codex-runtime-evidence-gates-r5.test.cjs'],
  ]);

  for (const [id, expectedRef] of expectedRefs) {
    assert.ok(findings.has(id), `${id} missing from coverage ledger`);
    assert.ok(findings.get(id).test_refs.includes(expectedRef), `${id} missing ${expectedRef}`);
  }
});

test('AP-ISO-019 maps the isolation doctor and its current six-reason fail-closed contract', () => {
  const coverage = JSON.parse(fs.readFileSync(COVERAGE, 'utf8'));
  const finding = coverage.findings.find(entry => entry.id === 'AP-ISO-019');
  assert.ok(finding, 'AP-ISO-019 missing from coverage ledger');
  assert.ok(finding.code_refs.includes('scripts/codex-configure.cjs'));
  assert.ok(finding.test_refs.includes('tests/source/codex-activation-lifecycle-r10.test.cjs'));

  const notes = finding.notes.join('\n');
  for (const reason of [
    'canonical-live-evidence-invalid',
    'external-attestation-missing',
    'external-attestation-verification-method-invalid',
    'supported-capability-unattested-isolation',
    'supported-capability-unattested-privateSkillRoot',
    'supported-capability-unattested-processOwnership',
  ]) {
    assert.match(notes, new RegExp(`\\b${reason}\\b`), reason);
  }
});
