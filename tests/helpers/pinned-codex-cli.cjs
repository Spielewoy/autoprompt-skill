'use strict'

const childProcess = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const VERSION = '0.148.0'

// These probes use the real CLI against a local fake provider. Discover only
// an installed CLI; never depend on benchmark archives or download at test time.
function pinnedCodexCli(options = {}) {
  const env = options.env || process.env
  const root = options.root || path.resolve(__dirname, '..', '..')
  const candidates = []
  if (env.AUTOPROMPT_PINNED_CODEX) {
    candidates.push(path.resolve(env.AUTOPROMPT_PINNED_CODEX))
  } else {
    try {
      candidates.push(require.resolve('@openai/codex/bin/codex.js', { paths: [root] }))
    } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND' && error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error
    }
    for (const directory of (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) {
      candidates.push(path.join(directory, 'codex'))
      if (process.platform === 'win32') {
        candidates.push(path.join(directory, 'codex.exe'))
        candidates.push(path.join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'))
      }
    }
  }
  for (const candidate of [...new Set(candidates)]) {
    let cliPath
    try {
      cliPath = fs.realpathSync(candidate)
      if (!fs.statSync(cliPath).isFile()) continue
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) continue
      throw error
    }
    const javascript = /\.[cm]?js$/u.test(cliPath)
    const command = javascript ? process.execPath : cliPath
    const args = javascript ? [cliPath] : []
    const result = childProcess.spawnSync(command, [...args, '--version'], {
      env, encoding: 'utf8', timeout: 10_000,
    })
    if (result.status === 0 && result.stdout.trim() === `codex-cli ${VERSION}`) {
      return { command, args, cliPath }
    }
  }
  if (env.AUTOPROMPT_PINNED_CODEX || env.AUTOPROMPT_REQUIRE_PINNED_CODEX === '1') {
    throw new Error(`Codex ${VERSION} is required for native transport probes; install @openai/codex@${VERSION} or set AUTOPROMPT_PINNED_CODEX to its executable`)
  }
  return null
}

module.exports = { pinnedCodexCli }
