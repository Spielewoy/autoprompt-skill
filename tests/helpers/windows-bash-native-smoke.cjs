'use strict'
// Shared exact native assertions. Selection remains with each source-owned caller.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path')
const { ensureWindowsPrivateAcl }=require('../../agents/codex/workflow/safe-run-root.js')
const ipcFixture=path.resolve(__dirname,'../fixtures/windows-msys/bash-ipc.sh')
async function runNativeWindowsBashSmoke(t,{probeWindowsAppContainer,executeTool}) {
  const probe = await probeWindowsAppContainer()
  assert.equal(probe.supported, true, JSON.stringify(probe))
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'windows-bash-command-')))
  let preserve = false
  t.after(() => { if (!preserve) fs.rmSync(root, { recursive: true, force: true }) })
  ensureWindowsPrivateAcl(root)
  const targetPath = path.join(root, 'target'), scratchPath = path.join(root, 'scratch'), controlRoot = path.join(root, 'controller')
  for (const directory of [targetPath, scratchPath, controlRoot]) { fs.mkdirSync(directory); ensureWindowsPrivateAcl(directory) }
  const candidate = path.join(targetPath, 'candidate'), secret = path.join(controlRoot, 'secret')
  fs.writeFileSync(candidate, 'preserved'); fs.writeFileSync(secret, 'controller-only')
  const shellWitness = path.join(scratchPath, 'shell-witness')
  // usertemp maps /tmp to this worker's package TEMP, independently of controller scratch.
  const source = `const fs=require('node:fs'),assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os');const privateTemp=fs.realpathSync.native(os.tmpdir());assert.ok(path.isAbsolute(privateTemp));assert.equal(fs.readFileSync(path.join(privateTemp,'shell-witness-tmp'),'utf8'),'private-temp\\n');const fstab=path.resolve(path.dirname(process.execPath),'../../etc/fstab');assert.equal(fs.readFileSync(fstab,'utf8'),'none /tmp usertemp binary,posix=0,noacl 0 0\\n');assert.throws(()=>fs.appendFileSync(fstab,'forbidden'),error=>['EPERM','EACCES'].includes(error.code));assert.equal(fs.readFileSync(${JSON.stringify(shellWitness)},'utf8'),'shell-write\\n');fs.writeFileSync(${JSON.stringify(path.join(scratchPath, 'witness'))},'native-node');for(const attempt of [()=>fs.writeFileSync(${JSON.stringify(candidate)},'forbidden'),()=>fs.readFileSync(${JSON.stringify(secret)})])assert.throws(attempt,error=>['EPERM','EACCES'].includes(error.code));process.stdout.write('node-ok')`
  const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`
  const command = [`[[ -d /tmp ]] && printf 'private-temp\\n' > /tmp/shell-witness-tmp`, `set -- ${shellQuote(shellWitness)}`, fs.readFileSync(ipcFixture, 'utf8'),
    `printf 'bash-ok:'; node -e "eval(Buffer.from('${Buffer.from(source).toString('base64')}','base64').toString())"`].join('\n')
  const policy = { provider: 'claude', nestedDispatch: false, commandBoundary: true, externalWrites: false, readOnly: true, targetPath, scratchPath, readableRoots: [targetPath, scratchPath], writableRoots: [scratchPath] }
  let result
  try { result = await executeTool(policy, 'bash', { command, timeoutMs: 30000 }, { controlRoot }) } catch (error) {
    preserve = error.cleanupConfirmed === false || error.code === 'APPCONTAINER_CLEANUP_UNCONFIRMED' || Boolean(error.recovery && !error.recoveryResolved)
    if (preserve) t.diagnostic('Unconfirmed native cleanup; retained diagnostic root: ' + root)
    throw error
  }
  assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(result.output, 'bash-ok:node-ok')
  assert.equal(fs.readFileSync(path.join(scratchPath, 'witness'), 'utf8'), 'native-node')
  assert.equal(fs.readFileSync(candidate, 'utf8'), 'preserved')
}
module.exports={runNativeWindowsBashSmoke}
