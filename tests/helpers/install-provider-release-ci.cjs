'use strict'

// Acquire the exact upstream release artifact for the actual runner. This
// test helper never invokes an installer or selects a host-emulated binary.
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const hashes = Object.freeze({
  'darwin-arm64': '66c09cc5ffc8e080335649579c7cc32212d7e2a13d486a14f45d00f3088ea6d2',
  'darwin-x64': 'bf5653dfc74bc9aa6edd6967323cabf0cfb76ade80f669ae2e554f27fa2dad0e',
  'linux-arm64': '93ba1143e95c6a138ecfaea5efa6057e45aa6e40853d88a55b48586d118f7325',
  'linux-x64': '27dd66cb6a2c39fff51e1fe6db40f1f376fee4a3d04457f236edaa5d0290e4d2',
  'windows-arm64': '9b70fe6b3a3dd69c5ba8f089777f05bc12f68c477f89a226a5863fe8b431192b',
  'windows-x64': 'f5b46850f92ad2c2aa337b094fbf51742417ecdd808c088e24bb3d21b19e5177',
})
async function main() {
  assert.ok(process.env.GITHUB_ENV, 'This acquisition helper requires a CI environment file')
  const provider = process.argv[2]
  assert.ok(['omp', 'prime'].includes(provider), 'Select an exact reviewed release')
  const key = `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`
  if (provider === 'omp') assert.ok(Object.hasOwn(hashes, key), `No native OMP release for ${key}`)
  const name = provider === 'prime' ? 'prime-agent-0.7.2.tgz' : `omp-${key}${process.platform === 'win32' ? '.exe' : ''}`
  const version = provider === 'prime' ? '0.7.2' : '18.1.14'
  const url = provider === 'prime'
    ? `https://github.com/PrimeIntellect-ai/prime-agent/releases/download/v0.7.2/${name}`
    : `https://github.com/can1357/oh-my-pi/releases/download/v18.1.14/${name}`
  const expected = provider === 'prime' ? 'bc5471f2a626d727b88a45eb745fff93b10c554a3c4fc5912f25d8c64b987f5e' : hashes[key]
  const response = await fetch(url, { signal: AbortSignal.timeout(240000) })
  assert.equal(response.ok, true, `Provider release download returned ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
  assert.equal(sha256, expected, 'Provider release bytes differ from the reviewed GitHub asset digest')
  // A standalone binary must not inherit the checkout's unrelated package.json
  // as its runtime closure (test logs in that checkout change during testing).
  const destination = provider === 'omp'
    ? fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, 'autoprompt-omp-release-'))
    : path.resolve('.native-provider')
  fs.mkdirSync(destination, { recursive: true })
  const executable = path.join(destination, name)
  fs.writeFileSync(executable, bytes, { flag: 'wx', mode: 0o700 })
  if (provider === 'omp') fs.appendFileSync(process.env.GITHUB_ENV, `AUTOPROMPT_OMP_TEST_CLI=${executable}\n`)
  process.stdout.write(JSON.stringify({ provider, version, platform: process.platform, architecture: process.arch, url, sha256 }) + '\n')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
