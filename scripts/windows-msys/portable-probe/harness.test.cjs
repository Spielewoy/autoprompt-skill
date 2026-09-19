'use strict'
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const repo=path.resolve(__dirname,'../../..'),p=require(path.join(repo,'scripts/windows-msys/portable-runtime/portable.cjs'))
const h=require('./harness.cjs'),{setup}=require('./test-fixture.cjs')
async function packet(t){
 const x=setup(t)
 const exported=await p.exportCandidate({buildRoot:x.build,expected:x.expected,destination:x.packet})
 await p.importCandidate({packetRoot:x.packet,expected:x.expected,manifestSha256:exported.manifestSha256,destination:x.dest})
 // Parser fixture only: never passed to native capture or used to issue a capability.
 const receipt=JSON.parse(fs.readFileSync(path.join(x.dest,'import.json')))
 receipt.consumer={platform:'win32',processArchitecture:'arm64'}
 fs.writeFileSync(path.join(x.dest,'import.json'),p.canonical(receipt))
 const files=[...Object.keys(p.MAP),'manifest.json','import.json'].map(name=>({path:name,bytes:fs.readFileSync(path.join(x.dest,name))}))
 const expected={authority:x.expected,manifestSha256:exported.manifestSha256,receiptSha256:p.hash(p.canonical(receipt))}
 return{...x,files,expected}
}
test('imported parser binds exact original manifest plus separately authorized local receipt',async t=>{
 const x=await packet(t),value=h.validateImported(repo,x.files,x.expected)
 assert.equal(value.receipt.status,'not-native-accepted');assert.equal(value.receipt.nativeAcceptance,'not-performed')
 assert.equal(value.data.size,19)
 x.files[0].bytes.fill(0)
 assert.notDeepEqual(value.data.get(x.files[0].path),x.files[0].bytes)
})
for(const [name,change]of[
 ['wrong receipt hash',x=>x.expected.receiptSha256='0'.repeat(64)],
 ['wrong manifest hash',x=>x.expected.manifestSha256='0'.repeat(64)],
 ['missing receipt',x=>x.files.pop()],['extra file',x=>x.files.push({path:'extra',bytes:Buffer.from('x')})],
 ['duplicate file',x=>x.files.push(x.files[0])],['binary byte changed',x=>x.files[0].bytes[0]^=1],
 ['producer changed',x=>x.expected.authority.producer.jobId='457'],
])test('import parser refuses '+name,async t=>{const x=await packet(t);change(x);assert.throws(()=>h.validateImported(repo,x.files,x.expected))})
for(const [name,change]of[
 ['acceptance claim',r=>r.nativeAcceptance='passed'],['wrong platform',r=>r.consumer.platform='linux'],
 ['different producer',r=>r.producer.runId='124'],['extra pass flag',r=>r.accepted=true],
])test('even externally rehashed malformed import receipt refuses '+name,async t=>{
 const x=await packet(t),file=x.files.find(f=>f.path==='import.json'),receipt=JSON.parse(file.bytes)
 change(receipt);file.bytes=p.canonical(receipt);x.expected.receiptSha256=p.hash(file.bytes)
 assert.throws(()=>h.validateImported(repo,x.files,x.expected))
})
test('plain objects never authorize materialization, native smoke, or downstream tests',()=>{
 const fake=Object.freeze({status:'captured-candidate-not-accepted'})
 assert.throws(()=>h.tupleIdentity(fake),/Authentic captured/)
 assert.throws(()=>h.materialize(fake,'unused'),/Authentic captured/)
 assert.throws(()=>h.runSmoke(fake,'unused'),/Authentic captured/)
 assert.throws(()=>h.inputsAfterSmoke(fake,{status:'passed'}),/Authentic captured/)
})
test('non-Windows cannot issue native capture capabilities',async()=>{
 if(process.platform==='win32')return
 await assert.rejects(h.captureImported({}),/native Windows capture cannot be simulated/)
})
test('selected smoke environment removes duplicate-cased Node preload paths and ambient Bash',()=>{
 const env={NODE_OPTIONS:'--require untrusted',Node_Options:'--import other',NODE_PATH:'untrusted',Node_Path:'other',
  AUTOPROMPT_WINDOWS_BASH:'ambient',Autoprompt_Windows_Bash:'other',NODE_TEST_CONTEXT:'inherited',SystemRoot:'C:\\Windows'}
 const controlled=h.smokeEnvironment(env,'C:\\private\\bash.exe')
 assert.deepEqual(controlled,{SystemRoot:'C:\\Windows',AUTOPROMPT_WINDOWS_BASH:'C:\\private\\bash.exe'})
 assert.equal(env.NODE_OPTIONS,'--require untrusted')
})
test('portable POSIX factoring preserves the original execution, cancellation and positive drain body',()=>{
 const original=fs.readFileSync(path.join(repo,'scripts/windows-msys/probe-posix-runtime.cjs'),'utf8')
 let expected=original.slice(original.indexOf('  const dependencies = importedDlls(fixture)'),original.indexOf("  assert.deepEqual(closureRecords(bindBashRuntime(path.join(work, 'sdk/usr/bin')"))
 expected=expected.replace("  const root = path.join(payload, 'posix-proof-' + crypto.randomUUID())","  const root = path.resolve(outputArgument)\n  assert.equal(fs.existsSync(root), false, 'Fresh portable POSIX output required')\n  assert.equal(fs.realpathSync.native(path.dirname(root)), path.dirname(root))")
 expected=expected.replaceAll('smoke.copied','runtimeRecords').replace("note({ status: 'bound', root, sourceSha256","note({ status: 'bound', tuple, accepted: false, root, sourceSha256")
 expected=expected.replace("  const note = record => { const line = JSON.stringify(record) + '\\n'; fs.appendFileSync(logPath, line); process.stdout.write(line) }", "  const note = require('./progress.cjs').createBoundedJsonl(logPath)")
 const actual=fs.readFileSync(path.join(__dirname,'posix.cjs'),'utf8')
 assert.equal(actual.includes(expected),true)
 assert.equal(actual.includes('built-runtime-proof.txt'),false);assert.equal(actual.includes('sdk/usr/bin'),false)
 assert.deepEqual(require('./posix.cjs').MODES,['pipe-fork','fifo','locks','blocked-fifo','null','af-local'])
})
