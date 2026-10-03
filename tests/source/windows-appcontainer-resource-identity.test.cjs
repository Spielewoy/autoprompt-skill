'use strict'
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto')
const workflow = path.resolve(__dirname, '../../agents/codex/workflow')
const sources = [path.join(workflow, 'windows-appcontainer-native.cs'), path.join(workflow, 'windows-appcontainer-resources-native.cs'), path.resolve(__dirname, '../fixtures/windows-appcontainer/resource-identity-proof.cs')]
const windows = process.platform === 'win32'
const shell = () => windows ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : process.env.AUTOPROMPT_TEST_PWSH || 'pwsh'
const sha = b => crypto.createHash('sha256').update(b).digest('hex')
const names = ['no-change', 'outside-rename', 'creation-mismatch', 'sharing-denial', 'deleted-replacement', 'delete-pending', 'classic-delete-pending']

test('complete native resource identity fixture compiles against actual production sources', { timeout: 90000 }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-identity-compile-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const stub = path.join(root, 'serializer.cs'); fs.writeFileSync(stub, 'namespace System.Web.Script.Serialization { public class JavaScriptSerializer { public int MaxJsonLength {get;set;} public object DeserializeObject(string x){throw new System.NotSupportedException();} public T Deserialize<T>(string x){throw new System.NotSupportedException();} public string Serialize(object x){throw new System.NotSupportedException();} } }')
  const command = '$ErrorActionPreference="Stop";$files=[string[]]@($env:AP_ID_NATIVE,$env:AP_ID_RESOURCES,$env:AP_ID_FIXTURE);if($env:AP_ID_STUB){Add-Type -Path ($files+@($env:AP_ID_STUB))}else{Add-Type -Path $files -ReferencedAssemblies @("System.dll","System.Core.dll","System.Security.dll","System.Web.Extensions.dll")};if(-not [ResourceIdentityProof]::Contracts()){throw "identity contracts failed"};[Console]::Write("compiled")'
  const r = cp.spawnSync(shell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 60000, windowsHide: true, env: { ...process.env, AP_ID_NATIVE: sources[0], AP_ID_RESOURCES: sources[1], AP_ID_FIXTURE: sources[2], AP_ID_STUB: windows ? '' : stub } })
  if (r.error?.code === 'ENOENT' && !windows) { t.skip('PowerShell compiler unavailable; native identity proof remains required'); return }
  assert.ifError(r.error); assert.equal(r.status, 0, r.stderr || r.stdout); assert.equal(r.stderr, ''); assert.equal(r.stdout, 'compiled')
})

