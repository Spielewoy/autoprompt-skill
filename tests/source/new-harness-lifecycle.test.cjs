#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const BASH = process.platform === 'win32'
  ? 'C:\\Program Files\\Git\\bin\\bash.exe'
  : 'bash'
const POWERSHELL = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
const NODE_DIRECTORY = path.dirname(process.execPath)
const PYTHON_DIRECTORY = path.dirname(childProcess.spawnSync(
  'python',
  ['-c', 'import sys; print(sys.executable)'],
  { encoding: 'utf8' },
).stdout.trim())
const PROVIDERS = Object.freeze({
  omp: Object.freeze({ command: 'omp', version: 'omp/17.4.0' }),
  deepseek: Object.freeze({ command: 'dsh', version: '0.1.0-rc.7' }),
  reasonix: Object.freeze({ command: 'reasonix', version: 'reasonix v1.30.0' }),
})

function run(command, args, options = {}) {
  return childProcess.spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 180000,
    ...options,
  })
}

function runDiagnostic(label, result) {
  return [
    label,
    result.stdout,
    result.stderr,
    result.error ? `spawn-error=${result.error.message}` : '',
    result.signal ? `signal=${result.signal}` : '',
  ].filter(Boolean).join('\n')
}

function toBash(value) {
  return value.replaceAll('\\', '/').replace(
    /^([A-Za-z]):/,
    (_, drive) => `/${drive.toLowerCase()}`,
  )
}

