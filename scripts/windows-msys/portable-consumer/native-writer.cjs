'use strict'
// Transport materialization only; a later importer must acquire real native leases.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto')
const MAX_TOTAL = 320 * 1024 * 1024, MAX_FILE = 128 * 1024 * 1024, MAX_MANIFEST = 65536
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
function validName(name) {
  assert.equal(typeof name, 'string'); assert.ok(name.length > 0 && name.length <= 256)
  assert.ok(name.split('/').every(part => part.length <= 96 && /^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))
}
function manifest(bytes) {
  assert.ok(bytes.length > 0 && bytes.length <= MAX_MANIFEST)
  const v = JSON.parse(bytes), canonical = Buffer.from(JSON.stringify(v) + '\n')
  assert.ok(canonical.equals(bytes), 'Exact writer framing required')
  assert.deepEqual(Object.keys(v), ['schema','files']); assert.equal(v.schema, 1)
  assert.ok(Array.isArray(v.files) && v.files.length > 0 && v.files.length <= 100)
  const seen = new Set(); let total = 0
  for (const f of v.files) {
    assert.deepEqual(Object.keys(f), ['path','bytes','sha256']); validName(f.path)
    assert.ok(!seen.has(f.path.toLowerCase())); seen.add(f.path.toLowerCase())
    assert.ok(Number.isSafeInteger(f.bytes) && f.bytes >= 0 && f.bytes <= MAX_FILE)
    assert.match(f.sha256, /^[a-f0-9]{64}$/); total += f.bytes
  }
  assert.ok(total <= MAX_TOTAL)
  for (const name of seen) { const parts = name.split('/'); for (let i = 1; i < parts.length; i++) assert.ok(!seen.has(parts.slice(0,i).join('/'))) }
  return v
}
function physical(target, directory) {
  assert.ok(path.isAbsolute(target)); assert.equal(fs.realpathSync.native(target).toLowerCase(), path.resolve(target).toLowerCase())
  for (let p = target;; p = path.dirname(p)) {
    const s = fs.lstatSync(p); assert.ok(!s.isSymbolicLink())
    if (p !== target || directory) assert.ok(s.isDirectory())
    else assert.ok(s.isFile() && s.nlink === 1)
    if (p === path.dirname(p)) break
  }
}
async function main(args) {
  assert.equal(process.platform, 'win32', 'Actual Windows private ACL establishment required')
  assert.equal(args.length, 4)
  const [root, repo, aclSha, controllerSha] = args
  physical(root, true); physical(repo, true); physical(process.execPath, false)
  assert.match(controllerSha, /^[a-f0-9]{64}$/); assert.equal(sha(fs.readFileSync(process.execPath)), controllerSha)
  assert.deepEqual(fs.readdirSync(root), [], 'Fresh empty root required')
  const source = path.join(repo, 'agents/codex/workflow/safe-run-root.js')
  physical(source, false); assert.match(aclSha, /^[a-f0-9]{64}$/); assert.equal(sha(fs.readFileSync(source)), aclSha)
  const api = require(source)
  const before = fs.lstatSync(root, { bigint: true })
  assert.deepEqual(api.ensureWindowsPrivateAcl(root), { supported: true, mechanism: 'windows-dacl' })
  assert.equal(sha(fs.readFileSync(source)), aclSha)
  // This same process now has a user token owner for every created descendant.
  // The caller never writes candidate bytes into the root before this point.
  const parts = []; let size = 0
  for await (const chunk of process.stdin) { size += chunk.length; assert.ok(size <= MAX_TOTAL + MAX_MANIFEST); parts.push(chunk) }
  const bytes = Buffer.concat(parts), end = bytes.indexOf(10)
  assert.ok(end >= 0 && end < MAX_MANIFEST)
  const value = manifest(bytes.subarray(0,end+1)); let offset = end + 1
  for (const f of value.files) {
    assert.ok(offset + f.bytes <= bytes.length)
    const body = bytes.subarray(offset, offset + f.bytes); offset += f.bytes
    assert.equal(sha(body), f.sha256)
  }
  assert.equal(offset, bytes.length, 'No trailing writer payload permitted')
  offset = end + 1
  for (const f of value.files) {
    const target = path.join(root, ...f.path.split('/')), parent = path.dirname(target)
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 }); physical(parent, true)
    api.inspectPathNoFollow(parent)
    const fd = fs.openSync(target, 'wx', 0o600)
    try {
      const body = bytes.subarray(offset, offset + f.bytes); offset += f.bytes
      let written = 0; while (written < body.length) { const count = fs.writeSync(fd, body, written, body.length-written); assert.ok(count > 0); written += count }
      fs.fsyncSync(fd); const st = fs.fstatSync(fd); assert.ok(st.isFile() && st.nlink === 1 && st.size === f.bytes)
    } finally { fs.closeSync(fd) }
    physical(target, false); api.inspectPathNoFollow(target, { mustBeDirectory: false })
    assert.equal(sha(fs.readFileSync(target)), f.sha256)
  }
  const after = fs.lstatSync(root, { bigint: true }); assert.equal(after.dev, before.dev); assert.equal(after.ino, before.ino)
  assert.equal(sha(fs.readFileSync(source)), aclSha); assert.equal(sha(fs.readFileSync(process.execPath)), controllerSha)
  process.stdout.write(JSON.stringify({status:'private-native-materialization-not-held-capture',files:value.files.length})+'\n')
}
if (require.main === module) main(process.argv.slice(2)).catch(() => { process.stderr.write('Native candidate writer refused\n'); process.exitCode=1 })
module.exports = { manifest, validName }
