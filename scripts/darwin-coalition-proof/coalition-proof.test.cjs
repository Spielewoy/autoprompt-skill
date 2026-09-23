'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { runProof } = require('./run.cjs');

test('Darwin launchd coalition proof keeps setsid and posix_spawn escapes in one enumerable domain', {
  skip: process.platform !== 'darwin' ? 'requires native macOS' : false,
  timeout: 90_000,
}, (t) => {
  const evidence = runProof();
  t.diagnostic(JSON.stringify(evidence));
  assert.equal(evidence.phase, 'observed');
  assert.deepEqual(evidence.cleanup.survivors, []);
  assert.equal(evidence.cleanup.bootout.status, 0);
  assert.equal(evidence.observations.allQueriesAvailable, true);
  assert.equal(evidence.observations.distinctFromController, true);
  assert.equal(evidence.observations.descendantsInRootResourceCoalition, true);
  assert.equal(evidence.observations.censusContainsAllKnownMembers, true);
  assert.equal(evidence.observations.sameUidCensusQueryable, true);
  assert.equal(evidence.observations.foreignCoalitionJoinRejected, true);
});

test('coalition diagnostic stays isolated from production sources', () => {
  const source = fs.readFileSync(path.join(__dirname, 'coalition_probe.c'), 'utf8');
  const driver = fs.readFileSync(path.join(__dirname, 'run.cjs'), 'utf8');
  assert.match(source, /AP_PROC_PIDCOALITIONINFO 20/);
  assert.match(source, /POSIX_SPAWN_SETSID/);
  assert.match(source, /_NSGetEnviron\(\)/);
  assert.match(driver, /launchctl', \['bootstrap', candidate/);
  assert.match(driver, /sameUidCensusQueryable/);
});
