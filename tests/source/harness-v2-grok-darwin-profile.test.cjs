'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const {
  DarwinGrokProfileError,
  SYSTEM_CONFIG_METADATA_PATHS,
  buildDarwinGrokProfile,
  validateProfileInput,
} = require('../../scripts/harness-v2-bridge/grok/darwin-profile.cjs')

const input = () => ({
  nodeExecutable: '/opt/autoprompt/runtime/node',
  grokExecutable: '/opt/autoprompt/grok/grok',
  home: '/private/ap/home',
  cwd: '/private/ap/work',
  scratch: '/private/ap/scratch',
  proxyPort: 19777,
  mcpPort: 19778,
})

test('Darwin Grok Seatbelt profile is default-deny, exact-path, and IPv6 loopback-only', () => {
  const profile = buildDarwinGrokProfile(input())
  assert.match(profile, /^\(version 1\)\n\(deny default\)/)
  for (const executable of ['/opt/autoprompt/runtime/node', '/opt/autoprompt/grok/grok']) {
    assert.match(profile, new RegExp(`\\(allow process-exec \\(literal ${JSON.stringify(executable).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)\\)`))
  }
  for (const root of ['/private/ap/home', '/private/ap/work', '/private/ap/scratch']) {
    assert.match(profile, new RegExp(`file-write\\* \\(subpath ${JSON.stringify(root).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`))
  }
  for (const port of [19777, 19778]) {
    assert.match(profile, new RegExp(`network-outbound \\(remote tcp6 "localhost:${port}"\\)`))
    assert.match(profile, new RegExp(`network-inbound \\(local tcp6 "localhost:${port}"\\)`))
  }
  assert.doesNotMatch(profile, /tcp4|127\.0\.0\.1|::ffff|network-outbound \(remote ip|network-inbound \(local ip/)
  assert.doesNotMatch(profile, /subpath "\/opt\/autoprompt"|subpath "\/private\/ap"|launchctl|file-write\* \(subpath "\/System"/)
})

test('Darwin Grok profile permits only metadata for exact system config absence probes', () => {
  const profile = buildDarwinGrokProfile(input())
  const lines = profile.split('\n')
  assert.deepEqual(SYSTEM_CONFIG_METADATA_PATHS, [
    '/etc',
    '/etc/grok',
    '/etc/grok/managed_config.toml',
    '/etc/grok/requirements.toml',
    '/private/etc',
    '/private/etc/grok',
    '/private/etc/grok/managed_config.toml',
    '/private/etc/grok/requirements.toml',
  ])
  for (const candidate of SYSTEM_CONFIG_METADATA_PATHS) {
    assert.equal(lines.filter(line => line === `(allow file-read-metadata (literal ${JSON.stringify(candidate)}))`).length, 1)
  }
  for (const line of lines.filter(line => /"\/(?:private\/)?etc(?:\/|"\))/.test(line))) {
    assert.match(line, /^\(allow file-read-metadata \(literal /)
    assert.doesNotMatch(line, /file-read-data|file-read\*|subpath/)
  }
  assert.doesNotMatch(profile, /GlobalPreferences|CFUserTextEncoding|file-read\* \((?:literal|subpath) "\/(?:private\/)?etc/)
})

test('Darwin Grok profile admits the /var metadata alias only for physical /private/var inputs', () => {
  assert.doesNotMatch(buildDarwinGrokProfile(input()), /^\(allow file-read-metadata \(literal "\/var"\)\)$/m)
  const value = input()
  value.nodeExecutable = '/private/var/folders/ap/runtime/node'
  value.grokExecutable = '/private/var/folders/ap/runtime/grok'
  value.home = '/private/var/folders/ap/home'
  value.cwd = '/private/var/folders/ap/work'
  value.scratch = '/private/var/folders/ap/scratch'
  const profile = buildDarwinGrokProfile(value)
  assert.match(profile, /^\(allow file-read-metadata \(literal "\/var"\)\)$/m)
  assert.doesNotMatch(profile, /file-read(?:-data|\*) .*"\/var"|file-read-metadata \(subpath "\/var"/)
})

test('Darwin Grok profile rejects path ambiguity, writable executable roots, and non-exact listeners', () => {
  for (const mutate of [
    value => { value.home = '/private/ap/../ap/home' },
    value => { value.cwd = '/private/ap/home/nested' },
    value => { value.nodeExecutable = '/private/ap/home/node' },
    value => { value.grokExecutable = value.nodeExecutable },
    value => { value.proxyPort = 1023 },
    value => { value.mcpPort = 19777 },
    value => { value.extra = true },
  ]) {
    const value = input(); mutate(value)
    assert.throws(() => validateProfileInput(value), DarwinGrokProfileError)
  }
})
