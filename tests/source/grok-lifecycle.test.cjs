#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const MANIFEST = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'agents', 'manifests', 'grok-runtime.json'),
  'utf8',
))
const ACTIVATION_KEY = 'mcp_servers.autoprompt'
const USER_CONFIG = [
  '# user owned',
  '[mcp_servers.linear]',
  'command = "npx"',
  'args = ["-y", "linear-mcp"]',
  '',
  '[permission]',
  'allow = ["Bash(git *)"]',
  '',
].join('\n')

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

function makeEnvironment(sandbox, version = '1.0.5') {
  const home = path.join(sandbox, 'home')
  const bin = path.join(sandbox, 'bin')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(bin, { recursive: true })
  const fake = path.join(bin, 'grok')
  fs.writeFileSync(fake, `#!/bin/sh\nprintf 'grok ${version}\\n'\n`)
  fs.chmodSync(fake, 0o755)
  return {
    bin,
    home,
    grokHome: path.join(home, '.grok'),
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
    },
  }
}

function paths(context) {
  const runtime = path.join(context.grokHome, 'skills', 'autoprompt')
  return {
    runtime,
    config: path.join(context.grokHome, 'config.toml'),
    backup: path.join(context.grokHome, 'config.toml.autoprompt.bak'),
    profile: path.join(context.grokHome, 'autoprompt.grok.toml'),
    receipt: path.join(context.grokHome, '.autoprompt-install-receipt.json'),
    skill: path.join(runtime, 'SKILL.md'),
    dispatchServer: path.join(runtime, 'workflow', 'grok-dispatch-server.js'),
  }
}

function lifecycle(bash, script, target, context, extra = []) {
  return run(bash, [path.join(ROOT, 'scripts', 'install', `${script}.sh`), target, ...extra], {
    env: context.env,
  })
}

function assertPayload(target) {
  for (const relative of MANIFEST.files) {
    assert.equal(fs.existsSync(path.join(target, ...relative.split('/'))), true, relative)
  }
  assert.equal(MANIFEST.files.length, 54)
}

