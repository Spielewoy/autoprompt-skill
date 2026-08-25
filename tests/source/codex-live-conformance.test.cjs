#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const harness = require('../../scripts/benchmark-evidence/codex-live-conformance.cjs')
const runtimeIdentity = require('../../scripts/codex-runtime-identity.cjs')

const IDENTITY_HASH = 'a'.repeat(64)
const ROOT = path.resolve(__dirname, '..', '..')

function canonicalCodexInputs() {
  const manifest = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'agents', 'manifests', 'codex-runtime.json'), 'utf8'))
  const registry = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'agents', 'contracts', 'providers.json'), 'utf8'))
  const provider = registry.providers.find(candidate => candidate.id === 'codex')
  return { manifest, provider }
}

function write(file, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, { mode })
}

function fakeSpawnedChild(pid = 4242) {
  const child = new EventEmitter()
  child.pid = pid
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  return child
}

function fakeCli(root, typed = true, fixture = {}) {
  const file = path.join(root, typed ? 'fake-codex-v149.cjs' : 'fake-text-only-codex-v149.cjs')
  const source = String.raw`
'use strict'
const cp=require('node:child_process'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path')
const settings=__SETTINGS__,typed=__TYPED__
const args=process.argv.slice(2)
if(settings.invocationMarker)fs.appendFileSync(settings.invocationMarker,'invoked\n')
if(args[0]==='--version'){process.stdout.write('codex-cli fixture-1.0\n');process.exit(0)}
if(args[0]==='--help'){process.stdout.write('fixture help --profile --strict-config --cd\n');process.exit(0)}
const target=args[args.indexOf('--cd')+1],mission=args.at(-1)
const token=/The file must contain exactly ([A-Za-z0-9_]+)/.exec(mission)[1]
const roles=[...mission.matchAll(/exact private role ([^ .]+)/g)].map(match=>match[1])
const base=Date.parse('2026-08-23T00:00:00.000Z')
const stamp=(ms,row)=>({timestamp:new Date(base+ms).toISOString(),...row})
const event=(ms,type,payload={})=>stamp(ms,{type:'event_msg',payload:{type,...payload}})
const start=(ms,id)=>event(ms,'task_started',{turn_id:id,started_at:Math.floor((base+ms)/1000),collaboration_mode_kind:'default',model_context_window:1000})
const complete=(ms,id,message)=>event(ms,'task_complete',{turn_id:id,last_agent_message:message,started_at:Math.floor((base+ms-10)/1000),completed_at:Math.floor((base+ms)/1000),duration_ms:10,time_to_first_token_ms:1})
const usage=(ms,input,output)=>event(ms,'token_count',{info:{last_token_usage:{input_tokens:input,output_tokens:output,total_tokens:input+output,cached_input_tokens:0,cache_write_input_tokens:0,reasoning_output_tokens:0},total_token_usage:{input_tokens:input,output_tokens:output,total_tokens:input+output,cached_input_tokens:0,cache_write_input_tokens:0,reasoning_output_tokens:0},model_context_window:1000},rate_limits:{}})
const spawnBegin=(ms,callId)=>event(ms,'collab_agent_spawn_begin',{call_id:callId,started_at_ms:base+ms,sender_thread_id:'root-1',prompt:'bounded',model:'fixture-model',reasoning_effort:'low'})
const spawnEnd=(ms,callId,threadId,role)=>event(ms,'collab_agent_spawn_end',{call_id:callId,completed_at_ms:base+ms,sender_thread_id:'root-1',new_thread_id:threadId,new_agent_nickname:'fixture',new_agent_role:role,prompt:'bounded',model:'fixture-model',reasoning_effort:'low',status:'running'})
const activity=(ms,kind,threadId,agentPath)=>event(ms,'sub_agent_activity',{event_id:'event-'+ms,occurred_at_ms:base+ms,agent_thread_id:threadId,agent_path:agentPath,kind})
const completed=reason=>({completed:reason??null})
const waitPair=(beginMs,endMs,callId,threadId,status)=>[event(beginMs,'collab_waiting_begin',{call_id:callId,started_at_ms:base+beginMs,sender_thread_id:'root-1',receiver_thread_ids:[threadId],receiver_agents:[{thread_id:threadId}]}),event(endMs,'collab_waiting_end',{call_id:callId,completed_at_ms:base+endMs,sender_thread_id:'root-1',agent_statuses:[{thread_id:threadId,status}],statuses:{[threadId]:status}})]
const resumePair=(beginMs,endMs,callId,threadId,role)=>settings.interactionInsteadOfResume?[event(beginMs,'collab_agent_interaction_begin',{call_id:callId,started_at_ms:base+beginMs,sender_thread_id:'root-1',receiver_thread_id:threadId,prompt:'continue'}),event(endMs,'collab_agent_interaction_end',{call_id:callId,completed_at_ms:base+endMs,sender_thread_id:'root-1',receiver_thread_id:threadId,receiver_agent_nickname:'fixture',receiver_agent_role:role,prompt:'continue',status:'running'})]:[event(beginMs,'collab_resume_begin',{call_id:callId,started_at_ms:base+beginMs,sender_thread_id:'root-1',receiver_thread_id:threadId,receiver_agent_nickname:'fixture',receiver_agent_role:role}),event(endMs,'collab_resume_end',{call_id:callId,completed_at_ms:base+endMs,sender_thread_id:'root-1',receiver_thread_id:threadId,receiver_agent_nickname:'fixture',receiver_agent_role:role,status:'running'})]
const resultHash=crypto.createHash('sha256').update(token+'\n').digest('hex')
const generation=fs.readdirSync(path.join(process.env.CODEX_HOME,'.autoprompt-private','bundles'))[0]
const privateSkill=path.join(process.env.CODEX_HOME,'.autoprompt-private','bundles',generation,'skills','autoprompt','SKILL.md')
const observedSkill=settings.invalidPrivateSkill?path.join(process.env.CODEX_HOME,'skills','autoprompt','SKILL.md'):privateSkill
const skillText='<skills_instructions>\n## Skills\n### Available skills\n- autoprompt: Frozen private skill. (file: '+observedSkill+')\n</skills_instructions>'
const rootMeta=stamp(0,{type:'session_meta',payload:{id:'root-1',session_id:'root-1',...(settings.rootParentNull?{parent_thread_id:null}:{}),cli_version:settings.wrongVersion?'0.148.0':'0.149.0',source:'exec',selected_capability_roots:[]}})
const developerInput=ms=>stamp(ms,{type:'response_item',payload:{type:'message',role:'developer',content:[{type:'input_text',text:skillText}]}})
const rootContext=stamp(2,{type:'turn_context',payload:{turn_id:'root-turn',sandbox_policy:{type:'workspace-write'},user_instructions:skillText}})
const workerPath='/root/conformance-worker',checkerPath='/root/conformance-checker',diagnosticPath='/root/conformance-diagnostic'
const rootRows=[rootMeta,developerInput(1),rootContext,start(3,'root-turn'),spawnBegin(10,'spawn-worker'),activity(11,'started','worker-thread',workerPath),spawnEnd(12,'spawn-worker','worker-thread',roles[0]),...waitPair(36,40,'wait-worker-1','worker-thread',settings.legacyCompletedString?'completed':completed()),...resumePair(50,52,'resume-worker','worker-thread',roles[0]),...waitPair(71,75,'wait-worker-2','worker-thread',completed('worker done')),spawnBegin(80,'spawn-checker'),activity(81,'started','checker-thread',checkerPath),spawnEnd(82,'spawn-checker','checker-thread',roles[1]),...waitPair(101,105,'wait-checker','checker-thread',completed())]
if(roles[2]){rootRows.push(spawnBegin(110,'spawn-diagnostic'),activity(111,'started','diagnostic-thread',diagnosticPath),spawnEnd(112,'spawn-diagnostic','diagnostic-thread',roles[2]));if(!settings.missingInterruptCall){rootRows.push(stamp(113,{type:'response_item',payload:{type:'function_call',namespace:'collaboration',name:'interrupt_agent',call_id:'interrupt-diagnostic',arguments:JSON.stringify({target:settings.wrongInterruptTarget?'worker-thread':'diagnostic-thread'})}}),stamp(114,{type:'response_item',payload:{type:'function_call_output',call_id:'interrupt-diagnostic',output:JSON.stringify({previous_status:settings.failedInterrupt?'completed':'running'})}}))}if(!settings.missingInterrupted)rootRows.push(activity(115,'interrupted','diagnostic-thread',diagnosticPath));rootRows.push(...waitPair(116,118,'wait-diagnostic','diagnostic-thread',settings.failedInterrupt?'running':'interrupted'))}
rootRows.push(usage(125,100,50),complete(130,'root-turn','ROOT_COMPLETE'))
if(settings.nullOrdering){const row=rootRows.find(row=>row.payload?.type==='collab_resume_end');row.timestamp='invalid';row.payload.completed_at_ms=null}
const childMeta=(ms,id,agentPath,role)=>stamp(ms,{type:'session_meta',payload:{id,session_id:id,...(settings.missingParent&&id==='worker-thread'?{}:{parent_thread_id:'root-1'}),agent_path:agentPath,agent_role:role,cli_version:settings.wrongVersion?'0.148.0':'0.149.0',selected_capability_roots:[],source:{subagent:{thread_spawn:{parent_thread_id:'root-1',depth:1,agent_nickname:'fixture',agent_path:agentPath,agent_role:role}}}}})
const childContext=(ms,id,policy)=>stamp(ms,{type:'turn_context',payload:{turn_id:id,sandbox_policy:{type:policy},user_instructions:skillText}})
const workerFirst=JSON.stringify({schemaVersion:'codex-conformance-worker.v1',phase:'initial',changedPaths:['conformance-result.txt'],resultSha256:resultHash})
const workerSecond=JSON.stringify({schemaVersion:'codex-conformance-worker.v1',phase:'resumed',sameContext:true,resultSha256:resultHash})
const checkerReport=JSON.stringify({schemaVersion:'codex-conformance-checker.v1',verdict:'PASS',checkedSha256:resultHash,readOnly:!settings.checkerWritable})
const patchContent=settings.fakePatchContent?'TAMPERED\n':token+'\n'
const patchChange=settings.legacyFileChangeShape?{add:{content:patchContent}}:{type:'add',content:patchContent}
const resultFile=path.join(target,'conformance-result.txt'),patchChanges={[resultFile]:patchChange}
const workerRows=[childMeta(13,'worker-thread',workerPath,roles[0]),...(settings.skillOnlyInRoot?[]:[developerInput(14)]),childContext(14,'worker-first','workspace-write'),start(15,'worker-first'),event(20,'patch_apply_begin',{turn_id:'worker-first',call_id:'patch-1',changes:patchChanges}),event(25,'patch_apply_end',{turn_id:'worker-first',call_id:'patch-1',changes:patchChanges,status:'completed',stdout:'',stderr:'',success:true}),usage(30,4,6),complete(35,'worker-first',workerFirst),stamp(49,{type:'inter_agent_communication_metadata',payload:{trigger_turn:true}}),childContext(54,'worker-resume','workspace-write'),start(55,'worker-resume'),usage(65,settings.nonMonotonicUsage?3:7,settings.nonMonotonicUsage?5:13),complete(70,'worker-resume',workerSecond)]
const exactCheckCommand='node conformance-sha256.cjs conformance-result.txt'
let checkerCommand=settings.rawCommandArray?['node','conformance-sha256.cjs','conformance-result.txt']:[process.env.ComSpec,'/c',exactCheckCommand]
if(settings.wrongCheckerShell)checkerCommand=[process.execPath,'/c',exactCheckCommand]
if(settings.extraCheckerFlag)checkerCommand=[process.env.ComSpec,'/d','/c',exactCheckCommand]
if(settings.changedCheckerCommand)checkerCommand=[process.env.ComSpec,'/c',exactCheckCommand+' && echo injected']
const checkerRows=[childMeta(83,'checker-thread',checkerPath,roles[1]),...(settings.skillOnlyInRoot?[]:[developerInput(84)]),childContext(84,'checker-turn',settings.checkerWritable?'workspace-write':'read-only'),start(85,'checker-turn'),event(88,'exec_command_begin',{turn_id:'checker-turn',call_id:'check-hash',command:checkerCommand,cwd:target}),event(92,'exec_command_end',{turn_id:'checker-turn',call_id:'check-hash',command:checkerCommand,cwd:target,stdout:(settings.fakeCheckerHash?'0'.repeat(64):resultHash)+'\n',stderr:'',aggregated_output:(settings.fakeCheckerHash?'0'.repeat(64):resultHash)+'\n',exit_code:0,status:'completed'}),usage(95,settings.childOverflow?15000:2,settings.childOverflow?6000:8),complete(100,'checker-turn',checkerReport)]
const sessionFiles=[['root.jsonl',rootRows],['worker.jsonl',workerRows],['checker.jsonl',checkerRows]]
for(let index=0;index<(settings.extraSessions||0);index++){const id='extra-'+index,agentPath='/root/extra-'+index;sessionFiles.push([id+'.jsonl',[childMeta(116+index,id,agentPath,roles[0]),childContext(117+index,id+'-turn','workspace-write'),start(118+index,id+'-turn'),usage(119+index,1,1),complete(120+index,id+'-turn','EXTRA')]])}
const observe=phase=>{const run=cp.spawnSync(process.execPath,[path.join(target,'conformance-discovery-probe.cjs'),phase],{cwd:target,encoding:'utf8'});return settings.discoveryTextOnly?{type:'agent.message',text:run.stdout}:{type:'item.completed',item:{type:'command_execution',command:'node conformance-discovery-probe.cjs '+phase,aggregated_output:run.stdout,exit_code:run.status}}}
const topology=()=>{const run=cp.spawnSync(process.execPath,[path.join(target,'conformance-topology-probe.cjs')],{cwd:target,encoding:'utf8'});return settings.topologyTextOnly?{type:'agent.message',text:run.stdout}:{type:'item.completed',item:{type:'command_execution',command:'node conformance-topology-probe.cjs',aggregated_output:run.stdout,exit_code:run.status}}}
const observedDuring=observe('isolated-during')
cp.spawnSync(process.execPath,[path.join(target,'conformance-check.cjs')],{cwd:target})
fs.writeFileSync(path.join(target,'conformance-result.txt'),token+'\n')
cp.spawnSync(process.execPath,[path.join(target,'conformance-check.cjs')],{cwd:target})
if(typed){const sessionDir=path.join(process.env.CODEX_HOME,'sessions');fs.mkdirSync(sessionDir,{recursive:true});for(const [name,rows] of sessionFiles)fs.writeFileSync(path.join(sessionDir,name),rows.map(row=>JSON.stringify(row)).join('\n')+'\n')}
const rows=typed?[observedDuring,topology(),settings.missingUsage?{type:'turn.completed'}:{type:'turn.completed',usage:{input_tokens:100,output_tokens:50,...(settings.explicitStdoutTotal?{total_tokens:150}:{})}}]:[{type:'agent.message',text:mission,thread_id:'same-id'},{type:'turn.completed',thread_id:'same-id',usage:{total_tokens:10}}]
for(const row of rows)process.stdout.write(JSON.stringify(row)+'\n')
`
  write(file, source.trimStart().replace('__SETTINGS__', JSON.stringify(fixture))
    .replace('__TYPED__', JSON.stringify(typed)), 0o700)
  return file
}

