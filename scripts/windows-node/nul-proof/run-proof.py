import argparse,hashlib,json,os,shutil,subprocess,tempfile
from pathlib import Path
root=Path(__file__).resolve().parent
parser=argparse.ArgumentParser()
parser.add_argument('--source',required=True)
parser.add_argument('--cc',required=True)
args=parser.parse_args()
source=Path(args.source).resolve(strict=True)
binding=json.loads((root/'binding.json').read_text())
sha=lambda value:hashlib.sha256(value).hexdigest()
def require(condition, message):
 if not condition:raise RuntimeError(message)
patch=(root/'libuv-private-nul-capability.patch').read_bytes()
require(sha(patch)==binding['patchSha256'], 'Candidate patch hash mismatch')
compiler=str(Path(shutil.which(args.cc) or args.cc).resolve(strict=True))
environment={k:v for k,v in os.environ.items() if not k.upper().startswith('GIT_') and k.upper() not in {'CPATH','C_INCLUDE_PATH','CPLUS_INCLUDE_PATH','LIBRARY_PATH','GCC_EXEC_PREFIX','COMPILER_PATH'}}
environment.update(GIT_CONFIG_NOSYSTEM='1',GIT_CONFIG_GLOBAL=os.devnull)
def run(cmd,cwd,timeout=30):
 r=subprocess.run(cmd,cwd=cwd,env=environment,stdin=subprocess.DEVNULL,capture_output=True,text=True,timeout=timeout)
 if r.returncode:raise RuntimeError(str(cmd)+'\n'+r.stdout+r.stderr)
 return r
def function(text,name):
 start='int '+name+'('
 require(text.count(start)==1, 'Function must occur exactly once: '+name)
 return start+text.split(start,1)[1].split('\n}\n',1)[0]+'\n}\n'
with tempfile.TemporaryDirectory(prefix='nul-capability-proof-') as temp:
 work=Path(temp)
 originals={}
 for file,identities in binding['files'].items():
  if identities['originalSha256'] is None:continue
  data=(source/file).read_bytes();require(sha(data)==identities['originalSha256'], 'Source hash mismatch: '+file)
  originals[file]=data
  target=work/file;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(data)
 (work/'candidate.patch').write_bytes(patch)
 run(['git','apply','--check','candidate.patch'],work)
 run(['git','apply','candidate.patch'],work)
 for file,identities in binding['files'].items():require(sha((work/file).read_bytes())==identities['candidateSha256'], 'Patched file hash mismatch: '+file)
 header=(work/'deps/uv/src/win/nul-capability.h').read_text()
 function_body=function((work/'deps/uv/src/win/process-stdio.c').read_text(),'uv__create_nul_handle')
 normalized=function_body.replace('DWORD access, HANDLE capability)', 'DWORD access)').replace('  if (capability != NULL)\n    return uv__nul_capability_duplicate(capability, access, handle_ptr);\n\n','')
 require(normalized==function(originals['deps/uv/src/win/process-stdio.c'].decode(),'uv__create_nul_handle'), 'Ordinary direct-open body changed')
 internal=(work/'deps/uv/src/win/internal.h').read_text()
 state='typedef struct {\n  HANDLE handle;\n  uintptr_t locator;\n} uv__nul_capability_t;\n'
 require(internal.count(state)==1, 'Expected capability state must occur exactly once')
 prefix=(root/'mock-prefix.c').read_text()
 duplicate='typedef struct {HANDLE handle;uintptr_t locator;} uv__nul_capability_t;\n'
 require(prefix.count(duplicate)==1, 'Mock state placeholder must occur exactly once')
 prefix=prefix.replace(duplicate,state)
 suffix=(root/'mock-suffix.c').read_text()
 code=prefix+header+function_body+suffix
 (work/'proof.c').write_text(code)
 run([compiler,'-std=c11','-fshort-wchar','-Wall','-Wextra','-Werror','-O2',str(work/'proof.c'),'-o',str(work/'proof')],work)
 result=json.loads(run([str(work/'proof')],work,10).stdout)
 require(result=={'cases':41,'nativeWindows':False,'wcharBytes':2,'dwordBytes':4}, 'Unexpected proof result')
 result.update(patchSha256=sha(patch),helperSha256=sha(header.encode()),extractedNulFunctionSha256=sha(function_body.encode()),mockPrefixSha256=sha(prefix.encode()),mockSuffixSha256=sha(suffix.encode()),compiler=run([compiler,'--version'],work).stdout.splitlines()[0],compilerSha256=sha(Path(compiler).read_bytes()))
 print(json.dumps(result,indent=2))
