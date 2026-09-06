#!/usr/bin/env node
'use strict'

const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { detectLegacyCodexInstall } = require('../scripts/install/legacy-compat.cjs')
const { createProviderRootCompat } = require('./provider-root-compat.cjs')

const REAL_CLI_PATH = fs.realpathSync(__filename)
const PACKAGE_ROOT = path.resolve(path.dirname(REAL_CLI_PATH), '..')
const PACKAGE_JSON = require(path.join(PACKAGE_ROOT, 'package.json'))
const REGISTRY_PACKAGE_SPEC = 'autoprompt-skill@latest'
const GITHUB_PACKAGE_ROOT = 'github:Spielewoy/autoprompt-skill'
const GITHUB_PACKAGE_JSON_URL = 'https://raw.githubusercontent.com/Spielewoy/autoprompt-skill/main/package.json'
const GITHUB_COMMIT_API_URL = 'https://api.github.com/repos/Spielewoy/autoprompt-skill/commits/main'
const UPDATE_STATE_DIRECTORY = '.autoprompt'
const UPDATE_STATE_BASENAME = 'cli-update.json'
const UPDATE_HANDOFF_ENV = 'AUTOPROMPT_UPDATED_HANDOFF'
const CLIENT_TOKEN = /^[a-z][a-z0-9-]*$/
const OMP_PROFILE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/
const OMP_WINDOWS_RESERVED_BASENAME = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i
const PROVIDERS = Object.freeze([
  Object.freeze({ id: 'claude', label: 'Claude Code' }),
  Object.freeze({ id: 'codex', label: 'Codex' }),
  Object.freeze({ id: 'opencode', label: 'OpenCode' }),
  Object.freeze({ id: 'kilo', label: 'Kilo Code' }),
  Object.freeze({ id: 'vscode', label: 'VS Code' }),
  Object.freeze({ id: 'prime', label: 'Prime Agent' }),
  Object.freeze({ id: 'omp', label: 'Oh My Pi' }),
  Object.freeze({ id: 'deepseek', label: 'DeepSeek Harness' }),
  Object.freeze({ id: 'reasonix', label: 'Reasonix' }),
])
const PUBLIC_PROVIDER_IDS = new Set(PROVIDERS.map(provider => provider.id))
const CUSTOM_PROVIDER_OPTION = Object.freeze({ id: 'custom', label: 'Custom coding agent' })
const INTERACTIVE_PROVIDERS = Object.freeze([...PROVIDERS, CUSTOM_PROVIDER_OPTION])
const CUSTOM_COMPATIBILITY_GUIDE_URL = `${friendlyRepositoryUrl(PACKAGE_JSON.repository)}/blob/main/docs/guides/custom-agent-compatibility.md`
const PROVIDER_LABELS = Object.freeze(Object.fromEntries(
  PROVIDERS.map(provider => [provider.id, provider.label]),
))
const ROOT_COMPAT = createProviderRootCompat(PROVIDER_LABELS)

const HELP_TEXT = [
  `Autoprompt ${PACKAGE_JSON.version}`,
  '',
  'Usage:',
  '  autoprompt',
  '  autoprompt help',
  '  autoprompt version',
  '  autoprompt install <client|all> [--root <absolute-path>]',
  '  autoprompt doctor [client] [--strict] [--root <absolute-path>]',
  '  autoprompt doctor isolation [--strict] [--root <absolute-path>]',
  '  autoprompt uninstall [client|all] [--root <absolute-path>]',
  '  autoprompt configure codex --agents <off|auto|model,...> [--model-map <absolute-json>] [--effort <low|medium|high|xhigh>] [--root <absolute-path>]',
  '  autoprompt activate codex [--target <absolute-path>] [--ttl <seconds>] [--resume <activation-id>] [--root <absolute-path>] -- <mission>',
  '  autoprompt update',
  '  autoprompt repo',
  '  autoprompt support',
  '',
  'Aliases:',
  '  -h, --help       Show this help.',
  '  -v, --version    Print the package version.',
  '',
  'Interactive providers: claude, codex, opencode, kilo, vscode, prime, omp, deepseek, reasonix.',
  '',
  'Launch `autoprompt` to check for CLI updates and open the installer.',
  'It scans detected roots and lets you install, update, or repair a provider.',
  'Run `autoprompt update` for a manual CLI refresh.',
].join('\n')

class UsageError extends Error {
  constructor(message) {
    super(message)
    this.code = 'AUTOPROMPT_USAGE'
  }
}

function usageError(message) {
  throw new UsageError(message)
}

function validateClient(client) {
  if (typeof client !== 'string' || !CLIENT_TOKEN.test(client)) {
    usageError(`Invalid client token: ${String(client)}`)
  }
  return client
}

function validateProvider(client, allowAll = false) {
  const validated = validateClient(client)
  if ((allowAll && validated === 'all') || PUBLIC_PROVIDER_IDS.has(validated)) return validated
  usageError(`Unsupported provider: ${validated}.`)
}

function validateLifecycleRoot(value) {
  if (typeof value !== 'string' || !value || /[\u0000-\u001f\u007f"]/.test(value) ||
      !path.isAbsolute(value) || value.split(/[\\/]/).includes('..')) {
    usageError('--root requires an absolute path without traversal or control characters.')
  }
  const resolved = path.resolve(value)
  if (resolved === path.parse(resolved).root) usageError('--root cannot be a filesystem root.')
  return resolved
}

function parseLifecycle(command, rest, doctor = false) {
  let client = null
  let root = ''
  let strict = false
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]
    if (argument === '--root') {
      if (root) usageError('--root may be provided only once.')
      const value = rest[index + 1]
      if (value === undefined || value.startsWith('--')) usageError('--root requires a value.')
      root = validateLifecycleRoot(value)
      index += 1
      continue
    }
    if (doctor && argument === '--strict' && !strict) {
      strict = true
      continue
    }
    if (argument.startsWith('-')) usageError(`Unknown ${command} flag: ${argument}`)
    if (client !== null) usageError(`${doctor ? 'Doctor accepts at most' : `${command} requires exactly`} one client token${doctor ? '.' : ' or all.'}`)
    client = validateProvider(argument, !doctor)
  }
  if (!doctor && client === null) usageError(`${command} requires exactly one client token or all.`)
  if (root && (client === null || client === 'all')) usageError('--root requires one explicit provider.')
  const parsed = { command, client }
  if (doctor) parsed.strict = strict
  if (root) parsed.root = root
  return parsed
}

