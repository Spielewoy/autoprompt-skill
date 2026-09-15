'use strict'

const assert = require('node:assert/strict')
const cp = require('node:child_process')
const crypto = require('node:crypto')
const { once } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const helper = path.resolve(__dirname, '../../agents/codex/workflow/windows-filesystem.ps1')
const windows = process.platform === 'win32'

function driveRoot(value) {
  return path.parse(path.resolve(value)).root
}

function fixture(t, privateAcl = false) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-nt-handle-')))
  if (privateAcl) {
    const script = '$ErrorActionPreference = "Stop"; $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User; $acl = New-Object Security.AccessControl.DirectorySecurity; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); foreach ($id in @($sid.Value,"S-1-5-18","S-1-5-32-544")) { $principal = New-Object Security.Principal.SecurityIdentifier($id); $rule = New-Object Security.AccessControl.FileSystemAccessRule($principal,"FullControl","ContainerInherit,ObjectInherit","None","Allow"); $acl.AddAccessRule($rule) }; [IO.Directory]::SetAccessControl($env:AUTOPROMPT_PRIVATE_FIXTURE,$acl)'
    const result = cp.spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 60000, env: { ...process.env, AUTOPROMPT_PRIVATE_FIXTURE: root } })
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stderr)
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function capture(root, components, options = {}) {
  const request = options.request || { schemaVersion: 1, operation: options.operation || 'read', root: driveRoot(root), components, maxBytes: options.maxBytes ?? 1024 * 1024 }
  const result = cp.spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', options.runner || helper, '-Request'], {
    input: options.input || JSON.stringify(request), encoding: 'utf8', timeout: 30000, maxBuffer: 9 * 1024 * 1024,
    env: options.env ? { ...process.env, ...options.env } : process.env,
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  return JSON.parse(result.stdout)
}

function shortDosPath(value) {
  // Ask the Windows filesystem for the short name without placing the fixture
  // path in a cmd command line.  8.3 names may be disabled on the volume.
  const result = cp.spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '$fso = New-Object -ComObject Scripting.FileSystemObject; [Console]::Out.Write($fso.GetFile($env:AUTOPROMPT_WINDOWS_CAPTURE_ALIAS_PATH).ShortPath)'], {
    encoding: 'utf8', timeout: 15000,
    env: { ...process.env, AUTOPROMPT_WINDOWS_CAPTURE_ALIAS_PATH: value },
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

function writableMapping(file, stopPath) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$p = $env:AUTOPROMPT_WINDOWS_CAPTURE_MAPPING_PATH",
    '$stream = [IO.File]::Open($p, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::ReadWrite)',
    "$mapName = 'AutopromptCaptureMap_' + [Guid]::NewGuid().ToString('N')",
    '$mapping = [IO.MemoryMappedFiles.MemoryMappedFile]::CreateFromFile($stream, $mapName, [int64]0, [IO.MemoryMappedFiles.MemoryMappedFileAccess]::ReadWrite, [IO.HandleInheritability]::None, $false)',
    '$stream.Dispose()',
    '$view = $mapping.CreateViewAccessor(0, [int64]0, [IO.MemoryMappedFiles.MemoryMappedFileAccess]::ReadWrite)',
    '$original = $view.ReadByte(0); $view.Write(0, $original)',
    "if ($null -eq $mapping -or $null -eq $view -or $view.ReadByte(0) -ne $original) { throw 'mapping view unavailable' }; [Console]::Out.WriteLine('READY:VIEW')",
    'while (-not [IO.File]::Exists($env:AUTOPROMPT_WINDOWS_CAPTURE_MAPPING_STOP)) { Start-Sleep -Milliseconds 10 }',
    '$view.Dispose()',
    '$mapping.Dispose()',
  ].join('; ')
  const child = cp.spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    // This owner is stopped by its marker file. An unused open stdin pipe can
    // keep Windows PowerShell waiting after the command has finished.
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60000,
    env: { ...process.env, AUTOPROMPT_WINDOWS_CAPTURE_MAPPING_PATH: file, AUTOPROMPT_WINDOWS_CAPTURE_MAPPING_STOP: stopPath },
  })
  const state = { stdout: '', stderr: '' }
  const ready = new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => reject(new Error(`mapping process timed out: ${stderr}`)), 15000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      stdout += chunk; state.stdout = stdout
      if (stdout.includes('READY:VIEW\r\n') || stdout.includes('READY:VIEW\n')) {
        clearTimeout(timeout)
        resolve()
      }
    })
    child.stderr.on('data', chunk => { stderr += chunk; state.stderr = stderr })
    child.once('error', error => { clearTimeout(timeout); reject(error) })
    child.once('exit', code => {
      if (!stdout.includes('READY')) {
        clearTimeout(timeout)
        reject(new Error(`mapping process exited ${code}: ${stderr}`))
      }
    })
  })
  return { child, ready, stopPath, state }
}

