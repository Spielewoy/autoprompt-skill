'use strict'

const assert = require('node:assert/strict')
const cp = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { packedToolPath } = require('../helpers/packed-tool-path.cjs')
const { platformBinding, resolveCodexExecutable } = require('../../agents/codex/workflow/codex-executable.js')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'packed shared tools '))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin)
  return { root, bin }
}

test('packed tool PATH hides quoted ambient Codex while preserving colocated executable origin, arguments and streams', t => {
  const { root, bin } = fixture(t)
  const suffix = process.platform === 'win32' ? '.exe' : ''
  fs.copyFileSync(process.execPath, path.join(bin, `node${suffix}`))
  fs.copyFileSync(process.execPath, path.join(bin, `codex${suffix}`))
  fs.writeFileSync(path.join(root, 'codex-package.json'), JSON.stringify({
    layoutVersion: 1, version: '0.148.0', target: platformBinding()[1], variant: 'codex',
    entrypoint: `bin/codex${suffix}`, resourcesDir: 'codex-resources', pathDir: 'codex-path',
  }))
  fs.writeFileSync(path.join(bin, 'adjacent-resource.txt'), 'original executable resource')
  const originalEnv = { ...process.env, PATH: `"${bin}"` }
  assert.equal(resolveCodexExecutable('codex', { environment: originalEnv }).source, 'standalone-package-runtime',
    'the ambient fixture must be discoverable before sanitizing PATH')
  const views = packedToolPath(path.join(root, 'views'), originalEnv)
  const mirror = views.at(-1)
  assert.ok(mirror.startsWith(path.join(root, 'views') + path.sep))
  const environment = { ...process.env, PATH: [mirror, ...views.filter(directory => directory !== mirror)].join(path.delimiter) }
  assert.throws(() => resolveCodexExecutable('codex', { environment }), { code: 'PROVIDER_UNSUPPORTED' })
  assert.equal(fs.existsSync(path.join(mirror, `codex${suffix}`)), false)
  const args = ['', 'space and 雪', 'a"quoted"value', 'trailing\\', 'two\\\\"slashes', '$x; &echo literal']
  const result = cp.spawnSync('node', ['-e', `const fs=require('node:fs'),path=require('node:path');process.stdout.write(JSON.stringify({args:process.argv.slice(1),input:fs.readFileSync(0,'utf8'),resource:fs.readFileSync(path.join(path.dirname(process.execPath),'adjacent-resource.txt'),'utf8')}));process.stderr.write('exact stderr');process.exitCode=23`, ...args],
    { env: environment, cwd: root, encoding: 'utf8', input: 'exact stdin', timeout: 30000 })
  assert.ifError(result.error)
  assert.equal(result.status, 23, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { args, input: 'exact stdin', resource: 'original executable resource' })
  assert.equal(result.stderr, 'exact stderr')
})

test('packed tool PATH preserves a real Python virtualenv sharing its bin with Codex', { skip: process.platform === 'win32' }, t => {
  const { root } = fixture(t)
  const venv = path.join(root, 'python environment')
  const created = cp.spawnSync('python3', ['-m', 'venv', '--without-pip', venv], { encoding: 'utf8', timeout: 30000 })
  assert.ifError(created.error)
  assert.equal(created.status, 0, created.stderr)
  const bin = path.join(venv, 'bin')
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nexit 93\n', { mode: 0o700 })
  const views = packedToolPath(path.join(root, 'views'), { ...process.env, PATH: `"${bin}"` })
  const environment = { ...process.env, PATH: [views.at(-1), ...views.slice(0, -1)].join(path.delimiter) }
  const result = cp.spawnSync('python', ['-c', 'import sys; print(sys.prefix)'], { env: environment, encoding: 'utf8', timeout: 30000 })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(fs.realpathSync(result.stdout.trim()), fs.realpathSync(venv))
})

test('packed Windows batch tools retain literal percent paths and their original adjacent resources', { skip: process.platform !== 'win32' }, t => {
  const { root } = fixture(t)
  const bin = path.join(root, 'shared %PACKED_WRONG_TARGET% tools')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'codex.cmd'), '@exit /b 93\r\n')
  fs.writeFileSync(path.join(bin, 'worker.cmd'), '@echo off\r\n@type "%~dp0resource.txt"\r\n@echo [%~1]\r\n@exit /b 29\r\n')
  fs.writeFileSync(path.join(bin, 'resource.txt'), 'original batch resource\r\n')
  const originalEnv = { ...process.env, PATH: `"${bin}"`, PACKED_WRONG_TARGET: 'must-not-expand' }
  const views = packedToolPath(path.join(root, 'views'), originalEnv)
  const target = path.join(views.at(-1), 'worker.cmd')
  const comspec = path.join(process.env.SystemRoot, 'System32', 'cmd.exe')
  const result = cp.spawnSync(comspec, ['/d', '/s', '/c', `""${target}" "argument with spaces""`], {
    env: originalEnv, windowsVerbatimArguments: true, encoding: 'utf8', timeout: 30000,
  })
  assert.ifError(result.error)
  assert.equal(result.status, 29, result.stderr)
  assert.equal(result.stdout.replaceAll('\r\n', '\n'), 'original batch resource\n[argument with spaces]\n')
})
