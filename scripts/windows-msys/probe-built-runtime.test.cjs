'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const vm = require('node:vm')
const cp = require('node:child_process')
const probe = require('./probe-built-runtime.cjs')
const lock = require('./build-lock.json')
const helperPath = path.join(__dirname, 'probe-built-runtime.cjs')
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const blobDigest = bytes => crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
const temporaryRoot = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'built-runtime-proof-check-')))

test('built runtime proof accepts one staged digest and rejects ambiguous or escaping manifests', () => {
  const hash = 'a'.repeat(64), valid = `${hash}  stage/usr/bin/msys-2.0.dll\n`
  assert.equal(probe.stagedDigest(Buffer.from(valid)), hash)
  assert.equal(probe.stagedDigest(Buffer.from(valid.replace('  ', ' *'))), hash)
  for (const bad of ['', valid.trimEnd(), valid.replace('\n', '\r\n'), valid + valid,
    valid + valid.replace('msys', 'MSYS'), valid.replace('  ', '**'), valid.replace('  ', ' x'),
    valid + valid.replace('  ', ' *'),
    valid.replace('usr/bin', 'usr/../bin'), valid.replace('usr/bin', 'usr//bin'),
    valid.replace('msys-2.0.dll', 'other.dll'), valid.replace(hash, hash.toUpperCase()), valid + 'garbage\n']) {
    assert.throws(() => probe.stagedDigest(Buffer.from(bad)))
  }
  assert.throws(() => probe.stagedDigest(Buffer.concat([Buffer.from(valid), Buffer.from([255, 10])])))
})

test('built runtime proof parses binary checksum records from the actual MSYS compiler artifact', () => {
  const actual = fs.readFileSync(path.resolve(__dirname, '../../tests/fixtures/windows-msys/compiler-stage.sha256'))
  assert.equal(probe.stagedDigest(actual), 'da05c7bdf38798149b94410f11dfced7de563f046fd9eeb259d268ce17740747')
})

function pe64(characteristics) {
  const bytes = Buffer.alloc(512); bytes.writeUInt16LE(0x5a4d, 0); bytes.writeUInt32LE(0x80, 0x3c); bytes.writeUInt32LE(0x4550, 0x80)
  bytes.writeUInt16LE(0xf0, 0x94); bytes.writeUInt16LE(0x20b, 0x98); bytes.writeUInt16LE(characteristics, 0x98 + 70); return bytes
}
test('built runtime proof requires the staged DLL DYNAMIC_BASE PE bit', () => {
  assert.equal(probe.dllCharacteristics(pe64(0x140)), 0x140); probe.requireDynamicBase(pe64(0x40))
  assert.throws(() => probe.requireDynamicBase(pe64(0)), /DYNAMIC_BASE/)
  assert.throws(() => probe.dllCharacteristics(Buffer.alloc(64)), /DOS header/)
})

test('built runtime proof requires one successful unskipped native test', () => {
  const success = `ok 1 - ${probe.TEST_NAME}\n`
  probe.selectedTestPassed(`TAP version 13\n${success}1..1\n`)
  for (const output of ['', success.replace('ok ', 'not ok '), success.trimEnd() + ' # SKIP\n',
    success.trimEnd() + ' # TODO\n', success.trimEnd() + ' different case\n',
    success + success.replace('ok 1', 'ok 2')]) assert.throws(() => probe.selectedTestPassed(output))
})