function barrierWritingMapping(file, barrier) {
  const source = [
    'using System;', 'using System.IO;', 'using System.IO.MemoryMappedFiles;', 'using System.Threading;',
    'public static class AutopromptMappingWriter {',
    'public static void Run(string path, string barrier) { ManualResetEvent stop = new ManualResetEvent(false);',
    'Thread reader = new Thread(delegate() { Console.ReadLine(); stop.Set(); }); reader.IsBackground = true; reader.Start();',
    'FileStream stream = new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.ReadWrite); MemoryMappedFile mapping;',
    'try { mapping = MemoryMappedFile.CreateFromFile(stream, null, 0, MemoryMappedFileAccess.ReadWrite, HandleInheritability.None, false); } finally { stream.Dispose(); }',
    'using (mapping) { Console.WriteLine("READY"); while (!stop.WaitOne(0)) {',
    'if (File.Exists(barrier) && File.ReadAllText(barrier) == "first-pass") {',
    'using (MemoryMappedViewAccessor view = mapping.CreateViewAccessor(0, 0, MemoryMappedFileAccess.ReadWrite)) {',
    'view.Write(0, (byte)0x71); File.WriteAllText(barrier, "mutated"); while (!stop.WaitOne(0)) Thread.Sleep(1);',
    '} } } } } }',
  ].join(' ')
  const child = cp.spawn('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    "Add-Type -TypeDefinition '" + source + "' -Language CSharp; [AutopromptMappingWriter]::Run($env:AUTOPROMPT_WINDOWS_CAPTURE_MAPPING_PATH, $env:AUTOPROMPT_WINDOWS_CAPTURE_BARRIER)",
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, AUTOPROMPT_WINDOWS_CAPTURE_MAPPING_PATH: file, AUTOPROMPT_WINDOWS_CAPTURE_BARRIER: barrier },
  })
  const ready = new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => reject(new Error('mapping writer timed out: ' + stderr)), 15000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      stdout += chunk
      if (stdout.includes('READY\r\n') || stdout.includes('READY\n')) {
        clearTimeout(timeout)
        resolve()
      }
    })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', error => { clearTimeout(timeout); reject(error) })
    child.once('exit', code => {
      if (!stdout.includes('READY')) {
        clearTimeout(timeout)
        reject(new Error('mapping writer exited ' + code + ': ' + stderr))
      }
    })
  })
  return { child, ready }
}

function barrierRunner(root) {
  const runner = path.join(root, 'windows-filesystem-between-passes.ps1')
  const marker = '      long reset; Need(SetFilePointerEx(file.Handle, 0, out reset, 0) && reset == 0, "PREIMAGE_UNSAFE");'
  const hook = [
    '      string testBarrier = Environment.GetEnvironmentVariable("AUTOPROMPT_WINDOWS_CAPTURE_TEST_BARRIER");',
    '      if (!String.IsNullOrEmpty(testBarrier)) {',
    '        File.WriteAllText(testBarrier, "first-pass"); bool changed = false;',
    '        for (int attempt = 0; attempt < 5000; attempt++) {',
    '          try { if (File.ReadAllText(testBarrier) == "mutated") { changed = true; break; } } catch (IOException) {}',
    '          System.Threading.Thread.Sleep(1);',
    '        }',
    '        Need(changed, "PREIMAGE_UNSAFE");',
    '      }',
  ].join('\n')
  const original = fs.readFileSync(helper, 'utf8')
  assert.equal(original.includes(marker), true)
  fs.writeFileSync(runner, original.replace(marker, '      if (pass == 1) {\n' + hook + '\n      }\n' + marker))
  return runner
}

