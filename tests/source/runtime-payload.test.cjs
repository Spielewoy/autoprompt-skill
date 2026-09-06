#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const ROOT = path.resolve(__dirname, '..', '..')
const {
  CODEX_EMBEDDED_MANIFEST,
  CODEX_EXTERNAL_RUNTIME_DEPENDENCIES,
  CODEX_RUNTIME_DYNAMIC_REQUIRES,
  assertCodexSourceClosure,
  codexRuntimeFiles,
  codexPayloadDigest,
  discoverCodexExternalRuntimeDependencies,
  installationPlan,
  installPayload,
  loadManifest,
  prunePayload,
  renderManifests,
  run: runRuntimePayload,
  uninstallPayload,
  validateDeclaredRuntimeRequires,
  verifyPayload,
} = require('../../scripts/runtime-payload.cjs')

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function npmCliPath() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean)
  const candidate = candidates.find(file => fs.existsSync(file))
  assert.ok(candidate, `could not locate npm CLI; checked ${candidates.join(', ')}`)
  return candidate
}

function windowsDirectoryGuardFixture(root, resolvedRoot) {
  const winPath = path.win32
  const directories = new Map()
  const events = []
  const identity = { dev: 19n, ino: 9007199254740992n, linked: false }
  const key = file => winPath.normalize(file).replace(/\\$/, '')
  const addDirectory = (directory, stats = identity) => {
    for (let current = directory; ; current = winPath.dirname(current)) {
      if (!directories.has(key(current))) directories.set(key(current), { ...stats })
      if (winPath.dirname(current) === current) break
    }
  }
  addDirectory(root)
  addDirectory(resolvedRoot)
  // These namespace prefixes are not directories; dirname walks above the
  // actual extended UNC share unless production explicitly anchors the walk.
  for (const file of [...directories.keys()]) {
    if (/^\\\\\?\\UNC(?:\\[^\\]+)?$/i.test(file)) directories.delete(file)
  }
  const modeledFs = {
    existsSync: file => directories.has(key(file)),
    lstatSync(file, options = {}) {
      events.push({ action: 'lstat', file })
      const stats = directories.get(key(file))
      if (!stats) {
        if (options.throwIfNoEntry === false) return undefined
        throw Object.assign(new Error(`missing modeled directory: ${file}`), { code: 'ENOENT' })
      }
      return {
        dev: options.bigint ? stats.dev : Number(stats.dev),
        ino: options.bigint ? stats.ino : Number(stats.ino),
        isDirectory: () => true,
        isSymbolicLink: () => stats.linked,
      }
    },
    realpathSync: { native: file => file === root ? resolvedRoot : file },
    mkdirSync(file, options = {}) {
      events.push({ action: 'mkdir', file })
      if (!options.recursive) assert.ok(directories.has(key(winPath.dirname(file))))
      addDirectory(file)
    },
  }
  // Execute the production guard and all of its helpers, with Windows lexical
  // semantics and modeled file IDs. Native Windows install tests below retain
  // their actual os.tmpdir spelling; this model does not replace that CI gate.
  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'runtime-payload.cjs'), 'utf8')
  const start = source.indexOf('function isContained(')
  const end = source.indexOf('function assertRegularUnlinked(', start)
  assert.ok(start >= 0 && end > start)
  const guard = vm.runInNewContext(`${source.slice(start, end)}\nassertDirectoryChainUnlinked`, {
    fs: modeledFs, path: winPath, process: { platform: 'win32' },
  })
  return { guard, directories, events, identity }
}

test('Windows runtime roots accept exact physical short/long aliases after checking every ancestor', () => {
  for (const [root, resolvedRoot] of [
    ['C:\\Users\\RUNNER~1\\Temp\\activation', 'C:\\Users\\runneradmin\\Temp\\activation'],
    ['\\\\server\\share\\RUNNER~1\\activation', '\\\\server\\share\\runneradmin\\activation'],
    ['\\\\?\\C:\\Users\\RUNNER~1\\activation', '\\\\?\\C:\\Users\\runneradmin\\activation'],
    ['\\\\?\\UNC\\server\\share\\RUNNER~1\\activation', '\\\\?\\UNC\\server\\share\\runneradmin\\activation'],
  ]) {
    const fixture = windowsDirectoryGuardFixture(root, resolvedRoot)
    const target = path.win32.join(root, 'skills', 'autoprompt')
    assert.doesNotThrow(() => fixture.guard(root, target, true), root)
    assert.deepEqual(fixture.events.filter(event => event.action === 'mkdir').map(event => event.file), [
      path.win32.join(root, 'skills'), target,
    ])
    const firstWrite = fixture.events.findIndex(event => event.action === 'mkdir')
    const extendedShare = /^(\\\\\?\\UNC\\[^\\]+\\[^\\]+)(?:\\|$)/i.exec(root)?.[1]
    for (let ancestor = root; ; ancestor = path.win32.dirname(ancestor)) {
      assert.ok(fixture.events.slice(0, firstWrite).some(event => event.action === 'lstat' &&
        event.file.replace(/\\$/, '') === ancestor.replace(/\\$/, '')), ancestor)
      if (ancestor === extendedShare) break
      if (path.win32.dirname(ancestor) === ancestor) break
    }
    assert.throws(() => fixture.guard(root, `${root}-outside`, true), /escapes activation root/)
  }
})

