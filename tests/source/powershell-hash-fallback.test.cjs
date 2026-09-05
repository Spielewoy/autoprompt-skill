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
const LIBRARY = path.join(ROOT, 'scripts', 'install', 'lib', 'install-lib.ps1')
const BASH_LIBRARY = path.join(ROOT, 'scripts', 'install', 'lib', 'install-lib.sh')
const BASH = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash'
const HAS_BASH = childProcess.spawnSync(BASH, ['--version'], { stdio: 'ignore' }).status === 0

function bashPath(value) {
  return value.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`)
}

function runHashBash(program, args, options = {}) {
  return childProcess.spawnSync(BASH, ['-c', `. "$1"\n${program}`, 'hash-fixture', bashPath(BASH_LIBRARY), ...args], {
    encoding: 'utf8', timeout: 10000, ...options,
    env: { ...process.env, AUTOPROMPT_INSTALL_LIB_SH: '', ...options.env },
  })
}

test('Bash hashes binary bytes through actual GNU escaped filenames and option-like operands', {
  skip: !HAS_BASH,
}, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt shell hash '))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const bytes = Buffer.concat([Buffer.from([0, 255, 128]), Buffer.from('line one\r\nline two\n')])
  const expected = crypto.createHash('sha256').update(bytes).digest('hex')
  const names = process.platform === 'win32'
    ? ['payload.bin', '--binary']
    : ['payload.bin', 'back\\slash.bin', 'line\nbreak.bin', '--binary']
  for (const name of names) {
    const file = path.join(directory, name)
    fs.writeFileSync(file, bytes)
    const operand = name.startsWith('-') ? name : file
    const raw = runHashBash('sha256sum -- "$2"', [operand], { cwd: directory })
    assert.equal(raw.status, 0, raw.stderr)
    if (operand.includes('\\') || operand.includes('\n')) {
      assert.ok(raw.stdout.startsWith(`\\${expected} `), 'real GNU output must contain its filename-escape marker')
    }
    const result = runHashBash('_idem_sha256 "$2"', [operand], { cwd: directory })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, expected, JSON.stringify(operand))
    assert.equal(result.stderr, '')
  }
})

test('Bash hash fallbacks validate tool records and reject malformed hashes or failed commands', {
  skip: !HAS_BASH,
}, () => {
  const hash = 'a'.repeat(64)
  const program = [
    'command() {',
    '  if [ "$1" = -v ]; then',
    '    case "$2" in sha256sum|shasum|openssl) [ "$2" = "$AP_TEST_HASH_BACKEND" ]; return ;; esac',
    '  fi',
    '  builtin command "$@"',
    '}',
    'sha256sum() { printf "%s\\n" "$AP_TEST_HASH_OUTPUT"; return "$AP_TEST_HASH_STATUS"; }',
    'shasum() { sha256sum "$@"; }',
    'openssl() { sha256sum "$@"; }',
    '_idem_sha256 ignored-file',
  ].join('\n')
  for (const backend of ['sha256sum', 'shasum', 'openssl']) {
    const record = backend === 'openssl' ? `SHA2-256(payload)= ${hash}` : `\\${hash}  escaped\\\\name`
    const environment = { AP_TEST_HASH_BACKEND: backend, AP_TEST_HASH_OUTPUT: record, AP_TEST_HASH_STATUS: '0' }
    const valid = runHashBash(program, [], { env: environment })
    assert.equal(valid.status, 0, `${backend}: ${valid.stderr}`)
    assert.equal(valid.stdout, hash)
    for (const malformed of [
      hash,
      record.replace(hash, 'a'.repeat(63)),
      record.replace(hash, 'a'.repeat(65)),
      record.replace(hash, `g${hash.slice(1)}`),
      record.replace(hash, `\\${hash}`),
    ]) {
      const invalid = runHashBash(program, [], { env: { ...environment, AP_TEST_HASH_OUTPUT: malformed } })
      assert.equal(invalid.status, 42, `${backend}: ${JSON.stringify(malformed)}`)
      assert.equal(invalid.stdout, '', 'malformed tool output must not become a receipt hash')
    }
    const failed = runHashBash(program, [], { env: { ...environment, AP_TEST_HASH_STATUS: '9' } })
    assert.equal(failed.status, 42)
    assert.equal(failed.stdout, '')
  }
})

test('Codex Bash stable-source copy accepts escaped paths but still rejects source mutation', {
  skip: !HAS_BASH,
}, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt codex hash copy '))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const source = path.join(directory, process.platform === 'win32' ? 'source.bin' : 'source\\escaped.bin')
  const target = path.join(directory, 'copied.bin')
  const bytes = Buffer.from('stable\r\nbytes\0\xff', 'latin1')
  fs.writeFileSync(source, bytes)
  const program = [
    'expected="$(_idem_sha256 "$2")" || exit "$?"',
    'mutate_source() { printf changed >> "$1"; }',
    '_idem_codex_stable_source_copy "$3" "$2" "$4" "$expected" "${AP_TEST_COPY_HOOK:-}"',
  ].join('\n')
  const args = [source, bashPath(directory), bashPath(target)]
  const stable = runHashBash(program, args)
  assert.equal(stable.status, 0, stable.stderr)
  assert.deepEqual(fs.readFileSync(target), bytes)
  fs.unlinkSync(target)
  const changed = runHashBash(program, args, { env: { AP_TEST_COPY_HOOK: 'mutate_source' } })
  assert.equal(changed.status, 46, changed.stderr)
  assert.match(changed.stderr, /SOURCE_CHANGED_DURING_COPY/)
  assert.equal(fs.existsSync(target), false)
  assert.deepEqual(fs.readdirSync(directory), [path.basename(source)], 'failed copies leave no staged publication')
})

function quotePowerShell(value) {
  return `'${value.replaceAll("'", "''")}'`
}

