#!/usr/bin/env node
'use strict'

// Development evidence only. This program cannot issue or install admission.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const cp = require('node:child_process')
const ROOT = path.resolve(__dirname, '..')
const PROVIDERS = Object.freeze({
  codex: { command: 'codex', help: ['exec', '--help'], flags: ['--json', '--output-schema', '--sandbox'] },
  claude: { command: 'claude', help: ['--help'], flags: ['--output-format', '--resume', '--strict-mcp-config'] },
  opencode: { command: 'opencode', help: ['run', '--help'], flags: ['--format', '--session'] },
  kilo: { command: 'kilo', help: ['run', '--help'], flags: ['--format', '--session'] },
  vscode: { command: 'code', help: ['--help'], flags: ['--user-data-dir', '--extensions-dir'] },
  prime: { command: 'prime-agent', help: ['--help'], flags: ['--mode', '--resume', '--session-dir'] },
  omp: { command: 'omp', help: ['--help'], flags: ['--mode', '--session'] },
  deepseek: { command: 'dsh', help: ['--help'], flags: ['--profile'] },
  hermes: { command: 'hermes', help: ['chat', '--help'], flags: ['--query-file', '--oneshot', '--resume', '--reasoning'] },
  grok: { command: 'grok', help: ['--help'], flags: ['-p', '--output-format', '--resume', '--model', '--tools'] },
  reasonix: { command: 'reasonix', help: ['run', '--help'], flags: ['--output-format', '--resume', '--dir', '--max-steps', '--permission-mode'] },
})
const CAPABILITIES = ['isolation', 'topologyEnforcement', 'privateSkillRoot', 'eventStreaming', 'toolOutputCapture', 'stableChildIdentity', 'sameContextContinuation', 'cancellation', 'isolatedChecking', 'processOwnership', 'modelRouting']
// Register actual-binary suites explicitly. A protocol parser fixture, a skipped
// native test, or an unrelated test's passing totals cannot satisfy this check.
const CLOSED_NATIVE_SUITES = {
  "vscode": {
  "file": "tests/source/harness-v2-vscode-capability-native.test.cjs",
  "cases": [
    "vscode native capability isolation",
    "vscode native capability topologyEnforcement",
    "vscode native capability privateSkillRoot",
    "vscode native capability eventStreaming",
    "vscode native capability toolOutputCapture",
    "vscode native capability stableChildIdentity",
    "vscode native capability sameContextContinuation",
    "vscode native capability cancellation",
    "vscode native capability isolatedChecking",
    "vscode native capability processOwnership",
    "vscode native capability modelRouting"
  ],
  "capabilityCases": {
    "isolation": "vscode native capability isolation",
    "topologyEnforcement": "vscode native capability topologyEnforcement",
    "privateSkillRoot": "vscode native capability privateSkillRoot",
    "eventStreaming": "vscode native capability eventStreaming",
    "toolOutputCapture": "vscode native capability toolOutputCapture",
    "stableChildIdentity": "vscode native capability stableChildIdentity",
    "sameContextContinuation": "vscode native capability sameContextContinuation",
    "cancellation": "vscode native capability cancellation",
    "isolatedChecking": "vscode native capability isolatedChecking",
    "processOwnership": "vscode native capability processOwnership",
    "modelRouting": "vscode native capability modelRouting"
  }
},
  "claude": {
    "file": "tests/source/harness-v2-claude-capability-native.test.cjs",
    "cases": [
      "claude closed native capability: isolation denies candidate/private/network while allowing scratch",
      "claude closed native capability: topology rejects injected nested dispatch and permits only its controller edge",
      "claude closed native capability: private skill root and ambient project configuration stay outside the model",
      "claude closed native capability: intermediate stream events remain correlated to the native session",
      "claude closed native capability: exact controller tool receipt binds the real command output",
      "claude closed native capability: concurrently owned siblings receive separate native identities",
      "claude closed native capability: same-context continuation succeeds while foreign target reuse is refused",
      "claude closed native capability: cancellation drains the held child and a sibling remains operational",
      "claude closed native capability: isolated checker receives read-only candidate and private scratch",
      "claude closed native capability: process ownership records completion and recovers a fresh session",
      "claude closed native capability: exact model effort is wired and unsupported assignment is refused"
    ],
    "capabilityCases": {
      "isolation": "claude closed native capability: isolation denies candidate/private/network while allowing scratch",
      "topologyEnforcement": "claude closed native capability: topology rejects injected nested dispatch and permits only its controller edge",
      "privateSkillRoot": "claude closed native capability: private skill root and ambient project configuration stay outside the model",
      "eventStreaming": "claude closed native capability: intermediate stream events remain correlated to the native session",
      "toolOutputCapture": "claude closed native capability: exact controller tool receipt binds the real command output",
      "stableChildIdentity": "claude closed native capability: concurrently owned siblings receive separate native identities",
      "sameContextContinuation": "claude closed native capability: same-context continuation succeeds while foreign target reuse is refused",
      "cancellation": "claude closed native capability: cancellation drains the held child and a sibling remains operational",
      "isolatedChecking": "claude closed native capability: isolated checker receives read-only candidate and private scratch",
      "processOwnership": "claude closed native capability: process ownership records completion and recovers a fresh session",
      "modelRouting": "claude closed native capability: exact model effort is wired and unsupported assignment is refused"
    }
  },
  "opencode": {
    "file": "tests/source/harness-v2-opencode-capability-native.test.cjs",
    "cases": [
      "opencode closed native capability: isolation",
      "opencode closed native capability: topologyEnforcement",
      "opencode closed native capability: privateSkillRoot",
      "opencode closed native capability: eventStreaming",
      "opencode closed native capability: toolOutputCapture",
      "opencode closed native capability: stableChildIdentity",
      "opencode closed native capability: sameContextContinuation",
      "opencode closed native capability: cancellation",
      "opencode closed native capability: isolatedChecking",
      "opencode closed native capability: processOwnership",
      "opencode closed native capability: modelRouting"
    ],
    "capabilityCases": {
      "isolation": "opencode closed native capability: isolation",
      "topologyEnforcement": "opencode closed native capability: topologyEnforcement",
      "privateSkillRoot": "opencode closed native capability: privateSkillRoot",
      "eventStreaming": "opencode closed native capability: eventStreaming",
      "toolOutputCapture": "opencode closed native capability: toolOutputCapture",
      "stableChildIdentity": "opencode closed native capability: stableChildIdentity",
      "sameContextContinuation": "opencode closed native capability: sameContextContinuation",
      "cancellation": "opencode closed native capability: cancellation",
      "isolatedChecking": "opencode closed native capability: isolatedChecking",
      "processOwnership": "opencode closed native capability: processOwnership",
      "modelRouting": "opencode closed native capability: modelRouting"
    }
  },
  "kilo": {
    "file": "tests/source/harness-v2-opencode-capability-native.test.cjs",
    "cases": [
      "kilo closed native capability: isolation",
      "kilo closed native capability: topologyEnforcement",
      "kilo closed native capability: privateSkillRoot",
      "kilo closed native capability: eventStreaming",
      "kilo closed native capability: toolOutputCapture",
      "kilo closed native capability: stableChildIdentity",
      "kilo closed native capability: sameContextContinuation",
      "kilo closed native capability: cancellation",
      "kilo closed native capability: isolatedChecking",
      "kilo closed native capability: processOwnership",
      "kilo closed native capability: modelRouting"
    ],
    "capabilityCases": {
      "isolation": "kilo closed native capability: isolation",
      "topologyEnforcement": "kilo closed native capability: topologyEnforcement",
      "privateSkillRoot": "kilo closed native capability: privateSkillRoot",
      "eventStreaming": "kilo closed native capability: eventStreaming",
      "toolOutputCapture": "kilo closed native capability: toolOutputCapture",
      "stableChildIdentity": "kilo closed native capability: stableChildIdentity",
      "sameContextContinuation": "kilo closed native capability: sameContextContinuation",
      "cancellation": "kilo closed native capability: cancellation",
      "isolatedChecking": "kilo closed native capability: isolatedChecking",
      "processOwnership": "kilo closed native capability: processOwnership",
      "modelRouting": "kilo closed native capability: modelRouting"
    }
  },
  "prime": {
    "file": "tests/source/harness-v2-pi-capability-native.test.cjs",
    "cases": [
      "prime closed native capability: all six owned tools enforce write/private/network isolation and scratch witness",
      "prime closed native capability: hostile nested dispatch is denied and only the fixed controller topology is advertised",
      "prime closed native capability: private and ambient configuration are absent from actual model requests",
      "prime closed native capability: native event stream stays correlated to one context",
      "prime closed native capability: exact output bytes are committed in the controller receipt",
      "prime closed native capability: overlapping siblings retain unique contexts and drain",
      "prime closed native capability: resume reuses only its bound target context",
      "prime closed native capability: held child cancels while a fast sibling remains alive and drained",
      "prime closed native capability: checker sees frozen candidate but writes only authenticated scratch",
      "prime closed native capability: crash recovery drains the durable owned child",
      "prime closed native capability: model and effort reach native wire while unsupported assignment is refused"
    ],
    "capabilityCases": {
      "isolation": "prime closed native capability: all six owned tools enforce write/private/network isolation and scratch witness",
      "topologyEnforcement": "prime closed native capability: hostile nested dispatch is denied and only the fixed controller topology is advertised",
      "privateSkillRoot": "prime closed native capability: private and ambient configuration are absent from actual model requests",
      "eventStreaming": "prime closed native capability: native event stream stays correlated to one context",
      "toolOutputCapture": "prime closed native capability: exact output bytes are committed in the controller receipt",
      "stableChildIdentity": "prime closed native capability: overlapping siblings retain unique contexts and drain",
      "sameContextContinuation": "prime closed native capability: resume reuses only its bound target context",
      "cancellation": "prime closed native capability: held child cancels while a fast sibling remains alive and drained",
      "isolatedChecking": "prime closed native capability: checker sees frozen candidate but writes only authenticated scratch",
      "processOwnership": "prime closed native capability: crash recovery drains the durable owned child",
      "modelRouting": "prime closed native capability: model and effort reach native wire while unsupported assignment is refused"
    }
  },
  "omp": {
    "file": "tests/source/harness-v2-pi-capability-native.test.cjs",
    "cases": [
      "omp closed native capability: all six owned tools enforce write/private/network isolation and scratch witness",
      "omp closed native capability: hostile nested dispatch is denied and only the fixed controller topology is advertised",
      "omp closed native capability: private and ambient configuration are absent from actual model requests",
      "omp closed native capability: native event stream stays correlated to one context",
      "omp closed native capability: exact output bytes are committed in the controller receipt",
      "omp closed native capability: overlapping siblings retain unique contexts and drain",
      "omp closed native capability: resume reuses only its bound target context",
      "omp closed native capability: held child cancels while a fast sibling remains alive and drained",
      "omp closed native capability: checker sees frozen candidate but writes only authenticated scratch",
      "omp closed native capability: crash recovery drains the durable owned child",
      "omp closed native capability: model and effort reach native wire while unsupported assignment is refused"
    ],
    "capabilityCases": {
      "isolation": "omp closed native capability: all six owned tools enforce write/private/network isolation and scratch witness",
      "topologyEnforcement": "omp closed native capability: hostile nested dispatch is denied and only the fixed controller topology is advertised",
      "privateSkillRoot": "omp closed native capability: private and ambient configuration are absent from actual model requests",
      "eventStreaming": "omp closed native capability: native event stream stays correlated to one context",
      "toolOutputCapture": "omp closed native capability: exact output bytes are committed in the controller receipt",
      "stableChildIdentity": "omp closed native capability: overlapping siblings retain unique contexts and drain",
      "sameContextContinuation": "omp closed native capability: resume reuses only its bound target context",
      "cancellation": "omp closed native capability: held child cancels while a fast sibling remains alive and drained",
      "isolatedChecking": "omp closed native capability: checker sees frozen candidate but writes only authenticated scratch",
      "processOwnership": "omp closed native capability: crash recovery drains the durable owned child",
      "modelRouting": "omp closed native capability: model and effort reach native wire while unsupported assignment is refused"
    }
  },
  "reasonix": {
    "file": "tests/source/harness-v2-reasonix-capability-native.test.cjs",
    "cases": [
      "reasonix closed native capability: isolation",
      "reasonix closed native capability: topology",
      "reasonix closed native capability: privateConfiguration",
      "reasonix closed native capability: intermediateEvents",
      "reasonix closed native capability: exactToolOutput",
      "reasonix closed native capability: concurrency",
      "reasonix closed native capability: resume",
      "reasonix closed native capability: cancellation",
      "reasonix closed native capability: checker",
      "reasonix closed native capability: processOwnership",
      "reasonix closed native capability: modelEffort"
    ],
    "capabilityCases": {
      "isolation": "reasonix closed native capability: isolation",
      "topologyEnforcement": "reasonix closed native capability: topology",
      "privateSkillRoot": "reasonix closed native capability: privateConfiguration",
      "eventStreaming": "reasonix closed native capability: intermediateEvents",
      "toolOutputCapture": "reasonix closed native capability: exactToolOutput",
      "stableChildIdentity": "reasonix closed native capability: concurrency",
      "sameContextContinuation": "reasonix closed native capability: resume",
      "cancellation": "reasonix closed native capability: cancellation",
      "isolatedChecking": "reasonix closed native capability: checker",
      "processOwnership": "reasonix closed native capability: processOwnership",
      "modelRouting": "reasonix closed native capability: modelEffort"
    }
  },
  "deepseek": {
    "file": "tests/source/harness-v2-deepseek-capability-native.test.cjs",
    "cases": [
      "deepseek closed native capability: isolation",
      "deepseek closed native capability: topologyEnforcement",
      "deepseek closed native capability: privateSkillRoot",
      "deepseek closed native capability: eventStreaming",
      "deepseek closed native capability: toolOutputCapture",
      "deepseek closed native capability: stableChildIdentity",
      "deepseek closed native capability: sameContextContinuation",
      "deepseek closed native capability: cancellation",
      "deepseek closed native capability: isolatedChecking",
      "deepseek closed native capability: processOwnership",
      "deepseek closed native capability: modelRouting"
    ],
    "capabilityCases": {
      "isolation": "deepseek closed native capability: isolation",
      "topologyEnforcement": "deepseek closed native capability: topologyEnforcement",
      "privateSkillRoot": "deepseek closed native capability: privateSkillRoot",
      "eventStreaming": "deepseek closed native capability: eventStreaming",
      "toolOutputCapture": "deepseek closed native capability: toolOutputCapture",
      "stableChildIdentity": "deepseek closed native capability: stableChildIdentity",
      "sameContextContinuation": "deepseek closed native capability: sameContextContinuation",
      "cancellation": "deepseek closed native capability: cancellation",
      "isolatedChecking": "deepseek closed native capability: isolatedChecking",
      "processOwnership": "deepseek closed native capability: processOwnership",
      "modelRouting": "deepseek closed native capability: modelRouting"
    }
  },
  "hermes": {
    "file": "tests/source/harness-v2-hermes-capability-native.test.cjs",
    "cases": [
      "hermes closed native capability: isolation denies candidate/private/network while allowing scratch",
      "hermes closed native capability: topology rejects injected nested tool and admits controller edge",
      "hermes closed native capability: ambient configuration skills and hooks stay absent",
      "hermes closed native capability: real intermediate tool journal event is correlated before final response",
      "hermes closed native capability: exact controller output bytes bind to receipt",
      "hermes closed native capability: concurrent siblings keep separate identities",
      "hermes closed native capability: continuation resumes and foreign target is denied",
      "hermes closed native capability: cancellation drains held child while sibling succeeds",
      "hermes closed native capability: independent checker freezes candidate and writes scratch",
      "hermes closed native capability: durable owner recovery drains live crashed controller child",
      "hermes closed native capability: model effort is wired and unsupported effort is denied"
    ],
    "capabilityCases": {
      "isolation": "hermes closed native capability: isolation denies candidate/private/network while allowing scratch",
      "topologyEnforcement": "hermes closed native capability: topology rejects injected nested tool and admits controller edge",
      "privateSkillRoot": "hermes closed native capability: ambient configuration skills and hooks stay absent",
      "eventStreaming": "hermes closed native capability: real intermediate tool journal event is correlated before final response",
      "toolOutputCapture": "hermes closed native capability: exact controller output bytes bind to receipt",
      "stableChildIdentity": "hermes closed native capability: concurrent siblings keep separate identities",
      "sameContextContinuation": "hermes closed native capability: continuation resumes and foreign target is denied",
      "cancellation": "hermes closed native capability: cancellation drains held child while sibling succeeds",
      "isolatedChecking": "hermes closed native capability: independent checker freezes candidate and writes scratch",
      "processOwnership": "hermes closed native capability: durable owner recovery drains live crashed controller child",
      "modelRouting": "hermes closed native capability: model effort is wired and unsupported effort is denied"
    }
  },
  "grok": {
    "file": "tests/source/harness-v2-grok-capability-native.test.cjs",
    "cases": [
      "grok closed native capability: all six owned tools enforce write/private/network isolation and scratch witness",
      "grok closed native capability: hostile native tool topology is denied before an owned controller call",
      "grok closed native capability: private and ambient configuration are absent from actual model requests",
      "grok closed native capability: native event stream stays correlated to one context",
      "grok closed native capability: exact output bytes are committed in the controller receipt",
      "grok closed native capability: overlapping siblings retain unique contexts and drain",
      "grok closed native capability: resume reuses only its bound target context",
      "grok closed native capability: held child cancels while a fast sibling remains alive and drained",
      "grok closed native capability: checker sees frozen candidate but writes only authenticated scratch",
      "grok closed native capability: crash recovery drains the durable owned child",
      "grok closed native capability: model and effort reach native wire while unsupported assignment is refused"
    ],
    "capabilityCases": {
      "isolation": "grok closed native capability: all six owned tools enforce write/private/network isolation and scratch witness",
      "topologyEnforcement": "grok closed native capability: hostile native tool topology is denied before an owned controller call",
      "privateSkillRoot": "grok closed native capability: private and ambient configuration are absent from actual model requests",
      "eventStreaming": "grok closed native capability: native event stream stays correlated to one context",
      "toolOutputCapture": "grok closed native capability: exact output bytes are committed in the controller receipt",
      "stableChildIdentity": "grok closed native capability: overlapping siblings retain unique contexts and drain",
      "sameContextContinuation": "grok closed native capability: resume reuses only its bound target context",
      "cancellation": "grok closed native capability: held child cancels while a fast sibling remains alive and drained",
      "isolatedChecking": "grok closed native capability: checker sees frozen candidate but writes only authenticated scratch",
      "processOwnership": "grok closed native capability: crash recovery drains the durable owned child",
      "modelRouting": "grok closed native capability: model and effort reach native wire while unsupported assignment is refused"
    }
  }
}
const NATIVE_SUITES = Object.freeze(Object.fromEntries([
  ...['claude', 'opencode', 'kilo'].map(provider => [provider, {
    file: 'tests/source/harness-v2-adapter-native.test.cjs',
    cases: [`${provider} production adapter: owned tools preserve candidate, private state and exact session continuation`],
  }]),
  ...['prime', 'omp'].map(provider => [provider, {
    file: 'tests/source/harness-v2-pi-adapter-native.test.cjs',
    cases: [`${provider} real production adapter preserves owned command boundaries, exact usage and resumed history`],
  }]),
  ['deepseek', {
    file: 'tests/source/harness-v2-adapter-native.test.cjs',
    cases: ['deepseek production adapter: owned tools preserve candidate, private state and exact session continuation'],
  }],
  ['reasonix', {
    file: 'tests/source/reasonix-controlled-native.test.cjs',
    cases: [
      'real Reasonix production adapter keeps candidate read-only, scratch writable, controller private, and resumes',
      'real Reasonix production adapter writes only its assigned target and validates terminal schema',
      'real Reasonix production adapter cancels and drains an active request',
    ],
  }],
  ['grok', {
    file: 'tests/source/harness-v2-grok-adapter-native.test.cjs',
    cases: ['Grok real production adapter uses all owned tools, resumes, and drains'],
  }],
  ['vscode', {
    file: 'tests/source/harness-v2-vscode-owned-native.test.cjs',
    cases: [
      'real VS Code owned BYOK session executes controlled tools, bills exact usage, and resumes privately',
      'real VS Code concurrent owned sessions isolate sibling cancellation and drain',
    ],
  }],
  ['hermes', {
    file: 'tests/source/harness-v2-hermes-adapter-native.test.cjs',
    cases: ['Hermes real adapter preserves controlled tools, resume, sibling isolation and cancellation drain'],
  }],
].map(([provider, original]) => {
  const suite = CLOSED_NATIVE_SUITES[provider] || original
  return [provider, Object.freeze({ ...suite, cases: Object.freeze(suite.cases), ...(suite.capabilityCases ? { capabilityCases: Object.freeze(suite.capabilityCases) } : {}) })]
})))
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const status = (value, reason, extra = {}) => ({ status: value, reason, ...extra })
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function nativeTestPlan(provider, root = ROOT) {
  if (!Object.hasOwn(NATIVE_SUITES, provider)) return null
  const suite = NATIVE_SUITES[provider]
  const file = path.join(root, suite.file)
  const pattern = `^(?:${suite.cases.map(escapeRegex).join('|')})$`
  return { file, cases: [...suite.cases],
    argv: ['--test', '--test-concurrency=1', '--test-reporter=tap', '--test-name-pattern', pattern, file],
    executableEnvironmentKey: `AUTOPROMPT_${provider.toUpperCase()}_TEST_CLI` }
}

