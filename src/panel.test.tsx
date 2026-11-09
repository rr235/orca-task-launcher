// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses.
import { assert, mockHost, mount, stored, test } from 'orca/testing'
import type { Board, Issue } from './protocol'
import * as panel from './panel'

const PROJECT = { id: 'github:acme/web', repo: 'acme/web', name: 'Web' }
const ISSUE: Issue = {
  number: 159,
  title: 'Show the saved theme on reload',
  url: 'https://github.com/acme/web/issues/159',
  labels: ['ui'],
  assignees: ['octocat'],
  author: 'octocat',
  milestone: 'v1.0',
  type: 'Task',
  fields: { Status: 'Ready', Size: 'M', Priority: 'High' }
}
const BACKLOG: Issue = {
  ...ISSUE,
  number: 62,
  title: 'Write the install guide',
  labels: [],
  assignees: [],
  author: 'hubot',
  milestone: null,
  type: 'Feature',
  fields: { Status: 'Backlog', Priority: 'Low' }
}
const READY: Board = {
  kind: 'ready',
  project: PROJECT,
  issues: [ISSUE, BACKLOG],
  sessions: {},
  states: ['Backlog', 'Ready', 'Done'],
  fields: ['Status', 'Size', 'Priority'],
  viewer: 'octocat'
}
const STARTED: Board = {
  ...READY,
  sessions: { 159: { worktreeId: 'repo::/w/issue-159', name: 'issue-159-show-the-saved-theme', agent: 'claude' } }
}
const CAPABILITIES = ['storage:own', 'workspace:read']

const host = (board: Board, started: Board = STARTED) => {
  const calls: unknown[] = []
  let current = board
  return {
    calls,
    host: mockHost({
      capabilities: CAPABILITIES,
      requests: {
        'project.active': () => (current.kind === 'ready' ? current.project : null),
        'board.load': () => current,
        'issue.start': (input: unknown) => {
          calls.push(input)
          current = started
          return null
        },
        'worktree.open': () => null
      }
    })
  }
}

test('Start flushes a template edit before asking the worker to launch', async () => {
  let saved: unknown
  const h = mockHost({
    capabilities: CAPABILITIES,
    requests: {
      'project.active': () => PROJECT,
      'board.load': () => READY,
      'issue.start': () => { saved = h.data().storage.templates; return null }
    }
  })
  const view = await mount(panel, { host: h })
  await view.type({ label: 'Web prompt template' }, 'Review {{issue_url}}', { replace: true })
  await view.press({ label: 'Start #159' })
  assert.deepEqual(saved, {
    default: 'Complete {{issue_url}}',
    projects: [{ repo: 'acme/web', name: 'Web', template: 'Review {{issue_url}}' }]
  })
  await view.unmount()
})

test('a GitHub label that matches a control sentinel remains filterable', async () => {
  const sentinelBoard: Board = { ...READY, issues: [{ ...ISSUE, labels: ['*any'] }, BACKLOG] }
  const h = mockHost({
    capabilities: CAPABILITIES,
    requests: { 'project.active': () => PROJECT, 'board.load': () => sentinelBoard }
  })
  const view = await mount(panel, { host: h })
  await view.toggle({ label: 'Filter' })
  await view.select({ label: 'Label' }, '=*any')
  assert.ok(view.find({ label: 'Start #159' }))
  assert.equal(view.find({ label: 'Start #62' }), null)
  await view.unmount()
})

test('a project switch that sends no workspace event still shows the new project', async () => {
  const OTHER = { id: 'github:acme/api', repo: 'acme/api', name: 'API' }
  const otherBoard: Board = { ...READY, project: OTHER, issues: [{ ...BACKLOG, number: 7, url: 'https://github.com/acme/api/issues/7' }] }
  let active = PROJECT
  const h = mockHost({
    capabilities: CAPABILITIES,
    requests: {
      'project.active': () => active,
      'board.load': (input: { projectId: string }) => (input.projectId === OTHER.id ? otherBoard : READY)
    }
  })
  const view = await mount(panel, { host: h })
  assert.ok(view.find({ label: 'Start #159' }))
  await panel.checkActiveProject()
  await view.settled()
  assert.ok(view.find({ label: 'Start #159' }))
  active = OTHER
  await panel.checkActiveProject()
  await view.settled()
  assert.equal(view.find({ label: 'Start #159' }), null)
  assert.ok(view.find({ label: 'Start #7' }))
  await view.unmount()
})

test('a failed project lookup hides the previous project issues', async () => {
  let offline = false
  const h = mockHost({
    capabilities: CAPABILITIES,
    requests: {
      'project.active': () => { if (offline) { throw new Error('offline') }; return PROJECT },
      'board.load': () => READY
    }
  })
  const view = await mount(panel, { host: h })
  assert.ok(view.find({ label: 'Start #159' }))
  offline = true
  await view.emit('workspace.changed', { context: null })
  assert.equal(view.find({ label: 'Start #159' }), null)
  assert.ok(view.find({ text: 'Could not load the issues.' }))
  await view.unmount()
})


