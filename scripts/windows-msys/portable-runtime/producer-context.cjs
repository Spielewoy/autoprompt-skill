'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const https = require('node:https')
const path = require('node:path')
const { canonical, read, hash, checksums } = require('./portable.cjs')
const { exportAuthority } = require('./cli.cjs')

const JOB_NAME = 'Platform and installer / windows-latest / Node 24.x'
const MAX_RESPONSE = 2 * 1024 * 1024
const MAX_JOBS = 200
const REQUEST_TIMEOUT = 10000

function environment(env) {
  assert.equal(env.GITHUB_ACTIONS, 'true', 'Producer context requires GitHub Actions')
  assert.equal(env.GITHUB_API_URL, 'https://api.github.com', 'Unexpected GitHub API origin')
  assert.equal(env.GITHUB_SERVER_URL, 'https://github.com', 'Unexpected GitHub server origin')
  assert.equal(env.GITHUB_JOB, 'platform-primitives', 'Unexpected workflow job role')
  assert.equal(env.RUNNER_OS, 'Windows')
  assert.equal(env.RUNNER_ARCH, 'X64')
  assert.equal(env.GITHUB_REF, 'refs/heads/codex/issue-27-native-platform-support')
  assert.ok(['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME), 'Unexpected producer event')
  assert.match(env.GITHUB_REPOSITORY, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
  assert.ok(env.GITHUB_REPOSITORY.split('/').every(part => part !== '.' && part !== '..'))
  assert.match(env.GITHUB_SHA, /^[a-f0-9]{40}$/)
  assert.match(env.GITHUB_RUN_ID, /^[1-9][0-9]{0,14}$/)
  assert.match(env.GITHUB_RUN_ATTEMPT, /^[1-9][0-9]{0,3}$/)
  return Object.freeze({ repository: env.GITHUB_REPOSITORY, headSha: env.GITHUB_SHA,
    runId: env.GITHUB_RUN_ID, runAttempt: Number(env.GITHUB_RUN_ATTEMPT), architecture: 'x64' })
}

function apiReader(token) {
  assert.equal(typeof token, 'string', 'A workflow token with actions:read is required')
  assert.ok(token.length > 0 && token.length <= 4096 && /^[A-Za-z0-9_.-]+$/.test(token), 'Invalid workflow token')
  return function getJson(apiPath) {
    assert.match(apiPath, /^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[1-9][0-9]*(?:\/attempts\/[1-9][0-9]*\/jobs\?per_page=100&page=[12])?$/)
    assert.ok(!apiPath.includes('/../') && !apiPath.includes('/./'), 'API path traversal refused')
    return new Promise((resolve, reject) => {
      let request
      const timer = setTimeout(() => request.destroy(new Error('GitHub API request deadline exceeded')), REQUEST_TIMEOUT)
      request = https.get({ hostname: 'api.github.com', port: 443, path: apiPath, method: 'GET',
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
          'User-Agent': 'autoprompt-native-candidate-context', 'X-GitHub-Api-Version': '2022-11-28',
          'Accept-Encoding': 'identity' },
      }, response => {
        if (response.statusCode !== 200) {
          response.resume()
          request.destroy(new Error(`GitHub API returned HTTP ${response.statusCode}`))
          return
        }
        const chunks = []
        let size = 0
        response.on('data', chunk => {
          size += chunk.length
          if (size > MAX_RESPONSE) request.destroy(new Error('GitHub API response exceeded bound'))
          else chunks.push(chunk)
        })
        response.on('end', () => {
          clearTimeout(timer)
          try {
            assert.ok(!response.headers['content-encoding'] || response.headers['content-encoding'] === 'identity')
            const bytes = Buffer.concat(chunks)
            const text = bytes.toString('utf8')
            assert.ok(Buffer.from(text).equals(bytes))
            resolve(JSON.parse(text))
          } catch { reject(new Error('GitHub API returned invalid bounded JSON')) }
        })
        response.on('error', () => { clearTimeout(timer); reject(new Error('GitHub API response failed')) })
      })
      request.on('error', error => {
        clearTimeout(timer)
        // Never print request objects, HTTP bodies, headers, tokens or network errors.
        const allowed = ['GitHub API request deadline exceeded', 'GitHub API response exceeded bound']
        reject(new Error(allowed.includes(error.message) || /^GitHub API returned HTTP [0-9]{3}$/.test(error.message)
          ? error.message : 'GitHub API request failed'))
      })
    })
  }
}

function verifyRun(run, expected) {
  assert.ok(Number.isSafeInteger(run.id) && String(run.id) === expected.runId, 'Workflow run ID differs')
  assert.equal(run.run_attempt, expected.runAttempt, 'Workflow run attempt differs')
  assert.equal(run.head_sha, expected.headSha, 'Workflow head differs')
  assert.equal(run.repository.full_name, expected.repository, 'Workflow repository differs')
  assert.equal(run.path, '.github/workflows/native-platform.yml', 'Unexpected workflow file')
  assert.equal(run.status, 'in_progress', 'Producer run is not currently running')
  assert.equal(run.conclusion, null, 'Producer run has already concluded')
}

async function currentProducer(expected, getJson) {
  const base = `/repos/${expected.repository}/actions/runs/${expected.runId}`
  verifyRun(await getJson(base), expected)
  const jobs = []
  let total
  for (let page = 1; page <= 2; page++) {
    const result = await getJson(`${base}/attempts/${expected.runAttempt}/jobs?per_page=100&page=${page}`)
    assert.ok(Number.isSafeInteger(result.total_count) && result.total_count > 0 && result.total_count <= MAX_JOBS,
      'Workflow job inventory is unbounded or empty')
    if (total === undefined) total = result.total_count
    assert.equal(result.total_count, total, 'Workflow job inventory changed during pagination')
    assert.ok(Array.isArray(result.jobs) && result.jobs.length > 0 && result.jobs.length <= 100)
    jobs.push(...result.jobs)
    if (jobs.length >= total) break
    assert.equal(result.jobs.length, 100, 'Truncated workflow job page')
  }
  assert.equal(jobs.length, total, 'Incomplete workflow job inventory')
  assert.equal(new Set(jobs.map(job => job.id)).size, jobs.length, 'Duplicate workflow job ID')
  const matches = jobs.filter(job => job.name === JOB_NAME)
  assert.equal(matches.length, 1, 'Producer job name must match exactly once')
  const job = matches[0]
  assert.ok(Number.isSafeInteger(job.id) && job.id > 0)
  assert.ok(Number.isSafeInteger(job.run_id) && String(job.run_id) === expected.runId)
  assert.equal(job.run_url, `https://api.github.com${base}`)
  assert.equal(job.head_sha, expected.headSha)
  assert.equal(job.status, 'in_progress', 'Producer job is not currently running')
  assert.equal(job.conclusion, null)
  // The attempt-specific endpoint supplies attempt identity even when the job
  // object omits run_attempt. If returned, it must agree as well.
  if (job.run_attempt !== undefined) assert.equal(job.run_attempt, expected.runAttempt)
  verifyRun(await getJson(base), expected)
  return Object.freeze({ ...expected, jobId: String(job.id) })
}

function observedTools(buildRoot) {
  const payload = path.join(path.resolve(buildRoot), 'sdk/issue27-build')
  const before = read(path.join(payload, 'toolchain-inputs.sha256'))
  const after = read(path.join(payload, 'toolchain-outputs.sha256'))
  assert.ok(before.equals(after), 'Compiler/linker before and after receipts differ')
  const tools = checksums(before, '/usr/bin/')
  assert.deepEqual([...tools.keys()], ['/usr/bin/gcc.exe', '/usr/bin/ld.exe'])
  const bootstrap = checksums(read(path.join(payload, 'bootstrap-runtime.sha256')), '/usr/bin/')
  assert.deepEqual([...bootstrap.keys()], ['/usr/bin/msys-2.0.dll'])
  for (const [name, expected] of [...tools, ...bootstrap]) {
    assert.equal(hash(read(path.join(buildRoot, 'sdk', name.slice(1)))), expected,
      'Current owned SDK tool differs from its compiler receipt')
  }
  return { linkerSha256: tools.get('/usr/bin/ld.exe'),
    bootstrapRuntimeSha256: bootstrap.get('/usr/bin/msys-2.0.dll') }
}

async function main(args) {
  assert.equal(args.length, 3, 'Usage: producer-context.cjs REPO BUILD_ROOT NEW_CONTEXT_JSON')
  assert.equal(process.platform, 'win32', 'Producer requires native Windows')
  assert.equal(process.arch, 'x64', 'Producer requires the x64 Node process')
  const [repoRoot, buildRoot, outputArg] = args.map(value => path.resolve(value))
  const expected = environment(process.env)
  const producer = await currentProducer(expected, apiReader(process.env.GITHUB_TOKEN))
  const context = { schema: 1, producer, observedTools: observedTools(buildRoot) }
  const authority = exportAuthority(repoRoot, context)
  const gcc = checksums(read(path.join(buildRoot, 'sdk/issue27-build/toolchain-inputs.sha256')), '/usr/bin/').get('/usr/bin/gcc.exe')
  assert.equal(gcc, authority.bindings.gccSha256, 'Observed compiler differs from pinned checkout compiler')
  const parent = path.dirname(outputArg)
  assert.equal(fs.realpathSync.native(parent), parent, 'Context destination parent must be physical')
  fs.writeFileSync(outputArg, canonical(context), { flag: 'wx', mode: 0o600 })
  return { status: 'producer-context-written-not-runtime-acceptance', contextPath: outputArg,
    producer, contextSha256: hash(read(outputArg)) }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(result => process.stdout.write(canonical(result)))
    .catch(error => { process.stderr.write(`Producer context refused: ${error.message}\n`); process.exitCode = 1 })
}

module.exports = { JOB_NAME, environment, apiReader, verifyRun, currentProducer, observedTools, main }
