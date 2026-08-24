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
const POSIX_LIBRARY = path.join(ROOT, 'scripts', 'install', 'lib', 'install-lib.sh')
const INSTALLER = path.join(ROOT, 'scripts', 'install', 'install.ps1')
const RUNTIME_TOOL = path.join(ROOT, 'scripts', 'runtime-payload.cjs')
const POSIX_INSTALLER = path.join(ROOT, 'scripts', 'install', 'install.sh')
const POWERSHELL = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe'

function ps(value) { return `'${String(value).replaceAll("'", "''")}'` }
function runPowerShell(command, timeout = 60_000) {
  const utf8Command = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding;' + command
  return childProcess.spawnSync(POWERSHELL, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', utf8Command,
  ], { cwd: ROOT, encoding: 'utf8', timeout })
}

test('PowerShell test harness preserves exact UTF-8 JSON path output', () => {
  const expected = 'C:\\share with spaces\\ü\\SKILL.md'
  const result = runPowerShell(`@{path=${ps(expected)}}|ConvertTo-Json -Compress`)
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.doesNotMatch(result.stdout, /\uFFFD/u)
  assert.equal(JSON.parse(result.stdout.trim()).path, expected)
})

function canonicalManifest(entries) {
  const rows = entries.map(([key, hash], index) =>
    `    ${JSON.stringify(key)}: ${JSON.stringify(hash)}${index + 1 < entries.length ? ',' : ''}`)
  return `{\n${rows.join('\n')}\n}\n`
}

function decodeCanonicalYamlScalar(serialized) {
  if (serialized.startsWith("'") && serialized.endsWith("'")) {
    const inner = serialized.slice(1, -1)
    let decoded = ''
    for (let index = 0; index < inner.length; index += 1) {
      if (inner[index] !== "'") {
        decoded += inner[index]
        continue
      }
      assert.equal(inner[index + 1], "'", 'single-quoted YAML apostrophes must be doubled')
      decoded += "'"
      index += 1
    }
    assert.equal(`'${decoded.replaceAll("'", "''")}'`, serialized)
    return decoded
  }
  if (serialized.startsWith('"') && serialized.endsWith('"')) {
    const decoded = JSON.parse(serialized)
    assert.equal(JSON.stringify(decoded), serialized)
    return decoded
  }
  assert.doesNotMatch(serialized, /^['"]|['"]$/u)
  return serialized
}

function byteProfile(bytes) {
  let trailingNewlines = 0
  for (let index = bytes.length - 1; index >= 0 && bytes[index] === 0x0a;) {
    trailingNewlines += 1
    index -= index > 0 && bytes[index - 1] === 0x0d ? 2 : 1
  }
  const text = bytes.toString('utf8')
  const crlf = (text.match(/\r\n/gu) || []).length
  const lf = (text.match(/\n/gu) || []).length
  return {
    bytes: bytes.length,
    bom: bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf,
    crlf,
    lf,
    bareLf: lf - crlf,
    trailingNewlines,
    normalizedLfHash: crypto.createHash('sha256').update(Buffer.from(text.replaceAll('\r\n', '\n'), 'utf8')).digest('hex'),
  }
}

function byteDifference(left, right) {
  const common = Math.min(left.length, right.length)
  let offset = 0
  while (offset < common && left[offset] === right[offset]) offset += 1
  if (offset === common && left.length === right.length) offset = -1
  const center = offset < 0 ? 0 : offset
  const start = Math.max(0, center - 32)
  const end = Math.min(Math.max(left.length, right.length), center + 33)
  const window = bytes => bytes.subarray(start, Math.min(end, bytes.length))
  return {
    firstOffset: offset,
    start,
    end,
    coreHex: window(left).toString('hex'),
    sourceHex: window(right).toString('hex'),
    coreText: window(left).toString('utf8'),
    sourceText: window(right).toString('utf8'),
  }
}

function readManifestFixture(raw) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-codex-manifest-read-'))
  const manifest = path.join(sandbox, '.autoprompt-install-hashes.json')
  fs.writeFileSync(manifest, raw)
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `. ${ps(LIBRARY)}`,
    'try {',
    `  $entries=Read-IdemManifestEntries -ConfigRoot ${ps(sandbox)}`,
    '  $records=@($entries.Keys|Sort-Object|ForEach-Object{@{key=[string]$_;hash=[string]$entries[$_]}})',
    '  @{ok=$true;records=$records}|ConvertTo-Json -Compress -Depth 4',
    '} catch {',
    '  @{ok=$false;error=$_.Exception.Message}|ConvertTo-Json -Compress',
    '}',
  ].join(';')
  const result = runPowerShell(command)
  fs.rmSync(sandbox, { recursive: true, force: true })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1))
}

function runBash(script, environment = {}, timeout = 60_000) {
  return childProcess.spawnSync(GIT_BASH, ['-lc', script], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...environment },
    timeout,
  })
}

function bashRaceResult(mode) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), `autoprompt-codex-bash-${mode}-`))
  const root = path.join(sandbox, 'root')
  const stage = path.join(sandbox, 'stage')
  fs.mkdirSync(root)
  fs.mkdirSync(stage)
  fs.writeFileSync(path.join(stage, 'one.txt'), 'stable one\n')
  fs.writeFileSync(path.join(stage, 'two.txt'), 'stable two\n')
  const script = [
    'set +e',
    'lib="$(cygpath -u "$AP_TEST_LIBRARY")"',
    'root="$(cygpath -u "$AP_TEST_ROOT")"',
    'stage="$(cygpath -u "$AP_TEST_STAGE")"',
    '. "$lib"',
    'AUTOPROMPT_RECEIPT_FILES=();AUTOPROMPT_RECEIPT_CREATED_DIRECTORIES=();AUTOPROMPT_RECEIPT_EDITS=();AUTOPROMPT_MANAGED_UNDO_JOURNAL=()',
    'race_count=0',
    'race_hook(){ race_count=$((race_count+1)); if [ "$AP_TEST_MODE" = single ] || [ "$race_count" -eq 2 ]; then printf hostile >> "$1"; fi; }',
    'code=0',
    'if [ "$AP_TEST_MODE" = single ]; then',
    '  _idem_install_managed_file "$root" "$stage/one.txt" "$root/skills/autoprompt/one.txt" 1 1 0 1 race_hook || code=$?',
    'else',
    '  landed=0;agents=0',
    '  inventory="$(printf \'skills/autoprompt/one.txt\\t%s\\nskills/autoprompt/two.txt\\t%s\' "$stage/one.txt" "$stage/two.txt")"',
    '  _extras_install_inventory "$root" "$stage" "$root/skills/autoprompt" "$inventory" landed agents 1 race_hook || code=$?',
    '  [ "$code" -eq 0 ] || _extras_rollback_changes codex "$root" 0',
    'fi',
    'target=0;[ -e "$root/skills/autoprompt/one.txt" ] && target=1',
    'residue=0;[ -n "$(find "$root" -mindepth 1 -print -quit 2>/dev/null)" ] && residue=1',
    'pointer=0;[ -n "${AUTOPROMPT_ROOT_TRANSACTION_DIR:-}" ] && pointer=1',
    'printf \'{"code":%s,"target":%s,"receipt":%s,"residue":%s,"pointer":%s}\\n\' "$code" "$target" "${#AUTOPROMPT_RECEIPT_FILES[@]}" "$residue" "$pointer"',
  ].join('\n')
  const result = runBash(script, {
    AP_TEST_LIBRARY: POSIX_LIBRARY,
    AP_TEST_MODE: mode,
    AP_TEST_ROOT: root,
    AP_TEST_STAGE: stage,
  })
  fs.rmSync(sandbox, { recursive: true, force: true })
  return result
}