test('a board error shows its own message', async () => {
  const message = 'gh is not signed in. Run gh auth login in a terminal, then try again.'
  const h = mockHost({
    capabilities: CAPABILITIES,
    requests: { 'project.active': () => PROJECT, 'board.load': () => ({ kind: 'error', message }) }
  })
  const view = await mount(panel, { host: h })
  assert.ok(view.find({ text: message }))
  await view.unmount()
})

test('without boards, every issue shows, with no Status filter, even one saved earlier', async () => {
  const noFields = (issue: Issue): Issue => ({ ...issue, fields: {} })
  const repoOnly: Board = { ...READY, issues: READY.issues.map(noFields), fields: [], states: [] }
  const saved = { status: '=Ready', assignee: '*any', label: '*any', author: '*any', milestone: '*any', type: '*any' }
  const view = await mount(panel, { host: host(repoOnly).host, persisted: { plugin: { filters: stored(saved, 2) } } })
  assert.ok(view.find({ label: 'Start #159' }))
  assert.ok(view.find({ label: 'Start #62' }))
  await view.toggle({ label: 'Filter' })
  assert.equal(view.find({ label: 'Status' }), null)
  assert.ok(view.find({ label: 'Label' }))
  await view.unmount()
})

test('a fresh repo-only load replaces cached board filters, and restored fields reuse the saved Status', async () => {
  const saved = { status: '=Ready', assignee: '*any', label: '*any', author: '*any', milestone: '*any', type: '*any' }
  let current: Board = { ...READY, issues: READY.issues.map((issue) => ({ ...issue, fields: {} })), fields: [], states: [] }
  const h = mockHost({
    capabilities: CAPABILITIES,
    requests: { 'project.active': () => PROJECT, 'board.load': () => current }
  })
  const view = await mount(panel, {
    host: h,
    persisted: { plugin: { boards: stored({ [PROJECT.id]: READY }, 2), filters: stored(saved, 2) } }
  })
  assert.ok(view.find({ label: 'Start #159' }))
  assert.ok(view.find({ label: 'Start #62' }))
  assert.ok(view.find({ label: 'Filter' }))
  assert.equal(view.find({ text: 'M' }), null)
  current = READY
  await view.emit('workspace.changed', { context: null })
  assert.ok(view.find({ label: 'Start #159' }))
  assert.equal(view.find({ label: 'Start #62' }), null)
  assert.ok(view.find({ label: 'Filter (1)' }))
  await view.unmount()
})

test('a structured refresh error preserves the selected project cache', async () => {
  const message = 'GitHub could not load the issues: unavailable'
  const h = mockHost({
    capabilities: CAPABILITIES,
    requests: { 'project.active': () => PROJECT, 'board.load': () => ({ kind: 'error', message }) }
  })
  const view = await mount(panel, {
    host: h,
    persisted: { plugin: { boards: stored({ [PROJECT.id]: READY }, 2) } }
  })
  assert.ok(view.find({ label: 'Start #159' }))
  assert.ok(view.find({ text: message }))
  await view.unmount()
})

