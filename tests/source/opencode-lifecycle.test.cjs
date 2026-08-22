#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const POWERSHELL = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
const manifestPath = path.join(ROOT, 'agents', 'manifests', 'opencode-runtime.json')

function run(command, args, options = {}) {
  return childProcess.spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 180000,
    ...options,
  })
}

function findBash() {
  const candidates = process.platform === 'win32'
    ? [
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
        'bash',
      ]
    : ['bash']
  for (const candidate of candidates) {
    if (run(candidate, ['--version']).status === 0) return candidate
  }
  return null
}

function findOnPath(command) {
  const sep = process.platform === 'win32' ? ';' : ':'
  const pathEntries = String(process.env.PATH || '').split(sep)
  for (const dir of pathEntries) {
    if (!dir) continue
    const candidate = path.join(dir, command + (process.platform === 'win32' ? '.exe' : ''))
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {
      // continue searching
    }
  }
  return null
}

function powershellLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`
}

function powershell(script, env) {
  return run(POWERSHELL, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
  ], { env })
}

function lifecycleCommand(name, target, strict = false) {
  const script = path.join(ROOT, 'scripts', 'install', `${name}.ps1`)
  const strictArgument = strict ? ' -Strict' : ''
  return `& ${powershellLiteral(script)} ${powershellLiteral(target)}${strictArgument}; exit $LASTEXITCODE`
}

function writeFakeOpencode(binDirectory, version) {
  fs.mkdirSync(binDirectory, { recursive: true })
  if (process.platform === 'win32') {
    fs.writeFileSync(
      path.join(binDirectory, 'opencode.cmd'),
      `@echo off\r\necho opencode ${version}\r\n`,
    )
  }
  const shellTarget = path.join(binDirectory, 'opencode')
  fs.writeFileSync(shellTarget, `#!/bin/sh\nprintf 'opencode ${version}\\n'\n`)
  fs.chmodSync(shellTarget, 0o755)
}

function lifecycleEnvironment(sandbox, version) {
  const home = path.join(sandbox, 'home')
  const xdg = path.join(sandbox, 'xdg')
  const bin = path.join(sandbox, 'bin')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(xdg, { recursive: true })
  writeFakeOpencode(bin, version)
  return {
    home,
    xdg,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: xdg,
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
    },
  }
}

function installedPaths(context) {
  const base = path.join(context.xdg, 'opencode')
  const skill = path.join(base, 'skills', 'autoprompt')
  return {
    base,
    agents: path.join(base, 'agents'),
    profile: path.join(base, 'autoprompt.opencode.json'),
    ordinaryConfig: path.join(base, 'opencode.json'),
    skill,
    shellWrapper: path.join(skill, 'workflow', 'launch-opencode.sh'),
    powershellWrapper: path.join(skill, 'workflow', 'launch-opencode.ps1'),
    receipt: path.join(context.xdg, '.autoprompt-install-receipt.json'),
    hashes: path.join(context.xdg, '.autoprompt-install-hashes.json'),
    credentials: path.join(context.home, '.local', 'share', 'opencode', 'auth.json'),
  }
}

function nativeAgentNames(directory) {
  return fs.readdirSync(directory)
    .filter(name => /^ap-.*\.md$/.test(name))
    .sort()
}

function doctorRow(client, env, strict = false) {
  return powershell(lifecycleCommand('doctor', client, strict), env)
}

test('OpenCode lifecycle ports pin 1.18.7 and inventory both safe launch wrappers', () => {
  const shell = fs.readFileSync(
    path.join(ROOT, 'scripts', 'install', 'lib', 'install-lib.sh'),
    'utf8',
  )
  const powershellSource = fs.readFileSync(
    path.join(ROOT, 'scripts', 'install', 'lib', 'install-lib.ps1'),
    'utf8',
  )
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

  assert.match(shell, /\[opencode\]=1\.18\.7/)
  assert.match(powershellSource, /opencode\s*=\s*'1\.18\.7'/)
  assert.equal(manifest.files.includes('workflow/launch-opencode.sh'), true)
  assert.equal(manifest.files.includes('workflow/launch-opencode.ps1'), true)

  const current = run(process.execPath, ['scripts/runtime-payload.cjs', '--check'])
  assert.equal(current.status, 0, current.stderr)
})