function usnRaceRunner(root) {
  const runner = path.join(root, 'windows-filesystem-usn-race.ps1')
  const marker = '            Snapshot originalTop=target.Snapshot;'
  const hook = [
    '            string raceDirectory=root+String.Join("\\\\",components)+"\\\\empty";',
    '            DateTime raceWrite=Directory.GetLastWriteTimeUtc(raceDirectory);',
    '            string raceChild=raceDirectory+"\\\\.transient";',
    '            Directory.CreateDirectory(raceChild);Directory.Delete(raceChild);Directory.SetLastWriteTimeUtc(raceDirectory,raceWrite);',
    marker,
  ].join('\n')
  const original = fs.readFileSync(helper, 'utf8')
  assert.equal(original.includes(marker), true)
  fs.writeFileSync(runner, original.replace(marker, hook))
  return runner
}

async function stopMapping(mapper, timeoutMs = 10000) {
  const child = mapper.child
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  if (mapper.stopPath) fs.writeFileSync(mapper.stopPath, 'stop')
  else child.stdin.end('\n')
  let timer
  try {
    await Promise.race([exited, new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`mapping owner did not stop: ${mapper.state?.stderr || ''}`)), timeoutMs)
    })])
  } catch (error) {
    // Fail the fixture, but release the mapping so subsequent native cases run.
    child.kill('SIGKILL')
    try { await once(child, 'close', { signal: AbortSignal.timeout(5000) }) }
    catch {
      child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); child.unref()
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

test('mapped-view fixture teardown kills an unresponsive owner and reports the failure', { timeout: 30000 }, async t => {
  const child = cp.spawn(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)'], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000 })
  t.after(() => { child.kill('SIGKILL'); child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); child.unref() })
  await once(child.stdout, 'data', { signal: AbortSignal.timeout(10000) })
  await assert.rejects(stopMapping({ child, state: { stderr: 'fixture diagnostic' } }, 100), /mapping owner did not stop: fixture diagnostic/)
  assert.notEqual(child.signalCode, null)
})

