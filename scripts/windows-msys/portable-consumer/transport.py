"""Authenticated diagnostic transport; never grants runtime acceptance."""
from pathlib import Path, PurePosixPath
from datetime import datetime
import hashlib, io, json, os, re, stat, time, urllib.request, urllib.error, urllib.parse, zipfile
MAX_ZIP=64*1024*1024
MAX_TOTAL=256*1024*1024
MAX_FILE=128*1024*1024
BRANCH='codex/issue-27-native-platform-support'

class TransportError(ValueError):
    """Only fixed code-owned validation messages; never external exception text."""

def require(value, message):
    if not value: raise TransportError(message)

def failure_reason(error):
    # Tests enforce literal messages at every require/TransportError call site.
    if type(error) is TransportError and len(error.args)==1 and isinstance(error.args[0],str) and len(error.args[0])<=160:
        return error.args[0]
    return 'external operation failed; exception details withheld'

def digest(data):return hashlib.sha256(data).hexdigest()
def canonical(obj):return (json.dumps(obj,sort_keys=True,separators=(',',':'),ensure_ascii=False)+'\n').encode()
def exact(obj,keys):require(isinstance(obj,dict) and set(obj)==set(keys),'unexpected fields')
def integer(x):return isinstance(x,int) and not isinstance(x,bool) and 0<x<2**53

def expectation(e):
    exact(e,['kind','repository','repositoryId','runId','runAttempt','headSha','jobId','artifactId','artifactName','archiveSha256'])
    require(e['kind'] in ['msys','node-arm64'],'candidate kind')
    require(re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+',e['repository']) is not None,'repository')
    require(all(x not in ['.','..'] for x in e['repository'].split('/')),'repository traversal')
    for k in ['repositoryId','runId','runAttempt','jobId','artifactId']:require(integer(e[k]),'numeric ID')
    require(re.fullmatch('[a-f0-9]{40}',e['headSha']) is not None,'head')
    require(re.fullmatch('[a-f0-9]{64}',e['archiveSha256']) is not None,'external archive SHA256')
    name=f"windows-msys-candidate-{e['headSha']}-{e['runAttempt']}" if e['kind']=='msys' else 'windows-node-compiler-proof-arm64'
    require(e['artifactName']==name,'exact artifact name')
    return e

def metadata(e,run,jobs,artifact,current=None):
    expectation(e)
    if e['kind']=='msys':
        require(current=={'repository':e['repository'],'runId':e['runId'],'runAttempt':e['runAttempt'],'headSha':e['headSha']},'MSYS must belong to exact current consumer run')
    require(run['id']==e['runId'] and run['run_attempt']==e['runAttempt'] and run['head_sha']==e['headSha'],'run identity')
    require(run['repository']['id']==e['repositoryId'] and run['repository']['full_name']==e['repository'],'repository identity')
    require(run['head_repository']['id']==e['repositoryId'],'foreign source repository')
    require(run['path']=='.github/workflows/native-platform.yml' and run['head_branch']==BRANCH and run['event'] in ['push','workflow_dispatch'],'workflow identity')
    require(run['status'] in ['in_progress','completed'],'run not started')
    require(jobs['total_count']==len(jobs['jobs']) and 0<len(jobs['jobs'])<=100,'complete bounded single-page job inventory')
    ids=[j['id'] for j in jobs['jobs']];require(len(set(ids))==len(ids),'duplicate jobs')
    name='Platform and installer / windows-latest / Node 24.x' if e['kind']=='msys' else 'Platform and installer / windows-11-arm / Node 20.x'
    selected=[j for j in jobs['jobs'] if j['name']==name];require(len(selected)==1,'unique producer job')
    j=selected[0]
    require(j['id']==e['jobId'] and j['run_id']==e['runId'] and j['head_sha']==e['headSha'],'job identity')
    require(j.get('run_attempt',e['runAttempt'])==e['runAttempt'],'job attempt')
    require(j['run_url']==f"https://api.github.com/repos/{e['repository']}/actions/runs/{e['runId']}",'job API origin')
    require(j['status'] in ['in_progress','completed'],'producer job not started')
    steps=['Compile the isolated MSYS pipe adapter proof','Export the exact compiled MSYS candidate for native reuse','Publish immutable MSYS candidate bytes and producer authority'] if e['kind']=='msys' else ['Compile the isolated Node AppContainer pipe adapter','Require exact subprocess roundtrips with the built Node worker','Preserve the Node compiler output and native observations']
    for name in steps:
        s=[x for x in j['steps'] if x['name']==name];require(len(s)==1 and s[0]['status']=='completed' and s[0]['conclusion']=='success','producer component step incomplete or failed')
    require(artifact['id']==e['artifactId'] and artifact['name']==e['artifactName'] and artifact['expired'] is False,'artifact identity')
    require(artifact['digest']=='sha256:'+e['archiveSha256'],'artifact GitHub digest differs from externally selected digest')
    require(integer(artifact['size_in_bytes']) and artifact['size_in_bytes']<=MAX_ZIP,'archive size bound')
    w=artifact['workflow_run'];require(w['id']==e['runId'] and w['head_sha']==e['headSha'] and w['head_branch']==BRANCH and w['repository_id']==e['repositoryId'] and w['head_repository_id']==e['repositoryId'],'artifact workflow binding')
    created=datetime.fromisoformat(artifact['created_at'].replace('Z','+00:00'));start=datetime.fromisoformat(j['started_at'].replace('Z','+00:00'));require(created>=start,'artifact predates current attempt job')
    if j['completed_at']:require(created<=datetime.fromisoformat(j['completed_at'].replace('Z','+00:00')),'artifact follows job completion')
    return j

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):return None