function bashStableResult(mode) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), `autoprompt-codex-bash-stable-${mode}-`))
  const root = path.join(sandbox, 'root')
  const stage = path.join(sandbox, 'stage')
  fs.mkdirSync(root)
  fs.mkdirSync(stage)
  fs.writeFileSync(path.join(stage, 'one.txt'), 'stable one\n')
  fs.writeFileSync(path.join(stage, 'two.txt'), 'stable two\n')
  const script = [
    'set +e',
    'lib="$(cygpath -u "$AP_TEST_LIBRARY")"',
    'root="$(cygpath -u "$AP_TEST_ROOT")"',
    'stage="$(cygpath -u "$AP_TEST_STAGE")"',
    '. "$lib"',
    'AUTOPROMPT_RECEIPT_FILES=();AUTOPROMPT_RECEIPT_CREATED_DIRECTORIES=();AUTOPROMPT_RECEIPT_EDITS=();AUTOPROMPT_MANAGED_UNDO_JOURNAL=()',
    'code=0;landed=0;agents=0',
    'if [ "$AP_TEST_MODE" = single ]; then',
    '  _idem_install_managed_file "$root" "$stage/one.txt" "$root/skills/autoprompt/one.txt" 1 1 0 1 || code=$?',
    'else',
    '  inventory="$(printf \'skills/autoprompt/one.txt\\t%s\\nskills/autoprompt/two.txt\\t%s\' "$stage/one.txt" "$stage/two.txt")"',
    '  _extras_install_inventory "$root" "$stage" "$root/skills/autoprompt" "$inventory" landed agents 1 || code=$?',
    'fi',
    'targets=0;hashes=1',
    'for name in one $([ "$AP_TEST_MODE" = batch ] && printf two); do',
    '  target="$root/skills/autoprompt/$name.txt"; [ -f "$target" ] || { hashes=0; continue; }',
    '  targets=$((targets+1)); source_hash="$(_idem_sha256 "$stage/$name.txt")"; target_hash="$(_idem_sha256 "$target")"',
    '  recorded=""; _idem_read_manifest_hash "$root" "$target" recorded || hashes=0',
    '  [ "$source_hash" = "$target_hash" ] && [ "$target_hash" = "$recorded" ] || hashes=0',
    'done',
    'tmp=0;[ -n "$(find "$root" -name \'*.autoprompt.codex.tmp.*\' -print -quit 2>/dev/null)" ] && tmp=1',
    'pointer=0;[ -n "${AUTOPROMPT_ROOT_TRANSACTION_DIR:-}" ] && pointer=1',
    'printf \'{"code":%s,"targets":%s,"hashes":%s,"receipt":%s,"tmp":%s,"pointer":%s}\\n\' "$code" "$targets" "$hashes" "${#AUTOPROMPT_RECEIPT_FILES[@]}" "$tmp" "$pointer"',
    '_idem_complete_managed_changes 0 >/dev/null',
  ].join('\n')
  const result = runBash(script, {
    AP_TEST_LIBRARY: POSIX_LIBRARY,
    AP_TEST_MODE: mode,
    AP_TEST_ROOT: root,
    AP_TEST_STAGE: stage,
  })
  fs.rmSync(sandbox, { recursive: true, force: true })
  return result
}

function batchResult(root, source, useIndex) {
  const names = fs.readdirSync(source).sort()
  const mappings = names.map(name =>
    `@{ Source = ${ps(path.join(source, name))}; Target = ${ps(path.join(root, 'skills', 'autoprompt', name))} }`,
  ).join(', ')
  const switchArg = useIndex ? ' -UseCodexBatchIndex' : ''
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `. ${ps(LIBRARY)}`,
    '$script:AutopromptReceiptFiles=@();$script:AutopromptReceiptCreatedDirectories=@();$script:AutopromptReceiptEdits=@();$script:AutopromptManagedUndoJournal=@()',
    `$code=Install-IdemManagedFiles -ConfigRoot ${ps(root)} -Mappings @(${mappings}) -RefuseUnownedTarget${switchArg}`,
    'if($code-ne 0){exit $code}',
    `$manifest=Get-Content -LiteralPath (Join-Path ${ps(root)} '.autoprompt-install-hashes.json') -Raw|ConvertFrom-Json`,
    `$normalize={param([string]$name)$value=$name;if($name.Length-gt ${root.length} -and $name.StartsWith(${ps(root)},[StringComparison]::OrdinalIgnoreCase) -and ($name[${root.length}]-eq [char]92 -or $name[${root.length}]-eq [char]47)){$value=$name.Substring(${root.length + 1})};$value=$value.Replace([char]92,[char]47);if($value.StartsWith('/')){$value=$value.Substring(1)};$value};$relative=@{};foreach($property in $manifest.PSObject.Properties){$relative[(& $normalize $property.Name)]=$property.Value}`,
    `$receipt=@($script:AutopromptReceiptFiles|ForEach-Object{& $normalize $_})`,
    '@{manifest=$relative;receipt=$receipt}|ConvertTo-Json -Compress -Depth 4',
    'if(-not(Complete-IdemManagedChanges)){exit 92}',
  ].join(';')
  const result = runPowerShell(command)
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1))
}

test('Codex indexed registration preserves legacy manifest bytes and receipt order', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-codex-index-'))
  const source = path.join(sandbox, 'source')
  fs.mkdirSync(source)
  for (let index = 0; index < 36; index += 1) {
    fs.writeFileSync(path.join(source, `${String(index).padStart(3, '0')}.txt`), `payload-${index}\n`)
  }
  const legacyRoot = path.join(sandbox, 'legacy')
  const indexedRoot = path.join(sandbox, 'indexed')
  fs.mkdirSync(legacyRoot)
  fs.mkdirSync(indexedRoot)
  const legacy = batchResult(legacyRoot, source, false)
  const indexed = batchResult(indexedRoot, source, true)
  assert.deepEqual(indexed, legacy)
  fs.rmSync(sandbox, { recursive: true, force: true })
})

test('Codex Windows hash manifest keeps the exact SKILL digest under a portable relative key', {
  skip: process.platform !== 'win32',
}, t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt Codex ü hash-'))
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }))
  const root = path.join(sandbox, 'installed skill')
  const source = path.join(sandbox, 'staged SKILL.md')
  const target = path.join(root, 'SKILL.md')
  const bytes = Buffer.from('# Autoprompt\r\nWindows drive-path manifest regression.\r\n', 'utf8')
  const expectedHash = crypto.createHash('sha256').update(bytes).digest('hex')
  fs.mkdirSync(root)
  fs.writeFileSync(source, bytes)

  const command = [
    "$ErrorActionPreference = 'Stop'",
    `. ${ps(LIBRARY)}`,
    '$script:AutopromptReceiptFiles=@();$script:AutopromptReceiptCreatedDirectories=@();$script:AutopromptReceiptEdits=@();$script:AutopromptManagedUndoJournal=@()',
    `$mapping=@{Source=${ps(source)};Target=${ps(target)}}`,
    `$code=Install-IdemManagedFiles -ConfigRoot ${ps(root)} -Mappings @($mapping) -RefuseUnownedTarget -UseCodexBatchIndex`,
    'if($code-ne 0){exit $code}',
    `$raw=[IO.File]::ReadAllText((Join-Path ${ps(root)} '.autoprompt-install-hashes.json'))`,
    '@{raw=$raw}|ConvertTo-Json -Compress',
  ].join(';')
  const result = runPowerShell(command)
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  const { raw } = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1))
  const expectedRaw = `{\n    "SKILL.md": "${expectedHash}"\n}\n`
  assert.equal(raw, expectedRaw, `manifest must not split ${target} into a bogus drive-letter key`)
  const manifest = JSON.parse(raw)
  assert.deepEqual(Object.keys(manifest), ['SKILL.md'])
  assert.equal(manifest['SKILL.md'], expectedHash)
  assert.equal(Object.hasOwn(manifest, 'C'), false)
})

test('Codex Windows hash manifest accepts nested portable keys for real drive-rooted targets', {
  skip: process.platform !== 'win32',
}, t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-codex-manifest-nested-'))
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }))
  const root = path.join(sandbox, 'config root')
  const skillTarget = path.join(root, 'skills', 'autoprompt', 'SKILL.md')
  const workflowTarget = path.join(root, 'skills', 'autoprompt', 'workflow', 'phase-budget.js')
  const agentTarget = path.join(root, 'agents', 'ap-planner.toml')
  const skillHash = '4'.repeat(64)
  const workflowHash = '5'.repeat(64)
  const agentHash = '6'.repeat(64)
  const manifestPath = path.join(root, '.autoprompt-install-hashes.json')
  fs.mkdirSync(root)
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `. ${ps(LIBRARY)}`,
    `$hashes=@(@{Key=${ps(skillTarget)};Hash=${ps(skillHash)}},@{Key=${ps(workflowTarget)};Hash=${ps(workflowHash)}},@{Key=${ps(agentTarget)};Hash=${ps(agentHash)}})`,
    `$ok=Set-IdemManifestHashes -ConfigRoot ${ps(root)} -Hashes $hashes -UseIdentityIndex`,
    `$skill=Get-IdemManifestHash -ConfigRoot ${ps(root)} -Key ${ps(skillTarget)}`,
    `$workflow=Get-IdemManifestHash -ConfigRoot ${ps(root)} -Key 'skills/autoprompt/workflow/phase-budget.js'`,
    `$agent=Get-IdemManifestHash -ConfigRoot ${ps(root)} -Key ${ps(agentTarget)}`,
    `$raw=if(Test-Path -LiteralPath ${ps(manifestPath)}){[IO.File]::ReadAllText(${ps(manifestPath)})}else{''}`,
    '@{ok=$ok;skill=$skill;workflow=$workflow;agent=$agent;raw=$raw}|ConvertTo-Json -Compress',
  ].join(';')
  const result = runPowerShell(command)
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.deepEqual(JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)), {
    ok: true,
    skill: skillHash,
    workflow: workflowHash,
    agent: agentHash,
    raw: canonicalManifest([
      ['skills/autoprompt/SKILL.md', skillHash],
      ['skills/autoprompt/workflow/phase-budget.js', workflowHash],
      ['agents/ap-planner.toml', agentHash],
    ]),
  })
})