function parseCodexActivation(rest, alias = false) {
  if (!alias && rest[0] !== 'codex') usageError('Activate currently supports only codex.')
  const args = alias ? rest : rest.slice(1)
  let root = ''
  let target = ''
  let ttlSeconds
  let resume = ''
  const mission = []
  let missionMode = false
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (missionMode) {
      mission.push(argument)
      continue
    }
    if (argument === '--') {
      missionMode = true
      continue
    }
    if (['--root', '--target', '--ttl', '--resume'].includes(argument)) {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('--')) usageError(`${argument} requires a value.`)
      index += 1
      if (argument === '--root') {
        if (root) usageError('--root may be provided only once.')
        root = validateLifecycleRoot(value)
      } else if (argument === '--target') {
        if (target) usageError('--target may be provided only once.')
        target = validateLifecycleRoot(value)
      } else if (argument === '--ttl') {
        if (ttlSeconds !== undefined) usageError('--ttl may be provided only once.')
        if (!/^[0-9]+$/.test(value)) usageError('--ttl requires integer seconds.')
        ttlSeconds = Number(value)
      } else {
        if (resume) usageError('--resume may be provided only once.')
        if (!/^apv2-[a-f0-9]{32}$/.test(value)) usageError('--resume requires an Autoprompt v2 activation id.')
        resume = value
      }
      continue
    }
    if (argument.startsWith('-')) usageError(`Unknown activate flag: ${argument}`)
    usageError('Activate codex requires `--` before the mission.')
  }
  if (!missionMode || mission.length === 0) usageError('Activate codex requires at least one mission argv after `--`.')
  return {
    command: 'activate',
    provider: 'codex',
    missionArgs: mission,
    ...(root ? { root } : {}),
    ...(target ? { target } : {}),
    ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
    ...(resume ? { resume } : {}),
    compatibilityAlias: alias,
  }
}

function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.some(argument => typeof argument !== 'string')) {
    usageError('Arguments must be strings.')
  }
  if (argv.length === 0) return { command: 'help' }

  const [command, ...rest] = argv
  if (['help', '-h', '--help'].includes(command)) {
    if (rest.length !== 0) usageError('Help does not accept arguments.')
    return { command: 'help' }
  }
  if (['version', '-v', '--version'].includes(command)) {
    if (rest.length !== 0) usageError('Version does not accept arguments.')
    return { command: 'version' }
  }
  if (command === 'repo' || command === 'support' || command === 'update') {
    if (rest.length !== 0) usageError(`${command} does not accept arguments.`)
    return { command }
  }
  if (command === 'uninstall' && rest.length === 0) {
    return { command: 'uninstall', client: null }
  }
  if (command === 'install' || command === 'uninstall') {
    return parseLifecycle(command, rest)
  }
  if (command === 'doctor') {
    if (rest[0] === 'isolation') {
      const parsed = parseLifecycle(command, ['codex', ...rest.slice(1)], true)
      parsed.isolation = true
      return parsed
    }
    return parseLifecycle(command, rest, true)
  }
  if (command === 'activate') return parseCodexActivation(rest)
  if (command === 'codex') return parseCodexActivation(rest, true)
  if (command === 'configure') {
    if (rest[0] !== 'codex') usageError('Configure currently supports only codex.')
    let selector = ''
    let modelMap = ''
    let effort
    let root = ''
    for (let index = 1; index < rest.length; index += 1) {
      const flag = rest[index]
      if (!['--agents', '--model-map', '--effort', '--root'].includes(flag)) usageError(`Unknown configure flag: ${flag}`)
      const value = rest[index + 1]
      if (value === undefined || value.startsWith('--')) usageError(`${flag} requires a value.`)
      index += 1
      if (flag === '--agents') {
        if (selector) usageError('--agents may be provided only once.')
        selector = value
      } else if (flag === '--model-map') {
        if (modelMap) usageError('--model-map may be provided only once.')
        modelMap = value
      } else if (flag === '--effort') {
        if (effort !== undefined) usageError('--effort may be provided only once.')
        if (!['low', 'medium', 'high', 'xhigh'].includes(value)) usageError('--effort requires low, medium, high, or xhigh.')
        effort = value
      } else {
        if (root) usageError('--root may be provided only once.')
        root = validateLifecycleRoot(value)
      }
    }
    if (!selector) usageError('Configure codex requires --agents.')
    if (effort !== undefined && selector.trim().toLowerCase() === 'off') usageError('--effort requires enabled Codex agents.')
    const parsed = { command: 'configure', provider: 'codex', selector, modelMap }
    if (effort !== undefined) parsed.effort = effort
    if (root) parsed.root = root
    return parsed
  }
  usageError(`Unknown command: ${command}`)
}

function isSupportedNodeVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(String(version))
  return Boolean(match && Number(match[1]) >= 20)
}

function friendlyRepositoryUrl(repository) {
  const raw = typeof repository === 'string' ? repository : repository && repository.url
  return String(raw || '').replace(/^git\+/, '').replace(/\.git$/, '')
}

function configuredHome(env, fallback = os.homedir()) {
  return env.HOME || env.USERPROFILE || fallback
}

function ompProfile(env) {
  const raw = Object.prototype.hasOwnProperty.call(env, 'OMP_PROFILE')
    ? env.OMP_PROFILE
    : env.PI_PROFILE
  const profile = String(raw || '').trim()
  if (!profile || profile === 'default') return ''
  if (profile.endsWith('.') || !OMP_PROFILE_NAME.test(profile) ||
      OMP_WINDOWS_RESERVED_BASENAME.test(profile)) {
    throw new Error(`Invalid OMP profile "${String(raw)}".`)
  }
  return profile
}

function ompDefaultAgentRoot(env, home) {
  return path.join(home, env.PI_CONFIG_DIR || '.omp', 'agent')
}

function ompInstallRoot(env, home) {
  const profile = ompProfile(env)
  if (profile) {
    return path.join(home, env.PI_CONFIG_DIR || '.omp', 'profiles', profile, 'agent')
  }
  return env.PI_CODING_AGENT_DIR || ompDefaultAgentRoot(env, home)
}