def bounded(response,maximum,deadline_seconds=20):
    deadline=time.monotonic()+deadline_seconds
    require(response.headers.get('Content-Encoding') in [None,'identity'],'response encoding')
    length=response.headers.get('Content-Length')
    if length is not None:require(length.isdecimal() and int(length)<=maximum,'response length')
    result=bytearray()
    while True:
        require(time.monotonic()<deadline,'response deadline')
        chunk=response.read1(min(65536,maximum+1-len(result)))
        if not chunk:break
        result.extend(chunk);require(len(result)<=maximum,'response bound')
    return bytes(result)

def api_request(route,token,zip_download=False):
    require(re.fullmatch(r'/repos/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/actions/(?:runs/[1-9][0-9]*(?:/attempts/[1-9][0-9]*/jobs\?per_page=100&page=1|/artifacts\?per_page=100&page=1)?|artifacts/[1-9][0-9]*(?:/zip)?)',route) is not None,'API path')
    require('/../' not in route and '/./' not in route,'API traversal')
    require(isinstance(token,str) and re.fullmatch(r'[A-Za-z0-9_.-]{1,4096}',token) is not None,'workflow token')
    req=urllib.request.Request('https://api.github.com'+route,headers={'Authorization':'Bearer '+token,'Accept':'application/vnd.github+json','User-Agent':'autoprompt-candidate-consumer','X-GitHub-Api-Version':'2022-11-28','Accept-Encoding':'identity'})
    opener=urllib.request.build_opener(NoRedirect)
    try:
        with opener.open(req,timeout=10) as response:
            require(not zip_download and response.status==200,'unexpected API response')
            return json.loads(bounded(response,2*1024*1024))
    except urllib.error.HTTPError as error:
        require(zip_download and error.code==302,'GitHub API request failed')
        location=error.headers.get('Location','');u=urllib.parse.urlsplit(location)
        require(u.scheme=='https' and u.port in [None,443] and not u.username and not u.password and re.fullmatch(r'productionresultssa[0-9]+\.blob\.core\.windows\.net',u.hostname or '') is not None,'artifact redirect origin')
        # Credential is deliberately absent from storage-origin request.
        with opener.open(urllib.request.Request(location,headers={'Accept-Encoding':'identity'}),timeout=10) as response:
            require(response.status==200,'artifact HTTP status')
            return bounded(response,MAX_ZIP,90)

