'use strict'

const { canonicalStringify, digestRecord, exactKeys, fail, hashPattern, isoDate } = require('./core.cjs')
const { requireRoleDigest, signRoleDigest } = require('./trust-registry.cjs')

const FAULT_DIAGNOSES = Object.freeze({
  'wrong-model': Object.freeze({ check: 'model-version', diagnosis: 'WRONG_MODEL' }),
  'missing-subagent-trace': Object.freeze({ check: 'subagents', diagnosis: 'MISSING_SUBAGENT_TRACE' }),
  'broken-verifier': Object.freeze({ check: 'verifier', diagnosis: 'BROKEN_VERIFIER' }),
  'upload-denied': Object.freeze({ check: 'upload', diagnosis: 'UPLOAD_DENIED' }),
})

function deriveCanaryResult(planned, raw) {
  exactKeys(raw, ['checks'], 'CANARY_RESULT_INVALID', 'raw canary observations')
  if (!raw.checks || typeof raw.checks !== 'object' || Array.isArray(raw.checks)) fail('CANARY_RESULT_INVALID', 'raw canary checks are required')
  const names = Object.keys(raw.checks)
  if (canonicalStringify([...names].sort()) !== canonicalStringify([...planned.checks].sort())) fail('CANARY_RESULT_INVALID', 'raw canary checks differ from the signed canary plan')
  for (const [name, outcome] of Object.entries(raw.checks)) if (!['pass', 'fail'].includes(outcome)) fail('CANARY_RESULT_INVALID', `canary check has invalid outcome: ${name}`)
  const failed = names.filter(name => raw.checks[name] === 'fail')
  if (planned.polarity === 'positive') {
    if (failed.length) fail('CANARY_FAILED', 'positive canary observed a failed check', { failed })
    return Object.freeze({ passed: true, diagnosis: null })
  }
  const contract = planned.execution && planned.execution.faultInjector && FAULT_DIAGNOSES[planned.execution.faultInjector.name]
  if (!contract || failed.length !== 1 || failed[0] !== contract.check || contract.diagnosis !== planned.expectedDiagnosis) {
    fail('CANARY_DIAGNOSIS_MISMATCH', 'controller could not independently derive the preregistered diagnosis', { failed, fault: planned.execution && planned.execution.faultInjector && planned.execution.faultInjector.name })
  }
  return Object.freeze({ passed: true, diagnosis: contract.diagnosis })
}

function signCanaryControllerRecord(manifestDigest, planned, observationDescriptor, recordedAt, signer) {
  if (!observationDescriptor || !hashPattern(observationDescriptor.sha256)) fail('CANARY_CONTROLLER_INVALID', 'canary observation descriptor is required')
  const core = {
    schemaVersion: 'benchmark-canary-controller.v2', manifestDigest,
    attemptId: planned.attemptId, injectedFault: planned.execution.faultInjector ? planned.execution.faultInjector.name : null,
    observationSha256: observationDescriptor.sha256, recordedAt,
  }
  isoDate(recordedAt, 'CANARY_CONTROLLER_INVALID', 'recordedAt')
  const recordDigest = digestRecord(core)
  return Object.freeze({ ...core, recordDigest, signature: signRoleDigest('controller', recordDigest, recordedAt, signer) })
}

function validateCanaryControllerRecord(record, manifestDigest, planned, observationDescriptor, trustRegistry) {
  exactKeys(record, ['schemaVersion', 'manifestDigest', 'attemptId', 'injectedFault', 'observationSha256', 'recordedAt', 'recordDigest', 'signature'], 'CANARY_CONTROLLER_INVALID', 'canary controller record')
  const expectedFault = planned.execution.faultInjector ? planned.execution.faultInjector.name : null
  if (record.schemaVersion !== 'benchmark-canary-controller.v2' || record.manifestDigest !== manifestDigest || record.attemptId !== planned.attemptId || record.injectedFault !== expectedFault || record.observationSha256 !== observationDescriptor.sha256) fail('CANARY_CONTROLLER_INVALID', 'canary controller record differs from signed execution or observation')
  isoDate(record.recordedAt, 'CANARY_CONTROLLER_INVALID', 'recordedAt')
  const core = { ...record }; delete core.recordDigest; delete core.signature
  if (!hashPattern(record.recordDigest) || record.recordDigest !== digestRecord(core)) fail('CANARY_CONTROLLER_INVALID', 'canary controller record digest is invalid')
  requireRoleDigest(trustRegistry, 'controller', record.recordDigest, record.recordedAt, record.signature, 'CANARY_CONTROLLER_SIGNATURE_INVALID')
  return record
}

module.exports = { FAULT_DIAGNOSES, deriveCanaryResult, signCanaryControllerRecord, validateCanaryControllerRecord }