test('Windows runtime aliases require exact bigint identities and ordinary filesystem paths', () => {
  const root = 'C:\\Users\\RUNNER~1\\activation'
  const resolvedRoot = 'C:\\Users\\runneradmin\\activation'
  for (const replacement of [
    { ino: 9007199254740993n }, // Adjacent file IDs must not collapse through Number precision.
    { dev: 20n },
    { ino: 0n },
    { ino: undefined },
    { linked: true },
  ]) {
    const fixture = windowsDirectoryGuardFixture(root, resolvedRoot)
    Object.assign(fixture.directories.get(resolvedRoot), replacement)
    assert.throws(() => fixture.guard(root, root), /resolves through a link/)
    assert.equal(fixture.events.some(event => event.action === 'mkdir'), false)
  }
  for (const unsupported of ['\\\\.\\pipe\\activation', '\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\activation', '\\??\\C:\\activation']) {
    const fixture = windowsDirectoryGuardFixture(root, unsupported)
    assert.throws(() => fixture.guard(root, root), /resolves through a link/)
  }
})

test('Windows runtime guards reject ancestor junctions before creating a missing activation root', () => {
  const parent = 'C:\\Users\\RUNNER~1'
  const root = `${parent}\\activation`
  const fixture = windowsDirectoryGuardFixture(root, 'C:\\Users\\runneradmin\\activation')
  fixture.directories.delete(root)
  fixture.directories.get(parent).linked = true
  assert.throws(() => fixture.guard(root, path.win32.join(root, 'skills', 'autoprompt'), true), /unsafe ancestor/)
  assert.equal(fixture.events.some(event => event.action === 'mkdir'), false)

  const childFixture = windowsDirectoryGuardFixture(root, 'C:\\Users\\runneradmin\\activation')
  childFixture.directories.set(path.win32.join(root, 'skills'), { ...childFixture.identity, linked: true })
  assert.throws(() => childFixture.guard(root, path.win32.join(root, 'skills', 'autoprompt'), true), /linked or unsafe/)
  assert.equal(childFixture.events.some(event => event.action === 'mkdir'), false)

  const uncRoot = '\\\\?\\UNC\\server\\share\\linked\\activation'
  const uncFixture = windowsDirectoryGuardFixture(uncRoot, '\\\\?\\UNC\\server\\share\\real\\activation')
  const linkedAncestor = path.win32.dirname(uncRoot)
  uncFixture.directories.get(linkedAncestor).linked = true
  assert.throws(() => uncFixture.guard(uncRoot, uncRoot), /unsafe ancestor/)
  assert.ok(uncFixture.events.some(event => event.action === 'lstat' && event.file === linkedAncestor))
  assert.equal(uncFixture.events.some(event => event.file === '\\\\?\\UNC\\'), false)
})

test('runtime installation rejects real linked ancestors without changing the outside directory', t => {
  const sandbox = temporaryDirectory('autoprompt-runtime-ancestor-')
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }))
  const outside = path.join(sandbox, 'outside')
  const existing = path.join(outside, 'activation')
  fs.mkdirSync(existing, { recursive: true })
  fs.writeFileSync(path.join(existing, 'sentinel.txt'), 'untouched\n')
  const linked = path.join(sandbox, 'linked')
  fs.symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => installPayload('claude', path.join(linked, 'activation'), ROOT), /activation root resolves through a link/)
  assert.deepEqual(fs.readdirSync(outside), ['activation'])
  assert.deepEqual(fs.readdirSync(existing), ['sentinel.txt'])
  assert.equal(fs.readFileSync(path.join(existing, 'sentinel.txt'), 'utf8'), 'untouched\n')
  if (process.platform === 'win32') {
    assert.throws(() => installPayload('claude', path.join(linked, 'missing'), ROOT), /activation root resolves through a link/)
    assert.equal(fs.existsSync(path.join(outside, 'missing')), false)
  }
})

