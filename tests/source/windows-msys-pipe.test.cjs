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
  t.diagnostic(`MSYS pipe probe: ${JSON.stringify({ status: result.status, stdout: result.stdout?.slice(0, 16384), stderr: result.stderr?.slice(0, 8192) })}`)
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(result.stderr, '')
  const proof = JSON.parse(result.stdout)
  assert.deepEqual(Object.keys(proof).sort(), ['child', 'controller', 'ntController'])
  assert.deepEqual(Object.keys(proof.child).sort(), ['appContainer', 'cases', 'ntRoots'])
  assert.equal(proof.child.appContainer, true)
  for (const [label, cases] of [['controller', proof.controller], ['child', proof.child.cases]]) {
    assert.equal(cases.length, 6)
    let index = 0
    for (const namespace of ['bare', 'local']) for (const descriptor of ['world', 'user', 'package']) {
      const observation = cases[index++]
      assert.deepEqual(Object.keys(observation).sort(), ['clientError', 'descriptor', 'expanded', 'namespace', 'serverError'])
      assert.equal(observation.namespace, namespace)
      assert.equal(observation.descriptor, descriptor)
      assert.ok(Number.isSafeInteger(observation.serverError) && observation.serverError >= 0)
      if (observation.serverError === 0) assert.ok(Number.isSafeInteger(observation.clientError) && observation.clientError >= 0)
      else assert.equal(observation.clientError, null, 'A failed listener must not probe an unrelated client endpoint')
      if (label === 'controller') assert.deepEqual([observation.serverError, observation.clientError], [0, 0])
      if (namespace !== 'local' || observation.serverError !== 0 || observation.clientError !== 0) {
        assert.equal(observation.expanded, null)
        continue
      }
      const expanded = observation.expanded
      assert.deepEqual(Object.keys(expanded).sort(), ['client', 'name', 'parent', 'query', 'relativeName', 'relativeQuery', 'root', 'server'])
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
      if (!succeeded(expanded.query)) {
        for (const key of ['name', 'parent', 'root', 'server', 'client', 'relativeQuery', 'relativeName']) assert.equal(expanded[key], null)
        continue
      }
      ownedName(expanded.name)
      assert.equal(expanded.parent, expanded.name.slice(0, expanded.name.lastIndexOf('\\') + 1))
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
