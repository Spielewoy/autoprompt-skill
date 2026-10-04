'use strict'
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),cp=require('node:child_process')
// Execute the actual generated shell command with controlled builtin failures.
// These host Bash checks do not substitute for the AppContainer canary itself.
function command(){
 const text=fs.readFileSync(path.resolve(__dirname,'../../agents/codex/workflow/windows-appcontainer-probe.js'),'utf8')
 const start=text.indexOf('    const command = '),end=text.indexOf('\n',start)
 assert.ok(start>0&&end>start)
 const encoded=Buffer.from('process.stdout.write("WORKER_REACHED")').toString('base64')
 return vm.runInNewContext(text.slice(start,end).replace('    const command = ',''),{encoded})
}
const options={skip:process.platform==='linux'?false:'Host Bash assertions run on Linux; Windows requires the actual AppContainer canary',timeout:15000}
function run(prefix=''){
 const result=cp.spawnSync('/bin/bash',['--noprofile','--norc','-c',prefix+command()],{encoding:'utf8',timeout:10000,env:{PATH:path.dirname(process.execPath)+path.delimiter+'/usr/bin:/bin'}})
 assert.ifError(result.error);assert.equal(result.signal,null);return result
}
test('production shell canary requires real command substitution and pipeline before the worker',options,()=>{
 const r=run();assert.equal(r.status,0,r.stderr);assert.equal(r.stdout,'WORKER_REACHED');assert.equal(r.stderr,'')
})
for(const [name,prefix,status] of [
 ['failed substitution',"printf(){ return 9; }; ",91],
 ['parent PID substituted for child',"printf(){ builtin printf '%s' \"$ap_parent\"; }; ",92],
 ['invalid child PID',"printf(){ builtin printf '%s' invalid; }; ",92],
 ['failed pipefail setup',"set(){ return 9; }; ",93],
 ['failed pipeline writer',"printf(){ if [[ $1 == '%s' ]]; then builtin printf \"$@\"; else return 9; fi; }; ",93],
 ['wrong pipeline payload',"read(){ ap_line=wrong; return 0; }; ",93],
])test('production shell canary refuses '+name+' without reaching the worker',options,()=>{
 const r=run(prefix);assert.equal(r.status,status,r.stderr);assert.equal(r.stdout,'')
})
