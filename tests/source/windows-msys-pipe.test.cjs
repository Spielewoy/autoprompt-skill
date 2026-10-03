'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cp = require('node:child_process')

test('native Windows pipe diagnostic records namespace and descriptor outcomes under an AppContainer token', { skip: process.platform !== 'win32', timeout: 600000 }, t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'native-msys-pipe-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const { ensureWindowsPrivateAcl } = require('../../agents/codex/workflow/safe-run-root.js')
  ensureWindowsPrivateAcl(root)
  const child = path.join(root, 'child'), control = path.join(root, 'control')
  for (const directory of [child, control]) { fs.mkdirSync(directory); ensureWindowsPrivateAcl(directory) }
  const nativeSource = path.join(control, 'windows-appcontainer-native.cs'), fixtureSource = path.join(control, 'pipe-proof.cs')
  fs.copyFileSync(path.resolve(__dirname, '../../agents/codex/workflow/windows-appcontainer-native.cs'), nativeSource, fs.constants.COPYFILE_EXCL)
  fs.copyFileSync(path.resolve(__dirname, '../fixtures/windows-msys/pipe-proof.cs'), fixtureSource, fs.constants.COPYFILE_EXCL)
  const executable = path.join(child, 'pipe-proof.exe'), controller = path.join(control, 'pipe-controller.exe'), systemRoot = process.env.SystemRoot
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const environment = { SystemRoot: systemRoot, WINDIR: systemRoot, SystemDrive: systemRoot.slice(0, 2),
    PATH: path.join(systemRoot, 'System32'), TEMP: control, TMP: control,
    AUTOPROMPT_PIPE_NATIVE: nativeSource, AUTOPROMPT_PIPE_FIXTURE: fixtureSource, AUTOPROMPT_PIPE_EXE: controller }
  const compiled = cp.spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop";Add-Type -Path @($env:AUTOPROMPT_PIPE_NATIVE,$env:AUTOPROMPT_PIPE_FIXTURE) -OutputAssembly $env:AUTOPROMPT_PIPE_EXE -OutputType ConsoleApplication'], {
    encoding: 'utf8', timeout: 60000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: environment,
  })
  assert.ifError(compiled.error)
  assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)
  // Grant only the unmapped child image; the running controller stays private.
  fs.copyFileSync(controller, executable, fs.constants.COPYFILE_EXCL)
  const result = cp.spawnSync(controller, [executable], { encoding: 'utf8', timeout: 45000, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'], cwd: control,
    env: { SystemRoot: systemRoot, WINDIR: systemRoot, SystemDrive: systemRoot.slice(0, 2),
      PATH: path.join(systemRoot, 'System32'), TEMP: control, TMP: control },
  })
  // Publish bounded observations before assertions so a native failure keeps
  // its evidence in TAP and in the workflow's streamed platform log.
  t.diagnostic(`MSYS pipe probe status: ${result.status}`)
  // Live CI logs truncate long lines. Preserve every bounded observation on
  // separate short lines instead of embedding the complete JSON as a string.
  for (const [stream, bound] of [['stdout', 32768], ['stderr', 8192]]) {
    const output = String(result[stream] || '').slice(0, bound)
    if (!output) continue
    let diagnostic = output
    try { diagnostic = JSON.stringify(JSON.parse(output), null, 2) } catch {}
    for (const line of diagnostic.split(/\r?\n/)) {
      for (let offset = 0; offset < line.length; offset += 512) t.diagnostic(`${stream}: ${line.slice(offset, offset + 512)}`)
    }
  }
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(result.stderr, '')
  const proof = JSON.parse(result.stdout)
  assert.deepEqual(Object.keys(proof).sort(), ['child', 'controller', 'ntController'])
  assert.deepEqual(Object.keys(proof.child).sort(), ['appContainer', 'cases', 'ntRoots'])
  assert.equal(proof.child.appContainer, true)
  for (const [label, cases] of [['controller', proof.controller], ['child', proof.child.cases]]) {
    assert.equal(cases.length, 8)
    let index = 0
    for (const namespace of ['bare', 'local']) for (const descriptor of ['world', 'user', 'package', 'default']) {
      const observation = cases[index++]
      assert.deepEqual(Object.keys(observation).sort(), ['clientError', 'descriptor', 'expanded', 'namespace', 'serverError'])
      assert.equal(observation.namespace, namespace)
      assert.equal(observation.descriptor, descriptor)
      assert.ok(Number.isSafeInteger(observation.serverError) && observation.serverError >= 0)
      if (observation.serverError === 0) assert.ok(Number.isSafeInteger(observation.clientError) && observation.clientError >= 0)
      else assert.equal(observation.clientError, null, 'A failed listener must not probe an unrelated client endpoint')
      if (label === 'controller' && descriptor !== 'default') assert.deepEqual([observation.serverError, observation.clientError], [0, 0])
      if (namespace === 'local' && descriptor === 'package') assert.deepEqual([observation.serverError, observation.clientError], [0, 0],
        `${label}: the private LOCAL package pipe must create and reopen`)
      if (namespace !== 'local' || descriptor === 'default' || observation.serverError !== 0 || observation.clientError !== 0) {
        assert.equal(observation.expanded, null)
        continue
      }
      const expanded = observation.expanded
      assert.deepEqual(Object.keys(expanded).sort(), ['client', 'flat', 'name', 'parent', 'query', 'relativeName', 'relativeQuery', 'root', 'server'])
      function succeeded(status) {
        if (status === null) return false
        assert.deepEqual(Object.keys(status).sort(), ['status', 'win32Error'])
        assert.match(status.status, /^[0-9A-F]{8}$/)
        assert.ok(Number.isSafeInteger(status.win32Error) && status.win32Error >= 0 && status.win32Error <= 0xffffffff)
        return Number.parseInt(status.status, 16) < 0x80000000
      }
      function ownedName(name) {
        assert.equal(typeof name, 'string')
        assert.ok(name.length <= 512)
        assert.match(name, /^\\Device\\NamedPipe\\(?:[A-Za-z0-9_{}.\\-]+\\)?autoprompt-msys-proof-[a-f0-9]{32}$/i)
        assert.ok(!name.split('\\').some(part => part === '.' || part === '..'))
      }
      assert.notEqual(expanded.query, null)
      if (descriptor === 'package') assert.equal(succeeded(expanded.query), true,
        `${label}: the owned private LOCAL pipe name must be queryable`)
      if (!succeeded(expanded.query)) {
        for (const key of ['name', 'parent', 'root', 'server', 'client', 'relativeQuery', 'relativeName', 'flat']) assert.equal(expanded[key], null)
        continue
      }
      ownedName(expanded.name)
      assert.equal(expanded.parent, expanded.name.slice(0, expanded.name.lastIndexOf('\\') + 1))
      // The flat proof is independent of whether NPFS exposes a traversable
      // parent directory. Only the package cell runs it, keeping output bounded.
      if (descriptor !== 'package') assert.equal(expanded.flat, null)
      else {
        const flat = expanded.flat
        assert.deepEqual(Object.keys(flat).sort(), ['afterClient', 'beforeClient', 'client', 'name', 'query', 'relativeName', 'root', 'server'])
        for (const key of ['root', 'server', 'client', 'query']) assert.equal(succeeded(flat[key]), true,
          `${label}: the observed flat NPFS namespace must support ${key}`)
        assert.equal(typeof flat.relativeName, 'string')
        assert.ok(flat.relativeName.length > 0 && flat.relativeName.length <= 512)
        assert.equal(flat.relativeName.startsWith('\\'), false)
        const intended = '\\Device\\NamedPipe\\' + flat.relativeName
        ownedName(intended)
        assert.equal(intended.slice(0, intended.lastIndexOf('\\') + 1), expanded.parent)
        assert.notEqual(intended, expanded.name, 'Flat proof creates a fresh independently owned name')
        function waitObservation(value) {
          assert.deepEqual(Object.keys(value).sort(), ['cancellation', 'completion', 'drainWait', 'drainWaitError', 'drained', 'elapsedMs', 'initialWait', 'initialWaitError', 'submission', 'timeoutMs', 'watchdogExpired'])
          assert.equal(value.timeoutMs, 50)
          assert.ok(Number.isSafeInteger(value.elapsedMs) && value.elapsedMs >= 0 && value.elapsedMs <= 15000)
          for (const key of ['submission', 'completion', 'cancellation']) {
            if (key === 'cancellation' && value[key] === null) continue
            assert.notEqual(value[key], null)
            succeeded(value[key]) // Validate the closed native status record; outcome is observational.
          }
          assert.equal(value.drained, true)
          assert.notEqual(value.completion.status, '00000103', 'A pending request must never be reported as drained')
          for (const key of ['initialWait', 'drainWait', 'initialWaitError', 'drainWaitError']) {
            assert.ok(value[key] === null || (Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= 0xffffffff))
          }
          if (value.submission.status === '00000103') {
            assert.notEqual(value.initialWait, null)
            if (value.initialWait === 0) {
              for (const key of ['cancellation', 'drainWait', 'drainWaitError']) assert.equal(value[key], null)
            } else {
              assert.notEqual(value.cancellation, null)
              assert.notEqual(value.cancellation.status, '00000103')
              assert.equal(value.drainWait, 0, 'Cancellation alone cannot prove original request completion')
              assert.equal(value.drainWaitError, null)
            }
            assert.equal(value.watchdogExpired, value.initialWait === 258)
            if (value.initialWait === 0xffffffff) assert.notEqual(value.initialWaitError, null)
            else assert.equal(value.initialWaitError, null)
          } else {
            for (const key of ['cancellation', 'initialWait', 'drainWait', 'initialWaitError', 'drainWaitError']) assert.equal(value[key], null)
            assert.equal(value.watchdogExpired, false)
          }
        }
        // Native x64/ARM64 observations establish these two distinct states:
        // the fresh listener is available; its sole connected instance is busy.
        for (const [key, status] of [['beforeClient', '00000000'], ['afterClient', 'C00000B5']]) {
          waitObservation(flat[key])
          assert.equal(flat[key].completion.status, status, `${label}: ${key} must reflect actual pipe availability`)
          assert.equal(flat[key].watchdogExpired, false)
          assert.equal(flat[key].cancellation, null)
        }
        assert.notEqual(flat.root, null)
        if (!succeeded(flat.root)) {
          for (const key of ['server', 'client', 'query', 'name', 'beforeClient', 'afterClient']) assert.equal(flat[key], null)
        } else {
          assert.notEqual(flat.server, null)
          if (!succeeded(flat.server)) {
            for (const key of ['client', 'query', 'name', 'beforeClient', 'afterClient']) assert.equal(flat[key], null)
          } else {
            // A fresh native server is not assumed to be LISTENING. Record
            // before/after-client wait codes without manufacturing availability.
            waitObservation(flat.beforeClient)
            assert.notEqual(flat.client, null)
            if (!succeeded(flat.client)) {
              for (const key of ['query', 'name', 'afterClient']) assert.equal(flat[key], null)
            } else {
              waitObservation(flat.afterClient)
              assert.notEqual(flat.query, null)
              if (succeeded(flat.query)) { ownedName(flat.name); assert.equal(flat.name, intended) }
              else assert.equal(flat.name, null)
            }
          }
        }
      }
      assert.notEqual(expanded.root, null)
      if (!succeeded(expanded.root)) {
        for (const key of ['server', 'client', 'relativeQuery', 'relativeName']) assert.equal(expanded[key], null)
        continue
      }
      assert.notEqual(expanded.server, null)
      if (!succeeded(expanded.server)) {
        for (const key of ['client', 'relativeQuery', 'relativeName']) assert.equal(expanded[key], null)
        continue
      }
      assert.notEqual(expanded.client, null)
      if (!succeeded(expanded.client)) {
        assert.equal(expanded.relativeQuery, null)
        assert.equal(expanded.relativeName, null)
        continue
      }
      assert.notEqual(expanded.relativeQuery, null)
      if (succeeded(expanded.relativeQuery)) {
        ownedName(expanded.relativeName)
        assert.equal(expanded.relativeName.slice(0, expanded.relativeName.lastIndexOf('\\') + 1), expanded.parent)
        assert.notEqual(expanded.relativeName, expanded.name)
      } else assert.equal(expanded.relativeName, null)

    }
  }
  for (const [label, cases] of [['controller', proof.ntController], ['child', proof.child.ntRoots]]) {
    assert.equal(cases.length, 2)
    for (const [index, namespace] of ['bare', 'local'].entries()) {
      const observation = cases[index]
      assert.deepEqual(Object.keys(observation).sort(), ['client', 'namespace', 'root', 'server'])
      assert.equal(observation.namespace, namespace)
      let previousSucceeded = true
      for (const stage of ['root', 'server', 'client']) {
        const status = observation[stage]
        if (!previousSucceeded) { assert.equal(status, null); continue }
        assert.deepEqual(Object.keys(status).sort(), ['status', 'win32Error'])
        assert.match(status.status, /^[0-9A-F]{8}$/)
        assert.ok(Number.isSafeInteger(status.win32Error) && status.win32Error >= 0 && status.win32Error <= 0xffffffff)
        previousSucceeded = Number.parseInt(status.status, 16) < 0x80000000
        if (label === 'controller' && namespace === 'bare') assert.equal(previousSucceeded, true, 'Direct NT bare controller must create and open its owned pipe')
      }
    }
  }
  // Child outcomes are intentionally observations. Existing native Git Bash
  // capability tests remain the mandatory compatibility and isolation gates.
})

