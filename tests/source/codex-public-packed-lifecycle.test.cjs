'use strict'

// Exercise the public CLI from an offline tarball, not runtime.uninstallPayload.
// Provider sentinels permit version probes only; they never perform native work.
const assert = require('node:assert/strict')
const cp = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '../..')
const RECEIPT = '.autoprompt-install-receipt.json'
const HASHES = '.autoprompt-install-hashes.json'
const MARKER = 'skills/autoprompt/.autoprompt-runtime-manifest.json'
const VERSIONS = {
  claude: ['claude', '2.1.141'], codex: ['codex', 'codex-cli 0.148.0'],
  opencode: ['opencode', '1.5.7'], kilo: ['kilo', '7.1.0'], vscode: ['code', '1.133.0'],
  prime: ['prime-agent', '0.7.2'], omp: ['omp', '17.4.0'], deepseek: ['dsh', '0.1.2-rc.1'],
  hermes: ['hermes', '0.21.1'], grok: ['grok', '1.0.13'],
  reasonix: ['reasonix', 'reasonix v1.30.0'],
}

function run(command, args, options = {}) {
  return cp.spawnSync(command, args, { encoding: 'utf8', timeout: 240000, maxBuffer: 16 * 1024 * 1024, ...options })
}
function ok(result, label = '') {
  assert.equal(result.status, 0, `${label}\n${result.stdout}\n${result.stderr}\n${result.error || ''}`)
  return result
}
function assertCodexDoctorRow(output) {
  const row = output.split(/\r?\n/).find(line => /^codex\s/.test(line))
  assert.ok(row, output)
  assert.match(row, /extras=complete/)
  if (process.platform === 'win32') {
    assert.match(row, /^codex\s+yes\s+yes\s+no\s+/)
    assert.match(row, /reason=codex-windows-sandbox-identity-unavailable/)
    assert.match(row, /activation=unavailable/)
  } else assert.match(row, /^codex\s+yes\s+yes\s+yes\s+/)
}
function codexDoctor(result) {
  assert.equal(result.status, process.platform === 'win32' ? 1 : 0, `${result.stdout}\n${result.stderr}`)
  assertCodexDoctorRow(result.stdout)
  return result
}
function allProviderDoctor(result) {
  // Every v2 payload is intact, but version-only sentinels cannot satisfy the
  // native executable/capability prerequisites. Strict must expose that refusal.
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`)
  for (const provider of Object.keys(VERSIONS).filter(provider => provider !== 'codex')) {
    const row = result.stdout.split(/\r?\n/).find(line => new RegExp(`^${provider}\\s`).test(line))
    assert.ok(row, `Missing ${provider} doctor row:\n${result.stdout}`)
    assert.match(row, new RegExp(`^${provider}\\s+\\S+\\s+yes\\s+no\\s+`))
    assert.match(row, /extras=complete.*payload=verified activation=unavailable/)
  }
  assertCodexDoctorRow(result.stdout)
  return result
}
function write(file, bytes) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes) }
function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex') }
function literal(value) { return `'${value.replaceAll("'", `'"'"'`)}'` }
function psLiteral(value) { return `'${value.replaceAll("'", "''")}'` }
function bashPath(value) { return value.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`) }
function npmCli() {
  const found = [process.env.npm_execpath,
    path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    '/usr/share/nodejs/npm/bin/npm-cli.js',
  ].filter(Boolean).find(file => fs.existsSync(file))
  assert.ok(found, 'npm CLI required for offline packed public lifecycle')
  return found
}
function environment(directory) {
  const env = { ...process.env }
  for (const key of ['AUTOPROMPT_INSTALL_ROOT', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'PRIME_AGENT_CODING_AGENT_DIR',
    'OMP_PROFILE', 'PI_PROFILE', 'PI_CONFIG_DIR', 'PI_CODING_AGENT_DIR', 'DSH_HOME', 'HERMES_HOME', 'GROK_HOME', 'REASONIX_HOME',
    'AUTOPROMPT_WORKSPACE_ROOT', 'NODE_PATH']) delete env[key]
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'npm_config_dry_run') delete env[key]
  Object.assign(env, {
    HOME: path.join(directory, 'home'), USERPROFILE: path.join(directory, 'home'),
    XDG_CONFIG_HOME: path.join(directory, 'xdg'), APPDATA: path.join(directory, 'appdata'),
    LOCALAPPDATA: path.join(directory, 'localappdata'),
    npm_config_cache: path.join(directory, 'npm-cache'), npm_config_offline: 'true',
    npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false',
    PATH: [path.join(directory, 'bin'), path.dirname(process.execPath), process.env.PATH || ''].join(path.delimiter),
  })
  for (const key of ['HOME', 'XDG_CONFIG_HOME', 'APPDATA', 'LOCALAPPDATA', 'npm_config_cache']) fs.mkdirSync(env[key], { recursive: true })
  for (const [command, version] of Object.values(VERSIONS)) {
    const file = path.join(directory, 'bin', `${command}${process.platform === 'win32' ? '.cmd' : ''}`)
    write(file, process.platform === 'win32'
      ? `@echo off\r\nif "%~1"=="--version" (echo ${version}& exit /b 0)\r\nif "%~1"=="-v" (echo ${version}& exit /b 0)\r\necho NATIVE WORK FORBIDDEN 1>&2\r\nexit /b 93\r\n`
      : `#!/bin/sh\ncase "$1" in --version|-v) printf '%s\\n' '${version}' ;; *) echo 'NATIVE WORK FORBIDDEN' >&2; exit 93 ;; esac\n`)
    fs.chmodSync(file, 0o700)
  }
  return env
}
function snapshot(directory) {
  if (!fs.existsSync(directory)) return {}
  return Object.fromEntries(fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) return [[entry.name, `link:${fs.readlinkSync(target)}`]]
    if (entry.isDirectory()) return Object.entries(snapshot(target)).map(([name, bytes]) => [`${entry.name}/${name}`, bytes])
    return [[entry.name, fs.readFileSync(target).toString('base64')]]
  }))
}
function codexInstallation(root) {
  const receipt = JSON.parse(fs.readFileSync(path.join(root, RECEIPT)))
  const marker = receipt.files.find(file => file.replaceAll('\\', '/').endsWith(`/${MARKER}`))
  assert.ok(marker, 'public receipt must own the private embedded manifest')
  const generation = JSON.parse(fs.readFileSync(marker)).payloadGeneration
  assert.match(generation, /^codex-v2\.0\.0-[a-f0-9]{16}$/)
  const bundle = path.join(root, '.autoprompt-private/bundles', generation)
  assert.ok(receipt.files.some(file => file.replaceAll('\\', '/').includes(`/${generation}/scripts/local-only-safety.cjs`)))
  return { receipt, marker, generation, bundle }
}
function assertRemoved(root, installed, preserved = new Set()) {
  for (const file of installed.receipt.files) {
    if (!preserved.has(file)) assert.equal(fs.existsSync(file), false, `receipt-owned file retained: ${file}`)
  }
  for (const relative of [RECEIPT, HASHES, 'skills/autoprompt/SKILL.md', '.autoprompt-operation.lock']) {
    assert.equal(fs.existsSync(path.join(root, relative)), false, relative)
  }
}
function preservationFiles(root) {
  const files = new Map([
    ['notes/user.txt', 'user data\n'],
    ['.autoprompt-private/bundles/claude-v2.0.0-aaaaaaaaaaaaaaaa/notes.txt', 'other provider data\n'],
    ['.autoprompt-private/bundles/codex-v2.0.0-bbbbbbbbbbbbbbbb/notes.txt', 'unregistered valid-looking generation\n'],
    ['.autoprompt-private/bundles/codex-v2.0.0-cccccccccccccccc-extra/notes.txt', 'invalid generation suffix\n'],
    ['.autoprompt-private/bundles/codex-v1.0.4-dddddddddddddddd/notes.txt', 'outside v2 scope\n'],
    ['.autoprompt-private/activations/archived/notes.txt', 'history sentinel, not an activation record\n'],
    ['.autoprompt-private/legacy-v1/notes.txt', 'quarantine history\n'],
    ['.a/archived/notes.txt', 'Codex history sentinel, not an activation record\n'],
  ].map(([relative, bytes]) => [path.join(root, relative), bytes]))
  for (const [file, bytes] of files) write(file, bytes)
  return files
}
function assertPreserved(files) { for (const [file, bytes] of files) assert.equal(fs.readFileSync(file, 'utf8'), bytes, file) }