function ompNativeTaskAgentRoot(env, home) {
  const profile = ompProfile(env)
  if (profile) return ompInstallRoot(env, home)
  // OMP 17.4.0 relocates skills and settings with PI_CODING_AGENT_DIR, but its
  // task-agent discovery still resolves the default native user root through
  // PI_CONFIG_DIR. Keep the role files where that runtime actually reads them.
  return env.PI_CODING_AGENT_DIR ? ompDefaultAgentRoot(env, home) : ompInstallRoot(env, home)
}

function providerInstallLocations(client, locationOptions = {}) {
  const env = locationOptions.env || process.env
  const platform = locationOptions.platform || process.platform
  const home = configuredHome(env, locationOptions.homeDirectory)
  const xdg = env.XDG_CONFIG_HOME || path.join(home, '.config')
  const singleRoot = installPath => ({
    roots: [{ label: 'Install directory', path: installPath }],
  })

  if (client === 'claude') return singleRoot(path.join(home, '.claude'))
  if (client === 'codex') return singleRoot(env.CODEX_HOME || path.join(home, '.codex'))
  if (client === 'opencode') return singleRoot(path.join(xdg, 'opencode'))
  if (client === 'prime') {
    return singleRoot(env.PRIME_AGENT_CODING_AGENT_DIR || path.join(home, '.prime', 'agent'))
  }
  if (client === 'omp') {
    const installRoot = ompInstallRoot(env, home)
    const nativeRoot = ompNativeTaskAgentRoot(env, home)
    if (nativeRoot === installRoot) return singleRoot(installRoot)
    return {
      roots: [
        { label: 'Install directory', path: installRoot },
        { label: 'Native task-agent root', path: nativeRoot },
      ],
    }
  }
  if (client === 'deepseek') {
    return singleRoot(env.DSH_HOME || path.join(home, '.dsh'))
  }
  if (client === 'reasonix') {
    const root = env.REASONIX_HOME || (platform === 'win32'
      ? path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'reasonix')
      : path.join(home, '.reasonix'))
    return singleRoot(root)
  }
  if (client === 'kilo') {
    return {
      roots: [
        { label: 'Skill root', path: path.join(home, '.kilo') },
        { label: 'Native root', path: path.join(xdg, 'kilo') },
      ],
    }
  }
  if (client === 'vscode') {
    let settings = env.AUTOPROMPT_VSCODE_SETTINGS_PATH
    if (!settings && platform === 'win32') {
      settings = path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Code', 'User', 'settings.json')
    } else if (!settings && platform === 'darwin') {
      settings = path.join(home, 'Library', 'Application Support', 'Code', 'User', 'settings.json')
    } else if (!settings) {
      settings = path.join(xdg, 'Code', 'User', 'settings.json')
    }
    return {
      ...singleRoot(path.join(home, '.copilot')),
      settings,
    }
  }
  throw new Error(`Unknown provider: ${String(client)}`)
}

class InputClosedError extends Error {}
class BackNavigationError extends Error {}

function readLineSync(stdin, stdout) {
  const descriptor = Number.isInteger(stdin.fd) ? stdin.fd : 0
  const byte = Buffer.allocUnsafe(1)
  const bytes = []
  const useRawMode = Boolean(stdin.isTTY && typeof stdin.setRawMode === 'function')
  const wasRaw = Boolean(stdin.isRaw)
  if (useRawMode && !wasRaw) stdin.setRawMode(true)
  try {
    while (true) {
      let count
      try {
        count = fs.readSync(descriptor, byte, 0, 1, null)
      } catch (error) {
        if (error && error.code === 'EINTR') continue
        throw error
      }
      if (count === 0) return bytes.length === 0 ? null : Buffer.from(bytes).toString('utf8')
      if (useRawMode && byte[0] === 27 && bytes.length === 0) return '\u001b'
      if (byte[0] === 10 || byte[0] === 13) {
        if (useRawMode) stdout.write('\n')
        return Buffer.from(bytes).toString('utf8')
      }
      if (useRawMode && (byte[0] === 8 || byte[0] === 127)) {
        if (bytes.length > 0) {
          bytes.pop()
          stdout.write('\b \b')
        }
        continue
      }
      bytes.push(byte[0])
      if (useRawMode) stdout.write(Buffer.from([byte[0]]))
    }
  } finally {
    if (useRawMode && !wasRaw) stdin.setRawMode(false)
  }
}

function answer(options, prompt) {
  options.stdout.write(prompt)
  const value = options.readLine()
  if (value === null || value === undefined) throw new InputClosedError()
  const normalized = String(value).trim()
  if (normalized === '\u001b' || normalized.toLowerCase() === 'esc') {
    throw new BackNavigationError()
  }
  return normalized
}

function providerInstallState(
  client,
  root,
  currentVersion = PACKAGE_JSON.version,
  packageRoot = PACKAGE_ROOT,
) {
  const receipt = path.join(
    root,
    client === 'prime' ? '.autoprompt-prime-install.json' : '.autoprompt-install-receipt.json',
  )
  if (!fs.existsSync(receipt)) {
    let legacy = false
    try {
      legacy = client === 'codex' && detectLegacyCodexInstall(root, { packageRoot }).matched
    } catch {}
    if (legacy) {
      return {
        installed: true,
        version: '',
        current: false,
        legacy: true,
      }
    }
    return { installed: false, version: '', current: false }
  }

  const marker = client === 'prime'
    ? path.join(root, 'autoprompt', 'packages', 'prime', 'package.json')
    : path.join(root, 'skills', 'autoprompt', 'VERSION')
  let version = ''
  try {
    if (client === 'prime') version = String(JSON.parse(fs.readFileSync(marker, 'utf8')).version || '')
    else version = fs.readFileSync(marker, 'utf8').trim()
  } catch {}
  return { installed: true, version, current: version === currentVersion }
}

function stateLabel(state) {
  if (state.legacy) return `legacy install detected, update available: ${PACKAGE_JSON.version}`
  if (!state.installed) return 'not installed'
  if (state.current) return `installed ${state.version}, current`
  if (state.version) return `installed ${state.version}, update available: ${PACKAGE_JSON.version}`
  return `installed, version unknown, update available: ${PACKAGE_JSON.version}`
}

function writeDetectedLocations(options, locations) {
  if (locations.roots.length === 1) {
    options.stdout.write(`Detected path: ${locations.roots[0].path}\n`)
  } else {
    options.stdout.write('Detected paths:\n')
    for (const location of locations.roots) {
      options.stdout.write(`  ${location.label}: ${location.path}\n`)
    }
  }
  if (locations.settings) {
    options.stdout.write(`VS Code settings: ${locations.settings}\n`)
  }
}

