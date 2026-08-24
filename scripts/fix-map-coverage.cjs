#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  candidateSnapshot,
  DEFAULT_EVIDENCE_ROOT: VERIFICATION_BUNDLE_ROOT,
  verificationGovernanceEntries,
  verifyBundle,
} = require('./codex-evidence/verification-bundle.cjs');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_MAP = path.join(ROOT, 'AUTOPROMPT-TOTAL-FIX-MAP.md');
const DEFAULT_LEDGER = path.join(ROOT, 'AUTOPROMPT-IMPLEMENTATION-COVERAGE.json');
const DEFAULT_EVIDENCE_INDEX = path.join(ROOT, 'CODEX-IMPLEMENTATION-EVIDENCE.json');
const VERIFICATION_CURRENTNESS_SCHEMA = 'codex-coverage-verification-currentness.v1';
const CURRENT_SCHEMA_VALID = 'CURRENT_SCHEMA_VALID';
const HISTORICAL_NON_PROMOTABLE = 'HISTORICAL_INVALIDATED_NON_PROMOTABLE';
const OUTPUT_SUMMARY_SCHEMA = 'codex-verification-output-summary.v1';
const VALID_STATUS = new Set(['not_started', 'partial', 'implemented', 'verified']);
const STATUS_RANK = new Map([
  ['not_started', 0],
  ['partial', 1],
  ['implemented', 2],
  ['verified', 3],
]);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase();
}

function parseArguments(argv) {
  const result = { positional: [], values: {}, flags: new Set() };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) {
      result.positional.push(argument);
      continue;
    }
    const equals = argument.indexOf('=');
    if (equals !== -1) {
      const name = argument.slice(2, equals);
      const value = argument.slice(equals + 1);
      if (!result.values[name]) result.values[name] = [];
      result.values[name].push(value);
      continue;
    }
    const name = argument.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      if (!result.values[name]) result.values[name] = [];
      result.values[name].push(next);
      index += 1;
    } else {
      result.flags.add(name);
    }
  }
  return result;
}

function one(args, name, fallback) {
  const values = args.values[name];
  if (!values || values.length === 0) return fallback;
  return values.at(-1);
}

function many(args, name) {
  return args.values[name] ? [...args.values[name]] : [];
}

function parseMap(mapPath) {
  const bytes = fs.readFileSync(mapPath);
  const text = bytes.toString('utf8');
  const pattern = /^\| (AP-[A-Z]+-\d{3}) \| (P[0-3]) \|/gm;
  const findings = [];
  const ids = new Set();
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const [, id, severity] = match;
    if (ids.has(id)) throw new Error(`Duplicate finding id in map: ${id}`);
    ids.add(id);
    findings.push({ id, severity, group: id.split('-')[1] });
  }
  if (findings.length === 0) throw new Error(`No findings found in ${mapPath}`);
  return { bytes, findings };
}

function blankEntry(finding) {
  return {
    id: finding.id,
    severity: finding.severity,
    group: finding.group,
    phase: null,
    batch: null,
    status: 'not_started',
    code_refs: [],
    test_refs: [],
    verification_refs: [],
    evidence_refs: [],
    notes: [],
  };
}

function loadLedger(ledgerPath) {
  return JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
}

function reconcile(map, prior) {
  const previousById = new Map((prior?.findings || []).map((entry) => [entry.id, entry]));
  const findings = map.findings.map((finding) => ({
    ...blankEntry(finding),
    ...(previousById.get(finding.id) || {}),
    id: finding.id,
    severity: finding.severity,
    group: finding.group,
  }));
  const ledger = {
    schema_version: 1,
    map_path: 'AUTOPROMPT-TOTAL-FIX-MAP.md',
    map_sha256: sha256(map.bytes),
    required_final_status: 'verified',
    findings,
  };
  if (prior?.scope) ledger.scope = prior.scope;
  if (prior?.evidence_index_path) ledger.evidence_index_path = prior.evidence_index_path;
  return ledger;
}

function writeJson(targetPath, value) {
  const temporary = `${targetPath}.tmp`;
  fs.rmSync(temporary, { force: true });
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  fs.renameSync(temporary, targetPath);
}

function writeLedger(ledgerPath, ledger) {
  writeJson(ledgerPath, ledger);
}

