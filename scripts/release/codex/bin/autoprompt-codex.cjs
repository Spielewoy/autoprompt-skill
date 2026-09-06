#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const runtime = require('../scripts/runtime-payload.cjs')

function fail(message, code = 2) {
  process.stderr.write(`autoprompt-codex: ${message}\n`)
  process.exitCode = code
}

function parse(argv) {
  const action = argv[0]
  if (!['install', 'verify', 'uninstall', 'plan'].includes(action) ||
      argv[1] !== '--root' || argv.length !== 3) {
    throw new Error('usage: autoprompt-codex <install|verify|uninstall|plan> --root <absolute-path>')
  }
  if (!path.isAbsolute(argv[2])) throw new Error('root must be absolute')
  const root = path.resolve(argv[2])
  if (root === path.parse(root).root) throw new Error('filesystem root is not a valid activation root')
  return { action, root }
}

function run(argv = process.argv.slice(2)) {
  const options = parse(argv)
  if (options.action !== 'install' &&
      (!fs.existsSync(options.root) || !fs.lstatSync(options.root).isDirectory())) {
    throw new Error(`activation root is missing: ${options.root}`)
  }
  const destination = path.join(options.root, 'skills', 'autoprompt')
  if (options.action === 'install') {
    fs.mkdirSync(options.root, { recursive: true })
    const installed = runtime.installPayload('codex', destination)
    return { action: 'install', files: installed.length, root: options.root }
  }
  if (options.action === 'verify') {
    return { action: 'verify', root: options.root, ...runtime.verifyPayload('codex', destination) }
  }
  if (options.action === 'uninstall') {
    return { action: 'uninstall', root: options.root, ...runtime.uninstallPayload('codex', destination) }
  }
  const plan = runtime.installationPlan('codex', destination)
  return {
    action: 'plan', root: options.root, files: plan.files.length,
    payloadDigest: plan.payloadDigest, payloadGeneration: plan.payloadGeneration,
  }
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(run())}\n`)
  } catch (error) {
    fail(error.message)
  }
}

module.exports = { parse, run }