function runInteractiveProviderLoop(options, settings) {
  let showTitle = true
  while (true) {
    let selected
    try {
      selected = chooseProvider(options, {
        action: settings.action,
        includeCustom: settings.includeCustom,
        showTitle,
      })
      showTitle = false
    } catch (error) {
      if (error instanceof BackNavigationError) {
        options.stdout.write(`\nAutoprompt ${settings.action === 'uninstall' ? 'uninstaller' : 'installer'} closed.\n`)
        return 0
      }
      throw error
    }
    try {
      return settings.onSelect(selected)
    } catch (error) {
      if (error instanceof BackNavigationError) {
        options.stdout.write('\nBack to provider selection.\n\n')
        continue
      }
      throw error
    }
  }
}

function chooseProvider(options, settings = {}) {
  const action = settings.action || 'install'
  const providers = settings.includeCustom === false ? PROVIDERS : INTERACTIVE_PROVIDERS
  if (settings.showTitle !== false) {
    options.stdout.write(`Autoprompt ${action === 'uninstall' ? 'uninstaller' : 'installer'}\n\n`)
  }
  options.stdout.write('Pick a coding agent:\n')
  const choices = providers.map(provider => {
    if (provider.id === CUSTOM_PROVIDER_OPTION.id) return { provider, state: null, locations: null }
    const locations = providerInstallLocations(provider.id, options)
    const state = providerInstallState(
      provider.id,
      locations.roots[0].path,
      PACKAGE_JSON.version,
      options.packageRoot,
    )
    const visibleState = action === 'uninstall' && state.legacy
      ? { installed: false, version: '', current: false }
      : state
    return { provider, state: visibleState, locations }
  })
  choices.forEach(({ provider, state }, index) => {
    const suffix = state ? ` (${stateLabel(state)})` : ''
    options.stdout.write(`  ${index + 1}) ${provider.label}${suffix}\n`)
  })

  while (true) {
    const choice = answer(options, `Provider [1-${providers.length}, Esc]: `)
    if (/^[1-9][0-9]*$/.test(choice)) {
      const selected = choices[Number(choice) - 1]
      if (selected) return selected
    }
    options.stdout.write(`Enter a number from 1 to ${providers.length}.\n`)
  }
}

function confirm(options, prompt) {
  while (true) {
    const response = answer(options, prompt).toLowerCase()
    if (response === 'y' || response === 'yes') return true
    if (response === 'n' || response === 'no') return false
    options.stdout.write('Please answer Y or N.\n')
  }
}

function confirmDefault(options) {
  return confirm(options, 'Use detected path(s)? [Y/N]: ')
}

function customProviderRoot(options) {
  while (true) {
    const resolved = ROOT_COMPAT.resolveInput(answer(options, 'Custom path: '), {
      cwd: options.cwd,
      env: options.env,
    })
    if (resolved.status === 'ok') return resolved.root
    if (resolved.status === 'invalid') options.stdout.write('Enter a valid directory path.\n')
    else if (resolved.status === 'empty') options.stdout.write('Enter a directory path.\n')
    else if (resolved.status === 'missing') options.stdout.write('Directory does not exist.\n')
    else if (resolved.status === 'not-directory') options.stdout.write('Path is not a directory.\n')
    else options.stdout.write('Enter a safe directory without symlink or reparse markers.\n')
  }
}

function forceConfirmation(options) {
  return confirm(options, 'Path does not match the selected provider. Continue anyway? [Y/N]: ')
}

function confirmedCustomProviderRoot(options, providerId) {
  while (true) {
    const resolved = customProviderRoot(options)
    const result = ROOT_COMPAT.inspect(resolved, providerId)
    if (result.status === 'unsafe') {
      options.stdout.write('Enter a safe directory without symlink or reparse markers.\n')
      continue
    }
    if (result.status === 'accept') return resolved
    options.stdout.write(`${result.headline}\n`)
    result.details.forEach(detail => options.stdout.write(`${detail}\n`))
    if (forceConfirmation(options)) return resolved
  }
}

function runCustomCompatibilityGuide(options) {
  options.stdout.write(`\n${CUSTOM_PROVIDER_OPTION.label}\n`)
  options.stdout.write(`Use the compatibility guide: ${CUSTOM_COMPATIBILITY_GUIDE_URL}\n`)
  return 0
}

function scriptArguments(command) {
  if (command.command === 'install') return [command.client]
  if (command.command === 'uninstall') return [command.client]
  const args = []
  if (command.isolation) args.push('isolation')
  else if (command.client !== null) args.push(command.client)
  if (command.strict) args.push('--strict')
  return args
}

function scriptPath(packageRoot, command, extension) {
  return path.join(packageRoot, 'scripts', 'install', `${command}.${extension}`)
}

function spawnOptions(options) {
  return {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    stdio: 'inherit',
  }
}

function childStatus(result, stderr, label) {
  if (result && Number.isInteger(result.status)) return result.status
  if (result && !result.error && typeof result.signal === 'string') {
    const signalNumber = os.constants.signals[result.signal]
    if (Number.isInteger(signalNumber)) return 128 + signalNumber

    // Node reports named signals; fail closed if a future or invalid name appears.
    stderr.write(
      `Autoprompt ${label} exited due to unknown signal ${result.signal}; using exit status 1.\n`,
    )
    return 1
  }
  const detail = result && result.error && result.error.message
    ? `: ${result.error.message}`
    : ''
  stderr.write(`Autoprompt could not start ${label}${detail}\n`)
  return 1
}

function npmInvocation(platform, args) {
  if (platform !== 'win32') return { executable: 'npm', args }
  const npmCliPath = path.join(
    path.dirname(fs.realpathSync(process.execPath)),
    'node_modules',
    'npm',
    'bin',
    'npm-cli.js',
  )
  return { executable: process.execPath, args: [npmCliPath, ...args] }
}

function npmEnvironment(env) {
  const clean = { ...env }
  for (const key of Object.keys(clean)) {
    if (key.toLowerCase() === 'npm_config_dry_run') delete clean[key]
  }
  clean.npm_config_audit = 'false'
  clean.npm_config_fund = 'false'
  clean.npm_config_update_notifier = 'false'
  return clean
}

function normalizeVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(String(value || '').trim())
  return match ? `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}` : ''
}

