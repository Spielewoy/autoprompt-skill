'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { codexDarwinAssets } = require('../../scripts/runtime-payload.cjs')

test('Codex packages the exact native Darwin closure and refuses extra or tampered helpers', t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ap-darwin-assets-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.resolve(__dirname, '../../agents/codex/workflow')
  const runtime = path.join(root, 'darwin-coalition-runtime')
  fs.cpSync(path.join(source, 'darwin-coalition-runtime'), runtime, { recursive: true })
  fs.chmodSync(runtime, 0o700)
  fs.copyFileSync(path.join(source, 'darwin-coalition-helper.c'), path.join(root, 'darwin-coalition-helper.c'))
  assert.deepEqual(codexDarwinAssets(root), [
    'workflow/darwin-coalition-helper.c',
    'workflow/darwin-coalition-runtime/coalition-helper-arm64',
    'workflow/darwin-coalition-runtime/coalition-helper-x64',
    'workflow/darwin-coalition-runtime/manifest.json',
  ])
  const extra = path.join(runtime, 'extra')
  fs.writeFileSync(extra, 'unreviewed')
  assert.throws(() => codexDarwinAssets(root), /exactly its declared helper files/)
  fs.unlinkSync(extra)
  fs.appendFileSync(path.join(runtime, 'coalition-helper-arm64'), 'drift')
  assert.throws(() => codexDarwinAssets(root), /binding drifted/)
})
