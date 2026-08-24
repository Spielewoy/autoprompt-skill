#!/usr/bin/env node
'use strict'

const path = require('node:path')
const {
  captureExecution,
  sealBundle,
  verifyBundle,
} = require('./codex-evidence/verification-bundle.cjs')

function parse(argv) {
  const [command, ...rest] = argv
  const values = new Map()
  const flags = new Set()
  const commandSeparator = rest.indexOf('--')
  const controls = commandSeparator === -1 ? rest : rest.slice(0, commandSeparator)
  const commandArgv = commandSeparator === -1 ? [] : rest.slice(commandSeparator + 1)
  for (let index = 0; index < controls.length; index += 1) {
    const argument = controls[index]
    if (!argument.startsWith('--')) throw new Error(`Unexpected positional argument: ${argument}`)
    const equals = argument.indexOf('=')
    if (equals !== -1) {
      const name = argument.slice(2, equals)
      if (values.has(name)) throw new Error(`Duplicate --${name}`)
      values.set(name, argument.slice(equals + 1))
      continue
    }
    const name = argument.slice(2)
    const next = controls[index + 1]
    if (next && !next.startsWith('--')) {
      if (values.has(name)) throw new Error(`Duplicate --${name}`)
      values.set(name, next)
      index += 1
    } else flags.add(name)
  }
  return { command, commandArgv, flags, values }
}

function value(args, name, required = false) {
  const result = args.values.get(name)
  if (required && !result) throw new Error(`--${name} is required`)
  return result
}

function usage() {
  return [
    'Usage:',
    '  node scripts/codex-evidence-bundle.cjs capture --runner-id ID [--repo PATH] [--cwd REL] [--execution-root PATH] [--evidence-root REL] -- COMMAND [ARG...]',
    '  node scripts/codex-evidence-bundle.cjs seal --execution PATH --verdict FILE [--repo PATH] [--evidence-root REL]',
    '  node scripts/codex-evidence-bundle.cjs verify --bundle PATH [--repo PATH] [--integrity-only]',
  ].join('\n')
}

async function main() {
  const args = parse(process.argv.slice(2))
  const repo = path.resolve(value(args, 'repo') || process.cwd())
  if (args.command === 'capture') {
    const result = await captureExecution({
      repo,
      cwd: value(args, 'cwd') || '.',
      runnerId: value(args, 'runner-id', true),
      executionRoot: value(args, 'execution-root'),
      evidenceRoot: value(args, 'evidence-root'),
      commandArgv: args.commandArgv,
    })
    process.stdout.write(`${JSON.stringify({
      schema_version: result.execution.schema_version,
      execution_hash: result.execution.execution_hash,
      path: result.path,
      candidate_hash: result.execution.candidate_hash,
      command_hash: result.execution.command_hash,
      exit_code: result.execution.exit_code,
      candidate_unchanged: result.execution.candidate_unchanged,
      raw_output_sha256: result.execution.raw_output_sha256,
      stderr_sha256: result.execution.stderr_sha256,
    }, null, 2)}\n`)
    return
  }
  if (args.command === 'seal') {
    const result = sealBundle({
      repo,
      execution: value(args, 'execution', true),
      verdict: value(args, 'verdict', true),
      evidenceRoot: value(args, 'evidence-root'),
    })
    process.stdout.write(`${JSON.stringify({
      id: result.bundle.id,
      bundle_hash: result.bundle.bundle_hash,
      path: result.path,
      result: result.bundle.result,
      finding_ids: result.bundle.finding_ids,
    }, null, 2)}\n`)
    return
  }
  if (args.command === 'verify') {
    const bundle = verifyBundle({
      repo,
      bundle: value(args, 'bundle', true),
      integrityOnly: args.flags.has('integrity-only'),
    })
    process.stdout.write(`${JSON.stringify({
      id: bundle.id,
      bundle_hash: bundle.bundle_hash,
      result: bundle.result,
      independent: bundle.independent,
      finding_ids: bundle.finding_ids,
      candidate_hash: bundle.candidate_hash,
      integrity_only: args.flags.has('integrity-only'),
    }, null, 2)}\n`)
    return
  }
  throw new Error(usage())
}

main().catch(error => {
  process.stderr.write(`${error.code ? `${error.code}: ` : ''}${error.stack || error.message || String(error)}\n`)
  process.exitCode = 1
})