test('Codex Windows hash manifest rejects noncanonical or escaping nested target spellings', {
  skip: process.platform !== 'win32',
}, t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-codex-manifest-contained-'))
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }))
  const root = path.join(sandbox, 'root')
  fs.mkdirSync(root)
  const driveEscape = path.join(path.parse(root).root, 'outside', 'SKILL.md')
  const targets = [
    driveEscape,
    '\\\\server\\share\\SKILL.md',
    `${root}\\..\\outside\\SKILL.md`,
    root,
    `${root}\\.`,
    `${root}\\skills\\autoprompt\\SKILL.md:stream`,
    `${root}\\skills\\\\autoprompt\\SKILL.md`,
    `${root}\\skills\\autoprompt\\`,
    `${root}\\skills\\.\\autoprompt\\SKILL.md`,
  ]
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `. ${ps(LIBRARY)}`,
    `$targets=@(${targets.map(ps).join(',')})`,
    '$values=@($targets|ForEach-Object{[string](ConvertTo-IdemPortableManifestKey -ConfigRoot ' + ps(root) + ' -Target $_)})',
    '@{values=$values}|ConvertTo-Json -Compress',
  ].join(';')
  const result = runPowerShell(command)
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.deepEqual(
    JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)).values,
    targets.map(() => ''),
  )
})

test('Codex Windows hash manifest rejects portable keys containing control characters', {
  skip: process.platform !== 'win32',
}, t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-codex-manifest-control-'))
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }))
  const root = path.join(sandbox, 'root')
  fs.mkdirSync(root)
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `. ${ps(LIBRARY)}`,
    `$keys=@(('skills/autoprompt/'+[char]1+'SKILL.md'),('skills/autoprompt/'+[char]9+'SKILL.md'),('skills/autoprompt/'+[char]10+'SKILL.md'))`,
    `$targets=@($keys|ForEach-Object{Join-Path ${ps(root)} $_})`,
    `$identities=@($keys|ForEach-Object{[string](Get-IdemManifestKeyIdentity -ConfigRoot ${ps(root)} -Key $_)})`,
    `$portable=@($targets|ForEach-Object{[string](ConvertTo-IdemPortableManifestKey -ConfigRoot ${ps(root)} -Target $_)})`,
    '@{identities=$identities;portable=$portable}|ConvertTo-Json -Compress',
  ].join(';')
  const result = runPowerShell(command)
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.deepEqual(JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)), {
    identities: ['', '', ''],
    portable: ['', '', ''],
  })
})

test('Codex Windows hash manifest preserves an exact UNC path and digest without drive-letter tokenization', {
  skip: process.platform !== 'win32',
}, () => {
  const key = '\\\\server\\share with spaces\\ü\\SKILL.md'
  const hash = crypto.createHash('sha256').update('unc fixture', 'utf8').digest('hex')
  const result = readManifestFixture(canonicalManifest([[key, hash]]))
  assert.deepEqual(result, { ok: true, records: [{ key, hash }] })
  assert.equal(result.records.some(record => record.key === 'C'), false)
})

test('Codex Windows hash manifest rejects ADS and other colon-hostile keys', {
  skip: process.platform !== 'win32',
}, () => {
  const hash = 'a'.repeat(64)
  for (const key of [
    'C:\\safe\\SKILL.md:stream',
    'relative:colon\\SKILL.md',
    'C::\\SKILL.md',
  ]) {
    const result = readManifestFixture(canonicalManifest([[key, hash]]))
    assert.equal(result.ok, false, `colon-hostile manifest key was accepted: ${key}`)
    assert.match(result.error, /invalid ownership manifest key|duplicate filesystem-equivalent manifest key/u)
  }
})

test('Codex Windows hash manifest rejects duplicate path and hash records', {
  skip: process.platform !== 'win32',
}, () => {
  const key = 'C:\\portable root\\SKILL.md'
  for (const hashes of [
    ['b'.repeat(64), 'b'.repeat(64)],
    ['b'.repeat(64), 'c'.repeat(64)],
  ]) {
    const result = readManifestFixture(canonicalManifest([[key, hashes[0]], [key, hashes[1]]]))
    assert.equal(result.ok, false, 'duplicate path/hash records must not be order-dependent')
    assert.match(result.error, /duplicate manifest key/u)
  }
})

test('Codex Windows hash manifest rejects malformed lines and object shapes', {
  skip: process.platform !== 'win32',
}, () => {
  const hash = 'd'.repeat(64)
  const malformed = [
    `${JSON.stringify({ 'SKILL.md': hash })}\n`,
    `{\n    "SKILL.md": "not-a-hash"\n}\n`,
    `{\n    "SKILL.md": "${hash}",\n}\n`,
    `{\n    "SKILL.md": "${hash}"\n}\ntrailing`,
  ]
  for (const raw of malformed) {
    const result = readManifestFixture(raw)
    assert.equal(result.ok, false, `malformed manifest was accepted: ${JSON.stringify(raw)}`)
    assert.match(result.error, /invalid ownership manifest|comma placement/u)
  }
})

test('Codex Windows hash manifest atomically migrates a legacy absolute key during indexed write', {
  skip: process.platform !== 'win32',
}, t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-codex-manifest-migrate-'))
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }))
  const root = path.join(sandbox, 'root')
  const target = path.join(root, 'SKILL.md')
  const hash = 'e'.repeat(64)
  const manifestPath = path.join(root, '.autoprompt-install-hashes.json')
  fs.mkdirSync(root)
  const legacyRaw = canonicalManifest([[target, hash]])
  fs.writeFileSync(manifestPath, legacyRaw)
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `. ${ps(LIBRARY)}`,
    `$before=[IO.File]::ReadAllText(${ps(manifestPath)})`,
    `$ok=Set-IdemManifestHashes -ConfigRoot ${ps(root)} -Hashes @(@{Key=${ps(target)};Hash=${ps(hash)}}) -UseIdentityIndex`,
    `$after=[IO.File]::ReadAllText(${ps(manifestPath)})`,
    `$residue=@(Get-ChildItem -LiteralPath ${ps(root)} -Force|Where-Object{$_.Name -like '.autoprompt-install-hashes.json.*'}).Count`,
    '@{ok=$ok;before=$before;after=$after;residue=$residue}|ConvertTo-Json -Compress',
  ].join(';')
  const result = runPowerShell(command)
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.deepEqual(JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)), {
    ok: true,
    before: legacyRaw,
    after: canonicalManifest([['SKILL.md', hash]]),
    residue: 0,
  })
})

test('Codex Windows hash manifest collapses identical absolute and relative aliases to one canonical key', {
  skip: process.platform !== 'win32',
}, t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-codex-manifest-alias-'))
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }))
  const root = path.join(sandbox, 'root')
  const target = path.join(root, 'SKILL.md')
  const hash = '1'.repeat(64)
  const manifestPath = path.join(root, '.autoprompt-install-hashes.json')
  fs.mkdirSync(root)
  fs.writeFileSync(manifestPath, canonicalManifest([[target, hash], ['SKILL.md', hash]]))
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `. ${ps(LIBRARY)}`,
    `$ok=Set-IdemManifestHashes -ConfigRoot ${ps(root)} -Hashes @(@{Key=${ps(target)};Hash=${ps(hash)}}) -UseIdentityIndex`,
    `$raw=[IO.File]::ReadAllText(${ps(manifestPath)})`,
    `$residue=@(Get-ChildItem -LiteralPath ${ps(root)} -Force|Where-Object{$_.Name -like '.autoprompt-install-hashes.json.*'}).Count`,
    '@{ok=$ok;raw=$raw;residue=$residue}|ConvertTo-Json -Compress',
  ].join(';')
  const result = runPowerShell(command)
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.deepEqual(JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)), {
    ok: true,
    raw: canonicalManifest([['SKILL.md', hash]]),
    residue: 0,
  })
})

test('Codex Windows hash manifest rejects a conflicting indexed alias before mutating legacy bytes', {
  skip: process.platform !== 'win32',
}, t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-codex-manifest-conflict-'))
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }))
  const root = path.join(sandbox, 'root')
  const target = path.join(root, 'SKILL.md')
  const recordedHash = '2'.repeat(64)
  const incomingHash = '3'.repeat(64)
  const manifestPath = path.join(root, '.autoprompt-install-hashes.json')
  const originalRaw = canonicalManifest([[target, recordedHash]])
  fs.mkdirSync(root)
  fs.writeFileSync(manifestPath, originalRaw)
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `. ${ps(LIBRARY)}`,
    `$ok=Set-IdemManifestHashes -ConfigRoot ${ps(root)} -Hashes @(@{Key=${ps(target)};Hash=${ps(incomingHash)}}) -UseIdentityIndex`,
    `$raw=[IO.File]::ReadAllText(${ps(manifestPath)})`,
    `$residue=@(Get-ChildItem -LiteralPath ${ps(root)} -Force|Where-Object{$_.Name -like '.autoprompt-install-hashes.json.*'}).Count`,
    '@{ok=$ok;raw=$raw;residue=$residue}|ConvertTo-Json -Compress',
  ].join(';')
  const result = runPowerShell(command)
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.deepEqual(JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)), {
    ok: false,
    raw: originalRaw,
    residue: 0,
  })
  assert.match(result.stderr, /error=hash-manifest-invalid-entry/u)
})

