// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses.
import { assert, mockHost, mount, stored, test, type MockRequests, type TestPanel } from 'orca/testing'
import { NO_BOARDS } from './issues'
import type { BoardFields, Issue, IssueList } from './protocol'
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
  type: 'Task'
}
const BACKLOG: Issue = {
  ...ISSUE,
  number: 62,
  title: 'Write the install guide',
  labels: [],
  assignees: [],
  author: 'hubot',
  milestone: null,
  type: 'Feature'
}
const READY: IssueList = { kind: 'ready', project: PROJECT, issues: [ISSUE, BACKLOG], sessions: {}, viewer: 'octocat' }
const BOARDS: BoardFields = {
  fields: ['Status', 'Size', 'Priority'],
  states: ['Backlog', 'Ready', 'Done'],
  values: { 159: { Status: 'Ready', Size: 'M', Priority: 'High' }, 62: { Status: 'Backlog', Priority: 'Low' } }
}
const STARTED: IssueList = {
  ...READY,
  sessions: { 159: { worktreeId: 'repo::/w/issue-159', name: 'issue-159-show-the-saved-theme', agent: 'claude' } }
}
const SAVED_READY = { status: '=Ready', assignee: '*any', label: '*any', author: '*any', milestone: '*any', type: '*any' }
const CAPABILITIES = ['storage:own', 'workspace:read']

/** A worker that answers with READY and BOARDS, unless a request is overridden. */
const worker = (requests: MockRequests = {}) =>
  mockHost({
    capabilities: CAPABILITIES,
    requests: { 'project.active': () => PROJECT, 'issues.load': () => READY, 'boardFields.load': () => BOARDS, ...requests }
  })

const host = (list: IssueList, started: IssueList = STARTED, boards: BoardFields = BOARDS) => {
  const calls: unknown[] = []
  let current = list
  return {
    calls,
    host: worker({
      'project.active': () => (current.kind === 'ready' ? current.project : null),
      'issues.load': () => current,
      'boardFields.load': () => boards,
      'issue.start': (input: unknown) => {
        calls.push(input)
        current = started
        return null
      },
      'worktree.open': () => null
    })
  }
}

/** A promise the test settles, to hold a worker request open. */
function held<T>() {
  let resolve: (value: T) => void = () => {}
  let reject: (error: Error) => void = () => {}
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Waits until the panel shows what `check` looks for, while a request is still held open. */
async function until(view: TestPanel, check: () => unknown): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.ok(check(), JSON.stringify(view.summary()))
}

test('Start flushes a template edit before asking the worker to launch', async () => {
  let saved: unknown
  const h = worker({ 'issue.start': () => { saved = h.data().storage.templates; return null } })
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
  const sentinelList: IssueList = { ...READY, issues: [{ ...ISSUE, labels: ['*any'] }, BACKLOG] }
  const view = await mount(panel, { host: worker({ 'issues.load': () => sentinelList }) })
  await view.toggle({ label: 'Filter' })
  await view.select({ label: 'Label' }, '=*any')
  assert.ok(view.find({ label: 'Start #159' }))
  assert.equal(view.find({ label: 'Start #62' }), null)
  await view.unmount()
})

test('a failed project lookup hides the previous project issues', async () => {
  let offline = false
  const h = worker({ 'project.active': () => { if (offline) { throw new Error('offline') }; return PROJECT } })
  const view = await mount(panel, { host: h })
  assert.ok(view.find({ label: 'Start #159' }))
  offline = true
  await view.emit('workspace.changed', { context: null })
  assert.equal(view.find({ label: 'Start #159' }), null)
  assert.ok(view.find({ text: 'Could not load the issues.' }))
  await view.unmount()
})

test('a load error shows its own message', async () => {
  const message = 'gh is not signed in. Run gh auth login in a terminal, then try again.'
  const view = await mount(panel, { host: worker({ 'issues.load': () => ({ kind: 'error', message }) }) })
  assert.ok(view.find({ text: message }))
  await view.unmount()
})

test('without boards, every issue shows, with no Status filter, even one saved earlier', async () => {
  const view = await mount(panel, { host: host(READY, STARTED, NO_BOARDS).host, persisted: { plugin: { filters: stored(SAVED_READY, 2) } } })
  assert.ok(view.find({ label: 'Start #159' }))
  assert.ok(view.find({ label: 'Start #62' }))
  await view.toggle({ label: 'Filter' })
  assert.equal(view.find({ label: 'Status' }), null)
  assert.ok(view.find({ label: 'Label' }))
  await view.unmount()
})