function materializer(mutateProvider = null) {
  return async layout => {
    const canonical = canonicalCodexInputs().manifest
    const generation = canonical.payloadGeneration
    const logicalRoles = ['ap-independent-checker', 'ap-worker']
    const logicalToPhysicalProviderRole = Object.fromEntries(logicalRoles.map(role =>
      [role, canonical.logicalToPhysicalProviderRole[role]]))
    const checker = logicalToPhysicalProviderRole['ap-independent-checker']
    const worker = logicalToPhysicalProviderRole['ap-worker']
    const manifest = {
      provider: canonical.provider, payloadGeneration: generation,
      payloadDigest: canonical.payloadDigest,
      logicalRoles,
      logicalToPhysicalProviderRole,
      physicalRoles: Object.values(logicalToPhysicalProviderRole).sort(),
    }
    write(path.join(layout.artifact, 'agents', 'manifests', 'codex-runtime.json'),
      `${JSON.stringify(manifest, null, 2)}\n`)
    const providers = JSON.parse(fs.readFileSync(path.join(ROOT, 'agents', 'contracts', 'providers.json'), 'utf8'))
    const codexProvider = providers.providers.find(provider => provider.id === 'codex')
    if (typeof mutateProvider === 'function') mutateProvider(codexProvider)
    write(path.join(layout.artifact, 'agents', 'contracts', 'providers.json'),
      `${JSON.stringify(providers, null, 2)}\n`)
    write(path.join(layout.artifact, 'scripts', 'install', 'codex-discovery-shim.md'), 'explicit-only shim\n')
    const ambient = path.join(layout.codexHome, 'skills', 'autoprompt', 'SKILL.md')
    write(ambient, 'explicit-only shim\n')
    const skillRoot = path.join(layout.activationHome, '.autoprompt-private', 'bundles', generation,
      'skills', 'autoprompt')
    const agentsRoot = path.join(skillRoot, 'agents-runtime')
    write(path.join(layout.activationHome, 'skills', 'autoprompt', 'SKILL.md'), 'explicit-only shim\n')
    write(path.join(skillRoot, 'SKILL.md'), 'private skill\n')
    write(path.join(skillRoot, 'workflow', 'phase-budget.js'), [
      "'use strict'",
      "class RolePolicy{validate(){const error=new Error('fixture denied edge');error.code='ROLE_POLICY_DENIED';throw error}}",
      'module.exports={RolePolicy}',
      '',
    ].join('\n'))
    write(path.join(agentsRoot, `${worker}.toml`), 'sandbox_mode = "workspace-write"\n')
    write(path.join(agentsRoot, `${checker}.toml`), 'sandbox_mode = "read-only"\n')
    const profilePath = path.join(layout.activationHome, 'autoprompt.config.toml')
    write(profilePath, '[agents]\n')
    write(path.join(layout.activationHome, 'config.toml'), '[[skills.config]]\n')
    return { installed: { agentsRoot, manifest, profilePath, skillRoot } }
  }
}

function identityProvider() {
  const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'agents', 'contracts', 'providers.json'), 'utf8'))
  const provider = registry.providers.find(candidate => candidate.id === 'codex')
  return {
    runtimeIdentityHash: IDENTITY_HASH,
    canonicalJson: JSON.stringify({ runtimeIdentityHash: IDENTITY_HASH }),
    identity: {
      codexConfigureSha256: 'b'.repeat(64),
      providerAdmissionSha256: runtimeIdentity.codexProviderAdmissionSha256(provider),
      providerContractCoreSha256: runtimeIdentity.providerContractCoreSha256(registry),
    },
  }
}

test('dry-run is non-mutating and registry overrides fail before staging', () => {
  assert.deepEqual(Object.keys(harness.dryRunPlan({ environment: {} })).sort(), [
    'fixtureOnly', 'maxRealModelProcessInvocations', 'productionLaunchCalled',
    'productionPrepareCalled', 'result', 'schemaVersion', 'sourceMutation', 'temporaryPaths',
  ])
  assert.throws(() => harness.parseArguments(['--registry', 'fixture.json']),
    /registry overrides are forbidden/)
  assert.throws(() => harness.rejectRegistryOverrides({ AUTOPROMPT_MODEL_REGISTRY: 'x' }),
    /registry overrides are forbidden/)
})

test('bounded Windows helpers reject hung taskkill and failed process-table probes', () => {
  const calls = []
  assert.throws(() => harness.killProcessTree({ pid: 4242 }, {
    platform: 'win32', helperTimeoutMs: 17,
    spawnSyncImpl(command, argv, options) {
      calls.push({ command, argv, options })
      return { error: Object.assign(new Error('hung'), { code: 'ETIMEDOUT' }),
        signal: 'SIGTERM', status: null }
    },
  }), error => error.code === 'PROCESS_TREE_KILL_FAILED' &&
    error.details.timedOut === true && error.details.timeoutMs === 17)
  assert.equal(calls[0].command, 'taskkill.exe')
  assert.equal(calls[0].options.timeout, 17)

  assert.throws(() => harness.processTable({
    platform: 'win32', helperTimeoutMs: 19,
    spawnSyncImpl(command, argv, options) {
      calls.push({ command, argv, options })
      return { error: null, signal: null, status: 5, stdout: '' }
    },
  }), error => error.code === 'PROCESS_AUDIT_UNAVAILABLE' &&
    error.details.status === 5 && error.details.timeoutMs === 19)
  assert.equal(calls[1].command, 'powershell.exe')
  assert.equal(calls[1].options.timeout, 19)
})