test('Codex Windows hash manifest resolves relative keys for Get and Remove under ConfigRoot', {
  skip: process.platform !== 'win32',
}, t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-codex-manifest-resolve-'))
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }))
  const root = path.join(sandbox, 'root')
  const target = path.join(root, 'skills', 'autoprompt', 'SKILL.md')
  const hash = 'f'.repeat(64)
  const manifestPath = path.join(root, '.autoprompt-install-hashes.json')
  fs.mkdirSync(root)
  fs.writeFileSync(manifestPath, canonicalManifest([['skills/autoprompt/SKILL.md', hash]]))
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `. ${ps(LIBRARY)}`,
    `$absolute=Get-IdemManifestHash -ConfigRoot ${ps(root)} -Key ${ps(target)}`,
    `$relative=Get-IdemManifestHash -ConfigRoot ${ps(root)} -Key 'skills/autoprompt/SKILL.md'`,
    `$removed=Remove-IdemManifestHash -ConfigRoot ${ps(root)} -Key ${ps(target)}`,
    `$raw=[IO.File]::ReadAllText(${ps(manifestPath)})`,
    '@{absolute=$absolute;relative=$relative;removed=$removed;raw=$raw}|ConvertTo-Json -Compress',
  ].join(';')
  const result = runPowerShell(command)
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.deepEqual(JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)), {
    absolute: hash,
    relative: hash,
    removed: true,
    raw: '{\n}\n',
  })
})

test('Codex Windows hash manifest uninstall resolves relative ownership keys safely', {
  skip: process.platform !== 'win32',
}, t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-codex-manifest-uninstall-'))
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }))
  const root = path.join(sandbox, 'root')
  const target = path.join(root, 'skills', 'autoprompt', 'SKILL.md')
  const sentinel = path.join(root, 'user-owned.txt')
  const manifestPath = path.join(root, '.autoprompt-install-hashes.json')
  const bytes = Buffer.from('owned Codex payload\n', 'utf8')
  const hash = crypto.createHash('sha256').update(bytes).digest('hex')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, bytes)
  fs.writeFileSync(sentinel, 'must survive\n')
  fs.writeFileSync(manifestPath, canonicalManifest([['skills/autoprompt/SKILL.md', hash]]))
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `. ${ps(LIBRARY)}`,
    `$receipt=@{Files=@(${ps(target)})}`,
    `$plan=@{IsScoped=$true;Manifest=${ps(manifestPath)}}`,
    `$removal=Remove-UninstallProviderFiles -ConfigRoot ${ps(root)} -Name 'codex' -Receipt $receipt -Plan $plan`,
    `$raw=[IO.File]::ReadAllText(${ps(manifestPath)})`,
    `@{code=$removal.Code;removed=$removal.Removed;retained=$removal.Retained;target=(Test-Path -LiteralPath ${ps(target)});sentinel=(Test-Path -LiteralPath ${ps(sentinel)});raw=$raw}|ConvertTo-Json -Compress`,
  ].join(';')
  const result = runPowerShell(command)
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.deepEqual(JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)), {
    code: 0,
    removed: 1,
    retained: 0,
    target: false,
    sentinel: true,
    raw: '{\n}\n',
  })
})

test('Codex Windows hash manifest preserves legacy absolute keys when identity indexing is disabled', {
  skip: process.platform !== 'win32',
}, t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-codex-manifest-legacy-'))
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }))
  const root = path.join(sandbox, 'root')
  const target = path.join(root, 'SKILL.md')
  const hash = '9'.repeat(64)
  const manifestPath = path.join(root, '.autoprompt-install-hashes.json')
  fs.mkdirSync(root)
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `. ${ps(LIBRARY)}`,
    `$ok=Set-IdemManifestHashes -ConfigRoot ${ps(root)} -Hashes @(@{Key=${ps(target)};Hash=${ps(hash)}}) -UseIdentityIndex:$false`,
    `$raw=[IO.File]::ReadAllText(${ps(manifestPath)})`,
    '@{ok=$ok;raw=$raw}|ConvertTo-Json -Compress',
  ].join(';')
  const result = runPowerShell(command)
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.deepEqual(JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)), {
    ok: true,
    raw: canonicalManifest([[target, hash]]),
  })
})

test('Codex Windows extras runtime plan cannot conflict with the core SKILL landing', {
  skip: process.platform !== 'win32',
}, t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-codex-core-extras-'))
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }))
  const root = path.join(sandbox, 'config')
  const stage = path.join(sandbox, 'stage')
  const stageSkill = path.join(stage, 'skills', 'autoprompt')
  const target = path.join(root, 'skills', 'autoprompt', 'SKILL.md')
  const manifestPath = path.join(root, '.autoprompt-install-hashes.json')
  const source = path.join(ROOT, 'agents', 'codex', 'SKILL.md')
  const staged = childProcess.spawnSync(process.execPath, [
    RUNTIME_TOOL, '--install', 'codex', '--destination', stageSkill,
  ], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 })
  assert.equal(staged.status, 0, `${staged.stdout}\n${staged.stderr}`)

  const command = [
    "$ErrorActionPreference = 'Stop'",
    `. ${ps(LIBRARY)}`,
    '$script:AutopromptReceiptFiles=@();$script:AutopromptReceiptCreatedDirectories=@();$script:AutopromptReceiptEdits=@();$script:AutopromptManagedUndoJournal=@()',
    `$tokens=$null;$parseErrors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile(${ps(INSTALLER)},[ref]$tokens,[ref]$parseErrors)`,
    "foreach($functionName in @('Get-PayloadBody','Get-PayloadField')){$definition=@($ast.FindAll({param($candidate)$candidate -is [Management.Automation.Language.FunctionDefinitionAst] -and $candidate.Name -ceq $functionName},$true))[0];Invoke-Expression $definition.Extent.Text}",
    `$payloadName=Get-PayloadField -File ${ps(source)} -Key 'name'`,
    `$payloadDescription=Get-PayloadField -File ${ps(source)} -Key 'description'`,
    `$payloadBody=Get-PayloadBody -File ${ps(source)}`,
    `$prior=$env:CODEX_HOME;$env:CODEX_HOME=${ps(root)}`,
    `try{$core=Install-Idempotent -ConfigRoot ${ps(root)} -Name 'codex' -SkillName $payloadName -Description $payloadDescription -Body $payloadBody}finally{$env:CODEX_HOME=$prior}`,
    'if($core-ne 0){exit $core}',
    `$plan=Get-CodexExtrasRuntimePlan -Tool ${ps(RUNTIME_TOOL)} -Stage ${ps(stage)}`,
    `$item=@($plan.files|Where-Object{$_.receiptPath -ceq 'skills/autoprompt/SKILL.md'})[0]`,
    `$existingManifestHash=Get-IdemManifestHash -ConfigRoot ${ps(root)} -Key ${ps(target)}`,
    `$actualInstalledRawHash=Get-IdemSha256 -Path ${ps(target)}`,
    '$incomingPlanHash=[string]$item.sha256',
    '$sourceRawHash=Get-IdemSha256 -Path ([string]$item.target)',
    `$aliases=@(Get-IdemManifestMatchingKeys -Entries (Read-IdemManifestEntries -ConfigRoot ${ps(root)}) -Key ${ps(target)} -ConfigRoot ${ps(root)})`,
    `$beforeManifest=[IO.File]::ReadAllText(${ps(manifestPath)});$beforeFiles=@(Get-ChildItem -LiteralPath ${ps(root)} -Recurse -File).Count`,
    "$ok=$true;$errorText='';try{Install-CodexExtrasRuntimePlan -ConfigRoot " + ps(root) + ' -Tool ' + ps(RUNTIME_TOOL) + ' -Stage ' + ps(stage) + "|Out-Null}catch{$ok=$false;$errorText=$_.Exception.Message}",
    `$afterManifest=[IO.File]::ReadAllText(${ps(manifestPath)});$afterHash=Get-IdemSha256 -Path ${ps(target)};$afterFiles=@(Get-ChildItem -LiteralPath ${ps(root)} -Recurse -File).Count`,
    `$residue=@(Get-ChildItem -LiteralPath ${ps(root)} -Recurse -Force|Where-Object{$_.Name -like '*.tmp' -or $_.Name -like '*.bak'}).Count`,
    `@{configRoot=${ps(root)};existingManifestHash=$existingManifestHash;actualInstalledRawHash=$actualInstalledRawHash;incomingPlanHash=$incomingPlanHash;sourceRawHash=$sourceRawHash;aliases=$aliases;ok=$ok;error=$errorText;beforeManifest=$beforeManifest;afterManifest=$afterManifest;beforeHash=$actualInstalledRawHash;afterHash=$afterHash;beforeFiles=$beforeFiles;afterFiles=$afterFiles;residue=$residue}|ConvertTo-Json -Compress -Depth 4`,
  ].join(';')
  const result = runPowerShell(command, 60_000)
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  const evidence = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1))
  const diagnostic = JSON.stringify(evidence)
  const coreBytes = fs.readFileSync(target)
  const sourceBytes = fs.readFileSync(path.join(stageSkill, 'SKILL.md'))
  const coreProfile = byteProfile(coreBytes)
  const sourceProfile = byteProfile(sourceBytes)
  t.diagnostic(JSON.stringify({
    configRoot: evidence.configRoot,
    existingManifestHash: evidence.existingManifestHash,
    actualInstalledRawHash: evidence.actualInstalledRawHash,
    incomingPlanHash: evidence.incomingPlanHash,
    sourceRawHash: evidence.sourceRawHash,
    aliases: evidence.aliases,
    ok: evidence.ok,
    error: evidence.error,
    manifestChanged: evidence.afterManifest !== evidence.beforeManifest,
    beforeHash: evidence.beforeHash,
    afterHash: evidence.afterHash,
    beforeFiles: evidence.beforeFiles,
    afterFiles: evidence.afterFiles,
    residue: evidence.residue,
    coreBytes: coreProfile,
    sourceBytes: sourceProfile,
    normalizedLfHashEqual: coreProfile.normalizedLfHash === sourceProfile.normalizedLfHash,
    difference: byteDifference(coreBytes, sourceBytes),
  }))
  assert.equal(evidence.existingManifestHash, evidence.actualInstalledRawHash, diagnostic)
  assert.equal(evidence.incomingPlanHash, evidence.sourceRawHash, diagnostic)
  if (evidence.existingManifestHash !== evidence.incomingPlanHash) {
    assert.equal(evidence.ok, false, diagnostic)
    assert.equal(evidence.afterManifest, evidence.beforeManifest, diagnostic)
    assert.equal(evidence.afterHash, evidence.beforeHash, diagnostic)
    assert.equal(evidence.afterFiles, evidence.beforeFiles, diagnostic)
    assert.equal(evidence.residue, 0, diagnostic)
    assert.equal(evidence.existingManifestHash, evidence.incomingPlanHash,
      `duplicate core/extras SKILL plan: ${diagnostic}`)
  } else {
    assert.equal(evidence.ok, true, diagnostic)
  }
})