test('POSIX OpenCode lifecycle syntax, version boundary, profile schema, and wrapper syntax pass', () => {
  const bash = findBash()
  assert.ok(bash, 'bash is required for the POSIX lifecycle checks')
  const syntax = run(bash, ['-n',
    'scripts/install/install.sh',
    'scripts/install/doctor.sh',
    'scripts/install/uninstall.sh',
    'scripts/install/lib/install-lib.sh',
    'agents/opencode/workflow/launch-opencode.sh',
  ])
  assert.equal(syntax.status, 0, syntax.stderr)

  const probe = [
    'set -u',
    '. scripts/install/lib/install-lib.sh',
    '[ "${AUTOPROMPT_VERSION_FLOOR[opencode]}" = 1.18.7 ]',
    '! _precheck_version_ge 1.18.6 "${AUTOPROMPT_VERSION_FLOOR[opencode]}"',
    '_precheck_version_ge 1.18.7 "${AUTOPROMPT_VERSION_FLOOR[opencode]}"',
    `py="$(autoprompt_python)" || { printf 'no-python\n' >&2; exit 1; }`,
    `"$py" - ${powershellLiteral(path.join(ROOT, 'agents', 'opencode', 'autoprompt.opencode.json'))} <<'PY'`,
    'import json, sys',
    'profile = json.load(open(sys.argv[1], encoding="utf-8"))',
    'assert profile == {',
    '  "$schema": "https://opencode.ai/config.json",',
    '  "subagent_depth": 4,',
    '  "share": "disabled",',
    '  "permission": {"task": {"*": "deny", "ap-*": "allow"}},',
    '}',
    'PY',
  ].join('\n')
  const completed = run(bash, ['-c', probe])
  assert.equal(completed.status, 0, completed.stderr)
})

test('PowerShell OpenCode rejects 1.18.6 before writing and accepts 1.18.7', {
  skip: process.platform !== 'win32',
  timeout: 120000,
}, () => {
  for (const [version, accepted] of [['1.18.6', false], ['1.18.7', true]]) {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), `autoprompt-opencode-${version}-`))
    const context = lifecycleEnvironment(sandbox, version)
    const paths = installedPaths(context)
    try {
      const installed = powershell(lifecycleCommand('install', 'opencode'), context.env)
      assert.equal(installed.status === 0, accepted, `${installed.stdout}\n${installed.stderr}`)
      if (accepted) {
        assert.equal(nativeAgentNames(paths.agents).length, 25)
        const removed = powershell(lifecycleCommand('uninstall', 'opencode'), context.env)
        assert.equal(removed.status, 0, `${removed.stdout}\n${removed.stderr}`)
      } else {
        assert.match(`${installed.stdout}\n${installed.stderr}`, /version-below-floor/)
        assert.equal(fs.existsSync(paths.skill), false)
        assert.equal(fs.existsSync(paths.receipt), false)
        assert.equal(fs.existsSync(paths.hashes), false)
      }
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true })
    }
  }
})