test('Windows owner SID and icacls helpers reject timeout and failure with checked status', () => {
  const calls = []
  assert.throws(() => harness.enforceOwnerOnlyWindowsAcl('C:\\fixture\\auth.json', {
    helperTimeoutMs: 23,
    spawnSyncImpl(command, argv, options) {
      calls.push({ command, argv, options })
      return { error: Object.assign(new Error('hung SID'), { code: 'ETIMEDOUT' }),
        signal: 'SIGTERM', status: null, stdout: '' }
    },
  }), error => error.code === 'AUTH_ACL_FAILED' && error.details.step === 'owner-sid' &&
    error.details.timedOut === true && error.details.timeoutMs === 23)
  assert.equal(calls[0].command, 'powershell.exe')
  assert.equal(calls[0].options.timeout, 23)

  calls.length = 0
  assert.throws(() => harness.enforceOwnerOnlyWindowsAcl('C:\\fixture\\auth.json', {
    helperTimeoutMs: 27,
    spawnSyncImpl() {
      return { error: null, signal: null, status: 5, stdout: '' }
    },
  }), error => error.code === 'AUTH_ACL_FAILED' && error.details.step === 'owner-sid' &&
    error.details.status === 5 && error.details.timeoutMs === 27)

  assert.throws(() => harness.enforceOwnerOnlyWindowsAcl('C:\\fixture\\auth.json', {
    helperTimeoutMs: 29,
    spawnSyncImpl(command, argv, options) {
      calls.push({ command, argv, options })
      if (command === 'powershell.exe') {
        return { error: null, signal: null, status: 0, stdout: 'S-1-5-21-42\n' }
      }
      return { error: null, signal: null, status: 5, stdout: '', stderr: 'denied' }
    },
  }), error => error.code === 'AUTH_ACL_FAILED' && error.details.step === 'owner-acl' &&
    error.details.status === 5 && error.details.timeoutMs === 29)
  assert.equal(calls[1].command, 'icacls.exe')
  assert.equal(calls[1].options.timeout, 29)

  assert.throws(() => harness.enforceOwnerOnlyWindowsAcl('C:\\fixture\\auth.json', {
    helperTimeoutMs: 31,
    spawnSyncImpl(command) {
      if (command === 'powershell.exe') {
        return { error: null, signal: null, status: 0, stdout: 'S-1-5-21-42\n' }
      }
      return { error: Object.assign(new Error('hung ACL'), { code: 'ETIMEDOUT' }),
        signal: 'SIGTERM', status: null }
    },
  }), error => error.code === 'AUTH_ACL_FAILED' && error.details.step === 'owner-acl' &&
    error.details.timedOut === true && error.details.timeoutMs === 31)
})

test('timed-out child that never closes is verified, escalated, and rejected with residual PIDs',
  async () => {
    const child = fakeSpawnedChild(5100)
    const alive = new Set([5100, 5101])
    const hardKills = []
    const started = Date.now()
    await assert.rejects(harness.runBoundedCommand(['fixture-command'], {
      spawnImpl: () => child,
      descendantPidsImpl: () => [5101],
      pidExistsImpl: pid => alive.has(pid),
      killProcessTreeImpl: () => true,
      killPidImpl(pid, signal) {
        hardKills.push([pid, signal])
        if (pid === 5100) alive.delete(pid)
      },
      timeoutMs: 10, killVerifyMs: 5, settlementTimeoutMs: 30, processPollMs: 1_000,
    }), error => {
      assert.equal(error.code, 'COMMAND_SETTLEMENT_TIMEOUT')
      assert.equal(error.details.escalationAttempted, true)
      assert.deepEqual(error.details.residualPids, [5101])
      return true
    })
    assert.deepEqual(hardKills, [[5100, 'SIGKILL'], [5101, 'SIGKILL']])
    assert.ok(Date.now() - started < 500)
  })

test('timed-out child cleanup resolves when tree termination closes it without residual PIDs',
  async () => {
    const child = fakeSpawnedChild(5200)
    const alive = new Set([5200])
    const result = await harness.runBoundedCommand(['fixture-command'], {
      spawnImpl: () => child,
      descendantPidsImpl: () => [],
      pidExistsImpl: pid => alive.has(pid),
      killProcessTreeImpl() {
        alive.delete(5200)
        setImmediate(() => child.emit('close', null, 'SIGKILL'))
        return true
      },
      killPidImpl() { assert.fail('clean tree termination must not escalate') },
      timeoutMs: 10, killVerifyMs: 20, settlementTimeoutMs: 40, processPollMs: 1_000,
    })
    assert.equal(result.timedOut, true)
    assert.equal(result.killAttempted, true)
    assert.equal(result.termination.escalationAttempted, false)
    assert.deepEqual(result.residualPids, [])
  })

test('late close after settlement is inert and final close sampling does not re-enter policy',
  async () => {
    const child = fakeSpawnedChild(5300)
    let policyPolls = 0
    let treeKills = 0
    const promise = harness.runBoundedCommand(['fixture-command'], {
      spawnImpl: () => child,
      descendantPidsImpl: () => [],
      pidExistsImpl: () => true,
      killProcessTreeImpl() { treeKills += 1; return true },
      killPidImpl() {},
      policyPollGuard() { policyPolls += 1; return true },
      timeoutMs: 10, killVerifyMs: 5, settlementTimeoutMs: 25, processPollMs: 1_000,
    })
    await assert.rejects(promise, error => error.code === 'COMMAND_SETTLEMENT_TIMEOUT' &&
      error.details.residualPids.includes(5300))
    const stateAtSettlement = { policyPolls, treeKills }
    child.emit('close', null, 'SIGKILL')
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual({ policyPolls, treeKills }, stateAtSettlement)
  })

test('normal close cleans observed descendants and final sampling cannot restart termination',
  async () => {
    const child = fakeSpawnedChild(5400)
    const alive = new Set([5400, 5401])
    let policyPolls = 0
    let treeKills = 0
    const hardKills = []
    const promise = harness.runBoundedCommand(['fixture-command'], {
      spawnImpl: () => child,
      descendantPidsImpl: () => [5401],
      pidExistsImpl: pid => alive.has(pid),
      killProcessTreeImpl() { treeKills += 1; return true },
      killPidImpl(pid, signal) { hardKills.push([pid, signal]); alive.delete(pid) },
      policyPollGuard() { policyPolls += 1; return true },
      timeoutMs: 100, processPollMs: 1_000,
    })
    alive.delete(5400)
    child.emit('close', 0, null)
    const result = await promise
    assert.equal(policyPolls, 1)
    assert.equal(treeKills, 0)
    assert.deepEqual(hardKills, [[5401, 'SIGKILL']])
    assert.deepEqual(result.residualPids, [])
  })

test('canonical Codex claims require only available mission roles and omit unknown cancellation', () => {
  const { manifest, provider } = canonicalCodexInputs()
  const requirements = harness.deriveMissionRequirements(provider.capabilities)
  assert.deepEqual(requirements.requiredLogicalRoles,
    ['ap-independent-checker', 'ap-worker'])
  assert.equal(requirements.cancellationRequired, false)
  const roles = harness.resolveRequiredProviderRoles(manifest, requirements)
  assert.deepEqual(Object.keys(roles).sort(), requirements.requiredLogicalRoles)
  assert.equal(Object.values(roles).every(role => typeof role === 'string' && role.length > 0), true)
  const mission = harness.missionText('AUTOPROMPT_CONFORMANCE_FIXTURE', roles, requirements)
  assert.doesNotMatch(mission, /undefined/)
  assert.doesNotMatch(mission, /interrupt that exact child/)
})

test('a claimed capability with a missing required role is refused without emitting undefined', () => {
  const { manifest, provider } = canonicalCodexInputs()
  const requirements = harness.deriveMissionRequirements({
    ...provider.capabilities,
    cancellation: 'supported',
  })
  assert.equal(requirements.cancellationRequired, true)
  assert.throws(() => harness.resolveRequiredProviderRoles(manifest, requirements), error => {
    assert.equal(error.code, 'REQUIRED_PROVIDER_ROLE_MISSING')
    assert.doesNotMatch(error.message, /undefined/)
    assert.doesNotMatch(harness.cliFailureLine(error), /exact private role undefined/)
    return true
  })
})

test('missing required role is refused before any provider CLI launch', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-live-role-prelaunch-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const marker = path.join(root, 'provider-launched.txt')
  await assert.rejects(harness.runConformance({
    mode: 'fake-cli', fakeCli: fakeCli(root, true, { invocationMarker: marker }), tempRoot: root,
    materializeCandidate: materializer(provider => { provider.capabilities.cancellation = 'supported' }),
    identityProvider, sourceIdentityProvider: identityProvider, environment: {}, timeoutMs: 20_000,
  }), error => {
    assert.equal(error.code, 'REQUIRED_PROVIDER_ROLE_MISSING')
    assert.doesNotMatch(error.message, /undefined/)
    return true
  })
  assert.equal(fs.existsSync(marker), false)
})

test('process ownership passes on process-tree cleanup while optional cancellation is NO_RESULT', () => {
  const { provider } = canonicalCodexInputs()
  const proofs = harness.scoreCapabilityProofs({
    providerCapabilities: provider.capabilities,
    isolationResult: 'PASS',
    privateSkillRootResult: 'PASS',
    topologyEnforcementResult: 'PASS',
    ownershipResult: 'PASS',
    residualPids: [],
    timedOut: false,
    cancellationObserved: false,
  })
  assert.equal(proofs.processOwnership, 'PASS')
  assert.equal(proofs.cancellation, 'NO_RESULT')
})

test('fake CLI proves isolated typed DIRECT conformance and preserves raw evidence after cleanup', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-live-conformance-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const result = await harness.runConformance({
    mode: 'fake-cli', fakeCli: fakeCli(root), tempRoot: root,
    materializeCandidate: materializer(), identityProvider, sourceIdentityProvider: identityProvider,
    environment: {}, timeoutMs: 20_000,
  })
  assert.equal(result.envelope.result, 'FAIL', JSON.stringify(result.envelope.evidence, null, 2))
  assert.equal(result.envelope.fixtureOnly, true)
  assert.equal(result.envelope.runtimeIdentityHash, IDENTITY_HASH)
  assert.deepEqual(Object.keys(result.envelope).sort(), [
    'evidence', 'fixtureOnly', 'result', 'runtimeIdentityHash', 'schemaVersion',
  ])
  assert.equal(result.envelope.evidence.canarySchema, 'codex-live-canary.v1')
  assert.equal(result.envelope.evidence.canaryResult, 'FAIL')
  assert.equal(result.envelope.evidence.providerAdmission.preCanaryPolicyExact, true)
  assert.equal(result.envelope.evidence.providerAdmission.identityBindingExact, true)
  assert.equal(result.envelope.evidence.providerAdmission.capabilityProofs.processOwnership, 'FAIL')
  assert.equal(result.envelope.evidence.delegation.sameContextResume, true)
  assert.equal(result.envelope.evidence.delegation.checkerIndependent, true)
  assert.equal(result.envelope.evidence.discovery.activationRevoked, true)
  assert.equal(result.envelope.evidence.discovery.localCrossCheck.ordinaryAfter.privateAgentCount, 0)
  assert.equal(result.envelope.evidence.discovery.activationRevoked, true)
  assert.equal(result.envelope.evidence.changedPathAudit.result, 'PASS')
  assert.equal(result.envelope.evidence.cleanup.runRootRemoved, true)
  assert.equal(result.envelope.evidence.transcript.stdoutBase64, undefined)
  assert.equal(result.envelope.evidence.transcript.providerSessionFiles.length, 3)
  assert.equal(result.envelope.evidence.transcript.providerSessionFiles.every(file =>
    typeof file.path === 'string' && Number.isSafeInteger(file.bytes) &&
    /^[a-f0-9]{64}$/.test(file.sha256) && file.base64 === undefined), true)
  assert.deepEqual(result.envelope.evidence.execution.nativeCliInvocations.map(row => row.classification), [
    'NON_MODEL_VERSION', 'NON_MODEL_HELP', 'PAID_MODEL_ROOT',
  ])
  assert.equal(result.envelope.evidence.execution.usage.accountingComplete, true)
  assert.equal(result.activationNonce, Buffer.from(result.fileSha256, 'hex').toString('base64url'))
})

