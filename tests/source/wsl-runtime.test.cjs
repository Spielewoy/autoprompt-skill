'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const childProcess = require('node:child_process')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const backend = require('../../scripts/wsl-runtime.cjs')
const guest = require('../../scripts/lima-runtime-guest.cjs')
const cli = require('../../bin/autoprompt.cjs')

const hash = character => character.repeat(64)

test('public WSL parsing binds every imported artifact and preserves activation resume identity', () => {
  const setup = cli.parseArgs(['runtime','wsl','setup','--root','/private/wsl','--target','/project','--provider','deepseek','--endpoint','https://gateway.example.invalid/v1','--connection','/private/models.json','--credential','/private/credentials.json','--toolchain-archive','/private/node.tar.xz','--toolchain-sha256',hash('a'),'--native-archive','/private/deepseek.tar','--native-sha256',hash('b'),'--wsl','/tools/wsl.exe','--rootfs','/private/rootfs.tar.xz','--rootfs-sha256',hash('c'),'--archive','/private/autoprompt.tgz'])
  assert.equal(setup.command, 'runtime-wsl')
  assert.equal(setup.toolchainSha256, hash('a'))
  assert.equal(setup.nativeArchive, '/private/deepseek.tar')
  assert.equal(setup.rootfsSha256, hash('c'))
  assert.equal(setup.arch, process.arch === 'arm64' ? 'aarch64' : 'x86_64')
  assert.throws(() => cli.parseArgs(['runtime','wsl','setup','--root','/private/wsl']), { code: 'AUTOPROMPT_USAGE' })
  assert.throws(() => cli.parseArgs(['runtime','wsl','cancel','--root','/private/wsl']), { code: 'AUTOPROMPT_USAGE' })
  assert.deepEqual(cli.parseArgs(['runtime','wsl','cancel','--root','/private/wsl','--request-id','d'.repeat(32)]), { command: 'runtime-wsl', action: 'cancel', root: path.resolve('/private/wsl'), requestId: 'd'.repeat(32) })
  const activation = cli.parseArgs(['activate','deepseek','--wsl-root','/private/wsl','--resume',`apv2-${'e'.repeat(32)}`,'--','review'])
  assert.equal(activation.wslRoot, path.resolve('/private/wsl'))
  assert.equal(activation.resume, `apv2-${'e'.repeat(32)}`)
  assert.throws(() => cli.parseArgs(['activate','deepseek','--wsl-root','/private/wsl','--target','/project','--','review']), { code: 'AUTOPROMPT_USAGE' })
})

test('WSL command construction keeps the Windows target as one argv and disables broad host integration', () => {
  const descriptor = { distribution: 'apwsl-0123456789abcdef', arch: 'x86_64', target: { path: 'C:\\Project Files\\sample & literal' } }
  const args = backend.bridgeArgs(descriptor)
  assert.deepEqual(args.slice(0, 5), ['--distribution','apwsl-0123456789abcdef','--user','root','--exec'])
  assert.equal(args.at(-3), 'C:\\Project Files\\sample & literal')
  assert.equal(args.at(-1), '/home/autoprompt/runtime/lima-runtime-guest.cjs')
  assert.match(args.at(-5), /mount -t drvfs/)
  assert.doesNotMatch(args.at(-5), /\/mnt\/c|automount|interop/i)
  assert.match(backend.bootstrapScript(), /enabled=false/)
  assert.match(backend.bootstrapScript(), /appendWindowsPath=false/)
  assert.match(backend.bootstrapScript(), /getent passwd 1000/)
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'wsl-runtime.cjs'), 'utf8'), /guest-bridge\.cjs/)
  assert.equal(backend.nodeRoot({ arch: 'aarch64' }), '/home/autoprompt/runtime/pinned/toolchain/node-v22.23.2-linux-arm64')
  assert.throws(() => backend.wslArgs('Ubuntu', ['/bin/true']), { code: 'WSL_DESCRIPTOR_INVALID' })
})