def archive_files(data,expected_digest,expected_size=None):
    require(isinstance(data,bytes) and 0<len(data)<=MAX_ZIP and digest(data)==expected_digest,'archive digest')
    if expected_size is not None:require(len(data)==expected_size,'archive byte length')
    result={};seen=set();total=0
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        require(len(z.infolist())<=96 and not z.comment,'ZIP directory bound/comment')
        for info in z.infolist():
            name=info.filename
            require(name==info.orig_filename and '\\' not in name and '\x00' not in name and not name.startswith('/'),'ZIP path encoding')
            parts=name.split('/');require(all(re.fullmatch(r'[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*',p) and len(p)<=96 and not re.match(r'(?i)^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)',p) for p in parts),'ZIP path segment')
            require(len(name)<=256 and name.lower() not in seen,'ZIP case alias/duplicate');seen.add(name.lower())
            mode=info.external_attr>>16;kind=stat.S_IFMT(mode)
            require(kind in [0,stat.S_IFREG] and not info.is_dir() and not (info.external_attr&0x400),'ZIP nonregular/reparse entry')
            require(info.flag_bits&1==0 and info.compress_type in [zipfile.ZIP_STORED,zipfile.ZIP_DEFLATED],'ZIP encryption/compression')
            require(0<=info.file_size<=MAX_FILE and 0<=info.compress_size<=MAX_ZIP,'ZIP file bounds');total+=info.file_size;require(total<=MAX_TOTAL,'ZIP aggregate bound')
            with z.open(info) as stream:
                value=stream.read(info.file_size+1);require(len(value)==info.file_size,'ZIP size/CRC');result[name]=value
    # Files cannot simultaneously be parent directories of other files.
    require(not any('/'.join(n.split('/')[:i]).lower() in seen for n in result for i in range(1,len(n.split('/')))),'ZIP file/directory collision')
    return result

def physical(target,directory=False):
    target=Path(target);require(target.is_absolute(),'absolute physical path')
    require(os.path.normcase(str(target.resolve(strict=True)))==os.path.normcase(str(target)),'aliased physical path')
    for item in [target,*target.parents]:
        st=item.lstat();require(not stat.S_ISLNK(st.st_mode) and not (getattr(st,'st_file_attributes',0)&0x400),'reparse or linked path')
        if item!=target or directory:require(stat.S_ISDIR(st.st_mode),'directory ancestor')
        else:require(stat.S_ISREG(st.st_mode) and st.st_nlink==1,'regular single-link file')
    return target.lstat()

def physical_read(target,maximum=MAX_FILE,allow_empty=False):
    target=Path(target);before=physical(target)
    require((0<=before.st_size if allow_empty else 0<before.st_size) and before.st_size<=maximum,'bounded physical input')
    with target.open('rb') as stream:data=stream.read(before.st_size+1)
    require(len(data)==before.st_size,'physical input size changed')
    after=physical(target)
    require((before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns),'physical input identity changed')
    return data

def native_environment(source,temporary_root=None):
    # Closed environment, case-insensitive cancellation of Node injection options.
    system=next((value for key,value in source.items() if key.upper()=='SYSTEMROOT'),None)
    require(isinstance(system,str) and re.fullmatch(r'[A-Za-z]:\\Windows',system,re.I),'Windows system root')
    result={'SystemRoot':system,'WINDIR':system,'SystemDrive':system[:2],'PATH':system+'\\System32'}
    if temporary_root is not None:result.update(TEMP=str(temporary_root),TMP=str(temporary_root))
    return result