test('prompt role names and repeated arbitrary IDs cannot satisfy typed delegation evidence', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-live-conformance-adversary-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const result = await harness.runConformance({
    mode: 'fake-cli', fakeCli: fakeCli(root, false), tempRoot: root,
    materializeCandidate: materializer(), identityProvider, sourceIdentityProvider: identityProvider,
    environment: {}, timeoutMs: 20_000,
  })
  assert.equal(result.envelope.result, 'FAIL')
  assert.equal(result.envelope.evidence.delegation.result, 'NO_RESULT')
})

test('missing provider usage cannot be coerced to zero', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-live-conformance-no-usage-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const result = await harness.runConformance({
    mode: 'fake-cli', fakeCli: fakeCli(root, true, { missingUsage: true }), tempRoot: root,
    materializeCandidate: materializer(), identityProvider, sourceIdentityProvider: identityProvider,
    environment: {}, timeoutMs: 20_000,
  })
  assert.equal(result.envelope.result, 'FAIL')
  assert.equal(result.envelope.evidence.execution.usage.accountingComplete, false)
  assert.equal(result.envelope.evidence.execution.usage.totalTokens, null)
})

test('isolated profile binds every real Codex role to its installed private file', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-live-private-profile-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const activationHome = path.join(root, 'activation-home')
  const agentsRoot = path.join(activationHome, '.autoprompt-private', 'bundles',
    'codex-v2.0.0-fixture', 'skills', 'autoprompt', 'agents-runtime')
  const profilePath = path.join(activationHome, 'autoprompt.config.toml')
  const manifest = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'agents', 'manifests', 'codex-runtime.json'), 'utf8'))
  for (const physicalRole of manifest.physicalRoles) {
    write(path.join(agentsRoot, `${physicalRole}.toml`), 'sandbox_mode = "read-only"\n')
  }
  const profile = harness.renderIsolatedProfile(profilePath, agentsRoot, manifest)
  const bindings = [...profile.matchAll(/^config_file = "([^"]+)"$/gm)].map(match => match[1])
  assert.equal(bindings.length, 32)
  assert.equal(bindings.length, manifest.physicalRoles.length)
  for (const binding of bindings) {
    const resolved = path.resolve(path.dirname(profilePath), ...binding.split('/'))
    assert.equal(harness.isWithin(agentsRoot, resolved), true)
    assert.equal(fs.statSync(resolved).isFile(), true)
  }

  fs.unlinkSync(path.join(agentsRoot, `${manifest.physicalRoles[0]}.toml`))
  assert.throws(() => harness.renderIsolatedProfile(profilePath, agentsRoot, manifest),
    /private agent configuration is unavailable/)
  write(path.join(root, 'escape.toml'), 'sandbox_mode = "read-only"\n')
  assert.throws(() => harness.privateAgentConfigPath(
    profilePath, agentsRoot, path.join('..', '..', '..', 'escape.toml')), /escapes the private agents root/)
  assert.throws(() => harness.privateAgentConfigPath(
    profilePath, path.join(root, '..', 'foreign'), 'missing.toml'),
  /private agents must be descendants|private agent configuration is unavailable/)
})

test('Codex 0.149 usage derives absent totals and refuses incomplete mixed duplicate or overflow rows', () => {
  assert.deepEqual(harness.normalizeTokenUsage({ input_tokens: 100, output_tokens: 50 }), {
    inputTokens: 100, outputTokens: 50, totalTokens: 150,
  })
  assert.throws(() => harness.normalizeTokenUsage({ input_tokens: 100 }),
    /token accounting is incomplete/)
  assert.throws(() => harness.normalizeTokenUsage({
    input_tokens: 100, output_tokens: 50, total_tokens: 151,
  }), /token accounting total is inconsistent/)

  const accepted = harness.createTranscriptPolicyGuard({
    maximumLaunches: 6, maximumTurns: 6, maximumTokens: 20_000,
  })
  assert.equal(accepted.accept(JSON.stringify({
    type: 'turn.completed', usage: { input_tokens: 12_000, output_tokens: 2_000 },
  })), true)
  assert.equal(accepted.accept(JSON.stringify({
    type: 'turn.completed', usage: { input_tokens: 12_000, output_tokens: 2_000 },
  })), false)

  for (const usage of [
    { input_tokens: 1 },
    { input_tokens: 100, output_tokens: 50, total_tokens: 151 },
    { input_tokens: 19_500, output_tokens: 501 },
  ]) {
    const guard = harness.createTranscriptPolicyGuard({
      maximumLaunches: 6, maximumTurns: 6, maximumTokens: 20_000,
    })
    assert.equal(guard.accept(JSON.stringify({ type: 'turn.completed', usage })), false)
  }
})

test('Codex 0.149 root may omit parent while child ancestry and cumulative usage remain strict', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-live-v149-session-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const home = path.join(root, 'home')
  const sessions = path.join(home, 'sessions')
  const stamp = (offset, row) => ({
    timestamp: new Date(Date.parse('2026-08-24T00:00:00.000Z') + offset).toISOString(), ...row,
  })
  const event = (offset, type, payload = {}) => stamp(offset, {
    type: 'event_msg', payload: { type, ...payload },
  })
  const cumulative = (offset, input, output, includeTotal = true) => event(offset, 'token_count', {
    info: { total_token_usage: {
      input_tokens: input, output_tokens: output,
      ...(includeTotal ? { total_tokens: input + output } : {}),
    } },
  })
  const rootRows = [
    stamp(0, { type: 'session_meta', payload: {
      id: 'root-1', session_id: 'root-1', cli_version: '0.149.0', source: 'exec',
      selected_capability_roots: [],
    } }),
    event(1, 'task_started', { turn_id: 'root-turn' }),
    cumulative(2, 8, 2, false),
    cumulative(3, 8, 2, false),
    event(4, 'task_complete', { turn_id: 'root-turn' }),
  ]
  write(path.join(sessions, 'root.jsonl'), `${rootRows.map(JSON.stringify).join('\n')}\n`)
  const exact = harness.readProviderSessionBundle(home)
  assert.equal(exact.schemaCompatible, true)
  assert.equal(exact.sessionUsageComplete, true)
  assert.deepEqual(exact.sessionUsageTotals, [{
    sessionId: 'root-1', inputTokens: 8, outputTokens: 2, totalTokens: 10,
  }])

  const childRows = [
    stamp(5, { type: 'session_meta', payload: {
      id: 'child-1', session_id: 'child-1', cli_version: '0.149.0',
      agent_path: '/root/child', agent_role: 'worker', selected_capability_roots: [],
      source: { subagent: { thread_spawn: { parent_thread_id: 'root-1' } } },
    } }),
    event(6, 'task_started', { turn_id: 'child-turn' }),
    cumulative(7, 4, 1),
    event(8, 'task_complete', { turn_id: 'child-turn' }),
  ]
  write(path.join(sessions, 'child.jsonl'), `${childRows.map(JSON.stringify).join('\n')}\n`)
  assert.equal(harness.readProviderSessionBundle(home).schemaCompatible, false)

  fs.unlinkSync(path.join(sessions, 'child.jsonl'))
  const rollback = [...rootRows.slice(0, 3), cumulative(3, 7, 1), rootRows.at(-1)]
  write(path.join(sessions, 'root.jsonl'), `${rollback.map(JSON.stringify).join('\n')}\n`)
  const rejected = harness.readProviderSessionBundle(home)
  assert.equal(rejected.sessionUsageComplete, false)
  assert.equal(rejected.schemaCompatible, false)
})

test('out-of-turn and incomplete Codex token events poison accounting before a stale low total can pass', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-live-v149-token-poison-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const home = path.join(root, 'home')
  const sessionFile = path.join(home, 'sessions', 'root.jsonl')
  const base = Date.parse('2026-08-24T01:00:00.000Z')
  const stamp = (offset, row) => ({ timestamp: new Date(base + offset).toISOString(), ...row })
  const event = (offset, type, payload = {}) => stamp(offset, {
    type: 'event_msg', payload: { type, ...payload },
  })
  const meta = stamp(0, { type: 'session_meta', payload: {
    id: 'root-poison', session_id: 'root-poison', cli_version: '0.149.0', source: 'exec',
    selected_capability_roots: [],
  } })
  const start = event(10, 'task_started', { turn_id: 'turn-1' })
  const low = event(20, 'token_count', { info: { total_token_usage: {
    input_tokens: 8, output_tokens: 2, total_tokens: 10,
  } } })
  const terminal = event(30, 'task_complete', { turn_id: 'turn-1' })
  const high = offset => event(offset, 'token_count', { info: { total_token_usage: {
    input_tokens: 50_000, output_tokens: 1, total_tokens: 50_001,
  } } })
  const cases = [
    ['pre-turn', [meta, high(5), start, low, terminal]],
    ['post-terminal', [meta, start, low, terminal, high(40)]],
    ['missing-info', [meta, start, event(15, 'token_count'), low, terminal]],
    ['missing-input', [meta, start, event(15, 'token_count', {
      info: { total_token_usage: { output_tokens: 2, total_tokens: 2 } },
    }), low, terminal]],
    ['missing-output', [meta, start, event(15, 'token_count', {
      info: { total_token_usage: { input_tokens: 8, total_tokens: 8 } },
    }), low, terminal]],
  ]
  for (const [label, rows] of cases) {
    write(sessionFile, `${rows.map(JSON.stringify).join('\n')}\n`)
    const bundle = harness.readProviderSessionBundle(home)
    assert.equal(bundle.tokenSchemaValid, false, label)
    assert.equal(bundle.schemaCompatible, false, label)
    assert.equal(bundle.sessionUsageComplete, false, label)
    assert.deepEqual(bundle.sessionUsageTotals, [], label)
    assert.equal(harness.liveProviderLimits([], bundle, {
      maximumLaunches: 6, maximumTurns: 6, maximumTokens: 20_000,
    }).within, false, label)
  }
})

test('discovery marker text without a provider command result is refused', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-live-conformance-fake-discovery-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const result = await harness.runConformance({
    mode: 'fake-cli', fakeCli: fakeCli(root, true, { discoveryTextOnly: true }), tempRoot: root,
    materializeCandidate: materializer(), identityProvider, sourceIdentityProvider: identityProvider,
    environment: {}, timeoutMs: 20_000,
  })
  assert.equal(result.envelope.result, 'FAIL')
  assert.equal(result.envelope.evidence.discovery.result, 'FAIL')
})

