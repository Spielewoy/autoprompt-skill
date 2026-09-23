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
  const domain = `user/${uid}`;
  const service = `${domain}/${label}`;
  const plistPath = path.join(temporaryRoot, `${label}.plist`);
  const stdoutPath = path.join(temporaryRoot, 'launchd.stdout.log');
  const stderrPath = path.join(temporaryRoot, 'launchd.stderr.log');
  let records = null;
  let bootstrap = null;
  let bootout = null;
  let evidence = null;
  let controllerProbe = null;
  let foreignAttempt = null;

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
    bootstrap = command('launchctl', ['bootstrap', domain, plistPath]);
    if (bootstrap.status !== 0) {
      throw new Error(`launchctl bootstrap failed: ${JSON.stringify(bootstrap)}`);
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
      controller,
      controllerProbe,
      records,
      inspections,
      inspectionProbes,
      foreignAttempt,
      foreignRecord,
      foreignInspection,
      census,
      observations: {
        allQueriesAvailable,
        distinctFromController,
        descendantsInRootResourceCoalition,
        censusContainsAllKnownMembers,
        foreignCoalitionJoinOutcome,
        foreignCoalitionJoinRejected: foreignCoalitionJoinOutcome === 'rejected',
        sameUidCensusQueryable: census.complete === true &&
          census.denied === 0 && census.otherErrors === 0 &&
          census.identityDenied === 0 && census.identityErrors === 0,
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
    const terminate = command('launchctl', ['kill', 'SIGTERM', service]);
    const terminationDeadline = Date.now() + 10_000;
    while (knownPids.some(isAlive) && Date.now() < terminationDeadline) {
      sleep(100);
    }
    for (const pid of knownPids) {
      if (isAlive(pid)) {
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
    }
    bootout = command('launchctl', ['bootout', service]);
    const reapDeadline = Date.now() + 5_000;
    while (knownPids.some(isAlive) && Date.now() < reapDeadline) {
      sleep(100);
    }
    const survivors = knownPids.filter(isAlive);
    evidence.cleanup = { terminate, bootout, records: cleanupRecords, knownPids, survivors };
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