function shellLiteral(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function powershellLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`
}

function runLifecycleScript(name, provider, context, strict = false) {
  const script = toBash(path.join(ROOT, 'scripts', 'install', `${name}.sh`))
  const args = [provider, ...(strict ? ['--strict'] : [])]
    .map(shellLiteral).join(' ')
  const command = [
    `export HOME=${shellLiteral(toBash(context.home))}`,
    `export XDG_CONFIG_HOME=${shellLiteral(toBash(context.xdg))}`,
    `export APPDATA=${shellLiteral(toBash(context.appData))}`,
    `export AUTOPROMPT_INSTALL_ROOT=${shellLiteral(toBash(context.customRoot))}`,
    `export PATH=${shellLiteral([
      toBash(context.bin),
      toBash(NODE_DIRECTORY),
      toBash(PYTHON_DIRECTORY),
      '/usr/bin',
      '/bin',
    ].join(':'))}`,
    `/usr/bin/bash ${shellLiteral(script)} ${args}`,
  ].join('; ')
  return run(BASH, ['--noprofile', '--norc', '-c', command])
}

function runPosixDefaultLifecycleScript(name, provider, context, platform, strict = false) {
  const script = toBash(path.join(ROOT, 'scripts', 'install', `${name}.sh`))
  const args = [provider, ...(strict ? ['--strict'] : [])]
    .map(shellLiteral).join(' ')
  const ostype = platform === 'macos' ? 'darwin23' : 'linux-gnu'
  const command = [
    `export HOME=${shellLiteral(toBash(context.home))}`,
    `export XDG_CONFIG_HOME=${shellLiteral(toBash(context.xdg))}`,
    `export APPDATA=${shellLiteral(toBash(context.appData))}`,
    `export OSTYPE=${shellLiteral(ostype)}`,
    'unset OS MSYSTEM AUTOPROMPT_INSTALL_ROOT AUTOPROMPT_INSTALL_ROOT_CLIENT',
    'unset PI_CODING_AGENT_DIR PI_CONFIG_DIR OMP_PROFILE PI_PROFILE DSH_HOME REASONIX_HOME',
    `export PATH=${shellLiteral([
      toBash(context.bin),
      toBash(NODE_DIRECTORY),
      toBash(PYTHON_DIRECTORY),
      '/usr/bin',
      '/bin',
    ].join(':'))}`,
    `. ${shellLiteral(script)} ${args}`,
  ].join('; ')
  return run(BASH, ['--noprofile', '--norc', '-c', command])
}

function runPowerShellLifecycleScript(name, provider, context, strict = false) {
  const script = path.join(ROOT, 'scripts', 'install', `${name}.ps1`)
  const command = [
    `& ${powershellLiteral(script)} ${powershellLiteral(provider)}`,
    ...(strict ? ["if ($LASTEXITCODE -eq 0) { exit 0 } else { exit $LASTEXITCODE }"] : []),
    'exit $LASTEXITCODE',
  ].join('; ')
  return run(POWERSHELL, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command,
  ], { env: context.psEnv })
}

function runReceiptValidation(port, context) {
  if (port === 'shell') {
    const library = toBash(path.join(
      ROOT, 'scripts', 'install', 'lib', 'install-lib.sh',
    ))
    const command = [
      `export HOME=${shellLiteral(toBash(context.home))}`,
      `export USERPROFILE=${shellLiteral(toBash(context.home))}`,
      `export XDG_CONFIG_HOME=${shellLiteral(toBash(context.xdg))}`,
      `export APPDATA=${shellLiteral(toBash(context.appData))}`,
      `export AUTOPROMPT_INSTALL_ROOT=${shellLiteral(toBash(context.customRoot))}`,
      `export PATH=${shellLiteral([
        toBash(context.bin),
        toBash(NODE_DIRECTORY),
        toBash(PYTHON_DIRECTORY),
        '/usr/bin',
        '/bin',
      ].join(':'))}`,
      'unset AUTOPROMPT_INSTALL_ROOT_CLIENT PI_CODING_AGENT_DIR PI_CONFIG_DIR',
      'unset OMP_PROFILE PI_PROFILE',
      `. ${shellLiteral(library)}`,
      `_uninstall_read_receipt ${shellLiteral(toBash(context.customRoot))}`,
    ].join('; ')
    return run(BASH, ['--noprofile', '--norc', '-c', command])
  }
  const library = path.join(ROOT, 'scripts', 'install', 'lib', 'install-lib.ps1')
  const command = [
    `. ${powershellLiteral(library)}`,
    `$receipt = Read-UninstallReceipt -ConfigRoot ${powershellLiteral(context.customRoot)}`,
    'if ($receipt -is [int]) { exit $receipt }',
    'exit 0',
  ].join('; ')
  const env = {
    ...context.psEnv,
    AUTOPROMPT_INSTALL_ROOT: context.customRoot,
  }
  delete env.AUTOPROMPT_INSTALL_ROOT_CLIENT
  delete env.PI_CODING_AGENT_DIR
  delete env.PI_CONFIG_DIR
  delete env.OMP_PROFILE
  delete env.PI_PROFILE
  return run(POWERSHELL, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command,
  ], { env })
}

function runPowerShellReceiptOwnership(
  context, detachedRoot, ownedFile, ownedDirectory, rejectedRootLocal,
) {
  const library = path.join(ROOT, 'scripts', 'install', 'lib', 'install-lib.ps1')
  const command = [
    `. ${powershellLiteral(library)}`,
    `$receipt = Read-UninstallReceipt -ConfigRoot ${powershellLiteral(context.customRoot)}`,
    'if ($receipt -is [int]) { exit $receipt }',
    `$script:AutopromptReceiptOmpManaged = $true`,
    `$script:AutopromptReceiptOmpDetachedRoot = ${powershellLiteral(detachedRoot)}`,
    `if (-not (Test-UninstallProviderPath -Name 'omp' -ConfigRoot ` +
      `${powershellLiteral(context.customRoot)} -Path ${powershellLiteral(ownedFile)})) { exit 20 }`,
    `if (-not (Test-UninstallProviderPath -Name 'omp' -ConfigRoot ` +
      `${powershellLiteral(context.customRoot)} -Path ${powershellLiteral(ownedDirectory)})) { exit 21 }`,
    `if (Test-UninstallProviderPath -Name 'omp' -ConfigRoot ` +
      `${powershellLiteral(context.customRoot)} -Path ${powershellLiteral(rejectedRootLocal)}) { exit 22 }`,
    'exit 0',
  ].join('; ')
  return run(POWERSHELL, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command,
  ], { env: context.psEnv })
}

function runPowerShellDetachedContainment(
  context, detachedRoot, detachedAgents, detachedFile,
) {
  const library = path.join(ROOT, 'scripts', 'install', 'lib', 'install-lib.ps1')
  const command = [
    `. ${powershellLiteral(library)}`,
    '$script:AutopromptReceiptOmpManaged = $true',
    `$script:AutopromptReceiptOmpDetachedRoot = ${powershellLiteral(detachedRoot)}`,
    `if (Test-UninstallProviderPath -Name 'omp' -ConfigRoot ` +
      `${powershellLiteral(context.customRoot)} -Path ${powershellLiteral(detachedAgents)}) { exit 30 }`,
    `if (Test-UninstallProviderPath -Name 'omp' -ConfigRoot ` +
      `${powershellLiteral(context.customRoot)} -Path ${powershellLiteral(detachedFile)}) { exit 31 }`,
    'exit 0',
  ].join('; ')
  return run(POWERSHELL, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command,
  ], { env: context.psEnv })
}

function runBashDetachedContainment(
  context, detachedRoot, detachedAgents, detachedFile,
) {
  const library = toBash(path.join(
    ROOT, 'scripts', 'install', 'lib', 'install-lib.sh',
  ))
  const command = [
    `export HOME=${shellLiteral(toBash(context.home))}`,
    `export USERPROFILE=${shellLiteral(toBash(context.home))}`,
    `export AUTOPROMPT_INSTALL_ROOT=${shellLiteral(toBash(context.customRoot))}`,
    `export AUTOPROMPT_INSTALL_ROOT_CLIENT=${shellLiteral('omp')}`,
    `. ${shellLiteral(library)}`,
    'UNINSTALL_RC_OMP_MANAGED=1',
    `UNINSTALL_RC_OMP_DETACHED_ROOT=${shellLiteral(detachedRoot)}`,
    `! _uninstall_provider_owns_path "$AUTOPROMPT_INSTALL_ROOT" omp ` +
      `${shellLiteral(detachedAgents)}`,
    `! _uninstall_provider_owns_path "$AUTOPROMPT_INSTALL_ROOT" omp ` +
      `${shellLiteral(detachedFile)}`,
  ].join('; ')
  return run(BASH, ['--noprofile', '--norc', '-c', command])
}

function runSplitOmpInstall(port, context, configDirectory) {
  if (port === 'shell') {
    const script = toBash(path.join(ROOT, 'scripts', 'install', 'install.sh'))
    const command = [
      `export HOME=${shellLiteral(toBash(context.home))}`,
      `export XDG_CONFIG_HOME=${shellLiteral(toBash(context.xdg))}`,
      `export APPDATA=${shellLiteral(toBash(context.appData))}`,
      `export PI_CONFIG_DIR=${shellLiteral(configDirectory)}`,
      `export PI_CODING_AGENT_DIR=${shellLiteral(toBash(context.customRoot))}`,
      'unset AUTOPROMPT_INSTALL_ROOT AUTOPROMPT_INSTALL_ROOT_CLIENT OMP_PROFILE PI_PROFILE',
      `export PATH=${shellLiteral([
        toBash(context.bin),
        toBash(NODE_DIRECTORY),
        toBash(PYTHON_DIRECTORY),
        '/usr/bin',
        '/bin',
      ].join(':'))}`,
      `. ${shellLiteral(script)} omp`,
    ].join('; ')
    return run(BASH, ['--noprofile', '--norc', '-c', command])
  }
  const installEnv = {
    ...context.psEnv,
    PI_CODING_AGENT_DIR: context.customRoot,
    PI_CONFIG_DIR: configDirectory,
  }
  delete installEnv.AUTOPROMPT_INSTALL_ROOT
  delete installEnv.AUTOPROMPT_INSTALL_ROOT_CLIENT
  delete installEnv.OMP_PROFILE
  delete installEnv.PI_PROFILE
  return runPowerShellLifecycleScript(
    'install', 'omp', { ...context, psEnv: installEnv },
  )
}

function writeFakeClaude(context) {
  const shellTarget = path.join(context.bin, 'claude')
  fs.writeFileSync(shellTarget, "#!/bin/sh\nprintf 'Claude Code 2.1.232\\n'\n")
  fs.chmodSync(shellTarget, 0o755)
  if (process.platform === 'win32') {
    fs.writeFileSync(
      path.join(context.bin, 'claude.cmd'),
      '@echo off\r\necho Claude Code 2.1.232\r\n',
    )
  }
}

function receiptPathKey(value) {
  const normalized = value.replaceAll('\\', '/')
    .replace(/^\/([A-Za-z])\//, '$1:/')
    .replace(/\/$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function detachedReceiptAuthority(receipt, nativeRoot) {
  const root = receiptPathKey(nativeRoot)
  const isDetached = value => {
    const candidate = receiptPathKey(value)
    return candidate === root || candidate.startsWith(`${root}/`)
  }
  return {
    files: receipt.files.filter(isDetached).map(receiptPathKey).sort(),
    createdDirectories: receipt.createdDirectories
      .filter(isDetached).map(receiptPathKey).sort(),
    configEdits: receipt.configEdits
      .filter(edit => isDetached(edit.file) || (edit.backup && isDetached(edit.backup)))
      .map(edit => ({
        file: receiptPathKey(edit.file),
        backup: edit.backup ? receiptPathKey(edit.backup) : '',
        kind: edit.kind,
        path: edit.path,
        value: edit.value,
      })),
    backup: receipt.backup && isDetached(receipt.backup)
      ? receiptPathKey(receipt.backup)
      : '',
  }
}

function assertPersistedDetachedReceipt(port, receiptPath, nativeRoot, authority) {
  const migrated = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
  assert.equal(
    migrated.ompManaged,
    true,
    `${port}: migrated OMP ownership was not persisted`,
  )
  assert.equal(
    typeof migrated.ompDetachedRoot,
    'string',
    `${port}: migrated detached root was not persisted`,
  )
  assert.equal(
    receiptPathKey(migrated.ompDetachedRoot),
    receiptPathKey(nativeRoot),
    `${port}: migrated detached root was not persisted`,
  )
  assert.deepEqual(
    detachedReceiptAuthority(migrated, nativeRoot),
    authority,
    `${port}: migrated receipt lost detached manifest authority`,
  )
}

function assertDetachedMetadataAndLegacyReceipt(port, context, nativeRoot, receiptPath) {
  const currentReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
  assert.ok(currentReceipt.configEdits.length > 0, `${port}: no config edit`)
  const forgedMetadata = [
    {
      label: 'truncated detached roles',
      mutate(receipt) {
        const index = receipt.files.findIndex((file) => (
          /[\\/]agent[\\/]agents[\\/]ap-manager\.md$/.test(file)
        ))
        assert.notEqual(index, -1, `${port}: detached role missing from receipt`)
        receipt.files.splice(index, 1)
      },
    },
    {
      label: 'created directory',
      mutate(receipt) {
        receipt.createdDirectories.push(path.join(nativeRoot, 'agents', 'scratch'))
      },
    },
    {
      label: 'config edit',
      mutate(receipt) {
        receipt.configEdits.push({
          ...receipt.configEdits[0],
          file: path.join(nativeRoot, 'agents', 'forged-config.yml'),
        })
      },
    },
    {
      label: 'backup',
      mutate(receipt) {
        receipt.backup = path.join(nativeRoot, 'agents', 'forged.bak')
      },
    },
  ]
  for (const variant of forgedMetadata) {
    const forged = structuredClone(currentReceipt)
    variant.mutate(forged)
    fs.writeFileSync(receiptPath, `${JSON.stringify(forged, null, 2)}\n`)
    const validation = runReceiptValidation(port, context)
    assert.notEqual(
      validation.status,
      0,
      runDiagnostic(`${port} accepted detached ${variant.label}`, validation),
    )
    assert.match(
      `${validation.stdout}\n${validation.stderr}`,
      /corrupt-receipt.*path-outside-root/s,
      runDiagnostic(`${port} detached ${variant.label}`, validation),
    )
  }
  for (const [label, value] of [
    ['string', 'true'],
    ['number', 1],
    ['null', null],
  ]) {
    const malformed = structuredClone(currentReceipt)
    malformed.ompManaged = value
    fs.writeFileSync(receiptPath, `${JSON.stringify(malformed, null, 2)}\n`)
    const validation = runReceiptValidation(port, context)
    assert.notEqual(
      validation.status,
      0,
      runDiagnostic(`${port} accepted ${label} ompManaged`, validation),
    )
    assert.match(
      `${validation.stdout}\n${validation.stderr}`,
      /corrupt-receipt.*detail=grammar/s,
      runDiagnostic(`${port} malformed ${label} ompManaged`, validation),
    )
  }
  const legacyReceipt = structuredClone(currentReceipt)
  delete legacyReceipt.ompManaged
  delete legacyReceipt.ompDetachedRoot
  fs.writeFileSync(receiptPath, `${JSON.stringify(legacyReceipt, null, 2)}\n`)
  const legacyValidation = runReceiptValidation(port, context)
  assert.equal(
    legacyValidation.status,
    0,
    runDiagnostic(`${port} legacy receipt validation`, legacyValidation),
  )
  return detachedReceiptAuthority(currentReceipt, nativeRoot)
}

function makeContext(provider) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), `autoprompt-${provider}-posix-`))
  const context = {
    sandbox,
    home: path.join(sandbox, 'home'),
    xdg: path.join(sandbox, 'xdg'),
    appData: path.join(sandbox, 'appdata'),
    localAppData: path.join(sandbox, 'localappdata'),
    temp: path.join(sandbox, 'tmp'),
    bin: path.join(sandbox, 'bin'),
    customRoot: path.join(sandbox, `${provider}-root`),
  }
  for (const directory of [
    context.home,
    context.xdg,
    context.appData,
    context.localAppData,
    context.temp,
    context.bin,
    context.customRoot,
  ]) fs.mkdirSync(directory, { recursive: true })
  for (const entry of Object.values(PROVIDERS)) {
    const target = path.join(context.bin, entry.command)
    fs.writeFileSync(target, `#!/bin/sh\nprintf '%s\\n' '${entry.version}'\n`)
    fs.chmodSync(target, 0o755)
    if (process.platform === 'win32') {
      fs.writeFileSync(
        path.join(context.bin, `${entry.command}.cmd`),
        `@echo off\r\necho ${entry.version}\r\n`,
      )
    }
  }
  context.psEnv = {
    ...process.env,
    APPDATA: context.appData,
    AUTOPROMPT_INSTALL_ROOT: context.customRoot,
    HOME: context.home,
    LOCALAPPDATA: context.localAppData,
    PATH: [context.bin, NODE_DIRECTORY, PYTHON_DIRECTORY, process.env.PATH || '']
      .join(path.delimiter),
    TEMP: context.temp,
    TMP: context.temp,
    USERPROFILE: context.home,
    XDG_CONFIG_HOME: context.xdg,
  }
  return context
}

function nativeTarget(provider, root) {
  switch (provider) {
    case 'omp': return path.join(root, 'agents', 'ap-manager.md')
    case 'deepseek': return path.join(
      root,
      '.agent-presets',
      'autoprompt',
      'agent.cordis.yml',
    )
    case 'reasonix': return path.join(root, 'skills', 'ap-manager', 'SKILL.md')
    default: throw new Error(`unknown provider: ${provider}`)
  }
}

function posixDefaultRoot(provider, context) {
  switch (provider) {
    case 'omp': return path.join(context.home, '.omp', 'agent')
    case 'deepseek': return path.join(context.home, '.dsh')
    case 'reasonix': return path.join(context.home, '.reasonix')
    default: throw new Error(`unknown provider: ${provider}`)
  }
}

