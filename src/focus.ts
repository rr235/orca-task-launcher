// Brings an agent session's tab to the front of Orca's window. Orca has no CLI command or plugin method
// for a tab, so this calls `session.tabs.activate` through the runtime client inside Orca's CLI, run
// under Orca's bundled Node. These are Orca internals, not a published API, and only the macOS app
// layout is known: the caller shows the worktree first, so a failure here still leaves it on screen.
import { execFile } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import process from 'node:process'
import { tabOfPane } from './issues'

// Where macOS installs Orca; `ORCA_APP` names another `.app` bundle.
const APP = process.env.ORCA_APP ?? '/Applications/Orca.app'
// Where Orca's CLI keeps its runtime client, newest layout first.
const CLIENT_PATHS = ['out/cli/runtime/client.js', 'out/cli/runtime-client.js']
const TIMEOUT_MS = 15000

const SCRIPT = `
const [request] = process.argv.slice(1)
const { client: clientPath, params } = JSON.parse(request)
const { RuntimeClient } = require(clientPath)
;(async () => {
  try {
    await new RuntimeClient().call('session.tabs.activate', params, { timeoutMs: ${TIMEOUT_MS} })
    console.log(JSON.stringify({ ok: true }))
  } catch (error) {
    console.log(JSON.stringify({ error: String(error.message || error) }))
  }
  process.exit(0)
})()
`

/** Focuses the tab of the session in `paneKey`, in the workspace at `path`, which Orca must already show. */
export async function focusTab(path: string, paneKey: string): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('Focusing a tab needs the macOS app.')
  }
  const tab = tabOfPane(paneKey)
  if (!tab) {
    throw new Error('This session has no tab Orca can focus.')
  }
  const contents = `${realpathSync(APP)}/Contents`
  const client = CLIENT_PATHS.map((p) => `${contents}/Resources/app.asar.unpacked/${p}`).find((p) => existsSync(p))
  if (!client) {
    throw new Error('This Orca build keeps its runtime client somewhere the plugin does not know.')
  }
  const params = { worktree: `path:${path}`, ...tab, intent: 'user', navigation: 'host' }
  const output = await new Promise<string>((resolve, reject) => {
    execFile(
      `${contents}/MacOS/Orca`,
      ['-e', SCRIPT, JSON.stringify({ client, params })],
      { timeout: TIMEOUT_MS, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
      (error: Error | null, stdout: string) => (error && !stdout ? reject(error) : resolve(stdout))
    )
  })
  let answer: { ok?: boolean; error?: string }
  try {
    answer = JSON.parse(output.trim().split('\n').pop() ?? '')
  } catch {
    throw new Error('Orca gave no readable answer.')
  }
  if (!answer.ok) {
    throw new Error(answer.error || 'Orca did not focus the tab.')
  }
}
