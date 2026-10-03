'use strict'
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const test = require('node:test')
const { childEnvironment, spawnAndDrain, runWorker } = require('../../scripts/harness-v2-bridge/grok/sandbox-worker.cjs')

const admitted = Object.freeze({
  HOME: '/private/worker/home', GROK_HOME: '/private/worker/grok',
  XDG_CONFIG_HOME: '/private/worker/config', XDG_DATA_HOME: '/private/worker/data',
  XDG_STATE_HOME: '/private/worker/state', XDG_CACHE_HOME: '/private/worker/cache', TMPDIR: '/private/worker/tmp',
  SystemRoot: 'C:\\Windows', AUTOPROMPT_GROK_SYSTEM_PATH: 'C:\\Windows\\System32;C:\\Windows',
  USERPROFILE: 'C:\\private\\profile', APPDATA: 'C:\\private\\profile\\AppData\\Roaming', LOCALAPPDATA: 'C:\\private\\profile\\AppData\\Local', TEMP: 'C:\\private\\temp', TMP: 'C:\\private\\temp',
  OPENROUTER_API_KEY: 'ambient-secret', AUTOPROMPT_GROK_RELAY_TOKEN: 'ambient-control-token',
})

test('Grok sandbox worker projects only admitted platform environment', () => {
  const linux = childEnvironment('linux', admitted)
  assert.deepEqual(linux, { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: admitted.HOME, GROK_HOME: admitted.GROK_HOME,
    XDG_CONFIG_HOME: admitted.XDG_CONFIG_HOME, XDG_DATA_HOME: admitted.XDG_DATA_HOME, XDG_STATE_HOME: admitted.XDG_STATE_HOME, XDG_CACHE_HOME: admitted.XDG_CACHE_HOME, TMPDIR: '/tmp',
    XAI_API_KEY: '', GROK_CODE_XAI_API_KEY: '', GROK_WORKFLOWS: '0', GROK_SUBAGENTS: '0' })
  const darwin = childEnvironment('darwin', admitted)
  assert.equal(darwin.TMPDIR, admitted.TMPDIR)
  const windows = childEnvironment('win32', admitted)
  assert.deepEqual(windows, { SystemRoot: admitted.SystemRoot, PATH: admitted.AUTOPROMPT_GROK_SYSTEM_PATH, HOME: admitted.HOME, GROK_HOME: admitted.GROK_HOME,
    USERPROFILE: admitted.USERPROFILE, APPDATA: admitted.APPDATA, LOCALAPPDATA: admitted.LOCALAPPDATA, TEMP: admitted.TEMP, TMP: admitted.TMP,
    XAI_API_KEY: '', GROK_CODE_XAI_API_KEY: '', GROK_WORKFLOWS: '0', GROK_SUBAGENTS: '0' })
  for (const environment of [linux, darwin, windows]) {
    assert.equal('OPENROUTER_API_KEY' in environment, false)
    assert.equal('AUTOPROMPT_GROK_RELAY_TOKEN' in environment, false)
  }
  assert.throws(() => childEnvironment('win32', { ...admitted, TEMP: '' }), /Missing admitted worker environment TEMP/u)
  assert.throws(() => childEnvironment('freebsd', admitted), /Unsupported Grok worker platform/u)
})

test('Grok sandbox worker drains relay proxy and MCP once when spawn emits error', async () => {
  const child = new EventEmitter(); child.kill = () => { throw new Error('spawn error child must not be killed') }
  const calls = { relay: 0, proxy: 0, mcp: 0 }
  const relay = { close() { calls.relay++ } }
  const proxy = { async close() { calls.proxy++ } }
  const mcp = { async close() { calls.mcp++ } }
  const result = spawnAndDrain({ spawn() { queueMicrotask(() => child.emit('error', Object.assign(new Error('missing executable'), { code: 'ENOENT' }))); return child }, executable: '/bound/grok', args: [], cwd: '/private/cwd', env: {}, relay, proxy, mcp })
  await assert.rejects(result, { code: 'ENOENT' })
  assert.deepEqual(calls, { relay: 1, proxy: 1, mcp: 1 })
})

