#!/usr/bin/env node
'use strict'

const { MissionLock, processIdentityForPid } = require('../../../agents/codex/workflow/mission-lock.js')

const input = JSON.parse(process.env.AUTOPROMPT_LEASE_RACE_INPUT)
const processIdentity = processIdentityForPid(process.pid)
const lock = new MissionLock({
  leaseRoot: input.leaseRoot,
  processIdentityObserver: pid => pid === process.pid ? processIdentity : processIdentityForPid(pid),
})
const options = {
  targetPath: input.targetPath, ledgerPath: input.ledgerPath, runId: input.runId,
  activationId: input.activationId, missionHash: input.missionHash, nonce: input.nonce,
  generation: 1, pid: process.pid, processIdentity, token: input.token,
}
let capability
process.send({ type: 'READY', activationId: input.activationId })
let retries = 0
function acquire() {
  try { capability = lock.acquire(options); process.send({ type: 'ACQUIRED', activationId: input.activationId }) }
  catch (error) {
    if (error.code === 'LEASE_UNVERIFIABLE' && retries < 20) { retries += 1; setTimeout(acquire, 10); return }
    process.send({ type: 'REJECTED', activationId: input.activationId, code: error.code }); process.exit(0)
  }
}
process.on('message', message => {
  if (message === 'GO') acquire()
  else if (message === 'RELEASE' && capability) {
    lock.release(capability); process.exit(0)
  }
})