test('mapped-view fixture teardown stops a marker-controlled owner with closed stdin', { timeout: 30000 }, async t => {
  const stopPath = path.join(fixture(t), 'stop')
  const child = cp.spawn(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(() => { if (require("node:fs").existsSync(process.argv[1])) process.exit(0) }, 10)', stopPath], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 })
  t.after(() => { child.kill('SIGKILL'); child.stdout?.destroy(); child.stderr?.destroy(); child.unref() })
  await once(child.stdout, 'data', { signal: AbortSignal.timeout(10000) })
  await stopMapping({ child, stopPath })
  assert.equal(child.exitCode, 0)
})

test('Windows HANDLE capture reads bounded bytes and returns a stable content digest', { skip: !windows }, t => {
  const root = fixture(t)
  const folder = path.join(root, 'capture')
  fs.mkdirSync(folder)
  const bytes = Buffer.from([0, 255, 10, 0x61])
  fs.writeFileSync(path.join(folder, 'payload.bin'), bytes)
  const relative = path.relative(driveRoot(root), path.join(folder, 'payload.bin')).split(path.sep)
  const read = capture(root, relative)
  // A temp directory is normally below Users, but calculate components from
  // the drive root so the request never depends on a named-path reopen.
  assert.equal(read.status, 'CAPTURED')
  assert.equal(read.operation, 'read')
  assert.deepEqual(Buffer.from(read.dataBase64, 'base64'), bytes)
  assert.equal(read.sha256, crypto.createHash('sha256').update(bytes).digest('hex'))
  const hashed = capture(root, relative, { operation: 'hash' })
  assert.equal(hashed.status, 'CAPTURED')
  assert.equal(hashed.sha256, read.sha256)
  assert.equal(Object.hasOwn(hashed, 'dataBase64'), false)
})

test('Windows HANDLE capture accepts strict UTF-8 request bytes and rejects malformed UTF-8', { skip: !windows }, t => {
  const root = fixture(t)
  const name = 'Grüße-é-漢字.txt'
  const bytes = Buffer.from('unicode payload')
  const file = path.join(root, name)
  fs.writeFileSync(file, bytes)
  const components = path.relative(driveRoot(root), file).split(path.sep)
  const request = { schemaVersion: 1, operation: 'read', root: driveRoot(root), components, maxBytes: 1024 }
  const captured = capture(root, components, { input: Buffer.from(JSON.stringify(request), 'utf8') })
  assert.equal(captured.status, 'CAPTURED')
  assert.deepEqual(Buffer.from(captured.dataBase64, 'base64'), bytes)

  const prefix = Buffer.from('{"schemaVersion":1,"operation":"hash","root":"C:\\\\","components":["', 'utf8')
  const suffix = Buffer.from('"],"maxBytes":1}', 'utf8')
  assert.deepEqual(capture(root, [], { input: Buffer.concat([prefix, Buffer.from([0xc3, 0x28]), suffix]) }),
    { schemaVersion: 1, status: 'REFUSED', code: 'FILESYSTEM_REQUEST_INVALID' })
})

test('Windows HANDLE capture accepts canonical long components and refuses their 8.3 aliases', { skip: !windows }, t => {
  const root = fixture(t)
  const name = 'long-file-name-for-alias.txt'
  const file = path.join(root, name)
  fs.writeFileSync(file, 'payload')
  const actual = shortDosPath(file)
  const shortName = path.basename(actual)
  if (!shortName || shortName.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0) {
    t.skip('8.3 aliases are unavailable on this guest volume')
    return
  }
  const prefix = path.relative(driveRoot(root), root).split(path.sep)
  assert.equal(capture(root, prefix.concat(name)).status, 'CAPTURED')
  assert.deepEqual(capture(root, prefix.concat(shortName)),
    { schemaVersion: 1, status: 'REFUSED', code: 'PREIMAGE_UNSAFE' })
})

test('Windows HANDLE capture refuses reparse points, hard links, devices and ambiguous components', { skip: !windows }, t => {
  const root = fixture(t)
  const relative = path.relative(driveRoot(root), root).split(path.sep)
  fs.writeFileSync(path.join(root, 'file'), 'payload')
  fs.linkSync(path.join(root, 'file'), path.join(root, 'linked'))
  assert.deepEqual(capture(root, relative.concat('linked')), { schemaVersion: 1, status: 'REFUSED', code: 'PREIMAGE_UNSAFE' })
  try {
    fs.symlinkSync(path.join(root, 'file'), path.join(root, 'jump'), 'file')
    assert.deepEqual(capture(root, relative.concat('jump')), { schemaVersion: 1, status: 'REFUSED', code: 'PREIMAGE_UNSAFE' })
  } catch (error) {
    // Windows Server accounts without SeCreateSymbolicLinkPrivilege still run
    // the hard-link and reserved-name native checks above.
    if (error.code !== 'EPERM') throw error
  }
  assert.deepEqual(capture(root, relative.concat('NUL')), { schemaVersion: 1, status: 'REFUSED', code: 'FILESYSTEM_REQUEST_INVALID' })
  assert.deepEqual(capture(root, relative.concat('file:stream')), { schemaVersion: 1, status: 'REFUSED', code: 'FILESYSTEM_REQUEST_INVALID' })
})

test('Windows HANDLE capture refuses a live writable mapped view after its stream closes', { skip: !windows }, async t => {
  const root = fixture(t)
  const relative = path.relative(driveRoot(root), root).split(path.sep).concat('file')
  const file = path.join(root, 'file')
  const stopPath = path.join(root, 'mapping-stop')
  fs.writeFileSync(file, 'payload')
  const mapper = writableMapping(file, stopPath)
  try {
    await mapper.ready
    assert.equal(mapper.state.stderr, '', mapper.state.stderr)
    assert.equal(mapper.child.exitCode, null, 'the mapping owner exited before capture')
    assert.deepEqual(capture(root, relative), { schemaVersion: 1, status: 'REFUSED', code: 'PREIMAGE_UNSAFE' })
    assert.equal(mapper.child.exitCode, null, 'the mapping owner exited during capture')
    assert.equal(mapper.state.stderr, '', mapper.state.stderr)
  } finally {
    await stopMapping(mapper)
  }
  assert.equal(capture(root, relative).status, 'CAPTURED')
})

test('Windows HANDLE capture rejects closed-protocol violations and size overrun', { skip: !windows }, t => {
  const root = fixture(t)
  const relative = path.relative(driveRoot(root), root).split(path.sep)
  fs.writeFileSync(path.join(root, 'file'), 'payload')
  const base = { schemaVersion: 1, operation: 'hash', root: driveRoot(root), components: relative.concat('file'), maxBytes: 32 }
  for (const request of [
    { ...base, ignored: true },
    { ...base, root },
    { ...base, components: relative.concat('file:stream') },
    { ...base, operation: 'remove' },
    { ...base, maxBytes: 2 },
  ]) assert.equal(capture(root, [], { request }).status, 'REFUSED')
  const escapedDuplicate = `{"schemaVersion":1,"operation":"hash","root":${JSON.stringify(base.root)},"r\\u006fot":${JSON.stringify(base.root)},"components":${JSON.stringify(base.components)},"maxBytes":32}`
  assert.deepEqual(capture(root, [], { input: escapedDuplicate }), { schemaVersion: 1, status: 'REFUSED', code: 'FILESYSTEM_REQUEST_INVALID' })
  const uppercaseRoot = '{"schemaVersion":1,"operation":"hash","ROOT":' + JSON.stringify(base.root) +
    ',"components":' + JSON.stringify(base.components) + ',"maxBytes":32}'
  assert.deepEqual(capture(root, [], { input: uppercaseRoot }),
    { schemaVersion: 1, status: 'REFUSED', code: 'FILESYSTEM_REQUEST_INVALID' })
  assert.deepEqual(capture(root, [], { input: JSON.stringify(base) + ' '.repeat(16385) }),
    { schemaVersion: 1, status: 'REFUSED', code: 'FILESYSTEM_REQUEST_INVALID' })
})

test('Windows HANDLE tree capture includes empty directories, exact bytes, and held stat identities', { skip: !windows }, t => {
  const root = fixture(t), directory = path.join(root, 'tree')
  fs.mkdirSync(path.join(directory, 'nested'), { recursive: true })
  fs.mkdirSync(path.join(directory, 'empty'))
  const bytes = Buffer.from([0, 255, 97, 10])
  fs.writeFileSync(path.join(directory, 'nested', 'data'), bytes)
  const components = path.relative(driveRoot(root), directory).split(path.sep)
  const value = capture(root, components, { operation: 'tree' })
  const parsed = require('../../agents/codex/workflow/windows-filesystem.js').parseCapture(JSON.stringify(value), 'tree')
  assert.equal(parsed.bytes, bytes.length)
  assert.deepEqual(parsed.entries.map(entry => entry.path), ['', 'empty', 'nested', 'nested/data'])
  assert.deepEqual(parsed.entries[3].content, bytes)
  const actual = fs.lstatSync(path.join(directory, 'nested', 'data'), { bigint: true })
  assert.equal(parsed.entries[3].stat.dev, String(actual.dev))
  assert.equal(parsed.entries[3].stat.ino, String(actual.ino))
  assert.equal(parsed.entries[3].stat.mode, Number(actual.mode))
  assert.equal(capture(root, components, { operation: 'tree', maxBytes: bytes.length - 1 }).code, 'FILESYSTEM_CAPTURE_LIMIT')
})

test('Windows HANDLE tree capture refuses hardlinked descendants and linked directories', { skip: !windows }, t => {
  const root = fixture(t), directory = path.join(root, 'tree'), outside = path.join(root, 'outside')
  fs.mkdirSync(directory); fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'payload'), 'outside')
  fs.linkSync(path.join(outside, 'payload'), path.join(directory, 'hardlink'))
  const components = path.relative(driveRoot(root), directory).split(path.sep)
  assert.equal(capture(root, components, { operation: 'tree' }).code, 'PREIMAGE_UNSAFE')
  fs.unlinkSync(path.join(directory, 'hardlink'))
  fs.symlinkSync(outside, path.join(directory, 'junction'), 'junction')
  assert.equal(capture(root, components, { operation: 'tree' }).code, 'PREIMAGE_UNSAFE')
})