function versionFromOutput(stdout) {
  const raw = String(stdout || '').trim()
  if (!raw) return ''
  try {
    const parsed = JSON.parse(raw)
    return normalizeVersion(Array.isArray(parsed) ? parsed.at(-1) : parsed)
  } catch {
    return normalizeVersion(raw)
  }
}

function compareVersions(left, right) {
  const leftParts = normalizeVersion(left).split('.').map(Number)
  const rightParts = normalizeVersion(right).split('.').map(Number)
  if (leftParts.length !== 3 || rightParts.length !== 3) return 0
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index]
  }
  return 0
}

function isPackagedInstall(packageRoot) {
  return String(packageRoot || '')
    .replaceAll('\\', '/')
    .toLowerCase()
    .includes(`/node_modules/${PACKAGE_JSON.name.toLowerCase()}`)
}

const GITHUB_VERSION_SCRIPT = [
  "const controller = new AbortController()",
  "const timer = setTimeout(() => controller.abort(), 4000)",
  "fetch(process.argv[1], { signal: controller.signal })",
  "  .then(response => { if (!response.ok) throw new Error(String(response.status)); return response.json() })",
  "  .then(value => process.stdout.write(String(value.version || '')))",
  "  .catch(() => { process.exitCode = 1 })",
  "  .finally(() => clearTimeout(timer))",
].join('\n')

const GITHUB_COMMIT_SCRIPT = [
  "const controller = new AbortController()",
  "const timer = setTimeout(() => controller.abort(), 4000)",
  "fetch(process.argv[1], {",
  "  headers: { 'accept': 'application/vnd.github+json', 'user-agent': 'autoprompt-skill-cli' },",
  "  signal: controller.signal,",
  "})",
  "  .then(response => { if (!response.ok) throw new Error(String(response.status)); return response.json() })",
  "  .then(value => process.stdout.write(String(value.sha || '')))",
  "  .catch(() => { process.exitCode = 1 })",
  "  .finally(() => clearTimeout(timer))",
].join('\n')

function queryLatestVersion(options) {
  const environment = npmEnvironment(options.env || process.env)
  const npm = npmInvocation(options.platform || process.platform, [
    'view',
    'autoprompt-skill',
    'version',
    '--json',
  ])
  const childOptions = {
    cwd: options.cwd,
    encoding: 'utf8',
    env: environment,
    shell: false,
    timeout: 5_000,
    windowsHide: true,
  }
  const registry = options.spawnSync(npm.executable, npm.args, childOptions)
  if (!registry.error && registry.status === 0) {
    const version = versionFromOutput(registry.stdout)
    if (version) return version
  }

  const github = options.spawnSync(
    process.execPath,
    ['-e', GITHUB_VERSION_SCRIPT, GITHUB_PACKAGE_JSON_URL],
    childOptions,
  )
  if (github.error || github.status !== 0) return ''
  return versionFromOutput(github.stdout)
}

function normalizeGitHubRevision(value) {
  const match = /^[0-9a-f]{7,40}$/i.exec(String(value || '').trim())
  return match ? match[0].toLowerCase() : ''
}

function queryLatestGitHubRevision(options) {
  const childOptions = {
    cwd: options.cwd,
    encoding: 'utf8',
    env: npmEnvironment(options.env || process.env),
    shell: false,
    timeout: 5_000,
    windowsHide: true,
  }
  const github = options.spawnSync(
    process.execPath,
    ['-e', GITHUB_COMMIT_SCRIPT, GITHUB_COMMIT_API_URL],
    childOptions,
  )
  if (!github.error && github.status === 0) {
    return normalizeGitHubRevision(github.stdout)
  }

  const authenticated = options.spawnSync(
    'gh',
    ['api', 'repos/Spielewoy/autoprompt-skill/commits/main', '--jq', '.sha'],
    childOptions,
  )
  if (authenticated.error || authenticated.status !== 0) return ''
  return normalizeGitHubRevision(authenticated.stdout)
}

function resolveInteractiveUpdateStatus(options, latestVersion, latestGitHubRevision) {
  const latest = normalizeVersion(latestVersion || '')
  const revision = normalizeGitHubRevision(latestGitHubRevision || '')
  if (!latest && !revision) {
    return {
      action: 'unreachable',
      message: `Could not reach npm or GitHub. Continuing with ${PACKAGE_JSON.version}.`,
      latestGitHubRevision: revision,
      latestVersion: latest,
    }
  }

  const state = readUpdateState(options)
  const comparison = latest ? compareVersions(latest, PACKAGE_JSON.version) : 0
  const packagedInstall = isPackagedInstall(options.packageRoot)
  if (packagedInstall && comparison > 0) {
    return {
      action: 'registry-first',
      message: `New Autoprompt version available: ${latest} (installed ${PACKAGE_JSON.version}). Updating...`,
      latestGitHubRevision: revision,
      latestVersion: latest,
    }
  }

  if (packagedInstall &&
      revision &&
      (revision !== state.installedGitHubRevision ||
        (latest && latest !== PACKAGE_JSON.version))) {
    return {
      action: 'github-main',
      message: `New Autoprompt build available on GitHub main (installed ${PACKAGE_JSON.version}). Updating...`,
      latestGitHubRevision: revision,
      latestVersion: latest,
    }
  }

  if (packagedInstall && latest && comparison < 0) {
    return {
      action: 'registry-first',
      message: `Installed Autoprompt ${PACKAGE_JSON.version} does not match current release ${latest}. Updating...`,
      latestGitHubRevision: revision,
      latestVersion: latest,
    }
  }

  if (!packagedInstall && (revision || (latest && comparison !== 0))) {
    const releaseDetail = latest && comparison !== 0
      ? ` Latest release: ${latest}.`
      : ''
    return {
      action: 'none',
      message: `Repository checkout ${PACKAGE_JSON.version} is not auto-updated.${releaseDetail}`,
      latestGitHubRevision: revision,
      latestVersion: latest,
    }
  }

  return {
    action: 'none',
    message: `Autoprompt ${PACKAGE_JSON.version} is current.`,
    latestGitHubRevision: revision,
    latestVersion: latest,
  }
}

function updateStatePath(env, fallbackHomeDirectory) {
  return path.join(
    configuredHome(env, fallbackHomeDirectory),
    UPDATE_STATE_DIRECTORY,
    UPDATE_STATE_BASENAME,
  )
}