def write_selected(destination,files,native=None):
    import subprocess
    destination=Path(destination);require(destination.is_absolute() and not destination.exists(),'fresh absolute destination')
    physical(destination.parent,True)
    seen=set()
    for name in files:
        require(re.fullmatch(r'[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*(?:/[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*)*',name) is not None,'output name')
        require(name.lower() not in seen,'output alias');seen.add(name.lower())
    if os.name=='nt':
        exact(native,['repoRoot','controllerPath','controllerSha256','aclSha256','writerSha256'])
        repo=Path(native['repoRoot']);controller=Path(native['controllerPath']);writer=Path(__file__).with_name('native-writer.cjs').resolve()
        physical(repo,True)
        inputs=[(controller,native['controllerSha256']),(repo/'agents/codex/workflow/safe-run-root.js',native['aclSha256']),(writer,native['writerSha256'])]
        for item,expected in inputs:physical(item);require(digest(physical_read(item))==expected,'trusted native writer input changed')
        destination.mkdir(mode=0o700);before=physical(destination,True)
        header={'schema':1,'files':[{'path':name,'bytes':len(value),'sha256':digest(value)} for name,value in files.items()]}
        payload=(json.dumps(header,separators=(',',':'))+'\n').encode()+b''.join(files.values())
        require(len(payload)<=320*1024*1024+65536,'native writer payload bound')
        result=subprocess.run([str(controller),str(writer),str(destination),str(repo),native['aclSha256'],native['controllerSha256']],input=payload,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=native_environment(os.environ,destination),cwd=str(destination.parent),timeout=180,check=True)
        require(not result.stderr and len(result.stdout)<=1024,'native writer output')
        require(json.loads(result.stdout)=={'status':'private-native-materialization-not-held-capture','files':len(files)},'native writer completion')
        after=physical(destination,True);require((before.st_dev,before.st_ino)==(after.st_dev,after.st_ino),'native root changed')
        for item,expected in inputs:physical(item);require(digest(physical_read(item))==expected,'trusted writer input changed afterward')
    else:
        require(native is None,'Windows writer cannot be simulated on this host')
        destination.mkdir(mode=0o700)
        for name,value in files.items():
            target=destination.joinpath(*PurePosixPath(name).parts);target.parent.mkdir(parents=True,exist_ok=True,mode=0o700);physical(target.parent,True)
            with target.open('xb') as f:f.write(value)
            target.chmod(0o600)
    # Explicit Python lstat checks reject reparse attributes and hardlinks too.
    for name,value in files.items():
        target=destination.joinpath(*PurePosixPath(name).parts);before=physical(target);require(target.read_bytes()==value,'materialized bytes changed');after=physical(target)
        require((before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns),'materialized file changed during verification')
    return destination

def parse_canonical(data):
    value=json.loads(data);require(canonical(value)==data,'canonical JSON required');return value

def msys_context(files,e,archive_path,repo,controller=None):
    """Authenticate exported authority through GitHub archive bytes, not self-hashes."""
    require(e['kind']=='msys','MSYS authority required')
    import subprocess
    producer=parse_canonical(files['producer-context.json']);result=parse_canonical(files['producer-result.json'].replace(b'\r\n',b'\n'))
    expected=result['expected']
    exact(producer,['schema','producer','observedTools'])
    exact(result,['root','manifestSha256','status','expected','toolIdentityAuthority','nativeAcceptance'])
    require(result['toolIdentityAuthority']=='trusted-builder-observation-not-independent-sdk-attestation','unexpected tool authority')
    require(producer['schema']==1 and producer['producer']==expected['producer'],'producer context join')
    target={'repository':e['repository'],'headSha':e['headSha'],'runId':str(e['runId']),'runAttempt':e['runAttempt'],'jobId':str(e['jobId']),'architecture':'x64'}
    require(expected['producer']==target,'authenticated producer identity differs')
    require(result['status']=='candidate-exported-not-accepted' and result['nativeAcceptance']=='not-performed','candidate export scope')
    manifest=files['packet/manifest.json'];require(digest(manifest)==result['manifestSha256'],'exported manifest identity')
    value=parse_canonical(manifest)
    require(value['authority']==expected and value['status']=='not-native-accepted','manifest authority join')
    require(set(files)=={'producer-context.json','producer-result.json','packet/manifest.json'}|{'packet/'+x['path'] for x in value['files']},'closed exported archive')
    # Export pins must match reviewed checkout; never adopt packet source pins.
    js="const fs=require('fs'),p=require(process.argv[1]+'/scripts/windows-msys/portable-runtime/portable.cjs'),c=require(process.argv[1]+'/scripts/windows-msys/portable-runtime/cli.cjs');const v=JSON.parse(fs.readFileSync(0));process.stdout.write(p.canonical(c.exportAuthority(process.argv[1],v)))"
    controller=controller or {'path':os.environ.get('NODE_BINARY'),'sha256':os.environ.get('NODE_BINARY_SHA256')}
    exact(controller,['path','sha256']);node=controller['path']
    require(isinstance(node,str) and Path(node).is_absolute(),'explicit absolute caller-selected Node controller required')
    require(isinstance(controller['sha256'],str) and re.fullmatch('[a-f0-9]{64}',controller['sha256']) is not None,'externally pinned Node controller required')
    require(digest(physical_read(node))==controller['sha256'],'source checker controller changed')
    env=native_environment(os.environ) if os.name=='nt' else {k:v for k,v in os.environ.items() if k.upper() not in ['NODE_OPTIONS','NODE_PATH','GITHUB_TOKEN']}
    checked=subprocess.run([node,'-e',js,str(Path(repo).resolve())],input=canonical(producer),stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,timeout=15,check=True)
    require(digest(physical_read(node))==controller['sha256'],'source checker controller changed afterward')
    require(parse_canonical(checked.stdout)==expected,'reviewed checkout source differs')
    return {'schema':1,'expected':expected,'transport':{'artifactId':str(e['artifactId']),'archivePath':str(Path(archive_path).resolve()),'archiveSha256':e['archiveSha256'],'manifestSha256':result['manifestSha256']}}