test('send_message cannot impersonate a terminal-child followup resume', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-live-conformance-fake-resume-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const result = await harness.runConformance({
    mode: 'fake-cli', fakeCli: fakeCli(root, true, { interactionInsteadOfResume: true }), tempRoot: root,
    materializeCandidate: materializer(), identityProvider, sourceIdentityProvider: identityProvider,
    environment: {}, timeoutMs: 20_000,
  })
  assert.equal(result.envelope.result, 'FAIL')
  assert.equal(result.envelope.evidence.delegation.sameContextResume, false)
})

test('checker spawn without a completed read-only bound verdict is refused', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-live-conformance-fake-checker-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const result = await harness.runConformance({
    mode: 'fake-cli', fakeCli: fakeCli(root, true, { checkerWritable: true }), tempRoot: root,
    materializeCandidate: materializer(), identityProvider, sourceIdentityProvider: identityProvider,
    environment: {}, timeoutMs: 20_000,
  })
  assert.equal(result.envelope.result, 'FAIL')
  assert.equal(result.envelope.evidence.delegation.result, 'NO_RESULT')
})

test('run-tree credential audit excludes the auth input identity and rejects any copied secret', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-live-conformance-auth-audit-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const auth = path.join(root, 'activation-home', 'auth.json')
  const leaked = path.join(root, 'activation-home', 'sessions', 'leak.jsonl')
  const authBytes = Buffer.from(JSON.stringify({ access_token: 'secret-fixture-value' }))
  write(auth, authBytes)
  write(leaked, 'secret-fixture-value')
  assert.throws(() => harness.auditRunTree(root, authBytes, [auth]), /credential material appeared/)
  fs.unlinkSync(leaked)
  const audit = harness.auditRunTree(root, authBytes, [auth])
  assert.equal(audit.allowedCredentialCount, 1)
  assert.equal(JSON.stringify(audit).includes('auth.json'), false)
  assert.equal(JSON.stringify(audit).includes('secret-fixture-value'), false)

  const catalog = path.join(root, 'activation-home', 'cache', 'remote_plugin_catalog', 'catalog.json')
  const metadataAuth = Buffer.from(JSON.stringify({
    auth_mode: 'chatgpt', tokens: { access_token: 'actual-secret-fixture-value' },
  }))
  write(auth, metadataAuth)
  write(catalog, JSON.stringify({ required_auth_mode: 'chatgpt' }))
  assert.doesNotThrow(() => harness.auditRunTree(root, metadataAuth, [auth]),
    'common authentication-mode metadata is not credential material')
  write(catalog, JSON.stringify({ copied: 'actual-secret-fixture-value' }))
  assert.throws(() => harness.auditRunTree(root, metadataAuth, [auth]),
    /credential material appeared/)
})

test('credential audit matches only exact sensitive schema leaves and reports sanitized real encodings', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-live-credential-encodings-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const auth = path.join(root, 'activation-home', 'auth.json')
  const secret = 'sensitive/value-with+symbols-123456'
  const authBytes = Buffer.from(JSON.stringify({
    auth_mode: 'chatgpt',
    last_refresh: '2026-08-23T00:00:00.000Z',
    OPENAI_API_KEY: null,
    tokens: { access_token: secret, refresh_token: 'refresh-secret-value-1234',
      id_token: 'identity-secret-value-1234', account_id: 'account-id-value-1234' },
  }))
  write(auth, authBytes)
  const variants = [
    ['raw', secret],
    ['base64', Buffer.from(secret).toString('base64')],
    ['base64url', Buffer.from(secret).toString('base64url')],
    ['hex', Buffer.from(secret).toString('hex')],
  ]
  for (const [encoding, value] of variants) {
    const destination = path.join(root, 'activation-home', 'cache', `${encoding}.json`)
    write(destination, JSON.stringify({ copied: value }))
    let error
    assert.throws(() => harness.auditRunTree(root, authBytes, [auth]), thrown => {
      error = thrown
      return true
    })
    assert.equal(error.code, 'AUTH_EVIDENCE_LEAK')
    const [match] = error.details.credentialMatches
    assert.equal(match.credentialClass, 'ACCESS_TOKEN')
    assert.equal(match.encoding, encoding)
    const relative = `activation-home/cache/${encoding}.json`
    assert.equal(match.destinationCategory, 'ACTIVATION_HOME')
    assert.equal(match.destinationPathLength, relative.length)
    assert.equal(match.destinationPathSha256,
      crypto.createHash('sha256').update(relative).digest('hex'))
    assert.equal(match.matchLocation, 'CONTENT')
    assert.equal(match.sourceLength, secret.length)
    assert.equal(match.sourceSha256, crypto.createHash('sha256').update(secret).digest('hex'))
    assert.equal(JSON.stringify(match).includes(secret), false)
    fs.unlinkSync(destination)
  }
  write(path.join(root, 'activation-home', 'cache', 'catalog.json'),
    JSON.stringify({ auth_mode: 'chatgpt', keyword: 'chatgpt' }))
  assert.doesNotThrow(() => harness.auditRunTree(root, authBytes, [auth]))
})

test('credential-bearing path encodings are rejected without persisting a raw path or secret', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-live-credential-paths-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const secret = 'credential-path-value-123456789'
  const authBytes = Buffer.from(JSON.stringify({ tokens: {
    access_token: secret,
    refresh_token: 'refresh-path-value-123456',
    id_token: 'identity-path-value-123456',
    account_id: 'account-path-value-123456',
  } }))
  const variants = [
    ['raw', secret],
    ['base64', Buffer.from(secret).toString('base64')],
    ['base64url', Buffer.from(secret).toString('base64url')],
    ['hex', Buffer.from(secret).toString('hex')],
  ]
  const readAll = directory => {
    const values = []
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name)
      if (entry.isDirectory()) values.push(...readAll(child))
      else values.push(fs.readFileSync(child, 'utf8'))
    }
    return values.join('\n')
  }
  for (const [encoding, value] of variants) {
    const caseRoot = path.join(base, encoding)
    const runRoot = path.join(caseRoot, 'run')
    const auth = path.join(runRoot, 'activation-home', 'auth.json')
    const leakedPath = path.join(runRoot, 'activation-home', 'cache', `${value}.json`)
    write(auth, authBytes)
    write(leakedPath, '{}')
    let error
    assert.throws(() => harness.auditRunTree(runRoot, authBytes, [auth]), thrown => {
      error = thrown
      return thrown.code === 'AUTH_EVIDENCE_LEAK'
    })
    const [match] = error.details.credentialMatches
    assert.equal(match.encoding, encoding)
    assert.equal(match.matchLocation, 'PATH')
    assert.equal(match.destinationCategory, 'ACTIVATION_HOME')
    assert.equal(match.destinationPathSha256,
      crypto.createHash('sha256').update(path.relative(runRoot, leakedPath).replaceAll('\\', '/')).digest('hex'))
    assert.equal(Object.hasOwn(match, 'destinationRelativePath'), false)
    assert.equal(JSON.stringify(match).includes(value), false)

    const auditRoot = path.join(caseRoot, 'audit')
    const journal = harness.createSecureAuditJournal(auditRoot)
    const cleanup = { runRootRemoved: false, launchedPids: [], residualPids: [], persistenceErrors: [] }
    const cleanupRecord = harness.writeSecureAuditCleanup(auditRoot, cleanup, journal)
    const noResult = harness.persistUnsignedNoResult(auditRoot, {
      error, missionRun: null, usage: null, accountingReason: 'PAID_MODEL_NOT_LAUNCHED',
      cleanup, cleanupRecord,
    }, journal)
    assert.equal(noResult.canonicalJson.includes(secret), false)
    assert.equal(noResult.canonicalJson.includes(value), false)
    const persisted = readAll(auditRoot)
    assert.equal(persisted.includes(secret), false)
    assert.equal(persisted.includes(value), false)
    fs.rmSync(path.dirname(leakedPath), { recursive: true, force: true })
    write(path.join(runRoot, 'activation-home', 'cache', 'safe.json'), '{}')
    const inventory = harness.auditRunTree(runRoot, authBytes, [auth])
    assert.equal(JSON.stringify(inventory).includes(secret), false)
    assert.equal(JSON.stringify(inventory).includes(value), false)
  }
})

test('provider-session input path encodings never reach raw audit names or metadata', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-live-provider-paths-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const secret = 'provider-session-secret-~~~~123456789'
  const authBytes = Buffer.from(JSON.stringify({ tokens: {
    access_token: secret,
    refresh_token: 'refresh-provider-value-123456',
    id_token: 'identity-provider-value-123456',
    account_id: 'account-provider-value-123456',
  } }))
  const variants = [
    ['raw', secret],
    ['base64', Buffer.from(secret).toString('base64')],
    ['base64url', Buffer.from(secret).toString('base64url')],
    ['hex', Buffer.from(secret).toString('hex')],
  ]
  const treeText = root => {
    const rows = []
    const walk = (directory, relative = '') => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name
        const child = path.join(directory, entry.name)
        rows.push(childRelative)
        if (entry.isDirectory()) walk(child, childRelative)
        else rows.push(fs.readFileSync(child, 'utf8'))
      }
    }
    walk(root)
    return rows.join('\n')
  }
  for (const [encoding, value] of variants) {
    const auditRoot = path.join(base, encoding)
    const journal = harness.createSecureAuditJournal(auditRoot)
    const providerBytes = Buffer.from('{"type":"session_meta","payload":{"id":"safe"}}\n')
    const inputs = harness.unsignedAuditInputs({}, { files: [{
      path: `${value}.jsonl`, bytes: providerBytes.length,
      sha256: harness.sha256(providerBytes), base64: providerBytes.toString('base64'),
    }] }, null, null)
    let error
    assert.throws(() => harness.assertNoCredentialLeak(authBytes, inputs), thrown => {
      error = thrown
      return thrown.code === 'AUTH_EVIDENCE_LEAK'
    })
    assert.equal(error.details.credentialMatches[0].matchLocation, 'PATH')
    assert.equal(error.details.credentialMatches[0].encoding, encoding)
    const accounting = harness.writeUnsignedAccounting(auditRoot, {
      deadlineMs: 240_000,
      missionRun: { durationMs: 10, exitCode: 0, policyTerminated: false, timedOut: false,
        residualPids: [], ownership: { result: 'PASS' }, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) },
      usage: { accountingComplete: true, providerLaunchCount: 1,
        providerTurnCount: 1, totalTokens: 10 }, inputs,
      modelProcessInvocations: 1,
    }, journal)
    const cleanup = { runRootRemoved: true, launchedPids: [], residualPids: [], persistenceErrors: [] }
    const cleanupRecord = harness.writeSecureAuditCleanup(auditRoot, cleanup, journal)
    const noResult = harness.persistUnsignedNoResult(auditRoot, {
      error, accounting, raw: null, missionRun: {},
      usage: { accountingComplete: true, providerLaunchCount: 1,
        providerTurnCount: 1, totalTokens: 10 }, cleanup, cleanupRecord,
    }, journal)
    assert.equal(fs.existsSync(path.join(auditRoot, 'raw')), false)
    const accountingJson = JSON.parse(fs.readFileSync(accounting.file, 'utf8'))
    assert.equal(accountingJson.rawFiles[0].sourceCategory, 'RUN_TREE_FILE')
    assert.equal(accountingJson.rawFiles[0].sourcePathLength, `provider/${value}.jsonl`.length)
    assert.equal(accountingJson.rawFiles[0].sourcePathSha256,
      harness.sha256(`provider/${value}.jsonl`))
    assert.equal(accountingJson.rawFiles[0].path, undefined)
    const persisted = treeText(auditRoot)
    assert.equal(persisted.includes(secret), false)
    assert.equal(persisted.includes(value), false)
    assert.equal(noResult.canonicalJson.includes(secret), false)
    assert.equal(noResult.canonicalJson.includes(value), false)
  }
})

