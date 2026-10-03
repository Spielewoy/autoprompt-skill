'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const util = require('node:util');
const { spawnSync } = require('node:child_process');

const SOURCE = path.join(__dirname, 'coalition_probe.c');
const ROLES = ['root', 'fork-setsid-exec', 'posix-spawn-setsid'];
const MAX_OUTPUT = 64 * 1024;

function excerpt(value) {
  const text = String(value || '');
  return text.length <= MAX_OUTPUT ? text : text.slice(0, MAX_OUTPUT);
}

function errnoName(value) {
  if (!Number.isInteger(value) || value <= 0) return null;
  try { return util.getSystemErrorName(-value); } catch { return 'UNKNOWN'; }
}

function command(commandName, args, options = {}) {
  const result = spawnSync(commandName, args, {
    encoding: 'utf8',
    timeout: options.timeout || 30_000,
    maxBuffer: MAX_OUTPUT,
    ...options,
  });
  return {
    status: result.status,
    signal: result.signal,
    error: result.error ? {
      code: result.error.code || null,
      message: excerpt(result.error.message),
    } : null,
    stdout: excerpt(result.stdout),
    stderr: excerpt(result.stderr),
  };
}

function parseSingleJson(result, description) {
  if (result.status !== 0) {
    throw new Error(`${description} failed: ${JSON.stringify(result)}`);
  }
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) {
    throw new Error(`${description} returned unexpected output: ${JSON.stringify(result)}`);
  }
  return JSON.parse(lines[0]);
}

function parseProbeJson(result, description) {
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) {
    throw new Error(`${description} returned unexpected output: ${JSON.stringify(result)}`);
  }
  return { command: result, value: JSON.parse(lines[0]) };
}

function xml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function waitForRecords(stateDirectory, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const paths = ROLES.map((role) => path.join(stateDirectory, `${role}.json`));
    if (paths.every((recordPath) => fs.existsSync(recordPath))) {
      return Object.fromEntries(ROLES.map((role, index) => [
        role,
        JSON.parse(fs.readFileSync(paths[index], 'utf8')),
      ]));
    }
    sleep(100);
  }
  throw new Error(`timed out waiting for ${ROLES.join(', ')}`);
}

function waitForJson(recordPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(recordPath)) {
      return JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    }
    sleep(100);
  }
  throw new Error(`timed out waiting for ${path.basename(recordPath)}`);
}

