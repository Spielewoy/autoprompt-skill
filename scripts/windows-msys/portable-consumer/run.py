#!/usr/bin/env python3
"""Native ARM diagnostic consumer. No production installation or acceptance."""
from pathlib import Path
import argparse, hashlib, json, os, re, shutil, subprocess, sys, threading, time
import transport as t
ROOT=Path(__file__).resolve().parent
LAST_STAGE='startup'
STAGES=frozenset(['startup','workflow-identity','checkout','private-output','helper-authority','helper-proof','msys-artifact-poll','msys-artifact-download','msys-authority-join','msys-private-write','node-artifact-download','node-private-write','node-source-proof','node-native','node-native-verify','native-import','import-receipt-join','probe-context','portable-probe'])
def set_stage(name):
    global LAST_STAGE
    t.require(name in STAGES,'unknown consumer stage')
    LAST_STAGE=name

def failure_report(error,output):
    report={'status':'portable-consumer-refused','stage':LAST_STAGE,'errorType':type(error).__name__,'reason':t.failure_reason(error),'cleanupConfirmed':False,'retainedOutput':str(Path(output).resolve())}
    if type(error) is t.NativeWriterError:report['nativeWriter']=t.writer_failure(b'',(json.dumps(error.record,separators=(',',':'))+'\n').encode())
    return report


def current_environment(env):
    for key,value in {'GITHUB_ACTIONS':'true','RUNNER_OS':'Windows','GITHUB_JOB':'platform-primitives','GITHUB_REF':'refs/heads/'+t.BRANCH}.items():t.require(env.get(key)==value,'current Windows workflow identity required')
    architecture=env.get('RUNNER_ARCH','').lower();t.require(architecture in ['x64','arm64'],'current native architecture required')
    t.require(env.get('GITHUB_EVENT_NAME') in ['push','workflow_dispatch'],'current branch producer event required')
    t.require(env.get('GITHUB_REPOSITORY')=='Spielewoy/autoprompt-skill','unexpected diagnostic repository')
    for key in ['GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','GITHUB_REPOSITORY_ID']:t.require(re.fullmatch('[1-9][0-9]{0,14}',env.get(key,'')) is not None,'numeric current workflow identity')
    current={'repository':env['GITHUB_REPOSITORY'],'runId':int(env['GITHUB_RUN_ID']),'runAttempt':int(env['GITHUB_RUN_ATTEMPT']),'headSha':env['GITHUB_SHA']}
    t.require(re.fullmatch('[a-f0-9]{40}',current['headSha']) is not None,'current head')
    return current,int(env['GITHUB_REPOSITORY_ID']),architecture

def helper_authority(repo,build,system_root,architecture):
    record=json.loads(t.physical_read(build/'build.json',1024*1024))
    t.exact(record,['schema','status','identity','source','files'])
    t.require(record['schema']==1 and record['status']=='compiled-native-identity-only' and record['identity']=='bundle-lease-helper-v1:'+architecture,'local native helper builder identity')
    source_paths=['../physical-proof/audit.cs','lease-main.cs','build.ps1']
    t.require([v['path'] for v in record['source']]==source_paths,'exact local helper sources')
    for value in record['source']:
        t.exact(value,['path','sha256']);source=(repo/'scripts/windows-runtime/precompiled-proof'/value['path']).resolve()
        t.require(t.digest(t.physical_read(source,1024*1024))==value['sha256'],'local helper source changed since build')
    t.require([v['path'] for v in record['files']]==['bundle-lease.exe','bundle-lease.exe.config'],'exact local helper files')
    hashes={}
    for value in record['files']:
        t.exact(value,['path','length','sha256']);data=t.physical_read(build/value['path'],1024*1024)
        t.require(len(data)==value['length'] and t.digest(data)==value['sha256'],'local helper bytes changed since build');hashes[value['path']]=value['sha256']
    return {'executable':str(build/'bundle-lease.exe'),'executableSha256':hashes['bundle-lease.exe'],'configSha256':hashes['bundle-lease.exe.config'],'systemRoot':system_root}

