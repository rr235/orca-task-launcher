// Reads Orca's default agent from real settings files laid out as Orca writes them.
import { assert, test } from 'orca/testing'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { activeProfileId, agentSetting, orcaDataDir, readDefaultAgent } from './settings'

const quiet = () => {}

/** A macOS-style home with Orca's data folder, an active profile and the given settings files. */
function home(files: { profile?: string; index?: boolean; settings?: object | null; legacy?: object }): string {
  const dir = mkdtempSync(join(tmpdir(), 'task-launcher-'))
  const data = join(dir, 'Library', 'Application Support', 'orca')
  const profile = files.profile ?? 'local-default'
  const profileDir = join(data, 'profiles', profile)
  mkdirSync(profileDir, { recursive: true })
  if (files.index !== false) {
    writeFileSync(join(data, 'orca-profile-index.json'), JSON.stringify({ activeProfileId: profile, profiles: [{ id: profile }] }))
  }
  if (files.settings !== undefined) {
    const db = new DatabaseSync(join(profileDir, 'profile-state.db'))
    db.exec('CREATE TABLE profile_state_documents (domain TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL)')
    if (files.settings) {
      db.prepare('INSERT INTO profile_state_documents VALUES (?, ?)').run('settings', JSON.stringify(files.settings))
    }
    db.close()
  }
  if (files.legacy) {
    writeFileSync(join(profileDir, 'orca-data.json'), JSON.stringify(files.legacy))
  }
  return dir
}

const agentFor = (dir: string) => readDefaultAgent(quiet, 'darwin', {}, dir)

test('Orca data lives in Electron user data on each platform', () => {
  assert.equal(orcaDataDir('darwin', {}, '/Users/a'), '/Users/a/Library/Application Support/orca')
  assert.equal(orcaDataDir('linux', {}, '/home/a'), '/home/a/.config/orca')
  assert.equal(orcaDataDir('linux', { XDG_CONFIG_HOME: '/xdg' }, '/home/a'), '/xdg/orca')
  assert.equal(orcaDataDir('win32', { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'C:\\Users\\a'), 'C:\\Users\\a\\AppData\\Roaming\\orca')
  assert.equal(orcaDataDir('win32', {}, 'C:\\Users\\a'), 'C:\\Users\\a\\AppData\\Roaming\\orca')
})

test('the active profile comes from the profile index, else the default profile', () => {
  assert.equal(activeProfileId(JSON.stringify({ activeProfileId: 'work', profiles: [{ id: 'work' }] })), 'work')
  assert.equal(activeProfileId(JSON.stringify({ activeProfileId: 'gone', profiles: [{ id: 'work' }] })), 'local-default')
  assert.equal(activeProfileId(JSON.stringify({ activeProfileId: '../x', profiles: [{ id: '../x' }] })), 'local-default')
  assert.equal(activeProfileId(null), 'local-default')
})

test('blank means no agent, unset means Claude', () => {
  assert.equal(agentSetting('codex'), 'codex')
  assert.equal(agentSetting('blank'), null)
  assert.equal(agentSetting(null), 'claude')
  assert.equal(agentSetting(''), 'claude')
})

test('the live settings database wins over the older settings file', async () => {
  assert.equal(await agentFor(home({ settings: { defaultTuiAgent: 'codex' }, legacy: { settings: { defaultTuiAgent: 'gemini' } } })), 'codex')
  assert.equal(await agentFor(home({ settings: { defaultTuiAgent: 'blank' } })), null)
})

test('the active profile is the one read, not always the default profile', async () => {
  assert.equal(await agentFor(home({ profile: 'work', settings: { defaultTuiAgent: 'opencode' } })), 'opencode')
})

test('without settings in the database, the older settings file is used, then Claude', async () => {
  assert.equal(await agentFor(home({ settings: null, legacy: { settings: { defaultTuiAgent: 'gemini' } } })), 'gemini')
  assert.equal(await agentFor(home({ legacy: { settings: { defaultTuiAgent: 'codex' } } })), 'codex')
  assert.equal(await agentFor(home({ index: false })), 'claude')
})