test('Codex Windows final manifest canonicalization seals mixed core and extras ownership', {
  skip: process.platform !== 'win32',
}, t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-codex-final-manifest-'))
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }))
  const root = path.join(sandbox, 'config')
  const manifestPath = path.join(root, '.autoprompt-install-hashes.json')
  fs.mkdirSync(root)
  const coreRelative = [
    'skills/autoprompt/SKILL.md',
    'autoprompt.config.toml',
    'agents/.autoprompt-casting.json',
    ...Array.from({ length: 32 }, (_, index) => `agents/ap-${String(index).padStart(2, '0')}.toml`),
  ]
  const extrasRelative = Array.from({ length: 110 }, (_, index) =>
    `skills/autoprompt/runtime/extra-${String(index).padStart(3, '0')}.dat`)
  assert.equal(coreRelative.length, 35)
  assert.equal(extrasRelative.length, 110)
  const relatives = [...coreRelative, ...extrasRelative]
  const records = relatives.map(relative => ({
    relative,
    absolute: path.join(root, ...relative.split('/')),
    hash: crypto.createHash('sha256').update(relative).digest('hex'),
  }))
  for (const record of records) {
    fs.mkdirSync(path.dirname(record.absolute), { recursive: true })
    fs.writeFileSync(record.absolute, record.relative)
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(record.absolute)).digest('hex'), record.hash)
  }
  const initialRaw = canonicalManifest([
    ...records.slice(0, 35).map(record => [record.absolute, record.hash]),
    ...records.slice(35).map(record => [record.relative, record.hash]),
  ])
  const expectedRaw = canonicalManifest(records.map(record => [record.relative, record.hash]))
  fs.writeFileSync(manifestPath, initialRaw)
  const batchPath = path.join(sandbox, 'receipt-owned-batch.json')
  fs.writeFileSync(batchPath, JSON.stringify(records.map(record => ({
    Key: record.absolute, Hash: record.hash,
  }))))
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `. ${ps(LIBRARY)}`,
    `$parsed=Get-Content -LiteralPath ${ps(batchPath)} -Raw|ConvertFrom-Json`,
    '$hashes=@($parsed|ForEach-Object{$_})',
    `$script:AutopromptReceiptFiles=@($hashes|ForEach-Object{$_.Key})`,
    `$ok=Set-IdemManifestHashes -ConfigRoot ${ps(root)} -Hashes $hashes -UseIdentityIndex`,
    `$raw=[IO.File]::ReadAllText(${ps(manifestPath)})`,
    `$residue=@(Get-ChildItem -LiteralPath ${ps(root)} -Recurse -Force|Where-Object{$_.Name -like '*.tmp' -or $_.Name -like '*.bak'}).Count`,
    '$invalid=@($hashes|Where-Object{[string]::IsNullOrEmpty((ConvertTo-IdemPortableManifestKey -ConfigRoot ' + ps(root) + ' -Target ([string]$_.Key)))}|ForEach-Object{[string]$_.Key})',
    '@{ok=$ok;raw=$raw;residue=$residue;batchCount=$hashes.Count;invalid=$invalid}|ConvertTo-Json -Compress -Depth 3',
  ].join(';')
  const result = runPowerShell(command)
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  const finalized = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1))
  t.diagnostic(JSON.stringify({
    ok: finalized.ok,
    residue: finalized.residue,
    stderr: result.stderr.trim(),
    keyCount: (() => { try { return Object.keys(JSON.parse(finalized.raw)).length } catch { return -1 } })(),
    batchCount: finalized.batchCount,
    invalid: finalized.invalid,
  }))
  assert.equal(finalized.ok, true, result.stderr)
  assert.equal(finalized.residue, 0)
  assert.equal(finalized.batchCount, 145)
  assert.deepEqual(finalized.invalid, [])
  assert.equal(finalized.raw, expectedRaw)
  const parsed = JSON.parse(finalized.raw)
  assert.deepEqual(Object.keys(parsed), relatives)
  assert.deepEqual(Object.values(parsed), records.map(record => record.hash))

  const runNegative = (name, raw, batch) => {
    const scenarioRoot = path.join(sandbox, name)
    const scenarioManifest = path.join(scenarioRoot, '.autoprompt-install-hashes.json')
    const scenarioBatch = path.join(sandbox, `${name}.json`)
    fs.mkdirSync(scenarioRoot)
    fs.writeFileSync(scenarioManifest, raw)
    fs.writeFileSync(scenarioBatch, JSON.stringify(batch))
    const negative = runPowerShell([
      "$ErrorActionPreference = 'Stop'",
      `. ${ps(LIBRARY)}`,
      `$hashes=@(Get-Content -LiteralPath ${ps(scenarioBatch)} -Raw|ConvertFrom-Json)`,
      `$before=[IO.File]::ReadAllText(${ps(scenarioManifest)})`,
      `$ok=Set-IdemManifestHashes -ConfigRoot ${ps(scenarioRoot)} -Hashes $hashes -UseIdentityIndex`,
      `$after=[IO.File]::ReadAllText(${ps(scenarioManifest)})`,
      `$residue=@(Get-ChildItem -LiteralPath ${ps(scenarioRoot)} -Recurse -Force|Where-Object{$_.Name -like '*.tmp' -or $_.Name -like '*.bak'}).Count`,
      '@{ok=$ok;before=$before;after=$after;residue=$residue}|ConvertTo-Json -Compress',
    ].join(';'))
    assert.equal(negative.status, 0, `${negative.stdout}\n${negative.stderr}`)
    assert.match(negative.stderr, /error=hash-manifest-invalid-entry/u)
    assert.deepEqual(JSON.parse(negative.stdout.trim().split(/\r?\n/).at(-1)), {
      ok: false, before: raw, after: raw, residue: 0,
    })
  }
  const stableHash = '7'.repeat(64)
  runNegative('outside-root', canonicalManifest([['owned.txt', stableHash]]), [{
    Key: path.join(sandbox, 'outside.txt'), Hash: stableHash,
  }])
  const conflictRoot = path.join(sandbox, 'conflicting-alias')
  const conflictTarget = path.join(conflictRoot, 'SKILL.md')
  runNegative('conflicting-alias', canonicalManifest([
    [conflictTarget, '8'.repeat(64)], ['SKILL.md', '9'.repeat(64)],
  ]), [{ Key: conflictTarget, Hash: '8'.repeat(64) }])

  const installerSource = fs.readFileSync(INSTALLER, 'utf8')
  const finalizerPresent = /function Invoke-CodexRootManifestFinalization\s*\{/u.test(installerSource)
  if (finalizerPresent) {
    const invoke = runPowerShell([
      "$ErrorActionPreference = 'Stop'",
      `. ${ps(LIBRARY)}`,
      `$tokens=$null;$parseErrors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile(${ps(INSTALLER)},[ref]$tokens,[ref]$parseErrors)`,
      "$definition=@($ast.FindAll({param($candidate)$candidate -is [Management.Automation.Language.FunctionDefinitionAst] -and $candidate.Name -ceq 'Invoke-CodexRootManifestFinalization'},$true))[0];Invoke-Expression $definition.Extent.Text",
      `$script:AutopromptReceiptFiles=@(${records.map(record => ps(record.absolute)).join(',')})`,
      `$ok=Invoke-CodexRootManifestFinalization -Root ${ps(root)}`,
      '@{ok=$ok}|ConvertTo-Json -Compress',
    ].join(';'))
    assert.equal(invoke.status, 0, `${invoke.stdout}\n${invoke.stderr}`)
    assert.deepEqual(JSON.parse(invoke.stdout.trim().split(/\r?\n/).at(-1)), { ok: true })
  }
  const finalizerFailures = []
  const runFinalizerFailure = (name, prepareUnsafe) => {
    const scenarioRoot = path.join(sandbox, `finalizer-${name}`)
    const valid = path.join(scenarioRoot, 'skills', 'autoprompt', 'SKILL.md')
    const scenarioManifest = path.join(scenarioRoot, '.autoprompt-install-hashes.json')
    const scenarioReceipt = path.join(scenarioRoot, '.autoprompt-install-receipt.json')
    fs.mkdirSync(path.dirname(valid), { recursive: true })
    fs.writeFileSync(valid, 'owned\n')
    const validHash = crypto.createHash('sha256').update(fs.readFileSync(valid)).digest('hex')
    const manifestRaw = canonicalManifest([[valid, validHash]])
    const receiptRaw = '{"prior":true}\n'
    fs.writeFileSync(scenarioManifest, manifestRaw)
    fs.writeFileSync(scenarioReceipt, receiptRaw)
    const unsafe = prepareUnsafe(scenarioRoot)
    const command = [
      "$ErrorActionPreference = 'Stop'",
      `. ${ps(LIBRARY)}`,
      `$tokens=$null;$parseErrors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile(${ps(INSTALLER)},[ref]$tokens,[ref]$parseErrors)`,
      "foreach($functionName in @('Invoke-ManagedRollback','Invoke-FinalManagedRollback','Invoke-CodexRootManifestFinalization')){$definition=@($ast.FindAll({param($candidate)$candidate -is [Management.Automation.Language.FunctionDefinitionAst] -and $candidate.Name -ceq $functionName},$true))[0];Invoke-Expression $definition.Extent.Text}",
      `$script:AutopromptReceiptFiles=@(${ps(valid)},${ps(unsafe)},${ps(scenarioManifest)})`,
      "$script:ResultRows=@('RESULT=PASS client=codex dest=x format=md-codex','RESULT=PASS client=claude dest=y format=md-claude')",
      '$script:AnyFail=0;$script:IsRecoveryRetained=$false;$script:AutopromptManagedUndoJournal=@()',
      `$snapshot=New-IdemManagedSnapshot -ConfigRoot ${ps(scenarioRoot)} -Paths @(${ps(scenarioManifest)},${ps(scenarioReceipt)})`,
      'if($null-eq $snapshot){exit 91};Add-IdemManagedUndo -Snapshot $snapshot',
      "$caught=$false;$errorText='';try{$null=Invoke-CodexRootManifestFinalization -Root " + ps(scenarioRoot) + '}catch{$caught=$true;$errorText=$_.Exception.Message}',
      `$manifestAfter=[IO.File]::ReadAllText(${ps(scenarioManifest)});$receiptAfter=[IO.File]::ReadAllText(${ps(scenarioReceipt)})`,
      `$residue=@(Get-ChildItem -LiteralPath ${ps(scenarioRoot)} -Recurse -Force|Where-Object{$_.Name -like '*.tmp' -or $_.Name -like '*.bak' -or $_.Name -like '*recovery*'}).Count`,
      '@{caught=$caught;error=$errorText;stage=$script:AutopromptRootFailureStage;anyFail=$script:AnyFail;rows=$script:ResultRows;manifest=$manifestAfter;receipt=$receiptAfter;journal=@($script:AutopromptManagedUndoJournal).Count;recovery=$script:IsRecoveryRetained;residue=$residue}|ConvertTo-Json -Compress -Depth 4',
    ].join(';')
    const failure = runPowerShell(command)
    assert.equal(failure.status, 0, `${failure.stdout}\n${failure.stderr}`)
    const observed = JSON.parse(failure.stdout.trim().split(/\r?\n/).at(-1))
    finalizerFailures.push({ name, stderr: failure.stderr, observed, manifestRaw, receiptRaw })
  }
  runFinalizerFailure('directory', scenarioRoot => {
    const directory = path.join(scenarioRoot, 'owned-directory')
    fs.mkdirSync(directory)
    return directory
  })
  runFinalizerFailure('outside-root', () => {
    const outside = path.join(sandbox, 'finalizer-outside.txt')
    fs.writeFileSync(outside, 'outside\n')
    return outside
  })
  let reparseSupported = false
  const reparseTarget = path.join(sandbox, 'finalizer-reparse-target.txt')
  const reparseRoot = path.join(sandbox, 'finalizer-reparse')
  const reparsePath = path.join(reparseRoot, 'linked.txt')
  try {
    fs.mkdirSync(reparseRoot)
    fs.writeFileSync(reparseTarget, 'target\n')
    fs.symlinkSync(reparseTarget, reparsePath, 'file')
    reparseSupported = true
  } catch { }
  if (reparseSupported) runFinalizerFailure('reparse', () => reparsePath)

  const finalizerSource = installerSource.slice(
    installerSource.indexOf('function Invoke-CodexRootManifestFinalization'),
    installerSource.indexOf('function Set-RootReceipt'),
  )
  const rootBatch = installerSource.slice(
    installerSource.indexOf('function Install-RootBatch'),
    installerSource.indexOf('function Install-Batch'),
  )
  const marksBeforeFinalizerExit = /Set-RootResultsFailed[\s\S]*(?:throw|return)/u.test(finalizerSource)
  const callerMarksBeforeExit = /try\s*\{[^{}]*Invoke-CodexRootManifestFinalization[^{}]*\}\s*catch\s*\{[^{}]*Set-RootResultsFailed[^{}]*(?:throw|return)/u.test(rootBatch)
  t.diagnostic(JSON.stringify({
    finalizerFailures: finalizerFailures.map(({ name, observed }) => ({ name, ...observed })),
    reparseSupported,
    lockedReadFailureSupported: false,
    marksBeforeFinalizerExit,
    callerMarksBeforeExit,
  }))
  for (const failure of finalizerFailures) {
    assert.equal(failure.observed.caught, true, failure.name)
    assert.match(failure.observed.error, /Codex manifest finalization failed/u)
    assert.equal(failure.observed.stage, 'manifest')
    assert.equal(failure.observed.manifest, failure.manifestRaw)
    assert.equal(failure.observed.receipt, failure.receiptRaw)
    assert.equal(failure.observed.journal, 0)
    assert.equal(failure.observed.recovery, false)
    assert.equal(failure.observed.residue, 0)
    assert.deepEqual(failure.observed.rows, [
      'RESULT=FAIL client=codex stage=manifest',
      'RESULT=FAIL client=claude stage=manifest',
    ], `${failure.name}: no staged PASS row may survive finalizer failure`)
  }
  assert.equal(finalizerPresent, true, 'Invoke-CodexRootManifestFinalization must exist')
  assert.equal(marksBeforeFinalizerExit || callerMarksBeforeExit, true,
    'finalizer failure path must call Set-RootResultsFailed before throw/return')
  assert.match(rootBatch,
    /if\s*\([^)]*codex[^)]*\)\s*\{[^}]*Invoke-CodexRootManifestFinalization[^}]*\}\s*if\s*\(-not\s*\(Set-RootReceipt/u,
    'Codex finalization must run in a Codex-only branch immediately before Set-RootReceipt')
})