test('WSL controlled host environment excludes ambient credentials and fixes Windows PowerShell', () => {
  const before = { key: process.env.OPENROUTER_API_KEY, appData: process.env.APPDATA, architecture: process.env.PROCESSOR_ARCHITECTURE }
  process.env.OPENROUTER_API_KEY = 'must-not-cross'
  process.env.APPDATA = 'C:\\Users\\tester\\AppData\\Roaming'
  process.env.PROCESSOR_ARCHITECTURE = 'AMD64'
  try {
    const env = backend.controlledEnv('C:\\Private')
    assert.equal(env.OPENROUTER_API_KEY, undefined)
    assert.equal(env.PSModulePath, undefined)
    assert.equal(env.APPDATA, process.env.APPDATA)
    assert.equal(env.PROCESSOR_ARCHITECTURE, 'AMD64')
    assert.match(env.PATH, /System32$/i)
    assert.match(backend.powershellPath(), /System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i)
  } finally {
    for (const [name, value] of [['OPENROUTER_API_KEY', before.key], ['APPDATA', before.appData], ['PROCESSOR_ARCHITECTURE', before.architecture]]) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

test('WSL PowerShell helper treats native stderr as output and binds success to the exit code', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'wsl-runtime.ps1'), 'utf8')
  assert.match(source, /function Invoke-WslCaptured/)
  assert.match(source, /\$ErrorActionPreference = 'Continue'/)
  assert.match(source, /\$code = \$LASTEXITCODE/)
  assert.match(source, /Invoke-WslCaptured -Arguments @\('--import',\$Distribution,\$InstallDirectory,\$resolvedRootfs,'--version','2'\)/)
  assert.match(source, /if \(\$importResult\.Code -ne 0\)/)
})

test('WSL installs and copies VS Code display prerequisites only for the VS Code provider', () => {
  const regular = backend.guestPrerequisiteScript('codex')
  assert.match(regular, /apt-get install -y --no-install-recommends bubblewrap git python3 python3-jsonschema/)
  assert.doesNotMatch(regular, /Xvfb|xvfb|xauth|xdpyinfo|libgtk|libasound/)

  const vscode = backend.guestPrerequisiteScript('vscode')
  assert.match(vscode, /resolve_candidate\(\).*apt-cache show/s)
  assert.match(vscode, /resolve_candidate libgtk-3-0t64 libgtk-3-0/)
  assert.match(vscode, /resolve_candidate libasound2t64 libasound2/)
  assert.match(vscode, /apt-get install -y xvfb xauth "\$gtk_package" libnss3 "\$asound_package" libx11-xcb1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libxkbcommon0 libdrm2 libatk-bridge2\.0-0 libcups2 x11-utils/)
  assert.match(vscode, /command -v Xvfb; command -v xauth; command -v xdpyinfo/)
  assert.throws(() => backend.guestPrerequisiteScript('unknown'), { code: 'WSL_PROVIDER_CONFIG_INVALID' })

  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'wsl-runtime.cjs'), 'utf8')
  assert.match(source, /input\.provider === 'vscode' \? binding\(path\.join\(__dirname, 'lima-runtime-vscode-display\.cjs'\)\) : null/)
  assert.match(source, /if \(vscodeDisplay\) writeGuestFile\(descriptor, `\$\{GUEST_ROOT\}\/lima-runtime-vscode-display\.cjs`/)
})

test('WSL descriptor reload requires the exact provider-specific display helper binding', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-wsl-vscode-display-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const helper = path.join(root, 'lima-runtime-vscode-display.cjs')
  fs.writeFileSync(helper, 'module.exports = {}\n')
  const display = backend.binding(helper)

  const vscodeDescriptor = backend.makeDescriptor({ provider: 'vscode' }, { vscodeDisplay: display })
  assert.deepEqual(vscodeDescriptor.vscodeDisplay, display)
  assert.equal(backend.assertVscodeDisplayDescriptor(vscodeDescriptor), true)
  assert.throws(() => backend.assertVscodeDisplayDescriptor({ provider: 'vscode' }), { code: 'WSL_DESCRIPTOR_INVALID' })
  assert.throws(() => backend.assertVscodeDisplayDescriptor({ provider: 'codex', vscodeDisplay: display }), { code: 'WSL_DESCRIPTOR_INVALID' })

  const codexDescriptor = backend.makeDescriptor({ provider: 'codex' }, { vscodeDisplay: display })
  assert.equal(Object.hasOwn(codexDescriptor, 'vscodeDisplay'), false)
  assert.equal(backend.assertVscodeDisplayDescriptor(codexDescriptor), true)

  fs.writeFileSync(helper, 'module.exports = {x:1}\n')
  assert.throws(() => backend.assertVscodeDisplayDescriptor(vscodeDescriptor), { code: 'WSL_BINDING_CHANGED' })
})

