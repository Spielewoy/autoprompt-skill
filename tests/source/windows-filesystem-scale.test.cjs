'use strict'
const assert = require('node:assert/strict')
const cp = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const workflow = path.resolve(__dirname, '../../agents/codex/workflow')
const helper = path.join(workflow, 'windows-filesystem.ps1')
const wrapper = path.join(workflow, 'windows-filesystem.js')
const windows = process.platform === 'win32'
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
const shell = () => windows ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : process.env.AUTOPROMPT_TEST_PWSH || 'pwsh'

test('complete Windows filesystem source compiles with separate tree cleanup and record bounds', { timeout: 90000 }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-filesystem-compile-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = /\$source = @'\r?\n([\s\S]*?)\r?\n'@/.exec(fs.readFileSync(helper, 'utf8'))
  assert.ok(source, 'compile the complete actual embedded helper')
  const file = path.join(root, 'capture.cs'); fs.writeFileSync(file, source[1])
  const command = '$ErrorActionPreference="Stop";Add-Type -Path $env:AP_FILESYSTEM_SOURCE;$t=[AutopromptWindowsCapture];$f=[Reflection.BindingFlags]"Static,NonPublic";foreach($p in @(@("MaxTreeEntries",16384),@("MaxCleanupEntries",32768),@("MaxRecordEntries",4096),@("MaxBytes",67108864))){if($t.GetField($p[0],$f).GetRawConstantValue() -ne $p[1]){throw "filesystem bound mismatch"}};$m=$t.GetMethod("ReadBufferLength",$f);foreach($p in @(@([long]0,1),@([long]1,1),@([long]17,17),@([long]1048576,1048576),@([long]67108864,1048576))){if($m.Invoke($null,[object[]]@($p[0])) -ne $p[1]){throw "buffer bound mismatch"}};foreach($n in @([long]-1,[long]67108865)){try{$m.Invoke($null,[object[]]@($n));throw "invalid buffer length admitted"}catch{$cause=$_.Exception;while($cause.InnerException){$cause=$cause.InnerException};if($cause.GetType().FullName -cne "AutopromptWindowsCapture+Refusal" -or $cause.Code -cne "FILESYSTEM_CAPTURE_LIMIT"){throw}}};[Console]::Write("compiled")'
  const result = cp.spawnSync(shell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 60000, windowsHide: true, env: { ...process.env, AP_FILESYSTEM_SOURCE: file } })
  if (result.error?.code === 'ENOENT' && !windows) { t.skip('PowerShell compiler unavailable; native filesystem scale remains unproven'); return }
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr || result.stdout); assert.equal(result.stderr, ''); assert.equal(result.stdout, 'compiled')
})

function recipe(count, nested = false) {
  const entries = [{ name: '', type: 'directory' }]
  if (!nested) {
    for (let index = 1; index < count; index++) entries.push({ name: 'f' + String(index).padStart(5, '0'), type: 'file', bytes: Buffer.from('data:' + index) })
  } else {
    for (let index = 0; entries.length < count; index++) {
      const directory = 'd' + String(index).padStart(5, '0')
      entries.push({ name: directory, type: 'directory' })
      for (let child = 0; child < 3 && entries.length < count; child++) entries.push({ name: directory + '/f' + child, type: 'file', bytes: Buffer.from(directory + ':' + child) })
    }
  }
  assert.equal(entries.length, count)
  return entries
}
function materialize(root, entries) {
  for (const entry of entries) {
    const file = path.join(root, ...entry.name.split('/'))
    if (entry.type === 'directory') fs.mkdirSync(file)
    else fs.writeFileSync(file, entry.bytes, { flag: 'wx' })
  }
}
function expectedDigest(entries) {
  const digest = crypto.createHash('sha256')
  for (const entry of entries.slice(1)) {
    if (entry.type === 'directory') digest.update('directory\0' + entry.name + '\0' + 0o666 + '\0')
    else { digest.update('file\0' + entry.name + '\0' + 0o666 + '\0' + entry.bytes.length + '\0'); digest.update(entry.bytes); digest.update('\0') }
  }
  return digest.digest('hex')
}
function verifyCapture(root, entries, captured) {
  assert.equal(captured.entries.length, entries.length)
  assert.equal(captured.bytes, entries.reduce((sum, item) => sum + (item.bytes?.length || 0), 0))
  assert.equal(captured.hash, expectedDigest(entries))
  const actual = new Map(captured.entries.map(entry => [entry.path, entry]))
  for (const entry of entries) {
    const value = actual.get(entry.name), file = path.join(root, ...entry.name.split('/')), stat = fs.lstatSync(file, { bigint: true })
    assert.ok(value, entry.name); assert.equal(value.type, entry.type); assert.equal(value.stat.dev, String(stat.dev)); assert.equal(value.stat.ino, String(stat.ino))
    assert.equal(value.mode, 0o666)
    if (entry.type === 'file') { assert.deepEqual(value.content, entry.bytes); assert.deepEqual(fs.readFileSync(file), entry.bytes) }
  }
}
function snapshot(root) {
  const digest = crypto.createHash('sha256'); let count = 0
  const visit = (relative = '') => {
    const file = path.join(root, ...relative.split('/')), stat = fs.lstatSync(file, { bigint: true })
    digest.update(JSON.stringify([relative, String(stat.dev), String(stat.ino), String(stat.mode), String(stat.nlink), String(stat.size)]) + '\n'); count++
    if (stat.isDirectory()) for (const child of fs.readdirSync(file).sort()) visit(relative ? relative + '/' + child : child)
    else if (stat.isFile()) digest.update(fs.readFileSync(file))
    else if (stat.isSymbolicLink()) digest.update(fs.readlinkSync(file))
    else assert.fail('unexpected fixture type')
  }
  visit(); return { count, sha256: digest.digest('hex') }
}

