#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const CLI_PATH = path.join(ROOT, 'bin', 'autoprompt.cjs')
const PACKAGE_VERSION = require('../../package.json').version
const CUSTOM_GUIDE_URL = 'https://github.com/Spielewoy/autoprompt-skill/blob/main/docs/guides/custom-agent-compatibility.md'
const {
  HELP_TEXT,
  PROVIDERS,
  isSupportedNodeVersion,
  parseArgs,
  providerInstallLocations,
  providerInstallState,
  queryLatestGitHubRevision,
  queryLatestVersion,
  resolveInteractiveUpdateStatus,
  run,
} = require('../../bin/autoprompt.cjs')

function capture() {
  let value = ''
  return {
    stream: { write(chunk) { value += String(chunk); return true } },
    value: () => value,
  }
}

function invoke(argv, overrides = {}) {
  const stdout = capture()
  const stderr = capture()
  const calls = []
  const responses = [...(overrides.responses || [])]
  const spawnSync = (command, args, options) => {
    calls.push({ command, args, options })
    const response = responses.length ? responses.shift() : { status: 0 }
    if (response instanceof Error) throw response
    return response
  }
  const env = overrides.env || {
    AUTOPROMPT_CLI_TEST: '1',
    HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-cli-home-')),
  }
  const answers = [...(overrides.answers || [])]
  const options = {
    cwd: overrides.cwd || path.join('caller', 'working directory'),
    env,
    nodeVersion: overrides.nodeVersion || '24.11.0',
    packageRoot: overrides.packageRoot || path.join(
      'package root',
      'with spaces',
      'node_modules',
      'autoprompt-skill',
    ),
    platform: overrides.platform || 'linux',
    readLine: overrides.readLine || (() => answers.length ? answers.shift() : null),
    checkLatestGitHubRevision: overrides.checkLatestGitHubRevision || (() => ''),
    checkLatestVersion: overrides.checkLatestVersion || (() => PACKAGE_VERSION),
    spawnSync,
    stderr: stderr.stream,
    stdout: stdout.stream,
  }
  if (overrides.interactive !== undefined) options.interactive = overrides.interactive
  const status = run(argv, options)
  return { calls, env, options, status, stderr: stderr.value(), stdout: stdout.value() }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function writeText(file, text = 'marker\n') {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

function makeLegacyCodexFixture (sandbox) {
  const packageRoot = path.join(sandbox, 'legacy-package')
  const files = new Map([
    ['SKILL.md', Buffer.from('older Codex skill\n')],
    ['frameworks/README.md', Buffer.from('older framework\n')],
    ['workflow/supervisor.sh', Buffer.from('#!/bin/sh\nexit 0\n')]
  ])
  const names = [...files.keys()].sort()
  const sha256 = value => crypto.createHash('sha256').update(value).digest('hex')
  writeJson(path.join(
    packageRoot,
    'scripts',
    'install',
    'legacy-codex-compat.json'
  ), {
    schemaVersion: 1,
    provider: 'codex',
    directories: ['frameworks', 'workflow'],
    optionalDirectories: ['workflow/closed-loop'],
    files: names,
    sizes: Object.fromEntries(names.map(name => [name, files.get(name).length])),
    sha256: Object.fromEntries(names.map(name => [name, sha256(files.get(name))]))
  })
  return {
    packageRoot,
    writeRoot (root) {
      for (const [relative, content] of files) {
        const target = path.join(root, 'skills', 'autoprompt', ...relative.split('/'))
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, content)
      }
      fs.mkdirSync(path.join(
        root,
        'skills',
        'autoprompt',
        'workflow',
        'closed-loop'
      ))
    }
  }
}

function writeRoles(directory, extension, count = 25) {
  for (let index = 1; index <= count; index += 1) {
    writeText(path.join(directory, `ap-test-${String(index).padStart(2, '0')}${extension}`))
  }
}

function writeStrongCustomRoot(root, provider) {
  switch (provider) {
    case 'claude':
      writeRoles(path.join(root, 'agents'), '.md')
      writeText(path.join(root, 'skills', 'autoprompt', 'workflow', 'autoprompt-gate.js'))
      writeText(path.join(root, 'skills', 'autoprompt', 'autoprompt-models.schema.md'))
      return
    case 'codex':
      writeText(path.join(root, 'autoprompt.config.toml'))
      writeRoles(path.join(root, 'skills', 'autoprompt', 'agents-runtime'), '.toml')
      writeJson(path.join(root, 'skills', 'autoprompt', 'agents-runtime', '.autoprompt-casting.json'), {
        enabled: false,
      })
      return
    case 'opencode':
      writeJson(path.join(root, 'autoprompt.opencode.json'), {
        $schema: 'https://opencode.ai/config.json',
      })
      writeRoles(path.join(root, 'agents'), '.md')
      writeText(path.join(root, 'skills', 'autoprompt', 'workflow', 'launch-opencode.sh'))
      writeText(path.join(root, 'skills', 'autoprompt', 'workflow', 'launch-opencode.ps1'))
      return
    case 'kilo':
      writeJson(path.join(root, 'autoprompt.kilo.json'), {
        $schema: 'https://app.kilo.ai/config.json',
      })
      writeRoles(path.join(root, 'agents'), '.md')
      return
    case 'vscode':
      writeRoles(path.join(root, 'agents'), '.agent.md')
      return
    case 'prime':
      writeJson(path.join(root, '.autoprompt-prime-install.json'), {
        packageRoot: path.join(root, 'autoprompt', 'packages', 'prime'),
      })
      writeJson(path.join(root, 'settings.json'), {
        packages: [path.join(root, 'autoprompt', 'packages', 'prime')],
      })
      writeJson(path.join(root, 'autoprompt', 'packages', 'prime', 'package.json'), {
        peerDependencies: {
          '@earendil-works/pi-coding-agent': '*',
        },
      })
      writeText(path.join(
        root,
        'autoprompt',
        'packages',
        'prime',
        'skills',
        'autoprompt',
        'src',
        'autoprompt',
        '__init__.py',
      ))
      return
    default:
      throw new Error(`unknown provider: ${provider}`)
  }
}

test('parser accepts command aliases and canonicalizes doctor arguments', () => {
  assert.deepEqual(parseArgs([]), { command: 'help' })
  for (const alias of ['help', '-h', '--help']) {
    assert.deepEqual(parseArgs([alias]), { command: 'help' })
  }
  for (const alias of ['version', '-v', '--version']) {
    assert.deepEqual(parseArgs([alias]), { command: 'version' })
  }
  assert.deepEqual(parseArgs(['install', 'codex']), {
    command: 'install',
    client: 'codex',
  })
  assert.deepEqual(parseArgs(['uninstall', 'all']), { command: 'uninstall', client: 'all' })
  assert.deepEqual(parseArgs(['uninstall']), { command: 'uninstall', client: null })
  assert.deepEqual(parseArgs(['doctor']), { command: 'doctor', client: null, strict: false })
  assert.deepEqual(parseArgs(['doctor', '--strict']), {
    command: 'doctor',
    client: null,
    strict: true,
  })
  assert.deepEqual(parseArgs(['doctor', '--strict', 'codex']), {
    command: 'doctor',
    client: 'codex',
    strict: true,
  })
  assert.deepEqual(parseArgs(['doctor', 'codex', '--strict']), {
    command: 'doctor',
    client: 'codex',
    strict: true,
  })
  assert.deepEqual(parseArgs(['repo']), { command: 'repo' })
  assert.deepEqual(parseArgs(['support']), { command: 'support' })
  assert.deepEqual(parseArgs(['update']), { command: 'update' })
  assert.deepEqual(parseArgs(['uninstall']), { command: 'uninstall', client: null })
})

test('parser rejects bad arity, unknown flags, commands, and injection-looking clients', () => {
  const invalid = [
    ['help', 'extra'],
    ['version', 'extra'],
    ['install'],
    ['install', 'codex', '--force'],
    ['doctor', '--verbose'],
    ['doctor', '--strict', '--strict'],
    ['doctor', 'codex', 'claude'],
    ['repo', 'extra'],
    ['update', 'extra'],
    ['unknown'],
    ['install', '--strict'],
    ['install', '../codex'],
    ['install', 'codex;echo-pwned'],
    ['uninstall', '$(touch-owned)'],
    ['doctor', 'Codex'],
  ]
  for (const argv of invalid) {
    assert.throws(
      () => parseArgs(argv),
      error => error && error.code === 'AUTOPROMPT_USAGE',
      argv.join(' '),
    )
  }
  assert.throws(() => parseArgs('help'), error => error && error.code === 'AUTOPROMPT_USAGE')
  assert.throws(() => parseArgs([1]), error => error && error.code === 'AUTOPROMPT_USAGE')
})

test('no arguments print help without probing or spawning', () => {
  const result = invoke([])
  assert.equal(result.status, 0)
  assert.equal(result.stdout, `${HELP_TEXT}\n`)
  assert.equal(result.stderr, '')
  assert.deepEqual(result.calls, [])

  const completed = childProcess.spawnSync(process.execPath, [CLI_PATH], {
    cwd: path.dirname(ROOT),
    encoding: 'utf8',
    input: '',
    timeout: 5_000,
  })
  assert.equal(completed.status, 0, completed.stderr)
  assert.equal(completed.stdout, `${HELP_TEXT}\n`)
})

test('interactive no-argument launch numbers every install provider plus the custom guide option', () => {
  const home = path.join('test home', 'person')
  const codexHome = path.join(home, 'state', 'codex')
  const result = invoke([], {
    answers: ['2', 'yes'],
    env: { HOME: home, CODEX_HOME: codexHome },
    interactive: true,
    platform: 'win32',
    responses: [{ status: 0 }],
  })

  assert.equal(result.status, 0)
  assert.match(result.stdout, /Checking for updates\.\.\.\r?\nAutoprompt 1\.0\.3 is current\./)
  assert.doesNotMatch(result.stdout, /\[[#.-]{10}\]/)
  assert.ok(result.stdout.indexOf('Checking for updates...') < result.stdout.indexOf('Pick a coding agent:'))
  assert.match(result.stdout, /Pick a coding agent:/)
  for (const [index, provider] of PROVIDERS.entries()) {
    assert.ok(result.stdout.includes(`${index + 1}) ${provider.label}`))
  }
  assert.match(result.stdout, /8\) Custom coding agent/)
  assert.match(result.stdout, /Provider \[1-8, Esc\]: /)
  assert.deepEqual(
    PROVIDERS.map(provider => provider.id),
    ['claude', 'codex', 'opencode', 'kilo', 'vscode', 'prime', 'omp'],
  )
  assert.equal(PROVIDERS.some(provider => provider.id === 'vibe'), false)
  assert.match(result.stdout, new RegExp(`Detected path: ${codexHome.replaceAll('\\', '\\\\')}`))
  assert.match(result.stdout, /Use detected path\(s\)\? \[Y\/N\]: /)
  assert.equal(
    result.stdout.match(/If Autoprompt helps, star https:\/\/github\.com\/Spielewoy\/autoprompt-skill/g)?.length,
    1,
  )
  assert.deepEqual(result.calls, [{
    command: 'powershell.exe',
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(result.options.packageRoot, 'scripts', 'install', 'install.ps1'),
      'codex',
    ],
    options: {
      cwd: result.options.cwd,
      env: result.env,
      shell: false,
      stdio: 'inherit',
    },
  }])
})

test('interactive launch offers a newer CLI release before provider selection', () => {
  const result = invoke([], {
    checkLatestVersion: () => '1.0.4',
    interactive: true,
    responses: [{ status: 0 }, { status: 0 }],
  })

  assert.equal(result.status, 0)
  assert.match(result.stdout, /New Autoprompt version available: 1\.0\.4 \(installed 1\.0\.3\)\. Updating\.\.\./)
  assert.match(result.stdout, /Autoprompt updated\. Restarting the installer\./)
  assert.doesNotMatch(result.stdout, /Pick a coding agent:/)
  assert.deepEqual(result.calls.map(call => [call.command, call.args]), [
    ['npm', ['install', '-g', 'autoprompt-skill@latest']],
    [process.execPath, [path.join(result.options.packageRoot, 'bin', 'autoprompt.cjs')]],
  ])
  assert.equal(result.calls[1].options.env.AUTOPROMPT_UPDATED_HANDOFF, '1')
})

test('interactive launch auto-updates a packaged install when GitHub main differs even if semver does not', () => {
  const result = invoke([], {
    checkLatestGitHubRevision: () => '0123456789abcdef0123456789abcdef01234567',
    checkLatestVersion: () => PACKAGE_VERSION,
    interactive: true,
    packageRoot: path.join('C:', 'Users', 'person', 'AppData', 'Roaming', 'npm', 'node_modules', 'autoprompt-skill'),
    responses: [{ status: 0 }, { status: 0 }],
  })

  assert.equal(result.status, 0)
  assert.match(result.stdout, /New Autoprompt build available on GitHub main \(installed 1\.0\.3\)\. Updating\.\.\./)
  assert.match(result.stdout, /Autoprompt updated\. Restarting the installer\./)
  assert.doesNotMatch(result.stdout, /Pick a coding agent:/)
  assert.deepEqual(result.calls.map(call => [call.command, call.args]), [
    ['npm', ['install', '-g', '--install-links=true', 'github:Spielewoy/autoprompt-skill#0123456789abcdef0123456789abcdef01234567']],
    [process.execPath, [path.join(result.options.packageRoot, 'bin', 'autoprompt.cjs')]],
  ])
})

test('successful startup update records the GitHub revision and does not reinstall it next launch', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-update-state-'))
  const env = { AUTOPROMPT_CLI_TEST: '1', HOME: home }
  const revision = '0123456789abcdef0123456789abcdef01234567'
  const packageRoot = path.join(
    'C:',
    'Users',
    'person',
    'AppData',
    'Roaming',
    'npm',
    'node_modules',
    'autoprompt-skill',
  )
  const first = invoke([], {
    answers: ['\u001b'],
    checkLatestGitHubRevision: () => revision,
    env,
    interactive: true,
    packageRoot,
    responses: [{ status: 0 }, { status: 0 }],
  })
  const second = invoke([], {
    answers: ['\u001b'],
    checkLatestGitHubRevision: () => revision,
    env,
    interactive: true,
    packageRoot,
  })

  assert.equal(first.calls.length, 2)
  assert.equal(second.calls.length, 0)
  assert.match(second.stdout, /Autoprompt 1\.0\.3 is current\./)
  assert.match(second.stdout, /Pick a coding agent:/)
})

test('Escape returns to provider selection, then exits the interactive installer', () => {
  const result = invoke([], {
    answers: ['2', '\u001b', '\u001b'],
    interactive: true,
  })

  assert.equal(result.status, 0)
  assert.equal(result.stdout.match(/Pick a coding agent:/g)?.length, 2)
  assert.equal(result.stdout.match(/Autoprompt installer\r?\n/g)?.length, 1)
  assert.match(result.stdout, /Back to provider selection\./)
  assert.match(result.stdout, /Autoprompt installer closed\./)
  assert.deepEqual(result.calls, [])
})

test('registry version query is bounded, shell-free, and ignores inherited npm dry-run state', () => {
  const calls = []
  const version = queryLatestVersion({
    cwd: path.resolve('registry query'),
    env: {
      NPM_CONFIG_DRY_RUN: 'true',
      npm_config_dry_run: 'true',
      SAFE: 'preserved',
    },
    platform: 'linux',
    spawnSync(command, args, options) {
      calls.push({ command, args, options })
      return { status: 0, stdout: '"1.0.1"\n' }
    },
  })

  assert.equal(version, '1.0.1')
  assert.deepEqual(calls.map(call => [call.command, call.args]), [[
    'npm',
    ['view', 'autoprompt-skill', 'version', '--json'],
  ]])
  assert.equal(calls[0].options.shell, false)
  assert.equal(calls[0].options.timeout, 5_000)
  assert.equal(calls[0].options.env.SAFE, 'preserved')
  assert.equal(calls[0].options.env.NPM_CONFIG_DRY_RUN, undefined)
  assert.equal(calls[0].options.env.npm_config_dry_run, undefined)
})

test('version discovery falls back to the GitHub repository when npm is unavailable', () => {
  const calls = []
  const responses = [
    { status: 1, stdout: '' },
    { status: 0, stdout: '1.0.0' },
  ]
  const version = queryLatestVersion({
    cwd: path.resolve('registry fallback'),
    env: {},
    platform: 'linux',
    spawnSync(command, args, options) {
      calls.push({ command, args, options })
      return responses.shift()
    },
  })

  assert.equal(version, '1.0.0')
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0].args, ['view', 'autoprompt-skill', 'version', '--json'])
  assert.equal(calls[1].command, process.execPath)
  assert.equal(calls[1].args.at(-1), 'https://raw.githubusercontent.com/Spielewoy/autoprompt-skill/main/package.json')
})