function selectedCaseSummary(text, names) {
  return names.map(name => {
    const pattern = new RegExp(`^(ok|not ok) \\d+ - ${escapeRegex(name)}(?:\\s+# (SKIP|TODO)(?:\\s.*)?)?\\s*$`, 'gm')
    const matches = [...text.matchAll(pattern)]
    const result = matches.length !== 1 ? (matches.length ? 'ambiguous' : 'not-observed')
      : matches[0][2] ? 'skipped' : matches[0][1] === 'ok' ? 'passed' : 'failed'
    return { name, status: result }
  })
}

function suiteCompleted(tested, counts, cases) {
  // Node versions may report nonselected tests as skipped. Only the explicitly
  // named cases must pass, once each; zero failures/cancellations is not enough.
  return tested.ok && cases.length > 0 && cases.every(item => item.status === 'passed') &&
    counts.pass === cases.length && Number.isSafeInteger(counts.skipped) && counts.skipped >= 0 &&
    counts.tests === counts.pass + counts.skipped && counts.fail === 0 && counts.cancelled === 0 &&
    (counts.todo ?? 0) === 0
}

function parseArgs(argv) {
  const options = { providers: [], executables: {}, nativeTests: false, integrationTests: false }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--native-tests') options.nativeTests = true
    else if (arg === '--integration-tests') options.integrationTests = true
    else if (arg === '--help') options.help = true
    else if (['--provider', '--executable', '--output'].includes(arg)) {
      const value = argv[++index]
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`)
      if (arg === '--provider') options.providers.push(value)
      if (arg === '--output') options.output = value
      if (arg === '--executable') {
        const separator = value.indexOf('=')
        if (separator < 1 || separator === value.length - 1) throw new Error('--executable requires provider=/absolute/path')
        const provider = value.slice(0, separator)
        if (!Object.hasOwn(PROVIDERS, provider) || !path.isAbsolute(value.slice(separator + 1))) throw new Error('Invalid executable provider or nonabsolute path')
        options.executables[provider] = value.slice(separator + 1)
      }
    } else throw new Error(`Unknown option: ${arg}`)
  }
  if (!options.providers.length) options.providers = Object.keys(PROVIDERS)
  options.providers = [...new Set(options.providers)]
  if (options.providers.some(provider => !Object.hasOwn(PROVIDERS, provider))) throw new Error('Unknown provider')
  return options
}

function isolatedEnvironment(root, source = process.env) {
  const env = {}
  // Do not inherit credentials, NODE_OPTIONS, provider homes, hooks or proxies.
  for (const key of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'PATHEXT', 'COMSPEC', 'LANG', 'LC_ALL']) if (source[key]) env[key] = source[key]
  for (const name of ['home', 'config', 'state', 'cache', 'temp', 'cwd']) fs.mkdirSync(path.join(root, name), { mode: 0o700 })
  Object.assign(env, { HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'config'), XDG_STATE_HOME: path.join(root, 'state'), XDG_CACHE_HOME: path.join(root, 'cache'),
    TMPDIR: path.join(root, 'temp'), TMP: path.join(root, 'temp'), TEMP: path.join(root, 'temp'),
    NO_COLOR: '1', CI: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'home', '.gitconfig') })
  for (const provider of Object.keys(PROVIDERS)) env[`${provider.toUpperCase()}_HOME`] = path.join(root, 'home', provider)
  env.REASONIX_STATE_HOME = path.join(root, 'state', 'reasonix')
  env.REASONIX_CACHE_HOME = path.join(root, 'cache', 'reasonix')
  env.CLAUDE_CONFIG_DIR = path.join(root, 'config', 'claude')
  env.PI_CODING_AGENT_DIR = path.join(root, 'config', 'omp')
  return env
}

function discover(provider, env, requested) {
  const command = PROVIDERS[provider].command
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  const candidates = requested ? [requested] : (env.PATH || '').split(path.delimiter).filter(Boolean).flatMap(directory => extensions.map(extension => path.resolve(directory, command + extension)))
  for (const candidate of candidates) {
    try {
      const resolved = fs.realpathSync(candidate)
      if (!fs.statSync(resolved).isFile()) continue
      fs.accessSync(resolved, fs.constants.X_OK)
      return status('supported', 'Executable discovered; provenance and behavioral compatibility are unverified', { path: resolved, sha256: sha256(fs.readFileSync(resolved)), provenance: 'unverified' })
    } catch { /* An absent or inaccessible candidate is not runnable. */ }
  }
  return status('not-tested', requested ? 'Requested executable is absent or inaccessible' : 'Executable not found on PATH')
}

function writeEvidence(directory, name, bytes) {
  const file = path.join(directory, name)
  fs.writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' })
  return { path: file, sha256: sha256(bytes), bytes: Buffer.byteLength(bytes) }
}

function capture(directory, name, executable, argv, env, spawn = cp.spawnSync, timeout = 15000) {
  const stdoutPath = path.join(directory, `${name}.stdout`)
  const stderrPath = path.join(directory, `${name}.stderr`)
  const out = fs.openSync(stdoutPath, 'wx', 0o600)
  const err = fs.openSync(stderrPath, 'wx', 0o600)
  let result
  try {
    // File capture also works where anonymous pipe creation is restricted.
    result = spawn(executable, argv, { cwd: path.join(directory, 'cwd'), env, shell: false, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', out, err] })
    if (result.stdout) fs.writeSync(out, String(result.stdout))
    if (result.stderr) fs.writeSync(err, String(result.stderr))
  } finally { fs.closeSync(out); fs.closeSync(err) }
  const read = file => {
    const size = fs.statSync(file).size
    const fd = fs.openSync(file, 'r')
    const bytes = Buffer.alloc(Math.min(size, 4 * 1024 * 1024))
    try { fs.readSync(fd, bytes, 0, bytes.length, 0) } finally { fs.closeSync(fd) }
    return { text: bytes.toString('utf8'), evidence: { path: file, sha256: sha256(bytes), bytes: bytes.length, totalBytes: size, truncated: size > bytes.length } }
  }
  const stdout = read(stdoutPath)
  const stderr = read(stderrPath)
  const record = { executable, argv, exitCode: result.status ?? null, signal: result.signal || null,
    errorCode: result.error?.code || null,
    stdout: stdout.evidence, stderr: stderr.evidence }
  return { record, stdout: stdout.text, stderr: stderr.text, ok: !result.error && !result.signal && result.status === 0 && !stdout.evidence.truncated && !stderr.evidence.truncated }
}

function testSummary(text) {
  const summary = {}
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = [...text.matchAll(new RegExp(`^# ${key} (\\d+)\\s*$`, 'gm'))]
    if (matches.length) summary[key] = Number(matches.at(-1)[1])
  }
  return summary
}

