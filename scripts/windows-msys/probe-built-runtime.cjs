'use strict'

// Compiler-output smoke proof only. This never selects an installed runtime or
// replaces the SDK DLL; full platform compatibility remains a separate gate.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const cp = require('node:child_process')
const assert = require('node:assert/strict')
const { bindBashRuntime, resolveWindowsBash } = require('../../agents/codex/workflow/windows-appcontainer-command.js')
const { ensureWindowsPrivateAcl } = require('../../agents/codex/workflow/safe-run-root.js')
const TEST_NAME = 'native Windows Bash copied closure permits scratch writes and denies candidate writes and controller reads'
const MAX_FILE = 32 * 1024 * 1024
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const samePath = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()

function physical(file, directory = false) {
  assert.equal(typeof file, 'string')
  assert.ok(path.isAbsolute(file) && !file.includes('\0'), 'An absolute physical path is required')
  const canonical = fs.realpathSync.native(file)
  assert.ok(samePath(canonical, file), `Aliased proof path refused: ${file}`)
  for (let current = canonical; ; current = path.dirname(current)) {
    const stat = fs.lstatSync(current)
    assert.equal(stat.isSymbolicLink(), false, `Linked proof path refused: ${current}`)
    if (directory || current !== canonical) assert.equal(stat.isDirectory(), true)
    if (current === path.parse(current).root) break
  }
  return canonical
}
function readBounded(file, limit = MAX_FILE) {
  const canonical = physical(file)
  const fd = fs.openSync(canonical, 'r')
  try {
    const before = fs.fstatSync(fd, { bigint: true })
    assert.ok(before.isFile() && before.nlink === 1n && before.size > 0n && before.size <= BigInt(limit), `Unbounded or linked proof file: ${file}`)
    const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd, { bigint: true })
    assert.equal(bytes.length, Number(before.size))
    for (const field of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']) assert.equal(after[field], before[field], `Proof input changed: ${file}`)
    return bytes
  } finally { fs.closeSync(fd) }
}
function stagedDigest(bytes) {
  const text = bytes.toString('utf8')
  assert.ok(Buffer.from(text, 'utf8').equals(bytes) && text.endsWith('\n') && !text.includes('\r'), 'Stage manifest must be complete UTF-8 with LF records')
  const entries = new Map()
  for (const line of text.slice(0, -1).split('\n')) {
    const match = /^([a-f0-9]{64})  (stage\/[A-Za-z0-9_+./-]+)$/.exec(line)
    assert.ok(match, 'Invalid stage checksum record')
    const name = match[2]
    assert.ok(!name.split('/').some(part => !part || part === '.' || part === '..'), 'Invalid stage checksum path')
    assert.equal(entries.has(name.toLowerCase()), false, 'Duplicate stage checksum record')
    entries.set(name.toLowerCase(), match[1])
  }
  assert.ok(entries.has('stage/usr/bin/msys-2.0.dll'), 'Staged DLL checksum is absent')
  return entries.get('stage/usr/bin/msys-2.0.dll')
}
function closureRecords(files) {
  assert.ok(files.length > 1 && files.length <= 96)
  const records = files.map(file => {
    assert.match(file.name, /^[a-z0-9_+.-]+\.(?:exe|dll)$/)
    assert.equal(file.name.includes('..'), false)
    assert.equal(sha256(file.bytes), file.sha256, 'Captured source hash mismatch')
    return { name: file.name, sha256: file.sha256, bytes: file.bytes.length }
  }).sort((left, right) => left.name.localeCompare(right.name))
  assert.equal(new Set(records.map(record => record.name)).size, records.length)
  return records
}
function selectedTestPassed(output) {
  const escaped = TEST_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const results = [...output.matchAll(new RegExp(`^(not ok|ok) [0-9]+ - ${escaped}(.*)$`, 'gm'))]
  assert.equal(results.length, 1, 'Exactly one selected native Bash test must execute')
  assert.equal(results[0][1], 'ok', 'Selected native Bash test failed')
  assert.equal(results[0][2].trim(), '', 'Selected native Bash test must not skip or remain TODO')
}
function main(workArgument) {
  assert.equal(process.platform, 'win32', 'The built-runtime smoke proof requires actual Windows')
  assert.equal(process.arch, 'x64', 'The pinned SDK compiler proof is x64')
  assert.ok(workArgument && process.argv.length === 3, 'Usage: node probe-built-runtime.cjs <build WorkRoot>')
  const work = physical(path.resolve(workArgument), true)
  const sdk = physical(path.join(work, 'sdk'), true)
  const payload = physical(path.join(sdk, 'issue27-build'), true)
  const stage = physical(path.join(payload, 'stage'), true)
  const logPath = path.join(payload, 'built-runtime-proof.txt')
  const log = fs.openSync(logPath, 'wx', 0o600)
  const note = message => { const line = `${message}\n`; fs.writeSync(log, line); process.stdout.write(line) }
  try {
    const lockBytes = readBounded(path.join(__dirname, 'build-lock.json'), 1024 * 1024)
    const lock = JSON.parse(lockBytes)
    assert.equal(lock.schema, 1)
    assert.equal(lock.sdk.commit, 'e3cc14afd549778c2f2d3bcc6e89307f40f5c2c1')
    assert.deepEqual(JSON.parse(readBounded(path.join(payload, 'lock.json'), 1024 * 1024)), lock, 'Compiler lock differs from the reviewed lock')
    const systemRoot = physical(process.env.SystemRoot, true)
    // The pinned SDK stores its MSYS Git in usr/bin (and native Git in
    // ucrt64/bin); it has no mingw64 tree. Select this exact pinned layout,
    // never a PATH executable or an unrelated installed Git fallback.
    const sdkGit = physical(path.join(sdk, 'usr', 'bin', 'git.exe'))
    const git = args => {
      const result = cp.spawnSync(sdkGit, ['--no-pager', '--no-optional-locks', '-C', sdk, ...args], {
        encoding: 'utf8', timeout: 15000, maxBuffer: 128 * 1024, windowsHide: true, shell: false,
        stdio: ['ignore', 'pipe', 'pipe'], env: { SystemRoot: systemRoot, WINDIR: systemRoot,
          PATH: `${path.dirname(sdkGit)};${path.join(systemRoot, 'System32')}`,
          GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: 'NUL', GIT_CONFIG_GLOBAL: 'NUL' },
      })
      assert.ifError(result.error)
      assert.equal(result.status, 0, result.stderr || 'SDK Git verification failed')
      return result.stdout
    }
    assert.match(git(['rev-parse', '--verify', 'HEAD']), new RegExp(`^${lock.sdk.commit}\\r?\\n$`), 'SDK HEAD differs from its pin')
    const sdkBin = physical(path.join(sdk, 'usr', 'bin'), true)
    const source = bindBashRuntime(sdkBin, systemRoot), sourceRecords = closureRecords(source)
    // HEAD alone does not prove working-tree bytes. Match every captured Bash
    // dependency against the pinned Git blob before executing a copied image.
    const tree = git(['ls-tree', '-z', lock.sdk.commit, '--', ...source.map(file => `usr/bin/${file.name}`)])
    const blobs = new Map()
    for (const record of tree.split('\0').filter(Boolean)) {
      const match = /^100(?:644|755) blob ([a-f0-9]{40})\tusr\/bin\/([a-z0-9_+.-]+)$/.exec(record)
      assert.ok(match, 'Unexpected SDK runtime tree entry')
      assert.equal(blobs.has(match[2]), false)
      blobs.set(match[2], match[1])
    }
    assert.equal(blobs.size, source.length)
    for (const file of source) {
      const blob = crypto.createHash('sha1').update(`blob ${file.bytes.length}\0`).update(file.bytes).digest('hex')
      assert.equal(blob, blobs.get(file.name), `SDK working-tree dependency differs from pinned commit: ${file.name}`)
    }
    const stageBytes = readBounded(path.join(stage, 'usr', 'bin', 'msys-2.0.dll'))
    const stageSha = stagedDigest(readBounded(path.join(payload, 'stage.sha256'), 4 * 1024 * 1024))
    assert.equal(sha256(stageBytes), stageSha, 'Staged DLL does not match stage.sha256')
    const fresh = path.join(payload, `proof-runtime-${crypto.randomUUID()}`)
    fs.mkdirSync(fresh, { mode: 0o700 })
    ensureWindowsPrivateAcl(fresh)
    physical(fresh, true)
    for (const file of source) fs.writeFileSync(path.join(fresh, file.name), file.name === 'msys-2.0.dll' ? stageBytes : file.bytes, { flag: 'wx', mode: 0o600 })
    const expected = sourceRecords.map(record => record.name === 'msys-2.0.dll' ? { name: record.name, sha256: stageSha, bytes: stageBytes.length } : record)
    assert.deepEqual(closureRecords(bindBashRuntime(fresh, systemRoot)), expected, 'Copied built runtime closure differs from captured inputs')
    const bashPath = path.join(fresh, 'bash.exe')
    const selected = resolveWindowsBash({ bashPath, env: { SystemRoot: systemRoot, PATH: fresh, AUTOPROMPT_WINDOWS_BASH: bashPath } })
    assert.ok(samePath(selected.bash.path, bashPath), 'Bash resolver fell back instead of selecting the built runtime')
    assert.deepEqual(closureRecords(selected.files), expected, 'Resolved closure differs from the fresh built runtime')
    const manifest = { schema: 1, purpose: 'prototype compiler-output smoke proof; not full platform certification', sdkCommit: lock.sdk.commit,
      sourceCommit: lock.source.commit, stageSha256: stageSha, bashPath, runtimeDirectory: fresh, source: sourceRecords, copied: expected, test: TEST_NAME }
    fs.writeFileSync(path.join(payload, 'built-runtime-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    note(`Built runtime bound: ${bashPath}`)
    note(`Staged DLL SHA256: ${stageSha}`)
    // Override only this child; inherited duplicate-cased keys are removed so
    // Windows cannot select an ambient value instead of the explicit path.
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['AUTOPROMPT_WINDOWS_BASH', 'NODE_OPTIONS', 'NODE_TEST_CONTEXT'].includes(key.toUpperCase())))
    environment.AUTOPROMPT_WINDOWS_BASH = bashPath
    const pattern = `^${TEST_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`
    const result = cp.spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern', pattern,
      path.resolve(__dirname, '../../tests/source/windows-bash-runtime.test.cjs')], {
      cwd: path.resolve(__dirname, '../..'), env: environment, encoding: 'utf8', timeout: 615000,
      maxBuffer: 8 * 1024 * 1024, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    })
    for (const [label, value] of [['stdout', result.stdout], ['stderr', result.stderr]]) if (value) { fs.writeSync(log, `[${label}]\n${value}`); (label === 'stdout' ? process.stdout : process.stderr).write(value) }
    assert.ifError(result.error)
    assert.equal(result.signal, null, 'Native Bash smoke child terminated by signal')
    assert.equal(result.status, 0, 'Native Bash smoke test failed')
    selectedTestPassed(result.stdout)
    assert.deepEqual(closureRecords(bindBashRuntime(sdkBin, systemRoot)), sourceRecords, 'Smoke proof modified SDK source inputs')
    assert.equal(sha256(readBounded(path.join(stage, 'usr', 'bin', 'msys-2.0.dll'))), stageSha, 'Smoke proof modified staged DLL')
    assert.deepEqual(closureRecords(bindBashRuntime(fresh, systemRoot)), expected, 'Smoke proof modified its copied runtime')
    note('Built runtime native Bash smoke passed; complete Windows support is not established by this probe.')
  } catch (error) {
    note(`Built runtime smoke refused: ${error.message}`)
    throw error
  } finally { fs.closeSync(log) }
}
if (require.main === module) {
  try { main(process.argv[2]) } catch (error) { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1 }
}
module.exports = { stagedDigest, readBounded, closureRecords, selectedTestPassed, TEST_NAME }
