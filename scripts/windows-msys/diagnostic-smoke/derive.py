"""Reproduce fixed diagnostic copies; never import these from production."""
from pathlib import Path
import hashlib,json,sys
ROOT=Path(__file__).resolve().parent

def once(text,old,new):
 assert text.count(old)==1,repr(old)
 return text.replace(old,new)

def derive():
 pins=json.loads((ROOT/'lineage.json').read_text());results={}
 for name in ['command','probe']:
  data=(ROOT/'original'/f'{name}.js.txt').read_bytes();assert hashlib.sha256(data).hexdigest()==pins['originalSha256'][name]
  text=data.decode()
  if name=='command':
   start=text.index('function windowsBashCandidates(');end=text.index('async function runWindowsAppContainerCommand(',start)
   text=text[:start]+"function resolveWindowsBash(options = {}) {\n  return require('./binding.cjs').select(options.diagnosticTuple, { bindBashRuntime, bindRuntimeFile })\n}\n"+text[end:]
   text=once(text,"    const expectedNodeHash = sha256(fs.readFileSync(process.execPath))","    const expectedNodeHash = sha256(fs.readFileSync(process.execPath))\n    require('node:assert/strict').equal(expectedNodeHash, options.diagnosticTuple.node.sha256, 'Diagnostic Node changed before copy')")
   text=once(text,'bindBashRuntime, windowsBashCandidates, resolveWindowsBash','bindBashRuntime, resolveWindowsBash')
   # Preserve the primary failure and owned recovery paths across secondary errors.
   text=once(text, 'privateScratch = null\n', 'privateScratch = null, runtimeCleanupUnknown = false, primaryError = null\n')
   text=once(text, """  } catch (error) {
    if (!lease && error.recovery) {
      recoveryPending = true
      const binding = { profileSid: error.recovery.profileSid, leaseId: error.recovery.leaseId }
      const unused = launcher.proveNotStarted(binding)
      await recoverWindowsAppContainerResources({ controlRoot, deploymentRoot: helperDeployment.root, journalPath: error.recovery.journalPath, verifyDrainEvidence: launcher.verifyDrainEvidence, evidence: unused })
      recoveryPending = false; released = true; error.recoveryResolved = true
    }
    if (lease && !evidence) {
      let unused
      try { unused = launcher.proveNotStarted({ profileSid: lease.profileSid, leaseId: lease.recovery.leaseId }) } catch {}
      if (unused) { await lease.release(unused); released = true }
    }
    if (lease && !released) error.recovery = Object.freeze({ ...lease.recovery, profileSid: lease.profileSid })
    throw error
  } finally {
    // Unconfirmed launches retain their exact request artifacts alongside the
    // resource journal. Recovery must prove process drain before revoking grants.
    if ((!lease && !recoveryPending) || released) {
      if (privateScratch) fs.rmSync(privateScratch, { recursive: true, force: true })
      fs.rmSync(runtimeRoot, { recursive: true, force: true })
      helperDeployment?.cleanup()
      try { fs.unlinkSync(cancellationPath) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
  }
}""", """  } catch (error) {
    primaryError = error
    runtimeCleanupUnknown = error.cleanupConfirmed === false
    try {
      if (!lease && error.recovery) {
        recoveryPending = true
        const binding = { profileSid: error.recovery.profileSid, leaseId: error.recovery.leaseId }
        const unused = launcher.proveNotStarted(binding)
        await recoverWindowsAppContainerResources({ controlRoot, deploymentRoot: helperDeployment.root, journalPath: error.recovery.journalPath, verifyDrainEvidence: launcher.verifyDrainEvidence, evidence: unused })
        recoveryPending = false; released = true; error.recoveryResolved = true
      }
      if (lease && !evidence) {
        let unused
        try { unused = launcher.proveNotStarted({ profileSid: lease.profileSid, leaseId: lease.recovery.leaseId }) } catch {}
        if (unused) { await lease.release(unused); released = true }
      }
    } catch (recoveryError) {
      // A secondary recovery failure must not erase the original lease or an
      // unknown-cleanup marker that tells the caller to retain its outer root.
      error.cleanupConfirmed = false
      error.recoveryFailureCode = String(recoveryError.code || 'recovery-failed').slice(0, 64)
      runtimeCleanupUnknown = true
    }
    if (lease && !released) error.recovery = Object.freeze({ ...lease.recovery, profileSid: lease.profileSid })
    throw error
  } finally {
    // Unconfirmed launches retain their exact request artifacts alongside the
    // resource journal. Recovery must prove process drain before revoking grants.
    if ((!lease && !recoveryPending) || released) {
      let cleanupFailure
      const cleanup = operation => {
        try { operation() } catch (error) { if (!cleanupFailure) cleanupFailure = error }
      }
      if (privateScratch) cleanup(() => fs.rmSync(privateScratch, { recursive: true, force: true }))
      if (!runtimeCleanupUnknown) cleanup(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }))
      cleanup(() => helperDeployment?.cleanup())
      cleanup(() => { try { fs.unlinkSync(cancellationPath) } catch (error) { if (error.code !== 'ENOENT') throw error } })
      if (cleanupFailure) {
        const error = primaryError || cleanupFailure
        error.cleanupConfirmed = false
        error.retainedControlRoot = controlRoot
        error.retainedRuntimeRoot = runtimeRoot
        error.cleanupCode = String(cleanupFailure.code || 'cleanup-failed').slice(0, 64)
        if (!primaryError) throw error
      }
    }
  }
}""")
  else:
   text=once(text,"const { runWindowsAppContainerCommand } = require('./windows-appcontainer-command.js')\n",'')
   text=once(text,'let cached\n','')
   text=once(text,'function runtimeKey() {','function runtimeKey(tupleIdentity) {')
   text=once(text,"fs.readFileSync(path.join(__dirname, name))","fs.readFileSync(name === 'windows-appcontainer-command.js' ? path.join(__dirname,'command.cjs') : name === 'windows-appcontainer-probe.js' ? __filename : path.join(__dirname,'../../../agents/codex/workflow',name))")
   text=once(text,'  hash.update(fs.readFileSync(process.execPath))','  hash.update(tupleIdentity)\n  hash.update(fs.readFileSync(process.execPath))')
   text=once(text,'async function probeWindowsAppContainer() {','async function probeWindowsAppContainer(runWindowsAppContainerCommand, tupleIdentity) {')
   text=once(text,'key = runtimeKey()','key = runtimeKey(tupleIdentity)')
   text=once(text,'  if (cached?.key === key) return cached.result\n','')
   text=once(text,'    cached = { key, result: supported }\n','')
   text=once(text,"    endpoints.push(await listen('127.0.0.1'), await listen('::1'))", "    endpoints.push(await listen('127.0.0.1'))\n    endpoints.push(await listen('::1'))")
   text=once(text,"probeFailure = null, phase = 'private-root'", "probeFailure = null, phase = 'private-root', primaryError = null")
   text=once(text,"  } catch (error) {\n    preserve =", "  } catch (error) {\n    primaryError = error\n    preserve =")
   text=once(text,"""    for (const endpoint of endpoints) endpoint.server.close()
    if (!preserve) fs.rmSync(base, { recursive: true, force: true })""", """    let cleanupFailure
    for (const endpoint of endpoints) { try { endpoint.server.close() } catch (error) { cleanupFailure ||= error } }
    if (!preserve && !cleanupFailure) { try { fs.rmSync(base, { recursive: true, force: true }) } catch (error) { cleanupFailure ||= error } }
    if (cleanupFailure) {
      const error = primaryError || cleanupFailure
      error.cleanupConfirmed = false
      error.recoveryRoot = base
      error.cleanupCode = String(cleanupFailure.code || 'cleanup-failed').slice(0, 64)
      throw error
    }""")
   text=once(text,"    preserve = error.code === 'APPCONTAINER_CLEANUP_UNCONFIRMED'","    preserve = error.cleanupConfirmed === false || error.code === 'APPCONTAINER_CLEANUP_UNCONFIRMED'")
   old="let gitDenied=false;try{fs.writeFileSync(path.join(f.target,'.git','guard'),'bad')}catch(e){gitDenied=['EACCES','EPERM'].includes(e.code)}need(gitDenied);"
   new="let gitDenied=false,gitOutcome='WRITE_SUCCEEDED';try{fs.writeFileSync(path.join(f.target,'.git','guard'),'bad')}catch(e){gitOutcome=/^[A-Z][A-Z0-9_]{0,39}$/.test(String(e.code))?e.code:'OTHER_ERRNO';gitDenied=['EACCES','EPERM'].includes(e.code)}if(!gitDenied){const error=Error('PROBE');error.code='GIT_'+gitOutcome;throw error};"
   text=once(text,old,new)
   marker="    if (result.status !== 'completed'"
   text=once(text,marker,"    try { probeFailure.gitGuard = fs.readFileSync(path.join(target, '.git', 'guard'), 'utf8') === 'controller git' ? 'UNCHANGED' : 'CHANGED' } catch { probeFailure.gitGuard = 'UNREADABLE' }\n"+marker)
  for sibling in ['safe-run-root.js','windows-appcontainer.js','windows-appcontainer-resources.js','windows-helper-deployment.js']:
   text=text.replace("require('./"+sibling+"')","require('../../../agents/codex/workflow/"+sibling+"')")
  results[name+'.cjs']="// Source-derived diagnostic only; regenerate with derive.py. No production selector.\n"+text
 return results
if __name__=='__main__':
 for name,text in derive().items():
  if '--check' in sys.argv:assert (ROOT/name).read_text()==text,name+' drift'
  else:(ROOT/name).write_text(text)
