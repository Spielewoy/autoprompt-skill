'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { createPlatformProcessAdapter } = require('../../agents/codex/workflow/process-owner.js')
const { ensureWindowsPrivateAcl } = require('../../agents/codex/workflow/safe-run-root.js')

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  ensureWindowsPrivateAcl(directory)
  return fs.realpathSync.native(directory)
}

function nativeProcessAdapter(registryPath, ownershipRoot = path.dirname(registryPath)) {
  return createPlatformProcessAdapter({ windows: {
    controlRoot: path.join(path.dirname(registryPath), 'process-control'),
    providerPrivateOwnershipRoot: ownershipRoot,
    trustedOwnershipRoots: [ownershipRoot],
  } })
}

// AppContainer deliberately exposes its verified copy of Node through PATH.
// An absolute host executable would exercise the wrong resource boundary.
// Base64 also preserves Windows backslashes and arbitrary fixture filenames
// through both POSIX Bash and the restricted Git Bash command backend.
function nodeCommand(source) {
  const encoded = Buffer.from(source, 'utf8').toString('base64')
  return `node -e "eval(Buffer.from('${encoded}','base64').toString('utf8'))"`
}

function readCommand(file) {
  return nodeCommand(`process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(file)}))`)
}

function withChallenge(command, challenge) {
  return `${command} && ${nodeCommand(`process.stdout.write(${JSON.stringify(`\nCLOSED_CANARY_CHALLENGE:${challenge}\n`)})`)}`
}

function requiredNativeCli(provider) {
  const variable = `AUTOPROMPT_${provider.toUpperCase()}_TEST_CLI`
  const executable = process.env[variable]
  if (process.env.AUTOPROMPT_REQUIRE_NATIVE_TESTS === '1' && !executable) throw new Error(`${variable} is required; native certification cannot skip`)
  if (executable && (!path.isAbsolute(executable) || !fs.statSync(executable).isFile())) throw new Error(`${variable} must name an installed native executable`)
  return executable
}

function nativeEnvironment() {
  const environment = { PATH: process.env.PATH }
  if (process.platform === 'win32') {
    for (const wanted of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT']) {
      const key = Object.keys(process.env).find(name => name.toLowerCase() === wanted.toLowerCase())
      if (key) environment[wanted] = process.env[key]
    }
  }
  return environment
}

module.exports = { privateDirectory, nativeProcessAdapter, nodeCommand, readCommand, withChallenge, requiredNativeCli, nativeEnvironment }
