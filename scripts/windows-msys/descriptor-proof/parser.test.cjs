'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { parseProof } = require('./run.cjs')
const encode = text => Buffer.from(text).toString('base64')
function proof() {
  const result = { schemaVersion: 1, objects: 16, sameProfileOpens: 16, otherProfileDenied: 16, pidLinkObjects: 1, sameProfilePidLinkOpens: 1, otherProfilePidLinkDenied: 1, drainedJobs: 3, namespaceCount: 2 }
  for (const [key, side, last] of [['creatorBase64', 'created', 'creator:16:descriptor-and-peer-effects-passed'], ['sameBase64', 'same', 'same-profile:16:passed'], ['otherBase64', 'other', 'other-profile:16:passed']]) {
    const lines = []
    for (let variant = 0; variant < 4; variant++) for (let kind = 0; kind < 4; kind++) lines.push(side === 'created' ? `created:variant=${variant}:kind=${kind}:effective-descriptor=passed` : `open:variant=${variant}:kind=${kind}:status=${side === 'same' ? '00000000' : 'c0000022'}:allowed=${side === 'same' ? 1 : 0}`)
    lines.push(side === 'created' ? 'created:pid-link:target=314159:helper-world=00000001:helper-package=10000000:effective-world=00000001:effective-package=000f0001:low-label=passed' : `open:pid-link:status=${side === 'same' ? '00000000' : 'c0000022'}:allowed=${side === 'same' ? 1 : 0}:target=${side === 'same' ? '314159' : 'denied'}`)
    lines.push(last)
    result[key] = encode(lines.join('\n') + '\n')
  }
  return result
}
test('exact sixteen-object plus PID-link peer proof is accepted', () => assert.deepEqual(parseProof(JSON.stringify(proof())), proof()))
for (const [name, mutate] of [
  ['missing drain', p => { p.drainedJobs = 2 }],
  ['missing object', p => { p.objects = 15 }],
  ['missing PID-link object', p => { p.pidLinkObjects = 0 }],
  ['namespace mismatch', p => { p.namespaceCount = 3 }],
  ['extra protocol field', p => { p.extra = true }],
  ['noncanonical base64', p => { p.sameBase64 += '\n' }],
  ['false same-profile success', p => { p.sameBase64 = encode(Buffer.from(p.sameBase64, 'base64').toString().replace('status=00000000', 'status=c0000022')) }],
  ['wrong-profile access allowed', p => { p.otherBase64 = encode(Buffer.from(p.otherBase64, 'base64').toString().replace('status=c0000022:allowed=0', 'status=00000000:allowed=1')) }],
  ['missing effective descriptor check', p => { p.creatorBase64 = encode(Buffer.from(p.creatorBase64, 'base64').toString().split('\n').slice(1).join('\n')) }],
  ['duplicate object check', p => { p.creatorBase64 = encode(Buffer.from(p.creatorBase64, 'base64').toString().replace('variant=0:kind=1', 'variant=0:kind=0')) }],
  ['wrong PID-link helper WORLD mask', p => { p.creatorBase64 = encode(Buffer.from(p.creatorBase64, 'base64').toString().replace('helper-world=00000001', 'helper-world=10000000')) }],
  ['wrong PID-link effective package mask', p => { p.creatorBase64 = encode(Buffer.from(p.creatorBase64, 'base64').toString().replace('effective-package=000f0001', 'effective-package=10000000')) }],
  ['wrong PID-link target', p => { p.sameBase64 = encode(Buffer.from(p.sameBase64, 'base64').toString().replace('target=314159', 'target=271828')) }],
  ['wrong-profile PID-link allowed', p => { p.otherBase64 = encode(Buffer.from(p.otherBase64, 'base64').toString().replace('open:pid-link:status=c0000022:allowed=0:target=denied', 'open:pid-link:status=00000000:allowed=1:target=314159')) }],
  ['missing final operation effects', p => { p.creatorBase64 = encode(Buffer.from(p.creatorBase64, 'base64').toString().replace('creator:16:descriptor-and-peer-effects-passed', 'creator:16:passed')) }],
]) test(name + ' refuses', () => { const p = proof(); mutate(p); assert.throws(() => parseProof(JSON.stringify(p))) })

test('descriptor fixture verifies exact low-label bytes independently of SDDL control flags', { timeout: 90000 }, t => {
  const cp = require('node:child_process'), path = require('node:path'), fs = require('node:fs'), os = require('node:os')
  const shell = process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'pwsh'
  const source = String.raw`public static class LabelContract {
    public static int Run() {
      var method=typeof(DescriptorController).GetMethod("ExactLowLabelAcl",System.Reflection.BindingFlags.NonPublic|System.Reflection.BindingFlags.Static);
      byte[] valid={2,0,28,0,1,0,0,0,17,0,20,0,1,0,0,0,1,1,0,0,0,0,0,16,0,16,0,0};
      System.Func<byte[],bool> check=bytes=>(bool)method.Invoke(null,new object[]{bytes});
      if(!check(valid))throw new System.Exception("exact-low-label-refused");
      byte[] ds=(byte[])valid.Clone();ds[0]=4;if(!check(ds))throw new System.Exception("DS-ACL-revision-refused");
      int cases=2;
      for(int i=0;i<valid.Length;i++){byte[] wrong=(byte[])valid.Clone();wrong[i]^=1;if(check(wrong))throw new System.Exception("invalid-label-byte-accepted:"+i);cases++;}
      foreach(byte[] wrong in new byte[][]{null,new byte[0],new byte[27],new byte[29]}){if(check(wrong))throw new System.Exception("invalid-label-size-accepted");cases++;}
      return cases;
    }
  }`
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'descriptor-label-contract-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const contract = path.join(directory, 'contract.cs'); fs.writeFileSync(contract, source)
  const result = cp.spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference="Stop";Add-Type -Path @($env:AP_LABEL_NATIVE,$env:AP_LABEL_CONTROLLER,$env:AP_LABEL_TEST);[LabelContract]::Run()'], {
    encoding: 'utf8', timeout: 60000, windowsHide: true,
    env: { ...process.env, AP_LABEL_NATIVE: path.resolve(__dirname, '../../../agents/codex/workflow/windows-appcontainer-native.cs'), AP_LABEL_CONTROLLER: path.join(__dirname, 'controller.cs'), AP_LABEL_TEST: contract },
  })
  if (result.error?.code === 'ENOENT' && process.platform !== 'win32') { t.skip('PowerShell unavailable for actual-source label contract'); return }
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(result.stderr, ''); assert.equal(result.stdout.trim(), '34')
})