test('WSL transport preserves stdin until a durable guest receipt', async t => {
  const original = childProcess.spawn
  t.after(() => { childProcess.spawn = original })
  let input = '', ended = false, argv
  childProcess.spawn = (_executable, childArgv) => {
    argv = childArgv
    const child = new EventEmitter()
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {}
    child.stdin.on('data', chunk => { input += chunk }); child.stdin.on('end', () => { ended = true })
    process.nextTick(() => { child.stdout.emit('data', Buffer.from('{"schemaVersion":1,"status":"SUCCEEDED"}\n')); child.emit('close', 0) })
    return child
  }
  const descriptor = { wsl: { path: 'C:\\Program Files\\WSL\\wsl.exe' }, distribution: 'apwsl-0123456789abcdef', arch: 'x86_64', target: { path: 'C:\\Project' }, privateRoot: { path: 'C:\\Private' } }
  const request = { schemaVersion: 1, action: 'exec', requestId: 'f'.repeat(32), argv: ['version'] }
  assert.deepEqual(await backend.transport(descriptor, 'C:\\Private', request), { schemaVersion: 1, status: 'SUCCEEDED' })
  assert.equal(input, `${JSON.stringify(request)}\n`)
  assert.equal(ended, false)
  assert.equal(argv.at(-3), 'C:\\Project')
})

test('WSL file bindings detect equal-size replacement and expected digests fail closed', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-wsl-binding-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'archive'); fs.writeFileSync(file, 'original')
  const before = backend.binding(file)
  const replacement = path.join(root, 'next'); fs.writeFileSync(replacement, 'replaced'); fs.renameSync(replacement, file)
  assert.throws(() => backend.assertBinding(before), { code: 'WSL_BINDING_CHANGED' })
  assert.throws(() => backend.exactDigest('A'.repeat(64), 'rootfs'), { code: 'WSL_DIGEST_INVALID' })
})

test('WSL reload compares enriched provider records through their semantic binding', () => {
  const record = { path: 'C:\\private\\models.json', dev: '1', ino: '2', mode: 0o100600, sha256: hash('d'), name: 'models.json', connectionIdentitySha256: hash('e') }
  assert.doesNotThrow(() => backend.assertSemanticBinding(record, { ...record }, 'Native connection'))
  assert.throws(() => backend.assertSemanticBinding(record, { ...record, connectionIdentitySha256: hash('f') }, 'Native connection'), { code: 'WSL_BINDING_CHANGED' })
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'wsl-runtime.cjs'), 'utf8')
  assert.match(source, /lima\.connectionBinding\(descriptor\.connection\.path, descriptor\.provider, descriptor\.endpoint\)/)
  assert.match(source, /lima\.credentialBinding\(descriptor\.credential\.path, descriptor\.provider, connection\)/)
})

test('WSL storage ACL admits only base identities and live WSL VHD principals', () => {
  const baseRules = [
    { identity: 'NT AUTHORITY\\SYSTEM', sid: 'S-1-5-18', type: 'Allow', inherited: true, rights: 'FullControl' },
    { identity: 'HOST\\tester', sid: 'S-1-5-21-1-2-3-1000', type: 'Allow', inherited: true, rights: 'FullControl' },
  ]
  const snapshot = { currentName: 'HOST\\tester', currentSid: 'S-1-5-21-1-2-3-1000', runningWslVmIds: ['b8033508-b264-475d-9787-72ea0dffbffc'], items: [
    { owner: 'HOST\\tester', ownerSid: 'S-1-5-21-1-2-3-1000', rules: baseRules },
    { owner: 'HOST\\tester', ownerSid: 'S-1-5-21-1-2-3-1000', rules: [...baseRules,
      { identity: 'NT VIRTUAL MACHINE\\B8033508-B264-475D-9787-72EA0DFFBFFC', sid: 'S-1-5-83-0-1-2-3-4-5', type: 'Allow', inherited: false, rights: 'FullControl' },
      { identity: 'S-1-15-3-1024-2268835264-3721307629-241982045-173645152-1490879176-104643441-2915960892-1612460704', sid: 'S-1-15-3-1024-2268835264-3721307629-241982045-173645152-1490879176-104643441-2915960892-1612460704', type: 'Allow', inherited: false, rights: 'FullControl' },
    ] },
  ] }
  assert.equal(backend.validateWslStorageAcl(snapshot).valid, true)
  const foreign = structuredClone(snapshot); foreign.items[1].rules.push({ identity: 'HOST\\other', sid: 'S-1-5-21-1-2-3-1001', type: 'Allow', inherited: false, rights: 'FullControl' })
  assert.throws(() => backend.validateWslStorageAcl(foreign), { code: 'WSL_PATH_UNSAFE' })
  const directoryVm = structuredClone(snapshot); directoryVm.items[0].rules.push(directoryVm.items[1].rules[2])
  assert.throws(() => backend.validateWslStorageAcl(directoryVm), { code: 'WSL_PATH_UNSAFE' })
  const foreignVm = structuredClone(snapshot); foreignVm.runningWslVmIds = ['35e2c116-1e9b-4f2f-843a-0e3f5d45af00']
  assert.throws(() => backend.validateWslStorageAcl(foreignVm), { code: 'WSL_PATH_UNSAFE' })
  const stoppedVm = structuredClone(snapshot); stoppedVm.runningWslVmIds = []
  assert.throws(() => backend.validateWslStorageAcl(stoppedVm), { code: 'WSL_PATH_UNSAFE' })
  const weaklyBoundVm = structuredClone(snapshot); weaklyBoundVm.items[1].rules[2].rights = 'ReadAndExecute'
  assert.throws(() => backend.validateWslStorageAcl(weaklyBoundVm), { code: 'WSL_PATH_UNSAFE' })
  assert.deepEqual(backend.runningWslVmIds('11111111-1111-1111-1111-111111111111\n VM, Running, 11111111-1111-1111-1111-111111111111, Docker\nB8033508-B264-475D-9787-72EA0DFFBFFC\n VM, Running, B8033508-B264-475D-9787-72EA0DFFBFFC, WSL\n'), ['b8033508-b264-475d-9787-72ea0dffbffc'])
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'wsl-runtime.cjs'), 'utf8')
  assert.match(source, /path\.win32\.join\(process\.env\.SystemRoot \|\| process\.env\.WINDIR \|\| 'C:\\\\Windows', 'System32', 'hcsdiag\.exe'\)/)
})

