'use strict'

const path = require('node:path')
const fs = require('node:fs')
const { writePrivate, sha256 } = require('../agents/reasonix/workflow/native.js')
const { descriptorValid, ensurePrivateDirectory } = require('./harness-v2-bridge/vscode/event-channel.cjs')
function fail(message) { const error = new Error(message); error.code = 'PROFILE_INVALID'; throw error }
function sanitize(source = {}) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) fail('VS Code owned provider needs connection data')
  const result = { provider: 'vscode', environment: {} }
  for (const field of ['model', 'baseUrl', 'apiKeyEnv', 'reasoningEffort']) if (source[field] !== undefined) {
    if (typeof source[field] !== 'string' || !source[field] || /[\r\n\0]/.test(source[field])) fail(`Invalid VS Code ${field}`)
    result[field] = source[field]
  }
  if (source.supportsStructuredOutput !== undefined && typeof source.supportsStructuredOutput !== 'boolean') fail('Invalid VS Code structured-output capability')
  result.supportsStructuredOutput = source.supportsStructuredOutput === true
  result.baseUrl ||= 'https://openrouter.ai/api/v1'
  let url
  try { url = new URL(result.baseUrl) } catch { fail('VS Code provider URL is invalid') }
  if (url.username || url.password || !(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) fail('VS Code provider requires HTTPS or a localhost fixture')
  result.apiKeyEnv ||= 'OPENROUTER_API_KEY'
  if (!['OPENROUTER_API_KEY', 'OPENAI_API_KEY'].includes(result.apiKeyEnv)) fail('VS Code owned provider requires an explicit supported credential name')
  if (result.reasoningEffort && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(result.reasoningEffort)) fail('Invalid VS Code reasoning effort')
  for (const [field, fallback, max] of [['maxTokens', 4096, 32768], ['maxSteps', 32, 128], ['timeoutMs', 120000, 600000]]) {
    const value = source[field] ?? fallback
    if (!Number.isSafeInteger(value) || value < 1 || value > max) fail(`Invalid VS Code ${field}`)
    result[field] = value
  }
  return result
}
function project(options, env) {
  const connection = sanitize(options.connection)
  connection.model = options.model || connection.model
  if (options.effort !== undefined && options.effort !== null) connection.reasoningEffort = require('./harness-v2-native.cjs').validateEffort('vscode', options.effort)
  if (!connection.model) fail('VS Code owned BYOK execution needs an explicit model')
  if (!options.toolBoundary) fail('VS Code owned sessions require the controlled tool boundary')
  if (!descriptorValid(options.vscodeEventChannel)) fail('VS Code owned sessions require an exact private event channel')
  const deepUserDataDir = path.join(options.home, 'user-data')
  const userDataDir = options.vscodeUserDataDir === undefined ? deepUserDataDir : options.vscodeUserDataDir
  if (options.vscodeUserDataDir !== undefined) {
    if (typeof userDataDir !== 'string' || !path.isAbsolute(userDataDir) || userDataDir.includes('\0') ||
        Buffer.byteLength(path.join(userDataDir, '0000-main.sock')) >= 103 ||
        fs.realpathSync.native(userDataDir) !== fs.realpathSync.native(deepUserDataDir)) {
      fail('VS Code IPC alias must address this exact private user-data directory within the socket path limit')
    }
  }
  const request = { version: 1, connection, connectionIdentityBaseUrl: options.providerConnectionIdentity?.baseUrl || connection.baseUrl, sessionRoot: options.sessionRoot, targetPath: options.targetPath,
    prompt: options.prompt, input: options.input, continuationId: options.continuationId || null,
    policyPath: options.toolBoundary.policyPath, policySha256: options.toolBoundary.policySha256,
    eventChannel: options.vscodeEventChannel,
    ...(connection.supportsStructuredOutput && options.outputSchema ? { outputSchema: options.outputSchema } : {}) }
  const file = path.join(options.home, 'owned-session.json')
  const bytes = JSON.stringify(request)
  writePrivate(file, bytes)
  env.AUTOPROMPT_VSCODE_OWNED_REQUEST = file
  env.AUTOPROMPT_VSCODE_OWNED_REQUEST_SHA256 = sha256(bytes)
  // The graphics connection is configuration, not a credential. All extension
  // storage, installed extensions and project discovery remain private.
  for (const name of ['DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'XAUTHORITY']) if (typeof options.environment?.[name] === 'string') env[name] = options.environment[name]
  const settingsRoot = path.join(options.home, 'user-data', 'User')
  fs.mkdirSync(settingsRoot, { recursive: true, mode: 0o700 })
  writePrivate(path.join(settingsRoot, 'settings.json'), JSON.stringify({ 'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false, 'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false }))
  if (options.vscodeUserDataDir !== undefined) {
    // VS Code's additional random IPC sockets use os.tmpdir(). Keep those
    // lexical paths short too, with their bytes in the same private target.
    try { ensurePrivateDirectory(path.join(deepUserDataDir, 't')) } catch { fail('VS Code private temporary directory is unsafe') }
    env.TMPDIR = env.TMP = env.TEMP = path.join(userDataDir, 't')
  }
  return ['--no-sandbox', '--disable-gpu', '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust',
    '--user-data-dir', userDataDir, '--extensions-dir', path.join(options.home, 'extensions'),
    '--extensionDevelopmentPath', path.join(__dirname, 'harness-v2-bridge/vscode'),
    '--extensionTestsPath', path.join(__dirname, 'harness-v2-bridge/vscode/session-driver.cjs')]
}
module.exports = { sanitize, project }