def node_component(files,pin):
    require(set(files)==set(pin['files']),'closed original Node archive')
    for file,key in [('stage/node.exe','nodeSha256'),('stage/built-runtime-proof.txt','proofSha256'),('stage/provenance.json','provenanceSha256')]:require(digest(files[file])==pin[key],'externally pinned Node component bytes')
    require(len(files['stage/node.exe'])==pin['nodeBytes'],'Node byte length')
    p=json.loads(files['stage/provenance.json']);require(p['identity']['arch']=='arm64' and p['architecture']=='arm64' and p['nodeSha256']==pin['nodeSha256'],'ARM64 Node provenance')
    return {name:files[name] for name in ['stage/node.exe','stage/provenance.json','stage/built-runtime-proof.txt','stage/LICENSE']}

def fetch(e,token,current=None):
    expectation(e);base=f"/repos/{e['repository']}/actions"
    run=api_request(f"{base}/runs/{e['runId']}",token)
    jobs=api_request(f"{base}/runs/{e['runId']}/attempts/{e['runAttempt']}/jobs?per_page=100&page=1",token)
    artifact=api_request(f"{base}/artifacts/{e['artifactId']}",token)
    metadata(e,run,jobs,artifact,current)
    data=api_request(f"{base}/artifacts/{e['artifactId']}/zip",token,True)
    files=archive_files(data,e['archiveSha256'],artifact['size_in_bytes'])
    # A concurrent rerun must not allow a stale-attempt artifact after download.
    after=api_request(f"{base}/runs/{e['runId']}",token)
    require(after['run_attempt']==e['runAttempt'] and after['head_sha']==e['headSha'],'run changed during download')
    return data,files,{'expectation':e,'run':run,'jobs':jobs,'artifact':artifact,'status':'authenticated-transport-not-native-acceptance'}