test('built runtime proof refuses oversized and linked inputs and mismatched captured hashes', t => {
  const root = temporaryRoot()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const directory = path.join(root, 'source'), linkedDirectory = path.join(root, 'linked')
  fs.mkdirSync(directory)
  const file = path.join(directory, 'bounded'), bytes = Buffer.from('bounded-data')
  fs.writeFileSync(file, bytes)
  assert.deepEqual(probe.readBounded(file, bytes.length), bytes)
  assert.throws(() => probe.readBounded(file, bytes.length - 1))
  // A directory junction requires no Windows developer-mode symlink privilege.
  fs.symlinkSync(directory, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => probe.readBounded(path.join(linkedDirectory, 'bounded')))
  const hardlink = path.join(root, 'hardlink')
  fs.linkSync(file, hardlink)
  assert.throws(() => probe.readBounded(file))
  fs.unlinkSync(hardlink)
  const files = ['bash.exe', 'msys-2.0.dll'].map(name => ({ name, bytes, sha256: digest(bytes) }))
  assert.equal(probe.closureRecords(files).length, 2)
  assert.throws(() => probe.closureRecords([files[0], files[0]]))
  assert.throws(() => probe.closureRecords([files[0], { ...files[1], sha256: 'a'.repeat(64) }]))
  assert.throws(() => probe.closureRecords([files[0], { ...files[1], name: '../outside.dll' }]))
})