test('WSL archive extraction rejects an escaping symlink before publication', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-wsl-extract-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const archive = path.join(root, 'unsafe.tar'), destination = path.join(root, 'destination')
  const make = childProcess.spawnSync('python3', ['-c', 'import io,tarfile,sys\np=sys.argv[1]\nwith tarfile.open(p,"w") as t:\n i=tarfile.TarInfo("root/link");i.type=tarfile.SYMTYPE;i.linkname="../../outside";t.addfile(i)', archive], { encoding: 'utf8' })
  assert.equal(make.status, 0, make.stderr)
  const extracted = childProcess.spawnSync('python3', ['-c', backend.EXTRACTOR, archive, destination, 'strip-one'], { encoding: 'utf8' })
  assert.notEqual(extracted.status, 0)
  assert.equal(fs.existsSync(destination), false)
})

test('WSL archive extraction refuses a pre-existing destination', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-wsl-existing-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const archive = path.join(root, 'safe.tar'), destination = path.join(root, 'destination')
  fs.mkdirSync(destination)
  const make = childProcess.spawnSync('python3', ['-c', 'import io,tarfile,sys\nwith tarfile.open(sys.argv[1],"w") as t:\n b=b"safe";i=tarfile.TarInfo("root/file");i.size=len(b);t.addfile(i,io.BytesIO(b))', archive], { encoding: 'utf8' })
  assert.equal(make.status, 0, make.stderr)
  const extracted = childProcess.spawnSync('python3', ['-c', backend.EXTRACTOR, archive, destination, 'strip-one'], { encoding: 'utf8' })
  assert.notEqual(extracted.status, 0)
  assert.deepEqual(fs.readdirSync(destination), [])
})

test('guest admits drvfs only through the explicit WSL provider backend binding', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'lima-runtime-guest.cjs'), 'utf8')
  assert.match(source, /configuration\.hostBackend === 'wsl2-drvfs' \? \['9p', 'drvfs'\] : \['9p', 'virtiofs'\]/)
  assert.doesNotMatch(source, /\['9p', 'virtiofs', 'drvfs'\]/)
})

test('guest decodes the real WSL 9p mountinfo source for a spaced Windows target', () => {
  const line = '130 81 0:68 / /home/autoprompt/target rw,relatime - 9p C:\\134Autoprompt\\040WSL\\040Frontend\\040Target rw,aname=drvfs;path=C:\\Autoprompt WSL Frontend Target;metadata;uid=1000;gid=1000;umask=077;fmask=077;symlinkroot=/mnt/,cache=0x5,access=client'
  const record = guest.mountRecord([line], '/home/autoprompt/target')
  assert.equal(record.type, '9p')
  assert.equal(record.source, 'C:\\Autoprompt WSL Frontend Target')
  assert.equal(record.mountOptions.has('rw'), true)
  for (const option of ['metadata','uid=1000','gid=1000','umask=077','fmask=077']) assert.match(record.superOptions, new RegExp(option))
})