def resolve_same_run(current,repository_id,token,deadline_seconds=1800,read_api=api_request,sleep=time.sleep,now=time.monotonic):
    """Resolve only a finalized exact-name artifact in this current run/attempt."""
    exact(current,['repository','runId','runAttempt','headSha'])
    require(integer(repository_id) and isinstance(deadline_seconds,int) and 1<=deadline_seconds<=3600,'poller bounds')
    # Reuse strict expectation validation before interpolating any API path.
    trial={'kind':'msys',**current,'repositoryId':repository_id,'jobId':1,'artifactId':1,
           'artifactName':f"windows-msys-candidate-{current['headSha']}-{current['runAttempt']}",'archiveSha256':'0'*64}
    expectation(trial)
    base=f"/repos/{current['repository']}/actions/runs/{current['runId']}";deadline=now()+deadline_seconds
    while now()<deadline:
        run=read_api(base,token)
        require(run['id']==current['runId'] and run['run_attempt']==current['runAttempt'] and run['head_sha']==current['headSha'],'current run changed while polling')
        require(run['repository']['id']==repository_id and run['repository']['full_name']==current['repository'],'poll repository changed')
        jobs=read_api(base+f"/attempts/{current['runAttempt']}/jobs?per_page=100&page=1",token)
        require(0<jobs['total_count']==len(jobs['jobs'])<=100,'poll job inventory bound')
        selected=[j for j in jobs['jobs'] if j['name']=='Platform and installer / windows-latest / Node 24.x']
        require(len(selected)==1,'poll producer job ambiguity');job=selected[0]
        required=['Compile the isolated MSYS pipe adapter proof','Export the exact compiled MSYS candidate for native reuse','Publish immutable MSYS candidate bytes and producer authority']
        ready=True
        for name in required:
            steps=[s for s in job['steps'] if s['name']==name]
            require(len(steps)<=1,'poll duplicate producer step')
            if not steps:ready=False;continue
            step=steps[0]
            require(step.get('conclusion') not in ['failure','cancelled','skipped','timed_out','action_required'],'producer component failed or skipped')
            ready &= step['status']=='completed' and step['conclusion']=='success'
        inventory=read_api(base+'/artifacts?per_page=100&page=1',token)
        require(0<=inventory['total_count']==len(inventory['artifacts'])<=100,'poll artifact inventory bound')
        candidates=[a for a in inventory['artifacts'] if a['name']==trial['artifactName']]
        require(len(candidates)<=1,'immutable candidate name ambiguity')
        if ready and candidates:
            artifact=candidates[0];e={**trial,'jobId':job['id'],'artifactId':artifact['id'],'archiveSha256':artifact['digest'].removeprefix('sha256:')}
            metadata(e,run,jobs,artifact,current)
            require(now()<deadline,'artifact appeared after poll deadline')
            return e
        require(job['status']!='completed' and run['status']!='completed','producer completed without a usable candidate')
        remaining=deadline-now()
        if remaining>0:sleep(min(15,remaining))
    raise TransportError('exact current-run artifact deadline exceeded')

if __name__=='__main__':
    import argparse,sys
    parser=argparse.ArgumentParser();parser.add_argument('kind',choices=['node-arm64','msys']);parser.add_argument('expectation');parser.add_argument('new_output');parser.add_argument('--current');parser.add_argument('--repo');parser.add_argument('--native-writer-context')
    args=parser.parse_args()
    try:
        writer_context=json.loads(Path(args.native_writer_context).read_text()) if args.native_writer_context else None
        pin=json.loads(Path(args.expectation).read_text());e=pin['expectation'] if args.kind=='node-arm64' else pin
        current=json.loads(Path(args.current).read_text()) if args.current else None
        data,files,record=fetch(e,os.environ.get('GITHUB_TOKEN'),current)
        destination=Path(args.new_output).resolve()
        if args.kind=='node-arm64':selected=node_component(files,pin)
        else:
            require(args.repo is not None,'trusted repo required');context=msys_context(files,e,destination/'archive.zip',args.repo,{'path':writer_context['controllerPath'],'sha256':writer_context['controllerSha256']} if writer_context else None);selected=files|{'import-context.json':canonical(context)}
        selected=selected|{'archive.zip':data,'transport.json':canonical(record)}
        write_selected(destination,selected,writer_context)
        print(json.dumps({'status':'authenticated-transport-not-native-acceptance','root':str(destination),'artifactId':e['artifactId'],'archiveSha256':e['archiveSha256']}))
    except Exception as error:
        # Do not print HTTP exceptions or signed storage URLs/tokens.
        print(json.dumps({'status':'candidate-transport-refused','errorType':type(error).__name__,'reason':failure_reason(error)}),file=sys.stderr);sys.exit(1)
