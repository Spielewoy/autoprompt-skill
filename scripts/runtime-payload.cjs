#!/usr/bin/env node
'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const HASH_PATTERN = /^[a-f0-9]{64}$/
const PROVIDERS = {
  claude: {
    topLevel: ['GATES.md', 'MODES.md', 'PLAYBOOKS.md', 'VERSION', 'autoprompt-models.schema.md'],
    agents: 'personas',
    workflow: [
      'agent-definitions-cli.js',
      'autoprompt-gate.js',
      'autoprompt-ledger-check.js',
      'model-casting.js',
      'phase-budget.js',
      'supervisor.ps1',
      'supervisor.sh',
    ],
  },
  codex: {
    topLevel: ['GATES.md', 'MODES.md', 'PLAYBOOKS.md', 'VERSION'],
    agents: 'codex-personas',
    workflow: [
      'codex-agent-casting.js',
      'codex-agent-profile.js',
      'phase-budget.js',
      'supervisor.ps1',
      'supervisor.sh',
    ],
  },
  opencode: {
    topLevel: ['GATES.md', 'MODES.md', 'PLAYBOOKS.md', 'VERSION', 'autoprompt.opencode.json'],
    agents: 'personas',
    workflow: ['launch-opencode.ps1', 'launch-opencode.sh'],
  },
  prime: {
    topLevel: [
      'extensions/autoprompt.ts',
      'package.json',
      'skills/autoprompt/SKILL.md',
      'skills/autoprompt/pyproject.toml',
      'skills/autoprompt/src/autoprompt/__init__.py',
    ],
    agents: 'prime-personas',
    agentRoot: 'personas',
    frameworkRoot: 'prompts/frameworks',
    workflow: [],
  },
  kilo: {
    topLevel: ['GATES.md', 'MODES.md', 'PLAYBOOKS.md', 'VERSION', 'autoprompt.kilo.json'],
    agents: 'personas',
    workflow: [],
  },
  vscode: {
    topLevel: ['GATES.md', 'MODES.md', 'PLAYBOOKS.md', 'README.md', 'SKILL.md', 'VERSION'],
    agents: 'vscode-personas',
    workflow: [],
  },
  omp: {
    topLevel: ['GATES.md', 'MODES.md', 'PLAYBOOKS.md', 'README.md', 'VERSION'],
    agents: 'personas',
    workflow: [],
  },
  deepseek: {
    topLevel: [
      'GATES.md',
      'MODES.md',
      'PLAYBOOKS.md',
      'README.md',
      'VERSION',
      'agent-preset/agent.cordis.yml',
      'agent-preset/preset.yml',
      'headless.patch.yml',
    ],
    agents: 'personas',
    workflow: [],
  },
  reasonix: {
    topLevel: ['GATES.md', 'MODES.md', 'PLAYBOOKS.md', 'README.md', 'VERSION'],
    agents: 'reasonix-personas',
    agentRoot: 'skills',
    workflow: [],
  },
  hermes: {
    topLevel: ['GATES.md', 'MODES.md', 'PLAYBOOKS.md', 'README.md', 'VERSION'],
    agents: 'hermes-personas',
    agentRoot: 'skills',
    workflow: [],
  },
}

function canonicalBytes(filePath) {
  const bytes = fs.readFileSync(filePath)
  return Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(canonicalBytes(filePath)).digest('hex')
}

function runtimeFiles(provider, root = ROOT) {
  const definition = PROVIDERS[provider]
  const contract = JSON.parse(fs.readFileSync(path.join(root, 'agents', 'contracts', 'autoprompt.contract.json'), 'utf8'))
  const files = [...definition.topLevel]
  const frameworkRoot = definition.frameworkRoot || 'frameworks'
  files.push(...contract.frameworks.map(framework => `${frameworkRoot}/${framework.id}.md`))
  const agents = definition.agents === 'personas'
    ? contract.personas.map(persona => `${persona.id}.md`)
    : definition.agents === 'codex-personas'
      ? ['openai.yaml', ...contract.personas.map(persona => `${persona.id}.toml`)]
      : definition.agents === 'vscode-personas'
        ? contract.personas.map(persona => `${persona.id}.agent.md`)
        : definition.agents === 'prime-personas'
          ? contract.personas.map(persona => `${persona.id}.md`)
          : definition.agents === 'reasonix-personas'
            ? contract.personas.map(persona => `${persona.id}/SKILL.md`)
            : definition.agents === 'hermes-personas'
              ? contract.personas.map(persona => `${persona.id}/SKILL.md`)
              : definition.agents
  const agentRoot = definition.agentRoot || 'agents'
  files.push(...agents.map(agent => `${agentRoot}/${agent}`))
  files.push(...definition.workflow.map(file => `workflow/${file}`))
  return files.sort()
}