test('packed public Codex and all-provider lifecycles remove receipt-bound v2 bundles without deleting private user data', {
  timeout: 1200000,
}, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-public-packed-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const packEnv = environment(path.join(directory, 'pack-env'))
  const packed = ok(run(process.execPath, [npmCli(), 'pack', '--ignore-scripts', '--json', '--pack-destination', directory], { cwd: ROOT, env: packEnv }), 'offline npm pack')
  const tarball = path.join(directory, JSON.parse(packed.stdout)[0].filename)
  ok(run('tar', ['-xf', tarball, '-C', directory]), 'extract offline tarball')
  const source = path.join(directory, 'package')
  const cli = path.join(source, 'bin/autoprompt.cjs')
  const lock = require(path.join(source, 'scripts/install/operation-lock.cjs'))
  const pkg = require(path.join(source, 'scripts/harness-v2-package.cjs'))
  const reasonix = require(path.join(source, 'scripts/reasonix-package.cjs'))
  assert.ok(fs.existsSync(path.join(source, 'node_modules/@iarna/toml/package.json')))

  await t.test('all: public install/replay/strict doctor/uninstall/reinstall use isolated native roots', () => {
    const sandbox = path.join(directory, 'all')
    const env = environment(sandbox)
    const root = path.join(env.HOME, '.codex')
    const invoke = args => {
      const result = run(process.execPath, [cli, ...args], { cwd: sandbox, env })
      t.diagnostic(`all: ${args.join(' ')} status=${result.status}`)
      return result
    }
    ok(invoke(['install', 'all']))
    const initial = codexInstallation(root)
    for (const relative of ['.autoprompt-private', '.autoprompt-private/bundles']) {
      assert.ok(initial.receipt.createdDirectories.some(file => path.resolve(file) === path.join(root, relative)),
        `fresh installation must record its owned parent: ${relative}`)
    }
    ok(invoke(['install', 'all']))
    assert.equal(codexInstallation(root).generation, initial.generation)
    allProviderDoctor(invoke(['doctor', '--strict']))
    // Make receipt-created parents nonempty with unowned data after installation.
    // Uninstall must relinquish them, not recurse or retain a stale receipt.
    const preserved = preservationFiles(root)
    const otherReceipts = pkg.PROVIDERS.map(provider => {
      const otherRoot = pkg.resolveRoot(provider, env)
      return { provider, root: otherRoot, receipt: pkg.readReceipt(provider, otherRoot) }
    })
    ok(invoke(['uninstall', 'all']))
    assertRemoved(root, initial)
    assert.equal(fs.existsSync(initial.bundle), false)
    for (const other of otherReceipts) {
      assert.equal(fs.existsSync(pkg.bundlePath(other.root, other.receipt)), false, other.provider)
      assert.equal(fs.existsSync(path.join(other.root, pkg.receiptName(other.provider))), false, other.provider)
    }
    assert.equal(fs.existsSync(path.join(reasonix.resolveRoot(env), '.autoprompt-reasonix-v2.json')), false)
    assertPreserved(preserved)
    ok(invoke(['install', 'all']))
    const reinstalled = codexInstallation(root)
    allProviderDoctor(invoke(['doctor', '--strict']))
    ok(invoke(['uninstall', 'all']))
    assertRemoved(root, reinstalled)
    assertPreserved(preserved)
  })

  await t.test('custom root: replay, lock refusal, clean reinstall and drift-safe public uninstall', () => {
    const sandbox = path.join(directory, 'custom')
    const env = environment(sandbox)
    const root = path.join(sandbox, 'custom config 雪')
    const preserved = preservationFiles(root)
    write(path.join(root, 'config.toml'), 'model = "user-choice"\n')
    preserved.set(path.join(root, 'config.toml'), 'model = "user-choice"\n')
    const invoke = args => {
      const result = run(process.execPath, [cli, ...args, '--root', root], { cwd: sandbox, env })
      t.diagnostic(`custom: ${args.join(' ')} status=${result.status}`)
      return result
    }
    ok(invoke(['install', 'codex']))
    const first = codexInstallation(root)
    ok(invoke(['install', 'codex']))
    assert.equal(codexInstallation(root).generation, first.generation)
    codexDoctor(invoke(['doctor', 'codex', '--strict']))
    const lease = lock.acquire(root, 'public-lifecycle-regression')
    try {
      const before = snapshot(root)
      const refused = invoke(['uninstall', 'codex'])
      assert.notEqual(refused.status, 0)
      assert.match(refused.stderr, /operation lock is held/)
      assert.deepEqual(snapshot(root), before)
    } finally { lock.release(lease) }
    ok(invoke(['uninstall', 'codex']))
    assertRemoved(root, first)
    assert.equal(fs.existsSync(first.bundle), false)
    assertPreserved(preserved)
    ok(invoke(['install', 'codex']))
    const second = codexInstallation(root)
    codexDoctor(invoke(['doctor', 'codex', '--strict']))
    const drift = path.join(second.bundle, 'skills/autoprompt/GATES.md')
    fs.appendFileSync(drift, '\nuser edit must survive public uninstall\n')
    fs.appendFileSync(second.marker, '\nuser manifest edit must survive\n')
    const custom = path.join(second.bundle, 'skills/autoprompt/custom-note.txt')
    write(custom, 'unreceipted custom bytes inside owned generation\n')
    const drifted = new Map([drift, second.marker, custom].map(file => [file, fs.readFileSync(file, 'utf8')]))
    assert.notEqual(invoke(['doctor', 'codex', '--strict']).status, 0)
    ok(invoke(['uninstall', 'codex']))
    assertRemoved(root, second, new Set([drift, second.marker]))
    assertPreserved(drifted)
    assertPreserved(preserved)
    // Reinstall may refuse unowned drift, but must not overwrite it silently.
    const retry = invoke(['install', 'codex'])
    assert.notEqual(retry.status, 0, 'reinstall must not overwrite relinquished user edits')
    assertPreserved(drifted)
    assertPreserved(preserved)
  })
})

