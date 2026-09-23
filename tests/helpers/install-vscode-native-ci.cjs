'use strict'

// Acquire the official VS Code archive used by native CI. The URLs and hashes
// are pinned to the 1.136.1 release metadata exposed by update.code.visualstudio.com.
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const cp = require('node:child_process')
const { Readable, Transform } = require('node:stream')
const { pipeline } = require('node:stream/promises')

const VERSION = '1.136.1'
const RELEASE_METADATA = 'https://update.code.visualstudio.com/1.136.1/{target}/stable'
const ARTIFACTS = Object.freeze({
  'win32-x64': {
    target: 'win32-x64-archive',
    url: 'https://vscode.download.prss.microsoft.com/dbazure/download/stable/a44adf7f53e00964ab890f9f8758a334f1fc15bc/VSCode-win32-x64-1.136.1.zip',
    sha256: 'deca16ea5c4d71ece23e50af57632bba3abd0e3577c3c8bfbcdd90b03f11e402'
  },
  'win32-arm64': {
    target: 'win32-arm64-archive',
    url: 'https://vscode.download.prss.microsoft.com/dbazure/download/stable/a44adf7f53e00964ab890f9f8758a334f1fc15bc/VSCode-win32-arm64-1.136.1.zip',
    sha256: 'e46a3ba3725416a499c8fbc985fa71d1e3172a954305c31f7192c37bb5ef20fd'
  },
  'darwin-x64': {
    target: 'darwin',
    url: 'https://vscode.download.prss.microsoft.com/dbazure/download/stable/a44adf7f53e00964ab890f9f8758a334f1fc15bc/VSCode-darwin.zip',
    sha256: '27b8b857b932454b91ccabde9d09642b15ce2fefa9e5e3c2f75e530eceb3cb9c'
  },
  'darwin-arm64': {
    target: 'darwin-arm64',
    url: 'https://vscode.download.prss.microsoft.com/dbazure/download/stable/a44adf7f53e00964ab890f9f8758a334f1fc15bc/VSCode-darwin-arm64.zip',
    sha256: 'bd15a1b26cd10ba84900f7bd30f21d51eef268828e1e15a8ac1f97f99620bbe5'
  }
})