test('Windows HANDLE capture permits unrelated sibling activity while retaining the captured subtree checks', { skip: !windows }, t => {
  const root = fixture(t), target = path.join(root, 'target')
  fs.mkdirSync(target)
  fs.writeFileSync(path.join(target, 'data.txt'), 'stable')
  const runner = path.join(root, 'sibling-activity.ps1')
  const marker = '  static void Verify(List<Opened> held, string nativeRoot) {'
  const original = fs.readFileSync(helper, 'utf8')
  assert.equal(original.includes(marker), true)
  // A deterministic scheduling barrier: the held lineage already exists.
  // The injected action changes a sibling, outside the captured target.
  const hook = [
    marker,
    '    string sibling = Environment.GetEnvironmentVariable("AUTOPROMPT_WINDOWS_CAPTURE_SIBLING");',
    '    if (!String.IsNullOrEmpty(sibling)) {',
    '      File.WriteAllText(sibling, "unrelated sibling");',
    '    }',
  ].join('\n')
  fs.writeFileSync(runner, original.replace(marker, hook))
  for (const operation of ['read', 'tree']) {
    const capturedPath = operation === 'read' ? path.join(target, 'data.txt') : target
    const result = capture(root, path.relative(driveRoot(root), capturedPath).split(path.sep), {
      runner, operation,
      env: { AUTOPROMPT_WINDOWS_CAPTURE_SIBLING: path.join(root, 'other-mission.tmp') },
    })
    assert.equal(result.status, operation === 'read' ? 'CAPTURED' : 'TREE_CAPTURED', JSON.stringify(result))
    if (operation === 'read') assert.equal(Buffer.from(result.dataBase64, 'base64').toString(), 'stable')
    else assert.deepEqual(result.entries.map(entry => entry.path), ['', 'data.txt'])
  }
})

