#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const PACKAGE_PATH = path.join(ROOT, 'package.json')
const PROVIDERS = ['claude', 'codex', 'opencode', 'kilo', 'vscode', 'prime']

function filesBelow(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name)
    return entry.isDirectory() ? filesBelow(target) : [target]
  })
}

function readmeReferenceClosure() {
  const queued = ['README.md']
  const visited = new Set()
  const references = new Map()

  while (queued.length > 0) {
    const source = queued.shift()
    if (visited.has(source)) continue
    visited.add(source)

    const sourcePath = path.join(ROOT, ...source.split('/'))
    if (!fs.existsSync(sourcePath)) continue
    const markdown = fs.readFileSync(sourcePath, 'utf8')
    const rawTargets = [
      ...[...markdown.matchAll(/\]\(([^)\s]+)\)/g)].map(match => match[1]),
      ...[...markdown.matchAll(/\b(?:href|src)=["']([^"']+)["']/g)].map(match => match[1]),
    ]

    for (let rawTarget of rawTargets) {
      rawTarget = rawTarget.replace(/^<|>$/g, '')
      if (
        rawTarget.startsWith('#') ||
        rawTarget.startsWith('//') ||
        /^[a-z][a-z\d+.-]*:/i.test(rawTarget)
      ) continue

      let decoded
      try {
        decoded = decodeURIComponent(rawTarget.split(/[?#]/, 1)[0])
      } catch {
        decoded = rawTarget.split(/[?#]/, 1)[0]
      }
      const directory = decoded.endsWith('/')
      const target = path.posix.normalize(path.posix.join(
        path.posix.dirname(source),
        decoded.replaceAll('\\', '/'),
      ))
      assert.equal(
        target === '..' || target.startsWith('../') || path.posix.isAbsolute(target),
        false,
        `${source}: local README reference escapes the package: ${rawTarget}`,
      )

      const key = `${directory ? 'directory' : 'file'}:${target}`
      if (!references.has(key)) references.set(key, { directory, from: source, target })
      if (!directory && target.endsWith('.md') && !visited.has(target)) queued.push(target)
    }
  }

  return [...references.values()]
}

function npmCliPath() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean)
  const npmCli = candidates.find(candidate => fs.existsSync(candidate))
  assert.ok(npmCli, `could not locate npm CLI; checked ${candidates.join(', ')}`)
  return npmCli
}

function runNpm(args, options = {}) {
  const env = { ...(options.env ?? process.env) }
  // npm exposes an outer dry-run to prepack through this environment key.
  // Nested pack and install commands must remain real so their output is verified.
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'npm_config_dry_run') {
      delete env[key]
    }
  }

  return childProcess.spawnSync(process.execPath, [npmCliPath(), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    ...options,
    env,
  })
}

function packageFilesOnDisk() {
  const explicit = [
    path.join(ROOT, 'package.json'),
    path.join(ROOT, 'README.md'),
    path.join(ROOT, 'LICENSE'),
    ...filesBelow(path.join(ROOT, 'bin')),
    path.join(ROOT, 'scripts', 'codex-configure.cjs'),
    path.join(ROOT, 'scripts', 'runtime-payload.cjs'),
    ...filesBelow(path.join(ROOT, 'scripts', 'install')),
    ...PROVIDERS.map(provider => path.join(ROOT, 'agents', 'manifests', `${provider}-runtime.json`)),
    ...PROVIDERS.flatMap(provider => filesBelow(path.join(ROOT, 'agents', provider))),
    ...readmeReferenceClosure()
      .filter(reference => !reference.directory)
      .map(reference => path.join(ROOT, ...reference.target.split('/'))),
  ]
  return [...new Set(explicit.map(file => path.relative(ROOT, file).split(path.sep).join('/')))].sort()
}

function isolatedEnvironment(root) {
  const home = path.join(root, 'home')
  const cache = path.join(root, 'npm-cache')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(cache, { recursive: true })
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    npm_config_audit: 'false',
    npm_config_cache: cache,
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
  }
}

function dryRunPackResult() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt npm dry run '))
  try {
    const completed = runNpm(['pack', '--dry-run', '--json', '--ignore-scripts'], {
      env: isolatedEnvironment(temporaryRoot),
    })
    assert.equal(completed.status, 0, completed.stderr)
    const [result] = JSON.parse(completed.stdout)
    return result
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
}