function inspectProvider(provider, options, evidenceRoot) {
  const directory = path.join(evidenceRoot, provider)
  fs.mkdirSync(directory, { mode: 0o700 })
  const env = isolatedEnvironment(directory, options.env)
  const executable = discover(provider, env, options.executables?.[provider])
  const result = { provider, executable, evidenceDirectory: directory, commands: [],
    version: status('not-tested', 'Executable has not been probed'),
    nativeInterface: status('not-tested', 'Executable has not been probed'),
    capabilities: Object.fromEntries(CAPABILITIES.map(key => [key, status('unknown', 'Requires behavioral evidence bound to this executable and runtime')])),
    nativeTests: status('not-tested', 'Native suite not requested'),
    liveModelConformance: status('not-tested', 'No independent live-model conformance is run by this diagnostic'),
    productionAdmission: status('unknown', 'Diagnostic evidence does not evaluate or grant signed production admission'), admissionGranted: false }
  if (executable.status !== 'supported') return result
  const version = capture(directory, 'version', executable.path, ['--version'], env, options.spawnSync)
  const help = capture(directory, 'help', executable.path, PROVIDERS[provider].help, env, options.spawnSync)
  result.commands.push(version.record, help.record)
  const match = version.ok && /(?:^|[^A-Za-z0-9])v?(\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)(?=$|[^A-Za-z0-9.+-])/.exec(version.stdout + '\n' + version.stderr)
  result.version = match ? status('supported', 'Version string observed from executable', { exact: match[1], evidence: version.record.stdout }) : status('unknown', 'Could not obtain an exact version', { errorCode: version.record.errorCode })
  const helpText = help.stdout + '\n' + help.stderr
  const flags = PROVIDERS[provider].flags.map(flag => ({ flag, ...status(help.ok ? (helpText.includes(flag) ? 'supported' : 'unsupported') : 'unknown', 'Help advertisement only; behavior not established') }))
  result.nativeInterface = status(!help.ok ? 'unknown' : flags.some(flag => flag.status === 'unsupported') ? 'unsupported' : flags.length ? 'supported' : 'unknown', 'Limited CLI help check; does not establish transport or safety capabilities', { flags, evidence: help.record.stdout })
  const modulePath = provider === 'reasonix' ? path.join(ROOT, 'agents/reasonix/workflow/native.js') : path.join(ROOT, 'scripts/harness-v2-native.cjs')
  if (provider !== 'codex' && fs.existsSync(modulePath)) {
    let sequence = 0
    try {
      const probe = require(modulePath).probeExecutable({ provider, executable: executable.path, env,
        spawnSync: (file, argv) => {
          const captured = capture(directory, `adapter-probe-${++sequence}`, file, argv, env, options.spawnSync)
          result.commands.push(captured.record)
          return { stdout: captured.stdout, stderr: captured.stderr, status: captured.record.exitCode,
            ...(captured.record.errorCode ? { error: Object.assign(new Error('Probe process failed'), { code: captured.record.errorCode }) } : {}) }
        } })
      result.adapterProbe = status('supported', 'Adapter preflight accepted; this is not native behavioral conformance', { version: probe.version, evidenceHashes: probe.evidenceHashes || [], declaredCapabilities: probe.capabilities || null,
        nativeRuntimeIdentity: probe.runtimeIdentity || null })
    } catch (error) {
      result.adapterProbe = status(error.code === 'PROVIDER_UNSUPPORTED' ? 'unsupported' : 'unknown', 'Adapter preflight refused; inspect bounded command evidence', { errorCode: error.code || 'PROBE_FAILED' })
    }
  } else result.adapterProbe = status('not-tested', 'No general diagnostic probe is available for this provider')
  if (sha256(fs.readFileSync(executable.path)) !== executable.sha256) {
    result.executable = status('unsupported', 'Executable changed during diagnostic; results cannot be bound')
    return result
  }
  if (options.nativeTests) {
    const plan = nativeTestPlan(provider)
    if (!plan) result.nativeTests = status('not-tested', 'No actual-binary native suite registered; parser fixtures are not conformance')
    else if (!fs.existsSync(plan.file)) result.nativeTests = status('not-tested', 'The registered native suite is available only in the source checkout, not this installed diagnostic package', { suite: NATIVE_SUITES[provider].file })
    else {
      const nativeEnv = { ...env, [plan.executableEnvironmentKey]: executable.path,
        AUTOPROMPT_NATIVE_TEST_EVIDENCE_ROOT: path.join(directory, 'native-wire') }
      if (provider === 'vscode') for (const key of ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR']) {
        const value = (options.env || process.env)[key]
        if (typeof value === 'string') nativeEnv[key] = value
      }
      // Match the bounded Windows startup allowance used by closed canaries.
      // The complete actual-provider suite may contain eleven cold owned Jobs.
      const nativeTimeoutMs = process.platform === 'win32' ? 720000 + plan.cases.length * 120000 : 720000
      const tested = capture(directory, 'native-tests', process.execPath, plan.argv, nativeEnv, options.spawnSync, nativeTimeoutMs)
      const counts = testSummary(tested.stdout)
      const cases = selectedCaseSummary(tested.stdout, plan.cases)
      const complete = suiteCompleted(tested, counts, cases)
      result.commands.push(tested.record)
      result.nativeTests = status(complete ? 'supported' : counts.fail > 0 || cases.some(item => item.status === 'failed') ? 'unsupported' : 'unknown', 'Actual executable with deterministic localhost model service; not live-model conformance', {
        suite: NATIVE_SUITES[provider].file, counts, cases, evidence: tested.record.stdout,
        errorCode: tested.record.errorCode, scope: 'native-binary-local-model-service',
      })
      // Tests launch the bound executable again. A pre-test digest alone cannot
      // establish which binary actually produced the recorded observations.
      let unchanged = false
      try {
        unchanged = sha256(fs.readFileSync(executable.path)) === executable.sha256
        if (unchanged && result.adapterProbe.nativeRuntimeIdentity) {
          const identityApi = require(modulePath)
          const currentIdentity = provider === 'hermes'
            ? identityApi.hermesRuntimeDependencyIdentity(executable.path, env)
            : identityApi.runtimeDependencyIdentity(executable.path, env)
          unchanged = JSON.stringify(currentIdentity) === JSON.stringify(result.adapterProbe.nativeRuntimeIdentity)
        }
      } catch {}
      if (!unchanged) {
        result.executable = status('unsupported', 'Executable changed or disappeared during native testing; results cannot be bound')
        result.nativeTests = { ...result.nativeTests, status: 'unknown', reason: 'Native observations cannot be bound to the original executable' }
      }
    }
  }
  return result
}

