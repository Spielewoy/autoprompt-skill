#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const HELPER = path.join(ROOT, 'scripts', 'harness-provider-config.cjs')
const { resolveBash } = require('../helpers/resolve-bash.cjs')
const BASH = resolveBash()
const POWERSHELL = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'

function runHelper (args) {
  return childProcess.spawnSync(process.execPath, [HELPER, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30000
  })
}

function plan (provider, file, desired, original) {
  return runHelper([
    'plan', '--provider', provider, '--file', file,
    '--desired', desired, '--original', original, '--minimum', '4'
  ])
}

function inspect (provider, file) {
  return runHelper([
    'inspect', '--provider', provider, '--file', file, '--minimum', '4'
  ])
}

function restore (provider, file, prior) {
  return runHelper([
    'restore', '--provider', provider, '--file', file,
    '--backup', `${file}.autoprompt.bak`, '--prior', prior, '--expected', '4'
  ])
}

test('provider config helper plans, verifies, and reverses OMP depth safely', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-omp-config-'))
  const file = path.join(sandbox, 'config.yml')
  const desired = path.join(sandbox, 'desired.yml')
  const original = path.join(sandbox, 'original.yml')
  try {
    const missing = plan('omp', file, desired, original)
    assert.equal(missing.status, 0, missing.stderr)
    assert.match(missing.stdout, /status=applied/)
    assert.match(missing.stdout, /prior=absent-file/)
    fs.copyFileSync(desired, file)
    assert.equal(inspect('omp', file).status, 0)
    assert.equal(restore('omp', file, 'absent-file').status, 0)
    assert.equal(fs.existsSync(file), false)

    const before = 'theme: dark\ntask:\n  maxRecursionDepth: 2\n'
    fs.writeFileSync(file, before)
    const existing = plan('omp', file, desired, original)
    assert.equal(existing.status, 0, existing.stderr)
    assert.match(existing.stdout, /prior=2/)
    assert.equal(fs.readFileSync(original, 'utf8'), before)
    fs.copyFileSync(original, `${file}.autoprompt.bak`)
    fs.copyFileSync(desired, file)
    fs.appendFileSync(file, 'editor:\n  color: blue\n')
    const restored = restore('omp', file, '2')
    assert.equal(restored.status, 0, restored.stderr)
    assert.match(restored.stdout, /via=surgical-diverged/)
    const after = fs.readFileSync(file, 'utf8')
    assert.match(after, /maxRecursionDepth: 2/)
    assert.match(after, /color: blue/)
    assert.equal(fs.existsSync(`${file}.autoprompt.bak`), false)
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('provider config helper plans, verifies, and reverses Reasonix depth safely', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-reasonix-config-'))
  const file = path.join(sandbox, 'config.toml')
  const desired = path.join(sandbox, 'desired.toml')
  const original = path.join(sandbox, 'original.toml')
  try {
    const before = '[model]\nname = "test"\n\n[agent]\nmax_subagent_depth = 2\n'
    fs.writeFileSync(file, before)
    const configured = plan('reasonix', file, desired, original)
    assert.equal(configured.status, 0, configured.stderr)
    assert.match(configured.stdout, /status=applied/)
    assert.match(configured.stdout, /prior=2/)
    fs.copyFileSync(original, `${file}.autoprompt.bak`)
    fs.copyFileSync(desired, file)
    assert.equal(inspect('reasonix', file).status, 0)
    fs.appendFileSync(file, '\n[ui]\ncolor = true\n')
    const restored = restore('reasonix', file, '2')
    assert.equal(restored.status, 0, restored.stderr)
    assert.match(restored.stdout, /via=surgical-diverged/)
    const after = fs.readFileSync(file, 'utf8')
    assert.match(after, /max_subagent_depth = 2/)
    assert.match(after, /color = true/)
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('provider config helper preserves inline comments while changing managed depth', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-harness-comments-'))
  try {
    const cases = [
      {
        provider: 'omp',
        source: 'task:\n  maxRecursionDepth: 2 # chosen by user\n',
        expected: 'task:\n  maxRecursionDepth: 4 # chosen by user\n',
      },
      {
        provider: 'reasonix',
        source: '[agent]\nmax_subagent_depth = 2 # chosen by user\n',
        expected: '[agent]\nmax_subagent_depth = 4 # chosen by user\n',
      },
    ]
    for (const entry of cases) {
      const file = path.join(sandbox, `${entry.provider}.config`)
      const desired = `${file}.desired`
      const original = `${file}.original`
      fs.writeFileSync(file, entry.source)
      const result = plan(entry.provider, file, desired, original)
      assert.equal(result.status, 0, `${entry.provider}: ${result.stderr}`)
      assert.equal(fs.readFileSync(desired, 'utf8'), entry.expected)
      assert.equal(fs.readFileSync(original, 'utf8'), entry.source)
    }
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('Reasonix planning rejects valid TOML shapes it cannot safely edit', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-reasonix-shapes-'))
  try {
    const unsupported = [
      'agent = { max_subagent_depth = 2 }\n',
      'agent.max_subagent_depth = 2\n',
      '["agent"]\nmax_subagent_depth = 2\n',
    ]
    for (const [index, source] of unsupported.entries()) {
      const file = path.join(sandbox, `config-${index}.toml`)
      const desired = `${file}.desired`
      const original = `${file}.original`
      fs.writeFileSync(file, source)
      const result = plan('reasonix', file, desired, original)
      assert.equal(result.status, 52, `${index}: ${result.stdout}\n${result.stderr}`)
      assert.match(result.stderr, /unsafe-reasonix-agent-shape/)
      assert.equal(fs.readFileSync(file, 'utf8'), source)
      assert.equal(fs.existsSync(desired), false)
      assert.equal(fs.existsSync(original), false)
    }
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('OMP planning rejects valid YAML shapes it cannot safely edit', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-omp-shapes-'))
  try {
    const unsupported = [
      '"task":\n  maxRecursionDepth: 2\n',
      "'task':\n  maxRecursionDepth: 2\n",
      '{task: {maxRecursionDepth: 2}}\n',
    ]
    for (const [index, source] of unsupported.entries()) {
      const file = path.join(sandbox, `config-${index}.yml`)
      const desired = `${file}.desired`
      const original = `${file}.original`
      fs.writeFileSync(file, source)
      const result = plan('omp', file, desired, original)
      assert.equal(result.status, 52, `${index}: ${result.stdout}\n${result.stderr}`)
      assert.match(result.stderr, /unsafe-omp-task-shape/)
      assert.equal(fs.readFileSync(file, 'utf8'), source)
      assert.equal(fs.existsSync(desired), false)
      assert.equal(fs.existsSync(original), false)
    }
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('restore preserves a user-changed managed depth and relinquishes ownership', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-harness-diverged-'))
  try {
    const cases = [
      {
        provider: 'omp',
        source: 'task:\n  maxRecursionDepth: 2\n',
        changed: 'task:\n  maxRecursionDepth: 8\n',
      },
      {
        provider: 'reasonix',
        source: '[agent]\nmax_subagent_depth = 2\n',
        changed: '[agent]\nmax_subagent_depth = 8\n',
      },
    ]
    for (const entry of cases) {
      const file = path.join(sandbox, `${entry.provider}.config`)
      const desired = `${file}.desired`
      const original = `${file}.original`
      const backup = `${file}.autoprompt.bak`
      fs.writeFileSync(file, entry.source)
      const configured = plan(entry.provider, file, desired, original)
      assert.equal(configured.status, 0, `${entry.provider}: ${configured.stderr}`)
      fs.copyFileSync(original, backup)
      fs.writeFileSync(file, entry.changed)

      const result = restore(entry.provider, file, '2')
      assert.equal(result.status, 0, `${entry.provider}: ${result.stdout}\n${result.stderr}`)
      assert.match(result.stdout, /via=preserve-user-diverged/)
      assert.match(result.stdout, /note=ownership-relinquished/)
      assert.equal(fs.readFileSync(file, 'utf8'), entry.changed)
      assert.equal(fs.existsSync(backup), false)
    }
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('restore preserves a user-deleted live config and discards the stale backup', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-harness-missing-live-'))
  try {
    const cases = [
      { provider: 'omp', source: 'theme: dark\n' },
      { provider: 'reasonix', source: '[model]\nname = "test"\n' },
    ]
    for (const entry of cases) {
      const file = path.join(sandbox, `${entry.provider}.config`)
      const backup = `${file}.autoprompt.bak`
      fs.writeFileSync(backup, entry.source)

      const result = restore(entry.provider, file, 'absent-key')
      assert.equal(result.status, 0, `${entry.provider}: ${result.stdout}\n${result.stderr}`)
      assert.match(result.stdout, /via=preserve-user-missing/)
      assert.match(result.stdout, /note=ownership-relinquished/)
      assert.equal(fs.existsSync(file), false)
      assert.equal(fs.existsSync(backup), false)
    }
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('surgical restore keeps pre-existing comment-only provider sections', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-harness-comments-only-'))
  try {
    const cases = [
      {
        provider: 'omp',
        source: 'task:\n  # keep this OMP note\n',
        comment: '# keep this OMP note',
        unrelated: '\neditor:\n  color: blue\n',
      },
      {
        provider: 'reasonix',
        source: '[agent]\n# keep this Reasonix note\n',
        comment: '# keep this Reasonix note',
        unrelated: '\n[ui]\ncolor = true\n',
      },
    ]
    for (const entry of cases) {
      const file = path.join(sandbox, `${entry.provider}.config`)
      const desired = `${file}.desired`
      const original = `${file}.original`
      const backup = `${file}.autoprompt.bak`
      fs.writeFileSync(file, entry.source)
      const configured = plan(entry.provider, file, desired, original)
      assert.equal(configured.status, 0, `${entry.provider}: ${configured.stderr}`)
      assert.match(configured.stdout, /prior=absent-key/)
      fs.copyFileSync(original, backup)
      fs.copyFileSync(desired, file)
      fs.appendFileSync(file, entry.unrelated)

      const result = restore(entry.provider, file, 'absent-key')
      assert.equal(result.status, 0, `${entry.provider}: ${result.stdout}\n${result.stderr}`)
      assert.match(result.stdout, /via=surgical-diverged/)
      const restored = fs.readFileSync(file, 'utf8')
      assert.match(restored, new RegExp(entry.comment.replaceAll(' ', '\\s+')))
      assert.doesNotMatch(restored, /maxRecursionDepth|max_subagent_depth/)
      assert.match(restored, /color/)
      assert.equal(fs.existsSync(backup), false)
    }
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('new harness uninstall ownership is provider-scoped in both shell ports', {
  skip: process.platform !== 'win32'
}, () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-harness-scope-'))
  const root = path.join(sandbox, 'provider-root')
  const shLibrary = path.join(ROOT, 'scripts', 'install', 'lib', 'install-lib.sh')
  const psLibrary = path.join(ROOT, 'scripts', 'install', 'lib', 'install-lib.ps1')
  fs.mkdirSync(root, { recursive: true })
  const cases = {
    omp: path.join(root, 'agents', 'ap-manager.md'),
    deepseek: path.join(root, '.agent-presets', 'autoprompt', 'preset.yml'),
    reasonix: path.join(root, 'skills', 'ap-manager', 'SKILL.md')
  }
  const detachedRoot = path.join(sandbox, 'omp-detached', 'agent')
  const detachedOwned = path.join(detachedRoot, 'agents', 'ap-manager.md')
  const foreign = path.join(root, 'notes.txt')
  try {
    for (const file of [...Object.values(cases), detachedOwned, foreign]) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, 'ownership fixture\n')
    }
    for (const [provider, owned] of Object.entries(cases)) {
      const shellScript = [
        `export HOME='${sandbox.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`)}'`,
        `export AUTOPROMPT_INSTALL_ROOT='${root.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`)}'`,
        `export AUTOPROMPT_INSTALL_ROOT_CLIENT='${provider}'`,
        `. '${shLibrary.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`)}'`,
        ...(provider === 'omp' ? [
          'UNINSTALL_RC_OMP_MANAGED=1',
          'UNINSTALL_RC_OMP_DETACHED_ROOT='
        ] : []),
        `_uninstall_provider_owns_path "$AUTOPROMPT_INSTALL_ROOT" '${provider}' '${owned.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`)}'`,
        `! _uninstall_provider_owns_path "$AUTOPROMPT_INSTALL_ROOT" '${provider}' '${foreign.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`)}'`,
        ...(provider === 'omp' ? [
          `UNINSTALL_RC_OMP_DETACHED_ROOT='${detachedRoot.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`)}'`,
          `! _uninstall_provider_owns_path "$AUTOPROMPT_INSTALL_ROOT" 'omp' '${owned.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`)}'`,
          `_uninstall_provider_owns_path "$AUTOPROMPT_INSTALL_ROOT" 'omp' '${detachedOwned.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`)}'`
        ] : [])
      ].join('\n')
      const shell = childProcess.spawnSync(BASH, ['--noprofile', '--norc', '-c', shellScript], {
        cwd: ROOT, encoding: 'utf8', timeout: 30000
      })
      assert.equal(shell.status, 0, `${provider}: ${shell.stdout}\n${shell.stderr}`)

      const psScript = [
        `$env:AUTOPROMPT_INSTALL_ROOT = '${root.replaceAll("'", "''")}'`,
        `$env:AUTOPROMPT_INSTALL_ROOT_CLIENT = '${provider}'`,
        `. '${psLibrary.replaceAll("'", "''")}'`,
        ...(provider === 'omp' ? [
          '$script:AutopromptReceiptOmpManaged = $true',
          "$script:AutopromptReceiptOmpDetachedRoot = ''"
        ] : []),
        `if (-not (Test-UninstallProviderPath -Name '${provider}' -ConfigRoot '${root.replaceAll("'", "''")}' -Path '${owned.replaceAll("'", "''")}')) { exit 10 }`,
        `if (Test-UninstallProviderPath -Name '${provider}' -ConfigRoot '${root.replaceAll("'", "''")}' -Path '${foreign.replaceAll("'", "''")}') { exit 11 }`,
        ...(provider === 'omp' ? [
          `$script:AutopromptReceiptOmpDetachedRoot = '${detachedRoot.replaceAll("'", "''")}'`,
          `if (Test-UninstallProviderPath -Name 'omp' -ConfigRoot '${root.replaceAll("'", "''")}' -Path '${owned.replaceAll("'", "''")}') { exit 12 }`,
          `if (-not (Test-UninstallProviderPath -Name 'omp' -ConfigRoot '${root.replaceAll("'", "''")}' -Path '${detachedOwned.replaceAll("'", "''")}')) { exit 13 }`
        ] : [])
      ].join('; ')
      const powershell = childProcess.spawnSync(POWERSHELL, [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psScript
      ], { cwd: ROOT, encoding: 'utf8', timeout: 30000 })
      assert.equal(powershell.status, 0, `${provider}: ${powershell.stdout}\n${powershell.stderr}`)
    }
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})