test('provider-session parser and integrity errors never echo credential-bearing paths', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-live-provider-errors-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const secret = 'provider-error-secret-~~~~123456789'
  const variants = [
    ['raw', secret],
    ['base64', Buffer.from(secret).toString('base64')],
    ['base64url', Buffer.from(secret).toString('base64url')],
    ['hex', Buffer.from(secret).toString('hex')],
  ]
  const readAudit = root => {
    const rows = []
    const walk = (directory, relative = '') => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name
        const child = path.join(directory, entry.name)
        rows.push(childRelative)
        if (entry.isDirectory()) walk(child, childRelative)
        else rows.push(fs.readFileSync(child, 'utf8'))
      }
    }
    walk(root)
    return rows.join('\n')
  }
  for (const [encoding, value] of variants) {
    const cases = [
      ['malformed', home => {
        write(path.join(home, 'sessions', `${value}.jsonl`), '{not-json\n')
        return () => harness.readProviderSessionBundle(home)
      }],
      ['oversize', home => {
        write(path.join(home, 'sessions', `${value}.jsonl`), '12345')
        return () => harness.readProviderSessionBundle(home, { maximumFileBytes: 4 })
      }],
      ['hash-mismatch', () => {
        const bytes = Buffer.from('{}\n')
        return () => harness.unsignedAuditInputs({}, { files: [{
          path: `${value}.jsonl`, bytes: bytes.length, sha256: '0'.repeat(64),
          base64: bytes.toString('base64'),
        }] }, null, null)
      }],
    ]
    for (const [failureKind, arrange] of cases) {
      const caseRoot = path.join(base, encoding, failureKind)
      const home = path.join(caseRoot, 'home')
      fs.mkdirSync(home, { recursive: true })
      const invoke = arrange(home)
      let error
      assert.throws(invoke, thrown => {
        error = thrown
        return /^PROVIDER_SESSION_/.test(thrown.code)
      })
      const observableError = `${error.message}\n${harness.cliFailureLine(error)}\n${JSON.stringify(error.details)}`
      assert.equal(observableError.includes(secret), false)
      assert.equal(observableError.includes(value), false)
      assert.equal(error.details.providerSessionPath.category, 'PROVIDER_SESSION')
      assert.equal(error.details.providerSessionPath.pathLength, `${value}.jsonl`.length)
      assert.equal(error.details.providerSessionPath.pathSha256,
        harness.sha256(`${value}.jsonl`))

      const auditRoot = path.join(caseRoot, 'audit')
      const journal = harness.createSecureAuditJournal(auditRoot)
      const cleanup = { runRootRemoved: true, launchedPids: [], residualPids: [], persistenceErrors: [] }
      const cleanupRecord = harness.writeSecureAuditCleanup(auditRoot, cleanup, journal)
      const noResult = harness.persistUnsignedNoResult(auditRoot, {
        error, missionRun: null, usage: null, accountingReason: 'PAID_MODEL_NOT_LAUNCHED',
        cleanup, cleanupRecord,
      }, journal)
      const persisted = readAudit(auditRoot)
      assert.equal(fs.existsSync(path.join(auditRoot, 'raw')), false)
      assert.equal(persisted.includes(secret), false)
      assert.equal(persisted.includes(value), false)
      assert.equal(noResult.canonicalJson.includes(secret), false)
      assert.equal(noResult.canonicalJson.includes(value), false)
    }
  }
})

test('filesystem boundary failures sanitize credential-named entries before OS errors escape', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-live-filesystem-errors-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const secret = 'provider-filesystem-secret-~~~~123456789'
  const variants = [
    ['raw', secret],
    ['base64', Buffer.from(secret).toString('base64')],
    ['base64url', Buffer.from(secret).toString('base64url')],
    ['hex', Buffer.from(secret).toString('hex')],
  ]
  const fsProxy = overrides => Object.assign(Object.create(fs), overrides)
  const throwing = (code, marker) => {
    const error = new Error(`raw operating-system error ${marker}`)
    error.code = code
    throw error
  }
  const auditText = root => {
    const rows = []
    const walk = (directory, relative = '') => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name
        const child = path.join(directory, entry.name)
        rows.push(childRelative)
        if (entry.isDirectory()) walk(child, childRelative)
        else rows.push(fs.readFileSync(child, 'utf8'))
      }
    }
    walk(root)
    return rows.join('\n')
  }
  for (const [encoding, value] of variants) {
    const entryName = `${value}.jsonl`
    const fakeEntry = kind => ({
      name: entryName,
      isSymbolicLink: () => kind === 'symlink',
      isDirectory: () => false,
      isFile: () => kind === 'file',
    })
    const cases = [
      ['symlink', () => harness.listFiles('unused', '', {
        category: 'PROVIDER_SESSION',
        fsImpl: fsProxy({ existsSync: () => true, readdirSync: () => [fakeEntry('symlink')] }),
      })],
      ['special', () => harness.listFiles('unused', '', {
        category: 'PROVIDER_SESSION',
        fsImpl: fsProxy({ existsSync: () => true, readdirSync: () => [fakeEntry('special')] }),
      })],
      ['readdir', home => harness.readProviderSessionBundle(home, {
        fsImpl: fsProxy({
          existsSync: () => true,
          readdirSync: () => throwing('EACCES', value),
        }),
      })],
      ['open', home => {
        write(path.join(home, 'sessions', entryName), '{}\n')
        return harness.readProviderSessionBundle(home, {
          fsImpl: fsProxy({ lstatSync: () => throwing('EACCES', value) }),
        })
      }],
      ['realpath-rotation', home => {
        write(path.join(home, 'sessions', entryName), '{}\n')
        const realpathFailure = () => throwing('ENOENT', value)
        realpathFailure.native = realpathFailure
        return harness.readProviderSessionBundle(home, {
          fsImpl: fsProxy({ realpathSync: realpathFailure }),
        })
      }],
      ['read-rotation', home => {
        write(path.join(home, 'sessions', entryName), '{}\n')
        return harness.readProviderSessionBundle(home, {
          fsImpl: fsProxy({ readFileSync: () => throwing('ENOENT', value) }),
        })
      }],
    ]
    for (const [failureKind, invokeCase] of cases) {
      const caseRoot = path.join(base, encoding, failureKind)
      const home = path.join(caseRoot, 'home')
      fs.mkdirSync(home, { recursive: true })
      let error
      assert.throws(() => invokeCase(home), thrown => {
        error = thrown
        return typeof thrown.code === 'string'
      })
      const observable = `${error.message}\n${harness.cliFailureLine(error)}\n${JSON.stringify(error.details)}`
      assert.equal(observable.includes(secret), false)
      assert.equal(observable.includes(value), false)
      const receipt = error.details.pathReceipt || error.details.providerSessionPath
      assert.ok(receipt)
      assert.equal(receipt.category, 'PROVIDER_SESSION')
      assert.match(receipt.pathSha256, /^[a-f0-9]{64}$/)

      const auditRoot = path.join(caseRoot, 'audit')
      const journal = harness.createSecureAuditJournal(auditRoot)
      const cleanup = { runRootRemoved: true, launchedPids: [], residualPids: [], persistenceErrors: [] }
      const cleanupRecord = harness.writeSecureAuditCleanup(auditRoot, cleanup, journal)
      const noResult = harness.persistUnsignedNoResult(auditRoot, {
        error, missionRun: null, usage: null, accountingReason: 'PAID_MODEL_NOT_LAUNCHED',
        cleanup, cleanupRecord,
      }, journal)
      const persisted = auditText(auditRoot)
      assert.equal(fs.existsSync(path.join(auditRoot, 'raw')), false)
      assert.equal(persisted.includes(secret), false)
      assert.equal(persisted.includes(value), false)
      assert.equal(noResult.canonicalJson.includes(secret), false)
      assert.equal(noResult.canonicalJson.includes(value), false)
    }
  }
})

test('unsigned audit journal preserves paid accounting and raw bytes before a later credential refusal', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-live-unsigned-journal-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const auditRoot = path.join(base, 'secure-audit')
  const runRoot = path.join(base, 'disposable-run')
  const auth = path.join(runRoot, 'activation-home', 'auth.json')
  const leak = path.join(runRoot, 'activation-home', 'cache', 'catalog.json')
  const secret = 'real-token-copy-remains-fatal-1234'
  const authBytes = Buffer.from(JSON.stringify({ tokens: {
    access_token: secret,
    refresh_token: 'refresh-value-123456',
    id_token: 'identity-value-123456',
    account_id: 'account-value-123456',
  } }))
  write(auth, authBytes)
  write(leak, JSON.stringify({ copied: secret }))
  const journal = harness.createSecureAuditJournal(auditRoot)
  const missionRun = {
    durationMs: 123, exitCode: 0, policyTerminated: false, timedOut: false,
    residualPids: [], ownership: { result: 'PASS' },
    stdout: Buffer.from('{"type":"turn.completed"}\n'), stderr: Buffer.from(''),
  }
  const providerBytes = Buffer.from('{"type":"session_meta"}\n')
  const inputs = harness.unsignedAuditInputs({ mission: missionRun }, { files: [{
    path: 'session.jsonl', bytes: providerBytes.length,
    sha256: harness.sha256(providerBytes), base64: providerBytes.toString('base64'),
  }] }, null, null)
  const accounting = harness.writeUnsignedAccounting(auditRoot, {
    deadlineMs: 240_000, missionRun, inputs,
    usage: { accountingComplete: true, providerLaunchCount: 4,
      providerTurnCount: 5, totalTokens: 4321 },
  }, journal)
  const raw = harness.preserveUnsignedRawAudit(auditRoot, inputs, journal)
  let credentialError
  assert.throws(() => harness.auditRunTree(runRoot, authBytes, [auth]), error => {
    credentialError = error
    return error.code === 'AUTH_EVIDENCE_LEAK'
  })
  const missionSourcePathSha = harness.sha256('mission/root.stdout.jsonl')
  const missionRaw = raw.files.find(file => file.sourcePathSha256 === missionSourcePathSha)
  assert.ok(missionRaw)
  assert.equal(fs.readFileSync(path.join(auditRoot, ...missionRaw.storagePath.split('/')), 'utf8'),
    missionRun.stdout.toString('utf8'))
  const accountingJson = JSON.parse(fs.readFileSync(accounting.file, 'utf8'))
  assert.equal(accountingJson.usage.totalTokens, 4321)
  assert.equal(accountingJson.rawFiles.every(file => file.path === undefined &&
    /^[a-f0-9]{64}$/.test(file.sourcePathSha256)), true)
  assert.equal(raw.fileCount, 3)
  const cleanup = { runRootRemoved: true, launchedPids: [4242], residualPids: [], persistenceErrors: [] }
  const cleanupRecord = harness.writeSecureAuditCleanup(auditRoot, cleanup, journal)
  const noResult = harness.persistUnsignedNoResult(auditRoot, {
    error: credentialError, missionRun,
    usage: { accountingComplete: true, providerLaunchCount: 4,
      providerTurnCount: 5, totalTokens: 4321 },
    accounting, raw, cleanup, cleanupRecord,
  }, journal)
  assert.equal(noResult.envelope.failure.credentialMatches[0].destinationCategory,
    'ACTIVATION_HOME')
  assert.equal(noResult.envelope.failure.credentialMatches[0].matchLocation, 'CONTENT')
  assert.equal(noResult.envelope.accounting.totalTokens, 4321)
  assert.equal(noResult.canonicalJson.includes(secret), false)
  assert.equal(fs.readdirSync(path.join(auditRoot, 'journal')).some(name => name.endsWith('.tmp')), false)
})