test('committed runtime manifests match every provider source file', () => {
  const completed = childProcess.spawnSync(
    process.execPath,
    ['scripts/runtime-payload.cjs', '--check'],
    { cwd: ROOT, encoding: 'utf8' },
  )

  assert.equal(completed.status, 0, completed.stderr)
  assert.match(completed.stdout, /runtime manifests are current/)
})

test('Codex manifest currentness rejects CRLF byte drift', t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-codex-manifest-bytes-'))
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }))
  fs.cpSync(path.join(ROOT, 'agents'), path.join(sandbox, 'agents'), { recursive: true })
  fs.cpSync(path.join(ROOT, 'assets'), path.join(sandbox, 'assets'), { recursive: true })
  fs.mkdirSync(path.join(sandbox, 'scripts', 'install'), { recursive: true })
  fs.copyFileSync(
    path.join(ROOT, 'scripts', 'local-only-safety.cjs'),
    path.join(sandbox, 'scripts', 'local-only-safety.cjs'),
  )
  fs.copyFileSync(
    path.join(ROOT, 'scripts', 'install', 'codex-package-registry.json'),
    path.join(sandbox, 'scripts', 'install', 'codex-package-registry.json'),
  )
  fs.copyFileSync(
    path.join(ROOT, 'scripts', 'install', 'legacy-codex-compat.json'),
    path.join(sandbox, 'scripts', 'install', 'legacy-codex-compat.json'),
  )
  const manifestPath = path.join(sandbox, 'agents', 'manifests', 'codex-runtime.json')
  const canonical = fs.readFileSync(path.join(ROOT, 'agents', 'manifests', 'codex-runtime.json'), 'utf8')
  fs.writeFileSync(manifestPath, canonical.replace(/\n/g, '\r\n'))
  const stdout = []
  const stderr = []
  const status = runRuntimePayload(['--check', 'codex'], sandbox, {
    stdout: { write: value => stdout.push(value) },
    stderr: { write: value => stderr.push(value) },
  })
  assert.equal(status, 1)
  assert.equal(stdout.join(''), '')
  assert.match(stderr.join(''), /stale manifests: agents\/manifests\/codex-runtime\.json/)
})