def run_process(argv,output,name,env,timeout,emit=False):
    """Bound stdout+stderr jointly; any outer failure retains all native roots."""
    limit=12*1024*1024;lock=threading.Lock();total=[0];errors=[]
    paths=[output/(name+'.stdout.txt'),output/(name+'.stderr.txt')]
    for file in paths:t.physical(file)
    process=subprocess.Popen(argv,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,cwd=output)
    def capture(stream,file):
        try:
            with file.open('wb') as target:
                while True:
                    data=stream.read(4096)
                    if not data:break
                    with lock:
                        total[0]+=len(data)
                        if total[0]>limit:
                            errors.append('bounded child output exceeded');process.kill();return
                    target.write(data);target.flush()
                    if emit and file==paths[0]:sys.stdout.buffer.write(data);sys.stdout.buffer.flush()
        except Exception:
            with lock:errors.append('child output capture failed')
            try:process.kill()
            except OSError:pass
        finally:stream.close()
    threads=[threading.Thread(target=capture,args=(stream,file),daemon=True) for stream,file in zip([process.stdout,process.stderr],paths)]
    for thread in threads:thread.start()
    timed_out=False
    try:status=process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        process.kill();process.wait(timeout=10);timed_out=True;status=process.returncode
    for thread in threads:thread.join(timeout=10)
    t.require(not timed_out,'native stage deadline; cleanup unknown, output retained')
    t.require(not any(thread.is_alive() for thread in threads) and not errors,'native output close unconfirmed; output retained')
    t.require(status==0,'native stage failed; inspect retained stdout and stderr')
    return [t.physical_read(file,limit,allow_empty=True) for file in paths]

