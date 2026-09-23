'use strict'

// Provider interfaces are deliberately separate from runtime admission. A help
// probe is evidence of a CLI surface, never a sandbox or conformance receipt.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cp = require('node:child_process')
const crypto = require('node:crypto')
const { readBound, sha256, privateDirectory, writePrivate } = require('../agents/reasonix/workflow/native.js')
class HarnessError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'HarnessError'; this.code = code; this.details = details }
}
const fail = (code, message, details) => { throw new HarnessError(code, message, details) }
const PROVIDERS = Object.freeze(Object.fromEntries(Object.entries({
  claude: { command: 'claude', protocol: 'claude-json', helpArgs: ['--help'], flags: ['--print', '--output-format', '--include-partial-messages', '--resume', '--tools', '--settings', '--setting-sources', '--strict-mcp-config', '--bare', '--effort', '--json-schema'], credentials: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'], urls: ['ANTHROPIC_BASE_URL'], docs: 'https://code.claude.com/docs/en/cli-reference' },
  opencode: { command: 'opencode', protocol: 'opencode-json', helpArgs: ['run', '--help'], flags: ['--format', '--session', '--agent', '--model', '--variant'], credentials: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY'], urls: [], docs: 'https://opencode.ai/v2/docs/models' },
  kilo: { command: 'kilo', protocol: 'opencode-json', helpArgs: ['run', '--help'], flags: ['--format', '--session', '--agent', '--model', '--variant'], credentials: ['KILO_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY'], urls: [], docs: 'https://kilo.ai/docs/code-with-ai/platforms/cli-reference' },
  // Prime 0.7.2 is pinned because the ownership-safe headless path below uses
  // that release's shipped owned-session-worker frontend. Later releases must
  // be re-proved before they can silently fall back to a detached daemon path.
  prime: { command: 'prime-agent', protocol: 'pi-json', helpArgs: ['--help'], flags: ['--mode', '--resume', '--session-dir', '--no-tools', '--no-builtin-tools', '--no-extensions', '--no-skills', '--no-context-files', '--system-prompt', '--thinking'], versions: ['0.7.2'], credentials: ['PRIME_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY'], urls: [], docs: 'https://github.com/PrimeIntellect-ai/prime-agent/blob/v0.7.2/packages/coding-agent/docs/json.md' },
  omp: { command: 'omp', protocol: 'pi-json', helpArgs: ['--help'], flags: ['--mode', '--resume', '--session-dir', '--tools', '--no-extensions', '--no-skills', '--no-rules', '--system-prompt', '--no-lsp', '--no-pty', '--thinking'], credentials: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY'], urls: [], docs: 'https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/modes/print-mode.ts' },
  deepseek: { command: 'dsh', protocol: 'deepseek-json', helpArgs: ['--help'], flags: ['--profile', '--patch'], versions: ['0.1.2-rc.1'], credentials: ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY'], urls: ['DEEPSEEK_BASE_URL'], docs: 'https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/protocol/src/types.ts' },
  hermes: { command: 'hermes', protocol: 'hermes-owned-json', helpArgs: ['chat', '--help'], flags: ['--query-file', '--oneshot', '--resume', '--model', '--provider', '--reasoning', '--toolsets', '--ignore-rules'], versions: ['0.21.1'], credentials: ['HERMES_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY'], urls: ['HERMES_BASE_URL'], docs: 'https://hermes-agent.nousresearch.com/docs' },
  grok: { command: 'grok', protocol: 'grok-owned-json', helpArgs: ['--help'], flags: ['-p', '--output-format', '--resume', '--model', '--tools', '--verbatim', '--system-prompt-override', '--no-subagents'], versions: ['1.0.13'], credentials: ['GROK_API_KEY', 'XAI_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY'], urls: ['GROK_BASE_URL'], docs: 'https://docs.x.ai/build/cli/headless-scripting' },
  vscode: { command: 'code', protocol: 'vscode-owned-json', helpArgs: ['--help'], flags: ['--list-extensions', '--extensions-dir', '--user-data-dir'], credentials: ['OPENROUTER_API_KEY', 'OPENAI_API_KEY'], urls: [], blockers: [], docs: 'https://code.visualstudio.com/api/extension-guides/ai/language-model' },
}).map(([id, descriptor]) => [id, Object.freeze({ id, provider: id, ...descriptor, flags: Object.freeze(descriptor.flags), versions: Object.freeze(descriptor.versions || []), credentials: Object.freeze(descriptor.credentials), urls: Object.freeze(descriptor.urls), blockers: Object.freeze(descriptor.blockers || []) })])))
function descriptor(provider) {
  if (typeof provider !== 'string' || !Object.hasOwn(PROVIDERS, provider)) fail('PROVIDER_UNSUPPORTED', `Unknown native provider: ${String(provider)}`)
  return PROVIDERS[provider]
}
function executableSha256(file) {
  // npm legitimately hard-links several native distributions. Private runtime
  // payloads still use readBound's one-link rule; executable trust is instead
  // bound to its exact open file identity and complete bytes.
  const before = fs.lstatSync(file, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || before.nlink < 1n) fail('PROVIDER_IDENTITY_MISMATCH', 'Native executable is not a regular file')
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  const same = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key])
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true })
    if (!same(before, opened)) fail('PROVIDER_IDENTITY_MISMATCH', 'Native executable changed while opening')
    const hash = crypto.createHash('sha256')
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let bytes = 0n
    for (;;) {
      const length = fs.readSync(descriptor, buffer, 0, buffer.length, null)
      if (!length) break
      hash.update(buffer.subarray(0, length)); bytes += BigInt(length)
    }
    const after = fs.lstatSync(file, { bigint: true })
    if (bytes !== opened.size || !same(opened, fs.fstatSync(descriptor, { bigint: true })) || !same(opened, after) || after.isSymbolicLink()) {
      fail('PROVIDER_IDENTITY_MISMATCH', 'Native executable changed while hashing')
    }
    return hash.digest('hex')
  } finally { fs.closeSync(descriptor) }
}
function windowsPackageRoot(script) {
  for (let directory = path.dirname(script); ; directory = path.dirname(directory)) {
    const parent = path.dirname(directory)
    const direct = path.basename(parent) === 'node_modules'
    const scoped = path.basename(path.dirname(parent)) === 'node_modules' && path.basename(parent).startsWith('@')
    if (direct || scoped) {
      const manifest = path.join(directory, 'package.json')
      try { if (fs.lstatSync(manifest).isFile()) return directory } catch {}
    }
    if (parent === directory) break
  }
  fail('PROVIDER_UNSUPPORTED', 'npm command shim does not resolve to one package bin')
}
function unlinkedDescendant(root, file) {
  const relative = path.relative(root, file)
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    fail('PROVIDER_IDENTITY_MISMATCH', 'npm command shim script escapes its package root')
  }
  for (let cursor = root; ; ) {
    const stat = fs.lstatSync(cursor)
    if (stat.isSymbolicLink() || (!stat.isDirectory() && cursor !== file) || (cursor === file && !stat.isFile())) {
      fail('PROVIDER_IDENTITY_MISMATCH', 'npm command shim contains a linked or invalid package path')
    }
    const next = path.relative(cursor, file).split(path.sep).filter(Boolean)[0]
    if (!next) break
    cursor = path.join(cursor, next)
  }
}
function windowsNpmShimInvocation(shim) {
  const bytes = readBound(shim)
  if (bytes.length > 65536) fail('PROVIDER_UNSUPPORTED', 'npm command shim is unexpectedly large')
  let source
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { fail('PROVIDER_UNSUPPORTED', 'npm command shim is not UTF-8') }
  if (source.includes('\0') || source.includes('\u001a')) fail('PROVIDER_UNSUPPORTED', 'npm command shim contains control data')
  const directory = path.dirname(shim)
  // npm's generated .cmd invokes its package bin through %dp0% (or %~dp0%).
  // We never interpret CMD syntax.  Admit only the small, flag-free Node form
  // below. A Bun or arbitrary command launcher must be explicitly modeled and
  // cannot be silently reinterpreted as this controller's Node process.
  // npm 10's cmd-shim has a deliberate `%_prog%` fallback skeleton. Match
  // that whole fixed Node form, including its no-argument final invocation;
  // do not treat `%_prog%` as a general command-language variable.
  const currentNpmNodeShim = /^@ECHO off\r?\nGOTO start\r?\n:find_dp0\r?\nSET dp0=%~dp0\r?\nEXIT \/b\r?\n:start\r?\nSETLOCAL\r?\nCALL :find_dp0\r?\n\r?\nIF EXIST "%dp0%\\node\.exe" \(\r?\n  SET "_prog=%dp0%\\node\.exe"\r?\n\) ELSE \(\r?\n  SET "_prog=node"\r?\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r?\n\)\r?\n\r?\nendLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & "%_prog%"  "%dp0%\\([^"%&|<>\r\n]+?\.(?:cjs|mjs|js))" %\*\r?\n$/iu
  const currentNpmNativeExeShim = /^@ECHO off\r?\nGOTO start\r?\n:find_dp0\r?\nSET dp0=%~dp0\r?\nEXIT \/b\r?\n:start\r?\nSETLOCAL\r?\nCALL :find_dp0\r?\n"%dp0%\\([^"%&|<>\r\n]+?\.exe)"[ \t]+%\*\r?\n$/iu
  const nodeCommand = currentNpmNodeShim.exec(source)
  const nativeCommand = currentNpmNativeExeShim.exec(source)
  const command = nodeCommand || nativeCommand
  if (!command) fail('PROVIDER_UNSUPPORTED', 'npm command shim is not a reviewed npm Node or native-executable cmd-shim form')
  const entrypoint = path.resolve(directory, command[1].replaceAll('\\', path.sep))
  const kind = nativeCommand ? 'native-exe' : 'node-script'
  const packageRoot = windowsPackageRoot(entrypoint)
  unlinkedDescendant(packageRoot, entrypoint)
  let manifest
  try { manifest = JSON.parse(readBound(path.join(packageRoot, 'package.json')).toString('utf8')) } catch { fail('PROVIDER_UNSUPPORTED', 'npm command shim package metadata is unreadable') }
  const shimName = path.basename(shim).replace(/\.cmd$/iu, '').toLowerCase()
  const packageName = typeof manifest.name === 'string' ? manifest.name.split('/').at(-1).toLowerCase() : ''
  const bins = typeof manifest.bin === 'string' ? { [packageName]: manifest.bin } : manifest.bin
  if (!bins || typeof bins !== 'object' || Array.isArray(bins) || typeof bins[shimName] !== 'string') {
    fail('PROVIDER_UNSUPPORTED', 'npm command shim does not name an exact declared package bin')
  }
  const declared = path.resolve(packageRoot, bins[shimName].replaceAll('/', path.sep))
  if (declared !== entrypoint) fail('PROVIDER_IDENTITY_MISMATCH', 'npm command shim entrypoint differs from its package bin declaration')
  if (kind === 'node-script') {
    const firstLine = readBound(entrypoint).subarray(0, 512).toString('utf8').split(/\r?\n/u, 1)[0]
    if (!/^#!(?:\/usr\/bin\/env\s+node(?:\.exe)?|\/[A-Za-z0-9._/-]*\/node(?:\.exe)?)\s*$/iu.test(firstLine)) {
      fail('PROVIDER_UNSUPPORTED', 'npm command shim entrypoint does not have a plain Node shebang')
    }
  }
  const shimSha256 = executableSha256(shim), entrypointSha256 = executableSha256(entrypoint)
  const body = kind === 'node-script'
    ? { schemaVersion: 1, kind, shim: { path: shim, sha256: shimSha256 }, node: { path: path.resolve(process.execPath), sha256: executableSha256(path.resolve(process.execPath)) }, script: { path: entrypoint, sha256: entrypointSha256 } }
    : { schemaVersion: 1, kind, shim: { path: shim, sha256: shimSha256 }, executable: { path: entrypoint, sha256: entrypointSha256 } }
  return Object.freeze({ ...body, sha256: sha256(JSON.stringify(body)) })
}
function executableRuntimePath(binding) {
  return binding?.invocation?.kind === 'node-script' ? binding.invocation.script.path
    : binding?.invocation?.kind === 'native-exe' ? binding.invocation.executable.path : binding?.path
}
function executableInvocation(binding, argv = []) {
  if (!binding || typeof binding.path !== 'string' || !/^[a-f0-9]{64}$/.test(binding.sha256 || '') || !Array.isArray(argv) || argv.some(value => typeof value !== 'string' || value.includes('\0'))) {
    fail('PROVIDER_IDENTITY_MISMATCH', 'Native executable binding or argv is invalid')
  }
  if (executableSha256(binding.path) !== binding.sha256) fail('PROVIDER_IDENTITY_MISMATCH', 'Native executable changed before launch')
  if (!binding.invocation) return Object.freeze({ executable: binding.path, argv: [...argv] })
  const invocation = binding.invocation
  const nodeScript = invocation.kind === 'node-script'
  const entrypoint = nodeScript ? invocation.script : invocation.executable
  if (!['node-script', 'native-exe'].includes(invocation.kind) || invocation.schemaVersion !== 1 ||
      !invocation.shim || !entrypoint ||
      typeof invocation.shim.path !== 'string' || typeof entrypoint.path !== 'string' ||
      !path.isAbsolute(invocation.shim.path) || !path.isAbsolute(entrypoint.path) ||
      invocation.shim.path !== binding.path || invocation.shim.sha256 !== binding.sha256 ||
      !/^[a-f0-9]{64}$/.test(entrypoint.sha256 || '') || !/^[a-f0-9]{64}$/.test(invocation.sha256 || '') ||
      executableSha256(entrypoint.path) !== entrypoint.sha256 ||
      (nodeScript && (!invocation.node || typeof invocation.node.path !== 'string' || !path.isAbsolute(invocation.node.path) ||
        !/^[a-f0-9]{64}$/.test(invocation.node.sha256 || '') || executableSha256(invocation.node.path) !== invocation.node.sha256))) {
    fail('PROVIDER_IDENTITY_MISMATCH', 'npm command shim launch binding changed')
  }
  const body = nodeScript
    ? { schemaVersion: 1, kind: invocation.kind, shim: invocation.shim, node: invocation.node, script: invocation.script }
    : { schemaVersion: 1, kind: invocation.kind, shim: invocation.shim, executable: invocation.executable }
  if (sha256(JSON.stringify(body)) !== invocation.sha256) fail('PROVIDER_IDENTITY_MISMATCH', 'npm command shim launch binding digest changed')
  return Object.freeze(nodeScript
    ? { executable: invocation.node.path, argv: [invocation.script.path, ...argv] }
    : { executable: invocation.executable.path, argv: [...argv] })
}
function locateExecutable({ provider, env = process.env, executable, platform = process.platform } = {}) {
  const d = descriptor(provider)
  const requested = executable || env[`AUTOPROMPT_${provider.toUpperCase()}_CLI`]
  const names = requested && path.isAbsolute(requested) ? [requested] : (env.PATH || '').split(path.delimiter).filter(Boolean).flatMap(dir => {
    const name = requested || d.command
    return platform === 'win32' ? /\.(?:exe|cmd)$/i.test(name) ? [path.join(dir, name)] : [path.join(dir, `${name}.exe`), path.join(dir, `${name}.cmd`)] : [path.join(dir, name)]
  })
  for (const name of names) {
    try {
      let resolved = fs.realpathSync.native(name)
      if (provider === 'vscode' && path.basename(path.dirname(resolved)) === 'bin') {
        const electron = path.join(path.dirname(path.dirname(resolved)), platform === 'win32' ? 'Code.exe' : 'code')
        if (fs.existsSync(electron)) resolved = fs.realpathSync.native(electron)
      }
      if (/^(codex|codex\.exe|codex\.js)$/i.test(path.basename(resolved))) fail('PROVIDER_IDENTITY_MISMATCH', 'Codex is not a native executable for this provider')
      fs.accessSync(resolved, fs.constants.X_OK)
      if (platform === 'win32' && /\.cmd$/i.test(resolved)) {
        const invocation = windowsNpmShimInvocation(resolved)
        return { provider, path: resolved, sha256: invocation.shim.sha256, invocation }
      }
      if (platform === 'win32' && /\.bat$/i.test(resolved)) fail('PROVIDER_UNSUPPORTED', 'Windows batch launchers are not an admitted native executable form')
      return { provider, path: resolved, sha256: executableSha256(resolved) }
    } catch (error) { if (error instanceof HarnessError) throw error }
  }
  fail('PROVIDER_UNSUPPORTED', `${d.command} is not installed or executable`, { provider, command: d.command })
}
function runtimeDependencyIdentity(executable, environment = process.env, invocation = null) {
  const roots = new Set(), files = new Map()
  let totalBytes = 0
  const packageAt = start => {
    for (let dir = start; ; dir = path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, 'package.json'))) return dir
      if (path.dirname(dir) === dir) return null
    }
  }
  const first = packageAt(path.dirname(executable))
  const record = file => {
    const real = fs.realpathSync.native(file)
    totalBytes += fs.statSync(real).size
    if (files.size >= 100000 || totalBytes > 8 * 1024 * 1024 * 1024) fail('PROVIDER_IDENTITY_MISMATCH', 'Runtime dependency inventory exceeds its bounded size')
    files.set(file, [real, executableSha256(real)])
  }
  const visit = root => {
    root = fs.realpathSync.native(root)
    if (roots.has(root)) return
    if (roots.size >= 4096) fail('PROVIDER_IDENTITY_MISMATCH', 'Runtime dependency inventory exceeds its package limit')
    roots.add(root)
    const manifestFile = path.join(root, 'package.json'), manifestBytes = fs.readFileSync(manifestFile)
    const manifest = JSON.parse(manifestBytes)
    const walk = dir => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue
        const file = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(file)
        else if (entry.isFile()) record(file)
        else if (entry.isSymbolicLink()) {
          const real = fs.realpathSync.native(file)
          if (!fs.statSync(real).isFile()) fail('PROVIDER_IDENTITY_MISMATCH', 'Runtime package contains an unbound directory symlink')
          record(file)
        }
      }
    }
    walk(root)
    if (sha256(manifestBytes) !== files.get(manifestFile)?.[1]) fail('PROVIDER_IDENTITY_MISMATCH', 'Runtime dependency metadata changed while collecting identity')
    for (const name of Object.keys({ ...manifest.peerDependencies, ...manifest.dependencies, ...manifest.optionalDependencies }).sort()) {
      if (!/^(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+$/.test(name)) fail('PROVIDER_IDENTITY_MISMATCH', 'Runtime dependency has an invalid package identity')
      let found = null
      for (let dir = root; ; dir = path.dirname(dir)) {
        const candidate = path.join(dir, 'node_modules', name)
        if (fs.existsSync(path.join(candidate, 'package.json'))) { found = candidate; break }
        if (path.dirname(dir) === dir) break
      }
      if (found) visit(found)
      else if (Object.hasOwn(manifest.dependencies || {}, name) && !Object.hasOwn(manifest.optionalDependencies || {}, name)) fail('PROVIDER_IDENTITY_MISMATCH', `Runtime dependency is missing: ${name}`)
    }
  }
  const vscodeBundle = path.dirname(executable)
  if (fs.existsSync(path.join(vscodeBundle, 'resources/app/product.json')) && fs.existsSync(path.join(vscodeBundle, 'resources/app/package.json'))) {
    // Electron can stay byte-identical while the VS Code application changes.
    // Bind the complete shipped bundle, including ASARs, native modules and
    // built-in extensions. Never treat the Electron executable hash as enough.
    roots.add(vscodeBundle)
    const walkBundle = dir => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name)
        if (entry.isDirectory()) walkBundle(file)
        else if (entry.isFile()) record(file)
        else if (entry.isSymbolicLink()) {
          if (!fs.statSync(file).isFile()) fail('PROVIDER_IDENTITY_MISMATCH', 'VS Code bundle contains an unbound directory link')
          record(file)
        }
      }
    }
    walkBundle(vscodeBundle)
  } else if (first) visit(first)
  record(executable)
  const header = Buffer.alloc(256), descriptor = fs.openSync(executable, 'r')
  let length
  try { length = fs.readSync(descriptor, header, 0, header.length, 0) } finally { fs.closeSync(descriptor) }
  const shebang = /^#!([^\r\n]+)/.exec(header.subarray(0, length).toString('utf8'))?.[1].trim().split(/\s+/)
  if (shebang) {
    let interpreter = invocation?.kind === 'node-script' ? invocation.node?.path : shebang[0]
    if (invocation?.kind === 'node-script' && (invocation.script?.path !== executable || !path.isAbsolute(interpreter || ''))) {
      fail('PROVIDER_IDENTITY_MISMATCH', 'Runtime invocation does not bind its JavaScript entrypoint and interpreter')
    }
    if (!invocation && path.basename(interpreter) === 'env') {
      if (shebang.length !== 2 || !/^[A-Za-z0-9._-]+$/.test(shebang[1])) fail('PROVIDER_IDENTITY_MISMATCH', 'Runtime launcher has an unsupported interpreter selector')
      interpreter = (environment.PATH || '').split(path.delimiter).map(dir => path.join(dir, shebang[1])).find(file => {
        try { fs.accessSync(file, fs.constants.X_OK); return true } catch { return false }
      })
    }
    if (!interpreter || !path.isAbsolute(interpreter)) fail('PROVIDER_IDENTITY_MISMATCH', 'Runtime launcher interpreter is unavailable')
    record(interpreter)
  }
  return Object.freeze({ sha256: sha256(JSON.stringify([...files].sort(([a], [b]) => a.localeCompare(b)))), fileCount: files.size, packageCount: roots.size })
}
function portableRuntimeDependencyIdentity(provider, executable, environment = process.env, invocation = null) {
  // This identity is intentionally separate from runtimeDependencyIdentity().
  // The latter remains path-sensitive because activation binds the exact local
  // installation. Portable identities bind the bytes of a relocatable Node or
  // VS Code closure through stable, package-relative labels.
  // Reasonix has its own native probe but shares the standalone closure format.
  if (provider !== 'reasonix') descriptor(provider)
  if (provider === 'hermes') return hermesPortableRuntimeDependencyIdentity(executable, environment)
  const maxFiles = 100000, maxPackages = 4096, maxBytes = 8 * 1024 * 1024 * 1024
  const logicalFiles = new Map(), seenPackages = new Map()
  let totalBytes = 0, packageCount = 0
  const safeRelative = (root, file) => {
    const relative = path.relative(root, file)
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      fail('PROVIDER_IDENTITY_MISMATCH', 'Portable runtime inventory escaped its declared root')
    }
    return relative.split(path.sep).join('/')
  }
  const regular = file => {
    const stat = fs.lstatSync(file, { bigint: true })
    if (!stat.isFile() || stat.isSymbolicLink()) fail('PROVIDER_IDENTITY_MISMATCH', 'Portable runtime inventory contains a non-regular or linked file')
    return stat
  }
  const directory = file => {
    const stat = fs.lstatSync(file, { bigint: true })
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('PROVIDER_IDENTITY_MISMATCH', 'Portable runtime inventory contains a linked or invalid directory')
    return fs.realpathSync.native(file)
  }
  const record = (label, file) => {
    if (typeof label !== 'string' || !label || label.includes('\\') || label.startsWith('/') || label.split('/').some(part => !part || part === '.' || part === '..')) {
      fail('PROVIDER_IDENTITY_MISMATCH', 'Portable runtime inventory has an invalid logical path')
    }
    const stat = regular(file)
    const real = fs.realpathSync.native(file)
    if (real !== path.resolve(file)) fail('PROVIDER_IDENTITY_MISMATCH', 'Portable runtime inventory contains a linked file')
    totalBytes += Number(stat.size)
    if (!Number.isSafeInteger(totalBytes) || totalBytes > maxBytes || logicalFiles.size >= maxFiles) fail('PROVIDER_IDENTITY_MISMATCH', 'Portable runtime inventory exceeds its bounded size')
    const hash = executableSha256(file), prior = logicalFiles.get(label)
    if (prior && prior !== hash) fail('PROVIDER_IDENTITY_MISMATCH', 'Portable runtime inventory has ambiguous duplicate logical paths')
    if (prior) fail('PROVIDER_IDENTITY_MISMATCH', 'Portable runtime inventory repeats a logical path')
    logicalFiles.set(label, hash)
  }
  // Interpreters are declared by an absolute launcher shebang and may be a
  // distribution-managed symlink. Bind the final executable bytes, while
  // keeping package/bundle symlinks fail-closed above.
  const recordInterpreter = (label, file) => {
    let real
    try { real = fs.realpathSync.native(file) } catch { fail('PROVIDER_IDENTITY_MISMATCH', 'Portable runtime launcher interpreter is unavailable') }
    const stat = regular(real)
    totalBytes += Number(stat.size)
    if (!Number.isSafeInteger(totalBytes) || totalBytes > maxBytes || logicalFiles.size >= maxFiles) fail('PROVIDER_IDENTITY_MISMATCH', 'Portable runtime inventory exceeds its bounded size')
    const hash = executableSha256(real), prior = logicalFiles.get(label)
    if (prior) fail('PROVIDER_IDENTITY_MISMATCH', 'Portable runtime inventory repeats an interpreter label')
    logicalFiles.set(label, hash)
  }
  const readManifest = root => {
    const manifestFile = path.join(root, 'package.json')
    regular(manifestFile)
    let manifest
    try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) } catch { fail('PROVIDER_IDENTITY_MISMATCH', 'Portable runtime package metadata is invalid') }
    if (!manifest || typeof manifest.name !== 'string' || !/^(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+$/.test(manifest.name) || typeof manifest.version !== 'string' || !manifest.version) {
      fail('PROVIDER_IDENTITY_MISMATCH', 'Portable runtime package has no stable name and version')
    }
    return manifest
  }
  const packageAt = start => {
    for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
      const manifest = path.join(dir, 'package.json')
      try { if (fs.lstatSync(manifest).isFile()) return dir } catch {}
      if (path.dirname(dir) === dir) return null
    }
  }
  const packageLabel = manifest => `${manifest.name}@${manifest.version}`
  const declaredArtifactMatches = (requestedName, specifier, dependency) => {
    if (dependency.name === requestedName) return true
    // Prime publishes a few scoped source dependencies as versioned tarballs
    // whose installed package metadata carries the artifact name. Accept only
    // when that exact declared artifact filename binds both installed name and
    // version; the complete package bytes remain in the inventory below.
    if (typeof specifier !== 'string') return false
    let artifact
    try { artifact = path.basename(new URL(specifier).pathname) } catch { return false }
    return artifact === `${dependency.name}-${dependency.version}.tgz`
  }
  let dependencySearchRoot = null
  const visitPackage = (candidate, label) => {
    const root = directory(candidate), manifest = readManifest(root)
    if (seenPackages.has(root)) {
      return
    }
    if (++packageCount > maxPackages) fail('PROVIDER_IDENTITY_MISMATCH', 'Portable runtime inventory exceeds its package limit')
    seenPackages.set(root, label)
    const walk = dir => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue
        const file = path.join(dir, entry.name), stat = fs.lstatSync(file)
        if (stat.isSymbolicLink()) fail('PROVIDER_IDENTITY_MISMATCH', 'Portable runtime package contains a symbolic link')
        if (stat.isDirectory()) walk(file)
        else if (stat.isFile()) record(`${label}/${safeRelative(root, file)}`, file)
        else fail('PROVIDER_IDENTITY_MISMATCH', 'Portable runtime package contains an unsupported filesystem entry')
      }
    }
    walk(root)
    const requested = { ...manifest.peerDependencies, ...manifest.dependencies, ...manifest.optionalDependencies }
    for (const name of Object.keys(requested).sort()) {
      if (!/^(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+$/.test(name)) fail('PROVIDER_IDENTITY_MISMATCH', 'Portable runtime dependency has an invalid package identity')
      let found = null
      for (let dir = root; ; dir = path.dirname(dir)) {
        const nodeModules = path.join(dir, 'node_modules'), candidate = path.join(nodeModules, name)
        try {
          if (fs.lstatSync(candidate).isSymbolicLink()) fail('PROVIDER_IDENTITY_MISMATCH', 'Portable runtime dependency is linked outside its package root')
          if (fs.lstatSync(path.join(candidate, 'package.json')).isFile()) { found = candidate; break }
        } catch (error) { if (error?.code !== 'ENOENT') throw error }
        if (dir === dependencySearchRoot) break
      }
      if (found) {
        const dependency = readManifest(found)
        if (!declaredArtifactMatches(name, requested[name], dependency)) fail('PROVIDER_IDENTITY_MISMATCH', 'Portable runtime dependency metadata does not match its requested name')
        // A hoisted package can be reached from more than one branch. Its
        // first canonical graph path remains stable; later references reopen
        // the same physical package and are already byte-bound above.
        visitPackage(found, `${label}/node_modules/${packageLabel(dependency)}`)
      } else if (Object.hasOwn(manifest.dependencies || {}, name) && !Object.hasOwn(manifest.optionalDependencies || {}, name)) {
        fail('PROVIDER_IDENTITY_MISMATCH', `Portable runtime dependency is missing: ${name}`)
      }
    }
  }
  const resolvedExecutable = fs.realpathSync.native(executable)
  if (resolvedExecutable !== path.resolve(executable)) fail('PROVIDER_IDENTITY_MISMATCH', 'Portable runtime executable must not be a symbolic link')
  regular(resolvedExecutable)
  let rootBase = null
  const vscodeBundle = path.dirname(resolvedExecutable)
  if (provider === 'vscode' && fs.existsSync(path.join(vscodeBundle, 'resources/app/product.json')) && fs.existsSync(path.join(vscodeBundle, 'resources/app/package.json'))) {
    rootBase = directory(vscodeBundle); packageCount = 1
    const walkBundle = dir => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const file = path.join(dir, entry.name), stat = fs.lstatSync(file)
        if (stat.isSymbolicLink()) fail('PROVIDER_IDENTITY_MISMATCH', 'Portable VS Code bundle contains a symbolic link')
        if (stat.isDirectory()) walkBundle(file)
        else if (stat.isFile()) record(`vscode/${safeRelative(rootBase, file)}`, file)
        else fail('PROVIDER_IDENTITY_MISMATCH', 'Portable VS Code bundle contains an unsupported filesystem entry')
      }
    }
    walkBundle(rootBase)
  } else {
    rootBase = packageAt(path.dirname(resolvedExecutable))
    if (rootBase) {
      rootBase = directory(rootBase)
      // npm commonly hoists a package's declared dependency beside its
      // package directory. Resolve only within that installation root: this
      // preserves the complete required closure without searching ambient
      // parent installations or loosening the byte inventory.
      let nodeModules = rootBase
      while (path.basename(nodeModules) !== 'node_modules' && path.dirname(nodeModules) !== nodeModules) nodeModules = path.dirname(nodeModules)
      dependencySearchRoot = path.basename(nodeModules) === 'node_modules' ? path.dirname(nodeModules) : rootBase
      const rootManifest = readManifest(rootBase)
      visitPackage(rootBase, `npm/${packageLabel(rootManifest)}`)
    } else {
      record(`entrypoint/${path.basename(resolvedExecutable)}`, resolvedExecutable)
    }
  }
  // A package walk should already include the entrypoint. Verify it did rather
  // than adding an absolute-path-dependent duplicate record.
  if (rootBase && !safeRelative(rootBase, resolvedExecutable)) fail('PROVIDER_IDENTITY_MISMATCH', 'Portable runtime entrypoint escaped its closure')
  const header = Buffer.alloc(256), fd = fs.openSync(resolvedExecutable, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  let length
  try { length = fs.readSync(fd, header, 0, header.length, 0) } finally { fs.closeSync(fd) }
  const shebang = /^#!([^\r\n]+)/.exec(header.subarray(0, length).toString('utf8'))?.[1].trim().split(/\s+/)
  if (shebang) {
    let interpreter = invocation?.kind === 'node-script' ? invocation.node?.path : shebang[0], envInterpreter = null
    if (invocation?.kind === 'node-script' && (invocation.script?.path !== executable || !path.isAbsolute(interpreter || ''))) {
      fail('PROVIDER_IDENTITY_MISMATCH', 'Portable runtime invocation does not bind its JavaScript entrypoint and interpreter')
    }
    if (!invocation && path.basename(interpreter) === 'env') {
      if (shebang.length !== 2 || !/^[A-Za-z0-9._-]+$/.test(shebang[1])) fail('PROVIDER_IDENTITY_MISMATCH', 'Portable runtime launcher has an unsupported interpreter selector')
      envInterpreter = interpreter
      interpreter = (environment.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, shebang[1])).find(file => {
        // Package managers deliberately expose runtime launchers through
        // node_modules/.bin symlinks. Resolve and bind the final executable
        // bytes below; rejecting the link itself would make a valid, pinned
        // runtime depend on an ambient replacement command instead.
        try {
          const stat = fs.lstatSync(file)
          if (!stat.isFile() && !stat.isSymbolicLink()) return false
          return fs.statSync(file).isFile()
        } catch { return false }
      })
    }
    if (!interpreter || !path.isAbsolute(interpreter)) fail('PROVIDER_IDENTITY_MISMATCH', 'Portable runtime launcher interpreter is unavailable')
    if (envInterpreter) recordInterpreter(`interpreter/${path.basename(envInterpreter)}`, envInterpreter)
    recordInterpreter(`interpreter/${path.basename(interpreter)}`, interpreter)
  }
  const files = [...logicalFiles].sort(([a], [b]) => a.localeCompare(b))
  const body = { schemaVersion: 1, provider, platform: process.platform, architecture: process.arch, files }
  return Object.freeze({ ...body, sha256: sha256(JSON.stringify(body)), fileCount: files.length, packageCount })
}
function hermesClosureRuntime(executable) {
  // The Linux closure uses small /bin/sh wrappers so it can find its copied
  // interpreter after relocation.  Do not mistake that shell shebang for the
  // Python used by Hermes' SQLite observer.
  const root = path.dirname(path.dirname(executable)), manifestFile = path.join(root, '.autoprompt-hermes-linux-closure.json')
  if (!fs.existsSync(manifestFile)) return null
  let manifest
  try { manifest = JSON.parse(readBound(manifestFile).toString('utf8')) } catch { fail('PROVIDER_IDENTITY_MISMATCH', 'Hermes closure manifest is unreadable') }
  const relative = value => typeof value === 'string' && !path.isAbsolute(value) && !value.split(/[\\/]/).some(part => !part || part === '.' || part === '..')
  if (!manifest || manifest.schemaVersion !== 1 || manifest.kind !== 'autoprompt-hermes-linux-closure-v1' || manifest.provider !== 'hermes' || manifest.platform !== 'linux' ||
      !manifest.entrypoint || !relative(manifest.entrypoint.hermes) || !relative(manifest.entrypoint.python) || !relative(manifest.entrypoint.runtimePython) ||
      path.join(root, manifest.entrypoint.hermes) !== executable) fail('PROVIDER_IDENTITY_MISMATCH', 'Hermes closure manifest does not bind this launcher')
  const result = Object.fromEntries(Object.entries(manifest.entrypoint).map(([key, value]) => [key, path.join(root, value)]))
  for (const file of Object.values(result)) {
    try { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || !fs.realpathSync.native(file).startsWith(root + path.sep)) throw new Error('unsafe') }
    catch { fail('PROVIDER_IDENTITY_MISMATCH', 'Hermes closure manifest points outside its runtime root') }
  }
  return Object.freeze({ root, manifestFile, manifest: Object.freeze(manifest), ...result })
}
function hermesPythonDependencyInventory(executable, environment = process.env) {
  const closure = hermesClosureRuntime(executable)
  const interpreter = closure?.python || /^#!([^\r\n\s]+)/.exec(readBound(executable).subarray(0, 512).toString('utf8'))?.[1]
  if (!interpreter || !path.isAbsolute(interpreter)) fail('PROVIDER_IDENTITY_MISMATCH', 'Hermes launcher has no bound absolute Python interpreter')
  // Hermes is commonly installed editable during development. Distribution
  // RECORD files then contain only the finder and metadata, while the actual
  // imported source lives in the mapped checkout. Include those mappings and
  // the interpreter's standard library so activation and dispatch bind the
  // code Python will really import. The Python side emits paths only; Node
  // performs the race-resistant hashing with the same executable hasher used
  // for every other native runtime.
  const script = String.raw`import ast
import importlib.metadata as metadata
import json
import os
from pathlib import Path
import sysconfig

files = set()
package_names = set()
source_roots = set()
resolved_source_roots = set()
missing = []
generated = []
finder_roots = []
editable_direct_roots = []
links = []

for distribution in metadata.distributions():
    name = distribution.metadata.get("Name")
    if name:
        package_names.add(name.lower())
    for item in distribution.files or ():
        candidate = Path(distribution.locate_file(item))
        if candidate.suffix in {".pyc", ".pyo"}:
            continue
        if candidate.is_symlink():
            missing.append(str(candidate))
        elif candidate.is_file():
            files.add(str(candidate.resolve()))
        elif not candidate.exists():
            missing.append(str(candidate))

# Editable installs expose their import roots through generated finder files.
# Parse only literal MAPPING/NAMESPACES assignments; never execute package code
# while constructing the identity.
for finder in Path(sysconfig.get_paths().get("purelib", "")).glob("__editable___*_finder.py"):
    try:
        tree = ast.parse(finder.read_text(encoding="utf-8"))
    except Exception:
        missing.append(str(finder))
        continue
    for statement in tree.body:
        if not isinstance(statement, (ast.Assign, ast.AnnAssign)):
            continue
        targets = ({target.id for target in statement.targets if isinstance(target, ast.Name)}
                   if isinstance(statement, ast.Assign)
                   else ({statement.target.id} if isinstance(statement.target, ast.Name) else set()))
        if not targets.intersection({"MAPPING", "NAMESPACES"}):
            continue
        try:
            value = ast.literal_eval(statement.value)
        except Exception:
            missing.append(str(finder))
            continue
        if "MAPPING" in targets and isinstance(value, dict):
            values = [str(item) for item in value.values()]
            source_roots.update(values)
            finder_roots.extend(values)
            generated.append({"path": str(finder.resolve()), "kind": "editable-finder", "references": values})
        if "NAMESPACES" in targets and isinstance(value, dict):
            for items in value.values():
                if isinstance(items, list):
                    values = [str(item) for item in items]
                    source_roots.update(values)
                    finder_roots.extend(values)
                    generated.append({"path": str(finder.resolve()), "kind": "editable-finder", "references": values})

# Plain-path .pth files are another supported editable-install mechanism. Read
# only path entries; executable import lines are intentionally not evaluated.
# An editable .pth without a matching literal finder is incomplete and must
# fail closed instead of silently omitting its source tree.
purelib_path = Path(sysconfig.get_paths().get("purelib", ""))
for pth in purelib_path.glob("*.pth"):
    try:
        lines = pth.read_text(encoding="utf-8").splitlines()
    except Exception:
        continue
    has_import = False
    path_values = []
    for line in lines:
        value = line.strip()
        if not value or value.startswith("#"):
            continue
        if value.startswith("import ") or value.startswith("import\\t"):
            has_import = True
            continue
        candidate = Path(value)
        if not candidate.is_absolute():
            candidate = pth.parent / candidate
        if candidate.exists():
            source_roots.add(str(candidate))
            path_values.append(str(value))
        else:
            missing.append(str(candidate))
    if pth.name.startswith("__editable__") and has_import:
        finder_name = pth.read_text(encoding="utf-8").split("import ", 1)[-1].split(";", 1)[0].strip()
        if not (purelib_path / f"{finder_name}.py").exists():
            missing.append(str(pth))
    if path_values:
        generated.append({"path": str(pth.resolve()), "kind": "editable-pth", "references": path_values})

# PEP 610 direct_url.json is generated installer metadata.  An editable URL
# may name the checkout root while the finder maps individual import roots.
# It is portable only when every finder root stays inside that declared source
# checkout; otherwise an edited finder could redirect the imported closure.
for direct_url in purelib_path.glob("*.dist-info/direct_url.json"):
    try:
        direct = json.loads(direct_url.read_text(encoding="utf-8"))
        value = direct.get("url")
        editable = isinstance(direct.get("dir_info"), dict) and direct["dir_info"].get("editable") is True
        if not editable or not isinstance(value, str) or not value.startswith("file://"):
            continue
        from urllib.parse import unquote, urlsplit
        parsed = urlsplit(value)
        if parsed.scheme != "file" or parsed.netloc not in {"", "localhost"}:
            missing.append(str(direct_url)); continue
        root = Path(unquote(parsed.path)).resolve()
        if not root.is_dir():
            missing.append(str(direct_url)); continue
        editable_direct_roots.append((str(root), direct_url.parent.name))
        generated.append({"path": str(direct_url.resolve()), "kind": "direct-url", "references": [value]})
    except Exception:
        missing.append(str(direct_url))

if finder_roots and editable_direct_roots:
    for raw in finder_roots:
        try:
            resolved = Path(raw).resolve()
            matches = [root for root, _name in editable_direct_roots if resolved.is_relative_to(Path(root))]
            if len(matches) != 1:
                missing.append(str(resolved))
        except Exception:
            missing.append(str(raw))

stdlib_roots = {sysconfig.get_paths().get("stdlib"), sysconfig.get_paths().get("platstdlib")}
package_roots = {sysconfig.get_paths().get("purelib"), sysconfig.get_paths().get("platlib")}
stdlib_root = Path(sysconfig.get_paths().get("stdlib", "")).resolve()
allowed_stdlib_links = {
    stdlib_root / "sitecustomize.py": Path("/etc/python3.12/sitecustomize.py"),
    stdlib_root / "_sysconfigdata__linux_x86_64-linux-gnu.py": stdlib_root / "_sysconfigdata__x86_64-linux-gnu.py",
    stdlib_root / "config-3.12-x86_64-linux-gnu" / "libpython3.12.so": Path("/usr/lib/x86_64-linux-gnu/libpython3.12.so.1.0"),
}
def add_tree(root, allow_stdlib_links=False):
    if not root:
        return
    root = Path(root)
    # setuptools' editable finder stores a top-level module as its stem
    # (for example /checkout/run_agent for run_agent.py).  Accept only
    # that exact generated convention; every other absent mapped root fails.
    if root.is_symlink():
        missing.append(str(root))
        return
    if not root.exists() and not root.suffix and root.with_suffix(".py").is_file() and not root.with_suffix(".py").is_symlink():
        root = root.with_suffix(".py")
    if not root.exists():
        missing.append(str(root))
        return
    root = root.resolve()
    resolved_source_roots.add(str(root))
    if root.is_file():
        if root.suffix not in {".pyc", ".pyo"}:
            files.add(str(root))
        return
    for candidate in root.rglob("*"):
        if any(part in {"__pycache__", ".git"} for part in candidate.parts):
            continue
        if candidate.suffix in {".pyc", ".pyo"}:
            continue
        if candidate.is_symlink():
            target = allowed_stdlib_links.get(candidate) if allow_stdlib_links else None
            if target is None or not target.is_file() or candidate.resolve() != target.resolve():
                missing.append(str(candidate))
                continue
            links.append({"logicalPath": "python/stdlib-link/" + candidate.relative_to(stdlib_root).as_posix(), "path": str(candidate), "target": str(target.resolve())})
            files.add(str(target.resolve()))
        elif candidate.is_file():
            files.add(str(candidate.resolve()))

for root in list(source_roots):
    add_tree(root)
for root in package_roots:
    add_tree(root)
for root in stdlib_roots:
    add_tree(root, Path(root).resolve() == stdlib_root)

# Keep a declared logical-root map alongside the raw path list. The Node
# caller hashes every listed byte for its legacy local identity; this map is
# used only by the portable identity and fails closed if a file is unmapped.
root_entries = {}
root_conflicts = []
def add_root(label, value):
    if not value:
        return
    try:
        value = str(Path(value).resolve())
    except Exception:
        return
    prior = root_entries.get(label)
    if prior and prior != value:
        root_conflicts.append(label)
        return
    root_entries[label] = value

add_root("python/stdlib", sysconfig.get_paths().get("stdlib"))
add_root("python/platstdlib", sysconfig.get_paths().get("platstdlib"))
add_root("python/site-packages", sysconfig.get_paths().get("purelib"))
add_root("python/plat-site-packages", sysconfig.get_paths().get("platlib"))
# Direct editable source roots are logical roots too, but their trees are not
# added a second time: finder/path roots above remain the exact file closure.
for root, name in editable_direct_roots:
    label = "editable/source/" + "".join(char if char.isalnum() or char in "._-" else "_" for char in name)
    add_root(label, root)
known_roots = set(root_entries.values())
for root in sorted(resolved_source_roots):
    try:
        resolved = Path(root).resolve()
    except Exception:
        continue
    value = str(resolved)
    if value in known_roots:
        continue
    matches = [(base, name) for base, name in editable_direct_roots if resolved.is_relative_to(Path(base))]
    if len(matches) == 1:
        base, distribution = matches[0]
        name = "source/" + "".join(char if char.isalnum() or char in "._-" else "_" for char in distribution)
        suffix = resolved.relative_to(Path(base)).as_posix()
        if suffix and suffix != ".":
            name += "/" + suffix
    else:
        name = resolved.name
    if not name or name in {".", ".."}:
        root_conflicts.append("editable/invalid")
        continue
    add_root("editable/" + name, value)

print(json.dumps({"files": sorted(files), "packageCount": len(package_names), "missing": sorted(set(missing)), "generated": generated, "links": sorted(links, key=lambda item: item["logicalPath"]), "roots": [{"logicalPath": label, "path": value} for label, value in sorted(root_entries.items())], "rootConflicts": sorted(set(root_conflicts))}))`
  const probeCache = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-hermes-python-cache-'))
  let run
  try {
    run = cp.spawnSync(interpreter, ['-c', script], { cwd: probeCache, env: { PATH: environment.PATH || '', PYTHONNOUSERSITE: '1', PYTHONPYCACHEPREFIX: probeCache }, encoding: 'utf8', timeout: 30000, maxBuffer: 64 * 1024 * 1024 })
  } finally {
    fs.rmSync(probeCache, { recursive: true, force: true })
  }
  if (run.error || run.status !== 0) fail('PROVIDER_IDENTITY_MISMATCH', 'Hermes Python dependency inventory could not be read')
  let inventory; try { inventory = JSON.parse(run.stdout) } catch { fail('PROVIDER_IDENTITY_MISMATCH', 'Hermes Python dependency inventory is invalid') }
  if (closure) {
    if (!Array.isArray(inventory.roots) || inventory.roots.some(item => item?.logicalPath === 'python/interpreter' || item?.logicalPath === 'hermes/manifest')) fail('PROVIDER_IDENTITY_MISMATCH', 'Hermes closure Python root is invalid')
    inventory.roots.push({ logicalPath: 'python/interpreter', path: closure.runtimePython })
    inventory.roots.push({ logicalPath: 'hermes/manifest', path: closure.manifestFile })
  }
  const listed = inventory?.files
  if (!Array.isArray(listed) || !listed.length || (Array.isArray(inventory.missing) && inventory.missing.length)) fail('PROVIDER_IDENTITY_MISMATCH', 'Hermes Python dependency inventory is incomplete')
  const files = new Map()
  for (const file of [executable, interpreter, ...(closure ? [closure.runtimePython, closure.manifestFile] : []), ...listed]) {
    if (!path.isAbsolute(file) || !fs.existsSync(file)) continue
    const stat = fs.lstatSync(file)
    const boundInterpreter = stat.isSymbolicLink() && path.resolve(file) === path.resolve(interpreter) && fs.statSync(file).isFile()
    if ((!stat.isFile() && !boundInterpreter) || (stat.isSymbolicLink() && !boundInterpreter)) fail('PROVIDER_IDENTITY_MISMATCH', 'Hermes Python dependency inventory contains a linked or invalid file')
    const real = fs.realpathSync.native(file); files.set(real, executableSha256(real))
  }
  if (files.size < 3) fail('PROVIDER_IDENTITY_MISMATCH', 'Hermes Python dependency inventory is incomplete')
  if (!Number.isSafeInteger(inventory.packageCount) || inventory.packageCount < 1) fail('PROVIDER_IDENTITY_MISMATCH', 'Hermes Python dependency package inventory is invalid')
  const links = []
  for (const link of inventory.links || []) {
    if (!link || typeof link !== 'object' || typeof link.logicalPath !== 'string' || typeof link.path !== 'string' || typeof link.target !== 'string' ||
        !/^python\/stdlib-link\/[A-Za-z0-9._/-]+$/.test(link.logicalPath) || !path.isAbsolute(link.path) || !path.isAbsolute(link.target)) {
      fail('PROVIDER_IDENTITY_MISMATCH', 'Hermes Python symlink inventory is invalid')
    }
    const lexical = path.resolve(link.path), expectedTarget = path.resolve(link.target)
    const stat = fs.lstatSync(lexical)
    if (!stat.isSymbolicLink() || fs.realpathSync.native(lexical) !== expectedTarget || !files.has(expectedTarget)) fail('PROVIDER_IDENTITY_MISMATCH', 'Hermes Python symlink binding changed while collecting identity')
    if (links.some(item => item.logicalPath === link.logicalPath)) fail('PROVIDER_IDENTITY_MISMATCH', 'Hermes Python symlink inventory is ambiguous')
    links.push(Object.freeze({ logicalPath: link.logicalPath, path: lexical, target: expectedTarget, targetSha256: files.get(expectedTarget) }))
  }
  return Object.freeze({ interpreter, inventory: Object.freeze(inventory), files: Object.freeze([...files]), links: Object.freeze(links) })
}
function hermesRuntimeDependencyIdentity(executable, environment = process.env, captured = hermesPythonDependencyInventory(executable, environment)) {
  const body = { files: [...captured.files].sort(([a], [b]) => a.localeCompare(b)), links: [...(captured.links || [])].sort((a, b) => a.logicalPath.localeCompare(b.logicalPath)) }
  return Object.freeze({ sha256: sha256(JSON.stringify(body)), fileCount: captured.files.length, packageCount: captured.inventory.packageCount })
}
function hermesPortableRuntimeDependencyIdentity(executable, environment = process.env, captured = hermesPythonDependencyInventory(executable, environment)) {
  const roots = captured.inventory.roots
  const launcher = fs.realpathSync.native(executable), interpreter = fs.realpathSync.native(captured.interpreter)
  if (!Array.isArray(roots) || !roots.length || !Array.isArray(captured.inventory.rootConflicts) || captured.inventory.rootConflicts.length) {
    fail('PROVIDER_IDENTITY_MISMATCH', 'Hermes Python dependency roots are incomplete or ambiguous for portable identity')
  }
  const validLabel = value => typeof value === 'string' && /^(?:python|editable|hermes)\//.test(value) && !/[\0\\]/.test(value) && !value.split('/').some(part => !part || part === '.' || part === '..')
  const normalizedRoots = [...roots, { logicalPath: 'hermes/bin', path: path.dirname(launcher) }].map(item => {
    if (!item || typeof item !== 'object' || !validLabel(item.logicalPath) || typeof item.path !== 'string' || !path.isAbsolute(item.path)) {
      fail('PROVIDER_IDENTITY_MISMATCH', 'Hermes Python dependency root has invalid portable metadata')
    }
    let real, lexical
    try { lexical = fs.lstatSync(item.path); real = fs.realpathSync.native(item.path) } catch { fail('PROVIDER_IDENTITY_MISMATCH', 'Hermes Python dependency root is unavailable') }
    if (lexical.isSymbolicLink()) fail('PROVIDER_IDENTITY_MISMATCH', 'Hermes Python dependency root is linked')
    const stat = fs.statSync(real)
    if (!stat.isDirectory() && !stat.isFile()) fail('PROVIDER_IDENTITY_MISMATCH', 'Hermes Python dependency root is invalid')
    return { logicalPath: item.logicalPath, path: real, directory: stat.isDirectory() }
  }).sort((a, b) => b.path.length - a.path.length || a.logicalPath.localeCompare(b.logicalPath))
  if (new Set(normalizedRoots.map(item => item.logicalPath)).size !== normalizedRoots.length) fail('PROVIDER_IDENTITY_MISMATCH', 'Hermes Python dependency roots repeat a portable label')
  const rawFiles = new Map(captured.files)
  const linkBindings = captured.links || []
  const rootFor = file => normalizedRoots.find(candidate => file === candidate.path || (candidate.directory && file.startsWith(`${candidate.path}${path.sep}`)))
  const closureFor = root => [...rawFiles.keys()].some(file => file === root.path || (root.directory && file.startsWith(`${root.path}${path.sep}`)))
  const logicalReference = (reference, kind) => {
    let source = reference
    if (kind === 'direct-url') {
      let url
      try { url = new URL(reference) } catch { fail('PROVIDER_IDENTITY_MISMATCH', 'Hermes direct URL metadata is invalid') }
      if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost') || url.search || url.hash || url.username || url.password) {
        fail('PROVIDER_IDENTITY_MISMATCH', 'Hermes direct URL metadata is not a local installation reference')
      }
      try { source = decodeURIComponent(url.pathname) } catch { fail('PROVIDER_IDENTITY_MISMATCH', 'Hermes direct URL metadata is not decodable') }
    }
    if (!path.isAbsolute(source)) fail('PROVIDER_IDENTITY_MISMATCH', 'Hermes generated metadata has a non-absolute installation reference')
    let real
    try { real = fs.realpathSync.native(source) } catch {
      // See the bounded `.py` stem convention documented in the Python
      // inventory above.  It is accepted for a parsed editable finder only.
      if (kind !== 'editable-finder' || path.extname(source)) fail('PROVIDER_IDENTITY_MISMATCH', 'Hermes generated metadata references a missing installation path')
      try { real = fs.realpathSync.native(`${source}.py`) } catch { fail('PROVIDER_IDENTITY_MISMATCH', 'Hermes generated metadata references a missing installation path') }
    }
    const root = rootFor(real)
    if (!root || !closureFor(root)) fail('PROVIDER_IDENTITY_MISMATCH', 'Hermes generated metadata escapes its captured source closure', { kind, reference })
    const relative = path.relative(root.path, real).split(path.sep).join('/')
    if (relative === '..' || relative.startsWith('../') || relative.includes('/../')) fail('PROVIDER_IDENTITY_MISMATCH', 'Hermes generated metadata escaped its logical root')
    const logical = `${root.logicalPath}${relative ? `/${relative}` : ''}`
    return kind === 'direct-url' ? `file:///@autoprompt-hermes-root/${logical}` : `@autoprompt-hermes-root/${logical}`
  }
  const readExact = (file, expectedHash) => {
    let bytes
    try { bytes = fs.readFileSync(file) } catch { fail('PROVIDER_IDENTITY_MISMATCH', 'Hermes portable dependency file is unreadable') }
    if (sha256(bytes) !== expectedHash || executableSha256(file) !== expectedHash) fail('PROVIDER_IDENTITY_MISMATCH', 'Hermes portable dependency file changed while canonicalizing')
    return bytes
  }
  const replaceQuoted = (text, reference, replacement, expected) => {
    if (typeof reference !== 'string' || !reference || /[\r\n\0]/.test(reference)) fail('PROVIDER_IDENTITY_MISMATCH', 'Hermes generated metadata reference is invalid')
    const escaped = reference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const matcher = new RegExp(`(['"])${escaped}\\1`, 'g')
    const matches = [...text.matchAll(matcher)]
    if (matches.length !== expected) fail('PROVIDER_IDENTITY_MISMATCH', 'Hermes generated metadata does not match its parsed literal closure')
    return text.replace(matcher, (_whole, quote) => `${quote}${replacement}${quote}`)
  }
  const replacePthPath = (text, reference, replacement, expected) => {
    if (typeof reference !== 'string' || !path.isAbsolute(reference) || /[\r\n\0]/.test(reference)) fail('PROVIDER_IDENTITY_MISMATCH', 'Hermes .pth metadata reference is invalid')
    const escaped = reference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const matcher = new RegExp(`(^[\\t ]*)${escaped}([\\t ]*(?:\\r?$))`, 'gm')
    const matches = [...text.matchAll(matcher)]
    if (matches.length !== expected) fail('PROVIDER_IDENTITY_MISMATCH', 'Hermes .pth metadata does not match its parsed literal closure')
    return text.replace(matcher, (_whole, prefix, suffix) => `${prefix}${replacement}${suffix}`)
  }
  const generated = new Map()
  for (const entry of captured.inventory.generated || []) {
    if (!entry || typeof entry !== 'object' || !['editable-finder', 'editable-pth', 'direct-url'].includes(entry.kind) || typeof entry.path !== 'string' || !Array.isArray(entry.references)) {
      fail('PROVIDER_IDENTITY_MISMATCH', 'Hermes generated metadata inventory is invalid')
    }
    let file
    try { file = fs.realpathSync.native(entry.path) } catch { fail('PROVIDER_IDENTITY_MISMATCH', 'Hermes generated metadata is unavailable') }
    if (!rawFiles.has(file) || !rootFor(file)?.logicalPath.startsWith('python/')) fail('PROVIDER_IDENTITY_MISMATCH', 'Hermes generated metadata is outside its Python closure')
    const prior = generated.get(file)
    if (prior && prior.kind !== entry.kind) fail('PROVIDER_IDENTITY_MISMATCH', 'Hermes generated metadata has ambiguous type evidence')
    const current = prior || { kind: entry.kind, references: [] }
    current.references.push(...entry.references)
    generated.set(file, current)
  }
  const canonical = new Map(), changed = new Set()
  for (const [file, entry] of generated) {
    let bytes = readExact(file, rawFiles.get(file)), text = bytes.toString('utf8')
    if (!Buffer.from(text, 'utf8').equals(bytes)) fail('PROVIDER_IDENTITY_MISMATCH', 'Hermes generated metadata is not UTF-8')
    const counts = new Map()
    for (const reference of entry.references) counts.set(reference, (counts.get(reference) || 0) + 1)
    for (const [reference, count] of [...counts].sort(([a], [b]) => b.length - a.length || a.localeCompare(b))) {
      // Relative .pth entries are stable as written.  Only an absolute path is
      // an installation-root reference eligible for the portable projection.
      if (entry.kind === 'editable-pth' && !path.isAbsolute(reference)) continue
      const replacement = logicalReference(reference, entry.kind)
      text = entry.kind === 'editable-pth'
        ? replacePthPath(text, reference, replacement, count)
        : replaceQuoted(text, reference, replacement, count)
    }
    const next = Buffer.from(text, 'utf8')
    if (!next.equals(bytes)) { canonical.set(file, next); changed.add(file) }
  }
  // pip/setuptools console scripts differ only by their absolute venv Python
  // shebang.  Treat that first-line reference as generated only when it names
  // this launcher's sibling interpreter and resolves to the captured one.
  for (const [file, hash] of rawFiles) {
    const root = rootFor(file)
    if (root?.logicalPath !== 'hermes/bin') continue
    const bytes = readExact(file, hash), lineEnd = bytes.indexOf(0x0a)
    if (lineEnd < 0) continue
    const line = bytes.subarray(0, lineEnd).toString('utf8')
    const match = /^#!([^\r\n\s]+)\r?$/.exec(line)
    if (!match || !path.isAbsolute(match[1]) || path.resolve(match[1]) !== path.resolve(captured.interpreter) ||
        path.resolve(path.dirname(match[1])) !== path.resolve(path.dirname(executable))) continue
    let resolved
    try { resolved = fs.realpathSync.native(match[1]) } catch { fail('PROVIDER_IDENTITY_MISMATCH', 'Hermes generated launcher interpreter is unavailable') }
    if (resolved !== interpreter) fail('PROVIDER_IDENTITY_MISMATCH', 'Hermes generated launcher interpreter differs from the captured interpreter')
    const replacement = `@autoprompt-hermes-root/hermes/bin/${path.basename(match[1])}`
    const next = Buffer.concat([Buffer.from(`#!${replacement}${line.endsWith('\r') ? '\r' : ''}\n`, 'utf8'), bytes.subarray(lineEnd + 1)])
    canonical.set(file, next); changed.add(file)
  }
  // RECORD still binds the generated files above.  Validate its raw hashes and
  // sizes before substituting only those two fields with the canonical bytes.
  for (const [file, hash] of rawFiles) {
    const root = rootFor(file)
    if (!root?.logicalPath.startsWith('python/') || path.basename(file) !== 'RECORD' || !path.basename(path.dirname(file)).endsWith('.dist-info')) continue
    const bytes = readExact(file, hash), text = bytes.toString('utf8')
    if (!Buffer.from(text, 'utf8').equals(bytes)) fail('PROVIDER_IDENTITY_MISMATCH', 'Hermes RECORD metadata is not UTF-8')
    let touched = false
    const next = text.replace(/^([^,\r\n]+),sha256=([A-Za-z0-9_-]+),(\d+)(\r?)$/gm, (line, recordedPath, recordedHash, recordedSize, cr) => {
      let target
      // RECORD paths are relative to the distribution installation root
      // (site-packages), not to the .dist-info directory containing RECORD.
      try { target = fs.realpathSync.native(path.resolve(root.path, recordedPath)) } catch { return line }
      const replacement = canonical.get(target)
      if (!replacement) return line
      const raw = rawFiles.get(target)
      const expectedHash = Buffer.from(raw, 'hex').toString('base64url')
      if (recordedHash !== expectedHash || Number(recordedSize) !== readExact(target, raw).length) {
        fail('PROVIDER_IDENTITY_MISMATCH', 'Hermes RECORD does not bind its generated metadata bytes')
      }
      touched = true
      return `${recordedPath},sha256=${sha256(replacement, 'hex')},${replacement.length}${cr}`
    })
    if (touched) { canonical.set(file, Buffer.from(next, 'utf8')); changed.add(file) }
  }
  const logical = new Map(), add = (label, hash) => {
    if (!validLabel(label) || !/^[a-f0-9]{64}$/.test(hash)) fail('PROVIDER_IDENTITY_MISMATCH', 'Hermes portable dependency record is invalid')
    if (logical.has(label)) fail('PROVIDER_IDENTITY_MISMATCH', 'Hermes portable dependency record is ambiguous')
    logical.set(label, hash)
  }
  add(`hermes/launcher/${path.basename(launcher)}`, sha256(canonical.get(launcher) || readExact(launcher, rawFiles.get(launcher))))
  add(`python/interpreter/${path.basename(interpreter)}`, executableSha256(interpreter))
  for (const link of linkBindings) {
    if (!validLabel(link.logicalPath) || !rawFiles.has(link.target) || link.targetSha256 !== rawFiles.get(link.target) || !/^[a-f0-9]{64}$/.test(link.targetSha256 || '')) fail('PROVIDER_IDENTITY_MISMATCH', 'Hermes Python symlink binding is invalid')
    add(link.logicalPath, sha256(JSON.stringify({ logicalPath: link.logicalPath, target: link.target, targetSha256: link.targetSha256 })))
  }
  const excluded = new Set([launcher, interpreter])
  for (const [file, hash] of captured.files) {
    if (excluded.has(file)) continue
    const root = rootFor(file)
    if (!root) {
      // Debian's interpreter injects this executable sitecustomize module
      // outside sysconfig's stdlib root. It is an OS runtime file, not an
      // editable path, so bind its stable system-relative location and bytes.
      if (!/^\/(?:etc|usr)\//.test(file)) fail('PROVIDER_IDENTITY_MISMATCH', 'Hermes Python dependency file has no portable logical root')
      add(`python/system/${file.slice(1).split(path.sep).join('/')}`, hash)
      continue
    }
    const relative = path.relative(root.path, file).split(path.sep).join('/')
    if (relative.startsWith('../') || relative.includes('/../')) fail('PROVIDER_IDENTITY_MISMATCH', 'Hermes Python dependency escaped its logical root')
    add(`${root.logicalPath}${relative ? `/${relative}` : ''}`, canonical.has(file) ? sha256(canonical.get(file)) : hash)
  }
  const files = [...logical].sort(([a], [b]) => a.localeCompare(b))
  if (files.length !== captured.files.length + linkBindings.length) fail('PROVIDER_IDENTITY_MISMATCH', 'Hermes portable dependency inventory is incomplete')
  const body = { schemaVersion: 1, provider: 'hermes', platform: process.platform, architecture: process.arch, files }
  return Object.freeze({ ...body, sha256: sha256(JSON.stringify(body)), fileCount: files.length, packageCount: captured.inventory.packageCount })
}
function isolatedEnvironment(root, environment = {}, credentials = {}, options = {}) {
  const windows = (options.platform || process.platform) === 'win32'
  if (windows) environment = require('../agents/codex/workflow/process-owner.js').normalizeWindowsChildEnvironment(environment)
  const result = {}
  // Explicit allowlist: NODE_OPTIONS, plugin paths, shell startup files, and all
  // inherited provider configuration overrides must not reach the child.
  for (const key of ['PATH', windows ? 'SYSTEMROOT' : 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL', 'TZ', 'TERM', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'GIT_CONFIG_COUNT', ...(windows ? ['AUTOPROMPT_WINDOWS_BASH'] : [])]) {
    if (typeof environment[key] === 'string') result[key] = environment[key]
  }
  // Preserve controller-owned Git safety projection, but no user Git config.
  if (/^\d+$/.test(result.GIT_CONFIG_COUNT || '')) for (let i = 0; i < Number(result.GIT_CONFIG_COUNT); i++) for (const suffix of ['KEY', 'VALUE']) {
    const key = `GIT_CONFIG_${suffix}_${i}`
    if (typeof environment[key] === 'string') result[key] = environment[key]
  }
  Object.assign(result, credentials, { HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'), XDG_STATE_HOME: path.join(root, 'state'), XDG_CACHE_HOME: path.join(root, 'cache'), TMPDIR: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'), TEMP: path.join(root, 'tmp'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig') })
  for (const dir of [root, result.XDG_CONFIG_HOME, result.XDG_DATA_HOME, result.XDG_STATE_HOME, result.XDG_CACHE_HOME, result.TMPDIR]) privateDirectory(dir)
  if (!fs.existsSync(result.GIT_CONFIG_GLOBAL)) writePrivate(result.GIT_CONFIG_GLOBAL, '')
  return result
}
function packageEvidence(packageRoot, expectedName, version) {
  let manifest
  try { manifest = JSON.parse(readBound(path.join(packageRoot, 'package.json')).toString('utf8')) } catch {
    fail('PROVIDER_UNSUPPORTED', `DeepSeek SDK package metadata is unreadable: ${expectedName}`)
  }
  if (manifest.name !== expectedName || manifest.version !== version) {
    fail('PROVIDER_UNSUPPORTED', 'DeepSeek SDK package set does not match the probed CLI', {
      expectedName, expectedVersion: version, actualName: manifest.name, actualVersion: manifest.version,
    })
  }
  return manifest
}
function deepseekPackageRoot(executable) {
  let current = path.dirname(executable)
  for (let depth = 0; depth < 8; depth++) {
    const manifest = path.join(current, 'package.json')
    if (fs.existsSync(manifest)) {
      try {
        if (JSON.parse(readBound(manifest)).name === '@deepseek-ai/dsh') return current
      } catch { /* Keep walking; the final refusal names the missing official package. */ }
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  fail('PROVIDER_UNSUPPORTED', 'DeepSeek CLI is not bound to a readable official @deepseek-ai/dsh package')
}
function deepseekSdkCapabilityEvidence(binding, version) {
  const executable = executableRuntimePath(binding)
  const dshRoot = deepseekPackageRoot(executable)
  const scopeRoot = path.dirname(dshRoot)
  const packages = [
    'dsh', 'dsh-sdk-protocol', 'dsh-sdk-jsonrpc-server', 'dsh-sdk-minimal',
    'dsh-agent', 'dsh-session', 'dsh-token-meter', 'dsh-llm-deepseek',
  ]
  const versions = {}
  for (const name of packages) {
    const root = name === 'dsh' ? dshRoot : path.join(scopeRoot, name)
    const manifest = packageEvidence(root, `@deepseek-ai/${name}`, version)
    versions[manifest.name] = manifest.version
  }
  const evidenceFiles = {
    protocol: path.join(scopeRoot, 'dsh-sdk-protocol/lib/types/types.d.ts'),
    server: path.join(scopeRoot, 'dsh-sdk-jsonrpc-server/lib/index.js'),
    profile: path.join(scopeRoot, 'dsh-sdk-minimal/cordis.patch.yml'),
    agent: path.join(scopeRoot, 'dsh-agent/lib/types/index.d.ts'),
    session: path.join(scopeRoot, 'dsh-session/lib/types/types.d.ts'),
    tokenMeter: path.join(scopeRoot, 'dsh-token-meter/lib/types/turn-usage.js'),
    adapter: path.join(scopeRoot, 'dsh-llm-deepseek/lib/index.js'),
  }
  const text = {}, hashes = []
  for (const [name, file] of Object.entries(evidenceFiles)) {
    let bytes
    try { bytes = readBound(file) } catch { fail('PROVIDER_UNSUPPORTED', `DeepSeek SDK capability source is unreadable: ${name}`) }
    if (bytes.length > 4 * 1024 * 1024) fail('PROVIDER_UNSUPPORTED', `DeepSeek SDK capability source is unexpectedly large: ${name}`)
    text[name] = bytes.toString('utf8'); hashes.push(sha256(bytes))
  }
  const executableText = readBound(executable).toString('utf8')
  let launcher = /import\("\.\/(profile-boot-[A-Za-z0-9_-]+\.js)"\)/.exec(executableText)?.[1]
  if (!launcher) fail('PROVIDER_UNSUPPORTED', 'DeepSeek executable does not identify its process-shutdown module')
  let launch = ''
  const visitedLaunchers = new Set()
  for (let depth = 0; depth < 4; depth++) {
    if (visitedLaunchers.has(launcher)) fail('PROVIDER_UNSUPPORTED', 'DeepSeek process-shutdown module chain is cyclic')
    visitedLaunchers.add(launcher)
    const launcherBytes = readBound(path.join(dshRoot, 'lib', launcher))
    if (launcherBytes.length > 4 * 1024 * 1024) fail('PROVIDER_UNSUPPORTED', 'DeepSeek process-shutdown source is unexpectedly large')
    launch = launcherBytes.toString('utf8'); hashes.push(sha256(launcherBytes))
    if (launch.includes('process.on("SIGTERM"')) break
    const delegated = /from\s+["']\.\/(profile-boot-[A-Za-z0-9_-]+\.js)["']/.exec(launch)?.[1]
    if (!delegated) fail('PROVIDER_UNSUPPORTED', 'DeepSeek process-shutdown module does not expose its bounded implementation')
    launcher = delegated
  }

  // These are exact observations over the installed official SDK implementation,
  // not admission claims. A missing marker refuses the probe instead of turning
  // absence into a guessed capability value.
  const required = [
    [text.protocol, "'session/prompt'", 'SDK session/prompt request'],
    [text.protocol, "'session.event'", 'SDK session.event notification'],
    [text.server, 'ctx.on("session/event"', 'full session event forwarding'],
    [text.server, 'this.ctx.agents.create({', 'fresh SDK session creation'],
    [text.agent, 'resume(options:', 'native core resume API'],
    [text.session, "'tool/call'", 'tool call log event'],
    [text.session, "'tool/result'", 'tool result log event'],
    [text.tokenMeter, 'deriveTurnTokenUsage(events)', 'exact turn usage fold'],
    [text.adapter, 'prompt_cache_hit_tokens', 'DeepSeek cache usage mapping'],
    [text.adapter, 'stream_options: { include_usage: true }', 'provider usage streaming'],
    [text.profile, 'mode: danger-full-access', 'sdk-minimal sandbox mode'],
    [text.profile, "name: '@deepseek-ai/dsh-tool-bash-persistent'", 'sdk-minimal shell tool'],
    [text.profile, "name: '@deepseek-ai/dsh-tool-str-replace-editor'", 'sdk-minimal editor tool'],
    [launch, 'process.on("SIGTERM"', 'bounded SIGTERM shutdown'],
    [launch, 'await app.current?.fiber.dispose()', 'whole-tree shutdown drain'],
  ]
  for (const [source, marker, label] of required) if (!source.includes(marker)) {
    fail('PROVIDER_UNSUPPORTED', `DeepSeek SDK capability marker is missing: ${label}`)
  }
  const sdkResumeRequest = /['"]session\/(?:resume|continue)['"]/.test(text.protocol)
  const serverUsesResume = /this\.ctx\.agents\.resume\s*\(/.test(text.server)
  if (sdkResumeRequest || serverUsesResume) {
    fail('PROVIDER_UNSUPPORTED', 'DeepSeek SDK continuation surface changed; the fail-closed capability record must be revalidated')
  }
  return Object.freeze({
    packageVersions: Object.freeze(versions),
    evidenceHashes: Object.freeze(hashes),
    facts: Object.freeze({
      callerSuppliedSessionId: true,
      fullSessionEventStream: true,
      toolCallAndResultEvents: true,
      providerReportedExactUsage: true,
      gracefulProcessDrain: true,
      nativeCoreResumeApi: true,
      sdkCrossProcessContinuation: false,
      sdkAutopromptOnlyTools: false,
      sdkSafeSandbox: false,
      sdkDefaultSandboxMode: 'danger-full-access',
      sdkDefaultTools: Object.freeze(['bash', 'str_replace_editor']),
    }),
    blockers: Object.freeze(['SDK_CROSS_PROCESS_CONTINUATION_UNAVAILABLE', 'SDK_AUTOPROMPT_ONLY_TOOLS_UNAVAILABLE', 'SDK_SAFE_SANDBOX_UNAVAILABLE']),
  })
}
function probeExecutable(options = {}) {
  const d = descriptor(options.provider)
  const binding = locateExecutable(options)
  const timeout = options.timeoutMs ?? 30000
  if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 120000) fail('PROVIDER_UNSUPPORTED', 'Native probe timeout must be bounded between 1 and 120 seconds')
  const probeRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-native-probe-')))
  try {
    const env = isolatedEnvironment(probeRoot, options.env || process.env)
    const spawn = options.spawnSync || cp.spawnSync
    const invoke = argv => {
      const vscodeCli = path.join(path.dirname(binding.path), 'resources/app/out/cli.js')
      const nativeArgv = options.provider === 'vscode' && fs.existsSync(vscodeCli) ? [vscodeCli, ...argv] : argv
      const nativeEnv = nativeArgv === argv ? env : { ...env, ELECTRON_RUN_AS_NODE: '1' }
      const launch = executableInvocation(binding, nativeArgv)
      const result = spawn(launch.executable, launch.argv, { cwd: probeRoot, env: nativeEnv, shell: false, encoding: 'utf8', timeout, maxBuffer: 1024 * 1024, windowsHide: true })
      if (result.error || result.status !== 0 || result.signal) fail('PROVIDER_UNSUPPORTED', `${d.command} capability probe failed`, { argv, status: result.status, code: result.error?.code })
      return `${result.stdout || ''}\n${result.stderr || ''}`
    }
    const versionText = invoke(['--version'])
    if (/\bcodex\b/i.test(versionText)) fail('PROVIDER_IDENTITY_MISMATCH', 'Executable identifies itself as Codex')
    const version = /(?:^|[^A-Za-z0-9])v?(\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)(?=$|[^A-Za-z0-9.+-])/.exec(versionText)?.[1]
    if (!version) fail('PROVIDER_UNSUPPORTED', `${d.command} did not report a recognizable native version`)
    if (d.versions.length && !d.versions.includes(version)) {
      fail('PROVIDER_UNSUPPORTED', `${d.command} ${version} has not been verified for this native transport`, { version, supportedVersions: [...d.versions] })
    }
    const help = invoke(d.helpArgs)
    const missing = d.flags.filter(flag => !help.includes(flag))
    if (missing.length) fail('PROVIDER_UNSUPPORTED', `${d.command} lacks the required native CLI interface`, { missing, version })
    const deepseekSdk = options.provider === 'deepseek' ? deepseekSdkCapabilityEvidence(binding, version) : null
    executableInvocation(binding)
    const identityEnvironment = options.env || process.env
    let runtimeIdentity, portableRuntimeIdentity
    if (options.provider === 'hermes') {
      // One Python enumeration feeds both the legacy local binding and the
      // portable projection, avoiding a racy second filesystem walk.
      const captured = hermesPythonDependencyInventory(binding.path, identityEnvironment)
      runtimeIdentity = hermesRuntimeDependencyIdentity(binding.path, identityEnvironment, captured)
      portableRuntimeIdentity = hermesPortableRuntimeDependencyIdentity(binding.path, identityEnvironment, captured)
    } else {
      const runtimePath = executableRuntimePath(binding)
      runtimeIdentity = runtimeDependencyIdentity(runtimePath, identityEnvironment, binding.invocation)
      portableRuntimeIdentity = portableRuntimeDependencyIdentity(options.provider, runtimePath, identityEnvironment, binding.invocation)
    }
    return Object.freeze({ ...binding, version, runtimeIdentity,
      portableRuntimeIdentity: portableRuntimeIdentity, portableRuntimeIdentity, portableRuntimeIdentityStatus: 'AVAILABLE',
      evidenceHashes: [sha256(versionText), sha256(help), ...(deepseekSdk?.evidenceHashes || [])],
      capabilities: Object.freeze({ cliInterface: true, protocol: d.protocol, conformance: 'NOT_TESTED',
        blockers: [...d.blockers],
        sandbox: 'REQUIRES_CONTROLLER_BOUNDARY',
        exactUsage: 'REQUIRES_NATIVE_REQUEST_EVIDENCE',
        ...(deepseekSdk ? {
          eventStream: 'OWNED_SDK_SESSION_EVENT',
          continuation: 'OWNED_SDK_CORE_RESUME',
          controlledTools: 'OWNED_SDK_FIXED_TOOLS',
          processDrain: 'SDK_SHUTDOWN_AND_SIGNAL_BOUNDED',
        } : {}),
        ...(deepseekSdk ? { deepseekSdk } : {}) }) })
  } finally { fs.rmSync(probeRoot, { recursive: true, force: true }) }
}
function safeString(value, name) {
  if (typeof value !== 'string' || !value || value.includes('\0') || /[\r\n]/.test(value)) fail('PROFILE_INVALID', `Invalid connection field: ${name}`)
  return value
}
function validateEffort(provider, effort) {
  descriptor(provider)
  if (effort === undefined || effort === null) return undefined
  if (provider === 'claude' && ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) return effort
  if ((provider === 'opencode' || provider === 'kilo') && ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) return effort
  if ((provider === 'prime' || provider === 'omp') && ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) return effort
  if (provider === 'deepseek' && ['off', 'low', 'high', 'max'].includes(effort)) return effort
  if (provider === 'hermes' && ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort)) return effort
  if (provider === 'grok' && ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) return effort
  if (provider === 'vscode' && ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(effort)) return effort
  fail('PROFILE_INVALID', `${provider} has no verified mapping for reasoning effort ${String(effort)}`)
}
function safeUrl(value, name) {
  const text = safeString(value, name)
  let url
  try { url = new URL(text) } catch { fail('PROFILE_INVALID', `Invalid connection URL: ${name}`) }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) fail('PROFILE_INVALID', `Invalid connection URL: ${name}`)
  return text
}
function sanitizeConnection(provider, source = {}) {
  const d = descriptor(provider)
  if (provider === 'vscode') return require('./harness-v2-vscode-config.cjs').sanitize(source)
  if (provider === 'hermes') return require('./harness-v2-hermes.cjs').sanitizeConnection(source)
  if (provider === 'grok') return require('./harness-v2-grok.cjs').sanitizeConnection(source)
  if (provider === 'prime' || provider === 'omp') return require('./harness-v2-pi-config.cjs').sanitize(provider, source)
  if (!source || typeof source !== 'object' || Array.isArray(source)) fail('PROFILE_INVALID', 'Native connection must be an object')
  const result = { provider, environment: {} }
  for (const key of ['model', 'modelProvider']) if (source[key] !== undefined) result[key] = safeString(source[key], key)
  for (const key of d.urls) if (source.environment?.[key] !== undefined) result.environment[key] = safeUrl(source.environment[key], key)
  // OpenCode/Kilo config provider identifiers and the built-in SDK allowlist
  // are data. Arbitrary npm providers execute code and are never imported.
  if (source.providers || source.provider && typeof source.provider === 'object') {
    const providers = source.providers || source.provider
    if (!providers || typeof providers !== 'object' || Array.isArray(providers)) fail('PROFILE_INVALID', 'Model providers must be an object')
    result.providers = {}
    for (const [id, value] of Object.entries(providers)) {
      if (!/^[a-zA-Z0-9_-]+$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id) ||
          !value || typeof value !== 'object' || Array.isArray(value)) fail('PROFILE_INVALID', 'Invalid model provider connection')
      const item = {}
      if (value.npm !== undefined) {
        if (!['@ai-sdk/openai', '@ai-sdk/openai-compatible', '@ai-sdk/anthropic'].includes(value.npm)) fail('PROFILE_INVALID', 'Custom executable model provider modules are not imported')
        item.npm = value.npm
      }
      item.options = {}
      if (value.options?.baseURL !== undefined) item.options.baseURL = safeUrl(value.options.baseURL, 'baseURL')
      if (value.options?.apiKey !== undefined) item.options.apiKey = safeString(value.options.apiKey, 'apiKey')
      if (value.models) {
        if (typeof value.models !== 'object' || Array.isArray(value.models)) fail('PROFILE_INVALID', 'Model definitions must be an object')
        item.models = {}
        for (const [id, model] of Object.entries(value.models)) {
          safeString(id, 'model id')
          if (['__proto__', 'constructor', 'prototype'].includes(id) || !model || typeof model !== 'object' || Array.isArray(model)) fail('PROFILE_INVALID', 'Invalid model definition')
          item.models[id] = {}
          for (const key of ['name', 'id']) if (typeof model[key] === 'string') item.models[id][key] = safeString(model[key], key)
          if (model.limit) {
            item.models[id].limit = {}
            for (const key of ['context', 'output']) if (Number.isSafeInteger(model.limit[key]) && model.limit[key] > 0) item.models[id].limit[key] = model.limit[key]
          }
          // Model variants are declarative request overlays. Preserve only the
          // reasoning-effort form that the native CLI consumes; profiles cannot
          // inject provider modules, commands, headers, or arbitrary request
          // bodies through this path.
          if (model.variants !== undefined) {
            if (!['opencode', 'kilo'].includes(provider) || !model.variants || typeof model.variants !== 'object' || Array.isArray(model.variants)) fail('PROFILE_INVALID', 'Model variants must be an object')
            item.models[id].variants = {}
            for (const [variantId, variant] of Object.entries(model.variants)) {
              if (!/^[a-zA-Z0-9_-]+$/.test(variantId) || ['__proto__', 'constructor', 'prototype'].includes(variantId) ||
                  !variant || typeof variant !== 'object' || Array.isArray(variant) || typeof variant.reasoningEffort !== 'string') fail('PROFILE_INVALID', 'Invalid model reasoning variant')
              item.models[id].variants[variantId] = { reasoningEffort: safeString(variant.reasoningEffort, 'reasoningEffort') }
            }
          }
        }
      }
      result.providers[id] = item
    }
  }
  return result
}
function connectionConfig(provider, root, env = process.env) {
  const d = descriptor(provider)
  if (provider === 'prime' || provider === 'omp') return require('./harness-v2-pi-config.cjs').readConnection(provider, root)
  const files = provider === 'opencode' || provider === 'kilo' ? [`${provider}.json`, 'config.json'] : ['models.json']
  let source = {}
  for (const name of files) {
    const file = path.join(root, name)
    if (!fs.existsSync(file)) continue
    try { source = JSON.parse(readBound(file).toString('utf8')) } catch { fail('PROFILE_INVALID', `Native connection config must be valid JSON: ${name}`) }
    break
  }
  const environment = {}
  for (const key of d.urls) if (env[key]) environment[key] = env[key]
  const connection = sanitizeConnection(provider, { ...source, environment })
  // This is the controller-owned production configuration boundary.  A VS
  // Code role is still bounded by the outer owned process and activation
  // deadline, but the extension's standalone 120-second default is too short
  // for a complete checker turn. Preserve any explicit operator cap.
  if (provider === 'vscode' && !Object.prototype.hasOwnProperty.call(source, 'timeoutMs')) {
    return { ...connection, timeoutMs: 600000 }
  }
  return connection
}
function credentialEnvironment(provider, connection, root, env = process.env) {
  const d = descriptor(provider)
  const result = {}
  // No shell evaluation or OAuth refresh commands. API credentials only.
  let dotenv = ''
  if (root && fs.existsSync(path.join(root, '.env'))) dotenv = readBound(path.join(root, '.env')).toString('utf8')
  const keys = [...d.credentials, ...(['prime', 'omp'].includes(provider) ? require('./harness-v2-pi-config.cjs').credentialNames(connection) : [])]
  for (const key of new Set(keys)) {
    let value = env[key]
    if (!value) {
      const match = new RegExp(`^(?:export\\s+)?${key}\\s*=\\s*(.*)$`, 'm').exec(dotenv)
      if (match) {
        value = match[1].trim()
        if (value.startsWith('"')) { try { value = JSON.parse(value) } catch { fail('PROFILE_INVALID', `Invalid quoted credential: ${key}`) } }
        else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1)
      }
    }
    if (value) result[key] = safeString(value, key)
  }
  return result
}
function declaredVariant(connection, model, effort) {
  const slash = model.indexOf('/')
  if (slash <= 0 || slash === model.length - 1) fail('PROFILE_INVALID', 'Reasoning effort requires a provider/model reference')
  const providerId = model.slice(0, slash), modelId = model.slice(slash + 1)
  const customModel = connection.providers?.[providerId]?.models?.[modelId]
  // Built-in provider catalogs validate their own variants. A supplied custom
  // provider has no catalog discovery, so require its exact declarative overlay.
  if (!customModel) return
  if (customModel.variants?.[effort]?.reasoningEffort !== effort) fail('PROFILE_INVALID', `Model ${model} has no verified ${effort} reasoning variant`)
}
function claudeCliOutputSchema(schema) {
  // Claude Code validates --json-schema with its embedded dialect resolver.
  // The controller's canonical schemas declare draft 2020-12, but that
  // declaration is metadata rather than an output constraint and the pinned
  // CLI does not have that meta-schema registered. Keep the full canonical
  // schema for controller validation and omit only the top-level declaration
  // from the CLI projection.
  const schemaMaps = new Set(['$defs', 'definitions', 'dependentSchemas', 'patternProperties', 'properties'])
  const schemaArrays = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems'])
  const schemaValues = new Set(['additionalProperties', 'contains', 'contentSchema', 'else', 'if', 'items', 'not', 'propertyNames', 'then', 'unevaluatedItems'])
  const localReference = (root, reference) => {
    if (typeof reference !== 'string' || !reference.startsWith('#/')) return null
    let current = root
    for (const encoded of reference.slice(2).split('/')) {
      const key = encoded.replaceAll('~1', '/').replaceAll('~0', '~')
      if (!current || typeof current !== 'object' || Array.isArray(current) || !Object.hasOwn(current, key)) return null
      current = current[key]
    }
    return current
  }
  const requiresObject = (value, root, references = new Set()) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    if (value.type === 'object') return true
    if (typeof value.$ref === 'string') {
      if (references.has(value.$ref)) return false
      const target = localReference(root, value.$ref)
      return target ? requiresObject(target, root, new Set([...references, value.$ref])) : false
    }
    if (Array.isArray(value.allOf) && value.allOf.some(item => requiresObject(item, root, references))) return true
    for (const keyword of ['anyOf', 'oneOf']) {
      if (Array.isArray(value[keyword]) && value[keyword].length > 0 && value[keyword].every(item => requiresObject(item, root, references))) return true
    }
    return false
  }
  const projectSchema = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value
    const projected = {}
    for (const [key, child] of Object.entries(value)) {
      // These names are removed only when they are schema keywords. A
      // property with either name, or the same text inside const/enum/example
      // data, remains literal user-domain data.
      if (key === '$schema' || key === 'unevaluatedProperties') continue
      if (schemaMaps.has(key) && child && typeof child === 'object' && !Array.isArray(child)) {
        projected[key] = Object.fromEntries(Object.entries(child).map(([name, subschema]) => [name, projectSchema(subschema)]))
      } else if (schemaArrays.has(key) && Array.isArray(child)) {
        projected[key] = child.map(projectSchema)
      } else if (schemaValues.has(key)) {
        projected[key] = Array.isArray(child) ? child.map(projectSchema) : projectSchema(child)
      } else projected[key] = structuredClone(child)
    }
    return projected
  }
  const projected = projectSchema(schema)
  // Claude's tool protocol requires a root object schema. The canonical role
  // report is a oneOf of local refs whose allOf branches each require an
  // object, so adding the already-implied root type preserves its accepted
  // values and prevents the CLI/model boundary from falling back to a string
  // `value` wrapper. The controller still validates the untouched canonical
  // schema after native capture.
  if (projected.type === undefined && requiresObject(projected, projected)) projected.type = 'object'
  return projected
}
function createLaunch(options) {
  const { provider, home, sessionRoot, prompt, input, continuationId, readOnly, targetPath } = options
  const d = descriptor(provider)
  if (d.blockers.length) fail('PROVIDER_UNSUPPORTED', `${d.command} cannot satisfy the native transport contract`, { blockers: d.blockers })
  let connection = sanitizeConnection(provider, options.connection)
  if (provider === 'vscode' && !Object.prototype.hasOwnProperty.call(options.connection || {}, 'timeoutMs')) {
    // The extension's standalone two-minute default is too short for a
    // healthy independent-checker turn.  The controller owns the outer
    // process/activation deadline; use the already reviewed ten-minute
    // connection ceiling unless this dispatch explicitly supplied a smaller
    // session cap.
    connection = { ...connection, timeoutMs: 600000 }
  }
  const env = isolatedEnvironment(home, options.environment, credentialEnvironment(provider, connection, null, options.credentials || {}))
  Object.assign(env, connection.environment)
  const model = options.model || connection.model
  const controlled = options.toolBoundary ? require('./harness-v2-controlled-tools.cjs') : null
  if (controlled) controlled.load(options.toolBoundary, provider)
  let argv, requiredResponseFormat = null, windowsTempDirectory = null
  if (provider === 'vscode') {
    argv = require('./harness-v2-vscode-config.cjs').project({ ...options, connection }, env)
  } else if (provider === 'claude') {
    const settings = path.join(home, 'settings.json')
    // The pre-route analyst has a hard zero-tool authority.  Do not merely
    // reject a later call: omitting the MCP server and its advertised tools
    // keeps that bounded control-plane request out of the provider context.
    const projection = options.toolFree === true ? null : controlled?.claudeProjection(options.toolBoundary)
    writePrivate(settings, JSON.stringify(projection?.settings || { disableAllHooks: true, enableAllProjectMcpServers: false, permissions: { deny: ['Agent', 'Task', 'Skill', 'mcp__*', ...(readOnly ? ['Write', 'Edit', 'NotebookEdit'] : [])] } }))
    const tools = readOnly ? 'Read,Glob,Grep' : 'Read,Glob,Grep,Write,Edit'
    // Bash is offered only behind an authenticated controller execution gate.
    const offered = options.toolFree === true ? '' : controlled ? '' : options.commandBoundary ? `${tools},Bash` : tools
    argv = ['--print', '--bare', '--verbose', '--output-format', 'stream-json', '--include-partial-messages', '--settings', settings, '--setting-sources', '', '--strict-mcp-config', '--mcp-config', JSON.stringify(projection?.mcp || { mcpServers: {} }), '--tools', offered, '--allowedTools', projection?.allowedTools || offered, '--permission-mode', 'dontAsk', '--system-prompt', prompt]
    if (options.outputSchema) argv.push('--json-schema', JSON.stringify(claudeCliOutputSchema(options.outputSchema)))
    const effort = validateEffort(provider, options.effort)
    if (effort) argv.push('--effort', effort)
    if (continuationId) argv.push('--resume', continuationId)
    env.CLAUDE_CONFIG_DIR = path.join(sessionRoot, 'claude')
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
    if (process.platform === 'win32') {
      // Claude 2.1.270 can stall before initialization when TEMP is a long
      // Windows path. Keep durable home/session state canonical and place only
      // transient files under cwd so the Job-owned cwd alias can shorten them.
      const cwd = path.resolve(options.cwd)
      let cwdItem, cwdReal
      try { cwdItem = fs.lstatSync(cwd); cwdReal = fs.realpathSync.native(cwd) } catch {}
      if (!cwdItem || !cwdItem.isDirectory() || cwdItem.isSymbolicLink() || cwdReal.toLowerCase() !== cwd.toLowerCase()) {
        fail('PROFILE_INVALID', 'Windows Claude temporary directory requires an existing canonical cwd')
      }
      const relativePath = `temp-${sha256(path.resolve(home)).slice(0, 32)}`
      const temporary = path.join(cwd, relativePath)
      const relative = path.relative(cwd, temporary)
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        fail('PROFILE_INVALID', 'Windows Claude temporary directory must be a strict cwd descendant')
      }
      privateDirectory(temporary)
      env.TEMP = temporary
      env.TMP = temporary
      env.TMPDIR = temporary
      const body = { schemaVersion: 1, path: temporary, relativePath }
      windowsTempDirectory = Object.freeze({ ...body, sha256: sha256(JSON.stringify(body)) })
    }
    if (options.maxTokens !== undefined) {
      if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0) fail('PROFILE_INVALID', 'Claude output token limit must be a positive integer')
      env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(options.maxTokens)
    }
  } else if (provider === 'opencode' || provider === 'kilo') {
    const tools = { read: true, glob: true, grep: true, list: true, write: !readOnly, edit: !readOnly, patch: !readOnly, bash: Boolean(options.commandBoundary) }
    const projection = options.toolFree === true ? null : controlled?.opencodeProjection(options.toolBoundary, provider)
    const permission = options.toolFree === true ? { '*': 'deny' }
      : projection?.permission || { '*': 'deny', ...Object.fromEntries(Object.entries(tools).filter(([, enabled]) => enabled).map(([name]) => [name, 'allow'])), external_directory: { '*': 'deny', [`${targetPath}/**`]: 'allow' } }
    // Native title/summary requests are not part of the run event ledger.
    // Disable them instead of silently omitting their model usage. Use one
    // permission table; deprecated `tools` overrides can reorder its rules.
    const disabledAgents = Object.fromEntries(['build', 'plan', 'general', 'explore', 'title', 'summary', 'compaction'].map(name => [name, { disable: true }]))
    const config = { ...(connection.model ? { model: connection.model } : {}), ...(connection.providers ? { provider: connection.providers } : {}), share: 'disabled', autoupdate: false, plugin: [], mcp: projection?.mcp || {}, instructions: [], lsp: false, formatter: false, compaction: { auto: false, prune: false }, permission, agent: { ...disabledAgents, autoprompt: { mode: 'primary', prompt, permission } } }
    const file = path.join(home, `${provider}.json`)
    writePrivate(file, JSON.stringify(config))
    const prefix = provider.toUpperCase()
    env[`${prefix}_CONFIG`] = file
    env[`${prefix}_CONFIG_DIR`] = path.join(home, 'native-config')
    env[`${prefix}_DISABLE_PROJECT_CONFIG`] = 'true'
    // State survives exact continuation, config remains dispatch-specific.
    env.XDG_DATA_HOME = path.join(sessionRoot, 'data')
    env.XDG_STATE_HOME = path.join(sessionRoot, 'state')
    argv = ['run', '--format', 'json', '--agent', 'autoprompt']
    const effort = validateEffort(provider, options.effort)
    if (effort) {
      declaredVariant(connection, model, effort)
      argv.push('--variant', effort)
    }
    if (continuationId) argv.push('--session', continuationId)
  } else if (provider === 'deepseek') {
    if (!controlled || !options.executable) fail('PROVIDER_UNSUPPORTED', 'DeepSeek requires its bound official SDK and owned tool projection')
    const effort = validateEffort(provider, options.effort)
    const packageRoot = path.dirname(deepseekPackageRoot(options.executable))
    const file = path.join(home, 'owned.patch.json')
    const sessionId = continuationId || crypto.randomUUID()
    writePrivate(file, JSON.stringify([
      ...['sdk-app-startup', 'sdk-jsonrpc-server', 'persistent-bash', 'persistent-pwsh', 'str-replace-editor', 'llm-retry', 'session-log-deepseek', 'plugin-package-inventory-deepseek'].map(id => ({ id, disabled: true })),
      { insert: [{ id: 'autoprompt-owned-sdk', name: require.resolve('./harness-v2-bridge/deepseek/plugin.cjs'), config: {
        packageRoot, oneShot: true, sessionId, input,
        initialize: { cwd: options.cwd, provider: connection.modelProvider || 'deepseek-official', model: model || 'deepseek-chat', outputSchema: options.outputSchema, ...(effort ? { reasoningEffort: effort } : {}), ...(continuationId ? { resumeSessionId: continuationId } : {}) },
      } }] },
    ]))
    env.DSH_HOME = path.join(sessionRoot, 'dsh')
    env.DSH_SYSTEM_PROMPT = prompt
    env.DSH_TELEMETRY_DISABLED = '1'
    env.AUTOPROMPT_TOOL_POLICY = options.toolBoundary.policyPath
    env.AUTOPROMPT_TOOL_POLICY_SHA256 = options.toolBoundary.policySha256
    argv = ['--profile', 'sdk-minimal', '--patch', file]
  } else if (provider === 'hermes') {
    if (!controlled || !options.executable) fail('PROVIDER_UNSUPPORTED', 'Hermes requires the fixed controller-owned tool projection')
    const effort = validateEffort(provider, options.effort)
    const credentials = credentialEnvironment(provider, connection, null, options.credentials || {})
    const apiKey = require('./harness-v2-hermes.cjs').selectApiKey(options.providerConnectionIdentity?.environment?.HERMES_BASE_URL || connection.environment?.HERMES_BASE_URL, credentials)
    if (!apiKey) fail('PROFILE_INVALID', 'Hermes BYOK requires an explicit API key')
    const promptFile = path.join(home, 'prompt.json')
    // Hermes has one user query channel (`--query-file`) rather than a
    // separately verified system-prompt flag. Keep the controller projection
    // and its original mission payload in the same authenticated file so the
    // role instructions, closed result schema, and request binding are visible
    // to the model without replacing the user's assignment.
    writePrivate(promptFile, `${prompt}\n\nController assignment payload:\n${input}`)
    // Never execute ambient or pre-existing Python bytecode. A fresh private
    // cache per reservation forces Python to compile the exact source files
    // bound by hermesRuntimeDependencyIdentity, while keeping the cache out of
    // the persistent Hermes session state.
    const pythonCache = path.join(home, 'python-cache')
    privateDirectory(pythonCache)
    env.PYTHONPYCACHEPREFIX = pythonCache
    const launcher = readBound(options.executable).subarray(0, 512).toString('utf8')
    const pythonExecutable = hermesClosureRuntime(options.executable)?.python || /^#!([^\r\n\s]+)/.exec(launcher)?.[1]
    if (!pythonExecutable || !path.isAbsolute(pythonExecutable)) fail('PROVIDER_UNSUPPORTED', 'Hermes launcher does not bind an absolute Python interpreter')
    const configuredMaxTokens = connection.maxTokens
    const maxTokens = options.maxTokens === undefined ? configuredMaxTokens : Math.min(options.maxTokens, configuredMaxTokens || options.maxTokens)
    const prepared = require('./harness-v2-hermes.cjs').prepare({ home, sessionRoot, toolBoundary: options.toolBoundary,
      model: model || connection.model, baseUrl: connection.environment?.HERMES_BASE_URL, apiKey, promptFile,
      hermesExecutable: options.executable, pythonExecutable, effort,
      continuationId, maxTurns: options.maxTurns, stateHome: sessionRoot, maxTokens })
    Object.assign(env, prepared.env)
    // The owned proxy serializes stdin as a required string field even though
    // Hermes receives its query through --query-file. An omitted value makes
    // the proxy request invalid before the native child can start.
    return { argv: prepared.argv, env, stdin: '', cwd: options.cwd, shell: false, executable: process.execPath }
  } else if (provider === 'grok') {
    if (!controlled || !options.executable) fail('PROVIDER_UNSUPPORTED', 'Grok requires the controller-owned relay and tool projection')
    const grok = require('./harness-v2-grok.cjs')
    const effort = validateEffort(provider, options.effort)
    const credentials = credentialEnvironment(provider, connection, null, options.credentials || {})
    const apiKey = grok.selectApiKey(connection.environment?.GROK_BASE_URL, credentials)
    if (!apiKey) fail('PROFILE_INVALID', 'Grok BYOK requires an explicit API key')
    if (!connection.environment?.GROK_BASE_URL) fail('PROFILE_INVALID', 'Grok BYOK requires an explicit upstream base URL')
    const proxyToken = options.proxyToken || crypto.randomBytes(32).toString('hex')
    if (!/^[a-f0-9]{64}$/u.test(proxyToken)) fail('PROFILE_INVALID', 'Grok proxy capability is invalid')
    const relayToken = crypto.randomBytes(32).toString('hex')
    // The persistent native state is deliberately narrower than the controller
    // context root. Issued-call history remains outside this writable HOME.
    const sessionHome = path.join(sessionRoot, 'grok-home')
    const prepared = grok.prepare({ sessionHome, toolBoundary: options.toolBoundary,
      executable: options.executable, model: model || connection.model,
      baseUrl: 'http://127.0.0.1:19777/v1', proxyToken, prompt, input,
      continuationId, effort, outputSchema: options.outputSchema, maxCompletionTokens: options.maxCompletionTokens })
    for (const key of descriptor(provider).credentials) delete env[key]
    delete env.GROK_BASE_URL
    return { argv: prepared.argv, env: {}, stdin: '', cwd: options.cwd, shell: false,
      grok: Object.freeze({ sessionHome, model: model || connection.model,
        proxyToken, relayToken, upstreamUrl: grok.upstreamChatCompletionsUrl(connection.environment?.GROK_BASE_URL),
        upstreamAuthorization: `Bearer ${apiKey}`, allowedMcpTools: prepared.allowedMcpTools,
        issuedCalls: options.issuedCalls || [], toolBoundary: options.toolBoundary,
        executable: options.executable, toolRuntimeRoot: path.resolve(__dirname, '..'),
        readOnlyRoots: options.toolBoundary.policy.readableRoots,
        writableRoots: options.toolBoundary.policy.writableRoots }), }
  } else if (controlled) {
    const effort = validateEffort(provider, options.effort)
    const pi = require('./harness-v2-pi-config.cjs').project({ ...options, connection, effort }, env)
    argv = pi.argv
    requiredResponseFormat = pi.requiredResponseFormat
  } else {
    argv = ['--print', '--mode', 'json', '--no-extensions', '--no-skills', '--system-prompt', prompt, '--session-dir', path.join(sessionRoot, 'sessions')]
    if (provider === 'prime') {
      // IPython includes the rlm child-spawn API. Never expose it merely because
      // an outer filesystem sandbox is available.
      argv.push('--no-tools', '--no-context-files', '--no-prompt-templates', '--offline')
      env.PRIME_AGENT_CODING_AGENT_DIR = path.join(home, 'prime')
    } else {
      argv.push('--no-rules', '--no-lsp', '--no-pty', '--tools', `${readOnly ? 'read,grep,find,ls' : 'read,grep,find,ls,write,edit'}${options.commandBoundary ? ',bash' : ''}`)
      env.PI_CODING_AGENT_DIR = path.join(home, 'omp')
    }
    if (continuationId) argv.push('--resume', continuationId)
    if (connection.modelProvider) argv.push('--provider', connection.modelProvider)
  }
  if (model && !['deepseek', 'vscode'].includes(provider)) argv.push('--model', safeString(model, 'model'))
  return { argv, env, stdin: input, cwd: options.cwd, shell: false,
    ...(windowsTempDirectory ? { windowsTempDirectory } : {}),
    ...(requiredResponseFormat ? { requiredResponseFormat } : {}) }
}
module.exports = { runtimeDependencyIdentity, portableRuntimeDependencyIdentity, hermesPythonDependencyInventory, hermesRuntimeDependencyIdentity, hermesPortableRuntimeDependencyIdentity, validateEffort, PROVIDERS, HarnessError, fail, descriptor, locateExecutable, executableSha256, executableRuntimePath, executableInvocation, probeExecutable, deepseekSdkCapabilityEvidence, connectionConfig, sanitizeConnection, credentialEnvironment, isolatedEnvironment, createLaunch, readBound, sha256, privateDirectory, writePrivate }
