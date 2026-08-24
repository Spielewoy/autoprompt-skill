'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');
const MAP = path.join(ROOT, 'AUTOPROMPT-TOTAL-FIX-MAP.md');
const PHASE_HEADERS = [
  'Phase',
  'Depends on',
  'Implementation status',
  'Independent-verification status',
  'Required result',
];
const BATCH_HEADERS = [
  'Batch',
  'Phase',
  'Finding ids',
  'Owner',
  'Exact files',
  'Implementation status',
  'Exact command',
  'Result / count',
  'Evidence bundle / SHA-256',
  'Independent-verification status',
  'Remaining work',
];
const IMPLEMENTATION_STATUSES = new Set(['NOT STARTED', 'ACTIVE', 'REPAIR ACTIVE', 'IMPLEMENTED', 'BLOCKED', 'REVERTED']);
const VERIFICATION_STATUSES = new Set(['NOT VERIFIED', 'VERIFIED', 'FAILED']);
const COMMAND_RE = /^`(?:node|npm|npx|git|pwsh|powershell|bash|sh)(?: [^`\r\n]+)+`$/;
const RESULT_RE = /^(?:PASS|FAIL) \((\d+)\/(\d+)\)$/;
const EVIDENCE_RE = /^`([^`]+)` @ `sha256:([a-f0-9]{64})`$/;

function cells(line) {
  return line.slice(1, -1).split('|').map((cell) => cell.trim());
}

function tableAfter(markdown, heading) {
  const start = markdown.indexOf(heading);
  assert.notEqual(start, -1, `missing ${heading}`);
  const lines = markdown.slice(start).split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.startsWith('|'));
  assert.notEqual(headerIndex, -1, `missing table after ${heading}`);
  const rows = [];
  for (const line of lines.slice(headerIndex + 2)) {
    if (!line.startsWith('|')) break;
    rows.push(cells(line));
  }
  return { headers: cells(lines[headerIndex]), rows };
}

function phasesIn(value) {
  const match = /^(P\d+)(?:-(P\d+))?$/.exec(value);
  assert.ok(match, `inexact phase reference: ${value}`);
  const first = Number(match[1].slice(1));
  const last = match[2] ? Number(match[2].slice(1)) : first;
  assert.ok(first <= last, `reversed phase range: ${value}`);
  return Array.from({ length: last - first + 1 }, (_, offset) => `P${first + offset}`);
}

function validateEvidence(value, root) {
  if (value === 'NOT RECORDED') return false;
  const match = EVIDENCE_RE.exec(value);
  assert.ok(match, `inexact evidence bundle/hash: ${value}`);
  const relative = match[1];
  assert.equal(path.isAbsolute(relative), false, `evidence path must be repository-relative: ${relative}`);
  const resolved = path.resolve(root, relative);
  assert.ok(resolved.startsWith(`${root}${path.sep}`), `evidence path escapes repository: ${relative}`);
  assert.ok(fs.existsSync(resolved), `missing evidence bundle: ${relative}`);
  const actual = crypto.createHash('sha256').update(fs.readFileSync(resolved)).digest('hex');
  assert.equal(actual, match[2], `stale evidence hash: ${relative}`);
  return true;
}

function validateBoard(markdown, root = ROOT) {
  assert.match(
    markdown,
    /AP-DESIGN-024 board implementation status: `IMPLEMENTED`; independent-verification status: `NOT VERIFIED`\./,
    'AP-DESIGN-024 must distinguish implementation from independent verification',
  );

  const phaseTable = tableAfter(markdown, '### Durable progress board');
  assert.deepEqual(phaseTable.headers, PHASE_HEADERS, 'phase board headers are missing or inexact');
  assert.ok(phaseTable.rows.length > 0, 'phase board has no rows');
  const phaseStates = new Map();
  for (const row of phaseTable.rows) {
    assert.equal(row.length, PHASE_HEADERS.length, `phase row has ${row.length} fields, expected ${PHASE_HEADERS.length}`);
    const phaseId = /^(P\d+)\b/.exec(row[0])?.[1];
    assert.ok(phaseId, `inexact phase id: ${row[0]}`);
    assert.equal(phaseStates.has(phaseId), false, `duplicate phase: ${phaseId}`);
    assert.ok(IMPLEMENTATION_STATUSES.has(row[2]), `inexact phase implementation status: ${row[2]}`);
    assert.ok(VERIFICATION_STATUSES.has(row[3]), `inexact phase verification status: ${row[3]}`);
    assert.notEqual(row[4], '', `missing required result for ${phaseId}`);
    if (row[2] !== 'IMPLEMENTED') {
      assert.notEqual(row[3], 'VERIFIED', `stale phase status: ${phaseId} is ${row[2]} but VERIFIED`);
    }
    phaseStates.set(phaseId, { implementation: row[2], verification: row[3] });
  }

  const batchTable = tableAfter(markdown, '### Per-batch record template');
  assert.deepEqual(batchTable.headers, BATCH_HEADERS, 'batch board headers are missing or inexact');
  assert.ok(batchTable.rows.length > 0, 'batch board has no rows');
  const batchIds = new Set();
  for (const row of batchTable.rows) {
    assert.equal(row.length, BATCH_HEADERS.length, `batch row has ${row.length} fields, expected ${BATCH_HEADERS.length}`);
    const [batch, phase, findingIds, owner, exactFiles, implementation, command, result, evidence, verification, remaining] = row;
    assert.match(batch, /^[A-Z0-9]+(?:-[A-Z0-9]+)+$/, `inexact batch id: ${batch}`);
    assert.equal(batchIds.has(batch), false, `duplicate batch: ${batch}`);
    batchIds.add(batch);
    assert.notEqual(findingIds, '', `missing finding ids for ${batch}`);
    assert.notEqual(owner, '', `missing owner for ${batch}`);
    assert.notEqual(exactFiles, '', `missing exact files for ${batch}`);
    assert.notEqual(remaining, '', `missing remaining work for ${batch}`);
    assert.ok(IMPLEMENTATION_STATUSES.has(implementation), `inexact implementation status for ${batch}: ${implementation}`);
    assert.ok(VERIFICATION_STATUSES.has(verification), `inexact verification status for ${batch}: ${verification}`);
    const commandRecorded = command !== 'NOT RECORDED';
    if (commandRecorded) assert.match(command, COMMAND_RE, `inexact command for ${batch}`);
    const resultRecorded = result !== 'NOT RECORDED';
    let resultMatch = null;
    if (resultRecorded) {
      resultMatch = RESULT_RE.exec(result);
      assert.ok(resultMatch, `inexact result/count for ${batch}: ${result}`);
      assert.equal(commandRecorded, true, `result/count lacks an exact command for ${batch}`);
    }
    const evidenceRecorded = validateEvidence(evidence, root);
    if (evidenceRecorded) {
      assert.equal(commandRecorded, true, `evidence lacks an exact command for ${batch}`);
      assert.equal(resultRecorded, true, `evidence lacks an exact result/count for ${batch}`);
    }
    if (verification === 'VERIFIED') {
      assert.equal(implementation, 'IMPLEMENTED', `active or incomplete batch falsely VERIFIED: ${batch}`);
      assert.ok(resultMatch && resultMatch[1] === resultMatch[2] && Number(resultMatch[1]) > 0 && result.startsWith('PASS'), `VERIFIED batch lacks a complete PASS count: ${batch}`);
      assert.equal(evidenceRecorded, true, `VERIFIED batch lacks immutable evidence: ${batch}`);
    }
    for (const phaseId of phasesIn(phase)) {
      assert.ok(phaseStates.has(phaseId), `batch ${batch} references missing phase ${phaseId}`);
      const phaseState = phaseStates.get(phaseId);
      if (phaseState.implementation === 'NOT STARTED') {
        assert.equal(implementation, 'NOT STARTED', `stale phase/batch status: ${phaseId} is NOT STARTED but ${batch} is ${implementation}`);
      }
      if (phaseState.verification === 'VERIFIED') {
        assert.equal(verification, 'VERIFIED', `stale phase/batch verification: ${phaseId} is VERIFIED but ${batch} is ${verification}`);
      }
    }
  }
}

function fixture(overrides = {}) {
  const phaseImplementation = overrides.phaseImplementation || 'ACTIVE';
  const phaseVerification = overrides.phaseVerification || 'NOT VERIFIED';
  const implementation = overrides.implementation || 'ACTIVE';
  const command = overrides.command || 'NOT RECORDED';
  const result = overrides.result || 'NOT RECORDED';
  const evidence = overrides.evidence || 'NOT RECORDED';
  const verification = overrides.verification || 'NOT VERIFIED';
  return [
    'AP-DESIGN-024 board implementation status: `IMPLEMENTED`; independent-verification status: `NOT VERIFIED`.',
    '### Durable progress board',
    '',
    `| ${PHASE_HEADERS.join(' | ')} |`,
    `| ${PHASE_HEADERS.map(() => '---').join(' | ')} |`,
    `| P0 Fixture | None | ${phaseImplementation} | ${phaseVerification} | Fixture result |`,
    '',
    '### Per-batch record template',
    '',
    `| ${BATCH_HEADERS.join(' | ')} |`,
    `| ${BATCH_HEADERS.map(() => '---').join(' | ')} |`,
    `| P0-FIXTURE | P0 | AP-DESIGN-024 | owner | file | ${implementation} | ${command} | ${result} | ${evidence} | ${verification} | Pending |`,
  ].join('\n');
}

test('AP-DESIGN-024 phase board carries exact per-batch provenance without false verification', () => {
  validateBoard(fs.readFileSync(MAP, 'utf8'));
});

test('validator rejects missing required board fields', () => {
  assert.throws(() => validateBoard(fixture().replace(' | Exact command', '')), /headers are missing or inexact/);
});

test('validator rejects inexact commands and unbound result counts', () => {
  assert.throws(() => validateBoard(fixture({ command: 'focused tests' })), /inexact command/);
  assert.throws(() => validateBoard(fixture({ result: 'PASS (1\/1)' })), /lacks an exact command/);
});

test('validator rejects stale evidence hashes and active batches marked VERIFIED', () => {
  const stale = '`AUTOPROMPT-TOTAL-FIX-MAP.md` @ `sha256:0000000000000000000000000000000000000000000000000000000000000000`';
  assert.throws(
    () => validateBoard(fixture({ command: '`node --test fixture.test.cjs`', result: 'PASS (1/1)', evidence: stale })),
    /stale evidence hash/,
  );
  assert.throws(() => validateBoard(fixture({ verification: 'VERIFIED' })), /falsely VERIFIED/);
});
