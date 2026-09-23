'use strict'

const cp = require('node:child_process')
const fs = require('node:fs')
const { createModelProxy } = require('./model-proxy.cjs')
const { createPreconnectedRelayClient } = require('./unix-relay.cjs')
const { createMcpLoopbackServer } = require('./mcp-loopback.cjs')
const { validateArguments } = require('./tool-schema.cjs')

const value = name => {
  const result = process.env[name]
  if (typeof result !== 'string' || !result) throw new Error(`Missing ${name}`)
  return result
}
const allowedMcpTools = () => {
  const raw = JSON.parse(value('AUTOPROMPT_GROK_ALLOWED_MCP_TOOLS'))
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Object.keys(raw).length) throw new Error('Owned MCP policy is invalid')
  return Object.fromEntries(Object.entries(raw).map(([qualifiedName, toolName]) => {
    if (typeof qualifiedName !== 'string' || !qualifiedName || typeof toolName !== 'string' || !toolName) throw new Error('Owned MCP policy is invalid')
    // Reuse the controller tool boundary's exact closed schemas. This admits
    // optional fields and their bounds as defined by the receipt-producing
    // server, rather than duplicating a weaker Grok-side schema.
    return [qualifiedName, input => validateArguments(toolName, input)]
  }))
}
const issuedCalls = () => {
  const raw = process.env.AUTOPROMPT_GROK_ISSUED_CALLS || '[]'
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed) || Buffer.byteLength(raw) > 4 * 1024 * 1024) throw new Error('Issued call history is invalid')
  return parsed
}
const admitted = (environment, name) => {
  const result = environment?.[name]
  if (typeof result !== 'string' || !result) throw new Error(`Missing admitted worker environment ${name}`)
  return result
}
function childEnvironment(platform, environment) {
  const base = {
    HOME: admitted(environment, 'HOME'), GROK_HOME: admitted(environment, 'GROK_HOME'),
    XAI_API_KEY: '', GROK_CODE_XAI_API_KEY: '', GROK_WORKFLOWS: '0', GROK_SUBAGENTS: '0',
  }
  if (platform === 'linux') return {
    PATH: '/usr/local/bin:/usr/bin:/bin', ...base,
    XDG_CONFIG_HOME: admitted(environment, 'XDG_CONFIG_HOME'), XDG_DATA_HOME: admitted(environment, 'XDG_DATA_HOME'),
    XDG_STATE_HOME: admitted(environment, 'XDG_STATE_HOME'), XDG_CACHE_HOME: admitted(environment, 'XDG_CACHE_HOME'), TMPDIR: '/tmp',
  }
  if (platform === 'darwin') return {
    PATH: '/usr/local/bin:/usr/bin:/bin', ...base,
    XDG_CONFIG_HOME: admitted(environment, 'XDG_CONFIG_HOME'), XDG_DATA_HOME: admitted(environment, 'XDG_DATA_HOME'),
    XDG_STATE_HOME: admitted(environment, 'XDG_STATE_HOME'), XDG_CACHE_HOME: admitted(environment, 'XDG_CACHE_HOME'), TMPDIR: admitted(environment, 'TMPDIR'),
  }
  if (platform === 'win32') return {
    SystemRoot: admitted(environment, 'SystemRoot'), PATH: admitted(environment, 'AUTOPROMPT_GROK_SYSTEM_PATH'), ...base,
    USERPROFILE: admitted(environment, 'USERPROFILE'), APPDATA: admitted(environment, 'APPDATA'), LOCALAPPDATA: admitted(environment, 'LOCALAPPDATA'),
    TEMP: admitted(environment, 'TEMP'), TMP: admitted(environment, 'TMP'),
  }
  throw new Error(`Unsupported Grok worker platform ${platform}`)
}
function resourceCleanup(options) {
  let cleanupPromise, child = options.child
  const cleanup = async terminate => {
    if (cleanupPromise) return cleanupPromise
    cleanupPromise = (async () => {
      const failures = []
      if (terminate && child) { try { child.kill('SIGTERM') } catch (error) { failures.push(error) } }
      if (options.relay?.close) { try { options.relay.close() } catch (error) { failures.push(error) } }
      const results = await Promise.allSettled([
        Promise.resolve().then(() => options.proxy?.close?.()),
        Promise.resolve().then(() => options.mcp?.close?.()),
      ])
      for (const result of results) if (result.status === 'rejected') failures.push(result.reason)
      if (failures.length) throw new AggregateError(failures, 'Grok sandbox worker cleanup failed')
    })()
    return cleanupPromise
  }
  cleanup.setChild = value => { child = value }
  return cleanup
}
const preservePrimaryFailure = async (primary, cleanup) => {
  try { await cleanup(false) } catch (cleanupError) {
    if (!primary) throw cleanupError
    try { Object.defineProperty(primary, 'cleanupFailure', { value: cleanupError, enumerable: false }) } catch {}
  }
  if (primary) throw primary
}
async function spawnAndDrain(options) {
  let child
  const cleanup = options.cleanup || resourceCleanup({ ...options, get child() { return child } })
  try {
    child = options.spawn(options.executable, options.args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'inherit', 'inherit'], shell: false })
    cleanup.setChild?.(child)
  } catch (error) {
    await preservePrimaryFailure(error, cleanup)
  }
  options.onChild?.(child, () => cleanup(true))
  const status = await new Promise(resolve => {
    let settled = false
    const finish = value => { if (!settled) { settled = true; resolve(value) } }
    child.once('error', error => finish({ error }))
    child.once('close', (code, signal) => finish({ code, signal }))
  })
  await preservePrimaryFailure(status.error, cleanup)
  return status
}
async function runWorker(options) {
  let child
  const cleanup = options.cleanup || resourceCleanup({ ...options, get child() { return child } })
  let primary = null
  try {
    await options.mcp.listen()
    if (options.isCancelled?.()) { const error = new Error('Grok sandbox worker was cancelled before child spawn'); error.code = 'CHILD_CANCELLED'; throw error }
    const address = await options.proxy.listen(options.proxyPort, '127.0.0.1')
    if (!address || typeof address === 'string') throw new Error('Proxy did not bind a TCP endpoint')
    if (options.isCancelled?.()) { const error = new Error('Grok sandbox worker was cancelled before child spawn'); error.code = 'CHILD_CANCELLED'; throw error }
    const status = await spawnAndDrain({ ...options, env: childEnvironment(options.platform, options.environment), cleanup,
      onChild: (owned, terminate) => { child = owned; options.onChild?.(owned, terminate) } })
    return status
  } catch (error) {
    primary = error
    throw error
  } finally {
    await preservePrimaryFailure(primary, cleanup)
  }
}
async function main() {
  let relay, mcp, proxy, stop, primary = null, stopped = false, cancellationRequested = false
  const cleanup = resourceCleanup({ get relay() { return relay }, get mcp() { return mcp }, get proxy() { return proxy } })
  const onSignal = () => { cancellationRequested = true; void Promise.resolve(stop?.()).catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1 }) }
  process.once('SIGTERM', onSignal); process.once('SIGINT', onSignal)
  try {
    const auditPath = process.env.AUTOPROMPT_GROK_AUDIT_PATH
    relay = createPreconnectedRelayClient({ fd: Number(value('AUTOPROMPT_GROK_RELAY_FD')), relayToken: value('AUTOPROMPT_GROK_RELAY_TOKEN') })
    mcp = createMcpLoopbackServer({ port: Number(value('AUTOPROMPT_GROK_MCP_PORT')), forward: async line => relay.mcp({ line }) })
    proxy = createModelProxy({
      upstreamUrl: 'relay://controller/v1/chat/completions',
      upstreamAuthorization: `Bearer ${value('AUTOPROMPT_GROK_RELAY_TOKEN')}`,
      childToken: value('AUTOPROMPT_GROK_PROXY_TOKEN'), model: value('AUTOPROMPT_GROK_MODEL'),
      allowedMcpTools: allowedMcpTools(), issuedCalls: issuedCalls(), requireNativeRequestIdentity: true, fetchImpl: relay.fetch,
      onAudit: auditPath ? entry => fs.appendFileSync(auditPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 }) : undefined,
    })
    const args = process.argv.slice(2).filter(arg => arg !== '--')
    const status = await runWorker({
      spawn: cp.spawn, executable: value('AUTOPROMPT_GROK_EXECUTABLE'), args, cwd: value('AUTOPROMPT_GROK_CWD'),
      platform: process.platform, environment: process.env, proxyPort: Number(value('AUTOPROMPT_GROK_PROXY_PORT')), relay, proxy, mcp, cleanup,
      isCancelled: () => cancellationRequested,
      onChild: (_child, terminate) => { stop = async () => { stopped = true; await terminate() } },
    })
    process.exitCode = stopped ? 143 : status.code === 0 && !status.signal ? 0 : 1
  } catch (error) {
    primary = error
    throw error
  } finally {
    process.removeListener('SIGTERM', onSignal); process.removeListener('SIGINT', onSignal)
    await preservePrimaryFailure(primary, cleanup)
  }
}
if (require.main === module) main().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1 })

module.exports = { allowedMcpTools, issuedCalls, childEnvironment, resourceCleanup, spawnAndDrain, runWorker, main }