function renderManifest(provider, root = ROOT) {
  const files = runtimeFiles(provider, root)
  const hashes = {}
  for (const relativePath of files) {
    hashes[relativePath] = sha256(path.join(root, 'agents', provider, relativePath))
  }
  return {
    schemaVersion: 1,
    provider,
    sourceRoot: `agents/${provider}`,
    files,
    sha256: hashes,
  }
}

function renderManifests(root = ROOT) {
  return new Map(Object.keys(PROVIDERS).map(provider => [
    `agents/manifests/${provider}-runtime.json`,
    renderManifest(provider, root),
  ]))
}

function serializeManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`
}

function writeAtomic(filePath, content) {
  const temporary = `${filePath}.tmp-${process.pid}`
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(temporary, content, 'utf8')
  fs.renameSync(temporary, filePath)
}

function validateRelativePath(relativePath) {
  const hasControlCharacter = typeof relativePath === 'string' &&
    [...relativePath].some(character => {
      const code = character.charCodeAt(0)
      return code <= 31 || code === 127
    })
  if (typeof relativePath !== 'string' || !relativePath ||
      relativePath.includes('\\') || hasControlCharacter) {
    throw new Error(`invalid runtime path: ${relativePath}`)
  }
  const normalized = path.posix.normalize(relativePath)
  if (normalized !== relativePath || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    throw new Error(`unsafe runtime path: ${relativePath}`)
  }
}

function loadManifest(provider, root = ROOT) {
  if (!PROVIDERS[provider]) throw new Error(`unknown runtime provider: ${provider}`)
  const manifestPath = path.join(root, 'agents', 'manifests', `${provider}-runtime.json`)
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (manifest.schemaVersion !== 1 || manifest.provider !== provider || manifest.sourceRoot !== `agents/${provider}`) {
    throw new Error(`invalid runtime manifest metadata: ${manifestPath}`)
  }
  if (!Array.isArray(manifest.files) || !manifest.sha256 || Array.isArray(manifest.sha256)) {
    throw new Error(`invalid runtime manifest inventory: ${manifestPath}`)
  }
  const sorted = [...manifest.files].sort()
  if (new Set(sorted).size !== sorted.length || sorted.some((file, index) => file !== manifest.files[index])) {
    throw new Error(`runtime manifest files must be unique and sorted: ${manifestPath}`)
  }
  for (const relativePath of manifest.files) validateRelativePath(relativePath)
  if (JSON.stringify(Object.keys(manifest.sha256)) !== JSON.stringify(manifest.files)) {
    throw new Error(`runtime manifest hashes must exactly match files: ${manifestPath}`)
  }
  for (const hash of Object.values(manifest.sha256)) {
    if (!HASH_PATTERN.test(hash)) throw new Error(`invalid runtime SHA-256 in ${manifestPath}`)
  }
  return manifest
}

function verifySource(manifest, root = ROOT) {
  const sourceRoot = path.join(root, manifest.sourceRoot)
  for (const relativePath of manifest.files) {
    const source = path.join(sourceRoot, ...relativePath.split('/'))
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
      throw new Error(`missing runtime source: ${relativePath}`)
    }
    if (sha256(source) !== manifest.sha256[relativePath]) {
      throw new Error(`source hash mismatch: ${relativePath}`)
    }
  }
}

function listFiles(directory, prefix) {
  const files = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relativePath = `${prefix}/${entry.name}`
    const absolutePath = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...listFiles(absolutePath, relativePath))
    else if (entry.isFile()) files.push(relativePath)
  }
  return files.sort()
}

function managedFiles(manifest, destination) {
  const topLevel = new Set(manifest.files.map(file => file.split('/')[0]))
  const files = []
  for (const entry of topLevel) {
    const target = path.join(destination, entry)
    if (!fs.existsSync(target)) continue
    const stats = fs.statSync(target)
    if (stats.isFile()) files.push(entry)
    if (stats.isDirectory()) files.push(...listFiles(target, entry))
  }
  return files.sort()
}

function removeEmptyDirectories(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) removeEmptyDirectories(path.join(directory, entry.name))
  }
  if (fs.readdirSync(directory).length === 0) fs.rmdirSync(directory)
}

function prunePayload(provider, destination, root = ROOT) {
  const manifest = loadManifest(provider, root)
  const expected = new Set(manifest.files)
  const removed = []
  for (const relativePath of managedFiles(manifest, destination)) {
    if (expected.has(relativePath)) continue
    fs.unlinkSync(path.join(destination, ...relativePath.split('/')))
    removed.push(relativePath)
  }
  for (const entry of new Set(manifest.files.map(file => file.split('/')[0]))) {
    const target = path.join(destination, entry)
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) removeEmptyDirectories(target)
  }
  return removed
}

function installPayload(provider, destination, root = ROOT) {
  const manifest = loadManifest(provider, root)
  verifySource(manifest, root)
  fs.mkdirSync(destination, { recursive: true })
  prunePayload(provider, destination, root)
  const sourceRoot = path.join(root, manifest.sourceRoot)
  for (const relativePath of manifest.files) {
    const source = path.join(sourceRoot, ...relativePath.split('/'))
    const target = path.join(destination, ...relativePath.split('/'))
    const temporary = `${target}.tmp-${process.pid}`
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(temporary, canonicalBytes(source))
    fs.renameSync(temporary, target)
  }
  for (const entry of new Set(manifest.files.map(file => file.split('/')[0]))) {
    const target = path.join(destination, entry)
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) removeEmptyDirectories(target)
  }
  verifyPayload(provider, destination, root)
  return manifest.files.map(relativePath => path.join(destination, ...relativePath.split('/')))
}

function verifyPayload(provider, destination, root = ROOT) {
  const manifest = loadManifest(provider, root)
  verifySource(manifest, root)
  const expected = new Set(manifest.files)
  for (const relativePath of manifest.files) {
    const target = path.join(destination, ...relativePath.split('/'))
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      throw new Error(`missing runtime file: ${relativePath}`)
    }
    if (sha256(target) !== manifest.sha256[relativePath]) {
      throw new Error(`installed hash mismatch: ${relativePath}`)
    }
  }
  for (const relativePath of managedFiles(manifest, destination)) {
    if (!expected.has(relativePath)) throw new Error(`unexpected runtime file: ${relativePath}`)
  }
  return { files: manifest.files.length, provider }
}

function parseCommand(argv) {
  if (argv.length === 1 && ['--check', '--generate'].includes(argv[0])) {
    return { action: argv[0].slice(2) }
  }
  if (argv.length === 2 && ['--inventory', '--list'].includes(argv[0])) {
    return { action: argv[0].slice(2), provider: argv[1] }
  }
  if (argv.length === 4 && ['--install', '--verify', '--prune'].includes(argv[0]) && argv[2] === '--destination') {
    return { action: argv[0].slice(2), provider: argv[1], destination: path.resolve(argv[3]) }
  }
  return null
}

function run(argv, root = ROOT, io = process) {
  const command = parseCommand(argv)
  if (!command) {
    io.stderr.write('runtime-payload: usage: --check | --generate | --inventory <provider> | --list <provider> | --install|--verify|--prune <provider> --destination <path>\n')
    return 2
  }
  try {
    if (command.action === 'check' || command.action === 'generate') {
      const outputs = renderManifests(root)
      const stale = []
      for (const [relativePath, manifest] of outputs) {
        const expected = serializeManifest(manifest)
        const target = path.join(root, relativePath)
        const actual = fs.existsSync(target) ? fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n') : null
        if (actual !== expected) stale.push(relativePath)
        if (command.action === 'generate') writeAtomic(target, expected)
      }
      if (command.action === 'check' && stale.length) {
        io.stderr.write(`runtime-payload: stale manifests: ${stale.join(', ')}\n`)
        return 1
      }
      io.stdout.write(command.action === 'check'
        ? 'runtime manifests are current\n'
        : `generated ${outputs.size} runtime manifests\n`)
      return 0
    }
    if (command.action === 'inventory' || command.action === 'list') {
      const manifest = loadManifest(command.provider, root)
      if (command.action === 'list') verifySource(manifest, root)
      io.stdout.write(`${manifest.files.join('\n')}\n`)
      return 0
    }
    if (command.action === 'prune') {
      const removed = prunePayload(command.provider, command.destination, root)
      io.stdout.write(`pruned provider=${command.provider} files=${removed.length}\n`)
      return 0
    }
    if (command.action === 'install') {
      const files = installPayload(command.provider, command.destination, root)
      io.stdout.write(`installed provider=${command.provider} files=${files.length}\n`)
      return 0
    }
    const verified = verifyPayload(command.provider, command.destination, root)
    io.stdout.write(`verified provider=${verified.provider} files=${verified.files}\n`)
    return 0
  } catch (error) {
    io.stderr.write(`runtime-payload: ${error.message}\n`)
    return 1
  }
}

if (require.main === module) process.exitCode = run(process.argv.slice(2))

module.exports = { installPayload, loadManifest, prunePayload, renderManifests, run, verifyPayload }