// Failure diagnostics only: these path observations are not held-identity
// verification and may race pathname changes; rejecting an observed link is
// not a security boundary. Counts never authorize cleanup or assert drain. The elapsed
// bound is checked between local filesystem calls, not a cancellation guarantee.
function partialCopyInventory(root, maxEntries = 32768) {
  const start = process.hrtime.bigint()
  const result = { observationOnly: true, complete: false, entries: 0, files: 0, directories: 0, bytes: 0, status: 'started' }
  const stop = status => { const error = new Error(status); error.inventoryStatus = status; throw error }
  const visit = (file, depth) => {
    if (Number((process.hrtime.bigint() - start) / 1000000n) >= 5000) stop('time-limit')
    if (result.entries >= maxEntries) stop('entry-limit')
    if (depth > 128) stop('depth-limit')
    const stat = fs.lstatSync(file)
    if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) stop('unsafe-entry')
    result.entries++
    if (stat.isFile()) { result.files++; result.bytes += stat.size; return }
    result.directories++
    const directory = fs.opendirSync(file)
    try { for (let item; (item = directory.readSync());) visit(path.join(file, item.name), depth + 1) }
    finally { directory.closeSync() }
  }
  try { visit(root, 0); result.complete = true; result.status = 'complete' }
  catch (error) {
    result.status = error.inventoryStatus || (error.code === 'ENOENT' && result.entries === 0 ? 'absent' : 'io-error')
    if (typeof error.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code)) result.code = error.code
  }
  result.elapsedMs = Number((process.hrtime.bigint() - start) / 1000000n)
  return result
}
test('partial copy diagnostics count bounded objects and reject observed links without cleanup claims', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'partial-copy-observation-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const root = path.join(base, 'copy'); fs.mkdirSync(root); fs.mkdirSync(path.join(root, 'child')); fs.writeFileSync(path.join(root, 'child', 'data'), 'bytes')
  const complete = partialCopyInventory(root)
  assert.equal(complete.status, 'complete'); assert.equal(complete.complete, true)
  assert.equal(complete.entries, 3); assert.equal(complete.directories, 2); assert.equal(complete.files, 1); assert.equal(complete.bytes, 5)
  assert.equal(complete.observationOnly, true); assert.equal(complete.cleanupConfirmed, undefined)
  assert.equal(partialCopyInventory(root, 2).status, 'entry-limit')
  const absent = partialCopyInventory(path.join(base, 'absent')); assert.equal(absent.status, 'absent'); assert.equal(absent.complete, false)
  const outside = path.join(base, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'guard'), 'outside')
  fs.symlinkSync(outside, path.join(root, 'link'), windows ? 'junction' : 'dir')
  const linked = partialCopyInventory(root); assert.equal(linked.status, 'unsafe-entry'); assert.equal(linked.complete, false)
  assert.equal(fs.readFileSync(path.join(outside, 'guard'), 'utf8'), 'outside')
  assert.equal(fs.readFileSync(path.join(root, 'child', 'data'), 'utf8'), 'bytes')
})