test('both lifecycle ports pin the Grok Build floor, config root, and sealed registration', () => {
  const shell = fs.readFileSync(path.join(ROOT, 'scripts', 'install', 'lib', 'install-lib.sh'), 'utf8')
  const powershell = fs.readFileSync(path.join(ROOT, 'scripts', 'install', 'lib', 'install-lib.ps1'), 'utf8')

  assert.match(shell, /\[grok\]=1\.0\.0/)
  assert.match(powershell, /grok\s*=\s*'1\.0\.0'/)
  assert.match(shell, /\[grok\]='GROK\|skills\/autoprompt\/SKILL\.md\|md-claude'/)
  assert.match(powershell, /grok\s+= 'GROK\|skills\/autoprompt\/SKILL\.md\|md-claude'/)
  for (const source of [shell, powershell]) {
    assert.match(source, /GROK_HOME/)
    assert.match(source, /mcp_servers\.autoprompt/)
    assert.match(source, /grok-config\.cjs/)
  }

  const installer = fs.readFileSync(path.join(ROOT, 'scripts', 'install', 'install.ps1'), 'utf8')
  const activation = installer.match(/function Install-GrokActivation \{[\s\S]*?\n\}/)?.[0] || ''
  assert.match(activation, /Install-IdemManagedFiles/)
  assert.match(activation, /AutopromptGrokActivationKey/)

  const helper = fs.readFileSync(path.join(ROOT, 'scripts', 'install', 'grok-config.cjs'), 'utf8')
  assert.match(helper, /function stage\(/)
  assert.match(helper, /function restore\(/)

  const current = run(process.execPath, ['scripts/runtime-payload.cjs', '--check'])
  assert.equal(current.status, 0, current.stderr)
})

test('POSIX lifecycle scripts and the Grok launcher parse cleanly', () => {
  const bash = findBash()
  assert.ok(bash, 'bash is required for the POSIX lifecycle checks')
  const syntax = run(bash, ['-n',
    'scripts/install/install.sh',
    'scripts/install/doctor.sh',
    'scripts/install/uninstall.sh',
    'scripts/install/lib/install-lib.sh',
    'agents/grok/workflow/launch-grok.sh',
  ])
  assert.equal(syntax.status, 0, syntax.stderr)

  const probe = [
    'set -u',
    '. scripts/install/lib/install-lib.sh',
    '[ "${AUTOPROMPT_VERSION_FLOOR[grok]}" = 1.0.0 ]',
    '! _precheck_version_ge 0.9.9 "${AUTOPROMPT_VERSION_FLOOR[grok]}"',
    '_precheck_version_ge 1.0.0 "${AUTOPROMPT_VERSION_FLOOR[grok]}"',
    'HOME=/tmp/grok-home GROK_HOME= autoprompt_config_root grok | grep -qx /tmp/grok-home/.grok',
    'HOME=/tmp/grok-home GROK_HOME=/tmp/custom-grok autoprompt_config_root grok | grep -qx /tmp/custom-grok',
    'validate_grok_profile agents/grok/autoprompt.grok.toml',
    '! validate_grok_profile agents/grok/VERSION',
  ].join('\n')
  const completed = run(bash, ['-c', probe])
  assert.equal(completed.status, 0, `${completed.stdout}\n${completed.stderr}`)
})

test('POSIX Grok lifecycle installs, verifies, repairs, and uninstalls without touching user config', {
  timeout: 240000,
}, () => {
  const bash = findBash()
  assert.ok(bash, 'bash is required for the POSIX lifecycle checks')
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-grok-lifecycle-'))
  const context = makeEnvironment(sandbox)
  const target = paths(context)
  fs.mkdirSync(context.grokHome, { recursive: true })
  fs.writeFileSync(target.config, USER_CONFIG)

  try {
    const install = lifecycle(bash, 'install', 'grok', context)
    assert.equal(install.status, 0, `${install.stdout}\n${install.stderr}`)
    assertPayload(target.runtime)
    assert.match(fs.readFileSync(target.skill, 'utf8'), /^disable-model-invocation: true$/m)

    const config = fs.readFileSync(target.config, 'utf8')
    assert.ok(config.startsWith(USER_CONFIG), 'the user config is preserved verbatim')
    assert.match(config, /\[mcp_servers\.autoprompt\]/)
    assert.ok(config.includes(target.dispatchServer), 'the registration points at the installed server')
    assert.equal(fs.readFileSync(target.backup, 'utf8'), USER_CONFIG)
    assert.equal(fs.existsSync(target.profile), true)

    const receipt = JSON.parse(fs.readFileSync(target.receipt, 'utf8'))
    assert.equal(receipt.configEdits.length, 1)
    assert.equal(receipt.configEdits[0].file, target.config)
    assert.equal(receipt.configEdits[0].key, ACTIVATION_KEY)

    const doctor = lifecycle(bash, 'doctor', 'grok', context, ['--strict'])
    assert.equal(doctor.status, 0, `${doctor.stdout}\n${doctor.stderr}`)
    assert.match(doctor.stdout, /^grok\s+yes\s+yes\s+yes\s+version=1\.0\.5 reason=- extras=complete$/m)

    const launcher = run(bash, [path.join(target.runtime, 'workflow', 'launch-grok.sh'), '--check'], {
      env: context.env,
    })
    assert.equal(launcher.status, 0, `${launcher.stdout}\n${launcher.stderr}`)
    assert.match(launcher.stdout, /grok activation policy: ok/)
    assert.match(launcher.stdout, /activation=minted/)

    // The installed dispatcher is reachable from any Grok session, so it must refuse
    // an unactivated caller and admit only a launcher-minted one.
    const dispatcher = path.join(target.runtime, 'workflow', 'grok-dispatch.js')
    const mission = path.join(sandbox, 'PROMPTS.txt')
    fs.writeFileSync(mission, 'the exact mission ledger\n')
    const dispatchArgs = [
      dispatcher,
      '--persona', 'ap-scope-coordinator',
      '--task', 'produce the roadmap',
      '--mission', mission,
      '--nonce', 'RUN-GROK-LIFECYCLE',
      '--dry-run',
    ]
    const unactivated = run(process.execPath, dispatchArgs, { env: context.env })
    assert.equal(unactivated.status, 3, unactivated.stdout)
    assert.match(unactivated.stderr, /no Autoprompt activation is present/)

    const activated = run(process.execPath, dispatchArgs, {
      env: { ...context.env, AUTOPROMPT_GROK_ACTIVATION: 'ap0123456789abcdef0123456789abcdef' },
    })
    assert.equal(activated.status, 0, `${activated.stdout}\n${activated.stderr}`)
    const plan = JSON.parse(activated.stdout)
    assert.equal(plan.persona, 'ap-scope-coordinator')
    assert.equal(plan.depth, 1)
    assert.equal(plan.args.includes('-p'), false, 'the retired -p flag conflicts with --prompt-file')
    assert.equal(plan.args[0], '--prompt-file')

    const configBefore = fs.readFileSync(target.config)
    const again = lifecycle(bash, 'install', 'grok', context)
    assert.equal(again.status, 0, `${again.stdout}\n${again.stderr}`)
    assert.deepEqual(fs.readFileSync(target.config), configBefore, 'a second install is a no-op edit')

    const tampered = path.join(target.runtime, 'agents', 'ap-manager.md')
    fs.writeFileSync(tampered, 'tampered\n')
    fs.rmSync(path.join(target.runtime, 'workflow', 'grok-dispatch.js'))
    const brokenDoctor = lifecycle(bash, 'doctor', 'grok', context, ['--strict'])
    assert.notEqual(brokenDoctor.status, 0, brokenDoctor.stdout)

    const repair = lifecycle(bash, 'install', 'grok', context)
    assert.equal(repair.status, 0, `${repair.stdout}\n${repair.stderr}`)
    assertPayload(target.runtime)
    assert.notEqual(fs.readFileSync(tampered, 'utf8'), 'tampered\n')
    const repaired = lifecycle(bash, 'doctor', 'grok', context, ['--strict'])
    assert.equal(repaired.status, 0, repaired.stdout)

    const uninstall = lifecycle(bash, 'uninstall', 'grok', context)
    assert.equal(uninstall.status, 0, `${uninstall.stdout}\n${uninstall.stderr}`)
    assert.equal(fs.readFileSync(target.config, 'utf8'), USER_CONFIG, 'uninstall restores the exact prior bytes')
    assert.equal(fs.existsSync(target.backup), false)
    assert.equal(fs.existsSync(target.profile), false)
    assert.equal(fs.existsSync(target.runtime), false)
    assert.equal(fs.existsSync(target.receipt), false)
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('an explicit install root keeps the whole Grok Build lifecycle inside that root', {
  timeout: 180000,
}, () => {
  const bash = findBash()
  assert.ok(bash, 'bash is required for the POSIX lifecycle checks')
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-grok-root-'))
  const context = makeEnvironment(sandbox)
  const customRoot = path.join(sandbox, 'grok custom root')
  fs.mkdirSync(customRoot, { recursive: true })
  const rooted = { ...context, env: { ...context.env, AUTOPROMPT_INSTALL_ROOT: customRoot } }

  try {
    const install = lifecycle(bash, 'install', 'grok', rooted)
    assert.equal(install.status, 0, `${install.stdout}\n${install.stderr}`)
    assertPayload(path.join(customRoot, 'skills', 'autoprompt'))
    assert.equal(fs.existsSync(path.join(customRoot, 'autoprompt.grok.toml')), true)
    assert.match(fs.readFileSync(path.join(customRoot, 'config.toml'), 'utf8'), /\[mcp_servers\.autoprompt\]/)
    assert.equal(fs.existsSync(context.grokHome), false, 'the default root stays untouched')

    const doctor = lifecycle(bash, 'doctor', 'grok', rooted, ['--strict'])
    assert.equal(doctor.status, 0, `${doctor.stdout}\n${doctor.stderr}`)

    const uninstall = lifecycle(bash, 'uninstall', 'grok', rooted)
    assert.equal(uninstall.status, 0, `${uninstall.stdout}\n${uninstall.stderr}`)
    assert.deepEqual(fs.readdirSync(customRoot), [])
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('a foreign autoprompt MCP section blocks activation instead of being overwritten', {
  timeout: 120000,
}, () => {
  const bash = findBash()
  assert.ok(bash, 'bash is required for the POSIX lifecycle checks')
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-grok-conflict-'))
  const context = makeEnvironment(sandbox)
  const target = paths(context)
  const foreign = '[mcp_servers.autoprompt]\ncommand = "someone-elses-server"\nsecret = "keep"\n'
  fs.mkdirSync(context.grokHome, { recursive: true })
  fs.writeFileSync(target.config, foreign)

  try {
    const install = lifecycle(bash, 'install', 'grok', context)
    assert.notEqual(install.status, 0, install.stdout)
    assert.match(`${install.stdout}\n${install.stderr}`, /activation-missing/)
    assert.equal(fs.readFileSync(target.config, 'utf8'), foreign, 'a foreign section is never rewritten')
    assert.equal(fs.existsSync(target.backup), false)
    assert.equal(fs.existsSync(target.profile), false)
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('a Grok Build older than the floor is refused before anything is written', {
  timeout: 120000,
}, () => {
  const bash = findBash()
  assert.ok(bash, 'bash is required for the POSIX lifecycle checks')
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-grok-floor-'))
  const context = makeEnvironment(sandbox, '0.9.9')
  const target = paths(context)

  try {
    const install = lifecycle(bash, 'install', 'grok', context)
    assert.notEqual(install.status, 0, install.stdout)
    assert.equal(fs.existsSync(target.runtime), false)
    assert.equal(fs.existsSync(target.config), false)
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})
