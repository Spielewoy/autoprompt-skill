#!/usr/bin/env node
'use strict'

const { RootGuard } = require('./operation-lock.cjs')

function inspectRoot(root) {
  const guard = new RootGuard(root)
  return Object.freeze({
    schemaVersion: 1,
    realPath: guard.rootReal,
    statIdentity: guard.rootIdentity,
  })
}

function run(argv, io = process) {
  if (argv.length !== 1) {
    io.stderr.write('root-identity: usage: <absolute-root>\n')
    return 2
  }
  try {
    io.stdout.write(`${JSON.stringify(inspectRoot(argv[0]))}\n`)
    return 0
  } catch (error) {
    io.stderr.write(`root-identity: ${error.message}\n`)
    return 1
  }
}

if (require.main === module) process.exitCode = run(process.argv.slice(2))

module.exports = { inspectRoot, run }