test('all nine public provider payloads contain the complete product', () => {
  const contract = require('../../agents/contracts/autoprompt.contract.json')
  const personaCount = contract.personas.length
  const frameworkCount = contract.frameworks.length

  const manifests = renderManifests(ROOT)
  for (const provider of [
    'claude', 'codex', 'opencode', 'kilo', 'vscode', 'omp', 'deepseek', 'reasonix',
  ]) {
    const manifest = manifests.get(`agents/manifests/${provider}-runtime.json`)
    assert.ok(manifest.files.includes('GATES.md'))
    assert.ok(manifest.files.includes('MODES.md'))
    assert.ok(manifest.files.includes('PLAYBOOKS.md'))
    assert.ok(manifest.files.includes('VERSION'))
    assert.equal(manifest.files.filter(file => file.startsWith('frameworks/')).length, frameworkCount)
  }

  const claude = manifests.get('agents/manifests/claude-runtime.json')
  const codex = manifests.get('agents/manifests/codex-runtime.json')
  const opencode = manifests.get('agents/manifests/opencode-runtime.json')
  const kilo = manifests.get('agents/manifests/kilo-runtime.json')
  const vscode = manifests.get('agents/manifests/vscode-runtime.json')
  const prime = manifests.get('agents/manifests/prime-runtime.json')
  const omp = manifests.get('agents/manifests/omp-runtime.json')
  const deepseek = manifests.get('agents/manifests/deepseek-runtime.json')
  const reasonix = manifests.get('agents/manifests/reasonix-runtime.json')
  assert.equal(claude.files.filter(file => /^agents\/ap-.*\.md$/.test(file)).length, personaCount)
  const rolePolicy = require('../../agents/codex/agents/role-policy.json')
  const logicalRoles = Object.keys(rolePolicy.physical_roles).sort()
  assert.equal(codex.files.filter(file => /^agents\/ap-.*\.toml$/.test(file)).length,
    logicalRoles.length)
  assert.deepEqual(codex.logicalRoles, logicalRoles)
  assert.deepEqual(Object.keys(codex.logicalToPhysicalProviderRole), logicalRoles)
  assert.deepEqual(
    codex.physicalRoles,
    Object.values(codex.logicalToPhysicalProviderRole).sort(),
  )
  for (const logicalRole of logicalRoles) {
    const physicalRole = codex.logicalToPhysicalProviderRole[logicalRole]
    assert.equal(
      physicalRole,
      `autoprompt-${codex.payloadGeneration.replace(/[^a-z0-9]+/g, '-')}-${logicalRole}`,
    )
    assert.notEqual(physicalRole, logicalRole)
  }
  assert.equal(codex.contractVersion, '2.0.0')
  assert.equal(codex.rolePolicy, 'agents/role-policy.json')
  assert.equal(codex.localRequireClosure, 'complete-declared-local-external-and-dynamic-requires')
  assert.equal(
    codex.payloadGeneration,
    `codex-v${codex.contractVersion}-${codex.payloadDigest.slice(0, 16)}`,
  )
  assert.equal(codex.payloadDigest, codexPayloadDigest(codex))
  assert.equal(codex.embeddedReceipt, CODEX_EMBEDDED_MANIFEST)
  for (const relativePath of codex.files) {
    const source = path.join(ROOT, 'agents', 'codex', ...relativePath.split('/'))
    const exactHash = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex')
    assert.equal(exactHash, codex.sha256[relativePath], `raw Codex byte drift: ${relativePath}`)
  }
  assert.deepEqual(
    codex.externalDependencies.map(dependency => dependency.source),
    CODEX_EXTERNAL_RUNTIME_DEPENDENCIES.map(dependency => dependency.source),
  )
  assert.deepEqual(codex.dynamicRequires, CODEX_RUNTIME_DYNAMIC_REQUIRES)
  assert.equal(opencode.files.filter(file => /^agents\/ap-.*\.md$/.test(file)).length, personaCount)
  assert.equal(kilo.files.filter(file => /^agents\/ap-.*\.md$/.test(file)).length, personaCount)
  assert.equal(vscode.files.filter(file => /^agents\/ap-.*\.agent\.md$/.test(file)).length, personaCount)
  assert.equal(prime.files.filter(file => /^personas\/ap-.*\.md$/.test(file)).length, personaCount)
  assert.equal(prime.files.filter(file => /^prompts\/frameworks\/.*\.md$/.test(file)).length, frameworkCount)
  assert.equal(omp.files.filter(file => /^agents\/ap-.*\.md$/.test(file)).length, personaCount)
  assert.equal(deepseek.files.filter(file => /^agents\/ap-.*\.md$/.test(file)).length, personaCount)
  assert.equal(reasonix.files.filter(file => /^skills\/ap-.*\/SKILL\.md$/.test(file)).length, personaCount)
  assert.ok(claude.files.includes('workflow/autoprompt-gate.js'))
  assert.ok(codex.files.includes('SKILL.md'))
  assert.ok(codex.files.includes('agents/role-policy.json'))
  assert.ok(codex.files.includes('agents/role-policy.schema.json'))
  assert.ok(codex.files.includes('workflow/codex-agent-casting.js'))
  const runtimeWorkflow = fs.readdirSync(path.join(ROOT, 'agents', 'codex', 'workflow'))
    .filter(file => ['.js', '.ps1', '.sh'].includes(path.extname(file)))
    .map(file => `workflow/${file}`)
    .sort()
  assert.deepEqual(codex.files.filter(file => file.startsWith('workflow/')), runtimeWorkflow)
  assert.ok(opencode.files.includes('autoprompt.opencode.json'))
  assert.ok(opencode.files.includes('workflow/launch-opencode.ps1'))
  assert.ok(opencode.files.includes('workflow/launch-opencode.sh'))
  assert.ok(kilo.files.includes('autoprompt.kilo.json'))
  assert.ok(vscode.files.includes('SKILL.md'))
  assert.ok(vscode.files.includes('README.md'))
  assert.ok(prime.files.includes('package.json'))
  assert.ok(prime.files.includes('extensions/autoprompt.ts'))
  assert.ok(prime.files.includes('skills/autoprompt/SKILL.md'))
  assert.ok(prime.files.includes('skills/autoprompt/pyproject.toml'))
  assert.ok(prime.files.includes('skills/autoprompt/src/autoprompt/__init__.py'))
  assert.ok(omp.files.includes('README.md'))
  assert.ok(deepseek.files.includes('agent-preset/agent.cordis.yml'))
  assert.ok(deepseek.files.includes('agent-preset/preset.yml'))
  assert.ok(reasonix.files.includes('README.md'))
  assert.equal(prime.files.length, 48)
})