test('package metadata is public-ready under the exact available name and remains dependency-free', () => {
  const packageJson = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'))
  assert.equal(packageJson.name, 'autoprompt-skill')
  assert.equal(packageJson.version, '1.0.2')
  assert.equal(
    packageJson.description,
    'Autoprompt is a coding-agent skill that cuts failures by 45% on agentic coding tasks.',
  )
  assert.equal(packageJson.private, undefined)
  assert.deepEqual(packageJson.publishConfig, {
    access: 'public',
    registry: 'https://registry.npmjs.org/',
  })
  assert.deepEqual(packageJson.engines, { node: '>=20.0.0' })
  assert.deepEqual(packageJson.bin, {
    autoprompt: 'bin/autoprompt.cjs',
    'autoprompt-skill': 'bin/autoprompt.cjs',
  })
  assert.equal(packageJson.dependencies, undefined)
  assert.equal(packageJson.devDependencies, undefined)
  assert.equal(packageJson.optionalDependencies, undefined)
  assert.equal(packageJson.peerDependencies, undefined)
  for (const forbidden of ['install', 'postinstall', 'preinstall', 'prepare']) {
    assert.equal(packageJson.scripts[forbidden], undefined, forbidden)
  }
  assert.match(packageJson.scripts['test:providers'], /generate-provider-contracts\.cjs --check/)
  assert.match(packageJson.scripts['test:providers'], /runtime-payload\.cjs --check/)
  for (const suite of [
    'provider-generation',
    'runtime-payload',
    'vscode-custom-agent-fixture',
    'provider-compatibility-registry',
    'codex-current-parity',
    'prime-provider',
  ]) {
    assert.match(packageJson.scripts['test:providers'], new RegExp(`${suite}\\.test\\.cjs`), suite)
  }
  for (const suite of [
    'claude-lifecycle',
    'kilo-provider',
    'opencode-lifecycle',
    'vscode-lifecycle',
    'install-custom-root',
    'prime-lifecycle',
  ]) {
    assert.match(packageJson.scripts['test:lifecycle'], new RegExp(`${suite}\\.test\\.cjs`), suite)
  }
  assert.match(packageJson.scripts['test:lifecycle'], /^node --test --test-concurrency=1\b/)
  assert.match(packageJson.scripts.test, /npm run test:cli/)
  assert.match(packageJson.scripts.test, /npm run test:providers/)
  assert.doesNotMatch(packageJson.scripts.test, /npm run test:lifecycle/)
  assert.match(packageJson.scripts.prepack, /npm test/)
  assert.doesNotMatch(packageJson.scripts.prepack, /npm run test:lifecycle/)
  assert.match(packageJson.scripts.verify, /npm test/)
  assert.match(packageJson.scripts.verify, /npm run test:lifecycle/)
  assert.equal(packageJson.scripts.prepublishOnly, 'npm run verify')
  assert.deepEqual(packageJson.files, [
    'bin/',
    'scripts/codex-configure.cjs',
    'scripts/install/',
    'scripts/runtime-payload.cjs',
    'agents/claude/',
    'agents/codex/',
    'agents/opencode/',
    'agents/kilo/',
    'agents/vscode/',
    'agents/prime/',
    'agents/manifests/claude-runtime.json',
    'agents/manifests/codex-runtime.json',
    'agents/manifests/opencode-runtime.json',
    'agents/manifests/kilo-runtime.json',
    'agents/manifests/vscode-runtime.json',
    'agents/manifests/prime-runtime.json',
    'assets/anatomy.svg',
    'assets/banner.svg',
    'assets/how-it-works-hierarchy.svg',
    'assets/how-it-works-loop.svg',
    'assets/terminal-bench-2.1.svg',
    'assets/terminal-bench-2.1-leaderboard.svg',
    'docs/CODE_OF_CONDUCT.md',
    'docs/CONTRIBUTING.md',
    'docs/SECURITY.md',
    'docs/SUPPORT.md',
    'docs/benchmarks/terminal-bench-2.1.md',
    'docs/faq/does-autoprompt-mean-i-do-not-have-to-prompt.md',
    'docs/faq/how-autonomous-is-autoprompt.md',
    'docs/faq/how-to-add-custom-models.md',
    'docs/faq/tokensaver-vs-wide-vs-custom.md',
    'docs/faq/what-are-the-layers-for.md',
    'docs/faq/which-coding-agents-are-supported.md',
    'docs/guides/9router-multi-provider-setup.md',
    'docs/guides/9router-routing.png',
    'docs/guides/custom-agent-compatibility.md',
  ])
  assert.equal(fs.existsSync(path.join(ROOT, 'package-lock.json')), false)
  assert.equal(fs.existsSync(path.join(ROOT, '.npmignore')), false)
})

