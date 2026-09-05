'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { pinnedCodexCli } = require('./pinned-codex-cli.cjs')
const { resolveCodexExecutable } = require('../../agents/codex/workflow/codex-executable.js')

// The global npm layout is the production-supported package discovery layout.
// Resolve it before exporting anything: a version-printing wrapper alone is not
// sufficient proof that the native optional dependency was installed.
const prefix = path.resolve(process.argv[2] || '')
if (!process.argv[2] || !process.env.GITHUB_PATH || !process.env.GITHUB_ENV) {
  throw new Error('expected an npm prefix and GitHub Actions environment files')
}
const bin = process.platform === 'win32' ? prefix : path.join(prefix, 'bin')
const packageRoot = process.platform === 'win32'
  ? path.join(prefix, 'node_modules', '@openai', 'codex')
  : path.join(prefix, 'lib', 'node_modules', '@openai', 'codex')
const cliPath = path.join(packageRoot, 'bin', 'codex.js')
const native = resolveCodexExecutable('codex', { environment: { PATH: bin } })
if (native.identity.version !== 'codex-cli 0.148.0') throw new Error('unexpected native Codex version')
pinnedCodexCli({ env: { ...process.env, AUTOPROMPT_PINNED_CODEX: cliPath } })
fs.appendFileSync(process.env.GITHUB_PATH, `${bin}\n`)
// The evidence sandbox deliberately rejects arbitrary PATH symlinks. Export
// its supported explicit package root too, using the same verified native pin.
fs.appendFileSync(process.env.GITHUB_ENV, `AUTOPROMPT_PINNED_CODEX=${cliPath}\nAUTOPROMPT_REQUIRE_PINNED_CODEX=1\nCODEX_MANAGED_PACKAGE_ROOT=${packageRoot}\n`)
console.log(`Pinned Codex 0.148.0 native package verified for ${process.platform}/${process.arch}`)
