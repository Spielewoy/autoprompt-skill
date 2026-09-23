'use strict'

// A native model receives only this controller-owned MCP server. Its file tools
// enforce the assigned roots, and its command tool uses a separate OS sandbox.
// Native CLI permissions are not used as a substitute for the command sandbox.
const fs = require('node:fs')
const boundary = require('./harness-v2-tool-boundary.cjs')
const { readBound, sha256 } = require('../agents/reasonix/workflow/native.js')

const PROVIDERS = Object.freeze(['claude', 'opencode', 'kilo', 'reasonix', 'prime', 'omp', 'deepseek', 'vscode', 'hermes', 'grok'])
const SERVER = 'autoprompt_owned'
const SUPPORTED = new Set(PROVIDERS)
const NAMES = new Set(boundary.TOOLS.map(tool => tool.name))
const NOT_STARTED_CODES = new Set(['TOOL_PATH_DENIED', 'TOOL_PATH_INVALID'])

function fail(code, message) { throw new boundary.BoundaryError(code, message) }
function toolName(provider, name) {
  if (!SUPPORTED.has(provider) || !NAMES.has(name)) fail('TOOL_DENIED', 'No controlled native tool matches this provider and name')
  return provider === 'claude' || provider === 'reasonix' ? `mcp__${SERVER}__${name}` : `${SERVER}_${name}`
}
function decodeToolName(provider, name) {
  if (typeof name !== 'string' || !SUPPORTED.has(provider)) return null
  for (const tool of NAMES) if (name === toolName(provider, tool)) return tool
  return null
}
function load(prepared, provider) {
  if (!prepared || !SUPPORTED.has(provider)) fail('TOOL_POLICY_INVALID', 'This provider has no controller-owned native tool projection')
  const current = boundary.loadBoundary(prepared.policyPath, prepared.policySha256)
  if (current.policy.provider !== provider || current.root !== prepared.root || current.receiptPath !== prepared.receiptPath) {
    fail('TOOL_POLICY_INVALID', 'Native tool server differs from the controller-owned policy')
  }
  return current
}
function serverSpec(prepared, provider) {
  const current = load(prepared, provider)
  // Construct this locally; do not execute a caller-supplied serverSpec.
  return { command: process.execPath,
    args: [require.resolve('./harness-v2-tool-server.cjs'), '--policy', current.policyPath, '--sha256', current.policySha256],
    env: { ...boundary.safeEnvironment(), HOME: current.root, TMPDIR: current.root } }
}
function claudeProjection(prepared) {
  const server = serverSpec(prepared, 'claude')
  return {
    mcp: { mcpServers: { [SERVER]: { type: 'stdio', ...server } } },
    settings: { disableAllHooks: true, enableAllProjectMcpServers: false,
      permissions: { deny: ['Agent', 'Task', 'Skill', 'Bash', 'Read', 'Glob', 'Grep', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch'] } },
    allowedTools: boundary.TOOLS.map(tool => toolName('claude', tool.name)).join(','),
  }
}
function opencodeProjection(prepared, provider) {
  const server = serverSpec(prepared, provider)
  const permission = { '*': 'deny', ...Object.fromEntries(boundary.TOOLS.map(tool => [toolName(provider, tool.name), 'allow'])) }
  // OpenCode's MCP client otherwise abandons a call after 60 seconds. The
  // owned bash tool permits up to 300 seconds of execution, and Windows must
  // also prepare and restore its private AppContainer resource grants. Keep
  // that bounded lifecycle inside the client deadline; controller cancellation
  // and the command's own timeout continue to govern actual execution.
  const timeout = 600_000
  return { permission,
    mcp: { [SERVER]: { type: 'local', command: [server.command, ...server.args], environment: server.env, enabled: true, timeout } } }
}

function parseResult(output) {
  if (typeof output !== 'string') fail('TOOL_OUTPUT_INCOMPLETE', 'Controlled native tool output must be the exact serialized result')
  let result
  try { result = JSON.parse(output) } catch { fail('TOOL_OUTPUT_INCOMPLETE', 'Native harness did not preserve the controller tool result') }
  if (!result || typeof result !== 'object' || Array.isArray(result) || !NAMES.has(result.tool) ||
      !['completed', 'failed'].includes(result.status) || typeof result.output !== 'string' ||
      !/^[a-f0-9]{64}$/.test(result.outputSha256 || '')) fail('TOOL_OUTPUT_INCOMPLETE', 'Controlled native tool result has an invalid shape')
  const bytes = result.outputBase64 === undefined ? Buffer.from(result.output) : Buffer.from(result.outputBase64, 'base64')
  if (sha256(bytes) !== result.outputSha256 || !Buffer.from(result.output).equals(bytes)) {
    fail('TOOL_OUTPUT_INCOMPLETE', 'Native tool output was changed, truncated, or is not losslessly representable as UTF-8')
  }
  if (result.executionState === 'NOT_STARTED') {
    const expected = result.code === 'TOOL_PATH_DENIED'
      ? 'TOOL_PATH_DENIED: Command cwd is outside the assigned readable roots'
      : result.code === 'TOOL_PATH_INVALID'
        ? 'TOOL_PATH_INVALID: Command cwd must be an existing assigned directory' : null
    if (result.tool !== 'bash' || result.status !== 'failed' || !NOT_STARTED_CODES.has(result.code) ||
        result.exitCode !== null || typeof result.command !== 'string' || !result.command || result.output !== expected ||
        JSON.stringify(Object.keys(result).sort()) !== JSON.stringify(['code', 'command', 'executionState', 'exitCode', 'output', 'outputSha256', 'status', 'tool'])) {
      fail('TOOL_OUTPUT_INCOMPLETE', 'Controlled no-spawn command result has an invalid shape')
    }
    return result
  }
  if (Object.hasOwn(result, 'executionState')) fail('TOOL_OUTPUT_INCOMPLETE', 'Controlled tool execution state is invalid')
  if (result.tool === 'bash' && (typeof result.command !== 'string' ||
      !Number.isInteger(result.exitCode) || result.truncated || result.cancelled || result.timedOut || result.background !== false)) {
    fail('TOOL_OUTPUT_INCOMPLETE', 'Controlled command lacks exact foreground completion evidence')
  }
  return result
}

class ReceiptVerifier {
  constructor(provider, prepared) {
    this.provider = provider
    this.boundary = load(prepared, provider)
    this.consumed = new Set()
  }
  verify(name, args, output, nativeError, expectedReceiptHash) {
    const decoded = decodeToolName(this.provider, name)
    if (!decoded) fail('ROLE_POLICY_DENIED', 'A native built-in or foreign MCP tool escaped the controlled projection')
    const result = parseResult(output)
    if (result.tool !== decoded || nativeError !== undefined && Boolean(nativeError) !== (result.status === 'failed')) {
      fail('TOOL_RECEIPT_INVALID', 'Native tool identity or status disagrees with its controller result')
    }
    const argsHash = sha256(boundary.canonicalJson(args)), resultHash = sha256(boundary.canonicalJson(result))
    if (expectedReceiptHash !== undefined && !/^[a-f0-9]{64}$/.test(expectedReceiptHash || '')) fail('TOOL_RECEIPT_INVALID', 'Native tool result has no exact controller receipt identity')
    const matches = boundary.readReceipts(this.boundary).filter(receipt => !this.consumed.has(receipt.hash) &&
      (expectedReceiptHash === undefined || receipt.hash === expectedReceiptHash) &&
      receipt.tool === decoded && receipt.argsSha256 === argsHash && receipt.resultSha256 === resultHash &&
      receipt.outputSha256 === result.outputSha256 && receipt.status === result.status && receipt.exitCode === (result.exitCode ?? null) &&
      (result.executionState === 'NOT_STARTED' ? receipt.executionState === 'NOT_STARTED' : receipt.executionState === undefined))
    if (!matches.length) fail('TOOL_RECEIPT_INVALID', 'Native tool result has no matching controller-owned execution receipt')
    // Identical repeated calls are legal. Every occurrence consumes one distinct
    // journal entry; no entry can stand in for two native calls.
    this.consumed.add(matches[0].hash)
    return { ...result, receiptHash: matches[0].hash }
  }
  finish() {
    const receipts = boundary.readReceipts(this.boundary)
    if (receipts.length !== this.consumed.size || receipts.some(receipt => !this.consumed.has(receipt.hash))) {
      fail('TOOL_RECEIPT_INVALID', 'Native stream omitted controller tool executions')
    }
    return receipts.map(receipt => receipt.hash)
  }
}

function assertStopped(prepared) {
  // The process owner must drain the server before committing successful work.
  // A remaining lock is intentionally not deleted or treated as stale here.
  if (fs.existsSync(require('node:path').join(prepared.root, 'server.lock'))) {
    fail('PROCESS_DRAIN_TIMEOUT', 'The native tool server has not released its controller-owned lease')
  }
  readBound(prepared.policyPath)
}

module.exports = { PROVIDERS, SERVER, toolName, decodeToolName, load, serverSpec,
  claudeProjection, opencodeProjection, parseResult, ReceiptVerifier, assertStopped }