test('Windows terminal publication is exclusive, byte-bound, and cleans only its held temporary', { skip: !windows }, t => {
  const root = fixture(t, true), filename = path.join(root, 'terminal.json')
  const backend = require('../../agents/codex/workflow/windows-filesystem.js').createWindowsFilesystemCapture()
  assert.equal(backend.assertRecordParent(filename).stat.ino, String(fs.lstatSync(root, { bigint: true }).ino))
  const bytes = Buffer.alloc(9000, 97)
  const created = backend.publishRecordExclusive(filename, bytes)
  assert.equal(created.stat.size, bytes.length)
  assert.equal(created.stat.ino, String(fs.lstatSync(filename, { bigint: true }).ino))
  assert.deepEqual(backend.captureFileBytes(filename).content, bytes)
  assert.throws(() => backend.publishRecordExclusive(filename, Buffer.from('replacement')), { code: 'EEXIST' })
  assert.deepEqual(fs.readFileSync(filename), bytes)
  assert.deepEqual(fs.readdirSync(root), ['terminal.json'])
  const residue = path.join(root, '.autoprompt-record-untrusted.tmp')
  fs.writeFileSync(residue, 'not owned by this invocation')
  backend.recoverRecordPublication(filename)
  assert.equal(fs.readFileSync(residue, 'utf8'), 'not owned by this invocation')
  const dead = cp.spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8', timeout: 15000 })
  assert.ifError(dead.error)
  assert.equal(dead.status, 0)
  const makeResidue = pid => {
    const name = `.terminal.json.${pid}.0123456789abcdef.create`, target = path.join(root, name)
    fs.writeFileSync(target, 'partial publication')
    const owner = cp.spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference = "Stop"; $acl = Get-Acl -LiteralPath $env:AUTOPROMPT_RESIDUE; $acl.SetOwner([Security.Principal.WindowsIdentity]::GetCurrent().User); Set-Acl -LiteralPath $env:AUTOPROMPT_RESIDUE -AclObject $acl'], { encoding: 'utf8', timeout: 60000, env: { ...process.env, AUTOPROMPT_RESIDUE: target } })
    assert.ifError(owner.error)
    assert.equal(owner.status, 0, owner.stderr)
    return name
  }
  const stale = makeResidue(Number(dead.stdout))
  assert.deepEqual(backend.recoverRecordPublication(filename), [stale])
  assert.equal(fs.existsSync(path.join(root, stale)), false)
  const live = makeResidue(process.pid)
  assert.throws(() => backend.recoverRecordPublication(filename), { code: 'RUN_RECORD_BUSY' })
  assert.equal(fs.existsSync(path.join(root, live)), true)
})

