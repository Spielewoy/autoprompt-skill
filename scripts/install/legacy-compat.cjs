#!/usr/bin/env node
'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const PACKAGE_ROOT = path.resolve(__dirname, '..', '..')
const HASH_PATTERN = /^[a-f0-9]{64}$/

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function listAnchoredTree(root) {
  let rootStats
  try {
    rootStats = fs.lstatSync(root)
  } catch {
    return null
  }
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) return null
  const directories = []
  const files = []
  const stack = [['', root]]
  while (stack.length > 0) {
    const [prefix, directory] = stack.pop()
    let children
    try {
      children = fs.readdirSync(directory, { withFileTypes: true })
    } catch {
      return null
    }
    children.sort((left, right) => left.name.localeCompare(right.name))
    for (const child of children) {
      const childPath = path.join(directory, child.name)
      let childStats
      try {
        childStats = fs.lstatSync(childPath)
      } catch {
        return null
      }
      if (childStats.isSymbolicLink()) return null
      const relative = prefix ? `${prefix}/${child.name}` : child.name
      if (childStats.isDirectory()) {
        directories.push(relative)
        stack.push([relative, childPath])
        continue
      }
      if (!childStats.isFile()) return null
      files.push(relative)
    }
  }
  return { directories: directories.sort(), files: files.sort() }
}

function listAnchoredFiles(root) {
  return listAnchoredTree(root)?.files || null
}

function loadLegacyCodexCompat(packageRoot = PACKAGE_ROOT) {
  const compatPath = path.join(packageRoot, 'scripts', 'install', 'legacy-codex-compat.json')
  const compat = JSON.parse(fs.readFileSync(compatPath, 'utf8'))
  if (compat.schemaVersion !== 1 || compat.provider !== 'codex') {
    throw new Error(`invalid legacy compatibility metadata: ${compatPath}`)
  }
  if (!Array.isArray(compat.directories) || !Array.isArray(compat.optionalDirectories) ||
      !Array.isArray(compat.files) ||
      !compat.sha256 || Array.isArray(compat.sha256) ||
      !compat.sizes || Array.isArray(compat.sizes)) {
    throw new Error(`invalid legacy compatibility inventory: ${compatPath}`)
  }
  const sortedFiles = [...compat.files].sort()
  if (JSON.stringify(sortedFiles) !== JSON.stringify(compat.files)) {
    throw new Error(`legacy compatibility files must be sorted: ${compatPath}`)
  }
  if (new Set(compat.files).size !== compat.files.length) {
    throw new Error(`legacy compatibility files must be unique: ${compatPath}`)
  }
  const sortedDirectories = [...compat.directories].sort()
  const sortedOptionalDirectories = [...compat.optionalDirectories].sort()
  if (JSON.stringify(sortedDirectories) !== JSON.stringify(compat.directories) ||
      new Set(compat.directories).size !== compat.directories.length ||
      JSON.stringify(sortedOptionalDirectories) !== JSON.stringify(compat.optionalDirectories) ||
      new Set(compat.optionalDirectories).size !== compat.optionalDirectories.length ||
      compat.optionalDirectories.some(directory => compat.directories.includes(directory))) {
    throw new Error(`legacy compatibility directories must be sorted and unique: ${compatPath}`)
  }
  if ([...compat.directories, ...compat.optionalDirectories, ...compat.files].some(file => (
    typeof file !== 'string' ||
    !file ||
    path.isAbsolute(file) ||
    file.split('/').some(part => !part || part === '.' || part === '..') ||
    file.includes('\\')
  ))) {
    throw new Error(`legacy compatibility files must be anchored: ${compatPath}`)
  }
  if (JSON.stringify(Object.keys(compat.sha256)) !== JSON.stringify(compat.files)) {
    throw new Error(`legacy compatibility hashes must exactly match files: ${compatPath}`)
  }
  if (JSON.stringify(Object.keys(compat.sizes)) !== JSON.stringify(compat.files)) {
    throw new Error(`legacy compatibility sizes must exactly match files: ${compatPath}`)
  }
  for (const hash of Object.values(compat.sha256)) {
    if (!HASH_PATTERN.test(hash)) {
      throw new Error(`invalid legacy compatibility hash: ${compatPath}`)
    }
  }
  for (const size of Object.values(compat.sizes)) {
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(`invalid legacy compatibility size: ${compatPath}`)
    }
  }
  return compat
}

