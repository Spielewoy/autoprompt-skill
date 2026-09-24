'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const {
  DarwinGrokProfileError,
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