test('Codex runtime inventory proves the local require closure and declares cross-root inputs', () => {
  const files = codexRuntimeFiles(ROOT)
  const dependencies = discoverCodexExternalRuntimeDependencies(ROOT)
  assert.equal(dependencies.length, 28)
  for (const requiredSource of [
    'agents/contracts/gates.json',
    'agents/contracts/plain-language.json',
    'agents/contracts/providers.json',
    'agents/contracts/roles.json',
    'agents/contracts/routes.json',
    'agents/contracts/state-machine.json',
    'agents/contracts/schemas/accounting-record.schema.json',
    'agents/contracts/schemas/accounting-snapshot.schema.json',
    'agents/contracts/schemas/outcome.schema.json',
    'agents/contracts/schemas/providers.schema.json',
    'agents/contracts/schemas/recovery-checkpoint-record.schema.json',
    'agents/contracts/schemas/recovery-checkpoint-snapshot.schema.json',
    'agents/contracts/schemas/request-envelope-entry.schema.json',
    'agents/contracts/schemas/settings.schema.json',
    'agents/contracts/schemas/state-event.schema.json',
  ]) assert.ok(dependencies.some(dependency => dependency.source === requiredSource), requiredSource)
  assert.ok(dependencies
    .filter(dependency => dependency.source.startsWith('agents/contracts/'))
    .every(dependency => dependency.destination === dependency.source.replace(/^agents\//, 'skills/')))
  assert.equal(validateDeclaredRuntimeRequires(files, ROOT), true)
  assert.throws(
    () => validateDeclaredRuntimeRequires(files.filter(file => file !== 'workflow/settings.js'), ROOT),
    /undeclared Codex runtime require: workflow\/phase-budget\.js -> workflow\/settings\.js/,
  )
  assert.throws(
    () => validateDeclaredRuntimeRequires(files, ROOT, []),
    /(?:undeclared external Codex runtime dependency|dynamic Codex runtime require lacks external dependency)/,
  )
  assert.throws(
    () => validateDeclaredRuntimeRequires(
      files,
      ROOT,
      dependencies.filter(dependency => dependency.source !== 'agents/contracts/gates.json'),
    ),
    /undeclared external Codex runtime dependency: agents\/contracts\/gates\.json/,
  )
  assert.throws(
    () => validateDeclaredRuntimeRequires(files, ROOT, CODEX_EXTERNAL_RUNTIME_DEPENDENCIES, []),
    /undeclared dynamic Codex runtime require: workflow\/phase-budget\.js -> safetyPath/,
  )
})

test('Codex source-tree closure rejects an unexpected provider file outside explicit exclusions', t => {
  const sandbox = temporaryDirectory('autoprompt-codex-source-closure-')
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }))
  fs.mkdirSync(path.join(sandbox, 'agents'), { recursive: true })
  fs.cpSync(path.join(ROOT, 'agents', 'codex'), path.join(sandbox, 'agents', 'codex'), {
    recursive: true,
  })
  const files = codexRuntimeFiles(ROOT)
  assert.equal(assertCodexSourceClosure(sandbox, files), true)
  fs.writeFileSync(path.join(sandbox, 'agents', 'codex', 'unexpected-runtime.txt'), 'not declared\n')
  assert.throws(
    () => assertCodexSourceClosure(sandbox, files),
    /Codex source closure mismatch: unexpected=unexpected-runtime\.txt/,
  )
})

test('Codex install capability registry admits standalone and fails closed on unknown modes', () => {
  const invoke = argv => {
    let stdout = ''
    let stderr = ''
    const status = runRuntimePayload(argv, ROOT, {
      stdout: { write(value) { stdout += value } },
      stderr: { write(value) { stderr += value } },
    })
    return { status, stderr, stdout }
  }
  assert.deepEqual(invoke(['--capability', 'codex', '--mode', 'standalone']), {
    status: 0,
    stderr: '',
    stdout: 'provider=codex mode=standalone capability=supported\n',
  })
  const unsupported = invoke(['--capability', 'codex', '--mode', 'ambient'])
  assert.equal(unsupported.status, 1)
  assert.match(unsupported.stderr, /unsupported Codex install mode: ambient/)
  const unknown = invoke(['--capability', 'future-codex', '--mode', 'standalone'])
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /unsupported capability provider: future-codex/)
})

test('Codex contract dependency discovery rejects reference traversal', t => {
  const sandbox = temporaryDirectory('autoprompt-contract-closure-')
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }))
  fs.mkdirSync(path.join(sandbox, 'agents', 'codex'), { recursive: true })
  fs.mkdirSync(path.join(sandbox, 'scripts'), { recursive: true })
  fs.cpSync(path.join(ROOT, 'agents', 'codex', 'workflow'), path.join(sandbox, 'agents', 'codex', 'workflow'), { recursive: true })
  fs.cpSync(path.join(ROOT, 'agents', 'contracts'), path.join(sandbox, 'agents', 'contracts'), { recursive: true })
  fs.copyFileSync(path.join(ROOT, 'scripts', 'local-only-safety.cjs'), path.join(sandbox, 'scripts', 'local-only-safety.cjs'))
  const routesPath = path.join(sandbox, 'agents', 'contracts', 'routes.json')
  const routes = JSON.parse(fs.readFileSync(routesPath, 'utf8'))
  routes.unsafeReference = './../../outside.json'
  fs.writeFileSync(routesPath, `${JSON.stringify(routes, null, 2)}\n`)
  assert.throws(
    () => discoverCodexExternalRuntimeDependencies(sandbox),
    /contract reference escapes agents\/contracts/,
  )
})