test('Codex md-codex renderer contract is byte-identical and git-clean', {
  skip: process.platform !== 'win32' || !fs.existsSync(GIT_BASH),
}, t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-codex-render-contract-'))
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }))
  const generatedPath = path.join(ROOT, 'scripts', 'install', 'codex-discovery-shim.md')
  const generatedBytes = fs.readFileSync(generatedPath)
  const generatedText = generatedBytes.toString('utf8')
  const closing = generatedText.indexOf('\n---\n', 4)
  assert.notEqual(closing, -1)
  const frontmatter = generatedText.slice(4, closing).split('\n')
  const name = frontmatter.find(line => line.startsWith('name:')).slice('name:'.length).trim()
  const descriptionScalar = frontmatter.find(line => line.startsWith('description:')).slice('description:'.length).trim()
  const description = decodeCanonicalYamlScalar(descriptionScalar)
  const wrappedBody = generatedText.slice(closing + '\n---\n'.length)
  assert.equal(wrappedBody.startsWith('\n'), true)
  assert.equal(wrappedBody.endsWith('\n'), true)
  const body = wrappedBody.slice(1, -1)
  assert.equal(body.startsWith('\n'), false)
  assert.equal(body.endsWith('\n'), false)
  const namePath = path.join(sandbox, 'name.txt')
  const descriptionPath = path.join(sandbox, 'description.txt')
  const bodyPath = path.join(sandbox, 'body.txt')
  const psOutput = path.join(sandbox, 'powershell.md')
  const bashOutput = path.join(sandbox, 'bash.md')
  const psEscapeOutput = path.join(sandbox, 'powershell-escape.md')
  const bashEscapeOutput = path.join(sandbox, 'bash-escape.md')
  const psActualOutput = path.join(sandbox, 'powershell-actual.md')
  const bashActualOutput = path.join(sandbox, 'bash-actual.md')
  const syntheticPath = path.join(sandbox, 'agents', 'codex', 'SKILL.md')
  const psSyntheticBody = path.join(sandbox, 'powershell-synthetic-body.txt')
  const bashSyntheticBody = path.join(sandbox, 'bash-synthetic-body.txt')
  fs.mkdirSync(path.dirname(syntheticPath), { recursive: true })
  fs.writeFileSync(syntheticPath,
    "---\nname: autoprompt\ndescription: 'Synthetic'\n---\n\n\n# Synthetic\n\n")
  fs.writeFileSync(namePath, name)
  fs.writeFileSync(descriptionPath, description)
  fs.writeFileSync(bodyPath, body)

  const psResult = runPowerShell([
    "$ErrorActionPreference = 'Stop'",
    `. ${ps(LIBRARY)}`,
    `$name=[IO.File]::ReadAllText(${ps(namePath)})`,
    `$description=[IO.File]::ReadAllText(${ps(descriptionPath)})`,
    `$body=[IO.File]::ReadAllText(${ps(bodyPath)})`,
    '$encoding=New-Object Text.UTF8Encoding($false)',
    `[IO.File]::WriteAllText(${ps(psOutput)},(Format-MdYaml -Token 'md-codex' -Name $name -Description $description -Body $body),$encoding)`,
    `[IO.File]::WriteAllText(${ps(psEscapeOutput)},(Format-MdYaml -Token 'md-codex' -Name 'autoprompt' -Description "Codex's exact path" -Body '# Escape'),$encoding)`,
    `$tokens=$null;$parseErrors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile(${ps(INSTALLER)},[ref]$tokens,[ref]$parseErrors)`,
    "foreach($functionName in @('Get-PayloadBody','Get-PayloadField')){$definition=@($ast.FindAll({param($candidate)$candidate -is [Management.Automation.Language.FunctionDefinitionAst] -and $candidate.Name -ceq $functionName},$true))[0];Invoke-Expression $definition.Extent.Text}",
    `$actualName=Get-PayloadField -File ${ps(generatedPath)} -Key 'name'`,
    `$actualDescription=Get-PayloadField -File ${ps(generatedPath)} -Key 'description'`,
    `$actualBody=Get-PayloadBody -File ${ps(generatedPath)}`,
    `$actualRender=Get-CopyRender -Call {Format-Skill -Format 'md-codex' -Name $actualName -Description $actualDescription -Body $actualBody}`,
    "if($actualRender.Code-ne 0){throw 'actual PowerShell payload render failed'}",
    `[IO.File]::WriteAllText(${ps(psActualOutput)},$actualRender.Rendered,$encoding)`,
    `[IO.File]::WriteAllText(${ps(psSyntheticBody)},(Get-PayloadBody -File ${ps(syntheticPath)}),$encoding)`,
  ].join(';'))
  assert.equal(psResult.status, 0, `${psResult.stdout}\n${psResult.stderr}`)
  const bashResult = runBash([
    'set -euo pipefail',
    'lib="$(cygpath -u "$AP_LIBRARY")"',
    '. "$lib"',
    'name="$(cat "$(cygpath -u "$AP_NAME")")"',
    'description="$(cat "$(cygpath -u "$AP_DESCRIPTION")")"',
    'body="$(cat "$(cygpath -u "$AP_BODY")")"',
    'format_skill md-codex "$name" "$description" "$body" > "$(cygpath -u "$AP_OUTPUT")"',
    'format_skill md-codex autoprompt "Codex\'s exact path" "# Escape" > "$(cygpath -u "$AP_ESCAPE_OUTPUT")"',
    'install="$(cygpath -u "$AP_INSTALLER")"',
    'eval "$(awk \'/^payload_body\\(\\) \\{/{emit=1} emit{print} emit && /^}$/{emit=0}\' "$install")"',
    'eval "$(awk \'/^payload_field\\(\\) \\{/{emit=1} emit{print} emit && /^}$/{emit=0}\' "$install")"',
    'generated="$(cygpath -u "$AP_GENERATED")"',
    'actual_name="$(payload_field "$generated" name)"',
    'actual_description="$(payload_field "$generated" description)"',
    'actual_body="$(payload_body "$generated")"',
    'format_skill md-codex "$actual_name" "$actual_description" "$actual_body" > "$(cygpath -u "$AP_ACTUAL_OUTPUT")"',
    'payload_body "$(cygpath -u "$AP_SYNTHETIC")" > "$(cygpath -u "$AP_SYNTHETIC_BODY")"',
  ].join('\n'), {
    AP_LIBRARY: POSIX_LIBRARY,
    AP_NAME: namePath,
    AP_DESCRIPTION: descriptionPath,
    AP_BODY: bodyPath,
    AP_OUTPUT: bashOutput,
    AP_ESCAPE_OUTPUT: bashEscapeOutput,
    AP_INSTALLER: POSIX_INSTALLER,
    AP_GENERATED: generatedPath,
    AP_ACTUAL_OUTPUT: bashActualOutput,
    AP_SYNTHETIC: syntheticPath,
    AP_SYNTHETIC_BODY: bashSyntheticBody,
  })
  assert.equal(bashResult.status, 0, `${bashResult.stdout}\n${bashResult.stderr}`)
  const psBytes = fs.readFileSync(psOutput)
  const bashBytes = fs.readFileSync(bashOutput)
  const psEscapeBytes = fs.readFileSync(psEscapeOutput)
  const bashEscapeBytes = fs.readFileSync(bashEscapeOutput)
  const psActualBytes = fs.readFileSync(psActualOutput)
  const bashActualBytes = fs.readFileSync(bashActualOutput)
  const psSyntheticBytes = fs.readFileSync(psSyntheticBody)
  const bashSyntheticBytes = fs.readFileSync(bashSyntheticBody)
  const gitClean = childProcess.spawnSync('git', [
    'diff', '--check', '--', 'scripts/install/codex-discovery-shim.md',
  ], {
    cwd: ROOT, encoding: 'utf8', timeout: 10_000,
  })
  t.diagnostic(JSON.stringify({
    powershell: byteProfile(psBytes),
    bash: byteProfile(bashBytes),
    generated: byteProfile(generatedBytes),
    powershellVsGenerated: byteDifference(psBytes, generatedBytes),
    bashVsGenerated: byteDifference(bashBytes, generatedBytes),
    gitDiffCheckStatus: gitClean.status,
    powershellActual: byteProfile(psActualBytes),
    bashActual: byteProfile(bashActualBytes),
    powershellActualVsGenerated: byteDifference(psActualBytes, generatedBytes),
    bashActualVsGenerated: byteDifference(bashActualBytes, generatedBytes),
    powershellSyntheticBody: byteProfile(psSyntheticBytes),
    bashSyntheticBody: byteProfile(bashSyntheticBytes),
  }))
  assert.deepEqual(psBytes, bashBytes)
  assert.deepEqual(psEscapeBytes, bashEscapeBytes)
  assert.match(psEscapeBytes.toString('utf8'), /^---\nname: autoprompt\ndescription: 'Codex''s exact path'\nactivation: explicit-only\nallow-implicit-invocation: false\n---\n\n# Escape\n$/u)
  assert.deepEqual(psBytes, generatedBytes)
  assert.deepEqual(psActualBytes, generatedBytes)
  assert.deepEqual(bashActualBytes, generatedBytes)
  assert.deepEqual(psActualBytes, bashActualBytes)
  assert.deepEqual(psSyntheticBytes, Buffer.from('\n\n# Synthetic\n\n'))
  assert.deepEqual(bashSyntheticBytes, Buffer.from('\n\n# Synthetic\n\n'))
  assert.equal(byteProfile(psActualBytes).normalizedLfHash, byteProfile(generatedBytes).normalizedLfHash)
  assert.equal(byteProfile(bashActualBytes).normalizedLfHash, byteProfile(generatedBytes).normalizedLfHash)
  assert.equal(byteProfile(psActualBytes).trailingNewlines, 1)
  assert.equal(byteProfile(bashActualBytes).trailingNewlines, 1)
  assert.match(generatedText, /^---\nname: autoprompt\ndescription: '[^\n]*'\nactivation: explicit-only\nallow-implicit-invocation: false\n---\n\n#/u)
  assert.equal(generatedBytes.includes(0x0d), false)
  assert.equal(byteProfile(generatedBytes).bom, false)
  assert.equal(byteProfile(generatedBytes).trailingNewlines, 1)
  assert.equal(gitClean.status, 0, gitClean.stdout || gitClean.stderr)
})

