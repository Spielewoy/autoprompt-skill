'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { pinnedCodexCli } = require('./pinned-codex-cli.cjs')
const { resolveCodexExecutable } = require('../../agents/codex/workflow/codex-executable.js')

// Copy actual installed native bytes into a production-supported global npm
// layout. No downloads, authenticated home, or ambient Codex fallback is used.
function pinnedCodexPackageFixture(directory, options = {}) {
  const environment = options.env || process.env
  const cli = pinnedCodexCli({ env: { ...environment, AUTOPROMPT_REQUIRE_PINNED_CODEX: '1' } })
  assert.equal(path.basename(cli.cliPath), 'codex.js', 'package tests require the pinned npm codex.js entrypoint')
  const sourceRoot = path.dirname(path.dirname(cli.cliPath))
  const metadata = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8'))
  assert.equal(metadata.name, '@openai/codex')
  assert.equal(metadata.version, '0.148.0')
  const nativeName = `@openai/codex-${process.platform}-${process.arch}`
  assert.equal(metadata.optionalDependencies[nativeName], `npm:@openai/codex@0.148.0-${process.platform}-${process.arch}`)
  const nativeSourceRoot = path.dirname(require.resolve(`${nativeName}/package.json`, { paths: [sourceRoot] }))
  const nativeMetadata = JSON.parse(fs.readFileSync(path.join(nativeSourceRoot, 'package.json'), 'utf8'))
  assert.equal(nativeMetadata.name, '@openai/codex')
  assert.equal(nativeMetadata.version, `0.148.0-${process.platform}-${process.arch}`)
  const bin = process.platform === 'win32' ? directory : path.join(directory, 'bin')
  const packageRoot = path.join(directory, ...(process.platform === 'win32' ? [] : ['lib']), 'node_modules', '@openai', 'codex')
  fs.mkdirSync(bin, { recursive: true })
  fs.cpSync(sourceRoot, packageRoot, { recursive: true, filter: source => source !== path.join(sourceRoot, 'node_modules') })
  const nativeRoot = path.join(packageRoot, 'node_modules', ...nativeName.split('/'))
  fs.cpSync(nativeSourceRoot, nativeRoot, { recursive: true })
  const copiedEntry = path.join(packageRoot, 'bin', 'codex.js')
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(bin, 'codex.cmd'), `@echo off\r\n"${process.execPath}" "${copiedEntry}" %*\r\n`)
  } else {
    fs.symlinkSync(copiedEntry, path.join(bin, 'codex'))
    fs.symlinkSync(process.execPath, path.join(bin, 'node'))
  }
  const cleanEnvironment = { ...environment }
  for (const key of Object.keys(cleanEnvironment)) if (/^path$/i.test(key)) delete cleanEnvironment[key]
  const directories = String(environment.PATH || environment.Path || '').split(path.delimiter).filter(Boolean)
  const ambientWithoutCodex = directories.filter(candidate => !['codex', 'codex.exe', 'codex.cmd', 'codex.ps1']
    .some(name => fs.existsSync(path.join(candidate, name))))
  // A host can install Codex beside /usr/bin/bash (or node.exe). Keep the
  // installer's declared tools reachable without retaining that directory as a
  // second Codex lookup location. These links never advertise a fake version.
  if (process.platform !== 'win32') {
    const installerTools = [
      'bash', 'sh', 'git', 'python', 'python3', 'basename', 'dirname', 'cat', 'cp',
      'mv', 'rm', 'mkdir', 'rmdir', 'chmod', 'find', 'grep', 'sed', 'awk', 'sort',
      'head', 'tail', 'wc', 'cut', 'tr', 'date', 'uname', 'readlink', 'realpath',
      'mktemp', 'stat', 'ln', 'touch', 'tee', 'which', 'expr', 'printf', 'timeout',
      'xargs', 'sha256sum', 'shasum', 'tar', 'gzip', 'id', 'env', 'flock', 'sleep',
      'diff', 'cmp',
    ]
    for (const name of installerTools) {
      const sourceDirectory = directories.find(candidate => {
        try { fs.accessSync(path.join(candidate, name), fs.constants.X_OK); return fs.statSync(path.join(candidate, name)).isFile() } catch { return false }
      })
      if (sourceDirectory && !ambientWithoutCodex.includes(sourceDirectory)) {
        fs.symlinkSync(path.join(sourceDirectory, name), path.join(bin, name))
      }
    }
  } else if (!ambientWithoutCodex.includes(path.dirname(process.execPath))) {
    fs.copyFileSync(process.execPath, path.join(bin, 'node.exe'))
  }
  assert.throws(() => resolveCodexExecutable('codex', { environment: { PATH: ambientWithoutCodex.join(path.delimiter) } }),
    /cannot be resolved safely/, 'the fixture must not retain an ambient native Codex fallback')
  cleanEnvironment.PATH = [bin, ...ambientWithoutCodex].join(path.delimiter)
  const runtime = resolveCodexExecutable('codex', { environment: cleanEnvironment })
  assert.equal(runtime.identity.version, 'codex-cli 0.148.0')
  assert.equal(runtime.packageRoot, fs.realpathSync.native(packageRoot))
  // Every supported lookup route must select the copied fixture, including
  // evidence runners that use this explicit root instead of PATH symlinks.
  cleanEnvironment.CODEX_MANAGED_PACKAGE_ROOT = runtime.packageRoot
  const originalExecutable = path.join(nativeSourceRoot, path.relative(nativeRoot, runtime.executable))
  const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  assert.equal(runtime.identity.sha256, digest(originalExecutable), 'fixture must preserve the actual pinned native bytes')
  return { env: cleanEnvironment, runtime, bin, packageRoot, cliPath: copiedEntry }
}

module.exports = { pinnedCodexPackageFixture }