// Exercise the complete controller and actual filesystem writes. Only Windows
// process calls, native ACL setup, PE binding and Bash transformation are substituted; the helper's
// lock/blob/digest/path checks, exclusive copies, manifest and TAP gate execute
// unchanged. This is not a substitute for the actual Windows Bash smoke test.
for (const scenario of ['pass', 'binary checksum', 'missing pinned SDK Git', 'stage mismatch', 'pinned source drift', 'Bash transformation refused', 'resolver fallback',
  'skipped native case', 'failed native case', 'source changed during smoke']) {
  test(`built runtime controller: ${scenario}`, t => {
    const root = temporaryRoot()
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const sdk = path.join(root, 'sdk'), payload = path.join(sdk, 'issue27-build')
    const bin = path.join(sdk, 'usr', 'bin'), systemRoot = path.join(root, 'Windows')
    const stage = path.join(payload, 'stage', 'usr', 'bin')
    for (const directory of [bin, stage, systemRoot]) fs.mkdirSync(directory, { recursive: true })
    if (scenario === 'missing pinned SDK Git') {
      // An obsolete layout or ambient executable must not hide a missing
      // expected pinned SDK input.
      const obsolete = path.join(sdk, 'mingw64', 'bin')
      fs.mkdirSync(obsolete, { recursive: true })
      fs.writeFileSync(path.join(obsolete, 'git.exe'), 'must never execute')
    } else fs.writeFileSync(path.join(bin, 'git.exe'), 'unused pinned SDK process-call placeholder')
    fs.writeFileSync(path.join(payload, 'lock.json'), JSON.stringify(lock))
    const original = { 'bash.exe': Buffer.from('pinned Bash'), 'msys-2.0.dll': Buffer.from('pinned original DLL') }
    const derivedBash = Buffer.from('derived Bash with relocation flag')
    const built = pe64(0x40), foreign = Buffer.from('untrusted mutation')
    for (const [name, bytes] of Object.entries(original)) fs.writeFileSync(path.join(bin, name), bytes)
    if (scenario === 'pinned source drift') fs.writeFileSync(path.join(bin, 'msys-2.0.dll'), foreign)
    fs.writeFileSync(path.join(stage, 'msys-2.0.dll'), scenario === 'stage mismatch' ? foreign : built)
    fs.writeFileSync(path.join(payload, 'stage.sha256'), `${digest(built)} ${scenario === 'binary checksum' ? '*' : ' '}stage/usr/bin/msys-2.0.dll\n`)
    const beforeSource = fs.readFileSync(path.join(bin, 'msys-2.0.dll'))
    const beforeStage = fs.readFileSync(path.join(stage, 'msys-2.0.dll'))
    const bind = directory => Object.keys(original).map(name => {
      const file = path.join(directory, name), bytes = fs.readFileSync(file)
      return { name, bytes, sha256: digest(bytes), path: file }
    })
    const state = { childCalls: 0, acl: [], runtime: null }
    const module = { exports: {} }
    const environment = { SystemRoot: systemRoot, AUTOPROMPT_WINDOWS_BASH: 'ambient Bash', Node_Options: 'ambient Node options' }
    const fakeProcess = { platform: 'win32', arch: 'x64', argv: [process.execPath, helperPath, root],
      execPath: process.execPath, env: environment, stdout: { write() {} }, stderr: { write() {} } }
    const native = {
      spawnSync(executable, args, options) {
        if (executable === path.join(bin, 'git.exe')) {
          if (args.includes('rev-parse')) return { status: 0, stdout: lock.sdk.commit + '\n' }
          assert.ok(args.includes('ls-tree'))
          return { status: 0, stdout: Object.entries(original).map(([name, bytes]) => `100755 blob ${blobDigest(bytes)}\tusr/bin/${name}\0`).join('') }
        }
        ++state.childCalls
        assert.equal(executable, process.execPath)
        assert.equal(args[0],'--test-reporter=tap');assert.equal(args[1],path.join(__dirname,'diagnostic-smoke/native.cjs'))
        const contextBytes=fs.readFileSync(args[2]),context=JSON.parse(contextBytes)
        assert.equal(args[3],digest(contextBytes));assert.equal(context.bash.path,path.join(state.runtime,'bash.exe'))
        assert.equal(context.node.kind,'compiler-controller');assert.equal(context.node.sha256,digest(fs.readFileSync(process.execPath)))
        assert.equal(options.timeout, 615000)
        assert.equal(options.env.Node_Options, undefined)
        assert.equal(options.env.AUTOPROMPT_WINDOWS_BASH, undefined)
        assert.equal(environment.AUTOPROMPT_WINDOWS_BASH, 'ambient Bash', 'The controller must not mutate its own environment')
        assert.deepEqual(fs.readFileSync(path.join(state.runtime, 'msys-2.0.dll')), built)
        assert.deepEqual(fs.readFileSync(path.join(state.runtime, 'bash.exe')), derivedBash)
        if (scenario === 'source changed during smoke') fs.writeFileSync(path.join(bin, 'msys-2.0.dll'), foreign)
        return { status: scenario === 'failed native case' ? 1 : 0, signal: null,
          stdout: `ok 1 - ${probe.TEST_NAME}${scenario === 'skipped native case' ? ' # SKIP' : ''}\n`, stderr: 'native diagnostic witness\n' }
      },
    }
    const customRequire = name => {
      if (name === './bash-relocation.cjs') return { derive(bytes) {
        assert.deepEqual(bytes, original['bash.exe'])
        if (scenario === 'Bash transformation refused') throw Error('Pinned SDK Bash required')
        return { bytes: derivedBash, receipt: { originalSha256: digest(bytes), derivedSha256: digest(derivedBash) } }
      } }
      if (name === 'node:child_process') return native
      if (name.endsWith('/diagnostic-smoke/command.cjs')) return {
        bindBashRuntime: bind,
        resolveWindowsBash({ diagnosticTuple }) {
          const bashPath=diagnosticTuple.bash.path
          state.runtime = path.dirname(bashPath)
          assert.equal(path.dirname(state.runtime), payload, 'Proof copy must be beside stage')
          assert.ok(path.basename(state.runtime).startsWith('proof-runtime-'))
          assert.ok(state.acl.includes(state.runtime), 'Private ACL must precede execution')
          return { bash: { path: scenario === 'resolver fallback' ? path.join(bin, 'bash.exe') : bashPath }, files: bind(state.runtime) }
        },
      }
      if (name.endsWith('/safe-run-root.js')) return { ensureWindowsPrivateAcl(directory) { state.acl.push(directory) } }
      return require(name)
    }
    // Expose main only in this isolated test copy, without production test hooks.
    vm.runInNewContext(fs.readFileSync(helperPath, 'utf8') + '\nmodule.exports.mainForTest = main;\n',
      { require: customRequire, module, __dirname, process: fakeProcess, Buffer }, { filename: helperPath })
    const main = () => module.exports.mainForTest(root)
    if (['pass', 'binary checksum'].includes(scenario)) main()
    else assert.throws(main, {
      message: new RegExp({
        'missing pinned SDK Git': 'ENOENT',
        'stage mismatch': 'Staged DLL does not match',
        'Bash transformation refused': 'Pinned SDK Bash required',
        'pinned source drift': 'SDK working-tree dependency differs',
        'resolver fallback': 'Bash resolver fell back',
        'skipped native case': 'must not skip',
        'failed native case': 'Native Bash smoke test failed',
        'source changed during smoke': 'Smoke proof modified SDK source inputs',
      }[scenario]),
    })
    const launched = ['pass', 'binary checksum', 'skipped native case', 'failed native case', 'source changed during smoke'].includes(scenario)
    assert.equal(state.childCalls, launched ? 1 : 0, 'Failed input verification must prevent the native test')
    assert.deepEqual(fs.readFileSync(path.join(bin, 'msys-2.0.dll')), scenario === 'source changed during smoke' ? foreign : beforeSource)
    assert.deepEqual(fs.readFileSync(path.join(stage, 'msys-2.0.dll')), beforeStage)
    const log = fs.readFileSync(path.join(payload, 'built-runtime-proof.txt'), 'utf8')
    if (launched) {
      assert.ok(log.includes('native diagnostic witness'))
      const manifest = JSON.parse(fs.readFileSync(path.join(payload, 'built-runtime-manifest.json'), 'utf8'))
      assert.equal(manifest.stageSha256, digest(built))
      assert.equal(manifest.sdkCommit, lock.sdk.commit)
      assert.equal(manifest.bashPath, path.join(state.runtime, 'bash.exe'))
      assert.equal(manifest.bashTransformation.originalSha256, digest(original['bash.exe']))
      assert.equal(manifest.bashTransformation.derivedSha256, digest(derivedBash))
      assert.equal(manifest.bashTransformationRecipeSha256, digest(fs.readFileSync(path.join(__dirname, 'bash-relocation.cjs'))))
      assert.equal(manifest.source.find(file => file.name === 'bash.exe').sha256, digest(original['bash.exe']))
      assert.equal(manifest.copied.find(file => file.name === 'bash.exe').sha256, digest(derivedBash))
    }
    assert.ok(log.includes(['pass', 'binary checksum'].includes(scenario) ? 'native Bash smoke passed' : 'Built runtime smoke refused'))
  })
}