test('Codex indexed registration rejects a source mutation before publish or receipt', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-codex-source-race-'))
  const root = path.join(sandbox, 'root')
  const source = path.join(sandbox, 'source.txt')
  const target = path.join(root, 'skills', 'autoprompt', 'source.txt')
  fs.mkdirSync(root)
  fs.writeFileSync(source, 'stable source\n')
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `. ${ps(LIBRARY)}`,
    '$script:AutopromptReceiptFiles=@();$script:AutopromptReceiptCreatedDirectories=@();$script:AutopromptReceiptEdits=@();$script:AutopromptManagedUndoJournal=@()',
    `$hook={param($source,$target)[IO.File]::AppendAllText($source,'hostile mutation')}`,
    `$mapping=@{Source=${ps(source)};Target=${ps(target)}}`,
    `$code=Install-IdemManagedFiles -ConfigRoot ${ps(root)} -Mappings @($mapping) -RefuseUnownedTarget -UseCodexBatchIndex -BeforeCodexCopy $hook`,
    `$residue=@(Get-ChildItem -LiteralPath ${ps(root)} -Recurse -Force -ErrorAction SilentlyContinue).Count`,
    '@{code=$code;target=(Test-Path -LiteralPath $mapping.Target);receipt=@($script:AutopromptReceiptFiles).Count;residue=$residue}|ConvertTo-Json -Compress',
  ].join(';')
  const result = runPowerShell(command)
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stderr, /client=codex error=SOURCE_CHANGED_DURING_COPY/)
  assert.deepEqual(JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)), {
    code: 46, target: false, receipt: 0, residue: 0,
  })
  fs.rmSync(sandbox, { recursive: true, force: true })
})