function readUpdateState(options) {
  const file = updateStatePath(options.env, options.homeDirectory)
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return {
      installedGitHubRevision: normalizeGitHubRevision(parsed.installedGitHubRevision),
    }
  } catch {
    return {
      installedGitHubRevision: '',
    }
  }
}

function writeUpdateState(options, nextState) {
  const file = updateStatePath(options.env, options.homeDirectory)
  const current = readUpdateState(options)
  const merged = {
    installedGitHubRevision: normalizeGitHubRevision(
      Object.prototype.hasOwnProperty.call(nextState, 'installedGitHubRevision')
        ? nextState.installedGitHubRevision
        : current.installedGitHubRevision,
    ),
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
  return merged
}

function persistUpdateState(options, nextState) {
  try {
    return writeUpdateState(options, nextState)
  } catch (error) {
    options.stderr.write(`Autoprompt could not record the CLI update state: ${error.message}\n`)
    return readUpdateState(options)
  }
}

function runPowerShell(command, options) {
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath(options.packageRoot, command.command, 'ps1'),
    ...scriptArguments(command).map(argument => argument === '--strict' ? '-Strict' : argument),
  ]
  const childOptions = spawnOptions(options)
  const windowsPowerShell = options.spawnSync('powershell.exe', args, childOptions)
  if (!windowsPowerShell.error || windowsPowerShell.error.code !== 'ENOENT') {
    return childStatus(windowsPowerShell, options.stderr, 'powershell.exe')
  }

  const powerShellCore = options.spawnSync('pwsh', args, childOptions)
  if (powerShellCore.error && powerShellCore.error.code === 'ENOENT') {
    options.stderr.write('Autoprompt requires powershell.exe or pwsh on PATH.\n')
    return 1
  }
  return childStatus(powerShellCore, options.stderr, 'pwsh')
}

function bashVersion(options) {
  const result = options.spawnSync(
    'bash',
    ['-c', 'printf "%s" "${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]}"'],
    {
      cwd: options.cwd,
      encoding: 'utf8',
      env: options.env,
      shell: false,
    },
  )
  if (result.error || result.status !== 0) return null
  const match = /^(\d+)\.(\d+)$/.exec(String(result.stdout || '').trim())
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]) }
}

function bashIsCurrent(version) {
  return version && (version.major > 4 || (version.major === 4 && version.minor >= 3))
}

function writeBashGuidance(options) {
  options.stderr.write('Autoprompt requires Bash 4.3 or newer on PATH.\n')
  if (options.platform === 'darwin') {
    options.stderr.write('macOS ships Bash 3.2; run `brew install bash` and put the Homebrew bash first on PATH.\n')
  }
}

function runBash(command, options) {
  const version = bashVersion(options)
  if (!bashIsCurrent(version)) {
    writeBashGuidance(options)
    return 1
  }
  const args = [
    scriptPath(options.packageRoot, command.command, 'sh'),
    ...scriptArguments(command),
  ]
  const result = options.spawnSync('bash', args, spawnOptions(options))
  return childStatus(result, options.stderr, 'bash')
}

function runScript(command, options) {
  let lease = null
  let operationLock = null
  if (['install', 'uninstall'].includes(command.command) &&
      ['codex', 'all'].includes(command.client)) {
    const home = configuredHome(options.env)
    const candidate = options.env.AUTOPROMPT_INSTALL_ROOT ||
      options.env.CODEX_HOME || path.join(home, '.codex')
    if (path.isAbsolute(candidate) && fs.existsSync(candidate)) {
      const lockModule = path.join(
        options.packageRoot, 'scripts', 'install', 'operation-lock.cjs',
      )
      if (!fs.existsSync(lockModule) && options.packageRoot === PACKAGE_ROOT) {
        options.stderr.write('Autoprompt cannot locate the packaged Codex operation lock.\n')
        return 1
      }
      if (fs.existsSync(lockModule)) {
        operationLock = require(lockModule)
        try {
          lease = operationLock.acquire(candidate, `${command.command}-codex`)
        } catch (error) {
          options.stderr.write(`Autoprompt ${command.command} (codex): ${error.message}\n`)
          return 1
        }
      }
    }
  }
  let status
  try {
    status = options.platform === 'win32'
      ? runPowerShell(command, options)
      : runBash(command, options)
  } finally {
    if (lease) {
      try {
        operationLock.release(lease)
      } catch (error) {
        options.stderr.write(`Autoprompt could not release the Codex operation lock: ${error.message}\n`)
        if (status === 0) status = 1
      }
    }
  }
  return status
}

function githubPackageSpec(revision) {
  const normalized = normalizeGitHubRevision(revision)
  return normalized ? `${GITHUB_PACKAGE_ROOT}#${normalized}` : ''
}

function runRegistryUpdate(options, latestGitHubRevision = '') {
  const primary = npmInvocation(options.platform, ['install', '-g', REGISTRY_PACKAGE_SPEC])
  let result
  try {
    result = options.spawnSync(primary.executable, primary.args, spawnOptions(options))
  } catch (error) {
    result = { error }
  }
  let status = childStatus(result, options.stderr, 'npm')
  if (status !== 0) {
    const fallbackSpec = githubPackageSpec(latestGitHubRevision)
    if (!fallbackSpec) {
      options.stdout.write('npm registry update failed; GitHub revision unavailable.\n')
      return { installedGitHubRevision: '', status }
    }
    options.stdout.write('npm registry update failed; trying the verified GitHub revision.\n')
    const fallback = npmInvocation(options.platform, [
      'install',
      '-g',
      '--install-links=true',
      fallbackSpec,
    ])
    let fallbackResult
    try {
      fallbackResult = options.spawnSync(
        fallback.executable,
        fallback.args,
        spawnOptions(options),
      )
    } catch (error) {
      fallbackResult = { error }
    }
    status = childStatus(fallbackResult, options.stderr, 'npm GitHub fallback')
    return {
      installedGitHubRevision: status === 0
        ? normalizeGitHubRevision(latestGitHubRevision)
        : '',
      status,
    }
  }
  return { installedGitHubRevision: '', status }
}