test('GitHub revision discovery reads the main branch head without a shell', () => {
  const calls = []
  const revision = queryLatestGitHubRevision({
    cwd: path.resolve('github revision query'),
    env: { SAFE: 'preserved' },
    spawnSync(command, args, options) {
      calls.push({ command, args, options })
      return { status: 0, stdout: '0123456789abcdef0123456789abcdef01234567\n' }
    },
  })

  assert.equal(revision, '0123456789abcdef0123456789abcdef01234567')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, process.execPath)
  assert.equal(calls[0].options.shell, false)
  assert.equal(calls[0].options.timeout, 5_000)
  assert.equal(calls[0].options.env.SAFE, 'preserved')
  assert.equal(
    calls[0].args.at(-1),
    'https://api.github.com/repos/Spielewoy/autoprompt-skill/commits/main',
  )
})

test('GitHub revision discovery falls back to authenticated gh for a private repository', () => {
  const calls = []
  const revision = queryLatestGitHubRevision({
    cwd: path.resolve('private github revision query'),
    env: { SAFE: 'preserved' },
    spawnSync(command, args, options) {
      calls.push({ command, args, options })
      return calls.length === 1
        ? { status: 1, stdout: '' }
        : { status: 0, stdout: 'fedcba9876543210fedcba9876543210fedcba98\n' }
    },
  })

  assert.equal(revision, 'fedcba9876543210fedcba9876543210fedcba98')
  assert.equal(calls.length, 2)
  assert.equal(calls[1].command, 'gh')
  assert.deepEqual(calls[1].args, [
    'api',
    'repos/Spielewoy/autoprompt-skill/commits/main',
    '--jq',
    '.sha',
  ])
  assert.equal(calls[1].options.shell, false)
  assert.equal(calls[1].options.timeout, 5_000)
  assert.equal(calls[1].options.env.SAFE, 'preserved')
})

