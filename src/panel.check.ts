// `orca plugin check` and `orca plugin shot --scenario` render the panel once per scenario.
// `demo` is the plugin page screenshot: a made-up project, with every worker request stubbed so no
// real issue reaches the image.
import { defineCheck } from 'orca/testing'
import type { BoardFields, Issue, IssueList } from './protocol'

const PROJECT = { id: 'github:acme/web', repo: 'acme/web', name: 'Web' }
const TEMPLATE = 'Work on {{issue_url}}\n\n1. Follow the project conventions.\n2. Add focused tests for the change.\n3. Open a pull request when done.'

const ROWS: [number, string, string, string, string][] = [
  [48, 'Add a dark mode toggle to settings', 'ui', 'S', 'In progress'],
  [47, 'Cache search results for repeat queries', 'performance', 'M', 'In progress'],
  [45, 'Fix the date picker on Safari', 'bug', 'XS', 'Ready'],
  [44, 'Show a progress bar during uploads', 'ui', 'M', 'Ready'],
  [41, 'Write the self-hosting guide', 'docs', 'L', 'Ready']
]

const issue = ([number, title, label]: (typeof ROWS)[number]): Issue => ({
  number,
  title,
  url: `https://github.com/acme/web/issues/${number}`,
  labels: [label],
  assignees: [],
  author: 'octocat',
  milestone: null,
  type: null
})

const DEMO: IssueList = {
  kind: 'ready',
  project: PROJECT,
  issues: ROWS.map(issue),
  sessions: {
    48: { worktreeId: 'demo::/w/issue-48', name: 'issue-48-add-a-dark-mode', agent: 'claude' },
    47: { worktreeId: 'demo::/w/issue-47', name: 'issue-47-cache-search-results-for', agent: 'codex' }
  },
  viewer: 'octocat'
}

const BOARDS: BoardFields = {
  fields: ['Status', 'Size', 'Priority'],
  states: ['Backlog', 'Ready', 'In progress', 'Done'],
  values: Object.fromEntries(ROWS.map(([number, , , size, status]) => [number, { Status: status, Size: size }]))
}

const templates = { default: 'Complete {{issue_url}}', projects: [{ repo: PROJECT.repo, name: PROJECT.name, template: TEMPLATE }] }

export default defineCheck({
  demo: {
    storage: { templates },
    // Orca first delivers the current context to each new subscriber, which makes the first load.
    events: [{ event: 'workspace.changed', payload: { context: null } }],
    requests: {
      'project.active': () => PROJECT,
      'issues.load': () => DEMO,
      'boardFields.load': () => BOARDS,
      'issue.start': () => null,
      'worktree.open': () => null
    }
  }
})