test('native pipe wait lease proves completion before freeing request memory', { timeout: 90000 }, t => {
  const powershell = process.platform === 'win32'
    ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'pwsh'
  const available = cp.spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8', timeout: 15000 })
  if (available.error?.code === 'ENOENT' && process.platform !== 'win32') { t.skip('PowerShell is unavailable'); return }
  assert.ifError(available.error)
  assert.equal(available.status, 0, available.stderr)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-wait-lifetime-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const fixture = fs.readFileSync(path.join(__dirname, '../fixtures/windows-msys/pipe-proof.cs'), 'utf8')
  // Compile the exact lease and wait implementation without unrelated launch
  // code; replace only the six native calls with controlled test substitutes.
  let source = fixture.slice(0, fixture.indexOf(' static String ProbeFlatRoot(')) + '\n}\n'
  const replacements = {
    NtFsControlFile: 'return PipeWaitFake.Submit(handle,signal,apc,context,io,control,input,inputLength,output,outputLength);',
    NtCancelIoFileEx: 'return PipeWaitFake.Cancel(handle,requestIo,cancelIo);',
    CreateEventW: 'return PipeWaitFake.Event(attributes,manualReset,initialState,name);',
    WaitForSingleObject: 'return PipeWaitFake.Wait(handle,milliseconds);',
    CloseHandle: 'return PipeWaitFake.Close(handle);',
    RtlNtStatusToDosError: 'return PipeWaitFake.Map(status);',
  }
  for (const [name, body] of Object.entries(replacements)) {
    const pattern = new RegExp('^ \\[DllImport\\([^\\n]+\\] static extern ([^\\n]+ ' + name + '\\([^\\n]+\\));$', 'gm')
    assert.equal([...source.matchAll(pattern)].length, 1, `One exact import must bind ${name}`)
    source = source.replace(pattern, ' static $1 {' + body + '}')
  }
  source += fs.readFileSync(path.join(__dirname, '../fixtures/windows-msys/pipe-wait-lifetime.cs'), 'utf8')
  const copied = path.join(root, 'wait.cs')
  fs.writeFileSync(copied, source)
  const result = cp.spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop"; Add-Type -Path $env:AUTOPROMPT_WAIT_SOURCE; 0..10 | ForEach-Object { [PipeWaitFake]::Run($_) }'], {
    encoding: 'utf8', timeout: 60000, env: { ...process.env, AUTOPROMPT_WAIT_SOURCE: copied },
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const cases = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line))
  assert.equal(cases.length, 11)
  for (const [mode, value] of cases.entries()) {
    assert.equal(value.mode, mode)
    assert.equal(value.submits, 1)
    assert.equal(value.closes, 1, 'A proven complete lease closes once; a retained lease closes only in explicit test teardown')
    assert.equal(value.cancels, mode >= 3 && mode <= 8 ? 1 : 0)
    assert.equal(value.waits, mode === 0 || mode === 1 || mode === 10 ? 0 : mode >= 3 && mode <= 8 ? 2 : 1)
    if (mode >= 6) {
      assert.equal(value.report, null)
      assert.equal(value.retained, true)
      assert.equal(value.rootHeld, true)
      assert.equal(value.retryRefused, true)
      assert.equal(value.memoryReadable, true)
      assert.equal(value.error, mode === 6 ? 'flat-wait-undrained' : mode === 7 || mode === 8 ? 'flat-wait-cancel-incomplete' : mode === 9 ? 'flat-wait-pending-after-event' : 'flat-wait-inconsistent-completion')
    } else {
      assert.equal(value.error, null)
      assert.equal(value.retained, false)
      assert.equal(value.report.drained, true)
      assert.equal(value.report.timeoutMs, 50)
      assert.equal(value.report.submission.status, mode === 0 ? 'C0000022' : mode === 1 ? '00000000' : '00000103')
      assert.equal(value.report.completion.status, ['C0000022', '00000000', 'C00000B5', 'C0000120', '00000000', 'C0000120'][mode])
      assert.equal(value.report.watchdogExpired, mode === 3 || mode === 4)
      if (mode === 4) assert.equal(value.report.cancellation.status, 'C0000225', 'A cancellation-not-found race still requires original completion')
      if (mode === 5) assert.ok(Number.isInteger(value.report.initialWaitError))
    }
  }
})

