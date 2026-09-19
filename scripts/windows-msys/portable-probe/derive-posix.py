from pathlib import Path
import hashlib,json
repo=Path(__file__).resolve().parents[3]
out=Path(__file__).parent
source=(repo/'scripts/windows-msys/probe-posix-runtime.cjs').read_text()
head=source[:source.index('async function main(')]
body_start=source.index('  const dependencies = importedDlls(fixture)')
body_end=source.index("  assert.deepEqual(closureRecords(bindBashRuntime(path.join(work, 'sdk/usr/bin')")
body=source[body_start:body_end]
body=body.replace("  const root = path.join(payload, 'posix-proof-' + crypto.randomUUID())", "  const root = path.resolve(outputArgument)\n  assert.equal(fs.existsSync(root), false, 'Fresh portable POSIX output required')\n  assert.equal(fs.realpathSync.native(path.dirname(root)), path.dirname(root))")
body=body.replace('smoke.copied','runtimeRecords')
body=body.replace("  const note = record => { const line = JSON.stringify(record) + '\\n'; fs.appendFileSync(logPath, line); process.stdout.write(line) }", "  const note = require('./progress.cjs').createBoundedJsonl(logPath)")
body=body.replace("note({ status: 'bound', root, sourceSha256", "note({ status: 'bound', tuple, accepted: false, root, sourceSha256")
preamble='''async function runPosix(capability, smokeCapability, outputArgument) {
  assert.equal(process.platform, 'win32', 'Native Windows required')
  const { repo, tuple, original, fixture, fixtureSource } = require('./harness.cjs').inputsAfterSmoke(capability, smokeCapability)
  assert.equal(tuple.nativeArchitecture, process.arch)
  const api = name => require(path.join(repo, 'agents/codex/workflow', name))
  const { readBounded, closureRecords } = require(path.join(repo, 'scripts/windows-msys/probe-built-runtime.cjs'))
  const { bindBashRuntime, importedDlls } = api('windows-appcontainer-command.js')
  const { ensureWindowsPrivateAcl } = api('safe-run-root.js')
  const { createWindowsAppContainerLauncher } = api('windows-appcontainer.js')
  const { stageWindowsHelperDeployment } = api('windows-helper-deployment.js')
  const { prepareWindowsAppContainerResources, recoverWindowsAppContainerResources } = api('windows-appcontainer-resources.js')
  assert.equal(sha(fixtureSource), SOURCE_SHA)
  const fixtureSha = sha(fixture)
  assert.equal(fixtureSha, tuple.fixtureSha256)
  const runtimeRecords = closureRecords(original)
'''
tail='''  assert.deepEqual(closureRecords(bindBashRuntime(runtime, process.env.SystemRoot)), runtimeRecords)
  assert.equal(sha(readBounded(path.join(runtime, 'posix-proof.exe'))), fixtureSha)
  const receipt = { status: 'consumer-native-posix-passed-not-accepted', modes: MODES, tuple,
    mqueue: 'not-run: isolated /dev/mqueue backing required', root, accepted: false }
  note(receipt)
  return Object.freeze(receipt)
}
module.exports = { runPosix, readyRecord, fixtureDigest, MODES, SOURCE_SHA, BASH_WRAPPER }
'''
result=head+preamble+body+tail
(out/'posix.cjs').write_text(result)
(out/'posix-lineage.json').write_text(json.dumps({'kind':'portable-source-factoring-not-native-proof','sourcePath':'scripts/windows-msys/probe-posix-runtime.cjs','sourceSha256':hashlib.sha256(source.encode()).hexdigest(),'derivedSha256':hashlib.sha256(result.encode()).hexdigest(),'preservedExecutionStart':'const dependencies = importedDlls(fixture)','preservedNativeModes':['pipe-fork','fifo','locks','blocked-fifo','null','af-local'],'bindingChanges':['opaque imported candidate and same-tuple fresh native smoke capability','fresh output root independent from SDK','captured source/runtime/fixture bytes instead of SDK paths','consumer-only tuple receipt; no copied producer smoke pass'],'nativeExecution':'not-performed'},indent=2)+'\n')
