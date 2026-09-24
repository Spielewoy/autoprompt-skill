'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const MODULE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*\.cjs$/u
const GROK_MODULES = Object.freeze(['sandbox-worker.cjs', 'model-proxy.cjs', 'unix-relay.cjs', 'mcp-loopback.cjs', 'tool-schema.cjs'])
const GROK_BUILTINS = Object.freeze(['node:child_process', 'node:crypto', 'node:fs', 'node:http', 'node:net', 'node:path', 'node:string_decoder'])
const GROK_MCP_MODULES = Object.freeze(['mcp-loopback.cjs'])
const GROK_MCP_BUILTINS = Object.freeze(['node:net', 'node:string_decoder'])
const WINDOWS_SAFE_COMMAND_LINE_UNITS = 30000

class GrokInlineBundleError extends Error {
  constructor(code, message) { super(message); this.name = 'GrokInlineBundleError'; this.code = code }
}
const fail = (code, message) => { throw new GrokInlineBundleError(code, message) }
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')

function validateModules(modules, entry, allowedBuiltins) {
  if (!modules || typeof modules !== 'object' || Array.isArray(modules)) fail('GROK_INLINE_BUNDLE_INVALID', 'Inline module map is invalid')
  const ids = Object.keys(modules).sort()
  if (!ids.length || ids.some(id => !MODULE_ID.test(id)) || !ids.includes(entry)) fail('GROK_INLINE_BUNDLE_INVALID', 'Inline module identity is invalid')
  const builtins = new Set(allowedBuiltins)
  if (builtins.size !== allowedBuiltins.length || allowedBuiltins.some(name => typeof name !== 'string' || !name.startsWith('node:'))) fail('GROK_INLINE_BUNDLE_INVALID', 'Inline builtin policy is invalid')
  for (const id of ids) {
    const source = modules[id]
    if (typeof source !== 'string' || !source || Buffer.byteLength(source) > 1024 * 1024 || source.includes('\0')) fail('GROK_INLINE_BUNDLE_INVALID', 'Inline module source is invalid')
  }
  return ids
}

function quoteWindowsArgument(value) {
  if (typeof value !== 'string' || value.includes('\0')) fail('GROK_INLINE_BUNDLE_INVALID', 'Inline command argument is invalid')
  if (value && !/[\s"]/u.test(value)) return value
  let result = '"', slashes = 0
  for (const character of value) {
    if (character === '\\') { slashes++; continue }
    if (character === '"') result += '\\'.repeat(slashes * 2 + 1) + '"'
    else result += '\\'.repeat(slashes) + character
    slashes = 0
  }
  return result + '\\'.repeat(slashes * 2) + '"'
}

function windowsCommandLineUnits(executable, argv) {
  const command = [executable, ...argv].map(quoteWindowsArgument).join(' ')
  return command.length + 1 // terminating UTF-16 NUL
}

function buildClosedCommonJsBundle(options = {}) {
  const entry = options.entry
  const allowedBuiltins = [...(options.allowedBuiltins || [])].sort()
  const ids = validateModules(options.modules, entry, allowedBuiltins)
  const ordered = Object.fromEntries(ids.map(id => [id, options.modules[id]]))
  const body = Buffer.from(JSON.stringify({ schemaVersion: 1, entry, allowedBuiltins, modules: ordered }), 'utf8')
  const compressed = zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } })
  const encoded = compressed.toString('base64')
  const bootstrap = `'use strict';const z=require('node:zlib');const p=JSON.parse(z.brotliDecompressSync(Buffer.from('${encoded}','base64')).toString('utf8'));if(!p||p.schemaVersion!==1)throw new Error('Invalid inline bundle');const b=new Set(p.allowedBuiltins),c=Object.create(null);let main=null;function load(id,isMain=false){if(c[id])return c[id].exports;if(!Object.hasOwn(p.modules,id))throw new Error('Unknown inline module');const m={id,exports:{},loaded:false,filename:(process.platform==='win32'?'C:\\\\autoprompt-inline\\\\grok\\\\':'/autoprompt-inline/grok/')+id};c[id]=m;if(isMain)main=m;function r(q){if(b.has(q))return require(q);if(typeof q!=='string'||!q.startsWith('./'))throw new Error('Denied inline require');const t=q.slice(2);if(!/^[A-Za-z0-9][A-Za-z0-9._-]*\\.cjs$/.test(t)||t.includes('/')||!Object.hasOwn(p.modules,t))throw new Error('Denied inline require');return load(t)}Object.defineProperty(r,'main',{get:()=>main});new Function('exports','require','module','__filename','__dirname',p.modules[id])(m.exports,r,m,m.filename,m.filename.slice(0,m.filename.lastIndexOf(process.platform==='win32'?'\\\\':'/')));m.loaded=true;return m.exports}load(p.entry,true);`
  return Object.freeze({
    schemaVersion: 1, entry, bootstrap, payloadSha256: sha256(body),
    moduleSha256: Object.freeze(Object.fromEntries(ids.map(id => [id, sha256(Buffer.from(ordered[id], 'utf8'))]))),
  })
}