function readAvailableRecords(stateDirectory) {
  return Object.fromEntries(ROLES.flatMap((role) => {
    const recordPath = path.join(stateDirectory, `${role}.json`);
    if (!fs.existsSync(recordPath)) return [];
    try {
      return [[role, JSON.parse(fs.readFileSync(recordPath, 'utf8'))]];
    } catch {
      return [];
    }
  }));
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

function censusCertifiesCompleteEnumeration(census) {
  return census && census.complete === true && census.listErrno === 0 &&
    census.sameUidCandidates > 0 && census.denied === 0 && census.otherErrors === 0;
}

function writeEvidence(evidence) {
  const encoded = `${JSON.stringify(evidence, null, 2)}\n`;
  if (process.env.AUTOPROMPT_DARWIN_COALITION_EVIDENCE) {
    fs.writeFileSync(process.env.AUTOPROMPT_DARWIN_COALITION_EVIDENCE, encoded, {
      mode: 0o600,
    });
  }
  return encoded;
}

function runProof() {
  if (process.platform !== 'darwin') {
    return { skipped: true, reason: 'darwin-only diagnostic' };
  }

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-coalition-proof-'));
  fs.chmodSync(temporaryRoot, 0o700);
  const stateDirectory = path.join(temporaryRoot, 'state');
  fs.mkdirSync(stateDirectory, { mode: 0o700 });
  const executable = path.join(temporaryRoot, 'coalition-probe');
  const label = `com.autoprompt.coalition-proof.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  const uid = process.getuid();
  const candidateDomains = [`gui/${uid}`, `user/${uid}`];
  let domain = null;
  const plistPath = path.join(temporaryRoot, `${label}.plist`);
  const stdoutPath = path.join(temporaryRoot, 'launchd.stdout.log');
  const stderrPath = path.join(temporaryRoot, 'launchd.stderr.log');
  let records = null;
  let bootstrap = null;
  let bootout = null;
  let evidence = null;
  let controllerProbe = null;
  let foreignAttempt = null;
  const domainProbes = Object.fromEntries(candidateDomains.map((candidate) => [
    candidate, command('launchctl', ['print', candidate], {
      stdio: ['ignore', 'ignore', 'pipe'],
    }),
  ]));
  const bootstrapAttempts = [];
  let launchdLog = null;

  const compile = command('cc', [
    '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', SOURCE, '-o', executable,
  ], { timeout: 60_000 });
  if (compile.status !== 0) {
    evidence = { skipped: false, phase: 'compile', compile };
    writeEvidence(evidence);
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    throw new Error(`coalition probe compilation failed: ${JSON.stringify(evidence)}`);
  }
  const executableRealpath = fs.realpathSync(executable);
  const executableBytes = fs.readFileSync(executableRealpath);
  const executableIdentity = {
    realpath: executableRealpath,
    sha256: crypto.createHash('sha256').update(executableBytes).digest('hex'),
    size: executableBytes.length,
    mode: fs.statSync(executableRealpath).mode & 0o777,
  };

  try {
    controllerProbe = parseProbeJson(
      command(executableRealpath, ['inspect', String(process.pid)]),
      'controller coalition query',
    );
    const controller = controllerProbe.value;
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key><array>
    <string>${xml(executableRealpath)}</string><string>root</string><string>${xml(stateDirectory)}</string>
    <string>${xml(controller.resourceCoalitionId)}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(stdoutPath)}</string>
  <key>StandardErrorPath</key><string>${xml(stderrPath)}</string>
</dict></plist>
`;
    fs.writeFileSync(plistPath, plist, { mode: 0o600 });
    const availableDomains = candidateDomains.filter(
      (candidate) => domainProbes[candidate].status === 0,
    );
    for (const candidate of availableDomains) {
      const result = command('launchctl', ['bootstrap', candidate, plistPath]);
      bootstrapAttempts.push({ domain: candidate, result });
      if (result.status === 0) {
        domain = candidate;
        bootstrap = result;
        break;
      }
    }
    if (domain === null) {
      launchdLog = command('/usr/bin/log', [
        'show', '--last', '2m', '--style', 'compact', '--predicate',
        `process == "launchd" AND eventMessage CONTAINS[c] "${label}"`,
      ]);
      throw new Error(`launchctl bootstrap failed: ${JSON.stringify({ domainProbes, bootstrapAttempts, launchdLog })}`);
    }
    records = waitForRecords(stateDirectory, 30_000);
    foreignAttempt = waitForJson(
      path.join(stateDirectory, 'foreign-attempt.json'), 30_000,
    );
    foreignAttempt.setterErrorName = errnoName(foreignAttempt.setterResult);
    foreignAttempt.spawnErrorName = errnoName(foreignAttempt.spawnResult);
    let foreignRecord = null;
    let foreignInspection = null;
    if (foreignAttempt.spawnedPid > 0) {
      foreignRecord = waitForJson(
        path.join(stateDirectory, 'foreign-coalition-attempt.json'), 30_000,
      );
      foreignInspection = parseProbeJson(
        command(executableRealpath, ['inspect', String(foreignAttempt.spawnedPid)]),
        'controller query for foreign coalition attempt',
      );
    }
    const inspectionProbes = Object.fromEntries(ROLES.map((role) => [
      role,
      parseProbeJson(
        command(executableRealpath, ['inspect', String(records[role].pid)]),
        `controller query for ${role}`,
      ),
    ]));
    const inspections = Object.fromEntries(ROLES.map((role) => [
      role, inspectionProbes[role].value,
    ]));
    const resourceId = records.root.resourceCoalitionId;
    const census = parseSingleJson(
      command(executableRealpath, ['census', resourceId]),
      'coalition census',
    );
    const expectedPids = ROLES.map((role) => records[role].pid).sort((a, b) => a - b);
    const matchingPids = [...(census.matchingPids || [])].sort((a, b) => a - b);
    const allQueriesAvailable = [controller, ...Object.values(inspections)]
      .every((item) => item.queryResult === 40 && item.queryErrno === 0);
    const descendantsInRootResourceCoalition = ROLES.every(
      (role) => inspections[role].resourceCoalitionId === resourceId,
    );
    const distinctFromController = controller.resourceCoalitionId !== resourceId;
    const censusContainsAllKnownMembers = expectedPids.every((pid) => matchingPids.includes(pid));
    const foreignCoalitionJoinOutcome = foreignAttempt.apiAvailable === false
      ? 'api-unavailable'
      : foreignAttempt.setterResult === 0 && ['EPERM', 'EACCES'].includes(errnoName(foreignAttempt.spawnResult))
        ? 'rejected'
        : foreignAttempt.setterResult === 0 && foreignAttempt.spawnResult === 0
          ? 'escaped' : 'inconclusive';
    const signalNumber = os.constants.signals;
    const signalTarget = records['posix-spawn-setsid'].pid;
    const staleAuditSignal = parseSingleJson(command(executableRealpath, [
      'audit-signal', String(signalTarget), String(signalNumber.SIGCONT), 'stale',
    ]), 'stale audit-token signal');
    const stopAuditSignal = parseSingleJson(command(executableRealpath, [
      'audit-signal', String(signalTarget), String(signalNumber.SIGSTOP), 'fresh',
    ]), 'bound audit-token stop');
    const continueAuditSignal = parseSingleJson(command(executableRealpath, [
      'audit-signal', String(signalTarget), String(signalNumber.SIGCONT), 'fresh',
    ]), 'bound audit-token continue');
    const rootKillAuditSignal = parseSingleJson(command(executableRealpath, [
      'audit-signal', String(records.root.pid), String(signalNumber.SIGKILL), 'fresh',
    ]), 'bound audit-token root kill');
    const rootDeathDeadline = Date.now() + 5_000;
    while (isAlive(records.root.pid) && Date.now() < rootDeathDeadline) sleep(50);
    const trustedRootKilled = !isAlive(records.root.pid);
    const postRootDeathCensus = parseSingleJson(
      command(executableRealpath, ['census', resourceId]),
      'post-root-death coalition census',
    );
    const detachedPids = [records['fork-setsid-exec'].pid, records['posix-spawn-setsid'].pid];
    const oldCoalitionRetainedDetachedChildren = detachedPids.every(
      (pid) => postRootDeathCensus.matchingPids.includes(pid),
    ) && censusCertifiesCompleteEnumeration(postRootDeathCensus);
    const recovery = [];
    const recoveryCensuses = [postRootDeathCensus];
    let emptyScans = 0;
    let recoveredCensus = postRootDeathCensus;
    for (let iteration = 0; iteration < 12 && emptyScans < 2; iteration += 1) {
      if (censusCertifiesCompleteEnumeration(recoveredCensus) &&
          recoveredCensus.matchingPids.length === 0) {
        emptyScans += 1;
      } else {
        emptyScans = 0;
        recovery.push(parseSingleJson(
          command(executableRealpath, ['drain', resourceId]),
          `old-coalition recovery ${iteration + 1}`,
        ));
      }
      sleep(50);
      recoveredCensus = parseSingleJson(
        command(executableRealpath, ['census', resourceId]),
        `old-coalition recovery census ${iteration + 1}`,
      );
      recoveryCensuses.push(recoveredCensus);
    }
    const auditTokenSignalsBound = stopAuditSignal.signalResult === 0 &&
      continueAuditSignal.signalResult === 0 && rootKillAuditSignal.signalResult === 0 &&
      trustedRootKilled;
    const staleAuditTokenRejected = staleAuditSignal.signalResult === 3 &&
      staleAuditSignal.signalErrno === 3;
    const oldCoalitionRecovered = emptyScans >= 2 &&
      recoveryCensuses.every(censusCertifiesCompleteEnumeration) &&
      recoveredCensus.matchingPids.length === 0 &&
      recovery.some((attempt) => Array.isArray(attempt.attempts) && attempt.attempts.some(
        (entry) => detachedPids.includes(entry.pid) && entry.signalResult === 0,
      ));

    evidence = {
      skipped: false,
      phase: 'observed',
      platform: `${os.platform()}-${os.release()}-${os.arch()}`,
      uid,
      domain,
      label,
      executableIdentity,
      compile,
      bootstrap,
      domainProbes,
      bootstrapAttempts,
      controller,
      controllerProbe,
      records,
      inspections,
      inspectionProbes,
      foreignAttempt,
      foreignRecord,
      foreignInspection,
      census,
      auditToken: {
        staleAuditSignal,
        stopAuditSignal,
        continueAuditSignal,
        rootKillAuditSignal,
        trustedRootKilled,
      },
      postRootDeathCensus,
      recovery,
      recoveryCensuses,
      recoveredCensus,
      observations: {
        allQueriesAvailable,
        distinctFromController,
        descendantsInRootResourceCoalition,
        censusContainsAllKnownMembers,
        foreignCoalitionJoinOutcome,
        foreignCoalitionJoinRejected: foreignCoalitionJoinOutcome === 'rejected',
        sameUidCensusQueryable: censusCertifiesCompleteEnumeration(census),
        auditTokenSignalsBound,
        staleAuditTokenRejected,
        oldCoalitionRetainedDetachedChildren,
        oldCoalitionRecovered,
      },
    };
  } catch (error) {
    evidence = {
      skipped: false,
      phase: 'observe-failed',
      uid,
      domain,
      label,
      executableIdentity,
      compile,
      bootstrap,
      domainProbes,
      bootstrapAttempts,
      launchdLog,
      controllerProbe,
      foreignAttempt,
      records,
      error: { name: error.name, message: excerpt(error.message) },
      launchdStdout: fs.existsSync(stdoutPath) ? excerpt(fs.readFileSync(stdoutPath, 'utf8')) : null,
      launchdStderr: fs.existsSync(stderrPath) ? excerpt(fs.readFileSync(stderrPath, 'utf8')) : null,
    };
  } finally {
    const cleanupRecords = { ...readAvailableRecords(stateDirectory), ...(records || {}) };
    let foreignSpawnedPid = null;
    try {
      const attempt = JSON.parse(fs.readFileSync(
        path.join(stateDirectory, 'foreign-attempt.json'), 'utf8',
      ));
      if (Number.isInteger(attempt.spawnedPid) && attempt.spawnedPid > 0) {
        foreignSpawnedPid = attempt.spawnedPid;
      }
    } catch {}
    const knownPids = ROLES
      .map((role) => cleanupRecords[role] && cleanupRecords[role].pid)
      .filter(Number.isInteger)
      .concat(foreignSpawnedPid === null ? [] : [foreignSpawnedPid]);
    const cleanupDomains = [...new Set([
      ...bootstrapAttempts.map((attempt) => attempt.domain),
      ...(domain ? [domain] : []),
    ])];
    const terminations = cleanupDomains.map((candidate) => ({
      domain: candidate,
      result: command('launchctl', ['kill', 'SIGTERM', `${candidate}/${label}`]),
    }));
    const terminationDeadline = Date.now() + 10_000;
    while (knownPids.some(isAlive) && Date.now() < terminationDeadline) {
      sleep(100);
    }
    for (const pid of knownPids) {
      if (isAlive(pid)) {
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
    }
    const bootouts = cleanupDomains.map((candidate) => ({
      domain: candidate,
      result: command('launchctl', ['bootout', `${candidate}/${label}`]),
    }));
    bootout = domain
      ? bootouts.find((entry) => entry.domain === domain)?.result || null
      : null;
    const reapDeadline = Date.now() + 5_000;
    while (knownPids.some(isAlive) && Date.now() < reapDeadline) {
      sleep(100);
    }
    const survivors = knownPids.filter(isAlive);
    evidence.cleanup = { terminations, bootouts, bootout, records: cleanupRecords, knownPids, survivors };
    if (survivors.length === 0) {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    } else {
      evidence.cleanup.retainedRoot = temporaryRoot;
    }
    writeEvidence(evidence);
  }
  return evidence;
}

if (require.main === module) {
  try {
    const evidence = runProof();
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
    if (!evidence.skipped && evidence.phase !== 'observed') {
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { runProof };