test('interactive launch offers a GitHub main build when the version stays the same', () => {
  const result = invoke([], {
    checkLatestGitHubRevision: () => 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
    interactive: true,
    packageRoot: path.join('C:', 'Users', 'person', 'AppData', 'Roaming', 'npm', 'node_modules', 'autoprompt-skill'),
    responses: [{ status: 0 }, { status: 0 }],
  })

  assert.equal(result.status, 0)
  assert.match(result.stdout, /New Autoprompt build available on GitHub main \(installed 1\.0\.3\)\. Updating\.\.\./)
  assert.match(result.stdout, /Autoprompt updated\. Restarting the installer\./)
  assert.doesNotMatch(result.stdout, /Pick a coding agent:/)
  assert.deepEqual(result.calls.map(call => [call.command, call.args]), [
    ['npm', ['install', '-g', '--install-links=true', 'github:Spielewoy/autoprompt-skill#abcdefabcdefabcdefabcdefabcdefabcdefabcd']],
    [process.execPath, [path.join(result.options.packageRoot, 'bin', 'autoprompt.cjs')]],
  ])
})

test('updated installer handoff skips a second update check', () => {
  const result = invoke([], {
    answers: ['\u001b'],
    checkLatestGitHubRevision: () => { throw new Error('must not run') },
    checkLatestVersion: () => { throw new Error('must not run') },
    env: { AUTOPROMPT_UPDATED_HANDOFF: '1', HOME: path.resolve('handoff-home') },
    interactive: true,
  })

  assert.equal(result.status, 0)
  assert.doesNotMatch(result.stdout, /Checking for updates/)
  assert.match(result.stdout, /Pick a coding agent:/)
  assert.match(result.stdout, /Autoprompt installer closed\./)
  assert.deepEqual(result.calls, [])
})

test('updated installer handoff forwards the refreshed CLI exit status', () => {
  const result = invoke([], {
    checkLatestVersion: () => '1.0.4',
    interactive: true,
    responses: [{ status: 0 }, { status: 77 }],
  })

  assert.equal(result.status, 77)
  assert.equal(result.calls.length, 2)
  assert.doesNotMatch(result.stdout, /Pick a coding agent:/)
})