function runGitHubUpdate(options, latestGitHubRevision = '') {
  const spec = githubPackageSpec(latestGitHubRevision)
  if (!spec) {
    options.stderr.write('Autoprompt update: GitHub revision unavailable.\n')
    return { installedGitHubRevision: '', status: 1 }
  }
  const fallback = npmInvocation(options.platform, [
    'install',
    '-g',
    '--install-links=true',
    spec,
  ])
  let result
  try {
    result = options.spawnSync(fallback.executable, fallback.args, spawnOptions(options))
  } catch (error) {
    result = { error }
  }
  const status = childStatus(result, options.stderr, 'npm GitHub install')
  return {
    installedGitHubRevision: status === 0
      ? normalizeGitHubRevision(latestGitHubRevision)
      : '',
    status,
  }
}

function resolveUpdateIntent(options, updateInfo = {}) {
  const latestVersion = normalizeVersion(updateInfo.latestVersion || '')
  const latestGitHubRevision = normalizeGitHubRevision(updateInfo.latestGitHubRevision || '')
  if (updateInfo.strategy) {
    return { latestGitHubRevision, latestVersion, strategy: updateInfo.strategy }
  }
  const comparison = latestVersion ? compareVersions(latestVersion, PACKAGE_JSON.version) : 0
  const strategy = comparison > 0
    ? 'registry-first'
    : latestGitHubRevision
      ? 'github-main'
      : 'registry-first'
  return { latestGitHubRevision, latestVersion, strategy }
}

function runUpdate(options, updateInfo = {}) {
  const latestVersion = updateInfo.latestVersion || options.checkLatestVersion()
  const latestGitHubRevision = updateInfo.latestGitHubRevision || options.checkLatestGitHubRevision()
  const intent = resolveUpdateIntent(options, {
    ...updateInfo,
    latestGitHubRevision,
    latestVersion,
  })
  const result = intent.strategy === 'github-main'
    ? runGitHubUpdate(options, intent.latestGitHubRevision)
    : runRegistryUpdate(options, intent.latestGitHubRevision)
  if (result.status === 0) {
    if (result.installedGitHubRevision) {
      persistUpdateState(options, {
        installedGitHubRevision: result.installedGitHubRevision,
      })
    }
    options.stdout.write(
      updateInfo.continueInteractive
        ? 'Autoprompt updated. Restarting the installer.\n'
        : 'Autoprompt updated. Rerun `autoprompt` to refresh provider files.\n',
    )
  }
  return result.status
}

function checkInteractiveUpdate(options) {
  options.stdout.write('Checking for updates...\n')
  let latest = ''
  let latestGitHubRevision = ''
  try {
    latest = normalizeVersion(options.checkLatestVersion())
  } catch {}
  try {
    latestGitHubRevision = normalizeGitHubRevision(options.checkLatestGitHubRevision())
  } catch {}
  const resolved = resolveInteractiveUpdateStatus(options, latest, latestGitHubRevision)
  if (resolved.action === 'unreachable') {
    options.stdout.write(`${resolved.message}\n`)
    return null
  }

  if (resolved.action === 'registry-first' || resolved.action === 'github-main') {
    options.stdout.write(`${resolved.message}\n`)
    const status = runUpdate(options, {
      latestGitHubRevision: resolved.latestGitHubRevision,
      latestVersion: resolved.latestVersion,
      strategy: resolved.action,
      continueInteractive: true,
    })
    if (status !== 0) return status
    return 'restart'
  }

  options.stdout.write(`${resolved.message}\n`)
  return null
}

function runUpdatedInstaller(options) {
  const cli = path.join(options.packageRoot, 'bin', 'autoprompt.cjs')
  const result = options.spawnSync(process.execPath, [cli], {
    ...spawnOptions(options),
    env: { ...options.env, [UPDATE_HANDOFF_ENV]: '1' },
  })
  return childStatus(result, options.stderr, 'updated Autoprompt installer')
}

function runSelectedInstall(options, selected) {
  const { provider, state } = selected
  if (provider.id === CUSTOM_PROVIDER_OPTION.id) return runCustomCompatibilityGuide(options)

  const locations = selected.locations
  options.stdout.write(`\n${provider.label}\n`)
  writeDetectedLocations(options, locations)

  if (state.installed) {
    const proceed = state.current
      ? confirm(options, `Autoprompt ${state.version} is current. Reinstall or repair it? [Y/N]: `)
      : confirm(
          options,
          state.legacy
            ? `Legacy Autoprompt install detected. Update it to ${PACKAGE_JSON.version}? [Y/N]: `
            : state.version
                ? `Update Autoprompt ${state.version} to ${PACKAGE_JSON.version}? [Y/N]: `
                : `Installed version is unknown. Update to ${PACKAGE_JSON.version}? [Y/N]: `,
        )
    if (!proceed) return 0
  }

  let env = { ...options.env }
  let customRoot = ''
  if (confirmDefault(options)) {
    delete env.AUTOPROMPT_INSTALL_ROOT
  } else {
    customRoot = confirmedCustomProviderRoot(options, provider.id)
    env = { ...env, AUTOPROMPT_INSTALL_ROOT: customRoot }
    options.stdout.write(`Using custom path: ${customRoot}\n`)
  }
  const status = runScript(
    { command: 'install', client: provider.id },
    { ...options, env },
  )
  if (status === 0) {
    options.stdout.write(
      'If Autoprompt helps, star https://github.com/Spielewoy/autoprompt-skill\n',
    )
    if (customRoot) {
      options.stdout.write(
        `Custom root commands:\n` +
        `  autoprompt doctor ${provider.id} --strict --root "${customRoot}"\n` +
        `  autoprompt uninstall ${provider.id} --root "${customRoot}"\n`,
      )
    }
  }
  return status
}

function runInteractive(options) {
  try {
    let updateStatus
    if (options.env[UPDATE_HANDOFF_ENV] !== '1') {
      try {
        updateStatus = checkInteractiveUpdate(options)
      } catch (error) {
        if (error instanceof BackNavigationError) {
          options.stdout.write('\nAutoprompt installer closed.\n')
          return 0
        }
        throw error
      }
    }
    if (Number.isInteger(updateStatus)) return updateStatus
    if (updateStatus === 'restart') return runUpdatedInstaller(options)
    return runInteractiveProviderLoop(options, {
      action: 'install',
      includeCustom: true,
      onSelect(selected) {
        return runSelectedInstall(options, selected)
      },
    })
  } catch (error) {
    if (error instanceof InputClosedError) {
      options.stderr.write('Autoprompt interactive install cancelled: input closed.\n')
      return 1
    }
    const detail = error && error.message ? `: ${error.message}` : ''
    options.stderr.write(`Autoprompt interactive install failed${detail}\n`)
    return 1
  }
}

