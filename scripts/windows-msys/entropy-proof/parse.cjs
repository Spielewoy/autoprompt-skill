'use strict'
const assert = require('node:assert/strict')
const ENVIRONMENT = ['SYSTEMROOT', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'LOCALAPPDATA', 'OPENSSL_CONF', 'OPENSSL_MODULES', 'NODE_OPTIONS', 'SYSTEMDRIVE', 'USERPROFILE', 'HOME', 'APPDATA']
const exact = (value, keys) => { assert.ok(value && typeof value === 'object' && !Array.isArray(value)); assert.deepEqual(Object.keys(value).sort(), [...keys].sort()) }
const uint = (value, max = 0xffffffff) => assert.ok(Number.isSafeInteger(value) && value >= 0 && value <= max)
const text = value => { assert.equal(typeof value, 'string'); assert.ok(value.length <= 2048 && !value.includes('\0')) }
const nullableStatus = value => { if (value !== null) assert.match(value, /^[0-9a-f]{8}$/) }
function identity(value) {
  exact(value, ['error', 'appContainer', 'userSid', 'packageSid', 'integrityRid']); uint(value.error)
  if (value.error) { for (const key of ['appContainer', 'userSid', 'packageSid', 'integrityRid']) assert.equal(value[key], null); return }
  assert.equal(typeof value.appContainer, 'boolean'); text(value.userSid); assert.match(value.userSid, /^S-1-[0-9]+(?:-[0-9]+)+$/)
  text(value.packageSid)
  if (value.appContainer) assert.match(value.packageSid, /^S-1-15-2-(?:[0-9]+-){6}[0-9]+$/)
  else assert.equal(value.packageSid, '')
  uint(value.integrityRid)
}
function parseProof(stdout, expectedPackageSid) {
  assert.equal(typeof stdout, 'string'); assert.ok(stdout.length > 0 && Buffer.byteLength(stdout) <= 131072)
  assert.match(stdout, /^[\x09\x0a\x0d\x20-\x7e]+$/)
  const p = JSON.parse(stdout)
  exact(p, ['schemaVersion', 'identity', 'architecture', 'libraries', 'rng', 'environment', 'legacyRng', 'selfAccess', 'security']); assert.equal(p.schemaVersion, 1)
  exact(p.identity, ['primary', 'threadTokenPresent', 'threadTokenError', 'thread']); identity(p.identity.primary)
  assert.equal(typeof p.identity.threadTokenPresent, 'boolean'); uint(p.identity.threadTokenError)
  if (p.identity.threadTokenPresent) { assert.equal(p.identity.threadTokenError, 0); identity(p.identity.thread) }
  else { assert.notEqual(p.identity.threadTokenError, 0); assert.equal(p.identity.thread, null) }
  if (expectedPackageSid !== undefined) {
    assert.equal(p.identity.primary.error, 0)
    assert.equal(p.identity.primary.appContainer, expectedPackageSid !== null)
    assert.equal(p.identity.primary.packageSid, expectedPackageSid === null ? '' : expectedPackageSid)
    assert.equal(p.identity.threadTokenPresent, false); assert.equal(p.identity.threadTokenError, 1008)
  }
  exact(p.architecture, ['error', 'pointerBits', 'processMachine', 'nativeMachine']); uint(p.architecture.error)
  assert.ok([32, 64].includes(p.architecture.pointerBits))
  for (const field of ['processMachine', 'nativeMachine']) { if (p.architecture.error) assert.equal(p.architecture[field], null); else uint(p.architecture[field], 65535) }
  exact(p.libraries, ['bcrypt', 'advapi'])
  for (const [name, dll] of Object.entries(p.libraries)) {
    exact(dll, ['loadError', 'path', 'pathError', 'symbolError']); for (const field of ['loadError', 'pathError', 'symbolError']) uint(dll[field])
    if (dll.loadError) { assert.equal(dll.path, null); assert.equal(dll.pathError, 0); assert.equal(dll.symbolError, 0) }
    else if (dll.pathError) assert.equal(dll.path, null)
    else { text(dll.path); assert.match(dll.path, /^(?:[A-Za-z]:\\|\\\\)/); assert.ok(dll.path.toLowerCase().endsWith('\\' + (name === 'advapi' ? 'advapi32' : name) + '.dll')) }
  }
  exact(p.rng, ['systemStatus', 'openStatus', 'providerStatus', 'closeStatus', 'rtlSuccess', 'rtlError'])
  for (const field of ['systemStatus', 'openStatus', 'providerStatus', 'closeStatus']) nullableStatus(p.rng[field])
  if (p.libraries.bcrypt.loadError) for (const field of ['systemStatus', 'openStatus', 'providerStatus', 'closeStatus']) assert.equal(p.rng[field], null)
  if (!p.libraries.bcrypt.loadError && !p.libraries.bcrypt.symbolError) { assert.notEqual(p.rng.systemStatus, null); assert.notEqual(p.rng.openStatus, null) }
  if (p.rng.openStatus === '00000000') { assert.notEqual(p.rng.closeStatus, null); if (!p.libraries.bcrypt.symbolError) assert.notEqual(p.rng.providerStatus, null) }
  else assert.equal(p.rng.providerStatus, null)
  if (p.rng.rtlSuccess === null) { assert.equal(p.rng.rtlError, null); assert.ok(p.libraries.advapi.loadError || p.libraries.advapi.symbolError) }
  else { assert.equal(typeof p.rng.rtlSuccess, 'boolean'); uint(p.rng.rtlError); if (p.rng.rtlSuccess) assert.equal(p.rng.rtlError, 0); assert.equal(p.libraries.advapi.loadError, 0) }
  exact(p.environment, ENVIRONMENT)
  for (const value of Object.values(p.environment)) {
    exact(value, ['present', 'error', 'value']); assert.equal(typeof value.present, 'boolean'); uint(value.error)
    if (!value.error) { assert.equal(value.present, true); text(value.value) }
    else { assert.equal(value.value, null); if (value.present) assert.equal(value.error, 234); if (value.error === 203) assert.equal(value.present, false) }
  }
  exact(p.legacyRng, ['acquireSuccess', 'acquireError', 'generateSuccess', 'generateError', 'releaseSuccess', 'releaseError'])
  for (const stage of ['acquire', 'generate', 'release']) {
    const success = p.legacyRng[stage + 'Success'], error = p.legacyRng[stage + 'Error']
    if (stage !== 'acquire' && !p.legacyRng.acquireSuccess) { assert.equal(success, null); assert.equal(error, null) }
    else { assert.equal(typeof success, 'boolean'); uint(error); if (success) assert.equal(error, 0); else assert.notEqual(error, 0) }
  }
  exact(p.selfAccess, ['process', 'thread']); exact(p.security, ['process', 'thread'])
  for (const [kind, masks] of [['process', [0x1000, 0x400, 0x410]], ['thread', [0x800, 0x40]]]) {
    assert.ok(Array.isArray(p.selfAccess[kind])); assert.equal(p.selfAccess[kind].length, masks.length)
    p.selfAccess[kind].forEach((cell, i) => { exact(cell, ['access', 'success', 'error']); assert.equal(cell.access, masks[i]); assert.equal(typeof cell.success, 'boolean'); uint(cell.error); if (cell.success) assert.equal(cell.error, 0); else assert.notEqual(cell.error, 0) })
    const descriptor = p.security[kind]; exact(descriptor, ['error', 'sddl']); uint(descriptor.error)
    if (descriptor.error) assert.equal(descriptor.sddl, null)
    else { text(descriptor.sddl); assert.ok(descriptor.sddl.length > 0); assert.match(descriptor.sddl, /^D:/) }
  }
  return p
}
module.exports = { parseProof, ENVIRONMENT }