for (const port of ['bash', 'powershell']) test(`${port}: Codex v2 scope requires a receipt-bound marker and excludes other generations, traversal and non-directory parents`, t => {
  const executable = port === 'bash'
    ? require('../helpers/resolve-bash.cjs').resolveBash()
    : (process.platform === 'win32' ? 'powershell.exe' : 'pwsh')
  const probeArgs = port === 'bash' ? ['--version'] : ['-NoProfile', '-NonInteractive', '-Command', 'exit 0']
  if (!executable || run(executable, probeArgs).status !== 0) { t.skip(`${executable} unavailable`); return }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-codex-scope-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const env = environment(directory)
  const root = path.join(directory, 'root')
  const bundle = path.join(root, '.autoprompt-private/bundles/codex-v2.0.0-aaaaaaaaaaaaaaaa')
  const marker = path.join(bundle, MARKER)
  const invalid = path.join(root, '.autoprompt-private/bundles/codex-v2.0.0-bbbbbbbbbbbbbbbb-extra', MARKER)
  const other = path.join(root, '.autoprompt-private/bundles/claude-v2.0.0-cccccccccccccccc', MARKER)
  const unfingerprinted = path.join(root, '.autoprompt-private/bundles/codex-v2.0.0-dddddddddddddddd', MARKER)
  for (const file of [marker, invalid, other, unfingerprinted]) write(file, '{}\n')
  const files = [marker, invalid, other, unfingerprinted]
  const outside = path.join(directory, 'outside')
  write(path.join(outside, 'keep.txt'), 'linked ancestor must not authorize outside deletion\n')
  fs.symlinkSync(outside, path.join(bundle, 'redirected'), process.platform === 'win32' ? 'junction' : 'dir')
  write(path.join(root, HASHES), `{\n${files.slice(0, 3).map((file, index) => `    ${JSON.stringify(file)}: "${digest('{}\n')}"${index < 2 ? ',' : ''}`).join('\n')}\n}\n`)
  const cases = [
    [path.join(bundle, 'skills/autoprompt/GATES.md'), false, true],
    [path.join(bundle, 'scripts/local-only-safety.cjs'), false, true],
    [bundle, true, true],
    [path.join(root, '.autoprompt-private'), true, true],
    [path.join(root, '.autoprompt-private/bundles'), true, true],
    [path.join(root, '.autoprompt-private'), false, false],
    [path.join(root, '.autoprompt-private/bundles'), false, false],
    [invalid, false, false], [other, false, false], [unfingerprinted, false, false],
    [path.join(root, '.autoprompt-private/bundles/codex-v2.0.0-eeeeeeeeeeeeeeee/user.txt'), false, false],
    [path.join(root, '.autoprompt-private/activations/notes.txt'), false, false],
    [path.join(bundle, 'redirected/keep.txt'), false, false],
    [path.join(bundle, 'redirected'), true, false],
    [`${bundle}/../claude-v2.0.0-cccccccccccccccc/user.txt`, false, false],
  ]
  const script = port === 'bash' ? [
    `source ${literal(bashPath(path.join(ROOT, 'scripts/install/lib/install-lib.sh')))}`,
    `files=(${files.map(file => literal(bashPath(file))).join(' ')})`,
    'codex_v2_receipt_bundles=()',
    `_codex_v2_receipt_bundle_roots ${literal(bashPath(root))} files codex_v2_receipt_bundles || exit 81`,
    '[ "${#codex_v2_receipt_bundles[@]}" -eq 1 ] || exit 82',
    ...cases.map(([file, isDirectory, expected], index) => `if _codex_v2_receipt_owned_path ${literal(bashPath(root))} ${literal(bashPath(file))} ${isDirectory ? 'directory' : 'file'}; then actual=0; else actual=1; fi; [ "$actual" -eq ${expected ? 0 : 1} ] || { echo 'case ${index} failed'; exit 83; }`),
  ].join('\n') : [
    `. ${psLiteral(path.join(ROOT, 'scripts/install/lib/install-lib.ps1'))}`,
    `$files = @(${files.map(psLiteral).join(',')})`,
    `$AutopromptCodexV2ReceiptBundleRoots = @(Get-CodexV2ReceiptBundleRoots -ConfigRoot ${psLiteral(root)} -Files $files)`,
    'if ($AutopromptCodexV2ReceiptBundleRoots.Count -ne 1) { throw "scope count" }',
    ...cases.map(([file, isDirectory, expected], index) => `if ((Test-CodexV2ReceiptBundlePath -ConfigRoot ${psLiteral(root)} -Path ${psLiteral(file)} -Directory:$${isDirectory}) -ne $${expected}) { throw 'case ${index} failed' }`),
  ].join(';\n')
  const args = port === 'bash' ? ['-c', script] : ['-NoProfile', '-NonInteractive', '-Command', script]
  ok(run(executable, args, { env }), port)
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'linked ancestor must not authorize outside deletion\n')
})