function buildGrokInlineWorker(options = {}) {
  const nodeExecutable = options.nodeExecutable
  const nodeArgs = options.nodeArgs || [], workerArgs = options.workerArgs || []
  if (typeof nodeExecutable !== 'string' || !path.isAbsolute(nodeExecutable) || !Array.isArray(nodeArgs) || !Array.isArray(workerArgs)) fail('GROK_INLINE_BUNDLE_INVALID', 'Inline worker command is invalid')
  if (nodeArgs.some(argument => !['--no-warnings', '--unhandled-rejections=strict'].includes(argument))) fail('GROK_INLINE_BUNDLE_INVALID', 'Inline worker Node argument is not admitted')
  const modules = Object.fromEntries(GROK_MODULES.map(id => [id, fs.readFileSync(path.join(__dirname, id), 'utf8')]))
  const bundle = buildClosedCommonJsBundle({ modules, entry: 'sandbox-worker.cjs', allowedBuiltins: GROK_BUILTINS })
  // The sentinel occupies Node's script-name argv slot under `-e`, preserving
  // sandbox-worker's normal process.argv.slice(2) behavior.
  const argv = [...nodeArgs, '-e', bundle.bootstrap, '--', 'autoprompt-grok-inline-worker.cjs', ...workerArgs]
  const commandLineUtf16Units = windowsCommandLineUnits(nodeExecutable, argv)
  if (commandLineUtf16Units > WINDOWS_SAFE_COMMAND_LINE_UNITS) fail('GROK_INLINE_BUNDLE_TOO_LARGE', 'Inline worker exceeds the bounded Windows command line')
  return Object.freeze({ ...bundle, executable: nodeExecutable, argv: Object.freeze(argv), commandLineUtf16Units })
}

function buildGrokInlineMcpClient(options = {}) {
  const nodeExecutable = options.nodeExecutable
  const port = options.port === undefined ? 19778 : options.port
  const host = options.host === undefined ? '127.0.0.1' : options.host
  const absoluteExecutable = options.platform === 'win32' ? path.win32.isAbsolute(nodeExecutable || '') : path.isAbsolute(nodeExecutable || '')
  if (typeof nodeExecutable !== 'string' || !absoluteExecutable ||
      !Number.isSafeInteger(port) || port < 1024 || port > 65535 || !['127.0.0.1', '::1'].includes(host)) fail('GROK_INLINE_BUNDLE_INVALID', 'Inline MCP command is invalid')
  const modules = Object.fromEntries(GROK_MCP_MODULES.map(id => [id, fs.readFileSync(path.join(__dirname, id), 'utf8')]))
  const bundle = buildClosedCommonJsBundle({ modules, entry: 'mcp-loopback.cjs', allowedBuiltins: GROK_MCP_BUILTINS })
  const argv = ['-e', bundle.bootstrap, '--', 'autoprompt-grok-inline-mcp.cjs', '--port', String(port), ...(host === '::1' ? ['--host', host] : [])]
  const commandLineUtf16Units = windowsCommandLineUnits(nodeExecutable, argv)
  if (commandLineUtf16Units > WINDOWS_SAFE_COMMAND_LINE_UNITS) fail('GROK_INLINE_BUNDLE_TOO_LARGE', 'Inline MCP command exceeds the bounded Windows command line')
  return Object.freeze({ ...bundle, executable: nodeExecutable, argv: Object.freeze(argv), commandLineUtf16Units })
}

module.exports = { GrokInlineBundleError, GROK_MODULES, GROK_BUILTINS, GROK_MCP_MODULES, GROK_MCP_BUILTINS, WINDOWS_SAFE_COMMAND_LINE_UNITS, buildClosedCommonJsBundle, buildGrokInlineWorker, buildGrokInlineMcpClient, quoteWindowsArgument, windowsCommandLineUnits }
