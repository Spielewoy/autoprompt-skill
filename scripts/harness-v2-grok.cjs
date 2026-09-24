'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const boundary = require('./harness-v2-tool-boundary.cjs')
const { privateDirectory, writePrivate } = require('../agents/reasonix/workflow/native.js')
const { buildGrokInlineMcpClient } = require('./harness-v2-bridge/grok/inline-worker-bundle.cjs')

const PINNED_VERSION = '1.0.13'
// This is the pinned 1.0.13 Chat Completions `ReasoningEffort` enum.  Do not
// accept controller aliases that the native Chat wire cannot serialize.
const EFFORTS = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const OWNED_TOOLS = Object.freeze(['read', 'list', 'search', 'write', 'edit', 'bash'])
// `--system-prompt-override` replaces Grok Build's usual tool guidance.  Keep
// the controller-only restriction and the concise-MCP protocol together: the
// native `search_tool` discovers schemas, while `use_tool` is the sole path
// that can invoke one of those discovered controller tools.
const SYSTEM_PROMPT = 'Use only the configured controller MCP tools. Do not load project instructions, skills, agents, rules, hooks, or plugins. search_tool only discovers the controller-owned MCP catalog and its exact input schemas; it never searches the workspace. To perform a task operation, call use_tool with a tool_name returned by search_tool and a tool_input that exactly matches that returned schema. Before each assignment role performs task work, call search_tool with exactly {"query":"read list search write edit bash","limit":32}; that broad controller-catalog query returns the six owned capability schemas. Then call use_tool only with an exact returned tool_name and its matching tool_input. The fixed returned schemas are read {path,startLine?,lineCount?}; list {path}; search {path,text,maxResults?}; write {path,content}; edit {path,oldText,newText,replaceAll?}; and bash {command,cwd?,timeoutMs?}. Copy only the keys for the selected returned schema; never add query, limit, description, or other wrapper fields to tool_input. Do not call discovered tools directly and do not reuse search_tool query or limit fields as a discovered tool input.'
const fail = message => { throw new Error(`Invalid Grok ${message}`) }
const text = (value, name) => { if (typeof value !== 'string' || !value || value.includes('\0') || /[\r\n]/u.test(value)) fail(name); return value }
const payloadText = (value, name) => { if (typeof value !== 'string' || !value || value.includes('\0') || Buffer.byteLength(value) > 4 * 1024 * 1024) fail(name); return value }
const absolute = (value, name) => { if (!path.isAbsolute(value || '')) fail(name); return value }
const toml = value => JSON.stringify(String(value))
function runtimeProjection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !['win32', 'darwin'].includes(value.platform)) fail('runtime projection')
  const names = value.platform === 'darwin' ? 'mcpPort,nodeExecutable,platform,proxyPort,skillsPath' : 'mcpPort,nodeExecutable,platform,skillsPath'
  if (Object.keys(value).sort().join(',') !== names) fail('runtime projection')
  const absolutePath = value.platform === 'win32' ? path.win32.isAbsolute : path.isAbsolute
  if (!absolutePath(value.nodeExecutable || '') || !absolutePath(value.skillsPath || '')) fail('runtime projection paths')
  if (!Number.isSafeInteger(value.mcpPort) || value.mcpPort < 1024 || value.mcpPort > 65535) fail('runtime MCP port')
  if (value.platform === 'darwin' && (!Number.isSafeInteger(value.proxyPort) || value.proxyPort < 1024 || value.proxyPort > 65535 || value.proxyPort === value.mcpPort)) fail('runtime proxy port')
  return Object.freeze({ platform: value.platform, nodeExecutable: value.nodeExecutable, skillsPath: value.skillsPath, mcpPort: value.mcpPort, ...(value.platform === 'darwin' ? { proxyPort: value.proxyPort } : {}) })
}
function tomlArray(values) { return `[${values.map(toml).join(',')}]` }
function sanitizeConnection(source = {}) {
  if (!source || typeof source !== 'object' || Array.isArray(source) || Object.keys(source).some(key => !['model', 'environment'].includes(key))) fail('connection')
  const result = {}
  if (source.model !== undefined) result.model = text(source.model, 'model')
  if (source.environment !== undefined) {
    if (!source.environment || typeof source.environment !== 'object' || Array.isArray(source.environment) || Object.keys(source.environment).some(key => key !== 'GROK_BASE_URL')) fail('environment')
    if (source.environment.GROK_BASE_URL !== undefined) {
      const baseUrl = text(source.environment.GROK_BASE_URL, 'base URL'); const parsed = new URL(baseUrl)
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) fail('base URL')
      result.environment = { GROK_BASE_URL: baseUrl }
    }
  }
  return result
}
function selectApiKey(baseUrl, credentials) {
  if (credentials === undefined && baseUrl && typeof baseUrl === 'object') { credentials = baseUrl; baseUrl = undefined }
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) fail('credentials')
  let host = ''
  if (baseUrl) { try { host = new URL(baseUrl).hostname.toLowerCase() } catch { fail('base URL') } }
  const order = host.endsWith('openrouter.ai') ? ['OPENROUTER_API_KEY', 'GROK_API_KEY', 'XAI_API_KEY', 'OPENAI_API_KEY']
    : host.endsWith('openai.com') ? ['OPENAI_API_KEY', 'GROK_API_KEY', 'XAI_API_KEY', 'OPENROUTER_API_KEY']
      : ['GROK_API_KEY', 'XAI_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY']
  for (const key of order) if (typeof credentials[key] === 'string' && credentials[key]) return credentials[key]
  return null
}
function upstreamChatCompletionsUrl(baseUrl) {
  const parsed = new URL(text(baseUrl, 'base URL'))
  const normalizedPath = parsed.pathname.replace(/\/+$/u, '')
  if (!normalizedPath.endsWith('/chat/completions')) parsed.pathname = `${normalizedPath}/chat/completions`
  return parsed.toString()
}
function configText({ model, baseUrl, proxyToken, effort, maxCompletionTokens, runtimeProjection: projection }) {
  if (maxCompletionTokens !== undefined && (!Number.isSafeInteger(maxCompletionTokens) || maxCompletionTokens <= 0)) fail('max completion tokens')
  const projected = projection === undefined ? null : runtimeProjection(projection)
  const mcp = projected ? buildGrokInlineMcpClient({ nodeExecutable: projected.nodeExecutable, port: projected.mcpPort, host: projected.platform === 'darwin' ? '::1' : '127.0.0.1', platform: projected.platform }) : null
  const skillsPath = projected ? projected.skillsPath : '/autoprompt/session/skills'
  const command = projected ? mcp.executable : '/usr/bin/node'
  const args = projected ? mcp.argv : ['/opt/autoprompt-grok/mcp-loopback.cjs', '--port', '19778']
  return `[cli]\nauto_update=false\nuse_leader=false\n[model.${JSON.stringify(model)}]\nmodel=${toml(model)}\nbase_url=${toml(baseUrl)}\napi_key=${toml(proxyToken)}\napi_backend="chat_completions"\ncontext_window=32768\n${effort ? `reasoning_effort=${toml(effort)}\n` : ''}[model.${JSON.stringify(model)}.laziness_detector]\nenabled=false\n[models]\ndefault_reasoning_effort=${toml(effort || 'none')}\n${maxCompletionTokens ? `max_completion_tokens=${maxCompletionTokens}\n` : ''}[features]\n# Background summaries and speculative compaction are outside native terminal usage.\n# Disable them so every authenticated upstream request belongs to the owned execution ledger.\nturn_summary=false\ntitle_refresh=false\ntwo_pass_compaction=false\nsession_recap=false\nauto_wake=false\n[memory]\nenabled=false\n[workflows]\nenabled=false\n[skills]\npaths=${tomlArray([skillsPath])}\nignore=["*"]\ndisabled=["*"]\n[plugins]\npaths=[]\ndisabled=["*"]\n[compat.claude]\nskills=false\nrules=false\nagents=false\nmcps=false\nhooks=false\nsessions=false\n[compat.cursor]\nskills=false\nrules=false\nagents=false\nmcps=false\nhooks=false\nsessions=false\n[mcp_servers.autoprompt_owned]\ncommand=${toml(command)}\nargs=${tomlArray(args)}\nenabled=true\n`
}
function prepare(options = {}) {
  const { sessionHome, toolBoundary, executable, model, baseUrl, proxyToken, prompt, input, continuationId, effort } = options
  for (const [name, value] of Object.entries({ sessionHome, executable })) absolute(value, name)
  text(model, 'model'); text(baseUrl, 'base URL'); text(proxyToken, 'proxy token'); payloadText(prompt, 'role prompt'); payloadText(input, 'canonical input')
  if (continuationId !== undefined && !/^[A-Za-z0-9_.:-]{1,256}$/u.test(continuationId)) fail('continuation identity')
  if (effort !== undefined && !EFFORTS.includes(effort)) fail('reasoning effort')
  const current = boundary.loadBoundary(toolBoundary.policyPath, toolBoundary.policySha256)
  if (current.policy.provider !== 'grok') fail('tool policy provider')
  privateDirectory(sessionHome)
  for (const directory of ['config', 'data', 'state', 'cache', 'skills']) privateDirectory(path.join(sessionHome, directory))
  const config = path.join(sessionHome, 'config.toml')
  const configContents = configText({ model, baseUrl, proxyToken, effort, maxCompletionTokens: options.maxCompletionTokens, runtimeProjection: options.runtimeProjection })
  if (fs.existsSync(config)) {
    // Grok 1.0.13 appends this one marketplace migration marker after its
    // first start. It does not alter a model or executable setting; any other
    // persistent mutation remains a fail-closed configuration replacement.
    const marketplaceMigration = '\n[marketplace]\ndefault_skills_installs_purged = true\n'
    const actual = fs.lstatSync(config).isFile() ? fs.readFileSync(config, 'utf8') : ''
    if (actual !== configContents && actual !== `${configContents}${marketplaceMigration}`) fail('persistent config changed')
  } else writePrivate(config, configContents)
  const payload = `${prompt}\n\n${input}`
  // Grok normally folds project AGENTS.md files into its system prompt. The
  // native override replaces that prompt, and verbatim mode preserves the
  // controller-authenticated payload without implicit project instructions.
  // The native CLI retains an explicitly selected streaming-json format when
  // --json-schema is present (it only upgrades the default plain format).  Its
  // authoritative ACP end event then carries structuredOutput, so the
  // controller never has to recover a result from assistant prose.
  if (!options.outputSchema || typeof options.outputSchema !== 'object' || Array.isArray(options.outputSchema) || Buffer.byteLength(JSON.stringify(options.outputSchema)) > 1024 * 1024) fail('invalid canonical output schema')
  const argv = ['--no-alt-screen', '--verbatim', '--no-subagents', '--system-prompt-override', SYSTEM_PROMPT, '-p', payload, '--output-format', 'streaming-json', '--json-schema', JSON.stringify(options.outputSchema), '--always-approve', '-m', model, '--tools', 'run_terminal_command']
  if (continuationId) argv.push('--resume', continuationId)
  return { executable, argv, configPath: config, sessionHome, model, effort: effort || null, receiptPath: current.receiptPath, payloadSha256: crypto.createHash('sha256').update(payload).digest('hex'), allowedMcpTools: Object.fromEntries(OWNED_TOOLS.map(name => [`autoprompt_owned__${name}`, name])) }
}
module.exports = { PINNED_VERSION, EFFORTS, OWNED_TOOLS, SYSTEM_PROMPT, sanitizeConnection, selectApiKey, upstreamChatCompletionsUrl, configText, prepare, runtimeProjection }
