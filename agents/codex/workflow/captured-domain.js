'use strict'

const crypto = require('node:crypto')

const SCHEMA_VERSION = '1.0.0'
const KINDS = Object.freeze([
  'MISSION_SOURCE_CONFLICT',
  'SIGNATURE_SEARCH',
  'FIXTURE_PROVENANCE',
  'HIDDEN_EXTERNAL_ORACLE',
  'IMAGE_DATUM',
  'DONE_RETRY_PROMOTION',
])

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hash(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
}

function text(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function hasExactKeys(value, keys) {
  return isObject(value) && same(Object.keys(value).sort(), keys.slice().sort())
}

function nullableHash(value) {
  return value === null || hash(value)
}

function baseErrors(contract) {
  const errors = []
  if (!isObject(contract)) return ['captured-domain contract must be an object']
  if (contract.schemaVersion !== SCHEMA_VERSION) errors.push(`schemaVersion must be ${SCHEMA_VERSION}`)
  if (!KINDS.includes(contract.kind)) errors.push('kind must be a captured incident domain')
  return errors
}

function validateContract(contract) {
  const errors = baseErrors(contract)
  if (errors.length > 0 || !KINDS.includes(contract.kind)) return { valid: false, errors }
  switch (contract.kind) {
    case 'MISSION_SOURCE_CONFLICT': {
      if (!hasExactKeys(contract, [
        'schemaVersion', 'kind', 'certificateHash', 'sourceDataHash',
        'priorCertificateHash', 'priorSourceDataHash', 'retryAuthority',
      ])) {
        errors.push('mission-source conflict contract must contain current/prior certificate, source-data, and retry-authority references')
      }
      for (const field of ['certificateHash', 'sourceDataHash', 'priorCertificateHash', 'priorSourceDataHash']) {
        if (!hash(contract[field])) errors.push(`${field} must be SHA-256`)
      }
      const authority = contract.retryAuthority
      if (!isObject(authority)) errors.push('retryAuthority must be a typed certificate reference')
      else if (authority.mode === 'UNCHANGED_CERTIFICATE') {
        if (!hash(authority.immutableRetryBindingHash) || Object.keys(authority).length !== 2) {
          errors.push('unchanged retry requires only immutableRetryBindingHash')
        }
      } else if (authority.mode === 'NEW_SOURCE_DATA') {
        if (!hash(authority.sourceTransitionCertificateHash) || Object.keys(authority).length !== 2) {
          errors.push('new source data requires only sourceTransitionCertificateHash')
        }
      } else if (authority.mode === 'EXPLICIT_USER_AUTHORITY') {
        if (!hash(authority.userAuthorityCertificateHash) || Object.keys(authority).length !== 2) {
          errors.push('user-authorized change requires only userAuthorityCertificateHash')
        }
      } else errors.push('retryAuthority.mode must name the only permitted retry authority')
      if (authority && authority.mode === 'UNCHANGED_CERTIFICATE' &&
          (contract.certificateHash !== contract.priorCertificateHash ||
           contract.sourceDataHash !== contract.priorSourceDataHash)) {
        errors.push('UNCHANGED_CERTIFICATE requires the prior certificate and source data to remain byte-identical')
      }
      if (authority && authority.mode === 'NEW_SOURCE_DATA' &&
          contract.sourceDataHash === contract.priorSourceDataHash) {
        errors.push('NEW_SOURCE_DATA requires source data that differs from the persisted prior source')
      }
      break
    }
    case 'SIGNATURE_SEARCH':
      if (!hash(contract.strongestInvariantInventoryHash)) errors.push('strongestInvariantInventoryHash must be SHA-256')
      if (typeof contract.secondCandidateFamily !== 'boolean') errors.push('secondCandidateFamily must be boolean')
      if (!nullableHash(contract.identifiabilityProofHash)) errors.push('identifiabilityProofHash must be SHA-256 or null')
      if (contract.secondCandidateFamily === true && !hash(contract.identifiabilityProofHash)) {
        errors.push('a second candidate family requires an identifiability proof')
      }
      break
    case 'FIXTURE_PROVENANCE':
      for (const field of ['fixtureProvenanceHash', 'mutationReplayHash', 'executablePrebuildValidationHash']) {
        if (!hash(contract[field])) errors.push(`${field} must be SHA-256`)
      }
      if (contract.initialStatus !== 'RED') errors.push('fixture provenance must begin RED')
      if (contract.executablePrebuildValidationRequired !== true) {
        errors.push('executable pre-build validation must be required')
      }
      break
    case 'HIDDEN_EXTERNAL_ORACLE':
      if (!text(contract.externalOracleId)) errors.push('externalOracleId must be concrete')
      if (contract.verificationRoute !== 'EXTERNALLY_VERIFIABLE_ONLY') {
        errors.push('verificationRoute must be EXTERNALLY_VERIFIABLE_ONLY')
      }
      if (contract.maxProvisionalWorkerLaunches !== 1) errors.push('provisional work must be capped at one worker')
      if (contract.localDoneAllowed !== false) errors.push('hidden external evidence must forbid local DONE')
      break
    case 'IMAGE_DATUM': {
      if (!hasExactKeys(contract, [
        'schemaVersion', 'kind', 'imageEvidenceHash', 'selectedInterpretation',
        'alternativeInterpretations', 'rulingHash', 'certificateHash',
      ])) {
        errors.push('image datum contract must use the selected-versus-alternatives representation')
      }
      for (const field of ['imageEvidenceHash', 'rulingHash', 'certificateHash']) {
        if (!hash(contract[field])) errors.push(`${field} must be SHA-256`)
      }
      if (!hasExactKeys(contract.selectedInterpretation, ['id', 'interpretation']) || !text(contract.selectedInterpretation.id) ||
          !text(contract.selectedInterpretation.interpretation)) {
        errors.push('selectedInterpretation requires id and interpretation')
      }
      if (!Array.isArray(contract.alternativeInterpretations) || contract.alternativeInterpretations.length < 1) {
        errors.push('at least one alternative datum interpretation is required')
      } else if (contract.alternativeInterpretations.some(item => !text(item)) ||
          new Set(contract.alternativeInterpretations).size !== contract.alternativeInterpretations.length) {
        errors.push('alternative datum interpretations must be unique non-empty strings')
      }
      break
    }
    case 'DONE_RETRY_PROMOTION':
      if (!hasExactKeys(contract, [
        'schemaVersion', 'kind', 'priorDoneCandidateHash', 'isolationCertificateHash', 'requiredAcceptanceIds',
      ])) {
        errors.push('DONE retry contract must contain only prior-candidate and isolation-certificate references')
      }
      for (const field of ['priorDoneCandidateHash', 'isolationCertificateHash']) {
        if (!hash(contract[field])) errors.push(`${field} must be SHA-256`)
      }
      if (!Array.isArray(contract.requiredAcceptanceIds) || contract.requiredAcceptanceIds.length === 0 ||
          contract.requiredAcceptanceIds.some(item => !text(item)) ||
          new Set(contract.requiredAcceptanceIds).size !== contract.requiredAcceptanceIds.length) {
        errors.push('requiredAcceptanceIds must be a non-empty unique string array')
      }
      break
  }
  return { valid: errors.length === 0, errors }
}

function normalizeContracts(input, facts = {}) {
  const supplied = input == null ? [] : input
  const contracts = Array.isArray(supplied) ? supplied.map(clone) : [clone(supplied)]
  const hidden = facts.checkAndBaseline && facts.checkAndBaseline.hiddenExternalCheck === true
  if (hidden && !contracts.some(contract => contract.kind === 'HIDDEN_EXTERNAL_ORACLE')) {
    contracts.push({
      schemaVersion: SCHEMA_VERSION,
      kind: 'HIDDEN_EXTERNAL_ORACLE',
      externalOracleId: 'declared-hidden-external-check',
      verificationRoute: 'EXTERNALLY_VERIFIABLE_ONLY',
      maxProvisionalWorkerLaunches: 1,
      localDoneAllowed: false,
    })
  }
  return contracts
}

function requiredKindsForFacts(facts = {}) {
  const declared = Array.isArray(facts.capturedIncidentDomains)
    ? facts.capturedIncidentDomains.filter(kind => KINDS.includes(kind)) : []
  if (facts.checkAndBaseline && facts.checkAndBaseline.hiddenExternalCheck === true) {
    declared.push('HIDDEN_EXTERNAL_ORACLE')
  }
  return [...new Set(declared)].sort()
}

function validateContracts(input, facts = {}) {
  const contracts = normalizeContracts(input, facts)
  const errors = []
  const kinds = new Set()
  for (const contract of contracts) {
    const validation = validateContract(contract)
    errors.push(...validation.errors.map(error => `${contract && contract.kind || 'UNKNOWN'}: ${error}`))
    if (contract && kinds.has(contract.kind)) errors.push(`duplicate captured-domain kind ${contract.kind}`)
    if (contract) kinds.add(contract.kind)
  }
  if (facts.checkAndBaseline && facts.checkAndBaseline.hiddenExternalCheck === true &&
      !kinds.has('HIDDEN_EXTERNAL_ORACLE')) {
    errors.push('hiddenExternalCheck requires HIDDEN_EXTERNAL_ORACLE')
  }
  for (const kind of requiredKindsForFacts(facts)) {
    if (!kinds.has(kind)) errors.push(`applicable captured incident domain ${kind} requires a pre-work contract`)
  }
  return { valid: errors.length === 0, errors, contracts }
}

function findOutcome(outcomes, kind) {
  return Array.isArray(outcomes) ? outcomes.find(outcome => outcome && outcome.kind === kind) : null
}

function evaluateOutcome(contract, outcome) {
  const validation = validateContract(contract)
  if (!validation.valid) return { valid: false, status: 'CAPTURED_DOMAIN_CONTRACT_INVALID', errors: validation.errors }
  const errors = []
  if (!isObject(outcome) || outcome.schemaVersion !== SCHEMA_VERSION || outcome.kind !== contract.kind) {
    return { valid: false, status: 'CAPTURED_DOMAIN_OUTCOME_MISSING', errors: [`missing outcome for ${contract.kind}`] }
  }
  switch (contract.kind) {
    case 'MISSION_SOURCE_CONFLICT':
      if (outcome.certificateHash !== contract.certificateHash || outcome.sourceDataHash !== contract.sourceDataHash) {
        errors.push('outcome must bind the immutable retry certificate and current source data')
      }
      {
        const authorityHash = contract.retryAuthority.immutableRetryBindingHash ||
          contract.retryAuthority.sourceTransitionCertificateHash ||
          contract.retryAuthority.userAuthorityCertificateHash
        if (outcome.retryAuthorityMode !== contract.retryAuthority.mode ||
            outcome.retryAuthorityHash !== authorityHash) {
          errors.push('outcome must bind the admitted retry-authority certificate')
        }
      }
      if (outcome.recordedBeforeRetryWork !== true) errors.push('conflict certificate must precede retry work')
      break
    case 'SIGNATURE_SEARCH':
      if (outcome.strongestInvariantInventoryHash !== contract.strongestInvariantInventoryHash) {
        errors.push('outcome must bind the strongest-invariant inventory')
      }
      if (outcome.broadEnumerationStartedAfterInventory !== true) {
        errors.push('broad enumeration must start after the invariant inventory')
      }
      if (contract.secondCandidateFamily === true &&
          outcome.identifiabilityProofHash !== contract.identifiabilityProofHash) {
        errors.push('second-family search must bind the declared identifiability proof')
      }
      break
    case 'FIXTURE_PROVENANCE':
      if (outcome.fixtureProvenanceHash !== contract.fixtureProvenanceHash ||
          outcome.mutationReplayHash !== contract.mutationReplayHash) {
        errors.push('outcome must bind authoritative fixture provenance and mutation replay')
      }
      if (outcome.initialStatus !== 'RED' || outcome.executablePrebuildValidationStatus !== 'PASS' ||
          outcome.executablePrebuildValidationHash !== contract.executablePrebuildValidationHash) {
        errors.push('fixture provenance and mutation replay must stay RED until executable pre-build validation passes')
      }
      break
    case 'HIDDEN_EXTERNAL_ORACLE':
      if (outcome.verificationRoute !== 'EXTERNALLY_VERIFIABLE_ONLY' ||
          outcome.externalBoundaryRecorded !== true || outcome.localDoneRequested === true) {
        errors.push('hidden evidence must remain externally verifiable only and cannot request local DONE')
      }
      break
    case 'IMAGE_DATUM':
      if (outcome.certificateHash !== contract.certificateHash || outcome.rulingHash !== contract.rulingHash ||
          outcome.selectedInterpretationId !== contract.selectedInterpretation.id) {
        errors.push('outcome must bind the stable image-derived datum ruling')
      }
      if (outcome.certificateRecordedBeforeGeometryWrites !== true) {
        errors.push('datum certificate must be recorded before geometry writes')
      }
      break
    case 'DONE_RETRY_PROMOTION': {
      if (outcome.priorDoneCandidateHash !== contract.priorDoneCandidateHash ||
          outcome.isolationCertificateHash !== contract.isolationCertificateHash ||
          !hash(outcome.retryCandidateHash) || !hash(outcome.isolatedWorktreeHash) ||
          outcome.retryCandidateHash === contract.priorDoneCandidateHash ||
          outcome.isolationVerified !== true) {
        errors.push('retry outcome must bind and verify its isolated candidate/worktree')
      }
      const results = Array.isArray(outcome.acceptanceResults) ? outcome.acceptanceResults : []
      const actualIds = results.map(item => item && item.id).sort()
      const requiredIds = contract.requiredAcceptanceIds.slice().sort()
      if (!same(actualIds, requiredIds) || results.some(item => item.status !== 'PASS' || !hash(item.evidenceHash))) {
        errors.push('every required acceptance item must join with PASS evidence')
      }
      if (!hash(outcome.acceptanceJoinHash) || outcome.promotionCandidateHash !== outcome.retryCandidateHash) {
        errors.push('retry candidate may be authorized for promotion only by its complete acceptance join')
      }
      break
    }
  }
  return {
    valid: errors.length === 0,
    status: errors.length === 0 ? 'CAPTURED_DOMAIN_ACCEPTED' : 'CAPTURED_DOMAIN_OUTCOME_INVALID',
    // A hidden evaluator cannot be invoked from the task container. Recording
    // that boundary must strengthen the local checks, not turn an otherwise
    // completed task into PARTIAL forever. A valid boundary outcome means the
    // controller did not claim to have run the hidden oracle; the independently
    // checked local candidate may still be returned as DONE for the outer
    // harness to evaluate.
    localDoneAllowed: errors.length === 0,
    errors,
    outcomeHash: errors.length === 0
      ? crypto.createHash('sha256').update(JSON.stringify(outcome)).digest('hex')
      : null,
  }
}

function evaluateOutcomes(contracts, outcomes) {
  const duplicateKinds = Array.isArray(outcomes)
    ? [...new Set(outcomes.map(outcome => outcome && outcome.kind).filter((kind, index, all) =>
        kind && all.indexOf(kind) !== index))]
    : []
  const results = contracts.map(contract => evaluateOutcome(contract, findOutcome(outcomes, contract.kind)))
  const duplicateErrors = duplicateKinds.map(kind => `duplicate captured-domain outcome ${kind}`)
  return {
    valid: results.every(result => result.valid) && duplicateErrors.length === 0,
    localDoneAllowed: results.every(result => result.localDoneAllowed),
    results,
    errors: [...results.flatMap(result => result.errors), ...duplicateErrors],
  }
}

module.exports = {
  KINDS,
  SCHEMA_VERSION,
  evaluateOutcome,
  evaluateOutcomes,
  normalizeContracts,
  requiredKindsForFacts,
  validateContract,
  validateContracts,
}
