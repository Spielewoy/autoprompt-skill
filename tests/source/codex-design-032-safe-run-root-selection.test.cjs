'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '..', '..')
const safeRoot = require(path.join(root, 'agents', 'codex', 'workflow', 'safe-run-root.js'))

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-design-032-selection-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

function treeSnapshot(directory) {
  const entries = []
  function visit(current, relative) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const filename = path.join(current, entry.name)
      const itemPath = relative ? `${relative}/${entry.name}` : entry.name
      entries.push({ path: itemPath, kind: entry.isDirectory() ? 'directory' : 'file' })
      if (entry.isDirectory()) visit(filename, itemPath)
      else entries.at(-1).sha256 = crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex')
    }
  }
  visit(directory, '')
  return entries
}

function expectedSidecar(privateRoot, targetIdentity) {
  const targetHash = crypto.createHash('sha256').update(targetIdentity).digest('hex')
  return path.join(privateRoot, 'targets', targetHash, '.autoprompt')
}

test('DESIGN-032 deterministically selects canonical sidecars for standalone archives, non-Git directories, and non-filesystem targets', t => {
  const directory = fixture(t)
  const privateRoot = path.join(directory, 'provider-private')

  const archiveDirectory = path.join(directory, 'archive-target')
  const archivePath = path.join(archiveDirectory, 'submission.zip')
  fs.mkdirSync(archiveDirectory)
  fs.writeFileSync(archivePath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]))
  const archiveBefore = treeSnapshot(archiveDirectory)
  const archiveOptions = {
    targetPath: archivePath,
    archive: true,
    allowProjectMutation: true,
    canonicalProviderPrivateRoot: privateRoot,
  }
  const archiveIdentity = safeRoot.canonicalTargetIdentity(archiveOptions)
  const archiveFirst = safeRoot.selectSafeRunRoot(archiveOptions)
  const archiveSecond = safeRoot.selectSafeRunRoot(archiveOptions)
  assert.equal(archiveFirst.kind, 'sidecar')
  assert.equal(archiveFirst.projectRejection, 'target is an archive or package input')
  assert.equal(archiveFirst.rootPath, expectedSidecar(privateRoot, archiveIdentity))
  assert.equal(archiveSecond.rootPath, archiveFirst.rootPath)
  assert.deepEqual(treeSnapshot(archiveDirectory), archiveBefore)

  const nonGitTarget = path.join(directory, 'plain-directory')
  fs.mkdirSync(nonGitTarget)
  fs.writeFileSync(path.join(nonGitTarget, 'source.txt'), 'unchanged\n')
  const nonGitBefore = treeSnapshot(nonGitTarget)
  const nonGitOptions = {
    targetPath: nonGitTarget,
    allowProjectMutation: true,
    canonicalProviderPrivateRoot: privateRoot,
  }
  const nonGitIdentity = safeRoot.canonicalTargetIdentity(nonGitOptions)
  const nonGitFirst = safeRoot.selectSafeRunRoot(nonGitOptions)
  const nonGitSecond = safeRoot.selectSafeRunRoot(nonGitOptions)
  assert.equal(nonGitFirst.kind, 'sidecar')
  assert.equal(nonGitFirst.projectRejection, 'non-Git targets use a sidecar')
  assert.equal(nonGitFirst.rootPath, expectedSidecar(privateRoot, nonGitIdentity))
  assert.equal(nonGitSecond.rootPath, nonGitFirst.rootPath)
  assert.deepEqual(treeSnapshot(nonGitTarget), nonGitBefore)
  assert.equal(fs.existsSync(path.join(nonGitTarget, '.autoprompt')), false)

  const remoteIdentity = 'codex-workspace://tenant/example/project/42'
  const nonFilesystemOptions = {
    targetKind: 'non-filesystem',
    targetIdentity: remoteIdentity,
    allowProjectMutation: true,
    canonicalProviderPrivateRoot: privateRoot,
  }
  const canonicalRemoteIdentity = `non-filesystem:${remoteIdentity}`
  const nonFilesystemFirst = safeRoot.selectSafeRunRoot(nonFilesystemOptions)
  const nonFilesystemSecond = safeRoot.selectSafeRunRoot(nonFilesystemOptions)
  assert.equal(nonFilesystemFirst.kind, 'sidecar')
  assert.equal(nonFilesystemFirst.targetPath, null)
  assert.equal(nonFilesystemFirst.targetIdentity, canonicalRemoteIdentity)
  assert.equal(nonFilesystemFirst.projectRejection, 'target is non-filesystem')
  assert.equal(nonFilesystemFirst.rootPath, expectedSidecar(privateRoot, canonicalRemoteIdentity))
  assert.equal(nonFilesystemSecond.rootPath, nonFilesystemFirst.rootPath)

  assert.equal(new Set([
    archiveFirst.rootPath,
    nonGitFirst.rootPath,
    nonFilesystemFirst.rootPath,
  ]).size, 3, 'distinct canonical target identities must not share sidecar roots')
})
