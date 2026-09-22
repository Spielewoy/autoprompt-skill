from pathlib import Path
import ast,copy,json,os,sys,tempfile,unittest,urllib.error
import run as r
import transport as t
class OrchestrationContracts(unittest.TestCase):
 def test_failure_diagnostics_are_fixed_stages_and_code_owned_reasons(self):
  for source in [r.ROOT/'transport.py',r.ROOT/'run.py']:
   tree=ast.parse(source.read_text())
   for call in [x for x in ast.walk(tree) if isinstance(x,ast.Call)]:
    name=call.func.attr if isinstance(call.func,ast.Attribute) else call.func.id if isinstance(call.func,ast.Name) else ''
    if name=='require':self.assertIsInstance(call.args[1],ast.Constant);self.assertIsInstance(call.args[1].value,str);self.assertLessEqual(len(call.args[1].value),160)
    if name=='set_stage':self.assertIsInstance(call.args[0],ast.Constant);self.assertIn(call.args[0].value,r.STAGES)
  r.set_stage('msys-authority-join')
  try:t.require(False,'manifest authority join')
  except t.TransportError as error:report=r.failure_report(error,'.')
  self.assertEqual(report['stage'],'msys-authority-join');self.assertEqual(report['reason'],'manifest authority join');self.assertFalse(report['cleanupConfirmed'])
  for error in [ValueError('secret-token-or-url'),urllib.error.URLError('https://storage/?signed=secret'),KeyError('malicious packet text')]:
   report=r.failure_report(error,'.');self.assertEqual(report['reason'],'external operation failed; exception details withheld');self.assertNotIn('secret',json.dumps(report));self.assertFalse(report['cleanupConfirmed'])
  with self.assertRaises(t.TransportError):r.set_stage('https://untrusted/?secret')
 def test_native_writer_failure_is_joined_without_external_exception_text(self):
  record={'status':'native-candidate-writer-refused','stage':'private-acl','code':'PRIVACY_UNSUPPORTED','helperPhase':'compiling','exitStatus':1}
  encoded=lambda value:(json.dumps(value,separators=(',',':'))+'\n').encode()
  self.assertEqual(t.writer_failure(b'',encoded(record)),record)
  r.set_stage('private-output');report=r.failure_report(t.NativeWriterError(record),'.')
  self.assertEqual(report['stage'],'private-output');self.assertEqual(report['nativeWriter'],record);self.assertEqual(report['reason'],'native writer failed; output retained');self.assertFalse(report['cleanupConfirmed'])
  for key,value in [('status','accepted'),('stage','secret-url'),('code','secret-token'),('helperPhase','secret'),('exitStatus',True),('exitStatus',4294967296),('extra','secret')]:
   with self.subTest(key=key,value=value):
    with self.assertRaises(ValueError):t.writer_failure(b'',encoded({**record,key:value}))
  for stdout,stderr in [(b'unexpected',encoded(record)),(b'',b'secret-token'),(b'',b'{}'*1024),(b'',encoded(record)+b'\n'),(b'',encoded(record).replace(b'"status":',b'"status":"duplicate","status":'))]:
   with self.assertRaises(ValueError):t.writer_failure(stdout,stderr)
 def test_current_workflow_requires_exact_native_windows_role(self):
  e={'GITHUB_ACTIONS':'true','RUNNER_OS':'Windows','RUNNER_ARCH':'ARM64','GITHUB_JOB':'platform-primitives','GITHUB_REF':'refs/heads/'+t.BRANCH,'GITHUB_EVENT_NAME':'push','GITHUB_REPOSITORY':'Spielewoy/autoprompt-skill','GITHUB_RUN_ID':'123','GITHUB_RUN_ATTEMPT':'1','GITHUB_REPOSITORY_ID':'456','GITHUB_SHA':'a'*40}
  current,repoid,arch=r.current_environment(e);self.assertEqual(current['runId'],123);self.assertEqual(repoid,456);self.assertEqual(arch,'arm64')
  self.assertEqual(r.current_environment({**e,'RUNNER_ARCH':'X64'})[2],'x64')
  for key,value in [('RUNNER_ARCH','X86'),('GITHUB_REF','refs/heads/main'),('GITHUB_JOB','other'),('GITHUB_EVENT_NAME','pull_request'),('GITHUB_RUN_ID','123/../'),('GITHUB_REPOSITORY','other/repo'),('GITHUB_SHA','latest')]:
   with self.subTest(key=key):
    with self.assertRaises(ValueError):r.current_environment({**e,key:value})
 def test_actual_windows_guard_precedes_writes(self):
  if os.name=='nt':self.skipTest('negative host guard is non-Windows only')
  with self.assertRaisesRegex(ValueError,'actual Windows'):r.main(None)
 def test_local_helper_requires_exact_reviewed_source_and_file_hashes(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);repo=root/'repo';build=root/'build';build.mkdir();base=repo/'scripts/windows-runtime/precompiled-proof';base.mkdir(parents=True);(base.parent/'physical-proof').mkdir()
   sources=[]
   for name in ['../physical-proof/audit.cs','lease-main.cs','build.ps1']:
    data=('synthetic source '+name).encode();(base/name).write_bytes(data);sources.append({'path':name,'sha256':t.digest(data)})
   files=[]
   for name in ['bundle-lease.exe','bundle-lease.exe.config']:
    data=('synthetic nonexecutable '+name).encode();(build/name).write_bytes(data);files.append({'path':name,'length':len(data),'sha256':t.digest(data)})
   record={'schema':1,'status':'compiled-native-identity-only','identity':'bundle-lease-helper-v1:arm64','source':sources,'files':files};(build/'build.json').write_bytes(t.canonical(record))
   value=r.helper_authority(repo,build,'C:\\Windows','arm64');self.assertEqual(value['executableSha256'],files[0]['sha256'])
   for change in ['source','exe','arch','extra']:
    modified=copy.deepcopy(record)
    if change=='source':modified['source'][0]['sha256']='0'*64
    if change=='exe':modified['files'][0]['sha256']='0'*64
    if change=='arch':modified['identity']='bundle-lease-helper-v1:x64'
    if change=='extra':modified['accepted']=True
    (build/'build.json').write_bytes(t.canonical(modified))
    with self.assertRaises(ValueError):r.helper_authority(repo,build,'C:\\Windows','arm64')
 def test_ci49_replay_pin_is_one_exact_nonaccepting_source_run(self):
  value=json.loads((r.ROOT/'msys-candidate-ci49.json').read_text());t.exact(value,['expectation','manifestSha256','scope']);t.expectation(value['expectation'])
  self.assertEqual(value['expectation']['runId'],35673425247);self.assertEqual(value['expectation']['headSha'],'7275b8e9a4e762ca854e3fa2119f621225e1cb82')
  self.assertEqual(value['expectation']['archiveSha256'],'80181618ea3f154dd5a22e0e09dd67839e63d94e34cddc13b63ab3598e6feb76')
  self.assertIn('never inferred',value['scope'])
 def test_bounded_child_output_and_failure_never_mean_cleanup(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp)
   for stream in ['stdout','stderr']:(root/('child.'+stream+'.txt')).write_bytes(b'')
   out,err=r.run_process([sys.executable,'-c','print("diagnostic")'],root,'child',dict(os.environ),10);self.assertEqual(out,b'diagnostic\n');self.assertEqual(err,b'')
   with self.assertRaisesRegex(ValueError,'stage failed'):r.run_process([sys.executable,'-c','raise SystemExit(1)'],root,'child',dict(os.environ),10)
   self.assertTrue(root.exists())
if __name__=='__main__':unittest.main()
