'use strict'

// Git reads GIT_CONFIG_GLOBAL before it can apply core.longpaths. Windows NUL
// is addressed through Git's /dev/null mapping, recognized by both mingw_access
// and mingw_open on x64 and ARM64 (uppercase NUL fails the ARM64 access check).
const crypto = require('node:crypto')

const KIND = 'windows-nul-device-v1'
const SCHEMA_VERSION = 1
const HASH = /^[a-f0-9]{64}$/u

function fail(message) {
  const error = new Error(message)
  error.code = 'WINDOWS_GIT_BOOTSTRAP_INVALID'
  throw error
}

function validateEntries(entries) {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 128) {
    fail('Git bootstrap policy must contain a bounded nonempty entry list')
  }
  const normalized = entries.map((entry, index) => {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' ||
        typeof entry[1] !== 'string' || !entry[0] || entry[0].length > 512 ||
        entry[1].length > 8192 || /[\0\r\n]/u.test(entry[0]) || /[\0\r\n]/u.test(entry[1]) ||
        !entry[0].includes('.') || !/^[^\s\0\r\n=]+$/u.test(entry[0])) {
      fail(`Git bootstrap policy entry ${index} is invalid`)
    }
    return Object.freeze([entry[0], entry[1]])
  })
  return Object.freeze(normalized)
}

function policySha256(entries) {
  return crypto.createHash('sha256').update(JSON.stringify(validateEntries(entries))).digest('hex')
}

function createWindowsNulBootstrap(entries) {
  const policy = validateEntries(entries)
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    kind: KIND,
    global: '/dev/null',
    system: '/dev/null',
    policySha256: policySha256(policy),
  })
}

function validateDescriptor(descriptor, entries) {
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor) ||
      Object.keys(descriptor).sort().join('\0') !== ['global', 'kind', 'policySha256', 'schemaVersion', 'system'].join('\0') ||
      descriptor.schemaVersion !== SCHEMA_VERSION || descriptor.kind !== KIND ||
      descriptor.global !== '/dev/null' || descriptor.system !== '/dev/null' ||
      !HASH.test(descriptor.policySha256 || '') || descriptor.policySha256 !== policySha256(entries)) {
    fail('Windows Git bootstrap descriptor is foreign or does not bind the exact policy')
  }
  return Object.freeze({ ...descriptor })
}

function projectWindowsNulBootstrap(descriptor, entries) {
  validateDescriptor(descriptor, entries)
  const policy = validateEntries(entries)
  const environment = {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: String(policy.length),
  }
  policy.forEach(([key, value], index) => {
    environment[`GIT_CONFIG_KEY_${index}`] = key
    environment[`GIT_CONFIG_VALUE_${index}`] = value
  })
  return Object.freeze(environment)
}

function validateWindowsNulBootstrapEnvironment(environment, descriptor, entries) {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
    fail('Windows Git bootstrap environment is invalid')
  }
  const expected = projectWindowsNulBootstrap(descriptor, entries)
  for (const [key, value] of Object.entries(expected)) {
    if (environment[key] !== value) fail(`Windows Git bootstrap environment changed ${key}`)
  }
  for (const key of Object.keys(environment)) {
    const upperKey = key.toUpperCase()
    if (upperKey.startsWith('GIT_CONFIG_') &&
        (key !== upperKey || !Object.prototype.hasOwnProperty.call(expected, key))) {
      fail('Windows Git bootstrap environment contains an unbound policy entry')
    }
  }
  return true
}

module.exports = {
  KIND,
  SCHEMA_VERSION,
  validateEntries,
  policySha256,
  createWindowsNulBootstrap,
  validateDescriptor,
  projectWindowsNulBootstrap,
  validateWindowsNulBootstrapEnvironment,
}
