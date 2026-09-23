'use strict'

const assert = require('node:assert/strict')
const cp = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const cmdShim = require('cmd-shim')
const { parseArgs } = require('../../bin/autoprompt.cjs')

test('activation freezes positional mission arguments after PowerShell consumes the separator', () => {
  for (const provider of ['codex', 'claude', 'opencode', 'kilo', 'prime', 'omp', 'deepseek', 'reasonix', 'grok', 'hermes', 'vscode']) {
    const tail = ['hello', '--target', 'mission text, not a controller path', '--ttl', '0']
    const parsed = parseArgs(['activate', provider, ...tail])
    assert.deepEqual(parsed.missionArgs, tail)
    assert.equal(parsed.target, undefined)
    assert.equal(parsed.ttlSeconds, undefined)
    assert.deepEqual(parseArgs(['activate', provider, '--', ...tail]), parsed)
    assert.throws(() => parseArgs(['activate', provider, '--unknown', 'hello']), /Unknown activate flag/)
    assert.throws(() => parseArgs(['activate', provider, '--ttl', '0', 'hello']), /--ttl requires/)
    assert.throws(() => parseArgs(['activate', provider]), /at least one mission/)
  }
})

const shells = process.platform === 'win32'
  ? [path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), 'pwsh']
  : [process.env.AUTOPROMPT_TEST_PWSH || 'pwsh']
for (const shell of shells) {
  const present = cp.spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { timeout: 10000 }).status === 0
  test(`real npm PowerShell shim preserves activation mission through ${path.basename(shell)}`, {
    skip: !present && process.platform !== 'win32' ? 'PowerShell unavailable' : false,
    timeout: 150000,
  }, async t => {
    assert.ok(present, `Required Windows shell is unavailable: ${shell}`)
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt argv '))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const entry = path.join(root, 'entry.cjs'), shim = path.join(root, 'autoprompt')
    fs.writeFileSync(entry, '#!/usr/bin/env node\n' +
      `const {parseArgs}=require(${JSON.stringify(path.resolve(__dirname, '../../bin/autoprompt.cjs'))});` +
      'process.stdout.write(JSON.stringify({argv:process.argv.slice(2),parsed:parseArgs(process.argv.slice(2))}));\n')
    await cmdShim(entry, shim)
    const quote = value => "'" + value.replaceAll("'", "''") + "'"
    for (const [separator, tail] of [
      ['--', ['hello with spaces', '--target', 'literal mission tail']],
      [quote('--'), ['--ttl', '0', 'mission beginning with an option-like token']],
    ]) {
      const result = cp.spawnSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        `& ${quote(shim + '.ps1')} activate opencode ${separator} ${tail.map(quote).join(' ')}`], {
        encoding: 'utf8', timeout: 60000,
        env: { ...process.env, PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH || process.env.Path || '') },
      })
      assert.equal(result.status, 0, result.stderr || result.error?.message)
      const observed = JSON.parse(result.stdout)
      assert.deepEqual(observed.parsed.missionArgs, tail)
      assert.equal(observed.parsed.target, undefined)
      assert.equal(observed.parsed.ttlSeconds, undefined)
      t.diagnostic(JSON.stringify({ shell, observedArgv: observed.argv }))
    }
  })
}