function run(options = {}) {
  const evidenceRoot = options.output ? path.resolve(options.output) : fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-harness-v2-evidence-'))
  if (options.output) fs.mkdirSync(evidenceRoot, { mode: 0o700 }) // Refuse existing paths and overwrite.
  const providers = options.providers || Object.keys(PROVIDERS)
  if (providers.some(provider => !Object.hasOwn(PROVIDERS, provider))) throw new Error('Unknown provider')
  const report = { schemaVersion: 'harness-v2-local-diagnostic.v1', createdAt: new Date().toISOString(),
    evidenceKind: options.spawnSync ? 'injected-process-tests' : 'local-executable-diagnostic',
    runtime: { node: process.version, platform: process.platform, architecture: process.arch, supportedNode: Number(process.versions.node.split('.')[0]) >= 20 },
    evidenceDirectory: evidenceRoot, admissionGranted: false,
    providers: providers.map(provider => inspectProvider(provider, options, evidenceRoot)),
    integrationTests: status('not-tested', 'Public CLI integration suite not requested') }
  if (options.integrationTests) {
    const directory = path.join(evidenceRoot, 'integration')
    fs.mkdirSync(directory, { mode: 0o700 })
    const env = isolatedEnvironment(directory, options.env)
    const tested = capture(directory, 'integration-tests', process.execPath, [path.join(ROOT, 'tests/source/harness-v2-integration.test.cjs')], env, options.spawnSync, 120000)
    const counts = testSummary(tested.stdout)
    report.integrationTests = status(tested.ok && counts.pass > 0 && counts.fail === 0 ? 'supported' : 'unknown', 'Local CLI/bundle diagnostic and refusal tests only; not provider conformance', { counts, evidence: tested.record })
  }
  writeEvidence(evidenceRoot, 'report.json', JSON.stringify(report, null, 2) + '\n')
  return report
}

if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) process.stdout.write('Usage: node scripts/harness-v2-conformance.cjs [--provider NAME] [--executable NAME=/absolute/path] [--output NEW_DIRECTORY] [--native-tests] [--integration-tests]\nWrites local diagnostic evidence only. Never grants production admission.\n')
    else process.stdout.write(JSON.stringify(run(options), null, 2) + '\n')
  } catch (error) { process.stderr.write(`DIAGNOSTIC_FAILED: ${error.message}\n`); process.exitCode = 1 }
}

module.exports = { PROVIDERS, CAPABILITIES, NATIVE_SUITES, nativeTestPlan, selectedCaseSummary, suiteCompleted,
  parseArgs, isolatedEnvironment, discover, testSummary, run }
