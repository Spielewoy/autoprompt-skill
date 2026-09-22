'use strict'
// Exact CI46 compiler outputs only; the original run did not execute either trial.
const path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict')
const { bound } = require('../descriptor-proof/run.cjs')
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
function verify(payload, inputs) {
  const pins = [
    [inputs, 'manifest.json', '5842461f662dde5ac409d9a8d8cc38c679f21c672dbd2416997a826867123897'],
    [inputs, 'combined.patch', '5d13ec584a74f913c7f787a3a6d820346b2a616445e8779f167d90d48ea90c0a'],
    [payload, 'adaptation.patch', '5d13ec584a74f913c7f787a3a6d820346b2a616445e8779f167d90d48ea90c0a'],
    [payload, 'stage/usr/bin/msys-2.0.dll', '835ba71e561034bb0307b3a752b771814b932583dbcd2cfe11aa7afc6d7583d2'],
    [payload, 'stage.sha256', 'd7e46359d39266c834d11b9b6f2a784489c90d7b461f41618e4125b7f7bf8b1a'],
    ...['toolchain-inputs.sha256', 'toolchain-outputs.sha256'].map(name => [payload, name, 'c3192cd30ec1b5ed2d265b44d65255da38d56f5b9a5893f8c5ed7f62cfbac69d']),
  ]
  for (const [root, name, digest] of pins) assert.equal(hash(bound(path.join(root, name), 8 * 1048576)), digest, 'CI46 reuse identity: ' + name)
  return { runId:'35670972446', headSha:'190df188c5b01c576facc1ccdc9f94de48391c4a', artifactId:'10671041821', archiveSha256:'68a45f7bb299c0b15cbd39cd7d2e58e994ea373b250f8649a2ad77cf8b918a82', compiledSources:'original build manifest; source tree not retained', nativeAcceptance:false }
}
module.exports = { verify }
