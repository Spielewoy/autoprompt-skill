'use strict'

// Supported extension-host runner entry. This starts a fresh owned VS Code
// process for each assignment; its durable conversations belong to Autoprompt,
// not the user's built-in Chat history. The host exits and drains afterward.
exports.run = async function run() {
  // Fixed non-protocol markers distinguish VS Code test-runner startup from
  // extension activation without exposing request or credential material.
  console.log('AUTOPROMPT_SESSION_DRIVER_ENTERED')
  try {
    const vscode = require('vscode')
    const extension = vscode.extensions.getExtension('autoprompt.autoprompt-native-bridge')
    if (!extension) throw new Error('Owned Autoprompt extension was not discovered')
    console.log('AUTOPROMPT_SESSION_DRIVER_BEFORE_EXTENSION_ACTIVATE')
    const api = await extension.activate()
    console.log('AUTOPROMPT_SESSION_DRIVER_AFTER_EXTENSION_ACTIVATE')
    if (!api || typeof api.runOwnedSession !== 'function') throw new Error('Owned Autoprompt extension did not provide a session API')
    const events = require('./event-channel.cjs').connect(api.eventChannel)
    let sessionError = null
    try { await api.runOwnedSession(event => events.emit(event)) } catch (error) { sessionError = error }
    await events.complete()
    if (sessionError) throw sessionError
  } catch (error) { throw error }
}