function runSelectedUninstall(options, selected) {
  const { provider, locations } = selected
  options.stdout.write(`\n${provider.label}\n`)
  writeDetectedLocations(options, locations)

  let root = locations.roots[0].path
  const env = { ...options.env }
  if (confirmDefault(options)) {
    delete env.AUTOPROMPT_INSTALL_ROOT
    if (!selected.state.installed) {
      options.stdout.write(`No Autoprompt installation was found at the detected ${provider.label} root.\n`)
      return 0
    }
  } else {
    root = customProviderRoot(options)
    env.AUTOPROMPT_INSTALL_ROOT = root
    if (!providerInstallState(provider.id, root).installed) {
      options.stdout.write(`No Autoprompt installation was found at ${root}.\n`)
      return 0
    }
  }
  if (!confirm(options, `Uninstall Autoprompt from ${provider.label}? [Y/N]: `)) return 0
  return runScript({ command: 'uninstall', client: provider.id }, { ...options, env })
}

function runInteractiveUninstall(options) {
  try {
    return runInteractiveProviderLoop(options, {
      action: 'uninstall',
      includeCustom: false,
      onSelect(selected) {
        return runSelectedUninstall(options, selected)
      },
    })
  } catch (error) {
    if (error instanceof InputClosedError) {
      options.stderr.write('Autoprompt interactive uninstall cancelled: input closed.\n')
      return 1
    }
    const detail = error && error.message ? `: ${error.message}` : ''
    options.stderr.write(`Autoprompt interactive uninstall failed${detail}\n`)
    return 1
  }
}

function run(argv, overrides = {}) {
  const stdin = overrides.stdin || process.stdin
  const stdout = overrides.stdout || process.stdout
  const options = {
    cwd: overrides.cwd === undefined ? process.cwd() : overrides.cwd,
    env: overrides.env === undefined ? process.env : overrides.env,
    interactive: overrides.interactive === undefined
      ? Boolean(stdin.isTTY && stdout.isTTY)
      : Boolean(overrides.interactive),
    nodeVersion: overrides.nodeVersion === undefined ? process.versions.node : overrides.nodeVersion,
    packageRoot: overrides.packageRoot === undefined ? PACKAGE_ROOT : overrides.packageRoot,
    platform: overrides.platform === undefined ? process.platform : overrides.platform,
    readLine: overrides.readLine || (() => readLineSync(stdin, stdout)),
    spawnSync: overrides.spawnSync || childProcess.spawnSync,
    stderr: overrides.stderr || process.stderr,
    stdin,
    stdout,
  }
  options.checkLatestVersion = overrides.checkLatestVersion || (() => queryLatestVersion(options))
  options.checkLatestGitHubRevision = overrides.checkLatestGitHubRevision ||
    (() => queryLatestGitHubRevision(options))

  if (!isSupportedNodeVersion(options.nodeVersion)) {
    options.stderr.write(
      `Autoprompt requires Node.js 20 or newer; found ${String(options.nodeVersion)}.\n`,
    )
    return 1
  }

  if (Array.isArray(argv) && argv.length === 0 && options.interactive) {
    return runInteractive(options)
  }

  let command
  try {
    command = parseArgs(argv)
  } catch (error) {
    if (!error || error.code !== 'AUTOPROMPT_USAGE') throw error
    options.stderr.write(`${error.message}\n\n${HELP_TEXT}\n`)
    return 2
  }

  if (command.command === 'help') {
    options.stdout.write(`${HELP_TEXT}\n`)
    return 0
  }
  if (command.command === 'version') {
    options.stdout.write(`${PACKAGE_JSON.version}\n`)
    return 0
  }
  if (command.command === 'repo') {
    options.stdout.write(`${friendlyRepositoryUrl(PACKAGE_JSON.repository)}\n`)
    return 0
  }
  if (command.command === 'support') {
    options.stdout.write(`${PACKAGE_JSON.bugs.url}\n`)
    return 0
  }
  if (command.command === 'update') return runUpdate(options)
  if (command.command === 'uninstall' && command.client === null) {
    if (!options.interactive) {
      options.stderr.write(`Interactive uninstall requires a terminal.\n\n${HELP_TEXT}\n`)
      return 2
    }
    return runInteractiveUninstall(options)
  }
  if (command.command === 'configure') {
    const configure = require(path.join(options.packageRoot, 'scripts', 'codex-configure.cjs'))
    return configure.run({
      env: command.root
        ? { ...options.env, AUTOPROMPT_INSTALL_ROOT: command.root }
        : options.env,
      modelMap: command.modelMap,
      ...(command.effort !== undefined ? { effort: command.effort } : {}),
      packageRoot: options.packageRoot,
      selector: command.selector,
      stderr: options.stderr,
      stdout: options.stdout,
    })
  }
  if (command.command === 'activate') {
    const configure = require(path.join(options.packageRoot, 'scripts', 'codex-configure.cjs'))
    try {
      const result = configure.launchActivation({
        env: command.root
          ? { ...options.env, AUTOPROMPT_INSTALL_ROOT: command.root }
          : options.env,
        missionArgs: command.missionArgs,
        compatibilityAlias: command.compatibilityAlias,
        now: overrides.now,
        resume: command.resume,
        ...(overrides.spawnSync ? { spawnSync: options.spawnSync } : {}),
        stdio: 'inherit',
        target: command.target || options.cwd,
        ttlSeconds: command.ttlSeconds,
      })
      options.stdout.write(`Autoprompt activation ${result.activationId}: status=${result.status} revoked=true\n`)
      return result.status
    } catch (error) {
      options.stderr.write(`Autoprompt activate (codex): ${error.message}\n`)
      return 1
    }
  }

  const lifecycleOptions = command.root
    ? { ...options, env: { ...options.env, AUTOPROMPT_INSTALL_ROOT: command.root } }
    : options
  return runScript(command, lifecycleOptions)
}

if (require.main === module) process.exitCode = run(process.argv.slice(2))

module.exports = {
  HELP_TEXT,
  PROVIDERS,
  isSupportedNodeVersion,
  parseArgs,
  providerInstallLocations,
  providerInstallState,
  queryLatestVersion,
  queryLatestGitHubRevision,
  resolveInteractiveUpdateStatus,
  run,
}
