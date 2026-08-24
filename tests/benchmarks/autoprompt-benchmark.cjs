#!/usr/bin/env node
'use strict'

const path = require('node:path')
const evidence = require('../../scripts/benchmark-evidence')

function parseArguments(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!['--config', '--baseline-sha', '--candidate-sha', '--output', '--generated-at'].includes(name) || value === undefined) throw new Error('usage: node autoprompt-benchmark.cjs --config FILE --baseline-sha SHA --candidate-sha SHA --output FILE [--generated-at ISO]')
    values[name.slice(2)] = value
  }
  for (const required of ['config', 'baseline-sha', 'candidate-sha', 'output']) if (!values[required]) throw new Error(`missing --${required}`)
  return values
}

function main(argv) {
  const args = parseArguments(argv)
  const repoRoot = path.resolve(__dirname, '..', '..')
  const definition = evidence.loadDefinition(path.resolve(args.config))
  const record = evidence.runMechanismCanary({
    repoRoot,
    definition,
    baselineSha: args['baseline-sha'],
    candidateSha: args['candidate-sha'],
    outputPath: path.resolve(args.output),
    generatedAt: args['generated-at'],
  })
  process.stdout.write(`${evidence.canonicalStringify({ output: path.resolve(args.output), checksum: record.checksum, mechanismVerified: record.mechanismVerified, qualityClaimEligible: record.qualityClaimEligible })}\n`)
}

if (require.main === module) {
  try { main(process.argv.slice(2)) } catch (error) {
    process.stderr.write(`${error.code || 'MECHANISM_CANARY_FAILED'}: ${error.message}\n`)
    process.exitCode = 1
  }
}

module.exports = { main, parseArguments }
