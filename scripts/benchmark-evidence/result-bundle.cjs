'use strict'

const { canonicalStringify, exactKeys, fail, hashPattern, nonEmpty } = require('./core.cjs')

const RESULT_BUNDLE_KEYS = Object.freeze([
  'schemaVersion', 'manifestDigest', 'taskId', 'attemptId', 'verdict', 'reward', 'grader', 'producer',
  'rawHarborSha256', 'verifierSha256', 'resourceEvidenceSha256', 'authorityAttestationSha256', 'authoritySignatureSha256',
])

function validateResultBundle(bundle, expected = {}) {
  exactKeys(bundle, RESULT_BUNDLE_KEYS, 'RESULT_BUNDLE_INVALID', 'canonical result bundle')
  if (RESULT_BUNDLE_KEYS.some(field => !Object.hasOwn(bundle, field))) fail('RESULT_BUNDLE_INVALID', 'canonical result bundle has missing fields')
  if (bundle.schemaVersion !== 'benchmark-result-bundle.v2') fail('RESULT_BUNDLE_INVALID', 'unsupported canonical result bundle schema')
  for (const field of ['manifestDigest', 'rawHarborSha256', 'verifierSha256', 'resourceEvidenceSha256', 'authorityAttestationSha256', 'authoritySignatureSha256']) if (!hashPattern(bundle[field])) fail('RESULT_BUNDLE_INVALID', `${field} must be sha256`)
  for (const field of ['taskId', 'attemptId']) nonEmpty(bundle[field], 'RESULT_BUNDLE_INVALID', field)
  if (!['pass', 'fail'].includes(bundle.verdict) || typeof bundle.reward !== 'number' || !Number.isFinite(bundle.reward)) fail('RESULT_BUNDLE_INVALID', 'result verdict or reward is invalid')
  exactKeys(bundle.grader, ['verdict', 'score'], 'RESULT_BUNDLE_INVALID', 'result grader')
  if (bundle.grader.verdict !== bundle.verdict || typeof bundle.grader.score !== 'number' || !Number.isFinite(bundle.grader.score)) fail('RESULT_BUNDLE_INVALID', 'result grader does not match the verdict')
  exactKeys(bundle.producer, ['name', 'version', 'buildDigest'], 'RESULT_BUNDLE_INVALID', 'result producer')
  nonEmpty(bundle.producer.name, 'RESULT_BUNDLE_INVALID', 'producer.name')
  nonEmpty(bundle.producer.version, 'RESULT_BUNDLE_INVALID', 'producer.version')
  if (!hashPattern(bundle.producer.buildDigest)) fail('RESULT_BUNDLE_INVALID', 'producer.buildDigest must be sha256')
  for (const [field, value] of Object.entries(expected)) {
    if (value === undefined) continue
    if (canonicalStringify(bundle[field]) !== canonicalStringify(value)) fail('RESULT_BUNDLE_MISMATCH', `canonical result ${field} differs from signed or raw evidence`)
  }
  return bundle
}

module.exports = { RESULT_BUNDLE_KEYS, validateResultBundle }
