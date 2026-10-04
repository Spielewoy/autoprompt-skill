'use strict'
const assert = require('node:assert/strict')
const cp = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const source = path.resolve(__dirname, '../helpers/darwin-coalition-churn-api-stub.c')

test('actual candidate census/signal distinguishes vanished snapshots from permission, identity and coalition failures', { skip: process.platform === 'win32' }, t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ap-coalition-api-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const compiler = process.platform === 'darwin' ? '/usr/bin/clang' : 'cc'
  const flags = ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2']
  if (process.platform === 'darwin') {
    const sdk = cp.spawnSync('/usr/bin/xcrun', ['--show-sdk-path'], { encoding: 'utf8', timeout: 30000 })
    assert.equal(sdk.status, 0, sdk.stderr)
    flags.push('-isysroot', sdk.stdout.trim(), '-mmacosx-version-min=13.5')
  } else {
    // Portable control-flow replay only. Native CI uses the actual SDK above;
    // these minimal declarations never enter a packaged executable.
    fs.mkdirSync(path.join(root, 'bsm')); fs.mkdirSync(path.join(root, 'sys'))
    fs.writeFileSync(path.join(root, 'bsm/audit.h'), '#pragma once\n#include <stdint.h>\ntypedef struct { uint32_t val[8]; } audit_token_t;\n')
    fs.writeFileSync(path.join(root, 'libproc.h'), '#pragma once\n#include <stdint.h>\n#define PROC_PIDTBSDINFO 3\n#define PROC_UID_ONLY 3\nstruct proc_bsdinfo { uint32_t pbi_uid,pbi_gid,pbi_ruid,pbi_rgid; };\n')
    fs.writeFileSync(path.join(root, 'sys/sysctl.h'), '#pragma once\n#include <stddef.h>\n')
    flags.push('-D_GNU_SOURCE', '-I', root, '-ldl')
  }
  const executable = path.join(root, 'api-replay')
  const build = cp.spawnSync(compiler, [...flags, source, '-o', executable], { encoding: 'utf8', timeout: 30000 })
  assert.equal(build.status, 0, build.stderr)
  const run = (command, phase, result, errno, success) => {
    const execution = cp.spawnSync(executable, [command, phase, String(result), String(errno)], { encoding: 'utf8', timeout: 5000 })
    assert.equal(execution.status, success ? 0 : 74, `${command}/${phase}/${result}/${errno}: ${execution.stderr}\n${execution.stdout}`)
    const value = JSON.parse(execution.stdout)
    assert.equal(value.complete, success)
    assert.equal(value.ok, success)
    const members = command === 'census' ? value.members : value.attempts
    assert.ok(members.some(member => member.pid === 42421), 'held coalition member must remain visible/targeted')
    if (success) assert.deepEqual(value.errors, [])
    else assert.equal(value.errors.length, 1)
    return value
  }
  for (const command of ['census', 'signal']) {
    for (const result of [0, -1]) for (const errno of [os.constants.errno.ESRCH, os.constants.errno.ENOENT]) {
      const value = run(command, 'before', result, errno, true)
      assert.equal((value.members || value.attempts).some(member => member.pid === 42420), false)
      if (command === 'census') run(command, 'after', result, errno, true)
    }
    for (const errno of [os.constants.errno.EPERM, os.constants.errno.EACCES]) run(command, 'before', 0, errno, false)
    run(command, 'before', 1, os.constants.errno.ESRCH, false)
    run(command, 'coalition', 0, os.constants.errno.ESRCH, false)
  }
  for (const errno of [os.constants.errno.EPERM, os.constants.errno.EACCES]) run('census', 'after', 0, errno, false)
  assert.equal(run('census', 'identity', 0, 0, false).errors[0].phase, 'bind-after')
  assert.equal(run('census', 'uid', 0, 0, false).errors[0].phase, 'uid-mismatch')
  assert.equal(run('signal', 'audit', -1, os.constants.errno.ESRCH, false).errors[0].phase, 'audit-signal')
})
