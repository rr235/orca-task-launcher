// `orca plugin check` and `orca plugin shot --scenario` render the panel once per scenario.
// `demo` is the plugin page screenshot: a made-up project, with every worker request stubbed so no
// real issue reaches the image.
import { defineCheck } from 'orca/testing'
import type { Board, Issue } from './protocol'

const PROJECT = { id: 'github:acme/web', repo: 'acme/web', name: 'Web' }
const TEMPLATE = 'Work on {{issue_url}}\n\n1. Follow the project conventions.\n2. Add focused tests for the change.\n3. Open a pull request when done.'

const issue = (number: number, title: string, label: string, size: string, status = 'Ready'): Issue => ({
  number,
  title,
  url: `https://github.com/acme/web/issues/${number}`,
  labels: [label],
  assignees: [],
  author: 'octocat',
  milestone: null,
  type: null,
  fields: { Status: status, Size: size }
})

const DEMO: Board = {
  kind: 'ready',
  project: PROJECT,
  issues: [
    issue(48, 'Add a dark mode toggle to settings', 'ui', 'S', 'In progress'),
    issue(47, 'Cache search results for repeat queries', 'performance', 'M', 'In progress'),
    issue(45, 'Fix the date picker on Safari', 'bug', 'XS'),
    issue(44, 'Show a progress bar during uploads', 'ui', 'M'),
    issue(41, 'Write the self-hosting guide', 'docs', 'L')
  ],
  sessions: {
    48: { worktreeId: 'demo::/w/issue-48', name: 'issue-48-add-a-dark-mode', agent: 'claude' },
    47: { worktreeId: 'demo::/w/issue-47', name: 'issue-47-cache-search-results-for', agent: 'codex' }
  },
  states: ['Backlog', 'Ready', 'In progress', 'Done'],
  fields: ['Status', 'Size', 'Priority'],
  viewer: 'octocat'
}

const templates = { default: 'Complete {{issue_url}}', projects: [{ repo: PROJECT.repo, name: PROJECT.name, template: TEMPLATE }] }

export default defineCheck({
  demo: {
    storage: { templates },
    requests: {
      'project.active': () => PROJECT,
      'board.load': () => DEMO,
      'issue.start': () => null,
      'worktree.open': () => null
    }
  }
})
