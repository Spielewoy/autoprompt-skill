#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe'

function bashPath(value) {
  return value.replaceAll('\\', '/').replace(
    /^([A-Za-z]):/,
    (_, drive) => `/${drive.toLowerCase()}`,
  )
}

test('POSIX receipt path validation is bounded and rejects traversal', {
  skip: process.platform !== 'win32' || !fs.existsSync(GIT_BASH),
  timeout: 12000,
}, () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-posix-paths-'))
  const home = path.join(sandbox, 'home')
  fs.mkdirSync(home, { recursive: true })
  const probe = [
    'set -e',
    `cd '${bashPath(ROOT)}'`,
    `export HOME='${bashPath(home)}'`,
    `export XDG_CONFIG_HOME='${bashPath(path.join(home, '.config'))}'`,
    'source scripts/install/lib/install-lib.sh',
    'for index in {1..40}; do',
    '  _uninstall_receipt_path_allowed "$HOME" "$HOME/.copilot/skills/autoprompt/file-$index.md"',
    'done',
    'if _uninstall_receipt_path_allowed "$HOME" "$HOME/../escaped.txt"; then exit 91; fi',
  ].join('\n')

  try {
    const completed = childProcess.spawnSync(
      GIT_BASH,
      [
        '--noprofile', '--norc', '-lc',
        'exec /usr/bin/timeout --signal=TERM --kill-after=1s 8s /usr/bin/bash --noprofile --norc -c "$AUTOPROMPT_POSIX_PATH_PROBE"',
      ],
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          AUTOPROMPT_POSIX_PATH_PROBE: probe,
          HOME: home,
          USERPROFILE: home,
          XDG_CONFIG_HOME: path.join(home, '.config'),
        },
        timeout: 11000,
      },
    )
    assert.equal(
      completed.status,
      0,
      `receipt path probe exceeded 8 seconds or failed\n${completed.stdout}\n${completed.stderr}`,
    )
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})