function normalizeRefs(values) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function preserveRefOrder(values) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function mark(ledger, args) {
  const id = one(args, 'mark');
  const entry = ledger.findings.find((finding) => finding.id === id);
  if (!entry) throw new Error(`Unknown finding id: ${id}`);
  const status = one(args, 'status', entry.status);
  if (!VALID_STATUS.has(status)) throw new Error(`Invalid status: ${status}`);
  entry.status = status;
  entry.phase = one(args, 'phase', entry.phase);
  entry.batch = one(args, 'batch', entry.batch);
  entry.code_refs = preserveRefOrder([...entry.code_refs, ...many(args, 'code')]);
  entry.test_refs = preserveRefOrder([...entry.test_refs, ...many(args, 'test')]);
  entry.verification_refs = normalizeRefs([...entry.verification_refs, ...many(args, 'verify')]);
  const notes = many(args, 'note');
  entry.notes = normalizeRefs(args.flags.has('replace-notes') ? notes : [...entry.notes, ...notes]);
}

function repositoryReference(value) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('Evidence paths must be non-empty strings');
  const normalized = value.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  if (path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error(`Evidence path escapes the repository: ${value}`);
  }
  const absolute = path.resolve(ROOT, ...normalized.split('/'));
  const relative = path.relative(ROOT, absolute);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Evidence path escapes the repository: ${value}`);
  }
  return { normalized, absolute };
}

function treeEntries(rootPath, prefix = '') {
  const entries = [];
  for (const name of fs.readdirSync(rootPath).sort()) {
    const absolute = path.join(rootPath, name);
    const relative = prefix ? `${prefix}/${name}` : name;
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Symlinks are not accepted as evidence: ${relative}`);
    if (stat.isDirectory()) entries.push(...treeEntries(absolute, relative));
    else if (stat.isFile()) entries.push({ path: relative, bytes: stat.size, sha256: sha256(fs.readFileSync(absolute)) });
    else throw new Error(`Unsupported evidence artifact type: ${relative}`);
  }
  return entries;
}

function artifactRecord(reference, roles) {
  const { normalized, absolute } = repositoryReference(reference);
  if (!fs.existsSync(absolute)) throw new Error(`Evidence artifact does not exist: ${normalized}`);
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) throw new Error(`Symlinks are not accepted as evidence: ${normalized}`);
  if (stat.isFile()) {
    return {
      id: `artifact:${normalized}`,
      path: normalized,
      type: 'file',
      roles: [...roles].sort(),
      bytes: stat.size,
      sha256: sha256(fs.readFileSync(absolute)),
    };
  }
  if (!stat.isDirectory()) throw new Error(`Unsupported evidence artifact type: ${normalized}`);
  const entries = treeEntries(absolute);
  return {
    id: `artifact:${normalized}`,
    path: normalized,
    type: 'directory',
    roles: [...roles].sort(),
    files: entries.length,
    bytes: entries.reduce((total, entry) => total + entry.bytes, 0),
    sha256: sha256(Buffer.from(JSON.stringify(entries))),
  };
}

function evidenceGrade(entry) {
  if (entry.status === 'not_started') return 'none';
  if (entry.status === 'partial') return 'artifact_refs_only';
  if (entry.status === 'implemented') return 'code_and_test_artifacts';
  return 'independently_verified';
}

function verificationCurrentness(bundle, currentCandidateHash, strictSchemaValid, historicalSchemaGaps = []) {
  const currentCandidateMatch = bundle.candidate_hash === currentCandidateHash;
  if (!strictSchemaValid && currentCandidateMatch) {
    throw new Error(`${bundle.id}: current verification bundle is missing the required private-home, Codex network sandbox, or output-summary schema`);
  }
  if (!strictSchemaValid && historicalSchemaGaps.length === 0) {
    throw new Error(`${bundle.id}: historical verification compatibility requires an explicit current-schema gap`);
  }
  const historicalInvalidationReasons = currentCandidateMatch ? [] : [
    'candidate-does-not-match-current-repository',
    ...historicalSchemaGaps,
  ];
  const promotable = currentCandidateMatch && strictSchemaValid && bundle.result === 'PASS' &&
    bundle.independent === true && bundle.exit_code === 0;
  return {
    validation_schema_version: VERIFICATION_CURRENTNESS_SCHEMA,
    validation_status: currentCandidateMatch && strictSchemaValid ? CURRENT_SCHEMA_VALID : HISTORICAL_NON_PROMOTABLE,
    schema_current: strictSchemaValid,
    current_candidate_match: currentCandidateMatch,
    promotion_forbidden: !promotable,
    historical_invalidation_reasons: historicalInvalidationReasons,
  };
}