test('PowerShell hashing falls back to .NET when Get-FileHash is unavailable', {
  skip: process.platform !== 'win32',
}, () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt hash fallback '))
  const source = path.join(sandbox, 'payload')
  const bytes = Buffer.from('autoprompt hash fallback\n', 'utf8')
  fs.writeFileSync(source, bytes)
  const expected = crypto.createHash('sha256').update(bytes).digest('hex')
  const program = [
    `$ErrorActionPreference = 'Stop'`,
    `. ${quotePowerShell(LIBRARY)}`,
    `function global:Get-FileHash { throw 'simulated unavailable cmdlet' }`,
    `$value = Get-IdemSha256 -Path ${quotePowerShell(source)}`,
    `if ($value -isnot [string]) { exit 42 }`,
    `[Console]::Out.WriteLine($value)`,
  ].join('; ')

  try {
    const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const completed = childProcess.spawnSync(powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', program,
    ], { encoding: 'utf8' })
    assert.equal(completed.status, 0, completed.stderr)
    assert.equal(completed.stdout.trim(), expected)
    assert.equal(completed.stderr, '')
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('PowerShell validation resolves a real PATH Python outside fixed install roots', {
  skip: process.platform !== 'win32',
}, () => {
  const discovered = childProcess.spawnSync('python', [
    '-c', 'import sys,yaml,tomllib;print(sys.executable)',
  ], { encoding: 'utf8' })
  assert.equal(discovered.status, 0, discovered.stderr)
  const python = discovered.stdout.trim()
  assert.equal(fs.existsSync(python), true)

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt python resolver '))
  const program = [
    `$ErrorActionPreference = 'Stop'`,
    `. ${quotePowerShell(LIBRARY)}`,
    `$value = Resolve-VerifyPython`,
    `if ($null -eq $value) { exit 65 }`,
    `[Console]::Out.WriteLine($value)`,
  ].join('; ')
  const env = {
    ...process.env,
    LOCALAPPDATA: sandbox,
    ProgramFiles: sandbox,
    'ProgramFiles(x86)': sandbox,
    PATH: `${path.dirname(python)}${path.delimiter}${process.env.SystemRoot}\\System32`,
  }

  try {
    const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const completed = childProcess.spawnSync(powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', program,
    ], { encoding: 'utf8', env })
    assert.equal(completed.status, 0, completed.stderr)
    assert.equal(path.resolve(completed.stdout.trim()), path.resolve(python))
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})