function foreignTarget(provider, root) {
  switch (provider) {
    case 'omp': return path.join(root, 'agents', 'notes.txt')
    case 'deepseek': return path.join(
      root,
      '.agent-presets',
      'autoprompt',
      'notes.txt',
    )
    case 'reasonix': return path.join(root, 'skills', 'ap-manager', 'notes.txt')
    default: throw new Error(`unknown provider: ${provider}`)
  }
}

function providerConfig(provider, root) {
  if (provider === 'omp') {
    return {
      file: path.join(root, 'config.yml'),
      before: 'theme: dark\ntask:\n  maxRecursionDepth: 2\n',
      configured: /maxRecursionDepth: 4/
    }
  }
  if (provider === 'reasonix') {
    return {
      file: path.join(root, 'config.toml'),
      before: '[model]\nname = "test"\n\n[agent]\nmax_subagent_depth = 2\n',
      configured: /max_subagent_depth = 4/
    }
  }
  return null
}

function sourcePayload(provider, context) {
  const source = fs.readFileSync(path.join(ROOT, 'agents', provider, 'SKILL.md'), 'utf8')
    .replaceAll('\r\n', '\n')
  const closing = source.indexOf('\n---\n', 4)
  assert.ok(source.startsWith('---\n') && closing > 4, provider)
  const frontmatter = source.slice(4, closing)
  const descriptionValue = frontmatter.match(/^description:\s*(.+)$/m)?.[1]
  assert.ok(descriptionValue, `${provider}: missing description`)
  const description = descriptionValue.startsWith('"')
    ? JSON.parse(descriptionValue)
    : descriptionValue
  const bodyFile = path.join(context.sandbox, 'repair-body.txt')
  const descriptionFile = path.join(context.sandbox, 'repair-description.txt')
  fs.writeFileSync(bodyFile, source.slice(closing + 5))
  fs.writeFileSync(descriptionFile, description)
  return { bodyFile, descriptionFile }
}

function runDirectRepair(port, provider, context) {
  const payload = sourcePayload(provider, context)
  const library = path.join(ROOT, 'scripts', 'install', 'lib',
    port === 'shell' ? 'install-lib.sh' : 'install-lib.ps1')
  if (port === 'shell') {
    const root = toBash(context.customRoot)
    const command = [
      `export HOME=${shellLiteral(toBash(context.home))}`,
      `export XDG_CONFIG_HOME=${shellLiteral(toBash(context.xdg))}`,
      `export APPDATA=${shellLiteral(toBash(context.appData))}`,
      `export AUTOPROMPT_INSTALL_ROOT=${shellLiteral(root)}`,
      `export PATH=${shellLiteral([
        toBash(context.bin), toBash(NODE_DIRECTORY), toBash(PYTHON_DIRECTORY),
        '/usr/bin', '/bin',
      ].join(':'))}`,
      `. ${shellLiteral(toBash(library))}`,
      `test_autoprompt_install_root_contract ${shellLiteral(provider)}`,
      `body="$(cat ${shellLiteral(toBash(payload.bodyFile))})"`,
      `description="$(cat ${shellLiteral(toBash(payload.descriptionFile))})"`,
      `uninstall_repair ${shellLiteral(root)} ${shellLiteral(provider)} autoprompt "$description" "$body"`,
    ].join('; ')
    return run(BASH, ['--noprofile', '--norc', '-c', command], {
      timeout: 300000,
    })
  }
  const command = [
    `. ${powershellLiteral(library)}`,
    `$contract = Test-AutopromptInstallRootContract -Target ${powershellLiteral(provider)}`,
    'if (-not $contract) { exit 90 }',
    `$body = [IO.File]::ReadAllText(${powershellLiteral(payload.bodyFile)})`,
    `$description = [IO.File]::ReadAllText(${powershellLiteral(payload.descriptionFile)})`,
    `$code = Repair-Install -ConfigRoot ${powershellLiteral(context.customRoot)} ` +
      `-Name ${powershellLiteral(provider)} -SkillName autoprompt ` +
      '-Description $description -Body $body',
    'exit $code',
  ].join('; ')
  return run(POWERSHELL, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command,
  ], { env: context.psEnv, timeout: 300000 })
}

test('POSIX lifecycle installs, diagnoses, repairs, and removes each new harness', {
  timeout: 600000,
}, () => {
  for (const provider of Object.keys(PROVIDERS)) {
    const context = makeContext(provider)
    const sentinel = path.join(context.customRoot, 'keep-user.txt')
    fs.writeFileSync(sentinel, 'keep\n')
    try {
      const installed = runLifecycleScript('install', provider, context)
      assert.equal(installed.status, 0, `${provider} install\n${installed.stdout}\n${installed.stderr}`)
      const installedSkill = fs.readFileSync(path.join(
        context.customRoot,
        'skills',
        'autoprompt',
        'SKILL.md',
      ), 'utf8')
      if (provider === 'reasonix') {
        assert.match(installedSkill, /^invocation: manual$/m)
      } else {
        assert.match(installedSkill, /^user-invocable: true$/m)
        assert.match(installedSkill, /^disable-model-invocation: true$/m)
      }
      const target = nativeTarget(provider, context.customRoot)
      assert.equal(fs.existsSync(target), true, `${provider}: native target missing`)
      const foreign = foreignTarget(provider, context.customRoot)
      fs.mkdirSync(path.dirname(foreign), { recursive: true })
      fs.writeFileSync(foreign, 'foreign user file\n')

      const healthy = runLifecycleScript('doctor', provider, context, true)
      assert.equal(healthy.status, 0, `${provider} doctor\n${healthy.stdout}\n${healthy.stderr}`)
      assert.match(healthy.stdout, new RegExp(`^${provider}\\s+yes\\s+yes\\s+yes\\s+`, 'm'))
      assert.match(healthy.stdout, /extras=complete/)

      fs.appendFileSync(target, '\ntampered\n')
      const broken = runLifecycleScript('doctor', provider, context, true)
      assert.notEqual(broken.status, 0, `${provider}: tamper was not detected`)

      const repaired = runLifecycleScript('install', provider, context)
      assert.equal(repaired.status, 0, `${provider} repair\n${repaired.stdout}\n${repaired.stderr}`)
      const repairedDoctor = runLifecycleScript('doctor', provider, context, true)
      assert.equal(
        repairedDoctor.status,
        0,
        `${provider} repaired doctor\n${repairedDoctor.stdout}\n${repairedDoctor.stderr}`,
      )

      const receipt = JSON.parse(fs.readFileSync(
        path.join(context.customRoot, '.autoprompt-install-receipt.json'),
        'utf8',
      ))
      const removed = runLifecycleScript('uninstall', provider, context)
      assert.equal(removed.status, 0, `${provider} uninstall\n${removed.stdout}\n${removed.stderr}`)
      for (const managed of receipt.files) assert.equal(fs.existsSync(managed), false, managed)
      assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep\n')
      assert.equal(fs.readFileSync(foreign, 'utf8'), 'foreign user file\n')
    } finally {
      fs.rmSync(context.sandbox, { recursive: true, force: true })
    }
  }
})

test('forged receipts cannot make either uninstall port delete outside files', {
  timeout: 600000,
}, () => {
  for (const port of ['shell', 'powershell']) {
    for (const provider of Object.keys(PROVIDERS)) {
      const context = makeContext(`${provider}-forged-${port}`)
      try {
        const installed = port === 'shell'
          ? runLifecycleScript('install', provider, context)
          : runPowerShellLifecycleScript('install', provider, context)
        assert.equal(
          installed.status,
          0,
          `${port} ${provider} install\n${installed.stdout}\n${installed.stderr}`,
        )

        const managed = nativeTarget(provider, context.customRoot)
        const outside = path.join(context.sandbox, 'outside-user-file.txt')
        fs.writeFileSync(outside, 'must survive\n')
        const receiptPath = path.join(
          context.customRoot,
          '.autoprompt-install-receipt.json',
        )
        const originalReceipt = fs.readFileSync(receiptPath, 'utf8')
        const forgedReceipt = JSON.parse(originalReceipt)
        forgedReceipt.files.push(outside)
        fs.writeFileSync(receiptPath, `${JSON.stringify(forgedReceipt, null, 2)}\n`)

        const refused = port === 'shell'
          ? runLifecycleScript('uninstall', provider, context)
          : runPowerShellLifecycleScript('uninstall', provider, context)
        assert.notEqual(refused.status, 0, `${port} ${provider}: forged receipt accepted`)
        assert.match(
          `${refused.stdout}\n${refused.stderr}`,
          /corrupt-receipt.*path-outside-root/s,
          `${port} ${provider}`,
        )
        assert.equal(fs.readFileSync(outside, 'utf8'), 'must survive\n')
        assert.equal(fs.existsSync(managed), true, `${port} ${provider}: partial uninstall`)
        assert.equal(fs.existsSync(receiptPath), true, `${port} ${provider}: receipt removed`)

        fs.writeFileSync(receiptPath, originalReceipt)
        const removed = port === 'shell'
          ? runLifecycleScript('uninstall', provider, context)
          : runPowerShellLifecycleScript('uninstall', provider, context)
        assert.equal(
          removed.status,
          0,
          `${port} ${provider} cleanup\n${removed.stdout}\n${removed.stderr}`,
        )
        assert.equal(fs.readFileSync(outside, 'utf8'), 'must survive\n')
      } finally {
        fs.rmSync(context.sandbox, { recursive: true, force: true })
      }
    }
  }
})

