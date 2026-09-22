'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const display = require('../../scripts/lima-runtime-vscode-display.cjs')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
function startTicks(pid) { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').trim().split(' ')[21] }
function processGroup(pid) { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').trim().split(' ')[4] }
async function withGlobalDisplayFixture(work) {
  // Separate guest roots in concurrent test processes still share this host's
  // X socket namespace. Keep its lifecycle serialized without unlinking a
  // peer's socket or replacing the lock inode while another process waits.
  const slots = path.join(fs.realpathSync.native(os.tmpdir()), `ap-lima-display-fixture-${process.getuid()}`)
  fs.mkdirSync(slots, { recursive: true, mode: 0o700 })
  const item = fs.lstatSync(slots)
  assert.ok(item.isDirectory() && !item.isSymbolicLink())
  assert.equal(item.uid, process.getuid())
  assert.equal(item.mode & 0o777, 0o700)
  assert.equal(fs.realpathSync.native(slots), slots)
  return await display.withSlotLock({ slots }, work)
}

if (process.platform !== 'linux') test('owned VS Code Xvfb lifecycle requires Linux process fixtures', { skip: true }, () => {})
else test('owned VS Code display is a private worker-group child and drains on normal completion', async () => withGlobalDisplayFixture(async () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ap-lima-vscode-display-')))
  fs.chmodSync(root, 0o700)
  const server = path.join(root, 'fake-xvfb.cjs'), xvfb = path.join(root, 'fake-xvfb'), xauth = path.join(root, 'fake-xauth'), probe = path.join(root, 'fake-xdpyinfo')
  fs.writeFileSync(server, `const fs=require('node:fs'),net=require('node:net'); const n=Number(process.argv[2].slice(1)); fs.mkdirSync('/tmp/.X11-unix',{recursive:true}); const socket='/tmp/.X11-unix/X'+n; const s=net.createServer(); s.listen(socket); const stop=()=>s.close(()=>process.exit(0)); process.on('SIGTERM',stop); process.on('SIGINT',stop);`, { mode: 0o600 })
  fs.writeFileSync(xvfb, `#!${process.execPath}\nrequire(${JSON.stringify(server)})\n`, { mode: 0o700 })
  fs.writeFileSync(xauth, '#!/bin/sh\nprintf 0123456789abcdef > "$2"\n', { mode: 0o700 })
  fs.writeFileSync(probe, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  let owned, second
  try {
    const requestId = '00000000000000000000000000000000'
    owned = await display.startOwnedDisplay({ root, requestId, xvfbPath: xvfb, xauthPath: xauth, probePath: probe })
    assert.match(owned.environment.DISPLAY, /^:[0-9]+$/)
    const selectedDisplay = Number(owned.environment.DISPLAY.slice(1))
    assert.ok(selectedDisplay >= display.DISPLAY_MIN && selectedDisplay < display.DISPLAY_MIN + display.DISPLAY_COUNT, 'allocated display must stay within the private slot range')
    assert.ok(owned.environment.XAUTHORITY.startsWith(`${root}/displays/${requestId}/`))
    assert.equal(owned.environment.XDG_RUNTIME_DIR, `${root}/d/${selectedDisplay}`)
    assert.ok(owned.environment.XDG_RUNTIME_DIR.length < 50, 'VS Code IPC socket base must stay comfortably below Unix socket limits')
    assert.equal(fs.statSync(owned.environment.XAUTHORITY).mode & 0o077, 0)
    assert.equal(processGroup(owned.child.pid), processGroup(process.pid), 'Xvfb must stay in its owning worker process group')
    const childTicks = startTicks(owned.child.pid)
    second = await display.startOwnedDisplay({ root, requestId: '00000020000000000000000000000000', xvfbPath: xvfb, xauthPath: xauth, probePath: probe })
    assert.equal(display.requestDisplay(requestId), display.requestDisplay('00000020000000000000000000000000'), 'test inputs must collide at the same initial slot')
    assert.notEqual(second.environment.DISPLAY, owned.environment.DISPLAY, 'slot reservation must retry after an owned same-slot collision')
    await second.stop()
    await owned.stop()
    await sleep(20)
    assert.equal(fs.existsSync(`/proc/${owned.child.pid}`), false, `owned Xvfb pid ${owned.child.pid}/${childTicks} survived shutdown`)
    assert.equal(fs.existsSync(`/proc/${second.child.pid}`), false, 'second owned Xvfb survived shutdown')
  } finally {
    if (second) await second.stop().catch(() => {})
    if (owned) await owned.stop().catch(() => {})
    fs.rmSync(root, { recursive: true, force: true })
  }
}))

test('owned VS Code display rejects malformed request identities', () => {
  assert.throws(() => display.requestDisplay('bad'), { code: 'LIMA_REQUEST_INVALID' })
})

test('owned VS Code display rejects missing POSIX system prerequisites', { skip: process.platform === 'win32' }, async t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ap-lima-vscode-display-invalid-')))
  fs.chmodSync(root, 0o700)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  await assert.rejects(display.startOwnedDisplay({ root, requestId: '00000020000000000000000000000000', xvfbPath: path.join(root, 'missing-xvfb') }), { code: 'LIMA_VSCODE_DISPLAY_UNAVAILABLE' })
})


test('stale display reclaim refuses a replaced reservation identity', t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ap-lima-vscode-slot-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const slot = path.join(root, 'slot'), replacement = path.join(root, 'replacement')
  const first = '{"request":"stale"}\n', second = '{"request":"live"}\n'
  fs.writeFileSync(slot, first, { mode: 0o600 })
  const identity = display.reservationIdentity(fs.lstatSync(slot, { bigint: true }))
  fs.writeFileSync(replacement, second, { mode: 0o600 })
  fs.renameSync(replacement, slot)
  assert.equal(display.releaseSlot(slot, first, identity, { strict: false }), false)
  assert.equal(fs.readFileSync(slot, 'utf8'), second, 'reclaim must not unlink a replacement reservation')
})

// This guest integration uses Linux /proc start ticks and the real flock binary.
test('concurrent Linux guest stale reclaim serializes a replacement reservation', { skip: process.platform !== 'linux' }, async t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ap-lima-vscode-stale-race-')))
  fs.chmodSync(root, 0o700)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const firstRequest = '00000000000000000000000000000000', secondRequest = '00000020000000000000000000000000'
  const paths = display.displayPaths(root, firstRequest)
  fs.mkdirSync(paths.slots, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(paths.slots, String(display.requestDisplay(firstRequest))), JSON.stringify({ schemaVersion: 1, requestId: 'stale', pid: 99999999, startTicks: '0' }) + '\n', { mode: 0o600 })
  const [first, second] = await Promise.all([display.reserveDisplay(paths, firstRequest), display.reserveDisplay(paths, secondRequest)])
  t.after(async () => { await Promise.allSettled([first.release(), second.release()]) })
  assert.equal(display.requestDisplay(firstRequest), display.requestDisplay(secondRequest), 'both reclaimers must contend for the same stale slot')
  assert.notEqual(first.display, second.display, 'kernel-held lock must let only one reclaimer replace the stale reservation')
  const records = [first, second].map(reservation => JSON.parse(fs.readFileSync(path.join(paths.slots, String(reservation.display)), 'utf8')))
  assert.deepEqual(new Set(records.map(record => record.requestId)), new Set([firstRequest, secondRequest]))
})