function targetFor(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`
  assert.ok(ARTIFACTS[key], `VS Code ${VERSION} archive is not pinned for ${key}`)
  return { key, ...ARTIFACTS[key] }
}

function privateRoot() {
  const runnerTemp = process.env.RUNNER_TEMP
  assert.ok(runnerTemp && path.isAbsolute(runnerTemp), 'RUNNER_TEMP must be an absolute private CI directory')
  const root = fs.mkdtempSync(path.join(runnerTemp, `autoprompt-vscode-${VERSION}-`), { encoding: 'utf8' })
  fs.chmodSync(root, 0o700)
  assert.equal(fs.realpathSync.native(runnerTemp), path.resolve(runnerTemp), 'RUNNER_TEMP must not be a symlinked directory')
  return root
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(240000) })
  assert.equal(response.status, 200, `VS Code archive download failed: HTTP ${response.status}`)
  assert.ok(response.body, 'VS Code archive response has no body')
  const maxBytes = 700 * 1024 * 1024
  if (response.headers.has('content-length')) assert.ok(Number(response.headers.get('content-length')) <= maxBytes, 'VS Code archive exceeds bounded download size')
  const hash = crypto.createHash('sha256')
  const output = fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 })
  let bytes = 0
  const digest = new Transform({ transform(chunk, encoding, callback) {
    bytes += chunk.length
    if (bytes > maxBytes) return callback(new Error('VS Code archive exceeds bounded download size'))
    hash.update(chunk)
    callback(null, chunk)
  } })
  await pipeline(Readable.fromWeb(response.body), digest, output)
  return hash.digest('hex')
}

function extract(archive, destination) {
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 })
  if (process.platform === 'win32') {
    cp.execFileSync('tar', ['-xf', archive, '-C', destination], { stdio: 'inherit', windowsHide: true })
  } else {
    cp.execFileSync('ditto', ['-x', '-k', archive, destination], { stdio: 'inherit' })
  }
}

function findExecutable(root) {
  if (process.platform === 'win32') {
    const executable = path.join(root, 'Code.exe')
    assert.ok(fs.statSync(executable).isFile(), `VS Code executable missing: ${executable}`)
    return { executable, bundleRoot: root }
  }
  const app = path.join(root, 'Visual Studio Code.app')
  const executable = path.join(app, 'Contents', 'MacOS', 'Electron')
  assert.ok(fs.statSync(executable).isFile(), `VS Code Electron missing: ${executable}`)
  return { executable, bundleRoot: app }
}

function bundleIdentity(bundleRoot) {
  const hash = crypto.createHash('sha256')
  let fileCount = 0
  const visited = new Set(), active = new Set()
  const walk = dir => {
    const canonical = fs.realpathSync.native(dir)
    const relativeDir = path.relative(bundleRoot, canonical)
    assert.ok(!relativeDir || (relativeDir !== '..' && !relativeDir.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeDir)), 'VS Code bundle link escapes its application root')
    if (active.has(canonical)) throw new Error('VS Code bundle contains a directory-link cycle')
    if (visited.has(canonical)) return
    active.add(canonical)
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(file)
      else if (entry.isFile()) {
        hash.update(path.relative(bundleRoot, file).replaceAll(path.sep, '/') + '\0')
        hash.update(fs.readFileSync(file))
        fileCount++
      } else if (entry.isSymbolicLink()) {
        const real = fs.realpathSync.native(file)
        const relative = path.relative(bundleRoot, real)
        assert.ok(!relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)), 'VS Code bundle link escapes its application root')
        hash.update(`link\0${path.relative(bundleRoot, file).replaceAll(path.sep, '/')}\0${path.relative(bundleRoot, real).replaceAll(path.sep, '/')}\0`)
        if (fs.statSync(real).isDirectory()) walk(real)
        else if (fs.statSync(real).isFile()) {
          hash.update(path.relative(bundleRoot, file).replaceAll(path.sep, '/') + '\0')
          hash.update(fs.readFileSync(real))
          fileCount++
        } else assert.fail(`VS Code bundle contains an unsupported link: ${file}`)
      }
    }
    active.delete(canonical)
    visited.add(canonical)
  }
  walk(bundleRoot)
  return { sha256: hash.digest('hex'), fileCount }
}

async function install({ platform = process.platform, arch = process.arch } = {}) {
  assert.equal(platform, process.platform, 'Acquisition must run on the target OS')
  assert.equal(arch, process.arch, 'Acquisition must run on the target architecture')
  if (process.env.AUTOPROMPT_CI_EXPECTED_ARCH) assert.equal(process.arch, process.env.AUTOPROMPT_CI_EXPECTED_ARCH)
  const artifact = targetFor(platform, arch)
  const root = privateRoot()
  const archive = path.join(root, path.basename(new URL(artifact.url).pathname))
  const extraction = path.join(root, 'extracted')
  if (!fs.existsSync(archive)) {
    const actual = await download(artifact.url, archive)
    assert.equal(actual, artifact.sha256, `VS Code archive SHA-256 mismatch for ${artifact.key}`)
  } else {
    const actual = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex')
    assert.equal(actual, artifact.sha256, `Cached VS Code archive SHA-256 mismatch for ${artifact.key}`)
  }
  extract(archive, extraction)
  const binding = findExecutable(extraction)
  const result = Object.freeze({ version: VERSION, ...artifact, metadataUrl: RELEASE_METADATA.replace('{target}', artifact.target), root, archive, ...binding, bundleIdentity: bundleIdentity(binding.bundleRoot) })
  if (process.env.GITHUB_ENV) fs.appendFileSync(process.env.GITHUB_ENV, `AUTOPROMPT_VSCODE_TEST_CLI<<AUTOPROMPT_VSCODE_EOF\n${result.executable}\nAUTOPROMPT_VSCODE_EOF\n`)
  return result
}

if (require.main === module) install().then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1 })

module.exports = { VERSION, ARTIFACTS, targetFor, install, bundleIdentity }