test('OMP custom-root receipts cannot claim an unrecorded detached tree', {
  timeout: 600000,
}, () => {
  for (const port of ['shell', 'powershell']) {
    const context = makeContext(`omp-unrecorded-detached-${port}`)
    const detached = path.join(
      context.home,
      '.omp',
      'agent',
      'agents',
      'ap-forged.md',
    )
    try {
      const installed = port === 'shell'
        ? runLifecycleScript('install', 'omp', context)
        : runPowerShellLifecycleScript('install', 'omp', context)
      assert.equal(
        installed.status,
        0,
        runDiagnostic(`${port} install`, installed),
      )

      fs.mkdirSync(path.dirname(detached), { recursive: true })
      fs.writeFileSync(detached, `${port} must survive\n`)
      const receiptPath = path.join(
        context.customRoot,
        '.autoprompt-install-receipt.json',
      )
      const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
      receipt.ompDetachedRoot = path.join(context.home, '.omp', 'agent')
      receipt.files.push(detached)
      fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)

      const refused = port === 'shell'
        ? runLifecycleScript('uninstall', 'omp', context)
        : runPowerShellLifecycleScript('uninstall', 'omp', context)
      assert.notEqual(refused.status, 0, `${port}: detached forgery accepted`)
      assert.match(
        `${refused.stdout}\n${refused.stderr}`,
        /corrupt-receipt.*path-outside-root/s,
        runDiagnostic(`${port} forged uninstall`, refused),
      )
      assert.equal(fs.readFileSync(detached, 'utf8'), `${port} must survive\n`)
      assert.equal(fs.existsSync(receiptPath), true, `${port}: receipt removed`)
    } finally {
      fs.rmSync(context.sandbox, { recursive: true, force: true })
    }
  }
})

