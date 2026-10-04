'use strict'
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process')
const harness=require('./harness.cjs')
const {createProgress,boundedError}=require('./progress.cjs')
function checkedConsumerHead(value,repo,environment=process.env,exec=cp.execFileSync) {
  assert.match(value,/^[a-f0-9]{40}$/)
  const head=exec('git',['-C',repo,'rev-parse','HEAD'],{encoding:'utf8',timeout:10000,maxBuffer:4096}).trim()
  assert.equal(head,value,'Consumer checkout must match recorded consumer head')
  assert.equal(environment.GITHUB_SHA,value,'Workflow SHA must match recorded consumer head')
  return head
}
async function main(args) {
  assert.equal(args.length,4,'Usage: verified-adapted-node.exe run.cjs REPO IMPORTED_ROOT AUTHORITY_JSON NEW_OUTPUT')
  assert.equal(process.platform,'win32','Actual Windows required')
  const [repoArg,importArg,authorityArg,outputArg]=args
  const repo=fs.realpathSync.native(path.resolve(repoArg)),root=fs.realpathSync.native(path.resolve(importArg))
  const p=require(path.join(repo,'scripts/windows-msys/portable-runtime/portable.cjs'))
  const context=p.parseCanonical(p.read(path.resolve(authorityArg)))
  assert.deepEqual(Object.keys(context).sort(),['candidate','consumerHeadSha','node','helper','captureAdapterSha256'].sort())
  checkedConsumerHead(context.consumerHeadSha,repo)
  cp.execFileSync('git',['-C',repo,'diff','--exit-code','HEAD','--','agents','scripts','tests'],{timeout:10000,maxBuffer:1024*1024})
  const output=path.resolve(outputArg)
  assert.equal(fs.existsSync(output),false);assert.equal(fs.realpathSync.native(path.dirname(output)),path.dirname(output))
  fs.mkdirSync(output,{mode:0o700})
  require(path.join(repo,'agents/codex/workflow/safe-run-root.js')).ensureWindowsPrivateAcl(output)
  const progress=createProgress(output)
  try {
  progress.record('capturing')
  const candidate=await harness.captureImported({repo,root,expected:context.candidate,node:context.node,
    helper:context.helper,captureAdapterSha256:context.captureAdapterSha256,workParent:output})
  fs.writeFileSync(path.join(output,'captured-tuple.json'),p.canonical(harness.tupleIdentity(candidate)),{flag:'wx'})
  progress.bindTuple(harness.tupleIdentity(candidate))
  progress.record('captured')
  progress.record('bash-smoke-started')
  const smoke=harness.runSmoke(candidate,path.join(output,'bash-smoke'))
  progress.record('bash-smoke-passed')
  progress.record('posix-started')
  const posix=await require('./posix.cjs').runPosix(candidate,smoke,path.join(output,'posix'))
  const result={status:'portable-native-smoke-and-posix-complete-not-runtime-acceptance',consumerHeadSha:context.consumerHeadSha,tuple:harness.tupleIdentity(candidate),
    smoke:smoke.status,posix:posix.status,accepted:false}
  fs.writeFileSync(path.join(output,'result.json'),p.canonical(result),{flag:'wx'})
  progress.record('completed')
  process.stdout.write(p.canonical(result))
  } catch(error) {
    progress.record('failed',boundedError(error))
    throw error
  }
}
module.exports={main,checkedConsumerHead}
if(require.main===module)main(process.argv.slice(2)).catch(error=>{process.stderr.write(JSON.stringify({status:'portable-native-probe-refused',...boundedError(error)})+'\n');process.exitCode=1})