test('built runtime CLI refusal exits nonzero directly and through the workflow PowerShell boundary', { timeout: 90000 }, t => {
  const root = temporaryRoot()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const missing = path.join(root, 'absent-build-root')
  const direct = cp.spawnSync(process.execPath, [helperPath, missing], { encoding: 'utf8', timeout: 15000 })
  assert.ifError(direct.error)
  assert.equal(direct.status, 1, direct.stdout || direct.stderr)
  const expected = process.platform !== 'win32' ? 'requires actual Windows' : process.arch !== 'x64' ? 'pinned SDK compiler proof is x64' : 'ENOENT'
  assert.ok(direct.stderr.includes(expected))
  const powershell = 'pwsh' // Match the GitHub workflow shell, including on Windows.
  const result = cp.spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop";$PSNativeCommandUseErrorActionPreference=$false;& $env:AUTOPROMPT_EXIT_NODE $env:AUTOPROMPT_EXIT_SCRIPT $env:AUTOPROMPT_EXIT_MISSING;$observed=$LASTEXITCODE;Write-Output "probe-exit:$observed";if($observed -ne 0){exit $observed}'], {
    encoding: 'utf8', timeout: 60000, env: { ...process.env, AUTOPROMPT_EXIT_NODE: process.execPath, AUTOPROMPT_EXIT_SCRIPT: helperPath, AUTOPROMPT_EXIT_MISSING: missing },
  })
  if (result.error?.code === 'ENOENT' && process.platform !== 'win32') {
    t.diagnostic('Direct CLI exit tested; PowerShell boundary unavailable on this host')
    return
  }
  assert.ifError(result.error)
  assert.equal(result.status, 1, result.stdout || result.stderr)
  assert.match(result.stdout, /probe-exit:1/)
})