test('Linux and macOS root emulation follows each harness home contract', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-new-roots-'))
  try {
    const home = toBash(path.join(sandbox, 'home'))
    const library = toBash(path.join(ROOT, 'scripts', 'install', 'lib', 'install-lib.sh'))
    for (const ostype of ['linux-gnu', 'darwin23']) {
      const command = [
        `export HOME=${shellLiteral(home)}`,
        `export OSTYPE=${shellLiteral(ostype)}`,
        'unset OS MSYSTEM PI_CODING_AGENT_DIR DSH_HOME REASONIX_HOME AUTOPROMPT_INSTALL_ROOT',
        `. ${shellLiteral(library)}`,
        "printf '%s\\n' \"$(autoprompt_config_root omp)\" \"$(autoprompt_config_root deepseek)\" \"$(autoprompt_config_root reasonix)\"",
      ].join('; ')
      const completed = run(BASH, ['--noprofile', '--norc', '-c', command])
      assert.equal(completed.status, 0, completed.stderr)
      assert.deepEqual(completed.stdout.trim().split(/\r?\n/), [
        `${home}/.omp/agent`,
        `${home}/.dsh`,
        `${home}/.reasonix`,
      ])
    }
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('Linux and macOS simulations complete default-root install, doctor, and uninstall', {
  timeout: 1800000,
}, () => {
  const requestedPlatform = process.env.AUTOPROMPT_TEST_POSIX_PLATFORM
  const requestedProvider = process.env.AUTOPROMPT_TEST_PROVIDER
  const platforms = requestedPlatform ? [requestedPlatform] : ['linux', 'macos']
  const providers = requestedProvider ? [requestedProvider] : Object.keys(PROVIDERS)
  assert.ok(
    platforms.every(platform => ['linux', 'macos'].includes(platform)),
    `unsupported simulated platform: ${requestedPlatform}`,
  )
  assert.ok(
    providers.every(provider => Object.hasOwn(PROVIDERS, provider)),
    `unsupported simulated provider: ${requestedProvider}`,
  )
  for (const platform of platforms) {
    for (const provider of providers) {
      const context = makeContext(`${platform}-${provider}-default`)
      const root = posixDefaultRoot(provider, context)
      try {
        const installed = runPosixDefaultLifecycleScript(
          'install', provider, context, platform,
        )
        assert.equal(
          installed.status,
          0,
          runDiagnostic(`${platform} ${provider} install`, installed),
        )
        assert.equal(
          fs.existsSync(nativeTarget(provider, root)),
          true,
          `${platform} ${provider}: native target missing`,
        )

        const healthy = runPosixDefaultLifecycleScript(
          'doctor', provider, context, platform, true,
        )
        assert.equal(
          healthy.status,
          0,
          runDiagnostic(`${platform} ${provider} doctor`, healthy),
        )
        assert.match(healthy.stdout, /extras=complete/)

        const foreign = foreignTarget(provider, root)
        fs.mkdirSync(path.dirname(foreign), { recursive: true })
        fs.writeFileSync(foreign, `${platform} user file\n`)
        const removed = runPosixDefaultLifecycleScript(
          'uninstall', provider, context, platform,
        )
        assert.equal(
          removed.status,
          0,
          runDiagnostic(`${platform} ${provider} uninstall`, removed),
        )
        assert.equal(fs.readFileSync(foreign, 'utf8'), `${platform} user file\n`)
        assert.equal(
          fs.existsSync(path.join(root, '.autoprompt-install-receipt.json')),
          false,
        )
      } finally {
        fs.rmSync(context.sandbox, { recursive: true, force: true })
      }
    }
  }
})

test('Claude ownership does not block a first detached OMP install in a shared root', {
  timeout: 1200000,
}, () => {
  const requestedPort = process.env.AUTOPROMPT_TEST_PORT
  assert.ok(
    !requestedPort || ['shell', 'powershell'].includes(requestedPort),
    `unsupported AUTOPROMPT_TEST_PORT: ${requestedPort}`,
  )
  const ports = requestedPort ? [requestedPort] : ['shell', 'powershell']
  for (const port of ports) {
    const context = makeContext(`claude-before-detached-omp-${port}`)
    const nativeRoot = path.join(context.home, '.omp-after-claude', 'agent')
    const claudeRole = nativeTarget('omp', context.customRoot)
    const detachedRole = nativeTarget('omp', nativeRoot)
    const deepseekRole = nativeTarget('deepseek', context.customRoot)
    const claudeForeign = path.join(context.customRoot, 'agents', 'user-agent.md')
    const detachedForeign = foreignTarget('omp', nativeRoot)
    const receiptPath = path.join(
      context.customRoot,
      '.autoprompt-install-receipt.json',
    )
    writeFakeClaude(context)
    try {
      const claudeInstalled = port === 'shell'
        ? runLifecycleScript('install', 'claude', context)
        : runPowerShellLifecycleScript('install', 'claude', context)
      assert.equal(
        claudeInstalled.status,
        0,
        runDiagnostic(`${port} Claude install`, claudeInstalled),
      )
      assert.equal(fs.existsSync(claudeRole), true, `${port}: Claude role missing`)
      fs.writeFileSync(claudeForeign, `${port} Claude user agent\n`)
      const claudeReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
      assert.ok(
        claudeReceipt.files.some(file => (
          receiptPathKey(file) === receiptPathKey(claudeRole)
        )),
        `${port}: Claude receipt did not exercise root-local ap role ownership`,
      )
      assert.equal(
        claudeReceipt.ompDetachedRoot,
        null,
        `${port}: Claude-only receipt claimed prior OMP detached authority`,
      )
      assert.notEqual(
        claudeReceipt.ompManaged,
        true,
        `${port}: Claude-only receipt claimed prior OMP ownership`,
      )

      const ompInstalled = runSplitOmpInstall(port, context, '.omp-after-claude')
      assert.equal(
        ompInstalled.status,
        0,
        runDiagnostic(`${port} first detached OMP install`, ompInstalled),
      )
      assert.equal(fs.existsSync(detachedRole), true, `${port}: detached OMP role missing`)
      assert.equal(fs.existsSync(claudeRole), true, `${port}: Claude role was displaced`)
      const sharedReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
      assert.equal(
        receiptPathKey(sharedReceipt.ompDetachedRoot),
        receiptPathKey(nativeRoot),
        `${port}: detached OMP authority was not recorded`,
      )
      assert.equal(
        sharedReceipt.ompManaged,
        true,
        `${port}: detached OMP ownership was not recorded`,
      )
      fs.mkdirSync(path.dirname(detachedForeign), { recursive: true })
      fs.writeFileSync(detachedForeign, `${port} detached user file\n`)

      const deepseekInstalled = port === 'shell'
        ? runLifecycleScript('install', 'deepseek', context)
        : runPowerShellLifecycleScript('install', 'deepseek', context)
      assert.equal(
        deepseekInstalled.status,
        0,
        runDiagnostic(`${port} DeepSeek shared-root rewrite`, deepseekInstalled),
      )
      assert.equal(fs.existsSync(deepseekRole), true, `${port}: DeepSeek role missing`)
      const rewrittenReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
      assert.equal(
        rewrittenReceipt.ompManaged,
        true,
        `${port}: another provider rewrite dropped OMP ownership`,
      )
      assert.equal(
        receiptPathKey(rewrittenReceipt.ompDetachedRoot),
        receiptPathKey(nativeRoot),
        `${port}: another provider rewrite dropped detached authority`,
      )

      const ompRemoved = port === 'shell'
        ? runLifecycleScript('uninstall', 'omp', context)
        : runPowerShellLifecycleScript('uninstall', 'omp', context)
      assert.equal(
        ompRemoved.status,
        0,
        runDiagnostic(`${port} OMP uninstall`, ompRemoved),
      )
      assert.equal(fs.existsSync(detachedRole), false, `${port}: OMP role remains`)
      assert.equal(fs.existsSync(claudeRole), true, `${port}: OMP removed Claude role`)
      assert.equal(fs.existsSync(deepseekRole), true, `${port}: OMP removed DeepSeek role`)
      assert.equal(
        fs.readFileSync(detachedForeign, 'utf8'),
        `${port} detached user file\n`,
      )
      assert.equal(fs.readFileSync(claudeForeign, 'utf8'), `${port} Claude user agent\n`)
      assert.equal(fs.existsSync(receiptPath), true, `${port}: shared receipt removed early`)
      const receiptAfterOmp = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
      assert.notEqual(
        receiptAfterOmp.ompManaged,
        true,
        `${port}: OMP uninstall retained provider ownership`,
      )
      assert.equal(
        receiptAfterOmp.ompDetachedRoot,
        null,
        `${port}: OMP uninstall retained detached authority`,
      )

      const deepseekRemoved = port === 'shell'
        ? runLifecycleScript('uninstall', 'deepseek', context)
        : runPowerShellLifecycleScript('uninstall', 'deepseek', context)
      assert.equal(
        deepseekRemoved.status,
        0,
        runDiagnostic(`${port} DeepSeek cleanup`, deepseekRemoved),
      )
      assert.equal(fs.existsSync(deepseekRole), false, `${port}: DeepSeek role remains`)
      assert.equal(fs.existsSync(claudeRole), true, `${port}: DeepSeek removed Claude role`)

      const claudeRemoved = port === 'shell'
        ? runLifecycleScript('uninstall', 'claude', context)
        : runPowerShellLifecycleScript('uninstall', 'claude', context)
      assert.equal(
        claudeRemoved.status,
        0,
        runDiagnostic(`${port} Claude cleanup`, claudeRemoved),
      )
      assert.equal(fs.existsSync(claudeRole), false, `${port}: Claude role remains`)
      assert.equal(fs.readFileSync(claudeForeign, 'utf8'), `${port} Claude user agent\n`)
      assert.equal(fs.existsSync(receiptPath), false, `${port}: receipt remains`)
    } finally {
      fs.rmSync(context.sandbox, { recursive: true, force: true })
    }
  }
})

test('PowerShell accepts and uninstalls a Bash shared-root receipt', {
  skip: process.platform !== 'win32',
  timeout: 900000,
}, () => {
  const context = makeContext('omp-bash-receipt-powershell')
  const nativeRoot = path.join(context.home, '.omp-bash-cross-port', 'agent')
  const ompRole = nativeTarget('omp', nativeRoot)
  const claudeRole = nativeTarget('omp', context.customRoot)
  const claudeForeign = path.join(context.customRoot, 'agents', 'user-agent.md')
  const foreign = foreignTarget('omp', nativeRoot)
  const receiptPath = path.join(
    context.customRoot,
    '.autoprompt-install-receipt.json',
  )
  writeFakeClaude(context)
  try {
    const claudeInstalled = runLifecycleScript('install', 'claude', context)
    assert.equal(
      claudeInstalled.status,
      0,
      runDiagnostic('Bash Claude shared-root install', claudeInstalled),
    )
    const ompInstalled = runSplitOmpInstall(
      'shell', context, '.omp-bash-cross-port',
    )
    assert.equal(
      ompInstalled.status,
      0,
      runDiagnostic('Bash OMP split-root install', ompInstalled),
    )
    assert.equal(fs.existsSync(ompRole), true, 'Bash OMP role missing')
    assert.equal(fs.existsSync(claudeRole), true, 'Bash Claude role missing')
    fs.writeFileSync(claudeForeign, 'cross-port Claude user agent\n')
    fs.mkdirSync(path.dirname(foreign), { recursive: true })
    fs.writeFileSync(foreign, 'cross-port Bash user file\n')

    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
    assert.match(
      receipt.ompDetachedRoot,
      /^\/[a-z]\//,
      'Bash receipt did not exercise an MSYS /c/... detached root',
    )
    assert.ok(
      receipt.files.some(file => /^\/[a-z]\//.test(file)),
      'Bash manifest did not exercise MSYS /c/... paths',
    )
    assert.equal(receipt.ompManaged, true, 'Bash receipt omitted OMP ownership')
    const bashOmpRole = receipt.files.find(file => (
      receiptPathKey(file) === receiptPathKey(ompRole)
    ))
    assert.match(
      bashOmpRole,
      /^\/[a-z]\//,
      'Bash receipt did not retain the raw MSYS detached role path',
    )
    const bashDetachedAgents = `${receipt.ompDetachedRoot}/agents`
    assert.ok(
      receipt.createdDirectories.some(directory => (
        receiptPathKey(directory) === receiptPathKey(bashDetachedAgents)
      )),
      'Bash receipt did not record the exact detached agents directory',
    )

    const validation = runReceiptValidation('powershell', context)
    assert.equal(
      validation.status,
      0,
      runDiagnostic('PowerShell validation of Bash receipt', validation),
    )
    const ownership = runPowerShellReceiptOwnership(
      context, receipt.ompDetachedRoot, bashOmpRole, bashDetachedAgents, claudeRole,
    )
    assert.equal(
      ownership.status,
      0,
      runDiagnostic('PowerShell scoped ownership of Bash receipt', ownership),
    )

    const ompRemoved = runPowerShellLifecycleScript('uninstall', 'omp', context)
    assert.equal(
      ompRemoved.status,
      0,
      runDiagnostic('PowerShell OMP uninstall of Bash receipt', ompRemoved),
    )
    assert.equal(fs.existsSync(ompRole), false, 'PowerShell left the OMP role')
    assert.equal(fs.existsSync(claudeRole), true, 'PowerShell removed Claude ownership')
    assert.equal(fs.readFileSync(claudeForeign, 'utf8'), 'cross-port Claude user agent\n')
    assert.equal(fs.readFileSync(foreign, 'utf8'), 'cross-port Bash user file\n')
    assert.equal(fs.existsSync(receiptPath), true, 'PowerShell removed shared receipt early')
    const receiptAfterOmp = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
    assert.notEqual(
      receiptAfterOmp.ompManaged,
      true,
      'PowerShell OMP uninstall retained provider ownership',
    )
    assert.equal(
      receiptAfterOmp.ompDetachedRoot,
      null,
      'PowerShell OMP uninstall retained detached authority',
    )

    const claudeRemoved = runPowerShellLifecycleScript('uninstall', 'claude', context)
    assert.equal(
      claudeRemoved.status,
      0,
      runDiagnostic('PowerShell Claude cleanup of Bash receipt', claudeRemoved),
    )
    assert.equal(fs.existsSync(claudeRole), false, 'PowerShell left Claude role')
    assert.equal(fs.readFileSync(claudeForeign, 'utf8'), 'cross-port Claude user agent\n')
    assert.equal(fs.readFileSync(foreign, 'utf8'), 'cross-port Bash user file\n')
    assert.equal(fs.existsSync(receiptPath), false, 'PowerShell left the receipt')
  } finally {
    fs.rmSync(context.sandbox, { recursive: true, force: true })
  }
})

test('OMP detached ownership rejects a junction escape in both Windows ports', {
  skip: process.platform !== 'win32',
  timeout: 900000,
}, () => {
  const context = makeContext('omp-detached-junction-escape')
  const outside = fs.mkdtempSync(path.join(
    os.tmpdir(), 'autoprompt-omp-detached-outside-',
  ))
  const nativeRoot = path.join(context.home, '.omp-junction-audit', 'agent')
  const nativeAgents = path.join(nativeRoot, 'agents')
  const outsideRole = path.join(outside, 'ap-manager.md')
  const receiptPath = path.join(
    context.customRoot,
    '.autoprompt-install-receipt.json',
  )
  try {
    const installed = runSplitOmpInstall(
      'shell', context, '.omp-junction-audit',
    )
    assert.equal(
      installed.status,
      0,
      runDiagnostic('Bash detached OMP install', installed),
    )
    const receiptBytes = fs.readFileSync(receiptPath)
    const receipt = JSON.parse(receiptBytes)
    assert.match(receipt.ompDetachedRoot, /^\/[a-z]\//)
    const detachedAgents = `${receipt.ompDetachedRoot}/agents`
    const detachedRole = `${detachedAgents}/ap-manager.md`

    fs.rmSync(nativeAgents, { recursive: true, force: true })
    fs.writeFileSync(outsideRole, 'outside junction sentinel\n')
    fs.symlinkSync(outside, nativeAgents, 'junction')
    assert.equal(
      fs.realpathSync.native(nativeAgents).toLowerCase(),
      fs.realpathSync.native(outside).toLowerCase(),
      'fixture did not create an escaping agents junction',
    )

    const powershellOwnership = runPowerShellDetachedContainment(
      context, receipt.ompDetachedRoot, detachedAgents, detachedRole,
    )
    assert.equal(
      powershellOwnership.status,
      0,
      runDiagnostic('PowerShell detached physical ownership', powershellOwnership),
    )
    const bashOwnership = runBashDetachedContainment(
      context, receipt.ompDetachedRoot, detachedAgents, detachedRole,
    )
    assert.equal(
      bashOwnership.status,
      0,
      runDiagnostic('Bash detached physical ownership', bashOwnership),
    )

    for (const port of ['powershell', 'shell']) {
      const validation = runReceiptValidation(port, context)
      assert.notEqual(
        validation.status,
        0,
        `${port}: junctioned detached receipt was accepted`,
      )
      assert.match(
        `${validation.stdout}\n${validation.stderr}`,
        /corrupt-receipt.*(?:path-outside-root|physical|reparse)/s,
        runDiagnostic(`${port} junctioned receipt validation`, validation),
      )
      assert.deepEqual(
        fs.readFileSync(receiptPath),
        receiptBytes,
        `${port}: failed validation changed the receipt`,
      )
      assert.equal(fs.readFileSync(outsideRole, 'utf8'), 'outside junction sentinel\n')
    }

    const powershellUninstall = runPowerShellLifecycleScript(
      'uninstall', 'omp', context,
    )
    assert.notEqual(
      powershellUninstall.status,
      0,
      runDiagnostic('PowerShell junctioned uninstall', powershellUninstall),
    )
    assert.equal(fs.readFileSync(outsideRole, 'utf8'), 'outside junction sentinel\n')
    const bashUninstall = runLifecycleScript('uninstall', 'omp', context)
    assert.notEqual(
      bashUninstall.status,
      0,
      runDiagnostic('Bash junctioned uninstall', bashUninstall),
    )
    assert.equal(fs.readFileSync(outsideRole, 'utf8'), 'outside junction sentinel\n')
    assert.deepEqual(fs.readFileSync(receiptPath), receiptBytes)
  } finally {
    try {
      if (fs.lstatSync(nativeAgents).isSymbolicLink()) fs.unlinkSync(nativeAgents)
    } catch {}
    fs.rmSync(context.sandbox, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  }
})

test('Bash accepts and uninstalls a PowerShell OMP split-root receipt', {
  skip: process.platform !== 'win32',
  timeout: 600000,
}, () => {
  const context = makeContext('omp-powershell-receipt-bash')
  const nativeRoot = path.join(context.home, '.omp-cross-port', 'agent')
  const owned = nativeTarget('omp', nativeRoot)
  const foreign = foreignTarget('omp', nativeRoot)
  const receiptPath = path.join(
    context.customRoot,
    '.autoprompt-install-receipt.json',
  )
  try {
    const installEnv = {
      ...context.psEnv,
      PI_CODING_AGENT_DIR: context.customRoot,
      PI_CONFIG_DIR: '.omp-cross-port',
    }
    delete installEnv.AUTOPROMPT_INSTALL_ROOT
    delete installEnv.AUTOPROMPT_INSTALL_ROOT_CLIENT
    delete installEnv.OMP_PROFILE
    delete installEnv.PI_PROFILE
    const installed = runPowerShellLifecycleScript(
      'install', 'omp', { ...context, psEnv: installEnv },
    )
    assert.equal(
      installed.status,
      0,
      runDiagnostic('PowerShell split-root install', installed),
    )
    assert.equal(fs.existsSync(owned), true, 'PowerShell native role missing')
    fs.mkdirSync(path.dirname(foreign), { recursive: true })
    fs.writeFileSync(foreign, 'cross-port user file\n')

    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
    assert.match(
      receipt.ompDetachedRoot,
      /\\/,
      'PowerShell receipt did not exercise Windows separators',
    )
    assert.ok(
      receipt.files.some(file => file.includes('\\')),
      'PowerShell manifest did not exercise Windows separators',
    )

    const validation = runReceiptValidation('shell', context)
    assert.equal(
      validation.status,
      0,
      runDiagnostic('Bash validation of PowerShell receipt', validation),
    )

    const removed = runLifecycleScript('uninstall', 'omp', context)
    assert.equal(
      removed.status,
      0,
      runDiagnostic('Bash uninstall of PowerShell receipt', removed),
    )
    assert.equal(fs.existsSync(owned), false, 'Bash left the managed native role')
    assert.equal(fs.readFileSync(foreign, 'utf8'), 'cross-port user file\n')
    assert.equal(fs.existsSync(receiptPath), false, 'Bash left the receipt')
  } finally {
    fs.rmSync(context.sandbox, { recursive: true, force: true })
  }
})

test('OMP detached-to-self-contained reinstall requires uninstall first in both ports', {
  timeout: 900000,
}, () => {
  for (const port of ['shell', 'powershell']) {
    const context = makeContext(`omp-layout-transition-${port}`)
    const nativeRoot = path.join(context.home, '.omp-transition', 'agent')
    const detachedRole = nativeTarget('omp', nativeRoot)
    const selfContainedRole = nativeTarget('omp', context.customRoot)
    const receiptPath = path.join(
      context.customRoot,
      '.autoprompt-install-receipt.json',
    )
    try {
      let installed
      if (port === 'shell') {
        const script = toBash(path.join(ROOT, 'scripts', 'install', 'install.sh'))
        const command = [
          `export HOME=${shellLiteral(toBash(context.home))}`,
          `export XDG_CONFIG_HOME=${shellLiteral(toBash(context.xdg))}`,
          `export APPDATA=${shellLiteral(toBash(context.appData))}`,
          `export PI_CONFIG_DIR=${shellLiteral('.omp-transition')}`,
          `export PI_CODING_AGENT_DIR=${shellLiteral(toBash(context.customRoot))}`,
          'unset AUTOPROMPT_INSTALL_ROOT AUTOPROMPT_INSTALL_ROOT_CLIENT OMP_PROFILE PI_PROFILE',
          `export PATH=${shellLiteral([
            toBash(context.bin),
            toBash(NODE_DIRECTORY),
            toBash(PYTHON_DIRECTORY),
            '/usr/bin',
            '/bin',
          ].join(':'))}`,
          `. ${shellLiteral(script)} omp`,
        ].join('; ')
        installed = run(BASH, ['--noprofile', '--norc', '-c', command])
      } else {
        const installEnv = {
          ...context.psEnv,
          PI_CODING_AGENT_DIR: context.customRoot,
          PI_CONFIG_DIR: '.omp-transition',
        }
        delete installEnv.AUTOPROMPT_INSTALL_ROOT
        delete installEnv.AUTOPROMPT_INSTALL_ROOT_CLIENT
        delete installEnv.OMP_PROFILE
        delete installEnv.PI_PROFILE
        installed = runPowerShellLifecycleScript(
          'install', 'omp', { ...context, psEnv: installEnv },
        )
      }
      assert.equal(
        installed.status,
        0,
        runDiagnostic(`${port} split-root install`, installed),
      )
      assert.equal(fs.existsSync(detachedRole), true, `${port}: detached role missing`)
      const receiptBeforeTransition = fs.readFileSync(receiptPath)

      let rejected
      if (port === 'shell') {
        const script = toBash(path.join(ROOT, 'scripts', 'install', 'install.sh'))
        const command = [
          `export HOME=${shellLiteral(toBash(context.home))}`,
          `export XDG_CONFIG_HOME=${shellLiteral(toBash(context.xdg))}`,
          `export APPDATA=${shellLiteral(toBash(context.appData))}`,
          `export AUTOPROMPT_INSTALL_ROOT=${shellLiteral(toBash(context.customRoot))}`,
          'unset AUTOPROMPT_INSTALL_ROOT_CLIENT PI_CODING_AGENT_DIR PI_CONFIG_DIR',
          'unset OMP_PROFILE PI_PROFILE',
          `export PATH=${shellLiteral([
            toBash(context.bin),
            toBash(NODE_DIRECTORY),
            toBash(PYTHON_DIRECTORY),
            '/usr/bin',
            '/bin',
          ].join(':'))}`,
          `. ${shellLiteral(script)} omp`,
        ].join('; ')
        rejected = run(BASH, ['--noprofile', '--norc', '-c', command])
      } else {
        const transitionEnv = { ...context.psEnv }
        delete transitionEnv.AUTOPROMPT_INSTALL_ROOT_CLIENT
        delete transitionEnv.PI_CODING_AGENT_DIR
        delete transitionEnv.PI_CONFIG_DIR
        delete transitionEnv.OMP_PROFILE
        delete transitionEnv.PI_PROFILE
        rejected = runPowerShellLifecycleScript(
          'install', 'omp', { ...context, psEnv: transitionEnv },
        )
      }
      assert.notEqual(
        rejected.status,
        0,
        `${port}: detached-to-self-contained transition was accepted`,
      )
      const rejection = `${rejected.stdout}\n${rejected.stderr}`
      assert.match(rejection, /error=omp-detached-root-layout-transition/i)
      assert.match(rejection, /action=uninstall-first/i)
      assert.deepEqual(
        fs.readFileSync(receiptPath),
        receiptBeforeTransition,
        `${port}: rejected transition changed the receipt`,
      )
      assert.equal(
        fs.existsSync(selfContainedRole),
        false,
        `${port}: rejected transition wrote a self-contained native role`,
      )

      const removed = port === 'shell'
        ? runLifecycleScript('uninstall', 'omp', context)
        : runPowerShellLifecycleScript('uninstall', 'omp', context)
      assert.equal(
        removed.status,
        0,
        [
          runDiagnostic(`${port} cleanup`, removed),
          runDiagnostic(`${port} rejected transition`, rejected),
        ].join('\n'),
      )
      assert.equal(fs.existsSync(detachedRole), false, `${port}: detached role remains`)
      assert.equal(fs.existsSync(receiptPath), false, `${port}: receipt remains`)
    } finally {
      fs.rmSync(context.sandbox, { recursive: true, force: true })
    }
  }
})

test('OMP self-contained-to-detached reinstall requires uninstall first in both ports', {
  timeout: 900000,
}, () => {
  for (const port of ['shell', 'powershell']) {
    const context = makeContext(`omp-inverse-layout-transition-${port}`)
    const nativeRoot = path.join(context.home, '.omp-inverse-transition', 'agent')
    const rootLocalRole = nativeTarget('omp', context.customRoot)
    const detachedRole = nativeTarget('omp', nativeRoot)
    const receiptPath = path.join(
      context.customRoot,
      '.autoprompt-install-receipt.json',
    )
    try {
      const installed = port === 'shell'
        ? runLifecycleScript('install', 'omp', context)
        : runPowerShellLifecycleScript('install', 'omp', context)
      assert.equal(
        installed.status,
        0,
        runDiagnostic(`${port} self-contained install`, installed),
      )
      assert.equal(fs.existsSync(rootLocalRole), true, `${port}: root-local role missing`)
      const receiptBeforeTransition = fs.readFileSync(receiptPath)

      let rejected
      if (port === 'shell') {
        const script = toBash(path.join(ROOT, 'scripts', 'install', 'install.sh'))
        const command = [
          `export HOME=${shellLiteral(toBash(context.home))}`,
          `export XDG_CONFIG_HOME=${shellLiteral(toBash(context.xdg))}`,
          `export APPDATA=${shellLiteral(toBash(context.appData))}`,
          `export PI_CONFIG_DIR=${shellLiteral('.omp-inverse-transition')}`,
          `export PI_CODING_AGENT_DIR=${shellLiteral(toBash(context.customRoot))}`,
          'unset AUTOPROMPT_INSTALL_ROOT AUTOPROMPT_INSTALL_ROOT_CLIENT OMP_PROFILE PI_PROFILE',
          `export PATH=${shellLiteral([
            toBash(context.bin),
            toBash(NODE_DIRECTORY),
            toBash(PYTHON_DIRECTORY),
            '/usr/bin',
            '/bin',
          ].join(':'))}`,
          `. ${shellLiteral(script)} omp`,
        ].join('; ')
        rejected = run(BASH, ['--noprofile', '--norc', '-c', command])
      } else {
        const transitionEnv = {
          ...context.psEnv,
          PI_CODING_AGENT_DIR: context.customRoot,
          PI_CONFIG_DIR: '.omp-inverse-transition',
        }
        delete transitionEnv.AUTOPROMPT_INSTALL_ROOT
        delete transitionEnv.AUTOPROMPT_INSTALL_ROOT_CLIENT
        delete transitionEnv.OMP_PROFILE
        delete transitionEnv.PI_PROFILE
        rejected = runPowerShellLifecycleScript(
          'install', 'omp', { ...context, psEnv: transitionEnv },
        )
      }
      assert.notEqual(
        rejected.status,
        0,
        `${port}: self-contained-to-detached transition was accepted`,
      )
      const rejection = `${rejected.stdout}\n${rejected.stderr}`
      assert.match(rejection, /error=omp-detached-root-layout-transition/i)
      assert.match(rejection, /action=uninstall-first/i)
      assert.deepEqual(
        fs.readFileSync(receiptPath),
        receiptBeforeTransition,
        `${port}: rejected transition changed the receipt`,
      )
      assert.equal(
        fs.existsSync(detachedRole),
        false,
        `${port}: rejected transition wrote a detached native role`,
      )
      assert.equal(
        fs.existsSync(rootLocalRole),
        true,
        `${port}: rejected transition removed the root-local role`,
      )

      const removed = port === 'shell'
        ? runLifecycleScript('uninstall', 'omp', context)
        : runPowerShellLifecycleScript('uninstall', 'omp', context)
      assert.equal(
        removed.status,
        0,
        [
          runDiagnostic(`${port} cleanup`, removed),
          runDiagnostic(`${port} rejected inverse transition`, rejected),
        ].join('\n'),
      )
      assert.equal(fs.existsSync(rootLocalRole), false, `${port}: root-local role remains`)
      assert.equal(fs.existsSync(receiptPath), false, `${port}: receipt remains`)
    } finally {
      fs.rmSync(context.sandbox, { recursive: true, force: true })
    }
  }
})

test('OMP split-root receipts reject detached metadata and migrate legacy state', {
  timeout: 900000,
}, () => {
  const requestedPort = process.env.AUTOPROMPT_TEST_PORT
  assert.ok(
    !requestedPort || ['shell', 'powershell'].includes(requestedPort),
    `unsupported AUTOPROMPT_TEST_PORT: ${requestedPort}`,
  )
  const ports = requestedPort ? [requestedPort] : ['shell', 'powershell']
  for (const port of ports) {
    const context = makeContext(`omp-split-root-${port}`)
    const nativeRoot = path.join(context.home, '.omp-audit', 'agent')
    const owned = nativeTarget('omp', nativeRoot)
    const foreign = foreignTarget('omp', nativeRoot)
    try {
      let installed
      let driftedReinstall
      let removed
      if (port === 'shell') {
        const script = toBash(path.join(ROOT, 'scripts', 'install', 'install.sh'))
        const common = [
          `export HOME=${shellLiteral(toBash(context.home))}`,
          `export XDG_CONFIG_HOME=${shellLiteral(toBash(context.xdg))}`,
          `export APPDATA=${shellLiteral(toBash(context.appData))}`,
          `export PATH=${shellLiteral([
            toBash(context.bin),
            toBash(NODE_DIRECTORY),
            toBash(PYTHON_DIRECTORY),
            '/usr/bin',
            '/bin',
          ].join(':'))}`,
        ]
        const installCommand = [
          ...common,
          `export PI_CONFIG_DIR=${shellLiteral('.omp-audit')}`,
          `export PI_CODING_AGENT_DIR=${shellLiteral(toBash(context.customRoot))}`,
          'unset AUTOPROMPT_INSTALL_ROOT AUTOPROMPT_INSTALL_ROOT_CLIENT OMP_PROFILE PI_PROFILE',
          `. ${shellLiteral(script)} omp`,
        ].join('; ')
        installed = run(BASH, ['--noprofile', '--norc', '-c', installCommand])
        assert.equal(
          installed.status,
          0,
          runDiagnostic(`${port} install`, installed),
        )
        assert.equal(
          fs.existsSync(owned),
          true,
          `${port}: split-root native role was not installed`,
        )
        fs.mkdirSync(path.dirname(foreign), { recursive: true })
        fs.writeFileSync(foreign, `${port} user file\n`)
        const receiptPath = path.join(
          context.customRoot,
          '.autoprompt-install-receipt.json',
        )
        const detachedAuthority = assertDetachedMetadataAndLegacyReceipt(
          port, context, nativeRoot, receiptPath,
        )
        const originalNativeRole = fs.readFileSync(owned)
        fs.appendFileSync(owned, '\nsplit-root-repair-tamper\n')
        const repaired = runDirectRepair(port, 'omp', context)
        assert.equal(
          repaired.status,
          0,
          runDiagnostic(`${port} split-root repair`, repaired),
        )
        assert.match(repaired.stdout, /repair=restored/)
        assert.deepEqual(fs.readFileSync(owned), originalNativeRole)
        assertPersistedDetachedReceipt(
          port, receiptPath, nativeRoot, detachedAuthority,
        )
        const receiptBeforeDrift = fs.readFileSync(receiptPath)
        const driftedInstallCommand = [
          ...common,
          `export PI_CONFIG_DIR=${shellLiteral('.omp-drifted')}`,
          `export PI_CODING_AGENT_DIR=${shellLiteral(toBash(context.customRoot))}`,
          'unset AUTOPROMPT_INSTALL_ROOT AUTOPROMPT_INSTALL_ROOT_CLIENT OMP_PROFILE PI_PROFILE',
          `. ${shellLiteral(script)} omp`,
        ].join('; ')
        driftedReinstall = run(BASH, [
          '--noprofile', '--norc', '-c', driftedInstallCommand,
        ])
        assert.notEqual(
          driftedReinstall.status,
          0,
          `${port}: detached-root drift reinstall was accepted`,
        )
        assert.deepEqual(fs.readFileSync(receiptPath), receiptBeforeDrift)
        const uninstallScript = toBash(path.join(
          ROOT, 'scripts', 'install', 'uninstall.sh',
        ))
        const uninstallCommand = [
          ...common,
          'unset PI_CODING_AGENT_DIR OMP_PROFILE PI_PROFILE',
          `export PI_CONFIG_DIR=${shellLiteral('.omp-drifted')}`,
          `export AUTOPROMPT_INSTALL_ROOT=${shellLiteral(toBash(context.customRoot))}`,
          `. ${shellLiteral(uninstallScript)} omp`,
        ].join('; ')
        removed = run(BASH, ['--noprofile', '--norc', '-c', uninstallCommand])
      } else {
        const installEnv = {
          ...context.psEnv,
          PI_CODING_AGENT_DIR: context.customRoot,
          PI_CONFIG_DIR: '.omp-audit',
        }
        delete installEnv.AUTOPROMPT_INSTALL_ROOT
        delete installEnv.AUTOPROMPT_INSTALL_ROOT_CLIENT
        delete installEnv.OMP_PROFILE
        delete installEnv.PI_PROFILE
        installed = runPowerShellLifecycleScript(
          'install', 'omp', { ...context, psEnv: installEnv },
        )
        assert.equal(
          installed.status,
          0,
          runDiagnostic(`${port} install`, installed),
        )
        assert.equal(
          fs.existsSync(owned),
          true,
          `${port}: split-root native role was not installed`,
        )
        fs.mkdirSync(path.dirname(foreign), { recursive: true })
        fs.writeFileSync(foreign, `${port} user file\n`)
        const receiptPath = path.join(
          context.customRoot,
          '.autoprompt-install-receipt.json',
        )
        const detachedAuthority = assertDetachedMetadataAndLegacyReceipt(
          port, context, nativeRoot, receiptPath,
        )
        const originalNativeRole = fs.readFileSync(owned)
        fs.appendFileSync(owned, '\nsplit-root-repair-tamper\n')
        const repaired = runDirectRepair(port, 'omp', context)
        assert.equal(
          repaired.status,
          0,
          runDiagnostic(`${port} split-root repair`, repaired),
        )
        assert.match(repaired.stdout, /repair=restored/)
        assert.deepEqual(fs.readFileSync(owned), originalNativeRole)
        assertPersistedDetachedReceipt(
          port, receiptPath, nativeRoot, detachedAuthority,
        )
        const receiptBeforeDrift = fs.readFileSync(receiptPath)
        const driftedInstallEnv = {
          ...context.psEnv,
          PI_CODING_AGENT_DIR: context.customRoot,
          PI_CONFIG_DIR: '.omp-drifted',
        }
        delete driftedInstallEnv.AUTOPROMPT_INSTALL_ROOT
        delete driftedInstallEnv.AUTOPROMPT_INSTALL_ROOT_CLIENT
        delete driftedInstallEnv.OMP_PROFILE
        delete driftedInstallEnv.PI_PROFILE
        driftedReinstall = runPowerShellLifecycleScript(
          'install',
          'omp',
          { ...context, psEnv: driftedInstallEnv },
        )
        assert.notEqual(
          driftedReinstall.status,
          0,
          `${port}: detached-root drift reinstall was accepted`,
        )
        assert.deepEqual(fs.readFileSync(receiptPath), receiptBeforeDrift)
        const uninstallEnv = {
          ...context.psEnv,
          AUTOPROMPT_INSTALL_ROOT: context.customRoot,
          PI_CONFIG_DIR: '.omp-drifted',
        }
        delete uninstallEnv.PI_CODING_AGENT_DIR
        delete uninstallEnv.OMP_PROFILE
        delete uninstallEnv.PI_PROFILE
        removed = runPowerShellLifecycleScript(
          'uninstall', 'omp', { ...context, psEnv: uninstallEnv },
        )
      }
      assert.equal(
        removed.status,
        0,
        [
          runDiagnostic(`${port} uninstall`, removed),
          runDiagnostic(`${port} rejected drift reinstall`, driftedReinstall),
        ].join('\n'),
      )
      assert.equal(fs.existsSync(owned), false, `${port}: owned role remains`)
      assert.equal(fs.readFileSync(foreign, 'utf8'), `${port} user file\n`)
      assert.equal(
        fs.existsSync(path.join(context.customRoot, '.autoprompt-install-receipt.json')),
        false,
        `${port}: receipt remains`,
      )
    } finally {
      fs.rmSync(context.sandbox, { recursive: true, force: true })
    }
  }
})

test('OMP roots follow profiles and preserve native task-agent discovery with an agent-dir override', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-omp-roots-'))
  try {
    const home = path.join(sandbox, 'home')
    const custom = path.join(sandbox, 'custom-agent')
    const bashHome = toBash(home)
    const bashCustom = toBash(custom)
    const bashLibrary = toBash(path.join(ROOT, 'scripts', 'install', 'lib', 'install-lib.sh'))
    const bashCommand = [
      `export HOME=${shellLiteral(bashHome)}`,
      `export PI_CODING_AGENT_DIR=${shellLiteral(bashCustom)}`,
      'export PI_CONFIG_DIR=.omp-audit',
      'unset OMP_PROFILE PI_PROFILE AUTOPROMPT_INSTALL_ROOT',
      `. ${shellLiteral(bashLibrary)}`,
      "printf '%s\\n' \"$(autoprompt_config_root omp)\" \"$(autoprompt_native_agents_root omp)\"",
      'export OMP_PROFILE=work PI_PROFILE=legacy',
      "printf '%s\\n' \"$(autoprompt_config_root omp)\" \"$(autoprompt_native_agents_root omp)\"",
    ].join('; ')
    const bashResult = run(BASH, ['--noprofile', '--norc', '-c', bashCommand])
    assert.equal(bashResult.status, 0, bashResult.stderr)
    assert.deepEqual(bashResult.stdout.trim().split(/\r?\n/), [
      bashCustom,
      `${bashHome}/.omp-audit/agent/agents`,
      `${bashHome}/.omp-audit/profiles/work/agent`,
      `${bashHome}/.omp-audit/profiles/work/agent/agents`,
    ])

    const psLibrary = path.join(ROOT, 'scripts', 'install', 'lib', 'install-lib.ps1')
    const psCommand = [
      `$env:HOME = ${powershellLiteral(home)}`,
      `$env:USERPROFILE = ${powershellLiteral(home)}`,
      `$env:PI_CODING_AGENT_DIR = ${powershellLiteral(custom)}`,
      "$env:PI_CONFIG_DIR = '.omp-audit'",
      'Remove-Item Env:OMP_PROFILE, Env:PI_PROFILE, Env:AUTOPROMPT_INSTALL_ROOT -ErrorAction SilentlyContinue',
      `. ${powershellLiteral(psLibrary)}`,
      '[Console]::Out.WriteLine((Get-AutopromptConfigRoot -Name omp))',
      '[Console]::Out.WriteLine((Get-AutopromptNativeAgentsRoot -Name omp))',
      "$env:OMP_PROFILE = 'work'",
      "$env:PI_PROFILE = 'legacy'",
      '[Console]::Out.WriteLine((Get-AutopromptConfigRoot -Name omp))',
      '[Console]::Out.WriteLine((Get-AutopromptNativeAgentsRoot -Name omp))',
    ].join('; ')
    const psResult = run(POWERSHELL, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psCommand,
    ])
    assert.equal(psResult.status, 0, psResult.stderr)
    assert.deepEqual(psResult.stdout.trim().split(/\r?\n/), [
      custom,
      path.join(home, '.omp-audit', 'agent', 'agents'),
      path.join(home, '.omp-audit', 'profiles', 'work', 'agent'),
      path.join(home, '.omp-audit', 'profiles', 'work', 'agent', 'agents'),
    ])
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('OMP root resolvers reject profile traversal and platform-reserved names', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-omp-invalid-profile-'))
  try {
    const home = path.join(sandbox, 'home')
    const bashLibrary = toBash(path.join(ROOT, 'scripts', 'install', 'lib', 'install-lib.sh'))
    for (const invalidProfile of ['..', '../escape', 'UPPER', 'con', 'name.']) {
      const bashCommand = [
        `export HOME=${shellLiteral(toBash(home))}`,
        `export OMP_PROFILE=${shellLiteral(invalidProfile)}`,
        'unset PI_PROFILE AUTOPROMPT_INSTALL_ROOT',
        `. ${shellLiteral(bashLibrary)}`,
        'autoprompt_config_root omp',
      ].join('; ')
      const bashResult = run(BASH, ['--noprofile', '--norc', '-c', bashCommand])
      assert.notEqual(bashResult.status, 0, `bash accepted ${invalidProfile}`)
      assert.match(`${bashResult.stdout}\n${bashResult.stderr}`, /invalid-omp-profile/i)

      const psLibrary = path.join(ROOT, 'scripts', 'install', 'lib', 'install-lib.ps1')
      const psCommand = [
        `$env:USERPROFILE = ${powershellLiteral(home)}`,
        `$env:OMP_PROFILE = ${powershellLiteral(invalidProfile)}`,
        'Remove-Item Env:PI_PROFILE, Env:AUTOPROMPT_INSTALL_ROOT -ErrorAction SilentlyContinue',
        `. ${powershellLiteral(psLibrary)}`,
        '[Console]::Out.WriteLine((Get-AutopromptConfigRoot -Name omp))',
      ].join('; ')
      const psResult = run(POWERSHELL, [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psCommand,
      ])
      assert.notEqual(psResult.status, 0, `PowerShell accepted ${invalidProfile}`)
      assert.match(`${psResult.stdout}\n${psResult.stderr}`, /Invalid OMP profile/i)
    }
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('dedicated repair restores native files for every new harness in both ports', {
  timeout: 2400000,
}, () => {
  for (const port of ['shell', 'powershell']) {
    for (const provider of Object.keys(PROVIDERS)) {
      const context = makeContext(`${provider}-${port}`)
      try {
        const installed = port === 'shell'
          ? runLifecycleScript('install', provider, context)
          : runPowerShellLifecycleScript('install', provider, context)
        assert.equal(installed.status, 0, `${port} ${provider}\n${installed.stdout}\n${installed.stderr}`)
        const target = nativeTarget(provider, context.customRoot)
        const original = fs.readFileSync(target)
        fs.appendFileSync(target, '\ndedicated-repair-tamper\n')
        const repaired = runDirectRepair(port, provider, context)
        assert.equal(
          repaired.status,
          0,
          runDiagnostic(`${port} ${provider}`, repaired),
        )
        assert.match(repaired.stdout, /repair=restored/)
        assert.deepEqual(fs.readFileSync(target), original, `${port} ${provider}`)
      } finally {
        fs.rmSync(context.sandbox, { recursive: true, force: true })
      }
    }
  }
})

test('OMP and Reasonix lifecycle configure recursion depth and restore the prior value', {
  timeout: 600000,
}, () => {
  for (const port of ['shell', 'powershell']) {
    for (const provider of ['omp', 'reasonix']) {
      const context = makeContext(`${provider}-depth-${port}`)
      const config = providerConfig(provider, context.customRoot)
      fs.writeFileSync(config.file, config.before)
      try {
        const installed = port === 'shell'
          ? runLifecycleScript('install', provider, context)
          : runPowerShellLifecycleScript('install', provider, context)
        assert.equal(
          installed.status,
          0,
          `${port} ${provider} install\n${installed.stdout}\n${installed.stderr}`,
        )
        assert.match(fs.readFileSync(config.file, 'utf8'), config.configured)
        const receipt = JSON.parse(fs.readFileSync(path.join(
          context.customRoot,
          '.autoprompt-install-receipt.json',
        )))
        assert.equal(receipt.configEdits.length, 1, `${port} ${provider}`)
        assert.equal(receipt.configEdits[0].value, '4')

        const healthy = port === 'shell'
          ? runLifecycleScript('doctor', provider, context, true)
          : runPowerShellLifecycleScript('doctor', provider, context, true)
        assert.equal(
          healthy.status,
          0,
          `${port} ${provider} doctor\n${healthy.stdout}\n${healthy.stderr}`,
        )

        const removed = port === 'shell'
          ? runLifecycleScript('uninstall', provider, context)
          : runPowerShellLifecycleScript('uninstall', provider, context)
        assert.equal(
          removed.status,
          0,
          `${port} ${provider} uninstall\n${removed.stdout}\n${removed.stderr}`,
        )
        assert.equal(fs.readFileSync(config.file, 'utf8'), config.before)
        assert.equal(fs.existsSync(`${config.file}.autoprompt.bak`), false)
      } finally {
        fs.rmSync(context.sandbox, { recursive: true, force: true })
      }
    }
  }
})