test('canonical unsigned NO_RESULT covers prelaunch post-paid and cleanup-failure accounting', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-live-no-result-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const prelaunch = harness.buildUnsignedNoResult({
    startedAt: '2026-08-23T00:00:00.000Z', endedAt: '2026-08-23T00:00:01.000Z',
    error: Object.assign(new Error('prelaunch fixture'), { code: 'PRELAUNCH_FIXTURE' }),
    missionRun: null, usage: null, accountingReason: 'PAID_MODEL_NOT_LAUNCHED',
    cleanup: { runRootRemoved: true, launchedPids: [], residualPids: [], persistenceErrors: [] },
  })
  assert.equal(prelaunch.envelope.result, 'NO_RESULT')
  assert.equal(prelaunch.envelope.signed, false)
  assert.equal(prelaunch.envelope.accounting.modelProcessInvocations, 0)
  assert.equal(prelaunch.envelope.accounting.totalTokens, null)
  assert.equal(prelaunch.envelope.accounting.reason, 'PAID_MODEL_NOT_LAUNCHED')

  const postPaid = harness.buildUnsignedNoResult({
    error: Object.assign(new Error('post-paid fixture'), { code: 'POST_PAID_FIXTURE' }),
    missionRun: {}, usage: { accountingComplete: true, providerLaunchCount: 4,
      providerTurnCount: 5, totalTokens: 4321 },
    cleanup: { runRootRemoved: false, launchedPids: [123], residualPids: [123],
      persistenceErrors: ['RUN_ROOT_REMOVE_EACCES'] },
  })
  assert.equal(postPaid.envelope.accounting.modelProcessInvocations, 1)
  assert.equal(postPaid.envelope.accounting.totalTokens, 4321)
  assert.equal(postPaid.envelope.accounting.reason, null)
  assert.equal(postPaid.envelope.cleanup.runRootRemoved, false)
  assert.deepEqual(postPaid.envelope.cleanup.residualPids, [123])

  const auditRoot = path.join(base, 'audit')
  const journal = harness.createSecureAuditJournal(auditRoot)
  const cleanup = { runRootRemoved: false, launchedPids: [123], residualPids: [123],
    persistenceErrors: ['RUN_ROOT_REMOVE_EACCES'] }
  const cleanupRecord = harness.writeSecureAuditCleanup(auditRoot, cleanup, journal)
  const persisted = harness.persistUnsignedNoResult(auditRoot, {
    error: Object.assign(new Error('cleanup fixture'), { code: 'CONFORMANCE_CLEANUP_FAILED' }),
    missionRun: {}, usage: { accountingComplete: false, providerLaunchCount: null,
      providerTurnCount: null, totalTokens: null }, cleanup, cleanupRecord,
  }, journal)
  assert.equal(fs.readFileSync(persisted.file, 'utf8'), persisted.canonicalJson)
  assert.equal(JSON.parse(fs.readFileSync(cleanupRecord.file, 'utf8')).residualPids[0], 123)
  assert.equal(fs.readdirSync(path.join(auditRoot, 'journal')).some(name => name.endsWith('.tmp')), false)
})

test('owner-safe audit initialization failure is caught before launch with canonical cleanup receipt', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-live-init-failure-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  let failure
  await assert.rejects(harness.runConformance({
    mode: 'live', tempRoot: base, auditRoot: base, environment: {},
    auditInitializationHook(stage) {
      assert.equal(stage, 'AFTER_OWNER_ACL')
      throw new harness.LiveConformanceError('AUDIT_JOURNAL_INIT_FIXTURE',
        'injected audit journal initialization failure')
    },
  }), error => {
    failure = error
    return error.code === 'AUDIT_JOURNAL_INIT_FIXTURE'
  })
  assert.match(failure.details.secureAuditRoot, /codex-live-secure-audit-/)
  const noResultFile = path.join(failure.details.secureAuditRoot, 'unsigned-no-result.json')
  const cleanupFile = path.join(failure.details.secureAuditRoot, 'cleanup.json')
  const accountingFile = path.join(failure.details.secureAuditRoot, 'unsigned-accounting.json')
  const noResultBytes = fs.readFileSync(noResultFile)
  const noResult = JSON.parse(noResultBytes)
  assert.equal(noResult.result, 'NO_RESULT')
  assert.equal(noResult.signed, false)
  assert.equal(noResult.accounting.modelProcessInvocations, 0)
  assert.equal(noResult.accounting.totalTokens, null)
  assert.equal(noResult.accounting.reason, 'PAID_MODEL_NOT_LAUNCHED')
  assert.equal(noResult.cleanup.runRootRemoved, true)
  assert.deepEqual(noResult.cleanup.residualPids, [])
  assert.equal(fs.readFileSync(noResultFile, 'utf8'), runtimeIdentity.stableJsonV1(noResult))
  assert.equal(JSON.parse(fs.readFileSync(cleanupFile, 'utf8')).launchedPidCount, 0)
  assert.equal(JSON.parse(fs.readFileSync(accountingFile, 'utf8')).modelProcessInvocations, 0)
  assert.equal(fs.readdirSync(base).some(name => name.startsWith('autoprompt-codex-conformance-')), false)
})

test('canonical evidence writer emits exact stable-json bytes and rejects newline tamper', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-live-conformance-canonical-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const result = harness.evidenceEnvelope({ result: 'PASS' }, IDENTITY_HASH, true)
  const file = path.join(root, 'evidence.json')
  const written = harness.writeCanonicalEvidence(file, result)
  assert.equal(fs.readFileSync(file, 'utf8'), result.canonicalJson)
  assert.equal(written.activationNonce, result.activationNonce)
  fs.appendFileSync(file, '\n')
  assert.throws(() => harness.verifyCanonicalEvidenceFile(file, result), /not exact stable-json-v1/)
})

test('documented stdout launch guard refuses a seventh root-or-child launch immediately', () => {
  const guard = harness.createTranscriptPolicyGuard({
    maximumLaunches: 6, maximumTurns: 6, maximumTokens: 20_000,
  })
  for (let index = 1; index <= 5; index += 1) {
    assert.equal(guard.accept(JSON.stringify({
      type: 'item.started', item: { type: 'mcp_tool_call', name: 'spawn_agent', id: `call-${index}` },
    })), true)
  }
  assert.equal(guard.accept(JSON.stringify({
    type: 'item.started', item: { type: 'mcp_tool_call', name: 'spawn_agent', id: 'call-6' },
  })), false)
})

test('production Windows Job path owns a real descendant before resume and drains helper plus job', {
  skip: process.platform !== 'win32',
  timeout: 30_000,
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-live-conformance-job-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const layout = harness.isolatedLayout(root)
  const env = Object.fromEntries(Object.entries({
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    ComSpec: process.env.ComSpec,
    PATH: process.env.PATH,
    PATHEXT: process.env.PATHEXT,
    TEMP: path.join(layout.runRoot, 'temp'),
    TMP: path.join(layout.runRoot, 'temp'),
  }).filter(([, value]) => typeof value === 'string'))
  fs.mkdirSync(env.TEMP, { recursive: true })
  const result = await harness.runWindowsJobCommand([
    process.execPath, '-e', "setTimeout(()=>process.stdout.write('owned\\n'),8000)",
  ], { layout, cwd: layout.target, env, timeoutMs: 20_000 })
  assert.equal(result.exitCode, 0, result.stderr.toString('utf8'))
  assert.equal(result.stdout.toString('utf8'), 'owned\n')
  assert.equal(result.ownership.result, 'PASS', JSON.stringify(result.ownership, null, 2))
  assert.equal(result.ownership.assignedBeforeResume, true)
  assert.equal(result.ownership.paidCodexObservedAsJobMember, true)
  assert.equal(result.ownership.zeroMembershipDrained, true)
  assert.equal(result.ownership.helperExited, true)
  assert.deepEqual(result.residualPids, [])
})