function verificationRecord(bundle, currentness) {
  return {
    id: bundle.id,
    result: bundle.result,
    independent: bundle.independent,
    finding_ids: [...bundle.finding_ids],
    finding_reviews: [...bundle.finding_reviews],
    reviewer_id: bundle.reviewer_id,
    reviewed_at: bundle.reviewed_at,
    command_argv: [...bundle.command_argv],
    cwd: bundle.cwd,
    started_at: bundle.started_at,
    ended_at: bundle.ended_at,
    exit_code: bundle.exit_code,
    ...currentness,
    candidate_hash: bundle.candidate_hash,
    environment_hash: bundle.environment_hash,
    bundle_ref: `artifact:${bundle.bundle_path}`,
    raw_output_ref: `artifact:${bundle.raw_output_path}`,
    stderr_ref: `artifact:${bundle.stderr_path}`,
    finding_registry_ref: `artifact:${bundle.finding_registry_path}`,
  };
}

function readJsonIfObject(filename) {
  try {
    const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function legacySchemaGaps(directory) {
  const gaps = [];
  const environment = readJsonIfObject(path.join(directory, 'environment.json'));
  const isolation = environment?.execution_isolation;
  if (isolation === undefined) {
    gaps.push('historical-schema-missing-private-home-boundary');
    gaps.push('historical-schema-missing-codex-network-sandbox-boundary');
  } else if (!isolation || typeof isolation !== 'object' || Array.isArray(isolation)) {
    return [];
  } else {
    const privateFields = ['host_home_and_config_inherited', 'synthetic_private_home'];
    const networkFields = ['network', 'permission_profile', 'sandbox_launcher'];
    if (privateFields.some(field => !Object.hasOwn(isolation, field))) gaps.push('historical-schema-missing-private-home-boundary');
    else if (isolation.host_home_and_config_inherited !== false || isolation.synthetic_private_home !== true) return [];
    if (networkFields.some(field => !Object.hasOwn(isolation, field))) gaps.push('historical-schema-missing-codex-network-sandbox-boundary');
    else if (isolation.network !== 'restricted-by-codex-sandbox' || isolation.permission_profile !== ':workspace' ||
      isolation.sandbox_launcher !== 'codex-cli') return [];
  }
  for (const name of ['stdout.bin', 'stderr.bin']) {
    const summary = readJsonIfObject(path.join(directory, name));
    if (!summary || !Object.hasOwn(summary, 'schema_version')) {
      if (!gaps.includes('historical-schema-missing-output-summary')) gaps.push('historical-schema-missing-output-summary');
    } else if (summary.schema_version !== OUTPUT_SUMMARY_SCHEMA) {
      return [];
    }
  }
  return gaps;
}

function historicalCompatibilityError(error) {
  return error?.code === 'CODEX_EVIDENCE_ENVIRONMENT_INVALID' || error?.code === 'CODEX_EVIDENCE_OUTPUT_INVALID';
}

function verificationCurrentnessErrors(record, scanned) {
  const errors = [];
  if (scanned?.validation_status === HISTORICAL_NON_PROMOTABLE && record.current_candidate_match === true) {
    errors.push(`${record.id}: historical verification cannot be relabeled as current`);
  }
  if (record.validation_schema_version !== VERIFICATION_CURRENTNESS_SCHEMA ||
      ![CURRENT_SCHEMA_VALID, HISTORICAL_NON_PROMOTABLE].includes(record.validation_status)) {
    errors.push(`${record.id}: missing or unsupported verification currentness metadata`);
  } else if (record.validation_status === HISTORICAL_NON_PROMOTABLE &&
      (record.current_candidate_match !== false || record.promotion_forbidden !== true ||
       !Array.isArray(record.historical_invalidation_reasons) || record.historical_invalidation_reasons.length === 0)) {
    errors.push(`${record.id}: historical verification must remain invalidated and nonpromotable`);
  } else if (record.validation_status === CURRENT_SCHEMA_VALID &&
      (record.current_candidate_match !== true || record.schema_current !== true)) {
    errors.push(`${record.id}: current verification must satisfy the current security schema`);
  }
  return errors;
}

function scanVerificationBundles() {
  const root = path.join(ROOT, ...VERIFICATION_BUNDLE_ROOT.split('/'));
  verificationGovernanceEntries(ROOT);
  if (!fs.existsSync(root)) return { bundles: [], artifacts: [] };
  const bundles = [];
  const artifacts = [];
  const currentCandidateHash = candidateSnapshot(ROOT, VERIFICATION_BUNDLE_ROOT).hash;
  const names = fs.readdirSync(root).sort();
  for (const name of names) {
    const directory = path.join(root, name);
    if (!fs.lstatSync(directory).isDirectory() || !/^[a-f0-9]{64}$/.test(name)) {
      throw new Error(`Unexpected entry in verification bundle root: ${name}`);
    }
  }
  for (const name of names) {
    const directory = path.join(root, name);
    let bundle;
    let strictSchemaValid = true;
    let gaps = [];
    try {
      bundle = verifyBundle({ repo: ROOT, bundle: directory, integrityOnly: true });
    } catch (error) {
      bundle = readJsonIfObject(path.join(directory, 'bundle.json'));
      gaps = legacySchemaGaps(directory);
      if (!bundle || bundle.candidate_hash === currentCandidateHash || !historicalCompatibilityError(error) || gaps.length === 0) throw error;
      strictSchemaValid = false;
    }
    const currentness = verificationCurrentness(bundle, currentCandidateHash, strictSchemaValid, gaps);
    bundles.push(verificationRecord(bundle, currentness));
    for (const [reference, role] of [
      [bundle.bundle_path, 'verification-bundle'],
      [bundle.raw_output_path, 'verification-output'],
      [bundle.stderr_path, 'verification-output'],
      [bundle.candidate_manifest_path, 'verification-support'],
      [bundle.environment_manifest_path, 'verification-support'],
      [bundle.execution_record_path, 'verification-support'],
      [bundle.reviewer_verdict_path, 'verification-support'],
      [bundle.finding_registry_path, 'verification-support'],
    ]) artifacts.push({ reference, role });
  }
  return { bundles, artifacts };
}

function buildEvidenceIndex(map, ledger, ledgerPath, evidenceIndexPath) {
  const artifactRoles = new Map();
  const discardedLegacyVerificationRefs = [];
  const verificationBundles = scanVerificationBundles();
  const promotableVerifications = new Map(verificationBundles.bundles
    .filter(record => record.promotion_forbidden === false)
    .map(record => [record.id, record]));
  for (const entry of ledger.findings) {
    entry.code_refs = preserveRefOrder(entry.code_refs || []);
    entry.test_refs = preserveRefOrder(entry.test_refs || []);
    for (const reference of entry.code_refs) {
      if (!artifactRoles.has(reference)) artifactRoles.set(reference, new Set());
      artifactRoles.get(reference).add('implementation');
    }
    for (const reference of entry.test_refs) {
      if (!artifactRoles.has(reference)) artifactRoles.set(reference, new Set());
      artifactRoles.get(reference).add('test-declaration');
    }
    const legacy = (entry.verification_refs || []).filter((reference) => !String(reference).startsWith('verification:'));
    if (legacy.length > 0) discardedLegacyVerificationRefs.push({ id: entry.id, refs: normalizeRefs(legacy) });
    entry.verification_refs = normalizeRefs((entry.verification_refs || []).filter((reference) => String(reference).startsWith('verification:')));
  }
  for (const { reference, role } of verificationBundles.artifacts) {
    if (!artifactRoles.has(reference)) artifactRoles.set(reference, new Set());
    artifactRoles.get(reference).add(role);
  }

  const artifacts = [...artifactRoles.entries()]
    .map(([reference, roles]) => artifactRecord(reference, roles))
    .sort((left, right) => left.id.localeCompare(right.id));
  const artifactIds = new Set(artifacts.map(({ id }) => id));

  for (const entry of ledger.findings) {
    entry.evidence_refs = [`finding-evidence:${entry.id}`];
    if (entry.status !== 'not_started' && entry.code_refs.length === 0 && entry.test_refs.length === 0) entry.status = 'not_started';
    else if (STATUS_RANK.get(entry.status) >= STATUS_RANK.get('implemented') &&
      (entry.code_refs.length === 0 || entry.test_refs.length === 0)) entry.status = 'partial';
    else if (entry.status === 'verified' && !entry.verification_refs.some(reference => {
      const verification = promotableVerifications.get(reference);
      return verification && verification.finding_ids.includes(entry.id);
    })) entry.status = 'implemented';
  }

  const repositoryIndexPath = path.relative(ROOT, evidenceIndexPath).replaceAll('\\', '/');
  if (repositoryIndexPath === '..' || repositoryIndexPath.startsWith('../') || path.isAbsolute(repositoryIndexPath)) {
    throw new Error('Evidence index must be written inside the repository');
  }
  ledger.evidence_index_path = path.relative(path.dirname(ledgerPath), evidenceIndexPath).replaceAll('\\', '/');
  ledger.scope = 'codex-only';
  const counts = summary(ledger).by_status;
  const evidenceCounts = ledger.findings.reduce((result, entry) => {
    const grade = evidenceGrade(entry);
    result[grade] = (result[grade] || 0) + 1;
    return result;
  }, {});
  const index = {
    schema_version: 1,
    scope: 'codex-only',
    ledger_path: path.relative(ROOT, ledgerPath).replaceAll('\\', '/'),
    map_path: ledger.map_path,
    map_sha256: sha256(map.bytes),
    rules: {
      not_started: 'No usable implementation or test artifact is referenced.',
      partial: 'At least one implementation/test artifact exists, but the acceptance change is incomplete or unevidenced.',
      implemented: 'Content-addressed implementation and test-declaration artifacts exist; execution is not implied.',
      verified: 'Implemented plus an independent PASS record with preserved content-addressed raw output.',
    },
    summary: { total: ledger.findings.length, by_status: counts, by_evidence_grade: evidenceCounts },
    artifacts,
    verifications: verificationBundles.bundles,
    findings: ledger.findings.map((entry) => ({
      id: entry.id,
      record_id: `finding-evidence:${entry.id}`,
      status: entry.status,
      evidence_grade: evidenceGrade(entry),
      artifact_refs: normalizeRefs([...entry.code_refs, ...entry.test_refs].map((reference) => `artifact:${reference}`)),
      verification_refs: [...entry.verification_refs],
    })),
    discarded_legacy_verification_refs: discardedLegacyVerificationRefs,
  };
  for (const finding of index.findings) {
    for (const reference of finding.artifact_refs) {
      if (!artifactIds.has(reference)) throw new Error(`${finding.id}: evidence index omitted ${reference}`);
    }
  }
  return index;
}

function loadEvidenceIndex(ledger, ledgerPath) {
  if (!ledger.evidence_index_path) return null;
  const indexPath = path.resolve(path.dirname(ledgerPath), ledger.evidence_index_path);
  const relative = path.relative(ROOT, indexPath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Ledger evidence_index_path escapes the repository');
  }
  return JSON.parse(fs.readFileSync(indexPath, 'utf8'));
}

function validateEvidenceIndex(map, ledger, index) {
  const errors = [];
  if (!index || index.schema_version !== 1) return ['Missing or unsupported Codex evidence index'];
  if (index.scope !== 'codex-only') errors.push('Evidence index scope must be codex-only');
  if (ledger.scope !== 'codex-only') errors.push('Ledger scope must be codex-only when an evidence index is present');
  if (index.map_sha256 !== sha256(map.bytes)) errors.push('Evidence index map_sha256 does not match the current fix map');
  const artifacts = new Map();
  for (const artifact of index.artifacts || []) {
    if (artifacts.has(artifact.id)) errors.push(`Duplicate evidence artifact id: ${artifact.id}`);
    artifacts.set(artifact.id, artifact);
    try {
      const current = artifactRecord(artifact.path, new Set(artifact.roles || []));
      for (const field of ['id', 'type', 'bytes', 'sha256']) {
        if (current[field] !== artifact[field]) errors.push(`${artifact.id}: stale ${field}`);
      }
      if (current.type === 'directory' && current.files !== artifact.files) errors.push(`${artifact.id}: stale files count`);
    } catch (error) {
      errors.push(`${artifact.id}: ${error.message}`);
    }
  }
  const scannedVerifications = scanVerificationBundles().bundles;
  const scannedById = new Map(scannedVerifications.map(record => [record.id, record]));
  if (JSON.stringify(index.verifications || []) !== JSON.stringify(scannedVerifications)) {
    errors.push('Evidence index verification bundles are stale');
  }
  const verifications = new Map();
  for (const record of index.verifications || []) {
    if (verifications.has(record.id)) errors.push(`Duplicate verification evidence id: ${record.id}`);
    verifications.set(record.id, record);
    const scanned = scannedById.get(record.id);
    errors.push(...verificationCurrentnessErrors(record, scanned));
  }
  const indexedFindings = new Map((index.findings || []).map((entry) => [entry.id, entry]));
  for (const entry of ledger.findings || []) {
    const indexed = indexedFindings.get(entry.id);
    if (!indexed) {
      errors.push(`${entry.id}: missing from evidence index`);
      continue;
    }
    const expectedArtifactRefs = normalizeRefs([...(entry.code_refs || []).map((reference) => `artifact:${reference}`),
      ...(entry.test_refs || []).map((reference) => `artifact:${reference}`)]);
    if (JSON.stringify(entry.evidence_refs || []) !== JSON.stringify([`finding-evidence:${entry.id}`])) errors.push(`${entry.id}: ledger evidence_refs are stale`);
    if (indexed.record_id !== `finding-evidence:${entry.id}` ||
      JSON.stringify(indexed.artifact_refs || []) !== JSON.stringify(expectedArtifactRefs) ||
      JSON.stringify(indexed.verification_refs || []) !== JSON.stringify(entry.verification_refs || [])) {
      errors.push(`${entry.id}: indexed evidence references are stale`);
    }
    if (indexed.status !== entry.status || indexed.evidence_grade !== evidenceGrade(entry)) errors.push(`${entry.id}: indexed status is stale`);
    for (const reference of expectedArtifactRefs) {
      if (!artifacts.has(reference)) errors.push(`${entry.id}: unknown artifact evidence ${reference}`);
    }
    for (const reference of entry.verification_refs || []) {
      const verification = verifications.get(reference);
      if (!verification) errors.push(`${entry.id}: unknown verification evidence ${reference}`);
      else {
        const rawOutput = artifacts.get(verification.raw_output_ref);
        const bundleArtifact = artifacts.get(verification.bundle_ref);
        if (verification.result !== 'PASS' || verification.independent !== true || verification.exit_code !== 0 ||
          verification.current_candidate_match !== true ||
          verification.validation_status !== CURRENT_SCHEMA_VALID || verification.schema_current !== true ||
          verification.promotion_forbidden !== false ||
          !(verification.finding_ids || []).includes(entry.id) || !rawOutput || !bundleArtifact ||
          !(rawOutput.roles || []).includes('verification-output') ||
          !(bundleArtifact.roles || []).includes('verification-bundle')) {
        errors.push(`${entry.id}: verification evidence is not an independent preserved PASS`);
        }
      }
    }
  }
  if ((index.summary || {}).total !== ledger.findings.length ||
    JSON.stringify(index.summary?.by_status) !== JSON.stringify(summary(ledger).by_status)) errors.push('Evidence index summary is stale');
  const expectedEvidenceCounts = ledger.findings.reduce((result, entry) => {
    const grade = evidenceGrade(entry);
    result[grade] = (result[grade] || 0) + 1;
    return result;
  }, {});
  if (JSON.stringify(index.summary?.by_evidence_grade) !== JSON.stringify(expectedEvidenceCounts)) {
    errors.push('Evidence index evidence-grade summary is stale');
  }
  return errors;
}

function validate(map, ledger, requiredStatus, evidenceIndex) {
  const errors = [];
  const expected = new Map(map.findings.map((finding) => [finding.id, finding]));
  const actual = new Map();
  if (ledger.schema_version !== 1) errors.push(`Unsupported ledger schema: ${ledger.schema_version}`);
  if (ledger.map_sha256 !== sha256(map.bytes)) errors.push('Ledger map_sha256 does not match the current fix map; run --init to reconcile.');
  for (const entry of ledger.findings || []) {
    if (actual.has(entry.id)) errors.push(`Duplicate ledger id: ${entry.id}`);
    actual.set(entry.id, entry);
    const finding = expected.get(entry.id);
    if (!finding) {
      errors.push(`Ledger contains unknown id: ${entry.id}`);
      continue;
    }
    if (entry.severity !== finding.severity) errors.push(`${entry.id}: severity mismatch`);
    if (entry.group !== finding.group) errors.push(`${entry.id}: group mismatch`);
    if (!VALID_STATUS.has(entry.status)) errors.push(`${entry.id}: invalid status ${entry.status}`);
    const strictEvidence = Boolean(ledger.evidence_index_path);
    if (strictEvidence && entry.status === 'partial' &&
        (!Array.isArray(entry.code_refs) || entry.code_refs.length === 0) &&
        (!Array.isArray(entry.test_refs) || entry.test_refs.length === 0)) {
      errors.push(`${entry.id}: partial requires at least one artifact reference`);
    }
    if (STATUS_RANK.get(entry.status) >= STATUS_RANK.get('implemented') && (!Array.isArray(entry.code_refs) || entry.code_refs.length === 0)) {
      errors.push(`${entry.id}: ${entry.status} requires code_refs`);
    }
    if (strictEvidence && STATUS_RANK.get(entry.status) >= STATUS_RANK.get('implemented') &&
        (!Array.isArray(entry.test_refs) || entry.test_refs.length === 0)) {
      errors.push(`${entry.id}: ${entry.status} requires test_refs`);
    }
    if (entry.status === 'verified' && (!Array.isArray(entry.verification_refs) || entry.verification_refs.length === 0)) {
      errors.push(`${entry.id}: verified requires independent verification_refs`);
    }
    if (requiredStatus && STATUS_RANK.get(entry.status) < STATUS_RANK.get(requiredStatus)) {
      errors.push(`${entry.id}: ${entry.status}, requires ${requiredStatus}`);
    }
  }
  for (const id of expected.keys()) {
    if (!actual.has(id)) errors.push(`Ledger missing id: ${id}`);
  }
  if (ledger.evidence_index_path) errors.push(...validateEvidenceIndex(map, ledger, evidenceIndex));
  return errors;
}

function summary(ledger) {
  const byStatus = Object.fromEntries([...VALID_STATUS].map((status) => [status, 0]));
  const bySeverity = {};
  for (const finding of ledger.findings || []) {
    byStatus[finding.status] = (byStatus[finding.status] || 0) + 1;
    if (!bySeverity[finding.severity]) bySeverity[finding.severity] = Object.fromEntries([...VALID_STATUS].map((status) => [status, 0]));
    bySeverity[finding.severity][finding.status] += 1;
  }
  return { total: ledger.findings.length, by_status: byStatus, by_severity: bySeverity };
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  const mapPath = path.resolve(one(args, 'map', DEFAULT_MAP));
  const ledgerPath = path.resolve(one(args, 'ledger', DEFAULT_LEDGER));
  const evidenceIndexPath = path.resolve(one(args, 'evidence-index', DEFAULT_EVIDENCE_INDEX));
  const map = parseMap(mapPath);
  let ledger;

  if (args.flags.has('init')) {
    const prior = fs.existsSync(ledgerPath) ? loadLedger(ledgerPath) : null;
    ledger = reconcile(map, prior);
    writeLedger(ledgerPath, ledger);
  } else {
    ledger = loadLedger(ledgerPath);
  }

  if (one(args, 'mark')) {
    mark(ledger, args);
    ledger.map_sha256 = sha256(map.bytes);
    writeLedger(ledgerPath, ledger);
  }

  if (args.flags.has('reconcile-evidence')) {
    ledger.map_sha256 = sha256(map.bytes);
    const index = buildEvidenceIndex(map, ledger, ledgerPath, evidenceIndexPath);
    writeJson(evidenceIndexPath, index);
    writeLedger(ledgerPath, ledger);
  }

  const requiredStatus = one(args, 'require');
  if (requiredStatus && !VALID_STATUS.has(requiredStatus)) throw new Error(`Invalid --require status: ${requiredStatus}`);
  const evidenceIndex = loadEvidenceIndex(ledger, ledgerPath);
  const errors = validate(map, ledger, requiredStatus, evidenceIndex);
  process.stdout.write(`${JSON.stringify(summary(ledger), null, 2)}\n`);
  if (errors.length > 0) fail(errors.join('\n'));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    fail(error.stack || error.message || String(error));
  }
}

module.exports = {
  CURRENT_SCHEMA_VALID,
  HISTORICAL_NON_PROMOTABLE,
  VERIFICATION_CURRENTNESS_SCHEMA,
  legacySchemaGaps,
  verificationCurrentness,
  verificationCurrentnessErrors,
};
