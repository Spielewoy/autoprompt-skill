#!/usr/bin/env node
'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const { stableJsonV1 } = require('../codex-runtime-identity.cjs')

const EVIDENCE_SCHEMA = 'codex-live-conformance-evidence.v1'
const OBSERVATION_SCHEMA = 'codex-live-conformance-observation.v1'
const PUBLIC_PROJECTION_POLICY = 'codex-public-fail-evidence.v1'
const HISTORICAL_FAIL_SOURCE_SHA256 = '2e24eda37043240b3cf3a008e6a3c628d87653741b21e38d4947d54955e01c59'
const HASH_PATTERN = /^[a-f0-9]{64}$/

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function projectPublicFailEvidence(rawBytes) {
  if (!Buffer.isBuffer(rawBytes)) throw new TypeError('raw evidence bytes must be a Buffer')
  let raw
  try { raw = JSON.parse(rawBytes.toString('utf8')) } catch {
    throw new Error('raw Codex conformance evidence is invalid JSON')
  }
  const observation = raw?.evidence
  const admission = observation?.providerAdmission
  const historicalFailExact = raw?.schemaVersion === EVIDENCE_SCHEMA &&
    raw?.fixtureOnly === false && raw?.result === 'FAIL' &&
    HASH_PATTERN.test(raw?.runtimeIdentityHash || '') &&
    observation?.schemaVersion === OBSERVATION_SCHEMA &&
    observation?.providerId === 'codex' && observation?.result === 'FAIL' &&
    observation?.canarySchema === 'codex-live-canary.v1' &&
    observation?.canaryResult === 'FAIL' &&
    Array.isArray(admission?.verifiedCapabilities) &&
    admission.verifiedCapabilities.length === 0 &&
    admission?.verifiedCapabilitiesExact === false
  if (!historicalFailExact) {
    throw new Error('only exact unsigned live FAIL evidence can be projected for publication')
  }

  const envelope = {
    evidence: {
      canaryResult: 'FAIL',
      canarySchema: 'codex-live-canary.v1',
      providerAdmission: {
        verifiedCapabilities: [],
        verifiedCapabilitiesExact: false,
      },
      providerId: 'codex',
      result: 'FAIL',
      schemaVersion: OBSERVATION_SCHEMA,
    },
    fixtureOnly: false,
    publicProjection: {
      policy: PUBLIC_PROJECTION_POLICY,
      sourceEvidenceSha256: sha256(rawBytes),
    },
    result: 'FAIL',
    runtimeIdentityHash: raw.runtimeIdentityHash,
    schemaVersion: EVIDENCE_SCHEMA,
  }
  const canonicalJson = stableJsonV1(envelope)
  return Object.freeze({
    envelope: Object.freeze(envelope),
    canonicalJson,
    publicEvidenceSha256: sha256(Buffer.from(canonicalJson, 'utf8')),
    sourceEvidenceSha256: envelope.publicProjection.sourceEvidenceSha256,
  })
}

function assertCurrentPublicFailEvidence(publicBytes) {
  if (!Buffer.isBuffer(publicBytes)) throw new TypeError('public evidence bytes must be a Buffer')
  let envelope
  try { envelope = JSON.parse(publicBytes.toString('utf8')) } catch {
    throw new Error('public Codex conformance evidence is invalid JSON')
  }
  const expected = {
    evidence: {
      canaryResult: 'FAIL',
      canarySchema: 'codex-live-canary.v1',
      providerAdmission: {
        verifiedCapabilities: [],
        verifiedCapabilitiesExact: false,
      },
      providerId: 'codex',
      result: 'FAIL',
      schemaVersion: OBSERVATION_SCHEMA,
    },
    fixtureOnly: false,
    publicProjection: {
      policy: PUBLIC_PROJECTION_POLICY,
      sourceEvidenceSha256: HISTORICAL_FAIL_SOURCE_SHA256,
    },
    result: 'FAIL',
    runtimeIdentityHash: envelope?.runtimeIdentityHash,
    schemaVersion: EVIDENCE_SCHEMA,
  }
  if (!HASH_PATTERN.test(envelope?.runtimeIdentityHash || '') ||
      publicBytes.toString('utf8') !== stableJsonV1(expected)) {
    throw new Error('public Codex conformance evidence is not the exact privacy-safe FAIL projection')
  }
  return Object.freeze(envelope)
}

function parseArguments(argv) {
  if (argv.length !== 4 || argv[0] !== '--input' || argv[2] !== '--output' ||
      !argv[1] || !argv[3]) {
    throw new Error('usage: --input <private-raw-evidence.json> --output <public-evidence.json>')
  }
  return Object.freeze({ input: path.resolve(argv[1]), output: path.resolve(argv[3]) })
}

function writePublicFailEvidence(input, output) {
  const projected = projectPublicFailEvidence(fs.readFileSync(input))
  fs.mkdirSync(path.dirname(output), { recursive: true })
  const temporary = `${output}.tmp-${process.pid}`
  fs.writeFileSync(temporary, projected.canonicalJson, { flag: 'wx' })
  try { fs.renameSync(temporary, output) } catch (error) {
    try { fs.rmSync(temporary, { force: true }) } catch {}
    throw error
  }
  return projected
}

function main(argv = process.argv.slice(2), io = process) {
  try {
    const parsed = parseArguments(argv)
    const result = writePublicFailEvidence(parsed.input, parsed.output)
    io.stdout.write(`${stableJsonV1({
      publicEvidenceSha256: result.publicEvidenceSha256,
      sourceEvidenceSha256: result.sourceEvidenceSha256,
    })}\n`)
    return 0
  } catch (error) {
    io.stderr.write(`codex-public-conformance: ${error.message}\n`)
    return 1
  }
}

if (require.main === module) process.exitCode = main()

module.exports = {
  EVIDENCE_SCHEMA,
  HISTORICAL_FAIL_SOURCE_SHA256,
  OBSERVATION_SCHEMA,
  PUBLIC_PROJECTION_POLICY,
  assertCurrentPublicFailEvidence,
  main,
  parseArguments,
  projectPublicFailEvidence,
  writePublicFailEvidence,
}