test('Windows owned cleanup binds the target, validates the entire tree, and proves final absence', { skip: !windows }, t => {
  const root = fixture(t, true), target = path.join(root, 'scratch'), nested = path.join(target, 'nested')
  fs.mkdirSync(nested, { recursive: true }); fs.writeFileSync(path.join(target, 'keep-until-validation'), 'a'); fs.writeFileSync(path.join(nested, 'data'), 'b')
  const backend = require('../../agents/codex/workflow/windows-filesystem.js').createWindowsFilesystemCapture()
  const owned = backend.inspectOwnedTarget(target)
  assert.equal(owned.parentIdentity.ino, String(fs.lstatSync(root, { bigint: true }).ino))
  assert.equal(owned.targetIdentity.ino, String(fs.lstatSync(target, { bigint: true }).ino))
  const wrongTarget = { ...owned.targetIdentity, ino: String(BigInt(owned.targetIdentity.ino) + 1n) }
  assert.throws(() => backend.removeOwnedTarget(target, owned.parentIdentity, wrongTarget), { code: 'PREIMAGE_UNSAFE' })
  fs.linkSync(path.join(nested, 'data'), path.join(nested, 'hardlink'))
  assert.throws(() => backend.removeOwnedTarget(target, owned.parentIdentity, owned.targetIdentity), { code: 'PREIMAGE_UNSAFE' })
  assert.equal(fs.readFileSync(path.join(target, 'keep-until-validation'), 'utf8'), 'a')
  fs.unlinkSync(path.join(nested, 'hardlink'))
  assert.equal(backend.removeOwnedTarget(target, owned.parentIdentity, owned.targetIdentity).removed, true)
  assert.equal(fs.existsSync(target), false)
  assert.equal(backend.removeOwnedTarget(target, owned.parentIdentity, owned.targetIdentity).removed, false)
  assert.throws(() => backend.removeOwnedTarget(target, { ...owned.parentIdentity, ino: String(BigInt(owned.parentIdentity.ino) + 1n) }, owned.targetIdentity), { code: 'PREIMAGE_UNSAFE' })
  assert.throws(() => backend.captureFileBytes(path.join(root, 'missing')), { code: 'ENOENT' })
  assert.throws(() => backend.captureFileBytes(path.join(root, 'missing-parent', 'missing')), { code: 'PREIMAGE_UNSAFE' })
})

