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
const LIBRARY_PS1 = path.join(ROOT, 'scripts', 'install', 'lib', 'install-lib.ps1')
const LIBRARY_SH = path.join(ROOT, 'scripts', 'install', 'lib', 'install-lib.sh')
const POWERSHELL = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
const BASH = process.platform === 'win32'
  ? 'C:\\Program Files\\Git\\bin\\bash.exe'
  : 'bash'
const HAS_POWERSHELL = childProcess.spawnSync(
  POWERSHELL,
  ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'],
).status === 0
const HAS_BASH = childProcess.spawnSync(BASH, ['--version']).status === 0

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function serializeHashManifest(entries) {
  const rows = entries.map(([file, hash], index) =>
    `    ${JSON.stringify(file)}: ${JSON.stringify(hash)}${index + 1 < entries.length ? ',' : ''}`)
  return `{\n${rows.join('\n')}\n}\n`
}

function psLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`
}

function shellLiteral(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function bashPath(value) {
  return value.replaceAll('\\', '/').replace(
    /^([A-Za-z]):/,
    (_, drive) => `/${drive.toLowerCase()}`,
  )
}

function createReceiptFixture(prefix, drift = true, fingerprinted = true) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const root = path.join(sandbox, 'codex-root')
  const managed = path.join(root, 'skills', 'autoprompt', 'SKILL.md')
  const manifest = path.join(root, '.autoprompt-install-hashes.json')
  const receipt = path.join(root, '.autoprompt-install-receipt.json')
  const installed = Buffer.from('installed Codex payload\n')
  fs.mkdirSync(path.dirname(managed), { recursive: true })
  fs.writeFileSync(managed, installed)
  fs.writeFileSync(manifest, fingerprinted
    ? `{\n    ${JSON.stringify(managed)}: "${sha256(installed)}"\n}\n`
    : '{\n}\n')
  fs.writeFileSync(receipt, `${JSON.stringify({
    nonce: 'receipt-lifecycle-test',
    backup: null,
    files: [managed, manifest],
    createdDirectories: [],
    ompManaged: false,
    ompDetachedRoot: null,
    configEdits: [],
  }, null, 2)}\n`)
  if (drift) fs.appendFileSync(managed, 'user-owned drift\n')
  return { sandbox, root, managed, manifest, receipt }
}

function createUpdateFixture(prefix, transform = value => value) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const root = path.join(sandbox, 'codex-root')
  const current = path.join(root, 'skills', 'autoprompt', 'SKILL.md')
  const retiredClean = path.join(root, 'skills', 'autoprompt', 'obsolete', 'stale.txt')
  const retiredDrift = path.join(root, 'skills', 'autoprompt', 'retired-drift.txt')
  const manifest = path.join(root, '.autoprompt-install-hashes.json')
  const receipt = path.join(root, '.autoprompt-install-receipt.json')
  const bytes = new Map([
    [current, Buffer.from('current generation\n')],
    [retiredClean, Buffer.from('retired clean generation\n')],
    [retiredDrift, Buffer.from('retired drift generation\n')],
  ])
  for (const [file, content] of bytes) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  fs.appendFileSync(retiredDrift, 'user drift survives update\n')
  const files = [...bytes.keys()].map(transform)
  fs.writeFileSync(manifest, serializeHashManifest(
    [...bytes].map(([file, content]) => [transform(file), sha256(content)]),
  ))
  fs.writeFileSync(receipt, `${JSON.stringify({
    nonce: 'receipt-update-test', backup: null, files,
    createdDirectories: [], ompManaged: false, ompDetachedRoot: null, configEdits: [],
  }, null, 2)}\n`)
  return {
    sandbox, root, current, retiredClean, retiredDrift, manifest, receipt,
    owned: files,
  }
}

function assertRelinquished(fixture, completed, expectedRetained) {
  assert.equal(completed.status, 0, `${completed.stdout}\n${completed.stderr}`)
  assert.match(completed.stdout, new RegExp(`retained=${expectedRetained}`))
  assert.equal(fs.existsSync(fixture.managed), expectedRetained === 1)
  if (expectedRetained === 1) {
    assert.match(fs.readFileSync(fixture.managed, 'utf8'), /installed Codex payload/)
    assert.match(completed.stdout, /ownership=relinquished/)
  }
  assert.equal(fs.existsSync(fixture.manifest), false)
  assert.equal(fs.existsSync(fixture.receipt), false)
}

test('PowerShell Codex uninstall preserves drift and relinquishes receipt ownership', {
  skip: !HAS_POWERSHELL,
}, t => {
  const fixture = createReceiptFixture('autoprompt-codex-receipt-ps-')
  t.after(() => fs.rmSync(fixture.sandbox, { recursive: true, force: true }))
  const command = [
    `. ${psLiteral(LIBRARY_PS1)}`,
    `$code = Uninstall-Client -ConfigRoot ${psLiteral(fixture.root)} -Name 'codex'`,
    'exit $code',
  ].join('; ')
  const completed = childProcess.spawnSync(POWERSHELL, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command,
  ], { encoding: 'utf8', timeout: 30000 })
  assertRelinquished(fixture, completed, 1)
})

test('Git Bash Codex uninstall preserves drift and relinquishes receipt ownership', {
  skip: !HAS_BASH,
}, t => {
  const fixture = createReceiptFixture('autoprompt-codex-receipt-sh-')
  t.after(() => fs.rmSync(fixture.sandbox, { recursive: true, force: true }))
  const command = [
    `source ${shellLiteral(bashPath(LIBRARY_SH))}`,
    `uninstall_client ${shellLiteral(bashPath(fixture.root))} codex`,
  ].join('; ')
  const completed = childProcess.spawnSync(BASH, ['-lc', command], {
    encoding: 'utf8',
    timeout: 30000,
  })
  assertRelinquished(fixture, completed, 1)
})

test('Codex uninstall removes pristine receipt-owned bytes in both installer ports', {
  skip: !HAS_POWERSHELL || !HAS_BASH,
}, t => {
  const powershellFixture = createReceiptFixture('autoprompt-codex-pristine-ps-', false)
  const bashFixture = createReceiptFixture('autoprompt-codex-pristine-sh-', false)
  t.after(() => {
    fs.rmSync(powershellFixture.sandbox, { recursive: true, force: true })
    fs.rmSync(bashFixture.sandbox, { recursive: true, force: true })
  })
  const psCommand = [
    `. ${psLiteral(LIBRARY_PS1)}`,
    `$code = Uninstall-Client -ConfigRoot ${psLiteral(powershellFixture.root)} -Name 'codex'`,
    'exit $code',
  ].join('; ')
  const psCompleted = childProcess.spawnSync(POWERSHELL, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psCommand,
  ], { encoding: 'utf8', timeout: 30000 })
  assertRelinquished(powershellFixture, psCompleted, 0)

  const shCommand = [
    `source ${shellLiteral(bashPath(LIBRARY_SH))}`,
    `uninstall_client ${shellLiteral(bashPath(bashFixture.root))} codex`,
  ].join('; ')
  const shCompleted = childProcess.spawnSync(BASH, ['-lc', shCommand], {
    encoding: 'utf8',
    timeout: 30000,
  })
  assertRelinquished(bashFixture, shCompleted, 0)
})

test('Codex uninstall preserves unfingerprinted receipt bytes in both installer ports', {
  skip: !HAS_POWERSHELL || !HAS_BASH,
}, t => {
  const powershellFixture = createReceiptFixture('autoprompt-codex-unfingerprinted-ps-', false, false)
  const bashFixture = createReceiptFixture('autoprompt-codex-unfingerprinted-sh-', false, false)
  t.after(() => {
    fs.rmSync(powershellFixture.sandbox, { recursive: true, force: true })
    fs.rmSync(bashFixture.sandbox, { recursive: true, force: true })
  })
  const psCommand = [
    `. ${psLiteral(LIBRARY_PS1)}`,
    `$code = Uninstall-Client -ConfigRoot ${psLiteral(powershellFixture.root)} -Name 'codex'`,
    'exit $code',
  ].join('; ')
  const psCompleted = childProcess.spawnSync(POWERSHELL, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psCommand,
  ], { encoding: 'utf8', timeout: 30000 })
  assertRelinquished(powershellFixture, psCompleted, 1)
  assert.match(psCompleted.stdout, /reason=unfingerprinted/)

  const shCommand = [
    `source ${shellLiteral(bashPath(LIBRARY_SH))}`,
    `uninstall_client ${shellLiteral(bashPath(bashFixture.root))} codex`,
  ].join('; ')
  const shCompleted = childProcess.spawnSync(BASH, ['-lc', shCommand], {
    encoding: 'utf8',
    timeout: 30000,
  })
  assertRelinquished(bashFixture, shCompleted, 1)
  assert.match(shCompleted.stdout, /reason=unfingerprinted/)
})

test('PowerShell Codex update reconciliation prunes clean prior-only bytes and relinquishes drift', {
  skip: !HAS_POWERSHELL,
}, t => {
  const fixture = createUpdateFixture('autoprompt-codex-update-ps-')
  t.after(() => fs.rmSync(fixture.sandbox, { recursive: true, force: true }))
  const command = [
    `. ${psLiteral(LIBRARY_PS1)}`,
    `$script:AutopromptReceiptFiles = @(${fixture.owned.map(psLiteral).join(', ')})`,
    `$code = Invoke-IdemRetiredCodexReconciliation -ConfigRoot ${psLiteral(fixture.root)} -CurrentTargets @(${psLiteral(fixture.current)})`,
    'Write-Output ("result-code=$code owned=" + ($script:AutopromptReceiptFiles -join "|"))',
    'exit $code',
  ].join('; ')
  const completed = childProcess.spawnSync(POWERSHELL, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command,
  ], { encoding: 'utf8', timeout: 30000 })
  assert.equal(completed.status, 0, `${completed.stdout}\n${completed.stderr}`)
  assert.match(completed.stdout, /update-pruned=.*obsolete.*stale\.txt reason=prior-only/)
  assert.match(completed.stdout, /update-retained=.*retired-drift\.txt reason=hash-drift ownership=relinquished/)
  assert.match(completed.stdout, /result-code=0 owned=.*SKILL\.md/)
  assert.doesNotMatch(completed.stdout, /owned=.*retired-drift\.txt/)
  assert.equal(fs.existsSync(fixture.retiredClean), false)
  assert.match(fs.readFileSync(fixture.retiredDrift, 'utf8'), /user drift survives update/)
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(fixture.manifest, 'utf8'))), [fixture.current])
})

test('Git Bash Codex update reconciliation prunes clean prior-only bytes and relinquishes drift', {
  skip: !HAS_BASH,
}, t => {
  const fixture = createUpdateFixture('autoprompt-codex-update-sh-', bashPath)
  t.after(() => fs.rmSync(fixture.sandbox, { recursive: true, force: true }))
  const current = bashPath(fixture.current)
  const command = [
    `source ${shellLiteral(bashPath(LIBRARY_SH))}`,
    `AUTOPROMPT_RECEIPT_FILES=(${fixture.owned.map(shellLiteral).join(' ')})`,
    `current_targets=(${shellLiteral(current)})`,
    `_idem_reconcile_retired_codex_files ${shellLiteral(bashPath(fixture.root))} current_targets`,
    'code=$?',
    'printf "result-code=%s owned=%s\\n" "$code" "${AUTOPROMPT_RECEIPT_FILES[*]}"',
    'exit "$code"',
  ].join('; ')
  const completed = childProcess.spawnSync(BASH, ['-lc', command], {
    encoding: 'utf8', timeout: 30000,
  })
  assert.equal(completed.status, 0, `${completed.stdout}\n${completed.stderr}`)
  assert.match(completed.stdout, /update-pruned=.*obsolete.*stale\.txt reason=prior-only/)
  assert.match(completed.stdout, /update-retained=.*retired-drift\.txt reason=hash-drift ownership=relinquished/)
  assert.match(completed.stdout, /result-code=0 owned=.*SKILL\.md/)
  assert.doesNotMatch(completed.stdout, /owned=.*retired-drift\.txt/)
  assert.equal(fs.existsSync(fixture.retiredClean), false)
  assert.match(fs.readFileSync(fixture.retiredDrift, 'utf8'), /user drift survives update/)
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(fixture.manifest, 'utf8'))), [current])
})

test('Codex receipt writers embed prior-manifest and per-file hashes accepted by strict parsers', {
  skip: !HAS_POWERSHELL || !HAS_BASH,
}, t => {
  const priorDigest = 'a'.repeat(64)
  for (const port of ['powershell', 'bash']) {
    const fixture = createReceiptFixture(`autoprompt-codex-bound-receipt-${port}-`, false)
    t.after(() => fs.rmSync(fixture.sandbox, { recursive: true, force: true }))
    const completed = port === 'powershell'
      ? childProcess.spawnSync(POWERSHELL, [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', [
            `. ${psLiteral(LIBRARY_PS1)}`,
            `$script:AutopromptReceiptPriorManifestSha256 = '${priorDigest}'`,
            `$code = Write-Receipt -ConfigRoot ${psLiteral(fixture.root)} -Nonce bound -Files @(${psLiteral(fixture.managed)},${psLiteral(fixture.manifest)})`,
            'if ($code -ne 0) { exit $code }',
            `$code = Uninstall-Client -ConfigRoot ${psLiteral(fixture.root)} -Name codex`,
            'exit $code',
          ].join('; '),
        ], { encoding: 'utf8', timeout: 30000 })
      : childProcess.spawnSync(BASH, ['-lc', [
          `source ${shellLiteral(bashPath(LIBRARY_SH))}`,
          `AUTOPROMPT_RECEIPT_FILES=(${shellLiteral(bashPath(fixture.managed))} ${shellLiteral(bashPath(fixture.manifest))})`,
          `AUTOPROMPT_RECEIPT_PRIOR_MANIFEST_SHA256=${priorDigest}`,
          `write_receipt ${shellLiteral(bashPath(fixture.root))} bound none >/dev/null`,
          `uninstall_client ${shellLiteral(bashPath(fixture.root))} codex`,
        ].join('; ')], { encoding: 'utf8', timeout: 30000 })
    assert.equal(completed.status, 0, `${port}\n${completed.stdout}\n${completed.stderr}`)
    assert.equal(fs.existsSync(fixture.receipt), false)
  }
})