test('Start still works after loading without project boards', async () => {
  const repoOnly: Board = { ...READY, issues: READY.issues.map((issue) => ({ ...issue, fields: {} })), fields: [], states: [] }
  const { host: h, calls } = host(repoOnly, { ...repoOnly, sessions: STARTED.sessions })
  const view = await mount(panel, { host: h })
  await view.press({ label: 'Start #159' })
  assert.deepEqual(calls, [{ projectId: PROJECT.id, repo: PROJECT.repo, issue: repoOnly.issues[0] }])
  assert.ok(view.find({ text: 'issue-159-show-the-saved-theme' }))
  assert.equal(view.find({ label: 'Start #159' }), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('Start sends the issue to the worker and shows its worktree and agent', async () => {
  const { host: h, calls } = host(READY)
  const view = await mount(panel, { host: h })
  assert.equal(view.valueOf({ label: 'Web prompt template' }), 'Complete {{issue_url}}')
  assert.ok(view.find({ text: 'ui' }))

  await view.press({ label: 'Start #159' })
  assert.deepEqual(calls, [{ projectId: PROJECT.id, repo: PROJECT.repo, issue: ISSUE }])
  assert.ok(view.find({ text: 'issue-159-show-the-saved-theme' }))
  assert.ok(view.find({ text: 'Claude' }))
  assert.equal(view.find({ label: 'Start #159' }), null)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test('editing the template saves it for the focused project only', async () => {
  const { host: h } = host(READY)
  const view = await mount(panel, { host: h })
  await view.type({ label: 'Web prompt template' }, 'Work on #{{issue_number}}', { replace: true })
  await new Promise((resolve) => setTimeout(resolve, 800))
  assert.deepEqual(h.data().storage.templates, {
    default: 'Complete {{issue_url}}',
    projects: [{ repo: 'acme/web', name: 'Web', template: 'Work on #{{issue_number}}' }]
  })
  await view.unmount()
})

test('without a GitHub project focused, says so', async () => {
  const view = await mount(panel, { host: host({ kind: 'no-project' }).host })
  assert.ok(view.find({ label: 'No GitHub project' }))
  await view.unmount()
})

test('a Start that times out but still created the worktree shows it, not an error', async () => {
  let current: Board = READY
  const h = mockHost({
    capabilities: CAPABILITIES,
    requests: {
      'project.active': () => PROJECT,
      'board.load': () => current,
      'issue.start': () => {
        current = STARTED
        throw new Error('timeout')
      }
    }
  })
  const view = await mount(panel, { host: h })
  await view.press({ label: 'Start #159' })
  assert.ok(view.find({ text: 'issue-159-show-the-saved-theme' }))
  assert.equal(view.find({ text: 'Could not confirm this start. Check Orca worktrees before retrying.' }), null)
  await view.unmount()
})

test('display fields choose the labels and board fields each card shows', async () => {
  const view = await mount(panel, { host: host(READY).host })
  assert.ok(view.find({ text: 'M' }))
  assert.equal(view.find({ text: 'High' }), null)
  await view.toggle({ label: 'Display fields' })
  await view.toggle({ label: 'Priority' })
  await view.toggle({ label: 'Size' })
  await view.toggle({ label: 'Labels' })
  assert.ok(view.find({ text: 'High' }))
  assert.equal(view.find({ text: 'M' }), null)
  assert.equal(view.find({ text: 'ui' }), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('filters narrow the list, count in the title, and Clear all resets them', async () => {
  const view = await mount(panel, { host: host(READY).host })
  await view.toggle({ label: 'Filter' })
  await view.select({ label: 'Assignee' }, '*me')
  assert.equal(view.find({ label: 'Start #62' }), null)
  assert.ok(view.find({ label: 'Start #159' }))
  await view.select({ label: 'Issue type' }, '=Feature')
  assert.ok(view.find({ text: 'No issues match these filters.' }))
  assert.ok(view.find({ label: 'Filter (2)' }))
  await view.press({ text: 'Clear all' })
  assert.ok(view.find({ label: 'Start #62' }))
  assert.ok(view.find({ label: 'Filter' }))
  await view.select({ label: 'Milestone' }, '*none')
  assert.equal(view.find({ label: 'Start #159' }), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('reopening shows the selected project cached list at once, never another project list, and a failed refresh says so', async () => {
  const first = await mount(panel, { host: host(READY).host })
  const persisted = { plugin: { ...first.persisted.plugin, boards: stored(first.persisted.plugin.boards, 2) } }
  await first.unmount()
  const offline = (project: typeof PROJECT) =>
    mockHost({
      capabilities: CAPABILITIES,
      requests: {
        'project.active': () => project,
        'board.load': () => {
          throw new Error('offline')
        }
      }
    })
  const same = await mount(panel, { host: offline(PROJECT), persisted })
  assert.ok(same.find({ label: 'Start #159' }))
  assert.ok(same.find({ text: 'Could not load the issues.' }))
  await same.unmount()
  const other = { id: 'github:acme/docs', repo: 'acme/docs', name: 'Docs' }
  const switched = await mount(panel, { host: offline(other), persisted })
  assert.equal(switched.find({ label: 'Start #159' }), null)
  await switched.unmount()
})

test('a list cached in the older shape is dropped, not shown', async () => {
  const persisted = {
    plugin: { boards: stored({ [PROJECT.id]: { kind: 'ready', project: PROJECT, issues: [{ number: 1, title: 't', url: 'u', labels: [], status: null, size: null }], sessions: {}, states: [] } }, 1) }
  }
  const view = await mount(panel, { host: host(READY).host, persisted })
  assert.ok(view.find({ label: 'Start #159' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('the worktree icon and its linked name both open the worktree', async () => {
  const opened: unknown[] = []
  const h = mockHost({
    capabilities: CAPABILITIES,
    requests: {
      'project.active': () => PROJECT,
      'board.load': () => STARTED,
      'worktree.open': (input: unknown) => {
        opened.push(input)
        return null
      }
    }
  })
  const view = await mount(panel, { host: h })
  await view.press({ label: 'Open issue-159-show-the-saved-theme' })
  await view.press({ text: 'issue-159-show-the-saved-theme' })
  assert.deepEqual(opened, [{ worktreeId: 'repo::/w/issue-159' }, { worktreeId: 'repo::/w/issue-159' }])
  assert.deepEqual(view.errors, [])
  await view.unmount()
})