test('Grok sandbox worker uses the same cleanup for child signal exit', async () => {
  const child = new EventEmitter(); child.kill = () => {}
  const calls = { relay: 0, proxy: 0, mcp: 0 }
  const result = await spawnAndDrain({ spawn() { queueMicrotask(() => child.emit('close', null, 'SIGTERM')); return child }, executable: '/bound/grok', args: [], cwd: '/private/cwd', env: {},
    relay: { close() { calls.relay++ } }, proxy: { async close() { calls.proxy++ } }, mcp: { async close() { calls.mcp++ } } })
  assert.deepEqual(result, { code: null, signal: 'SIGTERM' })
  assert.deepEqual(calls, { relay: 1, proxy: 1, mcp: 1 })
})

test('Grok sandbox worker cleans started servers when admitted environment validation fails', async () => {
  const calls = { listenMcp: 0, listenProxy: 0, spawn: 0, relay: 0, proxy: 0, mcp: 0 }
  const result = runWorker({
    platform: 'win32', environment: { ...admitted, TEMP: '' }, proxyPort: 1234, executable: '/bound/grok', args: [], cwd: '/private/cwd',
    spawn() { calls.spawn++; throw new Error('must not spawn') },
    relay: { close() { calls.relay++ } },
    mcp: { async listen() { calls.listenMcp++ }, async close() { calls.mcp++ } },
    proxy: { async listen() { calls.listenProxy++; return { port: 1234 } }, async close() { calls.proxy++ } },
  })
  await assert.rejects(result, /Missing admitted worker environment TEMP/u)
  assert.deepEqual(calls, { listenMcp: 1, listenProxy: 1, spawn: 0, relay: 1, proxy: 1, mcp: 1 })
})

test('Grok sandbox worker latches cancellation during MCP startup before spawning', async () => {
  let releaseListen, cancelled = false
  const pendingListen = new Promise(resolve => { releaseListen = resolve })
  const calls = { listenProxy: 0, spawn: 0, relay: 0, proxy: 0, mcp: 0 }
  const result = runWorker({
    platform: 'linux', environment: admitted, proxyPort: 1234, executable: '/bound/grok', args: [], cwd: '/private/cwd', isCancelled: () => cancelled,
    spawn() { calls.spawn++; throw new Error('must not spawn') },
    relay: { close() { calls.relay++ } },
    mcp: { listen() { return pendingListen }, async close() { calls.mcp++ } },
    proxy: { async listen() { calls.listenProxy++; return { port: 1234 } }, async close() { calls.proxy++ } },
  })
  cancelled = true; releaseListen()
  await assert.rejects(result, { code: 'CHILD_CANCELLED' })
  assert.deepEqual(calls, { listenProxy: 0, spawn: 0, relay: 1, proxy: 1, mcp: 1 })
})

test('Grok sandbox worker reports cleanup failure after a successful child exit', async () => {
  const child = new EventEmitter(); child.kill = () => {}
  const calls = { relay: 0, proxy: 0, mcp: 0 }
  const result = runWorker({
    platform: 'linux', environment: admitted, proxyPort: 1234, executable: '/bound/grok', args: [], cwd: '/private/cwd',
    spawn() { queueMicrotask(() => child.emit('close', 0, null)); return child },
    relay: { close() { calls.relay++ } },
    mcp: { async listen() {}, async close() { calls.mcp++; throw new Error('mcp close failed') } },
    proxy: { async listen() { return { port: 1234 } }, async close() { calls.proxy++ } },
  })
  await assert.rejects(result, error => error instanceof AggregateError && /cleanup failed/u.test(error.message))
  assert.deepEqual(calls, { relay: 1, proxy: 1, mcp: 1 })
})