test('npm dry-run inventory is an exact allowlist and excludes repository-only material', () => {
  const result = dryRunPackResult()
  assert.equal(result.name, 'autoprompt-skill')
  assert.equal(result.version, '1.0.2')
  const actual = result.files.map(file => file.path).sort()
  assert.deepEqual(actual, packageFilesOnDisk())
  assert.ok(result.size > 0)
  assert.ok(result.unpackedSize > result.size)

  const forbiddenPrefixes = [
    '.git',
    '.github/',
    'coverage/',
    'node_modules/',
    'tests/',
    'agents/contracts/frameworks/',
    'agents/contracts/personas/',
    'agents/other/',
    'agents/vibe/',
    'agents/manifests/vibe-runtime.json',
    'scripts/generate-provider-contracts.cjs',
  ]
  for (const file of actual) {
    assert.equal(
      forbiddenPrefixes.some(prefix => file === prefix || file.startsWith(prefix)),
      false,
      file,
    )
  }
})

test('every local file and directory linked from npm README docs is packed', () => {
  const result = dryRunPackResult()
  const packed = result.files.map(file => file.path)
  const references = readmeReferenceClosure()

  const missingOnDisk = references
    .filter(reference => !fs.existsSync(path.join(ROOT, ...reference.target.split('/'))))
    .map(reference => `${reference.from} -> ${reference.target}`)
  assert.deepEqual(missingOnDisk, [], 'README docs contain missing local references')

  const missingFromTarball = references
    .filter(reference => reference.directory
      ? !packed.some(file => file.startsWith(`${reference.target.replace(/\/$/, '')}/`))
      : !packed.includes(reference.target))
    .map(reference => `${reference.from} -> ${reference.target}`)
  assert.deepEqual(missingFromTarball, [], 'README docs contain unpacked local references')
})

test('every npm-packaged POSIX shell script has an LF shebang and no carriage returns', () => {
  const result = dryRunPackResult()
  const shellScripts = result.files
    .map(file => file.path)
    .filter(file => file.endsWith('.sh'))
    .sort()

  assert.ok(shellScripts.length > 0, 'npm package must contain POSIX shell scripts')
  for (const relativePath of shellScripts) {
    const bytes = fs.readFileSync(path.join(ROOT, ...relativePath.split('/')))
    const firstLineEnd = bytes.indexOf(0x0a)
    assert.ok(firstLineEnd > 2, `${relativePath}: missing LF-terminated shebang`)
    assert.equal(
      bytes.subarray(0, firstLineEnd).toString('utf8').startsWith('#!'),
      true,
      `${relativePath}: first line is not a shebang`,
    )
    assert.equal(bytes.includes(0x0d), false, `${relativePath}: contains CR bytes`)
  }
})

test('packed tarball installs into an isolated temporary global prefix and its shim runs', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt npm package '))
  const packDirectory = path.join(temporaryRoot, 'tarball output')
  const prefix = path.join(temporaryRoot, 'global prefix')
  const env = isolatedEnvironment(temporaryRoot)
  fs.mkdirSync(packDirectory, { recursive: true })
  fs.mkdirSync(prefix, { recursive: true })

  try {
    const packed = runNpm([
      'pack',
      '--json',
      '--ignore-scripts',
      '--pack-destination',
      packDirectory,
    ], { env })
    assert.equal(packed.status, 0, packed.stderr)
    const [packResult] = JSON.parse(packed.stdout)
    const tarball = path.join(packDirectory, packResult.filename)
    assert.equal(fs.existsSync(tarball), true)

    const installed = runNpm([
      'install',
      '--global',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--prefix',
      prefix,
      tarball,
    ], { env })
    assert.equal(installed.status, 0, installed.stderr)

    for (const command of ['autoprompt', 'autoprompt-skill']) {
      const shim = process.platform === 'win32'
        ? path.join(prefix, `${command}.cmd`)
        : path.join(prefix, 'bin', command)
      assert.equal(fs.existsSync(shim), true, shim)

      const invoked = process.platform === 'win32'
        ? childProcess.spawnSync(
          process.env.ComSpec || 'cmd.exe',
          ['/d', '/s', '/c', `call "${shim}" version`],
          {
            cwd: temporaryRoot,
            encoding: 'utf8',
            env,
            shell: false,
            windowsVerbatimArguments: true,
          },
        )
        : childProcess.spawnSync(shim, ['version'], {
          cwd: temporaryRoot,
          encoding: 'utf8',
          env,
          shell: false,
        })
      assert.equal(invoked.status, 0, invoked.stderr)
      assert.equal(invoked.stdout, '1.0.2\n')
    }
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})
