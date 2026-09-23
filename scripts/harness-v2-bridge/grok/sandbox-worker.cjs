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
async function main() {
  const auditPath = process.env.AUTOPROMPT_GROK_AUDIT_PATH
  const relay = createPreconnectedRelayClient({ fd: Number(value('AUTOPROMPT_GROK_RELAY_FD')), relayToken: value('AUTOPROMPT_GROK_RELAY_TOKEN') })
  const mcp = createMcpLoopbackServer({ port: Number(value('AUTOPROMPT_GROK_MCP_PORT')), forward: async line => relay.mcp({ line }) })
  await mcp.listen()
  const proxy = createModelProxy({
    upstreamUrl: 'relay://controller/v1/chat/completions',
    upstreamAuthorization: `Bearer ${value('AUTOPROMPT_GROK_RELAY_TOKEN')}`,
    childToken: value('AUTOPROMPT_GROK_PROXY_TOKEN'),
    model: value('AUTOPROMPT_GROK_MODEL'),
    allowedMcpTools: allowedMcpTools(),
    issuedCalls: issuedCalls(),
    requireNativeRequestIdentity: true,
    fetchImpl: relay.fetch,
    onAudit: auditPath ? entry => fs.appendFileSync(auditPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 }) : undefined,
  })
  const address = await proxy.listen(Number(value('AUTOPROMPT_GROK_PROXY_PORT')), '127.0.0.1')
  if (!address || typeof address === 'string') throw new Error('Proxy did not bind a TCP endpoint')
  const args = process.argv.slice(2).filter(arg => arg !== '--')
  const childEnvironment = {
    PATH: '/usr/local/bin:/usr/bin:/bin', HOME: value('HOME'), GROK_HOME: value('GROK_HOME'),
    XDG_CONFIG_HOME: value('XDG_CONFIG_HOME'), XDG_DATA_HOME: value('XDG_DATA_HOME'), XDG_STATE_HOME: value('XDG_STATE_HOME'), XDG_CACHE_HOME: value('XDG_CACHE_HOME'), TMPDIR: '/tmp',
    XAI_API_KEY: '', GROK_CODE_XAI_API_KEY: '', GROK_WORKFLOWS: '0', GROK_SUBAGENTS: '0',
  }
  const child = cp.spawn(value('AUTOPROMPT_GROK_EXECUTABLE'), args, { cwd: value('AUTOPROMPT_GROK_CWD'), env: childEnvironment, stdio: ['ignore', 'inherit', 'inherit'], shell: false })
  const stop = async () => { child.kill('SIGTERM'); relay.close(); await Promise.all([proxy.close(), mcp.close()]); process.exitCode = 143 }
  process.once('SIGTERM', stop); process.once('SIGINT', stop)
  const status = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
  relay.close(); await Promise.all([proxy.close(), mcp.close()]); process.exitCode = status.code === 0 && !status.signal ? 0 : 1
}
if (require.main === module) main().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1 })

module.exports = { allowedMcpTools, issuedCalls, main }