test('each provider installs and verifies as a complete isolated payload', () => {
  for (const provider of [
    'claude', 'codex', 'opencode', 'kilo', 'vscode', 'prime', 'omp', 'deepseek', 'reasonix',
  ]) {
    const sandbox = temporaryDirectory(`autoprompt-${provider}-`)
    const destination = provider === 'codex'
      ? path.join(sandbox, 'skills', 'autoprompt')
      : sandbox
    try {
      const installed = installPayload(provider, destination, ROOT)
      const manifest = loadManifest(provider, ROOT)
      const plan = installationPlan(provider, destination, ROOT)
      assert.deepEqual(installed, plan.files.map(item => item.target))
      assert.deepEqual(verifyPayload(provider, destination, ROOT), {
        files: plan.files.length,
        provider,
      })
      if (provider === 'codex') {
        assert.equal(plan.files.filter(item => item.kind === 'external-runtime').length, CODEX_EXTERNAL_RUNTIME_DEPENDENCIES.length)
        assert.deepEqual(
          plan.files.filter(item => item.kind === 'external-runtime')
            .map(item => path.relative(plan.bundleRoot, item.target).split(path.sep).join('/'))
            .sort(),
          CODEX_EXTERNAL_RUNTIME_DEPENDENCIES.map(dependency => dependency.destination).sort(),
        )
        assert.equal(plan.discoverySkillRoot, destination)
        assert.equal(plan.files.filter(item => item.kind === 'discovery-shim').length, 1)
        assert.deepEqual(fs.readdirSync(destination), ['SKILL.md'])
        const shim = fs.readFileSync(path.join(destination, 'SKILL.md'), 'utf8')
        assert.match(shim, /^---\nname: autoprompt\ndescription: [^\n]+\nactivation: explicit-only\nallow-implicit-invocation: false\n---\n/u)
        assert.match(shim, /autoprompt activate codex \.\.\. -- <mission>/u)
        assert.equal(plan.files.filter(item => item.kind === 'runtime-manifest').length, 1)
        assert.equal(
          plan.payloadGeneration,
          `codex-v${manifest.contractVersion}-${manifest.payloadDigest.slice(0, 16)}`,
        )
        assert.equal(plan.payloadDigest, manifest.payloadDigest)
      } else {
        assert.equal(plan.files.length, manifest.files.length)
      }

      if (provider !== 'codex') {
        fs.mkdirSync(path.join(destination, 'obsolete'), { recursive: true })
        fs.writeFileSync(path.join(destination, 'obsolete', 'stale.txt'), 'stale\n')
        assert.deepEqual(prunePayload(provider, destination, ROOT), [])
        assert.equal(fs.existsSync(path.join(destination, 'obsolete', 'stale.txt')), true)
      }
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true })
    }
  }
})