test('Windows transaction operations durably create, copy readonly projection, and rename without replacement', { skip: !windows }, t => {
  const root = fixture(t, true)
  const api = require('../../agents/codex/workflow/windows-filesystem.js').createWindowsFilesystemMutations()
  const source = path.join(root, 'source'), destination = path.join(root, 'copy'), renamed = path.join(root, 'renamed')
  assert.equal(api.mkdirExclusive(source, 0o700).stat.mode, 0o040666)
  assert.throws(() => api.mkdirExclusive(source, 0o700), { code: 'EEXIST' })
  const leaf = path.join(source, 'data'), bytes = Buffer.from([0, 255, 1, 13, 10])
  const first = api.writeExclusive(leaf, bytes, 0o600)
  assert.equal(first.stat.size, bytes.length)
  assert.throws(() => api.writeExclusive(leaf, Buffer.from('replacement'), 0o600), { code: 'EEXIST' })
  assert.equal(String(fs.lstatSync(leaf, { bigint: true }).ino), first.stat.ino)
  assert.deepEqual(fs.readFileSync(leaf), bytes)
  assert.deepEqual(api.fsyncDirectory(source), { flushed: true })
  assert.deepEqual(api.fsyncTree(source), { flushed: true })
  assert.deepEqual(api.fsyncTree(path.join(root, 'missing')), { flushed: false })
  assert.throws(() => api.fsyncDirectory(path.join(root, 'missing')), { code: 'ENOENT' })
  fs.chmodSync(leaf, 0o444)
  api.mkdirExclusive(path.join(source, 'empty'), 0o400)
  api.mkdirExclusive(path.join(source, 'nested'), 0o700)
  api.writeExclusive(path.join(source, 'nested', 'deep'), Buffer.from('nested bytes'), 0o600)
  const sourceState = api.captureTree(source)
  const copied = api.copyTreeExclusive(source, destination)
  assert.equal(api.captureTree(destination).hash, sourceState.hash)
  assert.equal(fs.statSync(path.join(destination, 'data')).mode & 0o777, 0o444)
  assert.throws(() => api.copyTreeExclusive(source, destination), { code: 'EEXIST' })
  const moved = api.renameTreeNoReplace(destination, renamed)
  assert.equal(moved.stat.ino, copied.stat.ino)
  assert.equal(fs.existsSync(destination), false)
  assert.equal(api.captureTree(renamed).hash, sourceState.hash)
  assert.throws(() => api.renameTreeNoReplace(renamed, source), { code: 'EEXIST' })
  assert.equal(api.captureTree(renamed).hash, sourceState.hash)
  const fileSource = path.join(root, 'file-source'), fileRenamed = path.join(root, 'file-renamed')
  const fileCreated = api.writeExclusive(fileSource, Buffer.from('file root'), 0o400)
  const fileMoved = api.renameTreeNoReplace(fileSource, fileRenamed)
  assert.equal(fileMoved.stat.ino, fileCreated.stat.ino)
  assert.equal(fs.existsSync(fileSource), false)
  assert.equal(fs.readFileSync(fileRenamed, 'utf8'), 'file root')
})

test('Windows transaction copy rejects hardlinks and reparse traversal before publication', { skip: !windows }, t => {
  const root = fixture(t, true), source = path.join(root, 'source'), outside = path.join(root, 'outside'), destination = path.join(root, 'copy')
  fs.mkdirSync(source); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'data'), 'guard')
  const api = require('../../agents/codex/workflow/windows-filesystem.js').createWindowsFilesystemMutations()
  fs.linkSync(path.join(outside, 'data'), path.join(source, 'linked'))
  assert.throws(() => api.copyTreeExclusive(source, destination), { code: 'PREIMAGE_UNSAFE' })
  assert.equal(fs.existsSync(destination), false)
  fs.unlinkSync(path.join(source, 'linked'))
  fs.symlinkSync(outside, path.join(source, 'junction'), 'junction')
  assert.throws(() => api.copyTreeExclusive(source, destination), { code: 'PREIMAGE_UNSAFE' })
  assert.equal(fs.existsSync(destination), false)
  assert.equal(fs.readFileSync(path.join(outside, 'data'), 'utf8'), 'guard')
})

test('Windows transaction rename refuses mutate-and-restore USN races and rolls the root back', { skip: !windows }, t => {
  const root = fixture(t, true)
  const api = require('../../agents/codex/workflow/windows-filesystem.js').createWindowsFilesystemMutations({ helper: usnRaceRunner(root) })
  const source = path.join(root, 'source'), copy = path.join(root, 'copy'), renamed = path.join(root, 'renamed')
  api.mkdirExclusive(source, 0o700)
  api.mkdirExclusive(path.join(source, 'empty'), 0o700)
  api.copyTreeExclusive(source, copy)
  assert.throws(() => api.renameTreeNoReplace(copy, renamed), { code: 'PREIMAGE_UNSAFE' })
  assert.equal(fs.existsSync(copy), true)
  assert.equal(fs.existsSync(renamed), false)
})