test('native Windows resource identity recovery preserves moved originals and refuses ambiguous lookup failures', { skip: !windows, timeout: 900000 }, t => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'resource-identity-native-')))
  let cleanupConfirmed = false
  t.after(() => { if (cleanupConfirmed) fs.rmSync(base, { recursive: true, force: true }); else t.diagnostic('Retained native resource identity plans and profiles: ' + base) })
  const { ensureWindowsPrivateAcl } = require('../../agents/codex/workflow/safe-run-root.js'); ensureWindowsPrivateAcl(base)
  const control = path.join(base, 'control'), trees = path.join(base, 'trees'); for (const d of [control, trees]) { fs.mkdirSync(d); ensureWindowsPrivateAcl(d) }
  const copied = sources.map((source, i) => { const to = path.join(control, ['native.cs', 'resources.cs', 'proof.cs'][i]); fs.copyFileSync(source, to, fs.constants.COPYFILE_EXCL); return to })
  const bindings = copied.map((file, i) => { const b = fs.readFileSync(file); assert.equal(sha(b), sha(fs.readFileSync(sources[i]))); return { source: path.relative(path.resolve(__dirname, '../..'), sources[i]).split(path.sep).join('/'), bytes: b.length, sha256: sha(b) } })
  const executable = path.join(control, 'identity-proof.exe'), system = process.env.SystemRoot
  const env = { SystemRoot: system, WINDIR: system, SystemDrive: system.slice(0, 2), PATH: path.join(system, 'System32'), TEMP: control, TMP: control }
  const build = '$ErrorActionPreference="Stop";$p=New-Object System.CodeDom.Compiler.CompilerParameters;$p.GenerateExecutable=$true;$p.GenerateInMemory=$false;$p.OutputAssembly=$env:AP_ID_OUTPUT;$p.CompilerOptions="/platform:anycpu";$p.MainClass="ResourceIdentityProof";$p.TreatWarningsAsErrors=$true;foreach($a in @("System.dll","System.Core.dll","System.Security.dll","System.Web.Extensions.dll")){[void]$p.ReferencedAssemblies.Add($a)};$options=[Collections.Generic.Dictionary[string,string]]::new();$options.Add("CompilerVersion","v4.0");$provider=[Microsoft.CSharp.CSharpCodeProvider]::new($options);try{$r=$provider.CompileAssemblyFromFile($p,[string[]]@($env:AP_ID_NATIVE,$env:AP_ID_RESOURCES,$env:AP_ID_FIXTURE));if($r.NativeCompilerReturnValue -ne 0 -or $r.Errors.HasErrors -or $r.Errors.HasWarnings){foreach($e in @($r.Errors|Select-Object -First 12)){[Console]::Error.WriteLine($e.ToString())};exit 1};if(![IO.File]::Exists($p.OutputAssembly)){throw "compiler output missing"}}finally{$provider.Dispose()}'
  const built = cp.spawnSync(shell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', build], { encoding: 'utf8', timeout: 120000, windowsHide: true, env: { ...env, AP_ID_NATIVE: copied[0], AP_ID_RESOURCES: copied[1], AP_ID_FIXTURE: copied[2], AP_ID_OUTPUT: executable } })
  assert.ifError(built.error); assert.equal(built.status, 0, built.stderr || built.stdout); assert.equal(built.stderr, '')
  t.diagnostic('WINDOWS_RESOURCE_IDENTITY_INPUTS:' + JSON.stringify({ sources: bindings, executable: { bytes: fs.statSync(executable).size, sha256: sha(fs.readFileSync(executable)) } }))
  const result = cp.spawnSync(executable, [trees], { encoding: 'utf8', timeout: 720000, maxBuffer: 128 * 1024, windowsHide: true, env, cwd: control, stdio: ['ignore', 'pipe', 'pipe'] })
  for (const stream of ['stdout', 'stderr']) fs.writeFileSync(path.join(control, stream + '.txt'), String(result[stream] || ''))
  let proof
  try { proof = JSON.parse(result.stdout); t.diagnostic('WINDOWS_RESOURCE_IDENTITY_PROOF:' + JSON.stringify(proof)) } catch { t.diagnostic('WINDOWS_RESOURCE_IDENTITY_PROTOCOL_FAILURE') }
  for (const line of String(result.stderr || '').slice(0, 4096).split(/\r?\n/)) if (line) t.diagnostic('stderr: ' + line)
  assert.ifError(result.error); assert.equal(result.signal, null)
  assert.ok(proof); assert.equal(proof.schema, 1); assert.equal(proof.scope, 'actual-source-resource-recovery-host-controls-no-worker-started'); assert.equal(proof.architecture, process.arch); assert.equal(proof.accepted, false)
  assert.deepEqual(proof.cases.map(c => c.case), names)
  for (const item of proof.cases) {
    assert.equal(item.passed, true, JSON.stringify(item)); assert.equal(item.cleanupConfirmed, true); assert.equal(item.planEntries, 4)
    assert.match(item.original.identity, /^[a-f0-9]{8}:[a-f0-9]{16}$/); assert.match(item.original.creation, /^[0-9]{1,19}$/); assert.match(item.planSha256, /^[a-f0-9]{64}$/)
    assert.equal(item.repeatedRestore, true); assert.equal(item.profileRemoved, true); assert.equal(item.outsideGuardUnchanged, true)
    if (!['deleted-replacement', 'no-change'].includes(item.case)) assert.equal(item.outsideIdentityMatched, true)
    if (item.case === 'no-change') assert.equal(item.noMutation, true)
    const deleted = ['deleted-replacement', 'delete-pending'].includes(item.case)
    assert.deepEqual(item.restore, { restored: deleted ? 3 : 4, newEntries: item.case === 'deleted-replacement' ? 1 : 0, deletedEntries: deleted ? 1 : 0 })
    if (item.case === 'creation-mismatch') assert.deepEqual(item.refusal, { code: 'WINDOWS_ACL_IDENTITY_MISMATCH', win32: null })
    if (item.case === 'sharing-denial') assert.deepEqual(item.refusal, { code: 'WINDOWS_ACL_IDENTITY_UNAVAILABLE', win32: 32 })
    const held = (value, pending, baseline) => {
      assert.equal(value.opened, true); assert.equal(value.identityRead, true); assert.equal(value.identityMatched, true)
      assert.equal(value.identity, item.original.identity); assert.equal(value.creation, item.original.creation)
      assert.equal(value.standardRead, true); assert.equal(value.directory, false); assert.equal(value.deletePending, pending)
      assert.equal(value.securityError, 0); assert.match(value.securitySha256, /^[a-f0-9]{64}$/)
      assert.equal(value.baselineSecurityMatched, baseline); assert.equal(value.packagePresent, !baseline)
    }
    const lookups = (value, expectedError) => {
      assert.equal(value.observationOnly, true); assert.equal(value.expectedIdentity, item.original.identity); assert.equal(value.expectedCreation, item.original.creation)
      for (const key of ['volumeOpened', 'volumeRead', 'volumeMatched', 'volumeClosed']) assert.equal(value[key], true)
      assert.equal(value.volumeCloseError, 0); assert.deepEqual(value.lookups.map(x => x.access), ['001e0081', '00100080'])
      assert.equal(value.lookups[0].error, expectedError)
      for (const lookup of value.lookups) {
        assert.ok([0, 5].includes(lookup.error)); assert.equal(lookup.opened, lookup.error === 0)
        if (expectedError === 0) assert.equal(lookup.error, 0)
        if (lookup.opened) {
          assert.equal(lookup.closed, true); assert.equal(lookup.closeError, 0)
          const h = lookup.handle; assert.equal(h.identityRead, true); assert.equal(h.identityMatched, true)
          assert.equal(h.identity, item.original.identity); assert.equal(h.creation, item.original.creation)
          assert.equal(h.standardRead, true); assert.equal(h.deletePending, true); assert.equal(h.directory, false)
          if (lookup.access === '001e0081') assert.equal(h.securityError, 0)
        }
      }
    }
    if (item.case === 'delete-pending') {
      assert.equal(item.deletePendingObserved, true); assert.equal(item.refusal, undefined)
      assert.deepEqual(item.heldRestore, { restored: 4, newEntries: 0, deletedEntries: 0 }); assert.equal(item.heldRepeatedRestore, true)
      held(item.modernPendingHeldBefore, true, false)
      for (const field of ['modernPendingHeldAfter', 'modernPendingHeldRepeated']) held(item[field], true, true)
      for (const field of ['modernPendingHeldBefore', 'modernPendingHeldAfter', 'modernPendingHeldRepeated']) assert.equal(item[field].links, 0)
      lookups(item.pendingBeforeRestore, 0); lookups(item.pendingAfterRestore, 0)
      held(item.pendingBeforeRestore.held, true, false); held(item.pendingAfterRestore.held, true, true)
      assert.deepEqual(item.modernObserverClose, { closed: true, error: 0 })
    }
    if (item.case === 'classic-delete-pending') {
      assert.ok(['restored', 'refused'].includes(item.classicWhilePendingOutcome)); const restored = item.classicWhilePendingOutcome === 'restored'
      lookups(item.classicPendingBeforeRestore, restored ? 0 : 5); lookups(item.classicPendingAfterRestore, restored ? 0 : 5)
      held(item.classicPendingBeforeRestore.held, true, false); held(item.classicPendingAfterRestore.held, true, restored)
      if (restored) { assert.equal(item.refusal, undefined); assert.deepEqual(item.classicHeldRestore, { restored: 4, newEntries: 0, deletedEntries: 0 }); assert.equal(item.classicHeldRepeatedRestore, true) }
      else assert.deepEqual(item.refusal, { code: 'WINDOWS_ACL_IDENTITY_UNAVAILABLE', win32: 5 })
      assert.equal(item.classicResetRecoveredOriginal, true); assert.deepEqual(item.classicResetNameIdentity, item.original)
      for (const field of ['classicObserverBefore', 'classicDisposerBefore']) held(item[field], false, false)
      held(item.classicPendingHeld, true, false); held(item.classicAfterRestoreHeld, true, restored)
      held(item.classicResetHeld, false, restored); held(item.classicRecoveredHeld, false, true)
      assert.equal(item.classicAfterRestoreHeld.securitySha256, item.classicResetHeld.securitySha256)
      if (!restored) assert.equal(item.classicObserverBefore.securitySha256, item.classicAfterRestoreHeld.securitySha256)
      for (const [field, deleted] of [['classicMark', true], ['classicReset', false]]) assert.deepEqual(item[field], { informationClass: 4, bytes: 1, delete: deleted, success: true, error: 0 })
      for (const field of ['classicObserverClose', 'classicDisposerClose']) assert.deepEqual(item[field], { closed: true, error: 0 })
    }
    if (item.refusal) assert.equal(item.refusalRetainedProfileAndPlan, true)
    if (item.case === 'deleted-replacement') { assert.match(item.replacement.identity, /^[a-f0-9]{8}:[a-f0-9]{16}$/); assert.notEqual(item.replacement.identity, item.original.identity) }
  }
  assert.equal(result.status, 0); assert.equal(result.stderr, ''); assert.equal(proof.cleanupConfirmed, true)
  cleanupConfirmed = true
})