test('Git Bash Codex single and inventory flows reject source mutation without residue', {
  skip: process.platform !== 'win32' || !fs.existsSync(GIT_BASH),
}, () => {
  for (const mode of ['single', 'batch']) {
    const result = bashRaceResult(mode)
    assert.equal(result.status, 0, `${mode}\n${result.stdout}\n${result.stderr}`)
    assert.match(result.stderr, /client=codex error=SOURCE_CHANGED_DURING_COPY/)
    assert.deepEqual(JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)), {
      code: 46, target: 0, receipt: 0, residue: 0, pointer: 0,
    }, mode)
  }
})

test('Git Bash Codex single and inventory flows bind receipt hashes to exact copied bytes', {
  skip: process.platform !== 'win32' || !fs.existsSync(GIT_BASH),
}, () => {
  const expected = {
    single: { code: 0, targets: 1, hashes: 1, receipt: 2, tmp: 0, pointer: 0 },
    batch: { code: 0, targets: 2, hashes: 1, receipt: 3, tmp: 0, pointer: 0 },
  }
  for (const mode of ['single', 'batch']) {
    const result = bashStableResult(mode)
    assert.equal(result.status, 0, `${mode}\n${result.stdout}\n${result.stderr}`)
    assert.deepEqual(JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)), expected[mode], mode)
  }
})

test('validated Codex target cache invalidates generation, digest, and replaced root identity', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-codex-cache-'))
  const root = path.join(sandbox, 'root')
  fs.mkdirSync(root)
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'agents', 'manifests', 'codex-runtime.json'), 'utf8'))
  const command = [
    "$ErrorActionPreference='Stop'",
    `. ${ps(LIBRARY)}`,
    `$RepoRoot=${ps(ROOT)}`,
    `$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile(${ps(INSTALLER)},[ref]$tokens,[ref]$errors)`,
    `$wanted=@('Get-CodexRootIdentity','Clear-ValidatedCodexTargetPlan','Set-ValidatedCodexTargetPlan','Get-ValidatedCodexTargetPlan')`,
    '$ast.FindAll({param($node)$node-is[Management.Automation.Language.FunctionDefinitionAst]-and$wanted-contains$node.Name},$true)|ForEach-Object{Invoke-Expression $_.Extent.Text}',
    `$manifestPath=Join-Path $RepoRoot 'agents/manifests/codex-runtime.json';$manifestHash=Get-IdemSha256 $manifestPath`,
    `$runtime=@{PayloadGeneration=${ps(manifest.payloadGeneration)};PayloadDigest=${ps(manifest.payloadDigest)};ManifestHash=$manifestHash}`,
    `$target=Join-Path ${ps(root)} 'skills/autoprompt/SKILL.md'`,
    `if(-not(Set-ValidatedCodexTargetPlan -Root ${ps(root)} -Targets @($target) -RuntimePlan $runtime)){exit 91}`,
    `if(@(Get-ValidatedCodexTargetPlan -Root ${ps(root)}).Count-ne 1){exit 92}`,
    `$script:CodexValidatedTargetPlan.PayloadGeneration='wrong';if(@(Get-ValidatedCodexTargetPlan -Root ${ps(root)}).Count-ne 0){exit 93}`,
    `if(-not(Set-ValidatedCodexTargetPlan -Root ${ps(root)} -Targets @($target) -RuntimePlan $runtime)){exit 94}`,
    `$script:CodexValidatedTargetPlan.PayloadDigest=('0'*64);if(@(Get-ValidatedCodexTargetPlan -Root ${ps(root)}).Count-ne 0){exit 95}`,
    `if(-not(Set-ValidatedCodexTargetPlan -Root ${ps(root)} -Targets @($target) -RuntimePlan $runtime)){exit 96}`,
    `Rename-Item -LiteralPath ${ps(root)} -NewName 'old-root';New-Item -ItemType Directory -Path ${ps(root)}|Out-Null`,
    `if(@(Get-ValidatedCodexTargetPlan -Root ${ps(root)}).Count-ne 0){exit 97}`,
    "'cache-invalidation=pass'",
  ].join(';')
  const result = runPowerShell(command)
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /cache-invalidation=pass/)
  fs.rmSync(sandbox, { recursive: true, force: true })
})

test('only the Codex runtime landing opts into indexed registration', () => {
  const source = fs.readFileSync(LIBRARY, 'utf8')
  const codex = source.slice(source.indexOf('function Install-CodexExtrasRuntimePlan'), source.indexOf('function Install-ExtrasSkillFiles'))
  const ordinary = source.slice(source.indexOf('function Install-ExtrasSkillFiles'), source.indexOf('function Install-ExtrasNativePersonas'))
  const installer = fs.readFileSync(INSTALLER, 'utf8')
  const posixLibrary = fs.readFileSync(POSIX_LIBRARY, 'utf8')
  const posixInstaller = fs.readFileSync(POSIX_INSTALLER, 'utf8')
  const codexAgentStage = installer.slice(
    installer.indexOf('function Install-CodexAgentStage'),
    installer.indexOf('function Install-CodexAgents'),
  )
  assert.match(codex, /-UseCodexBatchIndex/)
  assert.doesNotMatch(ordinary, /-UseCodexBatchIndex/)
  assert.match(codexAgentStage, /Install-IdemManagedFiles[\s\S]*?-Mappings \$mappings[\s\S]*?-RefuseUnownedTarget -UseCodexBatchIndex/)
  assert.doesNotMatch(codexAgentStage, /Install-IdemManagedFile\s/)
  const posixExtras = posixLibrary.slice(
    posixLibrary.indexOf('install_extras()'),
    posixLibrary.indexOf('# --- F-LIB-EXTRAS (end)'),
  )
  const posixCodexAgents = posixInstaller.slice(
    posixInstaller.indexOf('land_codex_agents()'),
    posixInstaller.indexOf('install_codex_agents()'),
  )
  assert.match(posixExtras, /\[ "\$client" != codex \] \|\| stable_source=1/)
  assert.match(posixCodexAgents, /_idem_install_managed_file[\s\S]*?1 1 0 1/)
})