test('native pipe default descriptor passes literal null security attributes for both endpoints', { timeout: 90000 }, t => {
  const powershell = process.platform === 'win32'
    ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'pwsh'
  const available = cp.spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8', timeout: 15000 })
  if (available.error?.code === 'ENOENT' && process.platform !== 'win32') { t.skip('PowerShell is unavailable'); return }
  assert.ifError(available.error)
  assert.equal(available.status, 0, available.stderr)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-default-sa-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const original = fs.readFileSync(path.join(__dirname, '../fixtures/windows-msys/pipe-proof.cs'), 'utf8')
  let source = original.slice(0, original.indexOf(' // Protect the child file')) + `
 public static int DefaultServers,DefaultClients,ExplicitServers,ExplicitClients,Descriptors;
 public static string RunDefaultSaProof(){return Probe("S-1-5-21-1","S-1-15-2-1",true);}
}\n`
  const replace = (name, signature, body) => {
    const pattern = new RegExp('^ \\[DllImport\\([^\\n]+\\] static extern ([^\\n]+ ' + name + '\\(' + signature + '\\));$', 'gm')
    assert.equal([...source.matchAll(pattern)].length, 1, `One exact import must bind ${name} ${signature}`)
    source = source.replace(pattern, ' static $1 {' + body + '}')
  }
  // Copy and compile the actual eight-cell dispatch. Only native boundaries
  // are replaced; these substitutes distinguish SA-by-reference from NULL SA.
  replace('CreateNamedPipeW', '[^\\n]+,IntPtr attributes', 'Require(attributes==IntPtr.Zero,"default-server-not-null");DefaultServers++;return new IntPtr(101);')
  replace('CreateNamedPipeW', '[^\\n]+,ref SA attributes', 'Require(attributes.Descriptor!=IntPtr.Zero,"explicit-server-missing-descriptor");ExplicitServers++;return new IntPtr(101);')
  replace('CreateFileW', '[^\\n]+,IntPtr attributes,UInt32 disposition,UInt32 flags,IntPtr template', 'Require(attributes==IntPtr.Zero,"default-client-not-null");DefaultClients++;return new IntPtr(102);')
  replace('CreateFileW', '[^\\n]+,ref SA attributes,UInt32 disposition,UInt32 flags,IntPtr template', 'Require(attributes.Descriptor!=IntPtr.Zero,"explicit-client-missing-descriptor");ExplicitClients++;return new IntPtr(102);')
  replace('ConvertStringSecurityDescriptorToSecurityDescriptor', '[^\\n]+', 'Descriptors++;descriptor=new IntPtr(103);size=64;return true;')
  replace('NtQueryObject', '[^\\n]+', 'returned=0;return unchecked((Int32)0xc0000022);')
  replace('RtlNtStatusToDosError', '[^\\n]+', 'return 5;')
  replace('LocalFree', '[^\\n]+', 'return IntPtr.Zero;')
  replace('CloseHandle', '[^\\n]+', 'return true;')
  const copied = path.join(root, 'default-sa.cs')
  fs.writeFileSync(copied, source)
  const result = cp.spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop";Add-Type -Path $env:AUTOPROMPT_DEFAULT_SA_SOURCE;[MsysPipeProof]::RunDefaultSaProof();@([MsysPipeProof]::DefaultServers,[MsysPipeProof]::DefaultClients,[MsysPipeProof]::ExplicitServers,[MsysPipeProof]::ExplicitClients,[MsysPipeProof]::Descriptors)|ConvertTo-Json -Compress'], {
    encoding: 'utf8', timeout: 60000, env: { ...process.env, AUTOPROMPT_DEFAULT_SA_SOURCE: copied },
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const [cases, counts] = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line))
  assert.equal(cases.length, 8)
  assert.deepEqual(counts, [2, 2, 6, 6, 6], 'Default cells must never construct an explicit descriptor')
  assert.deepEqual(cases.filter(value => value.descriptor === 'default').map(value => [value.namespace, value.expanded]), [['bare', null], ['local', null]])
})