test('an answer with no boards replaces cached board filters, and returning fields reuse the saved Status', async () => {
  let boards: BoardFields = NO_BOARDS
  const view = await mount(panel, {
    host: worker({ 'boardFields.load': () => boards }),
    persisted: { plugin: { issueLists: { [PROJECT.id]: { list: READY, boards: BOARDS } }, filters: stored(SAVED_READY, 2) } }
  })
  assert.ok(view.find({ label: 'Start #159' }))
  assert.ok(view.find({ label: 'Start #62' }))
  assert.ok(view.find({ label: 'Filter' }))
  assert.equal(view.find({ text: 'M' }), null)
  boards = BOARDS
  await view.emit('workspace.changed', { context: null })
  assert.ok(view.find({ label: 'Start #159' }))
  assert.equal(view.find({ label: 'Start #62' }), null)
  assert.ok(view.find({ label: 'Filter (1)' }))
  await view.unmount()
})

test('issues render before the board fields answer, which then fill in', async () => {
  let list: IssueList = READY
  let boards: () => BoardFields | Promise<BoardFields> = () => NO_BOARDS
  const view = await mount(panel, { host: worker({ 'issues.load': () => list, 'boardFields.load': () => boards() }) })
  assert.equal(view.find({ text: 'M' }), null)
  const pending = held<BoardFields>()
  list = { ...READY, issues: [{ ...ISSUE, number: 7, title: 'A new issue' }, ...READY.issues] }
  boards = () => pending.promise
  const refreshed = view.emit('workspace.changed', { context: null })
  await until(view, () => view.find({ label: 'Start #7' }))
  assert.equal(view.find({ text: 'M' }), null)
  pending.resolve(BOARDS)
  await refreshed
  assert.ok(view.find({ text: 'M' }))
  await view.unmount()
})

test('a failed board query leaves the list and its fields intact', async () => {
  let failing = false
  const h = worker({ 'boardFields.load': () => { if (failing) { throw new Error('read:project scope required') }; return BOARDS } })
  const view = await mount(panel, { host: h })
  assert.ok(view.find({ text: 'M' }))
  failing = true
  await view.emit('workspace.changed', { context: null })
  assert.ok(view.find({ label: 'Start #159' }))
  assert.ok(view.find({ label: 'Start #62' }))
  assert.ok(view.find({ text: 'M' }))
  assert.equal(view.find({ text: 'Could not load the issues.' }), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('a structured refresh error preserves the selected project cache', async () => {
  const message = 'GitHub could not load the issues: unavailable'
  const view = await mount(panel, {
    host: worker({ 'issues.load': () => ({ kind: 'error', message }) }),
    persisted: { plugin: { issueLists: { [PROJECT.id]: { list: READY, boards: BOARDS } } } }
  })
  assert.ok(view.find({ label: 'Start #159' }))
  assert.ok(view.find({ text: 'M' }))
  assert.ok(view.find({ text: message }))
  await view.unmount()
})

test('Start still works after loading without project boards', async () => {
  const { host: h, calls } = host(READY, STARTED, NO_BOARDS)
  const view = await mount(panel, { host: h })
  await view.press({ label: 'Start #159' })
  assert.deepEqual(calls, [{ projectId: PROJECT.id, repo: PROJECT.repo, issue: ISSUE }])
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
  let current: IssueList = READY
  const h = worker({
    'issues.load': () => current,
    'issue.start': () => {
      current = STARTED
      throw new Error('timeout')
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
  const persisted = { plugin: first.persisted.plugin }
  await first.unmount()
  const offline = (project: typeof PROJECT) =>
    worker({
      'project.active': () => project,
      'issues.load': () => {
        throw new Error('offline')
      },
      'boardFields.load': () => {
        throw new Error('offline')
      }
    })
  const same = await mount(panel, { host: offline(PROJECT), persisted })
  assert.ok(same.find({ label: 'Start #159' }))
  assert.ok(same.find({ text: 'M' }))
  assert.ok(same.find({ text: 'Could not load the issues.' }))
  await same.unmount()
  const other = { id: 'github:acme/docs', repo: 'acme/docs', name: 'Docs' }
  const switched = await mount(panel, { host: offline(other), persisted })
  assert.equal(switched.find({ label: 'Start #159' }), null)
  await switched.unmount()
})

test('a list cached under the older boards key is not shown', async () => {
  const h = worker({
    'issues.load': () => {
      throw new Error('offline')
    }
  })
  const view = await mount(panel, { host: h, persisted: { plugin: { boards: stored({ [PROJECT.id]: READY }, 2) } } })
  assert.equal(view.find({ label: 'Start #159' }), null)
  assert.ok(view.find({ text: 'Could not load the issues.' }))
  await view.unmount()
})

test('the worktree icon and its linked name both open the worktree', async () => {
  const opened: unknown[] = []
  const h = worker({
    'issues.load': () => STARTED,
    'worktree.open': (input: unknown) => {
      opened.push(input)
      return null
    }
  })
  const view = await mount(panel, { host: h })
  await view.press({ label: 'Open issue-159-show-the-saved-theme' })
  await view.press({ text: 'issue-159-show-the-saved-theme' })
  assert.deepEqual(opened, [{ worktreeId: 'repo::/w/issue-159' }, { worktreeId: 'repo::/w/issue-159' }])
  assert.deepEqual(view.errors, [])
  await view.unmount()
})
