// The board's reads of real `orca` and `gh` output shapes, trimmed to the fields used.
import { assert, test } from 'orca/testing'
import { activeProjectId, createArgs, defaultAgent, parseRepoIssues, sessionsFor, worktreeName } from './board'

const ID_42 = 'repo1::/work/issue-42-add-dark-mode'
const list = JSON.stringify({
  result: {
    worktrees: [
      { id: 'repo1::/work/main', projectId: 'github:acme/web', displayName: 'main', linkedIssue: null },
      { id: ID_42, projectId: 'github:acme/web', displayName: 'issue-42-add-dark-mode', linkedIssue: 42, isArchived: false },
      { id: 'repo1::/work/old', projectId: 'github:acme/web', linkedIssue: 12, isArchived: true },
      { id: 'repo2::/work/docs-15', projectId: 'github:acme/docs', linkedIssue: 15 }
    ]
  }
})
const ps = (activeId: string | null) =>
  JSON.stringify({
    result: {
      worktrees: [
        { worktreeId: 'repo1::/work/main', isActive: activeId === 'repo1::/work/main', agents: [] },
        { worktreeId: ID_42, isActive: activeId === ID_42, agents: [{ agentType: 'codex' }] }
      ]
    }
  })

test('GraphQL failures and missing repositories do not become an empty issue list', () => {
  for (const response of [
    { errors: [{ message: 'Missing project scope' }], data: { repository: { issues: { nodes: [] } } } },
    { data: { repository: null } }
  ]) {
    assert.throws(() => parseRepoIssues(JSON.stringify(response)))
  }
  assert.deepEqual(parseRepoIssues(JSON.stringify({ data: { repository: { issues: { nodes: [] } } } })), {
    issues: [], fields: [], states: [], viewer: null
  })
})

test('the active project is the project of the worktree selected in the sidebar', () => {
  assert.equal(activeProjectId(ps(ID_42), list), 'github:acme/web')
  assert.equal(activeProjectId(ps(null), list), null)
})

test('each live worktree linked to an issue of the project becomes its session', () => {
  assert.deepEqual(sessionsFor('github:acme/web', list, ps(null)), {
    42: { worktreeId: ID_42, name: 'issue-42-add-dark-mode', agent: 'codex' }
  })
})

test('the default agent follows Orca settings, blank means no agent, unset means Claude', () => {
  assert.equal(defaultAgent(JSON.stringify({ settings: { defaultTuiAgent: 'codex' } })), 'codex')
  assert.equal(defaultAgent(JSON.stringify({ settings: { defaultTuiAgent: 'blank' } })), null)
  assert.equal(defaultAgent(JSON.stringify({ settings: { defaultTuiAgent: null } })), 'claude')
  assert.equal(defaultAgent('not json'), 'claude')
})

test('Start creates a top-level worktree linked to the issue, sending the prompt to the agent', () => {
  const issue = { number: 159, title: 'Settings page - Show the saved theme on reload' }
  assert.equal(worktreeName(issue), 'issue-159-settings-page-show-the')
  assert.deepEqual(createArgs({ projectId: 'github:acme/web', issue, agent: 'claude', prompt: 'Do #159' }), [
    'worktree', 'create', '--project', 'github:acme/web', '--name', 'issue-159-settings-page-show-the',
    '--issue', '159', '--no-parent', '--json', '--agent', 'claude', '--prompt', 'Do #159'
  ])
  assert.equal(createArgs({ projectId: 'github:acme/web', issue, agent: null, prompt: 'x' }).includes('--agent'), false)
})

test('reads issues with their people, milestone, type and own board fields, and the boards fields and states', () => {
  const field = (name: string) => ({ name })
  const json = JSON.stringify({
    data: {
      viewer: { login: 'octocat' },
      repository: {
        issues: {
          nodes: [
            {
              number: 42,
              title: 'Add dark mode',
              url: 'https://github.com/acme/web/issues/42',
              author: { login: 'octocat' },
              assignees: { nodes: [{ login: 'octocat' }] },
              milestone: { title: 'v1.0' },
              issueType: { name: 'Task' },
              labels: { nodes: [{ name: 'ui' }] },
              projectItems: {
                nodes: [
                  {
                    project: { id: 'closed-board' },
                    fieldValues: { nodes: [{ name: 'Archived', field: field('Status') }] }
                  },
                  {
                    project: { id: 'open-board' },
                    fieldValues: {
                      nodes: [
                        { text: 'Add dark mode', field: field('Title') },
                        { name: 'Ready', field: field('Status') },
                        { name: 'XS', field: field('Size') },
                        { number: 3, field: field('Estimate') },
                        {}
                      ]
                    }
                  },
                  { project: { id: 'open-board' }, fieldValues: { nodes: [{ name: 'Done', field: field('Status') }] } }
                ]
              }
            },
            { number: 70, title: 'Off the board', url: 'u70', author: null, labels: { nodes: [] } },
            { number: 7, title: '' }
          ]
        },
        owner: {
          projectsV2: {
            nodes: [
              {
                id: 'open-board',
                closed: false,
                fields: {
                  nodes: [
                    { name: 'Title', dataType: 'TITLE' },
                    { name: 'Status', dataType: 'SINGLE_SELECT' },
                    { name: 'Size', dataType: 'SINGLE_SELECT' },
                    { name: 'Estimate', dataType: 'NUMBER' },
                    { name: 'Labels', dataType: 'LABELS' }
                  ]
                },
                field: { options: [{ name: 'Backlog' }, { name: 'Ready' }] }
              },
              { id: 'closed-board', closed: true, fields: { nodes: [{ name: 'Old', dataType: 'TEXT' }] }, field: { options: [{ name: 'Archived' }] } }
            ]
          }
        }
      }
    }
  })
  assert.deepEqual(parseRepoIssues(json), {
    issues: [
      {
        number: 42,
        title: 'Add dark mode',
        url: 'https://github.com/acme/web/issues/42',
        labels: ['ui'],
        assignees: ['octocat'],
        author: 'octocat',
        milestone: 'v1.0',
        type: 'Task',
        fields: { Status: 'Ready', Size: 'XS', Estimate: '3' }
      },
      { number: 70, title: 'Off the board', url: 'u70', labels: [], assignees: [], author: null, milestone: null, type: null, fields: {} }
    ],
    states: ['Backlog', 'Ready'],
    fields: ['Status', 'Size', 'Estimate'],
    viewer: 'octocat'
  })
})