test('PowerShell OpenCode 1.18.18 lifecycle detects tamper, repairs, stays idempotent, and uninstalls safely', {
  skip: process.platform !== 'win32',
  timeout: 180000,
}, () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-opencode-lifecycle-'))
  const context = lifecycleEnvironment(sandbox, '1.18.18')
  const paths = installedPaths(context)
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const expectedAgents = manifest.files
    .filter(relativePath => /^agents\/ap-.*\.md$/.test(relativePath))
    .map(relativePath => path.basename(relativePath))
    .sort()

  fs.mkdirSync(path.dirname(paths.credentials), { recursive: true })
  fs.mkdirSync(paths.base, { recursive: true })
  fs.writeFileSync(paths.ordinaryConfig, '{"share":"auto"}\n')
  fs.writeFileSync(paths.credentials, '{"token":"untouched"}\n')

  try {
    const first = powershell(lifecycleCommand('install', 'opencode'), context.env)
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`)
    assert.deepEqual(nativeAgentNames(paths.agents), expectedAgents)
    assert.equal(fs.existsSync(paths.shellWrapper), true)
    assert.equal(fs.existsSync(paths.powershellWrapper), true)

    const healthy = doctorRow('opencode', context.env, true)
    assert.equal(healthy.status, 0, `${healthy.stdout}\n${healthy.stderr}`)
    assert.match(
      healthy.stdout,
      /^opencode\s+yes\s+yes\s+yes\s+version=1\.18\.18 reason=- extras=complete$/m,
    )
    const kilo = doctorRow('kilo', context.env)
    assert.match(kilo.stdout, /^kilo\s+\S+\s+no\s+no\s+/m)

    const watched = [
      paths.receipt,
      paths.profile,
      path.join(paths.agents, 'ap-manager.md'),
      paths.shellWrapper,
      paths.powershellWrapper,
    ]
    const before = watched.map(file => ({
      bytes: fs.readFileSync(file),
      mtime: fs.statSync(file).mtimeMs,
    }))
    const second = powershell(lifecycleCommand('install', 'opencode'), context.env)
    assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`)
    watched.forEach((file, index) => {
      assert.deepEqual(fs.readFileSync(file), before[index].bytes, file)
      assert.equal(fs.statSync(file).mtimeMs, before[index].mtime, file)
    })

    const hashTamper = path.join(paths.agents, 'ap-manager.md')
    fs.appendFileSync(hashTamper, '\ntampered\n')
    const badHash = doctorRow('opencode', context.env, true)
    assert.notEqual(badHash.status, 0, `${badHash.stdout}\n${badHash.stderr}`)
    assert.match(badHash.stdout, /extras=invalid:opencode-native-hash/)
    fs.copyFileSync(path.join(paths.skill, 'agents', 'ap-manager.md'), hashTamper)

    const frontmatterTamper = path.join(paths.agents, 'ap-reviewer.md')
    const originalReviewer = fs.readFileSync(frontmatterTamper, 'utf8')
    fs.writeFileSync(frontmatterTamper, originalReviewer.replace(
      /^mode: subagent$/m,
      'mode: primary',
    ))
    const badFrontmatter = doctorRow('opencode', context.env, true)
    assert.notEqual(
      badFrontmatter.status,
      0,
      `${badFrontmatter.stdout}\n${badFrontmatter.stderr}`,
    )
    assert.match(badFrontmatter.stdout, /extras=invalid:opencode-native-frontmatter/)

    const unsafeProfile = JSON.parse(fs.readFileSync(paths.profile, 'utf8'))
    unsafeProfile.subagent_depth = 3
    unsafeProfile.share = 'auto'
    unsafeProfile.permission.task = { '*': 'allow', 'ap-*': 'deny' }
    fs.writeFileSync(paths.profile, `${JSON.stringify(unsafeProfile, null, 2)}\n`)
    const badProfile = doctorRow('opencode', context.env, true)
    assert.notEqual(badProfile.status, 0, `${badProfile.stdout}\n${badProfile.stderr}`)
    assert.match(badProfile.stdout, /extras=invalid:profile-policy/)

    fs.rmSync(paths.shellWrapper)
    const missingWrapper = doctorRow('opencode', context.env, true)
    assert.notEqual(missingWrapper.status, 0, `${missingWrapper.stdout}\n${missingWrapper.stderr}`)
    assert.match(missingWrapper.stdout, /extras=invalid:missing-runtime-file:-workflow\/launch-opencode\.sh/)

    const repaired = powershell(lifecycleCommand('install', 'opencode'), context.env)
    assert.equal(repaired.status, 0, `${repaired.stdout}\n${repaired.stderr}`)
    const repairedDoctor = doctorRow('opencode', context.env, true)
    assert.equal(repairedDoctor.status, 0, `${repairedDoctor.stdout}\n${repairedDoctor.stderr}`)
    assert.equal(fs.existsSync(paths.shellWrapper), true)
    assert.match(fs.readFileSync(frontmatterTamper, 'utf8'), /^mode: subagent$/m)
    assert.deepEqual(JSON.parse(fs.readFileSync(paths.profile, 'utf8')), {
      $schema: 'https://opencode.ai/config.json',
      subagent_depth: 4,
      share: 'disabled',
      permission: { task: { '*': 'deny', 'ap-*': 'allow' } },
    })

    const removed = powershell(lifecycleCommand('uninstall', 'opencode'), context.env)
    assert.equal(removed.status, 0, `${removed.stdout}\n${removed.stderr}`)
    assert.equal(fs.existsSync(paths.skill), false)
    assert.equal(fs.existsSync(paths.profile), false)
    assert.equal(fs.existsSync(paths.agents), false)
    assert.equal(fs.existsSync(paths.receipt), false)
    assert.equal(fs.existsSync(paths.hashes), false)
    assert.equal(fs.readFileSync(paths.ordinaryConfig, 'utf8'), '{"share":"auto"}\n')
    assert.equal(fs.readFileSync(paths.credentials, 'utf8'), '{"token":"untouched"}\n')
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('POSIX OpenCode profile validation resolves python3 when no bare python exists', {
  skip: process.platform === 'win32',
}, () => {
  const bash = findBash()
  assert.ok(bash, 'bash is required for the POSIX python-resolver checks')

  const python3 = findOnPath('python3')
  assert.ok(python3, 'python3 is required for the python3-only PATH regression test')
  const python = findOnPath('python')
  assert.equal(python, null, 'this test needs a system without bare `python` on PATH')

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-python3-only-'))
  const bin = path.join(sandbox, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  fs.symlinkSync(python3, path.join(bin, 'python3'))

  const script = [
    'set -u',
    `. scripts/install/lib/install-lib.sh`,
    `py="$(autoprompt_python)" || { printf 'no-python-resolved\n' >&2; exit 1; }`,
    `"$py" - ${powershellLiteral(path.join(ROOT, 'agents', 'opencode', 'autoprompt.opencode.json'))} <<'PY'`,
    'import json, sys',
    'profile = json.load(open(sys.argv[1], encoding="utf-8"))',
    'assert profile == {',
    '  "$schema": "https://opencode.ai/config.json",',
    '  "subagent_depth": 4,',
    '  "share": "disabled",',
    '  "permission": {"task": {"*": "deny", "ap-*": "allow"}},',
    '}',
    'PY',
    'printf "resolved=$py\\n"',
  ].join('\n')
  const completed = run(bash, ['-c', script], {
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH || ''}` },
  })
  assert.equal(completed.status, 0, completed.stderr)
  assert.match(completed.stdout, /resolved=python3/)

  fs.rmSync(sandbox, { recursive: true, force: true })
})