test('Windows Job child environment deduplicates PATH and rejects conflicting aliases before resume', {
  skip: process.platform !== 'win32', timeout: 90_000,
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-live-conformance-job-env-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const intendedPath = 'C:\\autoprompt-isolated-path'
  const baseEnvironment = Object.fromEntries(Object.entries({
    SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
    ComSpec: process.env.ComSpec, PATHEXT: process.env.PATHEXT,
    TEMP: path.join(root, 'temp'), TMP: path.join(root, 'temp'),
  }).filter(([, value]) => typeof value === 'string'))
  fs.mkdirSync(baseEnvironment.TEMP, { recursive: true })

  const acceptedLayout = harness.isolatedLayout(root)
  const accepted = await harness.runWindowsJobCommand([
    process.execPath, '-e', 'process.stdout.write(process.env.PATH);setTimeout(()=>{},1000)',
  ], {
    layout: acceptedLayout, cwd: acceptedLayout.target, timeoutMs: 60_000,
    env: { ...baseEnvironment, PATH: intendedPath, Path: intendedPath },
  })
  assert.equal(accepted.exitCode, 0)
  assert.equal(accepted.stdout.toString('utf8'), intendedPath)
  assert.equal(accepted.ownership.assignedBeforeResume, true)
  assert.equal(accepted.ownership.paidCodexObservedAsJobMember, true)
  assert.equal(accepted.ownership.zeroMembershipDrained, true)

  const rejectedLayout = harness.isolatedLayout(root)
  const marker = path.join(rejectedLayout.target, 'must-not-resume.txt')
  await assert.rejects(harness.runWindowsJobCommand([
    process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'resumed')`,
  ], {
    layout: rejectedLayout, cwd: rejectedLayout.target, timeoutMs: 15_000,
    env: { ...baseEnvironment, PATH: intendedPath, Path: 'C:\\ambient-escape' },
  }), /conflicting Windows child environment/i)
  assert.equal(fs.existsSync(marker), false)
})

async function runFixture(t, label, fixture) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `codex-live-conformance-${label}-`))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return harness.runConformance({
    mode: 'fake-cli', fakeCli: fakeCli(root, true, fixture), tempRoot: root,
    materializeCandidate: materializer(), identityProvider, sourceIdentityProvider: identityProvider,
    environment: {}, timeoutMs: 20_000,
  })
}

test('child token overflow and non-monotonic cumulative accounting are refused', async t => {
  const overflow = await runFixture(t, 'child-overflow', { childOverflow: true })
  assert.equal(overflow.envelope.result, 'FAIL')
  assert.ok(overflow.envelope.evidence.execution.usage.totalTokens > 20_000)

  const nonMonotonic = await runFixture(t, 'non-monotonic-usage', { nonMonotonicUsage: true })
  assert.equal(nonMonotonic.envelope.result, 'FAIL')
  assert.equal(nonMonotonic.envelope.evidence.execution.usage.accountingComplete, false)
})

test('provider session launch overflow is refused', async t => {
  const result = await runFixture(t, 'launch-overflow', { extraSessions: 4 })
  assert.equal(result.envelope.result, 'FAIL')
  assert.equal(result.envelope.evidence.execution.usage.providerLaunchCount, 7)
})

test('non-interrupted durable status and absent terminal activity are refused', async t => {
  const failed = await runFixture(t, 'failed-interrupt', { failedInterrupt: true })
  assert.equal(failed.envelope.result, 'FAIL')
  assert.equal(failed.envelope.evidence.delegation.cancellationObserved, false)

  const absent = await runFixture(t, 'missing-interrupt', { missingInterrupted: true })
  assert.equal(absent.envelope.result, 'FAIL')
  assert.equal(absent.envelope.evidence.delegation.cancellationObserved, false)
})

test('prompt topology text and non-provider private context cannot prove capabilities', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-live-conformance-topology-text-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const topologyText = await harness.runConformance({
    mode: 'fake-cli', fakeCli: fakeCli(root, true, { topologyTextOnly: true }), tempRoot: root,
    materializeCandidate: materializer(), identityProvider, sourceIdentityProvider: identityProvider,
    environment: {}, timeoutMs: 20_000,
  })
  assert.equal(topologyText.envelope.evidence.topology.result, 'FAIL')
  assert.equal(topologyText.envelope.result, 'FAIL')

  const privateContext = await runFixture(t, 'private-context', { invalidPrivateSkill: true })
  assert.equal(privateContext.envelope.result, 'FAIL')
  assert.equal(privateContext.envelope.evidence.discovery.providerEffectivePrivateSkill.result, 'NO_RESULT')
})

test('unknown provider session schema version is refused without inference', async t => {
  const result = await runFixture(t, 'unknown-schema-version', { wrongVersion: true })
  assert.equal(result.envelope.result, 'FAIL')
  assert.equal(result.envelope.evidence.execution.usage.accountingComplete, false)
  assert.equal(result.envelope.evidence.delegation.result, 'NO_RESULT')
  assert.equal(result.envelope.evidence.discovery.providerEffectivePrivateSkill.result, 'NO_RESULT')
})

test('official externally-tagged completed status is required', async t => {
  const result = await runFixture(t, 'legacy-completed-string', { legacyCompletedString: true })
  assert.equal(result.envelope.result, 'FAIL')
  assert.equal(result.envelope.evidence.delegation.result, 'NO_RESULT')
})

test('pre-canary provider policy and frozen admission hashes are mandatory', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-live-conformance-policy-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const result = await harness.runConformance({
    mode: 'fake-cli', fakeCli: fakeCli(root, true), tempRoot: root,
    materializeCandidate: materializer(provider => { provider.defaultAdmission = 'verified-only' }),
    identityProvider, sourceIdentityProvider: identityProvider, environment: {}, timeoutMs: 20_000,
  })
  assert.equal(result.envelope.result, 'FAIL')
  assert.equal(result.envelope.evidence.providerAdmission.preCanaryPolicyExact, false)
  assert.equal(result.envelope.evidence.providerAdmission.identityBindingExact, false)
})

test('diagnostic interrupted rows without an exact interrupt call and output are refused', async t => {
  const missing = await runFixture(t, 'missing-interrupt-call', { missingInterruptCall: true })
  assert.equal(missing.envelope.evidence.delegation.cancellationObserved, false)
  assert.equal(missing.envelope.evidence.delegation.result, 'NO_RESULT')
  const wrong = await runFixture(t, 'wrong-interrupt-target', { wrongInterruptTarget: true })
  assert.equal(wrong.envelope.evidence.delegation.cancellationObserved, false)
  assert.equal(wrong.envelope.evidence.delegation.result, 'NO_RESULT')
})

test('root-only or turn-context-only skills cannot prove child private skill injection', async t => {
  const result = await runFixture(t, 'root-only-skill', { skillOnlyInRoot: true })
  assert.equal(result.envelope.evidence.discovery.providerEffectivePrivateSkill.result, 'NO_RESULT')
  assert.equal(result.envelope.evidence.discovery.providerEffectivePrivateSkill.sessionBindings
    .filter(binding => binding.label !== 'root').every(binding => binding.valid === false), true)
})

test('self-reported hashes cannot replace worker patch and checker read causality', async t => {
  const patch = await runFixture(t, 'fake-patch-hash', { fakePatchContent: true })
  assert.equal(patch.envelope.evidence.delegation.editCausallyBoundToWorker, false)
  assert.equal(patch.envelope.evidence.delegation.result, 'NO_RESULT')
  const checker = await runFixture(t, 'fake-checker-hash', { fakeCheckerHash: true })
  assert.equal(checker.envelope.evidence.delegation.checkerReadCausallyBound, false)
  assert.equal(checker.envelope.evidence.delegation.result, 'NO_RESULT')
})

test('official tagged FileChange and shell-wrapped ExecCommand reject legacy inventions', async t => {
  const patch = await runFixture(t, 'legacy-file-change-shape', { legacyFileChangeShape: true })
  assert.equal(patch.envelope.evidence.delegation.editCausallyBoundToWorker, false)
  assert.equal(patch.envelope.evidence.delegation.result, 'NO_RESULT')
  const command = await runFixture(t, 'raw-command-array', { rawCommandArray: true })
  assert.equal(command.envelope.evidence.delegation.checkerReadCausallyBound, false)
  assert.equal(command.envelope.evidence.delegation.result, 'NO_RESULT')
})

test('checker shell binding rejects wrong identity extra flags and changed command payload', async t => {
  for (const [label, fixture] of [
    ['wrong-shell', { wrongCheckerShell: true }],
    ['extra-flag', { extraCheckerFlag: true }],
    ['changed-command', { changedCheckerCommand: true }],
  ]) {
    const result = await runFixture(t, label, fixture)
    assert.equal(result.envelope.evidence.delegation.checkerReadCausallyBound, false)
    assert.equal(result.envelope.evidence.delegation.result, 'NO_RESULT')
  }
})

test('missing child ancestry and null event ordering invalidate the complete session corpus', async t => {
  const orphan = await runFixture(t, 'missing-parent', { missingParent: true })
  assert.equal(orphan.envelope.evidence.execution.usage.accountingComplete, false)
  assert.equal(orphan.envelope.evidence.delegation.result, 'NO_RESULT')
  const unordered = await runFixture(t, 'null-ordering', { nullOrdering: true })
  assert.equal(unordered.envelope.evidence.execution.usage.accountingComplete, false)
  assert.equal(unordered.envelope.evidence.delegation.result, 'NO_RESULT')
})

test('Windows Job exceptional policy cleanup cancels and drains before rejection', {
  skip: process.platform !== 'win32', timeout: 30_000,
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-live-conformance-job-error-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const layout = harness.isolatedLayout(root)
  const seen = []
  const env = Object.fromEntries(Object.entries({
    SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
    ComSpec: process.env.ComSpec, PATH: process.env.PATH, PATHEXT: process.env.PATHEXT,
    TEMP: path.join(layout.runRoot, 'temp'), TMP: path.join(layout.runRoot, 'temp'),
  }).filter(([, value]) => typeof value === 'string'))
  fs.mkdirSync(env.TEMP, { recursive: true })
  await assert.rejects(harness.runWindowsJobCommand([
    process.execPath, '-e', 'setTimeout(()=>{},20000)',
  ], {
    layout, cwd: layout.target, env, timeoutMs: 25_000,
    onLaunchedPid: pid => seen.push(pid),
    policyPollGuard() { throw new Error('fixture policy guard failure') },
  }), /fixture policy guard failure/)
  assert.equal(seen.length >= 1, true)
  assert.equal(seen.every(pid => {
    try { process.kill(pid, 0); return false } catch { return true }
  }), true)
})

test('temporary candidate fixes release version before manifest hashing', {
  timeout: 45_000,
}, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-live-conformance-staging-order-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const layout = harness.isolatedLayout(root)
  harness.stageTemporaryCandidate(ROOT, layout, process.env)
  const destination = path.join(layout.activationHome, 'skills', 'autoprompt')
  const installed = childProcess.spawnSync(process.execPath, [
    'scripts/runtime-payload.cjs', '--install', 'codex', '--destination', destination,
  ], { cwd: layout.artifact, encoding: 'utf8', timeout: 30_000 })
  assert.equal(installed.status, 0, installed.stderr)

  const executableBytes = fs.readFileSync(process.execPath)
  const executable = {
    realpath: fs.realpathSync.native(process.execPath),
    platform: process.platform,
    arch: process.arch,
    basename: path.basename(process.execPath),
    sha256: crypto.createHash('sha256').update(executableBytes).digest('hex'),
    version: 'codex-cli 0.149.0',
  }
  const derive = candidateRoot => runtimeIdentity.deriveCodexRuntimeIdentity({
    runtimeManifestBytes: fs.readFileSync(path.join(candidateRoot, 'agents/manifests/codex-runtime.json')),
    providerRegistryBytes: fs.readFileSync(path.join(candidateRoot, 'agents/contracts/providers.json')),
    trustedKeyRingBytes: fs.readFileSync(path.join(candidateRoot, 'agents/contracts/codex-trusted-public-keys.json')),
    evidenceBytes: fs.readFileSync(path.join(candidateRoot, 'agents/contracts/codex-live-conformance-evidence.json')),
    codexConfigureBytes: fs.readFileSync(path.join(candidateRoot, 'scripts/codex-configure.cjs')),
    codexExecutable: executable,
  })
  assert.equal(derive(layout.source).runtimeIdentityHash, derive(layout.artifact).runtimeIdentityHash)

  const refused = childProcess.spawnSync(process.execPath, [
    'scripts/codex-artifact.cjs', '--check',
  ], { cwd: layout.source, encoding: 'utf8', timeout: 30_000 })
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /canonical-live-evidence-invalid|external-attestation-missing/)
  assert.doesNotMatch(refused.stderr, /source hash mismatch/)
})