def main(args):
    set_stage('workflow-identity')
    t.require(os.name=='nt','actual Windows consumer required')
    current,repository_id,architecture=current_environment(os.environ)
    repo=Path(args.repo).resolve();output=Path(args.output).resolve();controller=Path(args.controller).resolve();build=Path(args.helper_directory).resolve()
    for directory in [repo,output.parent,build]:t.physical(directory,True)
    t.require(re.fullmatch('[a-f0-9]{64}',args.controller_sha256) is not None and t.digest(t.physical_read(controller))==args.controller_sha256,'externally selected controller changed')
    set_stage('checkout')
    git=shutil.which('git');t.require(git is not None,'trusted workflow Git required');git=str(Path(git).resolve());t.physical(git)
    t.require(subprocess.check_output([git,'-C',str(repo),'rev-parse','HEAD'],timeout=10,text=True).strip()==current['headSha'],'current checkout head mismatch')
    subprocess.run([git,'-C',str(repo),'diff','--quiet','HEAD','--','agents','scripts','tests'],timeout=10,check=True)
    writer={'repoRoot':str(repo),'controllerPath':str(controller),'controllerSha256':args.controller_sha256,'aclSha256':t.digest(t.physical_read(repo/'agents/codex/workflow/safe-run-root.js')),'writerSha256':t.digest(t.physical_read(ROOT/'native-writer.cjs'))}
    stages=['helper-proof','node-source-proof','node-native','node-native-verify','import','portable-probe']
    initial={'controller-temp/anchor':b'private diagnostic controller scratch\n','current-run.json':t.canonical(current)}
    initial.update({name+'.'+stream+'.txt':b'' for name in stages for stream in ['stdout','stderr']})
    set_stage('private-output')
    t.write_selected(output,initial,writer)
    env=t.native_environment(os.environ,output/'controller-temp');env['PATH']=str(Path(git).parent)+';'+env['PATH']
    set_stage('helper-authority')
    helper=helper_authority(repo,build,env['SystemRoot'],architecture)
    set_stage('helper-proof')
    run_process([str(controller),str(repo/'scripts/windows-runtime/precompiled-proof/verify-output.cjs'),str(build/'native.tap')],output,'helper-proof',env,30)
    print('Portable consumer: authenticating '+('hard-pinned CI49' if args.reuse_ci49 else 'exact current-run')+' MSYS artifact',flush=True)
    set_stage('msys-artifact-poll')
    replay=None
    if args.reuse_ci49:
        replay=json.loads(t.physical_read(ROOT/'msys-candidate-ci49.json',65536));t.exact(replay,['expectation','manifestSha256','scope'])
        t.require(replay['scope']=='CI49 immutable candidate transport for explicit replay only; native acceptance is never inferred','exact CI49 replay scope')
        expected=replay['expectation'];t.expectation(expected)
    else:expected=t.resolve_same_run(current,repository_id,os.environ.get('GITHUB_TOKEN'),deadline_seconds=args.artifact_timeout)
    source_run={key:expected[key] for key in ['repository','runId','runAttempt','headSha']}
    set_stage('msys-artifact-download')
    msys_zip,msys_files,msys_record=t.fetch(expected,os.environ.get('GITHUB_TOKEN'),source_run)
    msys_root=output/'msys'
    set_stage('msys-authority-join')
    context=t.msys_context(msys_files,expected,msys_root/'archive.zip',repo,{'path':str(controller),'sha256':args.controller_sha256})
    if replay is not None:t.require(context['transport']['manifestSha256']==replay['manifestSha256'],'hard-pinned CI49 manifest changed')
    set_stage('msys-private-write')
    t.write_selected(msys_root,msys_files|{'archive.zip':msys_zip,'transport.json':t.canonical(msys_record),'import-context.json':t.canonical(context)},writer)
    pin=json.loads(t.physical_read(ROOT/('node-'+architecture+'-ci20.json'),65536))
    t.require(pin['architecture']==architecture,'current architecture Node pin required')
    print('Portable consumer: authenticating explicitly pinned CI20 '+architecture+' Node component',flush=True)
    set_stage('node-artifact-download')
    node_zip,node_files,node_record=t.fetch(pin['expectation'],os.environ.get('GITHUB_TOKEN'))
    set_stage('node-private-write')
    node_root=output/'node';t.write_selected(node_root,t.node_component(node_files,pin)|{'archive.zip':node_zip,'transport.json':t.canonical(node_record)},writer)
    stage=node_root/'stage';node=stage/'node.exe'
    set_stage('node-source-proof')
    run_process([str(controller),str(repo/'scripts/windows-node/verify-native-proof.cjs'),str(stage/'built-runtime-proof.txt'),str(stage/'provenance.json'),str(node),pin['nodeSha256']],output,'node-source-proof',env,60)
    print('Portable consumer: rerunning four native Node stdio/IPC modes',flush=True)
    node_env={**env,'AUTOPROMPT_NODE_PIPE_WORKER':str(node),'AUTOPROMPT_NODE_PIPE_WORKER_SHA256':pin['nodeSha256'],'AUTOPROMPT_NODE_PIPE_REQUIRE_SUPPORT':'1'}
    set_stage('node-native')
    run_process([str(controller),'--test','--test-reporter=tap',str(repo/'tests/source/windows-appcontainer-node-pipes.test.cjs')],output,'node-native',node_env,650)
    set_stage('node-native-verify')
    run_process([str(controller),str(repo/'scripts/windows-node/verify-native-proof.cjs'),str(output/'node-native.stdout.txt'),str(stage/'provenance.json'),str(node),pin['nodeSha256']],output,'node-native-verify',env,60)
    print('Portable consumer: acquiring an actual native import lease',flush=True)
    imported=output/'imported'
    set_stage('native-import')
    stdout,stderr=run_process([str(controller),str(repo/'scripts/windows-msys/portable-runtime/cli.cjs'),'import',str(repo),str(msys_root/'packet'),str(msys_root/'import-context.json'),str(imported)],output,'import',env,300)
    set_stage('import-receipt-join')
    t.require(not stderr,'native import stderr');receipt=t.parse_canonical(stdout)
    t.require(receipt['status']=='candidate-imported-not-accepted' and receipt['manifestSha256']==context['transport']['manifestSha256'],'fresh import completion')
    t.require(receipt['receiptSha256']==t.digest(t.physical_read(imported/'import.json')),'fresh importer receipt bytes')
    set_stage('probe-context')
    probe={'candidate':{'authority':context['expected'],'manifestSha256':context['transport']['manifestSha256'],'receiptSha256':receipt['receiptSha256']},'consumerHeadSha':current['headSha'],
           'node':{'architecture':architecture,'executableSha256':pin['nodeSha256'],'provenanceSha256':pin['provenanceSha256'],'nativeProofSha256':t.digest(t.physical_read(output/'node-native.stdout.txt',256*1024))},
           'helper':helper,'captureAdapterSha256':t.digest(t.physical_read(repo/'scripts/windows-runtime/precompiled-proof/adapter.cjs'))}
    control=output/'probe-control';t.write_selected(control,{'authority.json':t.canonical(probe)},writer)
    print('Portable consumer: executing fresh native '+architecture+' Node with x64 Bash/MSYS',flush=True)
    set_stage('portable-probe')
    probe_env={**env,'GITHUB_SHA':current['headSha']}
    run_process([str(node),str(repo/'scripts/windows-msys/portable-probe/run.cjs'),str(repo),str(imported),str(control/'authority.json'),str(output/'native-probe')],output,'portable-probe',probe_env,1800,emit=True)
    print(json.dumps({'status':'portable-consumer-diagnostic-completed-not-runtime-acceptance','output':str(output),'accepted':False}),flush=True)

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--repo',required=True);parser.add_argument('--output',required=True);parser.add_argument('--controller',required=True);parser.add_argument('--controller-sha256',required=True);parser.add_argument('--helper-directory',required=True);parser.add_argument('--artifact-timeout',type=int,default=2400);parser.add_argument('--reuse-ci49',action='store_true')
    args=parser.parse_args()
    try:main(args)
    except Exception as error:
        # Native failure/outer timeout never authorizes deleting diagnostic roots.
        print(json.dumps(failure_report(error,args.output)),file=sys.stderr);sys.exit(1)