test('runtime verification rejects tampered installed source', () => {
  const sandbox = temporaryDirectory('autoprompt-tamper-')
  const destination = path.join(sandbox, 'skills', 'autoprompt')
  try {
    installPayload('codex', destination, ROOT)
    const plan = installationPlan('codex', destination, ROOT)
    fs.writeFileSync(path.join(plan.skillRoot, 'unexpected.txt'), 'unexpected\n')
    assert.throws(
      () => verifyPayload('codex', destination, ROOT),
      /unexpected immutable Codex bundle file: skills\/autoprompt\/unexpected\.txt/,
    )
    fs.unlinkSync(path.join(plan.skillRoot, 'unexpected.txt'))
    fs.appendFileSync(path.join(plan.skillRoot, 'GATES.md'), '\ntampered\n')
    assert.throws(
      () => verifyPayload('codex', destination, ROOT),
      /installed hash mismatch: .*skills\/autoprompt\/GATES\.md/,
    )
    assert.throws(
      () => installPayload('codex', destination, ROOT),
      /immutable Codex bundle drift: .*skills\/autoprompt\/GATES\.md/,
    )
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('Codex external runtime files are contained, hash-bound, receipt-visible, and uninstall-safe', () => {
  const sandbox = temporaryDirectory('autoprompt-codex-external-')
  const destination = path.join(sandbox, 'skills', 'autoprompt')
  try {
    assert.throws(
      () => installationPlan('codex', path.join(sandbox, 'arbitrary'), ROOT),
      /must be <codex-root>\/skills\/autoprompt/,
    )
    installPayload('codex', destination, ROOT)
    const planned = childProcess.spawnSync(process.execPath, [
      'scripts/runtime-payload.cjs', '--plan', 'codex', '--destination', destination,
    ], { cwd: ROOT, encoding: 'utf8' })
    assert.equal(planned.status, 0, planned.stderr)
    const planReceipt = JSON.parse(planned.stdout)
    assert.equal(planReceipt.schemaVersion, 1)
    assert.equal(planReceipt.provider, 'codex')
    assert.deepEqual(
      planReceipt.files.filter(item => item.kind === 'external-runtime')
        .map(item => path.relative(planReceipt.bundleRoot, item.target).split(path.sep).join('/'))
        .sort(),
      CODEX_EXTERNAL_RUNTIME_DEPENDENCIES.map(dependency => dependency.destination).sort(),
    )
    const rolesTarget = path.join(planReceipt.bundleRoot, 'skills', 'contracts', 'roles.json')
    const routesTarget = path.join(planReceipt.bundleRoot, 'skills', 'contracts', 'routes.json')
    const stateTarget = path.join(planReceipt.bundleRoot, 'skills', 'contracts', 'state-machine.json')
    const stateEventSchemaTarget = path.join(planReceipt.bundleRoot, 'skills', 'contracts', 'schemas', 'state-event.schema.json')
    const safetyTarget = path.join(planReceipt.bundleRoot, 'scripts', 'local-only-safety.cjs')
    const embeddedManifest = path.join(planReceipt.skillRoot, CODEX_EMBEDDED_MANIFEST)
    for (const target of [rolesTarget, routesTarget, stateTarget, stateEventSchemaTarget, safetyTarget, embeddedManifest]) {
      assert.equal(fs.lstatSync(target).isFile(), true, target)
      assert.equal(fs.lstatSync(target).isSymbolicLink(), false, target)
    }

    fs.appendFileSync(rolesTarget, '\ndrift\n')
    assert.throws(() => verifyPayload('codex', destination, ROOT), /installed hash mismatch: .*skills\/contracts\/roles\.json/)
    const result = uninstallPayload('codex', destination, ROOT)
    const rolesReceipt = planReceipt.files.find(item => item.target === rolesTarget).receiptPath
    assert.deepEqual(result.retained, [{ path: rolesReceipt, reason: 'hash-drift' }])
    for (const target of [safetyTarget, routesTarget, stateTarget, stateEventSchemaTarget]) {
      assert.equal(result.removed.includes(planReceipt.files.find(item => item.target === target).receiptPath), true)
    }
    assert.equal(fs.existsSync(rolesTarget), true)
    assert.equal(fs.existsSync(routesTarget), false)
    assert.equal(fs.existsSync(stateTarget), false)
    assert.equal(fs.existsSync(stateEventSchemaTarget), false)
    assert.equal(fs.existsSync(safetyTarget), false)
    assert.equal(fs.existsSync(embeddedManifest), false)
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('Codex installation rejects linked external destinations', () => {
  const sandbox = temporaryDirectory('autoprompt-codex-linked-')
  const destination = path.join(sandbox, 'skills', 'autoprompt')
  try {
    const plan = installationPlan('codex', destination, ROOT)
    const safety = plan.files.find(item => item.kind === 'external-runtime' && item.source.endsWith('local-only-safety.cjs'))
    const scriptsDirectory = path.dirname(safety.target)
    const decoy = path.join(sandbox, 'decoy.cjs')
    fs.writeFileSync(decoy, 'decoy\n')
    fs.mkdirSync(scriptsDirectory, { recursive: true })
    fs.linkSync(decoy, safety.target)
    assert.throws(
      () => installPayload('codex', destination, ROOT),
      /runtime target is linked or not a regular file: .*scripts\/local-only-safety\.cjs/,
    )
    assert.equal(fs.readFileSync(decoy, 'utf8'), 'decoy\n')
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('packed npm payload installs the complete Codex activation dependency closure', t => {
  const sandbox = temporaryDirectory('autoprompt-packed-runtime-')
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }))
  const packageDirectory = path.join(sandbox, 'packed')
  const extractedDirectory = path.join(sandbox, 'extracted')
  fs.mkdirSync(packageDirectory)
  fs.mkdirSync(extractedDirectory)
  const environment = {
    ...process.env,
    HOME: path.join(sandbox, 'home'),
    USERPROFILE: path.join(sandbox, 'home'),
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
  }
  fs.mkdirSync(environment.HOME)
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === 'npm_config_dry_run') delete environment[key]
  }
  const packed = childProcess.spawnSync(process.execPath, [
    npmCliPath(), 'pack', '--ignore-scripts', '--json', '--pack-destination', packageDirectory,
  ], { cwd: ROOT, encoding: 'utf8', env: environment })
  assert.equal(packed.status, 0, packed.stderr)
  const [{ filename }] = JSON.parse(packed.stdout)
  const extracted = childProcess.spawnSync('tar', [
    '-xf', path.join(packageDirectory, filename), '-C', extractedDirectory,
  ], { encoding: 'utf8' })
  assert.equal(extracted.status, 0, extracted.stderr)

  const packageRoot = path.join(extractedDirectory, 'package')
  const packedRuntime = require(path.join(packageRoot, 'scripts', 'runtime-payload.cjs'))
  const activationRoot = path.join(sandbox, 'activation-private')
  const destination = path.join(activationRoot, 'skills', 'autoprompt')
  const installed = packedRuntime.installPayload('codex', destination, packageRoot)
  const packedPlan = packedRuntime.installationPlan('codex', destination, packageRoot)
  const expectedCount = packedPlan.files.length
  assert.equal(installed.length, expectedCount)
  assert.deepEqual(packedRuntime.verifyPayload('codex', destination, packageRoot), {
    files: expectedCount,
    provider: 'codex',
  })
  assert.equal(
    packedPlan.payloadGeneration,
    `codex-v${packedRuntime.loadManifest('codex', packageRoot).contractVersion}-${packedPlan.payloadDigest.slice(0, 16)}`,
  )
  assert.equal(packedPlan.payloadDigest, packedRuntime.loadManifest('codex', packageRoot).payloadDigest)
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(packedPlan.skillRoot, packedRuntime.CODEX_EMBEDDED_MANIFEST), 'utf8')),
    packedRuntime.loadManifest('codex', packageRoot),
  )

  const phase = require(path.join(packedPlan.skillRoot, 'workflow', 'phase-budget.js'))
  assert.equal(new phase.RolePolicy().contract.kind, 'autoprompt-role-contract')
  assert.equal(typeof phase.safeEnvironmentFactory(), 'function')
  assert.equal(require(path.join(packedPlan.skillRoot, 'workflow', 'router.js')).ROUTES.length, 3)
  const installedRoles = require(path.join(packedPlan.bundleRoot, 'skills', 'contracts', 'roles.json'))
  const installedPolicy = require(path.join(packedPlan.skillRoot, 'agents', 'role-policy.json'))
  assert.deepEqual(Object.keys(installedPolicy.physical_roles).sort(), packedRuntime.loadManifest('codex', packageRoot).logicalRoles)
  assert.deepEqual(
    Object.entries(installedPolicy.physical_roles)
      .filter(([, role]) => !role.compatibility_alias.enabled)
      .map(([id]) => id)
      .sort(),
    installedRoles.codexPhysicalRoleProjection.map(role => role.physicalId).sort(),
  )
  for (const legacyId of installedRoles.compatibilityAliasPolicy.legacyPhysicalIds) {
    const alias = installedPolicy.physical_roles[legacyId]
    assert.equal(alias.activation_allowed, false, legacyId)
    assert.equal(alias.telemetry_required, true, legacyId)
    assert.equal(alias.sandbox_mode, 'read-only', legacyId)
    assert.equal(alias.can_dispatch, false, legacyId)
    assert.deepEqual(alias.allowed_children, [], legacyId)
    assert.deepEqual(alias.resource_sets.write, [], legacyId)
  }
  assert.equal(fs.existsSync(path.join(packedPlan.skillRoot, 'agents', 'ap-work-group-manager.toml')), true)
  assert.equal(installedRoles.aliasTelemetrySchema.appendPath, 'compatibility/alias-telemetry.jsonl')
  assert.equal(installedRoles.aliasTelemetrySchema.enforcer, 'deterministic-control-plane')
  const installedRunRecord = require(path.join(packedPlan.skillRoot, 'workflow', 'run-record.js'))
  assert.equal(installedRunRecord.RUNTIME_PATHS.aliasTelemetry, installedRoles.aliasTelemetrySchema.appendPath)
  assert.equal(typeof installedRunRecord.appendAliasTelemetry, 'function')
  assert.equal(typeof installedRunRecord.readAliasTelemetry, 'function')
  const uninstall = packedRuntime.uninstallPayload('codex', destination, packageRoot)
  assert.equal(uninstall.retained.length, 0)
  assert.equal(uninstall.removed.length, expectedCount)
  assert.equal(fs.existsSync(path.join(packedPlan.bundleRoot, 'scripts', 'local-only-safety.cjs')), false)
})