function detectLegacyCodexInstall(root, options = {}) {
  const packageRoot = options.packageRoot || PACKAGE_ROOT
  const skillRoot = path.join(root, 'skills', 'autoprompt')
  const blockedPaths = [
    path.join(root, '.autoprompt-install-receipt.json'),
    path.join(root, '.autoprompt-install-hashes.json'),
    path.join(root, '.autoprompt-legacy-codex-recovery.clixml'),
    path.join(root, '.autoprompt-legacy-codex-recovery'),
    path.join(root, 'autoprompt.config.toml'),
    path.join(skillRoot, 'VERSION'),
    path.join(skillRoot, 'README.md'),
    path.join(skillRoot, 'agents-runtime'),
    path.join(skillRoot, 'workflow', 'codex-agent-casting.js'),
    path.join(skillRoot, 'workflow', 'codex-agent-profile.js'),
  ]
  if (blockedPaths.some(blocked => fs.existsSync(blocked))) {
    return { matched: false, files: [] }
  }

  const compat = loadLegacyCodexCompat(packageRoot)
  const actualTree = listAnchoredTree(skillRoot)
  if (actualTree === null || actualTree.files.length !== compat.files.length) {
    return { matched: false, files: [] }
  }
  const allowedDirectories = new Set([...compat.directories, ...compat.optionalDirectories])
  if (compat.directories.some(directory => !actualTree.directories.includes(directory)) ||
      actualTree.directories.some(directory => !allowedDirectories.has(directory))) {
    return { matched: false, files: [] }
  }
  for (const relativePath of actualTree.files) {
    if (!Object.prototype.hasOwnProperty.call(compat.sha256, relativePath)) {
      return { matched: false, files: [] }
    }
    const absolutePath = path.join(skillRoot, ...relativePath.split('/'))
    if (fs.statSync(absolutePath).size !== compat.sizes[relativePath]) {
      return { matched: false, files: [] }
    }
    if (sha256(absolutePath) !== compat.sha256[relativePath]) {
      return { matched: false, files: [] }
    }
  }
  return {
    matched: true,
    directories: actualTree.directories.map(relativePath => (
      path.join(skillRoot, ...relativePath.split('/'))
    )),
    files: actualTree.files.map(relativePath => path.join(skillRoot, ...relativePath.split('/'))),
  }
}

function detectLegacyInstall(provider, root, options = {}) {
  if (provider === 'codex') return detectLegacyCodexInstall(root, options)
  return { matched: false, directories: [], files: [] }
}

function main(argv) {
  if (argv.length !== 3 || !['match', 'files', 'files0', 'directories0'].includes(argv[0])) {
    process.stderr.write(
      'Usage: legacy-compat.cjs match|files|files0|directories0 <provider> <root>\n',
    )
    return 2
  }
  let result
  try {
    result = detectLegacyInstall(argv[1], path.resolve(argv[2]), { packageRoot: PACKAGE_ROOT })
  } catch (error) {
    process.stderr.write(`Autoprompt legacy compatibility check failed: ${error.message}\n`)
    return 2
  }
  if (!result.matched) return 1
  if (argv[0] === 'files' && result.files.length > 0) {
    process.stdout.write(`${result.files.join('\n')}\n`)
  }
  if (argv[0] === 'files0' && result.files.length > 0) {
    process.stdout.write(`${result.files.join('\0')}\0`)
  }
  if (argv[0] === 'directories0' && result.directories.length > 0) {
    const directories = [...result.directories].sort((left, right) => (
      right.split(path.sep).length - left.split(path.sep).length || right.localeCompare(left)
    ))
    process.stdout.write(`${directories.join('\0')}\0`)
  }
  return 0
}

if (require.main === module) process.exitCode = main(process.argv.slice(2))

module.exports = {
  detectLegacyCodexInstall,
  detectLegacyInstall,
  listAnchoredFiles,
  listAnchoredTree,
  loadLegacyCodexCompat,
}