test('interactive update resolver refreshes a mismatched installed version', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-cli-state-'))
  try {
    const resolved = resolveInteractiveUpdateStatus({
      env: { HOME: home },
      homeDirectory: home,
      packageRoot: path.join(home, 'node_modules', 'autoprompt-skill'),
    }, '0.9.9', '')
    assert.equal(resolved.action, 'registry-first')
    assert.match(resolved.message, /does not match current release 0\.9\.9\. Updating\.\.\./)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('interactive launch from a repo checkout does not self-install a same-version GitHub build', () => {
  const result = invoke([], {
    answers: ['\u001b'],
    checkLatestGitHubRevision: () => 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
    interactive: true,
    packageRoot: ROOT,
  })

  assert.equal(result.status, 0)
  assert.match(result.stdout, /Repository checkout 1\.0\.3 is not auto-updated\./)
  assert.match(result.stdout, /Pick a coding agent:/)
  assert.match(result.stdout, /Autoprompt installer closed\./)
  assert.deepEqual(result.calls, [])
})

test('interactive launch from a repo checkout does not self-install a newer registry release', () => {
  const result = invoke([], {
    answers: ['\u001b'],
    checkLatestGitHubRevision: () => 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
    checkLatestVersion: () => '1.0.4',
    interactive: true,
    packageRoot: ROOT,
  })

  assert.equal(result.status, 0)
  assert.match(
    result.stdout,
    /Repository checkout 1\.0\.3 is not auto-updated\. Latest release: 1\.0\.4\./,
  )
  assert.match(result.stdout, /Pick a coding agent:/)
  assert.deepEqual(result.calls, [])
})

test('interactive custom coding agent option exits safely with the compatibility guide URL', () => {
  const result = invoke([], {
    answers: ['8'],
    interactive: true,
  })

  assert.equal(result.status, 0)
  assert.match(result.stdout, /Custom coding agent/)
  assert.match(result.stdout, /Use the compatibility guide:/)
  assert.ok(result.stdout.includes(CUSTOM_GUIDE_URL))
  assert.doesNotMatch(result.stdout, /Use detected path\(s\)\?/)
  assert.doesNotMatch(result.stdout, /If Autoprompt helps/)
  assert.equal(result.stderr, '')
  assert.deepEqual(result.calls, [])
})

test('real synchronous TTY reader drives the no-argument chooser without an injected prompt library', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt tty '))
  const inputPath = path.join(temporaryRoot, 'answers.txt')
  fs.writeFileSync(inputPath, '2\r\ny')
  const descriptor = fs.openSync(inputPath, 'r')
  const stdout = capture()
  const stderr = capture()
  stdout.stream.isTTY = true
  const calls = []

  try {
    const status = run([], {
      cwd: temporaryRoot,
      env: { HOME: temporaryRoot },
      nodeVersion: '24.11.0',
      packageRoot: ROOT,
      platform: 'win32',
      checkLatestGitHubRevision: () => '',
      checkLatestVersion: () => PACKAGE_VERSION,
      spawnSync(command, args, options) {
        calls.push({ command, args, options })
        return { status: 0 }
      },
      stderr: stderr.stream,
      stdin: { fd: descriptor, isTTY: true },
      stdout: stdout.stream,
    })
    assert.equal(status, 0, stderr.value())
    assert.equal(calls[0].args.at(-1), 'codex')
    assert.match(stdout.value(), /Pick a coding agent:/)
  } finally {
    fs.closeSync(descriptor)
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

test('a raw Escape key closes provider selection without waiting for Enter', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt escape key '))
  const inputPath = path.join(temporaryRoot, 'escape.bin')
  fs.writeFileSync(inputPath, Buffer.from([27]))
  const descriptor = fs.openSync(inputPath, 'r')
  const stdout = capture()
  const stderr = capture()
  const rawModes = []
  const stdin = {
    fd: descriptor,
    isRaw: false,
    isTTY: true,
    setRawMode(value) {
      rawModes.push(value)
      this.isRaw = value
    },
  }
  stdout.stream.isTTY = true

  try {
    const status = run([], {
      checkLatestVersion: () => PACKAGE_VERSION,
      cwd: temporaryRoot,
      env: { HOME: temporaryRoot },
      nodeVersion: '24.11.0',
      packageRoot: ROOT,
      platform: 'win32',
      spawnSync() { throw new Error('must not spawn') },
      stderr: stderr.stream,
      stdin,
      stdout: stdout.stream,
    })
    assert.equal(status, 0, stderr.value())
    assert.deepEqual(rawModes, [true, false])
    assert.match(stdout.value(), /Autoprompt installer closed\./)
  } finally {
    fs.closeSync(descriptor)
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

test('interactive strong custom-root match reuses the lifecycle installer through an isolated override', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-cli-opencode-root-'))
  const originalEnv = { HOME: path.join('test home', 'person'), EXISTING: 'preserved' }
  const cwd = path.join('caller', 'working directory')
  const requested = path.join('custom root with spaces', 'opencode')
  const expectedRoot = path.resolve(cwd, requested)
  try {
    writeStrongCustomRoot(path.join(sandbox, requested), 'opencode')
    const result = invoke([], {
      answers: ['3', 'n', `"${path.join(sandbox, requested)}"`],
      cwd,
      env: originalEnv,
      interactive: true,
      platform: 'win32',
      responses: [{ status: 0 }],
    })

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Custom path: /)
    assert.doesNotMatch(result.stdout, /Proceed anyway\?/)
    assert.match(result.stdout, new RegExp(`Using custom path: ${path.join(sandbox, requested).replaceAll('\\', '\\\\')}`))
    assert.equal(result.calls.length, 1)
    assert.equal(result.calls[0].args.at(-1), 'opencode')
    assert.deepEqual(result.calls[0].options.env, {
      ...originalEnv,
      AUTOPROMPT_INSTALL_ROOT: path.join(sandbox, requested),
    })
    assert.equal(originalEnv.AUTOPROMPT_INSTALL_ROOT, undefined)
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('interactive prompts reject invalid choices and closed input without mutating', () => {
  const retried = invoke([], {
    answers: ['0', 'codex', '5', 'maybe', 'Y'],
    env: { HOME: path.join('test home', 'person') },
    interactive: true,
    platform: 'win32',
    responses: [{ status: 0 }],
  })
  assert.equal(retried.status, 0)
  assert.match(retried.stdout, /Enter a number from 1 to 8\./)
  assert.match(retried.stdout, /Please answer Y or N\./)
  assert.equal(retried.calls[0].args.at(-1), 'vscode')

  const closed = invoke([], { interactive: true })
  assert.equal(closed.status, 1)
  assert.equal(closed.stderr, 'Autoprompt interactive install cancelled: input closed.\n')
  assert.doesNotMatch(closed.stdout, /If Autoprompt helps/)
  assert.deepEqual(closed.calls, [])

  const failed = invoke([], {
    answers: ['1', 'y'],
    interactive: true,
    platform: 'win32',
    responses: [{ status: 9 }],
  })
  assert.equal(failed.status, 9)
  assert.doesNotMatch(failed.stdout, /If Autoprompt helps/)

  const readFailure = invoke([], {
    interactive: true,
    readLine() { throw new Error('terminal unavailable') },
  })
  assert.equal(readFailure.status, 1)
  assert.equal(
    readFailure.stderr,
    'Autoprompt interactive install failed: terminal unavailable\n',
  )
})

test('provider install locations match default config roots and external VS Code settings', () => {
  const home = path.join('sandbox', 'home')
  const env = {
    HOME: home,
    CODEX_HOME: path.join('sandbox', 'codex state'),
    PRIME_AGENT_CODING_AGENT_DIR: path.join('sandbox', 'prime state'),
    XDG_CONFIG_HOME: path.join('sandbox', 'xdg state'),
  }
  assert.deepEqual(
    Object.fromEntries(PROVIDERS.map(provider => [provider.id, providerInstallLocations(
      provider.id,
      { env, platform: 'win32' },
    )])),
    {
      claude: { roots: [{ label: 'Install directory', path: path.join(home, '.claude') }] },
      codex: { roots: [{ label: 'Install directory', path: env.CODEX_HOME }] },
      opencode: {
        roots: [{ label: 'Install directory', path: path.join(env.XDG_CONFIG_HOME, 'opencode') }],
      },
      kilo: {
        roots: [
          { label: 'Skill root', path: path.join(home, '.kilo') },
          { label: 'Native root', path: path.join(env.XDG_CONFIG_HOME, 'kilo') },
        ],
      },
      vscode: {
        roots: [{ label: 'Install directory', path: path.join(home, '.copilot') }],
        settings: path.join(home, 'AppData', 'Roaming', 'Code', 'User', 'settings.json'),
      },
      prime: {
        roots: [{ label: 'Install directory', path: env.PRIME_AGENT_CODING_AGENT_DIR }],
      },
      omp: {
        roots: [{ label: 'Install directory', path: path.join(home, '.omp', 'agent') }],
      },
    },
  )
  assert.throws(
    () => providerInstallLocations('unknown', { env, platform: 'win32' }),
    /Unknown provider/,
  )

  const userProfile = path.join('fallback', 'profile')
  assert.deepEqual(
    providerInstallLocations('vscode', { env: { USERPROFILE: userProfile }, platform: 'darwin' }),
    {
      roots: [{ label: 'Install directory', path: path.join(userProfile, '.copilot') }],
      settings: path.join(userProfile, 'Library', 'Application Support', 'Code', 'User', 'settings.json'),
    },
  )
  assert.equal(
    providerInstallLocations('vscode', {
      env: { HOME: home, AUTOPROMPT_VSCODE_SETTINGS_PATH: path.join('custom', 'settings.json') },
      platform: 'linux',
    }).settings,
    path.join('custom', 'settings.json'),
  )
  assert.equal(
    providerInstallLocations('vscode', { env: { HOME: home }, platform: 'linux' }).settings,
    path.join(home, '.config', 'Code', 'User', 'settings.json'),
  )
  assert.equal(
    providerInstallLocations('claude', { env: {}, homeDirectory: home }).roots[0].path,
    path.join(home, '.claude'),
  )
  assert.equal(
    providerInstallLocations('prime', { env: { HOME: home }, platform: 'linux' }).roots[0].path,
    path.join(home, '.prime', 'agent'),
  )
})

test('interactive chooser explains Kilo split roots and external VS Code settings', () => {
  const home = path.join('test home', 'person')
  const xdg = path.join('test home', 'xdg')
  const kilo = invoke([], {
    answers: ['4', 'y'],
    env: { HOME: home, XDG_CONFIG_HOME: xdg },
    interactive: true,
    platform: 'win32',
    responses: [{ status: 0 }],
  })
  assert.match(kilo.stdout, /Detected paths:/)
  assert.match(kilo.stdout, new RegExp(`Skill root: ${path.join(home, '.kilo').replaceAll('\\', '\\\\')}`))
  assert.match(kilo.stdout, new RegExp(`Native root: ${path.join(xdg, 'kilo').replaceAll('\\', '\\\\')}`))

  const vscode = invoke([], {
    answers: ['5', 'y'],
    env: { HOME: home, APPDATA: path.join(home, 'roaming') },
    interactive: true,
    platform: 'win32',
    responses: [{ status: 0 }],
  })
  const settings = path.join(home, 'roaming', 'Code', 'User', 'settings.json')
  assert.ok(vscode.stdout.includes(`VS Code settings: ${settings}`))
})

test('interactive chooser installs Prime through its detected native config root', () => {
  const primeRoot = path.join('test home', 'prime agent root')
  const result = invoke([], {
    answers: ['6', 'y'],
    env: { HOME: path.join('test home', 'person'), PRIME_AGENT_CODING_AGENT_DIR: primeRoot },
    interactive: true,
    platform: 'win32',
    responses: [{ status: 0 }],
  })

  assert.equal(result.status, 0, result.stderr)
  assert.ok(result.stdout.includes(`Detected path: ${primeRoot}`))
  assert.equal(result.calls.length, 1)
  assert.equal(result.calls[0].args.at(-1), 'prime')
})

test('interactive strong Prime custom root reuses the lifecycle installer without force prompts', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-cli-prime-root-'))
  const customRoot = path.join(sandbox, 'prime custom root')
  try {
    writeStrongCustomRoot(customRoot, 'prime')
    const result = invoke([], {
      answers: ['6', 'n', customRoot],
      env: { HOME: sandbox, PRIME_AGENT_CODING_AGENT_DIR: path.join(sandbox, 'detected-prime-root') },
      interactive: true,
      platform: 'win32',
      responses: [{ status: 0 }],
    })

    assert.equal(result.status, 0, result.stderr)
    assert.doesNotMatch(result.stdout, /Proceed anyway\?/)
    assert.equal(result.calls.length, 1)
    assert.equal(result.calls[0].args.at(-1), 'prime')
    assert.equal(result.calls[0].options.env.AUTOPROMPT_INSTALL_ROOT, customRoot)
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('interactive VS Code custom root requires confirmation because external activation is not root-local', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-cli-vscode-root-'))
  const customRoot = path.join(sandbox, 'vscode-root')
  try {
    writeStrongCustomRoot(customRoot, 'vscode')
    const result = invoke([], {
      answers: ['5', 'n', customRoot, 'yes'],
      env: { HOME: sandbox },
      interactive: true,
      platform: 'win32',
      responses: [{ status: 0 }],
    })

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /required VS Code subagent setting cannot be verified/i)
    assert.match(result.stdout, /Path does not match the selected provider\. Continue anyway\? \[Y\/N\]: /)
    assert.equal(result.calls.length, 1)
    assert.equal(result.calls[0].options.env.AUTOPROMPT_INSTALL_ROOT, customRoot)
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('interactive custom root validates empty and NUL input and expands home shorthand', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-cli-home-'))
  const providerRoot = path.join(home, 'provider-root')
  try {
    writeStrongCustomRoot(providerRoot, 'claude')
    const result = invoke([], {
      answers: ['1', 'no', '', `bad\0path`, 'bad\u0085path', 'bad\u202epath', '~/provider-root'],
      env: { HOME: home },
      interactive: true,
      platform: 'win32',
      responses: [{ status: 0 }],
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Enter a directory path\./)
    assert.match(result.stdout, /Enter a valid directory path\./)
    assert.equal((result.stdout.match(/Enter a valid directory path\./g) || []).length, 3)
    assert.equal(
      result.calls[0].options.env.AUTOPROMPT_INSTALL_ROOT,
      providerRoot,
    )
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('interactive custom root re-prompts for nonexistent paths, non-directories, and unsafe reparse children', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-cli-root-checks-'))
  const home = path.join(sandbox, 'home')
  const missing = path.join(home, 'missing')
  const notDirectory = path.join(home, 'not-a-directory')
  const unsafe = path.join(home, 'unsafe')
  const safe = path.join(home, 'safe')
  const escaped = path.join(sandbox, 'escaped')
  try {
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(notDirectory, 'user file\n')
    fs.mkdirSync(unsafe, { recursive: true })
    fs.mkdirSync(escaped, { recursive: true })
    fs.symlinkSync(escaped, path.join(unsafe, 'skills'), process.platform === 'win32' ? 'junction' : 'dir')
    writeStrongCustomRoot(safe, 'codex')
    const result = invoke([], {
      answers: ['2', 'n', path.parse(sandbox).root, missing, notDirectory, unsafe, safe],
      env: { HOME: home },
      interactive: true,
      platform: 'win32',
      responses: [{ status: 0 }],
    })

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Directory does not exist\./)
    assert.match(result.stdout, /Path is not a directory\./)
    assert.match(result.stdout, /Enter a safe directory without symlink or reparse markers\./)
    assert.equal(result.calls.length, 1)
    assert.equal(result.calls[0].options.env.AUTOPROMPT_INSTALL_ROOT, safe)
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('interactive custom root warns on weak shared markers and requires explicit force confirmation', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-cli-weak-root-'))
  const root = path.join(sandbox, 'shared root with spaces')
  try {
    writeText(path.join(root, 'skills', 'autoprompt', 'SKILL.md'))
    writeText(path.join(root, 'agents', 'ap-manager.md'))
    writeText(path.join(root, 'autoprompt.opencode.json'), '{ invalid json')
    const result = invoke([], {
      answers: ['2', 'n', `"${root}"`, 'yes'],
      env: { HOME: sandbox },
      interactive: true,
      platform: 'win32',
      responses: [{ status: 0 }],
    })

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /does not show a strong Codex layout/i)
    assert.match(result.stdout, /Found weak markers: skills\/autoprompt\/SKILL\.md, agents\/ap-\*\.md/)
    assert.match(result.stdout, /Found mixed markers: OpenCode \(autoprompt\.opencode\.json\)/)
    assert.match(result.stdout, /Path does not match the selected provider\. Continue anyway\? \[Y\/N\]: /)
    assert.equal(result.calls.length, 1)
    assert.equal(result.calls[0].options.env.AUTOPROMPT_INSTALL_ROOT, root)
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('interactive custom root warns on mismatched strong markers, re-prompts on N, and does not spawn before force confirmation', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-cli-mismatch-root-'))
  const wrong = path.join(sandbox, 'wrong-provider')
  const mixed = path.join(sandbox, 'mixed-provider')
  const safe = path.join(sandbox, 'safe-provider')
  try {
    writeStrongCustomRoot(wrong, 'opencode')
    writeStrongCustomRoot(mixed, 'codex')
    writeJson(path.join(mixed, 'autoprompt.opencode.json'), {
      $schema: 'https://opencode.ai/config.json',
    })
    writeStrongCustomRoot(safe, 'codex')
    const reprompted = invoke([], {
      answers: ['2', 'n', wrong, 'n', safe],
      env: { HOME: sandbox },
      interactive: true,
      platform: 'win32',
      responses: [{ status: 0 }],
    })
    assert.equal(reprompted.status, 0, reprompted.stderr)
    assert.match(reprompted.stdout, /looks like OpenCode, not Codex/i)
    assert.equal(reprompted.calls.length, 1)
    assert.equal(reprompted.calls[0].options.env.AUTOPROMPT_INSTALL_ROOT, safe)

    const mixedClosed = invoke([], {
      answers: ['2', 'n', mixed],
      env: { HOME: sandbox },
      interactive: true,
      platform: 'win32',
    })
    assert.equal(mixedClosed.status, 1)
    assert.match(mixedClosed.stdout, /Found mixed markers: OpenCode \(autoprompt\.opencode\.json\)/)
    assert.deepEqual(mixedClosed.calls, [])

    const mixedForced = invoke([], {
      answers: ['2', 'n', mixed, 'yes'],
      env: { HOME: sandbox },
      interactive: true,
      platform: 'win32',
      responses: [{ status: 0 }],
    })
    assert.equal(mixedForced.status, 0, mixedForced.stderr)
    assert.equal(mixedForced.calls.length, 1)
    assert.equal(mixedForced.calls[0].options.env.AUTOPROMPT_INSTALL_ROOT, mixed)

    const closed = invoke([], {
      answers: ['2', 'n', wrong],
      env: { HOME: sandbox },
      interactive: true,
      platform: 'win32',
    })
    assert.equal(closed.status, 1)
    assert.equal(closed.stderr, 'Autoprompt interactive install cancelled: input closed.\n')
    assert.deepEqual(closed.calls, [])
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('help stays lean and names only the seven public providers', () => {
  assert.match(HELP_TEXT, /Interactive providers: claude, codex, opencode, kilo, vscode, prime, omp./)
  assert.doesNotMatch(HELP_TEXT, /\b(?:vibe|cursor|dcode|roo|gemini|cline|goose)\b/i)
  assert.match(HELP_TEXT, /^  autoprompt update$/m)
})

test('update uses the installed npm CLI without a shell and pins its GitHub fallback', () => {
  const windows = invoke(['update'], {
    platform: 'win32',
    responses: [{ status: 0 }],
  })
  const npmCliPath = path.join(
    path.dirname(fs.realpathSync(process.execPath)),
    'node_modules',
    'npm',
    'bin',
    'npm-cli.js',
  )
  assert.equal(windows.status, 0)
  assert.deepEqual(windows.calls, [{
    command: process.execPath,
    args: [npmCliPath, 'install', '-g', 'autoprompt-skill@latest'],
    options: {
      cwd: windows.options.cwd,
      env: windows.env,
      shell: false,
      stdio: 'inherit',
    },
  }])
  assert.equal(
    windows.stdout,
    'Autoprompt updated. Rerun `autoprompt` to refresh provider files.\n',
  )
  assert.equal(windows.stderr, '')

  const githubBuild = invoke(['update'], {
    checkLatestGitHubRevision: () => 'fedcbafedcbafedcbafedcbafedcbafedcbafed0',
    platform: 'linux',
    responses: [{ status: 0 }],
  })
  assert.equal(githubBuild.status, 0)
  assert.deepEqual(githubBuild.calls.map(call => [call.command, call.args]), [[
    'npm',
    ['install', '-g', '--install-links=true', 'github:Spielewoy/autoprompt-skill#fedcbafedcbafedcbafedcbafedcbafedcbafed0'],
  ]])

  const posixFallback = invoke(['update'], {
    checkLatestVersion: () => '1.0.4',
    checkLatestGitHubRevision: () => 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
    platform: 'linux',
    responses: [{ status: 73 }, { status: 0 }],
  })
  assert.equal(posixFallback.status, 0)
  assert.deepEqual(posixFallback.calls.map(call => [call.command, call.args]), [
    ['npm', ['install', '-g', 'autoprompt-skill@latest']],
    ['npm', ['install', '-g', '--install-links=true', 'github:Spielewoy/autoprompt-skill#abcdefabcdefabcdefabcdefabcdefabcdefabcd']],
  ])
  assert.equal(
    posixFallback.stdout,
    'npm registry update failed; trying the verified GitHub revision.\n' +
    'Autoprompt updated. Rerun `autoprompt` to refresh provider files.\n',
  )

  const missingNpmFallback = invoke(['update'], {
    checkLatestVersion: () => '1.0.4',
    checkLatestGitHubRevision: () => 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
    platform: 'linux',
    responses: [
      { error: Object.assign(new Error('missing npm'), { code: 'ENOENT' }) },
      { status: 0 },
    ],
  })
  assert.equal(missingNpmFallback.status, 0)
  assert.deepEqual(missingNpmFallback.calls.map(call => [call.command, call.args]), [
    ['npm', ['install', '-g', 'autoprompt-skill@latest']],
    ['npm', ['install', '-g', '--install-links=true', 'github:Spielewoy/autoprompt-skill#abcdefabcdefabcdefabcdefabcdefabcdefabcd']],
  ])
  assert.match(missingNpmFallback.stdout, /trying the verified GitHub revision/)

  const thrownNpmFallback = invoke(['update'], {
    checkLatestVersion: () => '1.0.4',
    checkLatestGitHubRevision: () => 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
    platform: 'linux',
    responses: [
      Object.assign(new Error('npm launch threw'), { code: 'EACCES' }),
      { status: 0 },
    ],
  })
  assert.equal(thrownNpmFallback.status, 0)
  assert.deepEqual(thrownNpmFallback.calls.map(call => [call.command, call.args]), [
    ['npm', ['install', '-g', 'autoprompt-skill@latest']],
    ['npm', ['install', '-g', '--install-links=true', 'github:Spielewoy/autoprompt-skill#abcdefabcdefabcdefabcdefabcdefabcdefabcd']],
  ])

  const bothLaunchesThrow = invoke(['update'], {
    checkLatestVersion: () => '1.0.4',
    checkLatestGitHubRevision: () => 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
    platform: 'linux',
    responses: [
      Object.assign(new Error('npm launch threw'), { code: 'EACCES' }),
      Object.assign(new Error('GitHub launch threw'), { code: 'ENOENT' }),
    ],
  })
  assert.equal(bothLaunchesThrow.status, 1)
  assert.match(bothLaunchesThrow.stderr, /could not start npm: npm launch threw/)
  assert.match(bothLaunchesThrow.stderr, /could not start npm GitHub fallback: GitHub launch threw/)

  const unavailableRevision = invoke(['update'], {
    platform: 'linux',
    responses: [{ status: 73 }],
  })
  assert.equal(unavailableRevision.status, 73)
  assert.equal(unavailableRevision.calls.length, 1)
  assert.match(unavailableRevision.stdout, /GitHub revision unavailable/)
})

test('real Windows update reaches npm without EINVAL and cannot mutate the real global prefix', {
  skip: process.platform !== 'win32',
}, () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt update '))
  const isolatedPrefix = path.join(temporaryRoot, 'prefix')
  const isolatedCache = path.join(temporaryRoot, 'cache')
  try {
    const completed = childProcess.spawnSync(process.execPath, [CLI_PATH, 'update'], {
      cwd: temporaryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        npm_config_audit: 'false',
        npm_config_cache: isolatedCache,
        npm_config_dry_run: 'true',
        npm_config_fund: 'false',
        npm_config_offline: 'true',
        npm_config_prefix: isolatedPrefix,
        npm_config_update_notifier: 'false',
      },
      timeout: 30_000,
    })

    assert.equal(completed.error, undefined)
    assert.notEqual(completed.status, null)
    assert.doesNotMatch(`${completed.stdout}${completed.stderr}`, /EINVAL|could not start npm/i)
    assert.equal(
      fs.existsSync(path.join(isolatedPrefix, 'node_modules', 'autoprompt-skill')),
      false,
    )
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

test('help, version, repo, and support are non-mutating local commands', () => {
  for (const alias of ['help', '-h', '--help']) {
    const result = invoke([alias])
    assert.equal(result.status, 0)
    assert.equal(result.stdout, `${HELP_TEXT}\n`)
    assert.deepEqual(result.calls, [])
  }

  const version = invoke(['--version'])
  assert.equal(version.status, 0)
  assert.equal(version.stdout, '1.0.3\n')
  assert.deepEqual(version.calls, [])

  const repo = invoke(['repo'])
  assert.equal(repo.status, 0)
  assert.equal(repo.stdout, 'https://github.com/Spielewoy/autoprompt-skill\n')
  assert.deepEqual(repo.calls, [])

  const support = invoke(['support'])
  assert.equal(support.status, 0)
  assert.equal(support.stdout, 'https://github.com/Spielewoy/autoprompt-skill/issues\n')
  assert.deepEqual(support.calls, [])
})

test('POSIX dispatch uses a fixed packaged path and an argument array from a spaced root', () => {
  const packageRoot = path.join('/opt', 'Autoprompt package with spaces')
  const result = invoke(['install', 'codex'], {
    packageRoot,
    responses: [
      { status: 0, stdout: '5.2' },
      { status: 3 },
    ],
  })

  assert.equal(result.status, 3)
  assert.equal(result.calls.length, 2)
  assert.deepEqual(result.calls[0], {
    command: 'bash',
    args: ['-c', 'printf "%s" "${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]}"'],
    options: {
      cwd: result.options.cwd,
      encoding: 'utf8',
      env: result.env,
      shell: false,
    },
  })
  assert.deepEqual(result.calls[1], {
    command: 'bash',
    args: [path.join(packageRoot, 'scripts', 'install', 'install.sh'), 'codex'],
    options: {
      cwd: result.options.cwd,
      env: result.env,
      shell: false,
      stdio: 'inherit',
    },
  })
})

test('POSIX doctor and uninstall pass exact script arguments', () => {
  const doctor = invoke(['doctor', '--strict', 'codex'], {
    responses: [{ status: 0, stdout: '4.3' }, { status: 0 }],
  })
  assert.deepEqual(doctor.calls[1].args, [
    path.join(doctor.options.packageRoot, 'scripts', 'install', 'doctor.sh'),
    'codex',
    '--strict',
  ])

  const uninstall = invoke(['uninstall', 'all'], {
    responses: [{ status: 0, stdout: '5.1' }, { status: 0 }],
  })
  assert.deepEqual(uninstall.calls[1].args, [
    path.join(uninstall.options.packageRoot, 'scripts', 'install', 'uninstall.sh'),
    'all',
  ])

  const legacy = invoke(['install', 'vibe'])
  assert.equal(legacy.status, 2)
  assert.match(legacy.stderr, /Unsupported provider: vibe\./)
  assert.deepEqual(legacy.calls, [])
})

test('explicit custom roots are validated and passed only through a cloned lifecycle environment', () => {
  const root = path.resolve('custom provider root')
  assert.deepEqual(parseArgs(['install', 'codex', '--root', root]), {
    command: 'install', client: 'codex', root,
  })
  assert.deepEqual(parseArgs(['uninstall', '--root', root, 'codex']), {
    command: 'uninstall', client: 'codex', root,
  })
  assert.deepEqual(parseArgs(['doctor', '--root', root, '--strict', 'codex']), {
    command: 'doctor', client: 'codex', strict: true, root,
  })

  const env = { HOME: path.resolve('home'), AUTOPROMPT_INSTALL_ROOT: path.resolve('stale') }
  const result = invoke(['doctor', 'codex', '--strict', '--root', root], {
    env, platform: 'win32', responses: [{ status: 0 }],
  })
  assert.equal(result.status, 0)
  assert.equal(result.calls[0].options.env.AUTOPROMPT_INSTALL_ROOT, root)
  assert.deepEqual(result.calls[0].args.slice(-2), ['codex', '-Strict'])
  assert.equal(env.AUTOPROMPT_INSTALL_ROOT, path.resolve('stale'))

  for (const args of [
    ['install', 'all', '--root', root],
    ['doctor', '--root', root],
    ['install', 'codex', '--root'],
    ['install', 'codex', '--root', 'relative'],
    ['install', 'codex', '--root', path.parse(root).root],
    ['install', 'codex', '--root', `${root}${path.sep}..${path.sep}escape`],
    ['install', 'codex', '--root', `${root}\nspoof`],
  ]) {
    const rejected = invoke(args)
    assert.equal(rejected.status, 2, args.join(' '))
    assert.deepEqual(rejected.calls, [])
  }
})

test('interactive custom install prints exact follow-up root commands only after success', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-cli-followup-root-'))
  const requested = path.join(sandbox, 'custom root with spaces')
  try {
    writeStrongCustomRoot(requested, 'codex')
    const success = invoke([], {
      answers: ['2', 'n', requested], interactive: true, platform: 'win32', responses: [{ status: 0 }],
    })
    assert.match(success.stdout, new RegExp(`autoprompt doctor codex --strict --root "${requested.replaceAll('\\', '\\\\')}"`))
    assert.match(success.stdout, new RegExp(`autoprompt uninstall codex --root "${requested.replaceAll('\\', '\\\\')}"`))

    const failure = invoke([], {
      answers: ['2', 'n', requested], interactive: true, platform: 'win32', responses: [{ status: 1 }],
    })
    assert.doesNotMatch(failure.stdout, /autoprompt doctor codex/)
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('Codex install and uninstall share the root operation lock with configure', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt cli operation lock '))
  const root = path.join(sandbox, 'codex root')
  fs.mkdirSync(root)
  const lock = require('../../scripts/install/operation-lock.cjs')
  const lease = lock.acquire(root, 'configure-test-holder')
  try {
    for (const command of ['install', 'uninstall']) {
      const blocked = invoke([command, 'codex', '--root', root], {
        packageRoot: ROOT, platform: 'win32', responses: [{ status: 0 }],
      })
      assert.equal(blocked.status, 1)
      assert.match(blocked.stderr, /operation lock is held/)
      assert.deepEqual(blocked.calls, [])
    }
  } finally {
    lock.release(lease)
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('Windows uses powershell.exe first, translates strict, and falls back to pwsh only when absent', () => {
  const primary = invoke(['doctor', 'codex', '--strict'], {
    platform: 'win32',
    responses: [{ status: 77 }],
  })
  const script = path.join(primary.options.packageRoot, 'scripts', 'install', 'doctor.ps1')
  assert.equal(primary.status, 77)
  assert.deepEqual(primary.calls, [{
    command: 'powershell.exe',
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      'codex',
      '-Strict',
    ],
    options: {
      cwd: primary.options.cwd,
      env: primary.env,
      shell: false,
      stdio: 'inherit',
    },
  }])

  const missing = new Error('not found')
  missing.code = 'ENOENT'
  const fallback = invoke(['install', 'codex'], {
    platform: 'win32',
    responses: [
      { error: missing, status: null },
      { status: 0 },
    ],
  })
  assert.equal(fallback.status, 0)
  assert.deepEqual(fallback.calls.map(call => call.command), ['powershell.exe', 'pwsh'])
  assert.deepEqual(fallback.calls[1].args, fallback.calls[0].args)
  assert.deepEqual(fallback.calls[1].options, fallback.calls[0].options)

  const unavailable = invoke(['install', 'codex'], {
    platform: 'win32',
    responses: [
      { error: missing, status: null },
      { error: missing, status: null },
    ],
  })
  assert.equal(unavailable.status, 1)
  assert.deepEqual(unavailable.calls.map(call => call.command), ['powershell.exe', 'pwsh'])
  assert.equal(unavailable.stderr, 'Autoprompt requires powershell.exe or pwsh on PATH.\n')
})

test('Bash 4.3 is enforced with clear macOS guidance', () => {
  const old = invoke(['doctor'], {
    platform: 'darwin',
    responses: [{ status: 0, stdout: '3.2' }],
  })
  assert.equal(old.status, 1)
  assert.equal(old.calls.length, 1)
  assert.match(old.stderr, /Bash 4\.3 or newer/)
  assert.match(old.stderr, /macOS ships Bash 3\.2/)
  assert.match(old.stderr, /brew install bash/)

  const missing = new Error('not found')
  missing.code = 'ENOENT'
  const absent = invoke(['install', 'codex'], {
    responses: [{ error: missing, status: null }],
  })
  assert.equal(absent.status, 1)
  assert.match(absent.stderr, /Bash 4\.3 or newer/)
})

test('numeric child exits are forwarded and CLI-owned failures use 1 or 2', () => {
  for (const status of [0, 1, 2, 3, 77]) {
    const result = invoke(['install', 'codex'], {
      responses: [{ status: 0, stdout: '5.2' }, { status }],
    })
    assert.equal(result.status, status)
  }

  const usage = invoke(['install'])
  assert.equal(usage.status, 2)
  assert.match(usage.stderr, /Usage:/)
  assert.deepEqual(usage.calls, [])

  const failure = new Error('spawn failed')
  failure.code = 'EACCES'
  const spawnFailure = invoke(['install', 'codex'], {
    responses: [{ status: 0, stdout: '5.2' }, { error: failure, status: null }],
  })
  assert.equal(spawnFailure.status, 1)
  assert.match(spawnFailure.stderr, /could not start/)
})

test('child signals use conventional exit statuses with a safe unknown-signal fallback', () => {
  for (const signal of ['SIGTERM', 'SIGINT']) {
    const result = invoke(['install', 'codex'], {
      responses: [
        { status: 0, stdout: '5.2' },
        { signal, status: null },
      ],
    })
    assert.equal(result.status, 128 + os.constants.signals[signal], signal)
    assert.equal(result.stderr, '')
  }

  const unknown = invoke(['install', 'codex'], {
    responses: [
      { status: 0, stdout: '5.2' },
      { signal: 'SIGAUTOPROMPT', status: null },
    ],
  })
  assert.equal(unknown.status, 1)
  assert.equal(
    unknown.stderr,
    'Autoprompt bash exited due to unknown signal SIGAUTOPROMPT; using exit status 1.\n',
  )
})

test('Node runtime guard accepts every valid Node major from 20 onward', () => {
  for (const version of [
    '20.0.0',
    '20.19.5',
    '22.0.0',
    '22.20.0',
    '23.11.0',
    '24.0.0',
    '24.11.0',
    '25.0.0',
    '99.1.0',
    'v24.99.1',
  ]) {
    assert.equal(isSupportedNodeVersion(version), true, version)
  }
  for (const version of [
    '19.9.0',
    '24',
    'banana',
  ]) {
    assert.equal(isSupportedNodeVersion(version), false, version)
  }

  const rejected = invoke([], { nodeVersion: '19.9.0' })
  assert.equal(rejected.status, 1)
  assert.match(rejected.stderr, /Node\.js 20 or newer/)
  assert.deepEqual(rejected.calls, [])
})

test('provider state reads receipt-owned version markers without guessing from directory names', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-cli-state-'))
  try {
    const claude = path.join(sandbox, '.claude')
    assert.deepEqual(providerInstallState('claude', claude), {
      installed: false,
      version: '',
      current: false,
    })

    writeJson(path.join(claude, '.autoprompt-install-receipt.json'), { files: [] })
    writeText(path.join(claude, 'skills', 'autoprompt', 'VERSION'), '0.9.0\n')
    assert.deepEqual(providerInstallState('claude', claude), {
      installed: true,
      version: '0.9.0',
      current: false,
    })

    const prime = path.join(sandbox, '.prime', 'agent')
    writeJson(path.join(prime, '.autoprompt-prime-install.json'), { provider: 'prime' })
    writeJson(path.join(prime, 'autoprompt', 'packages', 'prime', 'package.json'), { version: PACKAGE_VERSION })
    assert.equal(providerInstallState('prime', prime).version, PACKAGE_VERSION)

    fs.rmSync(path.join(claude, '.autoprompt-install-receipt.json'))
    assert.equal(providerInstallState('claude', claude).installed, false)

    const codex = path.join(sandbox, '.codex')
    const legacyFixture = makeLegacyCodexFixture(sandbox)
    legacyFixture.writeRoot(codex)
    assert.deepEqual(providerInstallState(
      'codex',
      codex,
      PACKAGE_VERSION,
      legacyFixture.packageRoot
    ), {
      installed: true,
      version: '',
      current: false,
      legacy: true,
    })
    fs.rmdirSync(path.join(codex, 'skills', 'autoprompt', 'workflow', 'closed-loop'))
    assert.equal(providerInstallState(
      'codex',
      codex,
      PACKAGE_VERSION,
      legacyFixture.packageRoot
    ).installed, true)
    fs.mkdirSync(path.join(codex, 'skills', 'autoprompt', 'local-empty'))
    assert.equal(providerInstallState(
      'codex',
      codex,
      PACKAGE_VERSION,
      legacyFixture.packageRoot
    ).installed, false)
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('interactive install reports detected state and confirms update or repair before mutation', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-cli-update-'))
  const root = path.join(sandbox, '.claude')
  try {
    writeJson(path.join(root, '.autoprompt-install-receipt.json'), { files: [] })
    writeText(path.join(root, 'skills', 'autoprompt', 'VERSION'), '0.9.0\n')
    const update = invoke([], {
      answers: ['1', 'yes', 'yes'],
      env: { HOME: sandbox },
      interactive: true,
      platform: 'win32',
      responses: [{ status: 0 }],
    })
    assert.match(update.stdout, /Claude Code \(installed 0\.9\.0, update available: 1\.0\.3\)/)
    assert.match(update.stdout, /Update Autoprompt 0\.9\.0 to 1\.0\.3\? \[Y\/N\]: /)
    assert.equal(update.calls.length, 1)

    writeText(path.join(root, 'skills', 'autoprompt', 'VERSION'), `${PACKAGE_VERSION}\n`)
    const repair = invoke([], {
      answers: ['1', 'no'],
      env: { HOME: sandbox },
      interactive: true,
      platform: 'win32',
    })
    assert.match(repair.stdout, /Claude Code \(installed 1\.0\.3, current\)/)
    assert.match(repair.stdout, /Autoprompt 1\.0\.3 is current\. Reinstall or repair it\? \[Y\/N\]: /)
    assert.equal(repair.calls.length, 0)

    const codex = path.join(sandbox, '.codex')
    const legacyFixture = makeLegacyCodexFixture(sandbox)
    legacyFixture.writeRoot(codex)
    const legacy = invoke([], {
      answers: ['2', 'yes', 'yes'],
      env: { HOME: sandbox },
      interactive: true,
      packageRoot: legacyFixture.packageRoot,
      platform: 'win32',
      responses: [{ status: 0 }],
    })
    assert.match(legacy.stdout, /Codex \(legacy install detected, update available: 1\.0\.3\)/)
    assert.match(legacy.stdout, /Legacy Autoprompt install detected\. Update it to 1\.0\.3\? \[Y\/N\]: /)
    assert.equal(legacy.calls.length, 1)
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('interactive uninstall selects a detected installation and custom roots stay explicit', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-cli-uninstall-'))
  const root = path.join(sandbox, '.claude')
  try {
    writeJson(path.join(root, '.autoprompt-install-receipt.json'), { files: [] })
    writeText(path.join(root, 'skills', 'autoprompt', 'VERSION'), `${PACKAGE_VERSION}\n`)
    const removed = invoke(['uninstall'], {
      answers: ['1', 'yes', 'yes'],
      env: { HOME: sandbox },
      interactive: true,
      platform: 'win32',
      responses: [{ status: 0 }],
    })
    assert.match(removed.stdout, /Autoprompt uninstaller/)
    assert.match(removed.stdout, /Claude Code \(installed 1\.0\.3, current\)/)
    assert.match(removed.stdout, /Uninstall Autoprompt from Claude Code\? \[Y\/N\]: /)
    assert.equal(removed.calls.length, 1)
    assert.equal(removed.calls[0].args.at(-1), 'claude')

    const missing = invoke(['uninstall'], {
      answers: ['2', 'yes'],
      env: { HOME: sandbox },
      interactive: true,
      platform: 'win32',
    })
    assert.match(missing.stdout, /No Autoprompt installation was found at the detected Codex root\./)
    assert.equal(missing.calls.length, 0)
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('interactive uninstall keeps a receiptless legacy Codex install on the upgrade path', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-cli-uninstall-legacy-'))
  try {
    const legacyFixture = makeLegacyCodexFixture(sandbox)
    legacyFixture.writeRoot(path.join(sandbox, '.codex'))
    const missing = invoke(['uninstall'], {
      answers: ['2', 'yes'],
      env: { HOME: sandbox },
      interactive: true,
      packageRoot: legacyFixture.packageRoot,
      platform: 'win32',
    })
    assert.match(missing.stdout, /No Autoprompt installation was found at the detected Codex root\./)
    assert.equal(missing.calls.length, 0)
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('Escape returns to provider selection, then exits the interactive uninstaller', () => {
  const result = invoke(['uninstall'], {
    answers: ['1', '\u001b', '\u001b'],
    interactive: true,
  })

  assert.equal(result.status, 0)
  assert.equal(result.stdout.match(/Pick a coding agent:/g)?.length, 2)
  assert.equal(result.stdout.match(/Autoprompt uninstaller\r?\n/g)?.length, 1)
  assert.match(result.stdout, /Back to provider selection\./)
  assert.match(result.stdout, /Autoprompt uninstaller closed\./)
  assert.deepEqual(result.calls, [])
})
