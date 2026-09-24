'use strict'

// This module only renders a fixed Seatbelt policy from already authenticated,
// physical paths. The caller owns no-follow identity validation and snapshots.
const path = require('node:path')
const {
  NODE_STARTUP_MACH_SERVICES,
  NODE_STARTUP_SYSCTLS,
} = require('../../darwin-command-sandbox.cjs')

const PATH_FIELDS = Object.freeze(['nodeExecutable', 'grokExecutable', 'home', 'cwd', 'scratch'])
const PRIVATE_ROOT_FIELDS = Object.freeze(['home', 'cwd', 'scratch'])

class DarwinGrokProfileError extends Error {
  constructor(message) { super(message); this.name = 'DarwinGrokProfileError'; this.code = 'GROK_DARWIN_PROFILE_INVALID' }
}

const fail = message => { throw new DarwinGrokProfileError(message) }
const quoted = value => JSON.stringify(value)

function physicalAbsolutePath(value, field) {
  if (typeof value !== 'string' || !value || value.includes('\0') || /[\r\n]/u.test(value) ||
      !path.posix.isAbsolute(value) || path.posix.normalize(value) !== value || value === '/') {
    fail(`${field} must be an exact non-root absolute physical path`)
  }
  return value
}

function exactPort(value, field) {
  if (!Number.isSafeInteger(value) || value < 1024 || value > 65535) fail(`${field} must be an unprivileged TCP port`)
  return value
}

function isNested(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

function pathAncestors(value) {
  const values = []
  for (let current = value; current !== '/'; current = path.posix.dirname(current)) values.push(current)
  values.push('/')
  return values
}

function validateProfileInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join(',') !==
      'cwd,grokExecutable,home,mcpPort,nodeExecutable,proxyPort,scratch') {
    fail('profile input must have the exact Grok Darwin profile shape')
  }
  const value = {}
  for (const field of PATH_FIELDS) value[field] = physicalAbsolutePath(input[field], field)
  for (let index = 0; index < PRIVATE_ROOT_FIELDS.length; index += 1) {
    for (let other = index + 1; other < PRIVATE_ROOT_FIELDS.length; other += 1) {
      if (isNested(value[PRIVATE_ROOT_FIELDS[index]], value[PRIVATE_ROOT_FIELDS[other]])) {
        fail('home, cwd, and scratch must be disjoint private roots')
      }
    }
  }
  for (const executable of ['nodeExecutable', 'grokExecutable']) {
    for (const root of PRIVATE_ROOT_FIELDS) {
      if (value[executable] === value[root] || value[executable].startsWith(`${value[root]}/`)) {
        fail(`${executable} must not be supplied from a writable private root`)
      }
    }
  }
  if (value.nodeExecutable === value.grokExecutable) fail('Node and Grok executables must be distinct exact files')
  value.proxyPort = exactPort(input.proxyPort, 'proxyPort')
  value.mcpPort = exactPort(input.mcpPort, 'mcpPort')
  if (value.proxyPort === value.mcpPort) fail('proxyPort and mcpPort must be distinct')
  return Object.freeze(value)
}

function buildDarwinGrokProfile(input) {
  const value = validateProfileInput(input)
  const privateRoots = PRIVATE_ROOT_FIELDS.map(field => value[field])
  const metadata = new Set([
    ...PATH_FIELDS.flatMap(field => pathAncestors(value[field])),
    ...privateRoots.flatMap(pathAncestors),
  ])
  const loopbackPorts = [value.proxyPort, value.mcpPort]
  const lines = [
    '(version 1)',
    '(deny default)',
    ...[...metadata].sort().map(item => `(allow file-read-metadata (literal ${quoted(item)}))`),
    // dyld opens the root vnode while loading the shared cache. This does not
    // grant descendant contents outside the explicit rules below.
    '(allow file-read-data (literal "/"))',
    `(allow process-exec (literal ${quoted(value.nodeExecutable)}))`,
    `(allow file-read* (literal ${quoted(value.nodeExecutable)}))`,
    `(allow process-exec (literal ${quoted(value.grokExecutable)}))`,
    `(allow file-read* (literal ${quoted(value.grokExecutable)}))`,
    '(allow process-fork)',
    '(allow process-info* (target same-sandbox))',
    '(allow signal (target same-sandbox))',
    '(allow mach-priv-task-port (target same-sandbox))',
    '(allow sysctl-read', ...NODE_STARTUP_SYSCTLS.map(name => `  (sysctl-name ${quoted(name)})`), ')',
    '(allow mach-lookup', ...NODE_STARTUP_MACH_SERVICES.map(name => `  (global-name ${quoted(name)})`), ')',
    '(allow file-read* (subpath "/System"))',
    '(allow file-read* (subpath "/usr/lib"))',
    '(allow file-read* (subpath "/usr/share"))',
    '(allow file-read* (literal "/dev/null"))',
    '(allow file-read* (literal "/dev/urandom"))',
    ...privateRoots.flatMap(root => [
      `(allow file-read* file-write* (subpath ${quoted(root)}))`,
    ]),
    '(deny file-write* (regex #"/[.]git(/|$)"))',
    // `tcp6 localhost:port` is the exact syntax accepted by the native IPv6
    // Seatbelt diagnostic. The inbound clauses are intentionally equally
    // narrow, for the already-opened FD3/FD4 listeners only.
    ...loopbackPorts.map(port => `(allow network-outbound (remote tcp6 ${quoted(`localhost:${port}`)}))`),
    ...loopbackPorts.map(port => `(allow network-inbound (local tcp6 ${quoted(`localhost:${port}`)}))`),
  ]
  return `${lines.join('\n')}\n`
}

module.exports = { DarwinGrokProfileError, validateProfileInput, buildDarwinGrokProfile }