const nativeName = 'native Windows filesystem scale captures copies renames flushes and cleans bounded large trees'
test(nativeName, { skip: !windows, timeout: 1500000 }, t => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'windows-filesystem-scale-')))
  let cleanupConfirmed = false, evidence = null
  const report = () => {
    if (!evidence) return
    let bounded = evidence
    if (Buffer.byteLength(JSON.stringify(bounded)) > 65536) bounded = { ...evidence, diagnosticTruncated: true, operations: evidence.operations.slice(-16).map(({ details, ...operation }) => operation) }
    t.diagnostic('WINDOWS_FILESYSTEM_SCALE_PROOF:' + JSON.stringify(bounded))
  }
  t.after(() => {
    if (cleanupConfirmed) fs.rmSync(base, { recursive: true, force: true })
    else {
      t.diagnostic('Retained Windows filesystem scale fixture: ' + base)
      // CI keeps TAP even when the ephemeral runner disappears. Reporting
      // partial evidence must never replace the original operation failure.
      try { report() } catch { t.diagnostic('WINDOWS_FILESYSTEM_SCALE_DIAGNOSTIC_UNAVAILABLE') }
    }
  })
  require('../../agents/codex/workflow/safe-run-root.js').ensureWindowsPrivateAcl(base)
  const api = require(wrapper).createWindowsFilesystemCapture()
  const sourceBindings = [helper, wrapper].map(file => ({ path: path.basename(file), sha256: hash(fs.readFileSync(file)), bytes: fs.statSync(file).size }))
  assert.equal(api.helper.sha256, sourceBindings[0].sha256)
  assert.equal(api.helper.size, sourceBindings[0].bytes)
  evidence = { schema: 1, scope: 'filesystem-component', platform: process.platform, controllerArchitecture: process.arch, controllerVersion: process.version, sourceBindings, powershell: { sha256: api.powershell.sha256, bytes: api.powershell.size }, operations: [], cases: [], cleanupConfirmed: false }
  const evidenceFile = path.join(base, 'proof.json')
  const save = () => fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2) + '\n')
  const call = (name, action, failureObservation) => {
    const start = process.hrtime.bigint()
    try {
      const value = action(); evidence.operations.push({ name, outcome: 'returned', elapsedMs: Number((process.hrtime.bigint() - start) / 1000000n) }); save(); return value
    } catch (error) {
      const elapsedMs = Number((process.hrtime.bigint() - start) / 1000000n)
      let partialCopy
      try { if (failureObservation) partialCopy = failureObservation() } catch { partialCopy = { observationOnly: true, complete: false, status: 'diagnostic-unavailable' } }
      evidence.operations.push({ name, outcome: 'threw', ...(partialCopy ? { partialCopy } : {}), code: String(error.code || 'UNKNOWN').slice(0, 80), elapsedMs, ...(error.details ? { details: error.details } : {}) }); try { save() } catch {} throw error
    }
  }
  const remove = (name, target, owned) => {
    assert.deepEqual(call(name, () => api.removeOwnedTarget(target, owned.parentIdentity, owned.targetIdentity)), { removed: true })
    assert.equal(fs.existsSync(target), false)
    assert.deepEqual(call(name + '-repeated', () => api.removeOwnedTarget(target, owned.parentIdentity, owned.targetIdentity)), { removed: false })
  }
  save()
  // Exercise actual reads on both sides of the allocation/chunk boundary,
  // including the zero-length EOF probe, through the same public transport.
  const byteRoot = path.join(base, 'byte-boundaries'); fs.mkdirSync(byteRoot)
  const byteLengths = [0, 1, 17, 1048575, 1048576, 1048577]
  for (const length of byteLengths) {
    const bytes = Buffer.alloc(length)
    for (let index = 0; index < length; index++) bytes[index] = (index * 29 + 7) & 255
    const file = path.join(byteRoot, 'bytes' + length); fs.writeFileSync(file, bytes, { flag: 'wx' })
    const read = call('byte-read-' + length, () => api.captureFileBytes(file, undefined, length))
    assert.equal(read.bytes, length); assert.deepEqual(read.content, bytes); assert.equal(read.hash, hash(bytes))
    const digest = call('byte-hash-' + length, () => api.captureFile(file, undefined, length))
    assert.equal(digest.hash, read.hash); assert.equal(digest.identity, read.identity); assert.equal(digest.bytes, length)
    if (length > 0) assert.throws(() => call('byte-bound-refusal-' + length, () => api.captureFileBytes(file, undefined, length - 1)), { code: 'FILESYSTEM_CAPTURE_LIMIT' })
  }
  const byteOwned = call('byte-inspect', () => api.inspectOwnedTarget(byteRoot)); remove('byte-cleanup', byteRoot, byteOwned)
  evidence.byteLengths = byteLengths; save()
  for (const [name, entries] of [['flat5001', recipe(5001)], ['nested16384', recipe(16384, true)]]) {
    const source = path.join(base, name), copied = path.join(base, name + '-copy'), renamed = path.join(base, name + '-renamed')
    materialize(source, entries)
    const sourceBefore = snapshot(source)
    const first = call(name + '-capture', () => api.captureTree(source)); verifyCapture(source, entries, first)
    const repeated = call(name + '-capture-repeat', () => api.captureTree(source)); assert.equal(repeated.hash, first.hash); assert.deepEqual(repeated.entries.map(item => item.identity), first.entries.map(item => item.identity))
    assert.deepEqual(call(name + '-flush', () => api.fsyncTree(source)), { flushed: true })
    const copy = call(name + '-copy', () => api.copyTreeExclusive(source, copied), () => partialCopyInventory(copied))
    const copiedState = call(name + '-copy-capture', () => api.captureTree(copied)); verifyCapture(copied, entries, copiedState)
    assert.equal(copy.stat.dev, copiedState.entries[0].stat.dev); assert.equal(copy.stat.ino, copiedState.entries[0].stat.ino)
    const sourceIds = new Set(first.entries.map(item => item.identity)); assert.ok(copiedState.entries.every(item => !sourceIds.has(item.identity)))
    const moved = call(name + '-rename', () => api.renameTreeNoReplace(copied, renamed)); assert.equal(moved.stat.dev, copy.stat.dev); assert.equal(moved.stat.ino, copy.stat.ino); assert.equal(fs.existsSync(copied), false)
    const renamedState = call(name + '-rename-capture', () => api.captureTree(renamed)); verifyCapture(renamed, entries, renamedState)
    assert.equal(moved.stat.dev, renamedState.entries[0].stat.dev); assert.equal(moved.stat.ino, renamedState.entries[0].stat.ino)
    assert.deepEqual(renamedState.entries.map(item => item.identity), copiedState.entries.map(item => item.identity))
    assert.deepEqual(snapshot(source), sourceBefore)
    const owned = call(name + '-inspect-copy', () => api.inspectOwnedTarget(renamed))
    // Growth is legal after admission. Cleanup has independent headroom and
    // must remove this actual larger tree, not rely on test teardown.
    let cleanupEntries = entries.length
    if (name === 'nested16384') {
      for (let index = 0; index < 16384; index++) fs.writeFileSync(path.join(renamed, 'grown' + String(index).padStart(5, '0')), 'grown', { flag: 'wx' })
      cleanupEntries = 32768; assert.equal(snapshot(renamed).count, cleanupEntries)
    }
    remove(name + '-cleanup-copy', renamed, owned)
    const sourceOwned = call(name + '-inspect-source', () => api.inspectOwnedTarget(source)); remove(name + '-cleanup-source', source, sourceOwned)
    evidence.cases.push({ name, entries: entries.length, bytes: first.bytes, hash: first.hash, cleanupEntries, exactInventory: true, distinctCopiedIdentities: true, renamePreservedIdentities: true, sourceUnchanged: true, cleanupConfirmed: true }); save()
  }
  // Refuse a tree exceeding admission before copy/rename publishes anything.
  const overflow = path.join(base, 'overflow16385'), overflowCopy = path.join(base, 'overflow-copy'), overflowMove = path.join(base, 'overflow-move')
  materialize(overflow, recipe(16385)); const overflowBefore = snapshot(overflow)
  for (const [name, action] of [['capture', () => api.captureTree(overflow)], ['flush', () => api.fsyncTree(overflow)], ['copy', () => api.copyTreeExclusive(overflow, overflowCopy)], ['rename', () => api.renameTreeNoReplace(overflow, overflowMove)]]) {
    assert.throws(() => call('overflow-' + name, action), { code: 'FILESYSTEM_CAPTURE_LIMIT' }); assert.deepEqual(snapshot(overflow), overflowBefore); assert.equal(fs.existsSync(overflowCopy), false); assert.equal(fs.existsSync(overflowMove), false)
  }
  const overflowOwned = call('overflow-inspect', () => api.inspectOwnedTarget(overflow)); remove('overflow-cleanup', overflow, overflowOwned)
  // Owned deletion must validate its entire larger bound before first delete.
  const cleanupOverflow = path.join(base, 'cleanup32769'); materialize(cleanupOverflow, recipe(32769))
  const cleanupBefore = snapshot(cleanupOverflow), cleanupOwned = call('cleanup-overflow-inspect', () => api.inspectOwnedTarget(cleanupOverflow))
  assert.throws(() => call('cleanup-overflow-refusal', () => api.removeOwnedTarget(cleanupOverflow, cleanupOwned.parentIdentity, cleanupOwned.targetIdentity)), { code: 'FILESYSTEM_CAPTURE_LIMIT' }); assert.deepEqual(snapshot(cleanupOverflow), cleanupBefore)
  // Remove only the controller-created overflow item, then prove exact native
  // cleanup of the remaining 32768 entries.
  fs.unlinkSync(path.join(cleanupOverflow, 'f32768')); remove('cleanup-at-boundary', cleanupOverflow, cleanupOwned)
  // Hostile entries after the former 4096 limit must not be silently omitted.
  const hostile = path.join(base, 'hostile5001'); materialize(hostile, recipe(5001))
  const outside = path.join(base, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'guard'), 'outside')
  const hostileOwned = call('hostile-inspect', () => api.inspectOwnedTarget(hostile))
  const hostileEntry = path.join(hostile, 'zz-hostile'), hostileCopy = path.join(base, 'hostile-copy')
  for (const kind of ['hardlink', 'junction']) {
    if (kind === 'hardlink') fs.linkSync(path.join(outside, 'guard'), hostileEntry)
    else fs.symlinkSync(outside, hostileEntry, 'junction')
    const before = snapshot(hostile), outsideBefore = snapshot(outside)
    for (const [name, action] of [['capture', () => api.captureTree(hostile)], ['copy', () => api.copyTreeExclusive(hostile, hostileCopy)], ['cleanup', () => api.removeOwnedTarget(hostile, hostileOwned.parentIdentity, hostileOwned.targetIdentity)]]) {
      assert.throws(() => call(kind + '-' + name, action), { code: 'PREIMAGE_UNSAFE' }); assert.deepEqual(snapshot(hostile), before); assert.deepEqual(snapshot(outside), outsideBefore); assert.equal(fs.existsSync(hostileCopy), false)
    }
    if (kind === 'junction') fs.rmdirSync(hostileEntry); else fs.unlinkSync(hostileEntry)
  }
  remove('hostile-cleanup', hostile, hostileOwned)
  const outsideOwned = call('outside-inspect', () => api.inspectOwnedTarget(outside)); remove('outside-cleanup', outside, outsideOwned)
  // Shared directory enumeration must still refuse excessive private record
  // residues before deleting even the first matching dead-writer temporary.
  const records = path.join(base, 'records'); fs.mkdirSync(records)
  const dead = cp.spawnSync(process.execPath, ['-e', ''], { timeout: 15000, stdio: 'ignore', windowsHide: true }); assert.ifError(dead.error); assert.equal(dead.status, 0); assert.ok(dead.pid > 0)
  const residues = Array.from({ length: 4097 }, (_, index) => '.terminal.json.' + dead.pid + '.' + index.toString(16).padStart(16, '0') + '.create')
  for (const name of residues) fs.writeFileSync(path.join(records, name), '', { flag: 'wx' })
  const recordsBefore = snapshot(records)
  assert.throws(() => call('record-recovery-overflow', () => api.recoverRecordPublication(path.join(records, 'terminal.json'))), { code: 'FILESYSTEM_CAPTURE_LIMIT' }); assert.deepEqual(snapshot(records), recordsBefore)
  const recordOwned = call('records-inspect', () => api.inspectOwnedTarget(records)); remove('records-cleanup', records, recordOwned)
  evidence.refusals = { admissionEntries: 16385, cleanupEntries: 32769, privateRecordEntries: 4097, beforeMutation: true, lateHardlink: true, lateJunction: true }
  evidence.cleanupConfirmed = true; save(); cleanupConfirmed = true
  report()
})
