'use strict'

// Three fixed, diagnostic-only observations. No arm admits or exports a runtime.
const assert = require('node:assert/strict')
const cp = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const VARIANTS = Object.freeze(['baseline', 'heva-off', 'bottom-up-off'])
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')

function observeAll(invoke) {
  // A baseline failure must not discard the two distinguishing observations.
  return VARIANTS.map(variant => {
    try { return { variant, ...invoke(variant) } }
    catch (error) { return { variant, completed: false, error: String(error.message || error).slice(0, 2048) } }
  })
}

function assertComparable(arms) {
  let authority = null
  for (const arm of arms.filter(item => item.completed)) {
    const observation = arm.observation
    assert.ok(observation, 'Completed arm has no observation')
    assert.match(observation.tuple.identity, /^[a-f0-9]{64}$/)
    const inputs = { tuple: observation.tuple, runtime: observation.runtime, sourceHashes: observation.sourceHashes }
    if (authority) assert.deepEqual(inputs, authority, 'Diagnostic arms used different runtime or source inputs')
    else authority = inputs
  }
  return authority
}

function main(args) {
  assert.equal(args.length, 2, 'Usage: node compare.cjs REPO NEW_OUTPUT')
  assert.equal(process.platform, 'win32')
  assert.equal(process.arch, 'x64')
  const repo = fs.realpathSync.native(path.resolve(args[0]))
  const output = path.resolve(args[1])
  assert.equal(path.dirname(output), fs.realpathSync.native(path.dirname(output)))
  assert.equal(fs.existsSync(output), false, 'fresh output required')
  fs.mkdirSync(output)
  require(path.join(repo, 'agents/codex/workflow/safe-run-root.js')).ensureWindowsPrivateAcl(output)
  const runner = path.join(repo, 'scripts/windows-msys/fork-memory-diagnostic/run.cjs')
  const runnerSha256 = sha(fs.readFileSync(runner))
  const arms = observeAll(variant => {
    assert.equal(sha(fs.readFileSync(runner)), runnerSha256)
    const arm = path.join(output, variant)
    const result = cp.spawnSync(process.execPath, [runner, repo, arm, variant], {
      cwd: repo, env: process.env, encoding: 'utf8', windowsHide: true, shell: false,
      timeout: 450000, maxBuffer: 4 * 1024 * 1024,
    })
    const stdout = result.stdout || '', stderr = result.stderr || ''
    fs.writeFileSync(path.join(output, variant + '.stdout.txt'), stdout, { flag: 'wx' })
    fs.writeFileSync(path.join(output, variant + '.stderr.txt'), stderr, { flag: 'wx' })
    const summaryPath = path.join(arm, 'summary.json')
    let observation = null
    if (fs.existsSync(summaryPath)) {
      assert.ok(fs.statSync(summaryPath).size <= 2 * 1024 * 1024)
      observation = JSON.parse(fs.readFileSync(summaryPath, 'utf8'))
      assert.equal(observation.accepted, false)
      assert.equal(observation.variant, variant)
    }
    return {
      completed: !result.error && result.status === 0 && observation !== null,
      exitCode: result.status, signal: result.signal,
      errorCode: result.error && result.error.code || null,
      stdoutSha256: sha(stdout), stderrSha256: sha(stderr), observation,
    }
  })
  assert.equal(sha(fs.readFileSync(runner)), runnerSha256)
  let authority = null, comparisonError = null
  try { authority = assertComparable(arms) } catch (error) { comparisonError = String(error.message).slice(0, 2048) }
  const summary = { schema: 1, status: 'observed-not-accepted', accepted: false, runnerSha256, authority, comparisonError, arms }
  fs.writeFileSync(path.join(output, 'comparison.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' })
  process.stdout.write(JSON.stringify({ status: summary.status, accepted: false, arms: arms.map(({ variant, completed, exitCode, errorCode }) => ({ variant, completed, exitCode, errorCode })) }) + '\n')
  if (comparisonError || arms.some(arm => !arm.completed)) process.exitCode = 1
}

if (require.main === module) {
  try { main(process.argv.slice(2)) } catch (error) { process.stderr.write(String(error.stack || error) + '\n'); process.exitCode = 1 }
}
module.exports = { VARIANTS, observeAll, assertComparable }
