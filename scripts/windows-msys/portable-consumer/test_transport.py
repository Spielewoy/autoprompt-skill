from pathlib import Path
import copy,io,json,os,shutil,stat,subprocess,tempfile,unittest,zipfile
import transport as t
ROOT=Path(__file__).parent
REPO=ROOT.parents[2]

class Contracts(unittest.TestCase):
 def fixture(self):
  e=json.loads((ROOT/'node-arm64-ci20.json').read_text())['expectation']
  value=json.loads((ROOT/'fixtures/ci20-metadata.json').read_text())
  return e,value['run'],value['jobs'],value['artifact']
 def test_real_ci20_metadata(self):
  e,r,j,a=self.fixture();self.assertEqual(t.metadata(e,r,j,a)['id'],105236809824)
 def test_mutated_metadata(self):
  changes=[('runId',0),('runAttempt',2),('repositoryId',1),('headSha','b'*40),('jobId',1),('artifactId',1),('artifactName','latest'),('archiveSha256','0'*64)]
  for key,value in changes:
   with self.subTest(field=key):
    e,r,j,a=self.fixture();e[key]=value
    with self.assertRaises(ValueError):t.metadata(e,r,j,a)
  for target,key,value in [('run','path','other.yml'),('run','event','pull_request'),('run','head_branch','main'),('run','status','queued'),('artifact','expired',True),('artifact','created_at','2020-01-01T00:00:00Z'),('artifact','size_in_bytes',t.MAX_ZIP+1),('artifact','digest','sha256:'+'0'*64)]:
   with self.subTest(target=target,field=key):
    e,r,j,a=self.fixture();(r if target=='run' else a)[key]=value
    with self.assertRaises(ValueError):t.metadata(e,r,j,a)
 def test_producer_step_not_full_job_conclusion(self):
  e,r,j,a=self.fixture();job=next(x for x in j['jobs'] if x['id']==e['jobId']);self.assertEqual(job['conclusion'],'failure')
  t.metadata(e,r,j,a) # Actual independent component success despite later platform failure.
  step=next(x for x in job['steps'] if x['name']=='Require exact subprocess roundtrips with the built Node worker')
  for value in ['failure','skipped',None]:
   step['conclusion']=value
   with self.assertRaises(ValueError):t.metadata(e,r,j,a)
 def test_synthetic_same_run_msys_identity_and_attempt_join(self):
  e,r,j,a=self.fixture();e.update(kind='msys',jobId=105236810067,artifactId=123,artifactName=f"windows-msys-candidate-{e['headSha']}-1")
  job=next(x for x in j['jobs'] if x['id']==e['jobId'])
  for name in ['Export the exact compiled MSYS candidate for native reuse','Publish immutable MSYS candidate bytes and producer authority']:
   job['steps'].append({'name':name,'status':'completed','conclusion':'success'})
  a.update(id=123,name=e['artifactName'],created_at=job['started_at'])
  current={k:e[k] for k in ['repository','runId','runAttempt','headSha']}
  self.assertEqual(t.metadata(e,r,j,a,current)['id'],e['jobId'])
  for key in current:
   bad=copy.deepcopy(current);bad[key]='wrong'
   with self.assertRaises(ValueError):t.metadata(e,r,j,a,bad)
 def test_authenticated_outer_context_join_and_windows_line_endings(self):
  repo=REPO;node=os.environ.get('NODE_BINARY') or shutil.which('node');node=str(Path(node).resolve())
  e,_,_,_=self.fixture();e.update(kind='msys',jobId=105236810067,artifactId=123,artifactName=f"windows-msys-candidate-{e['headSha']}-1")
  producer={'schema':1,'producer':{'repository':e['repository'],'headSha':e['headSha'],'runId':str(e['runId']),'runAttempt':1,'jobId':str(e['jobId']),'architecture':'x64'},'observedTools':{'linkerSha256':'a'*64,'bootstrapRuntimeSha256':'b'*64}}
  js="const fs=require('fs'),c=require(process.argv[1]+'/scripts/windows-msys/portable-runtime/cli.cjs'),p=require(process.argv[1]+'/scripts/windows-msys/portable-runtime/portable.cjs');process.stdout.write(p.canonical(c.exportAuthority(process.argv[1],JSON.parse(fs.readFileSync(0)))))"
  expected=json.loads(subprocess.check_output([node,'-e',js,str(repo)],input=t.canonical(producer)))
  manifest=t.canonical({'schema':1,'kind':'msys-candidate-transport','status':'not-native-accepted','authority':expected,'architecture':{'bash':'x64','msys':'x64','posixFixture':'x64'},'files':[]})
  result={'root':'D:\\producer-local-unused','manifestSha256':t.digest(manifest),'status':'candidate-exported-not-accepted','expected':expected,'toolIdentityAuthority':'trusted-builder-observation-not-independent-sdk-attestation','nativeAcceptance':'not-performed'}
  files={'producer-context.json':t.canonical(producer),'producer-result.json':t.canonical(result),'packet/manifest.json':manifest}
  previous=os.environ.get('NODE_BINARY');os.environ['NODE_BINARY']=node
  try:
   for newline in [b'\n',b'\r\n']:
    files['producer-result.json']=t.canonical(result).replace(b'\n',newline)
    context=t.msys_context(files,e,'/tmp/authenticated.zip',repo,{'path':node,'sha256':t.digest(Path(node).read_bytes())})
    self.assertEqual(context['expected'],expected);self.assertEqual(context['transport']['manifestSha256'],t.digest(manifest))
   for mutation in ['job','acceptance','extra','digest','source']:
    changed=copy.deepcopy(files)
    if mutation=='extra':changed['unexpected']=b'no'
    else:
     value=copy.deepcopy(result)
     if mutation=='job':value['expected']['producer']['jobId']='9'
     if mutation=='acceptance':value['nativeAcceptance']='passed'
     if mutation=='digest':value['manifestSha256']='0'*64
     if mutation=='source':value['expected']['bindings']['patchSha256']='0'*64
     changed['producer-result.json']=t.canonical(value)
    with self.assertRaises(ValueError):t.msys_context(changed,e,'/tmp/authenticated.zip',repo,{'path':node,'sha256':t.digest(Path(node).read_bytes())})
  finally:
   if previous is None:os.environ.pop('NODE_BINARY')
   else:os.environ['NODE_BINARY']=previous
 def test_same_run_required_for_msys(self):
  e,r,j,a=self.fixture();e.update(kind='msys',artifactName=f"windows-msys-candidate-{e['headSha']}-1")
  with self.assertRaisesRegex(ValueError,'current consumer run'):t.metadata(e,r,j,a,None)
 def test_rejects_changed_job_attempt_and_incomplete_inventory(self):
  for which in ['attempt','count','duplicate','foreign']:
   e,r,j,a=self.fixture();job=next(x for x in j['jobs'] if x['id']==e['jobId'])
   if which=='attempt':job['run_attempt']=2
   if which=='count':j['total_count']+=1
   if which=='duplicate':j['jobs'].append(job);j['total_count']+=1
   if which=='foreign':r['head_repository']['id']=1
   with self.assertRaises(ValueError):t.metadata(e,r,j,a)
 def zipped(self,names,mode=None,comment=b''):
  out=io.BytesIO()
  with zipfile.ZipFile(out,'w',compression=zipfile.ZIP_DEFLATED) as z:
   z.comment=comment
   for name in names:
    item=zipfile.ZipInfo(name);item.external_attr=(mode if mode is not None else stat.S_IFREG|0o600)<<16;z.writestr(item,b'nonexecutable-fixture')
  return out.getvalue()
 def test_zip_positive_and_hash_authority(self):
  b=self.zipped(['packet/runtime/bash.exe','producer-result.json']);self.assertEqual(len(t.archive_files(b,t.digest(b))),2)
  with self.assertRaises(ValueError):t.archive_files(b,'0'*64)
  with self.assertRaises(ValueError):t.archive_files(b,t.digest(b),len(b)+1)
 def test_zip_empty_diagnostic_file_is_allowed(self):
  out=io.BytesIO()
  with zipfile.ZipFile(out,'w') as z:z.writestr('logs/empty.stderr.txt',b'')
  b=out.getvalue();self.assertEqual(t.archive_files(b,t.digest(b)),{'logs/empty.stderr.txt':b''})
 def test_zip_paths(self):
  for name in ['../escape','/absolute','C:/ads','packet/a:b','packet\\escape','packet/./file','packet//file','packet/NUL.exe','packet/con','packet/x.','packet/name ','packet/../../escape','packet/é','packet/.hidden']:
   with self.subTest(name=name):
    b=self.zipped([name])
    with self.assertRaises(ValueError):t.archive_files(b,t.digest(b))
 def test_zip_alias_and_nonregular(self):
  for names in [['packet/A','packet/a'],['a','a/b'],['a','a']]:
   b=self.zipped(names)
   with self.assertRaises(ValueError):t.archive_files(b,t.digest(b))
  for mode in [stat.S_IFLNK|0o777,stat.S_IFIFO|0o600,stat.S_IFDIR|0o700]:
   b=self.zipped(['a'],mode)
   with self.assertRaises(ValueError):t.archive_files(b,t.digest(b))
  b=self.zipped(['a'],comment=b'comment')
  with self.assertRaises(ValueError):t.archive_files(b,t.digest(b))
 def test_canonical_duplicate_keys_and_ambiguous_whitespace(self):
  for b in [b'{"a":1,"a":2}\n',b'{ "a":1}\n',b'{"a":1}']:
   with self.assertRaises(ValueError):t.parse_canonical(b)
 def test_external_node_component_hashes_with_nonexecutable_fixtures(self):
  files={'stage/node.exe':b'synthetic-not-executable','stage/built-runtime-proof.txt':b'synthetic-not-native-proof','stage/provenance.json':b'{}','stage/LICENSE':b'fixture'}
  pin={'architecture':'arm64','expectation':{'kind':'node-arm64'},'files':list(files),'nodeSha256':t.digest(files['stage/node.exe']),'nodeBytes':len(files['stage/node.exe']),'proofSha256':t.digest(files['stage/built-runtime-proof.txt']),'scope':'synthetic'}
  files['stage/provenance.json']=t.canonical({'identity':{'arch':'arm64'},'architecture':'arm64','nodeSha256':pin['nodeSha256']})
  pin['provenanceSha256']=t.digest(files['stage/provenance.json'])
  self.assertEqual(len(t.node_component(files,pin)),4)
  files['stage/node.exe']+=b'changed'
  with self.assertRaises(ValueError):t.node_component(files,pin)

 def test_ci20_node_pins_are_architecture_specific(self):
  for architecture in ['arm64','x64']:
   pin=json.loads((ROOT/f'node-{architecture}-ci20.json').read_text());self.assertEqual(pin['architecture'],architecture)
   self.assertEqual(pin['expectation']['kind'],'node-'+architecture);t.expectation(pin['expectation'])
   self.assertEqual(pin['expectation']['runId'],35231596403);self.assertEqual(pin['expectation']['headSha'],'f8e68b143d9c15f97a79a85165de08c6982f0da2')
  arm=json.loads((ROOT/'node-arm64-ci20.json').read_text());x64=json.loads((ROOT/'node-x64-ci20.json').read_text())
  self.assertNotEqual(arm['expectation']['artifactId'],x64['expectation']['artifactId']);self.assertNotEqual(arm['nodeSha256'],x64['nodeSha256'])

 def test_closed_native_environment_strips_node_injection(self):
  v=t.native_environment({'SystemRoot':'C:\\Windows','NODE_OPTIONS':'hostile','Node_Path':'hostile','PATH':'untrusted','GITHUB_TOKEN':'secret'},'D:\\owned')
  self.assertEqual(v,{'SystemRoot':'C:\\Windows','WINDIR':'C:\\Windows','SystemDrive':'C:','PATH':'C:\\Windows\\System32','TEMP':'D:\\owned','TMP':'D:\\owned'})
 def test_physical_inspection_rejects_link_and_hardlink(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);source=root/'source';source.write_bytes(b'x');t.physical(source)
   link=root/'link';link.symlink_to(source)
   with self.assertRaises(ValueError):t.physical(link)
   link.unlink();os.link(source,link)
   with self.assertRaises(ValueError):t.physical(source)
 def test_same_run_poller_ready_and_failure(self):
  e,r,j,a=self.fixture();e.update(kind='msys',jobId=105236810067,artifactId=123,artifactName=f"windows-msys-candidate-{e['headSha']}-1")
  job=next(x for x in j['jobs'] if x['id']==e['jobId'])
  for name in ['Export the exact compiled MSYS candidate for native reuse','Publish immutable MSYS candidate bytes and producer authority']:job['steps'].append({'name':name,'status':'completed','conclusion':'success'})
  a.update(id=123,name=e['artifactName'],created_at=job['started_at']);current={k:e[k] for k in ['repository','runId','runAttempt','headSha']}
  def read(route,token):
   return {'total_count':1,'artifacts':[a]} if '/artifacts?' in route else j if '/jobs?' in route else r
  self.assertEqual(t.resolve_same_run(current,e['repositoryId'],'unused',read_api=read),e)
  job['steps'][-1]['conclusion']='failure'
  with self.assertRaises(ValueError):t.resolve_same_run(current,e['repositoryId'],'unused',read_api=read)
 def test_same_run_poller_deadline_no_latest_fallback(self):
  e,r,j,a=self.fixture();job=next(x for x in j['jobs'] if x['id']==105236810067);r['status']='in_progress';job['status']='in_progress'
  current={k:e[k] for k in ['repository','runId','runAttempt','headSha']};tick=[0]
  def read(route,token):return {'total_count':0,'artifacts':[]} if '/artifacts?' in route else j if '/jobs?' in route else r
  def sleep(seconds):tick[0]+=seconds
  with self.assertRaisesRegex(ValueError,'deadline'):t.resolve_same_run(current,e['repositoryId'],'unused',deadline_seconds=31,read_api=read,sleep=sleep,now=lambda:tick[0])
  self.assertEqual(tick[0],31)
 def test_output_fresh_and_traversal(self):
  with tempfile.TemporaryDirectory() as tmp:
   output=Path(tmp)/'candidate';t.write_selected(output,{'packet/a':b'value'});self.assertEqual((output/'packet/a').read_bytes(),b'value')
   with self.assertRaises(ValueError):t.write_selected(output,{'packet/a':b'value'})
   with self.assertRaises(ValueError):t.write_selected(Path(tmp)/'other',{'../escape':b'value'})
if __name__=='__main__':unittest.main()
