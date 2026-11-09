// Pure reads of the `orca` and `gh` CLI output the issue list is built from, and the worktree create
// command a Start runs. The worker does the I/O; everything here is testable without it.
import type { BoardFields, Issue, Session } from './protocol'

type WorktreeRow = {
  id?: string
  projectId?: string
  displayName?: string
  linkedIssue?: number | null
  isArchived?: boolean
}
type PsRow = { worktreeId?: string; isActive?: boolean; agents?: { agentType?: string | null }[] }

const worktreeRows = (listJson: string): WorktreeRow[] =>
  (JSON.parse(listJson) as { result?: { worktrees?: WorktreeRow[] } }).result?.worktrees ?? []
const psRows = (psJson: string): PsRow[] =>
  (JSON.parse(psJson) as { result?: { worktrees?: PsRow[] } }).result?.worktrees ?? []

/** Orca's project id for the worktree selected in the sidebar, or null when none is selected. */
export function activeProjectId(psJson: string, listJson: string): string | null {
  const active = psRows(psJson).find((row) => row.isActive)?.worktreeId
  if (!active) {
    return null
  }
  return worktreeRows(listJson).find((row) => row.id === active)?.projectId ?? null
}

/** The live worktree linked to each issue of the project, with the agent running in it. */
export function sessionsFor(projectId: string, listJson: string, psJson: string): Record<number, Session> {
  const agents = new Map(psRows(psJson).map((row) => [row.worktreeId, row.agents?.[0]?.agentType ?? null]))
  const sessions: Record<number, Session> = {}
  for (const row of worktreeRows(listJson)) {
    if (row.projectId !== projectId || row.isArchived || !row.linkedIssue || !row.id) {
      continue
    }
    sessions[row.linkedIssue] = {
      worktreeId: row.id,
      name: row.displayName ?? `issue-${row.linkedIssue}`,
      agent: agents.get(row.id) ?? null
    }
  }
  return sessions
}

// The issues come from the repo alone. Project boards are optional and load separately: BOARDS_QUERY
// needs the `read:project` scope and boards to exist, and the issues never wait on it.

/** A repo's open issues with what the panel shows and filters by, and the signed-in login. */
export const ISSUES_QUERY = `query($owner: String!, $name: String!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    issues(states: OPEN, first: 100, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes {
        number
        title
        url
        author { login }
        assignees(first: 10) { nodes { login } }
        milestone { title }
        issueType { name }
        labels(first: 20) { nodes { name } }
      }
    }
  }
}`

/** The same issues' values on the owner's project boards, and those boards' fields and Status options. */
export const BOARDS_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    issues(states: OPEN, first: 100, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes {
        number
        projectItems(first: 10) {
          nodes {
            project { id }
            fieldValues(first: 30) {
              nodes {
                ... on ProjectV2ItemFieldSingleSelectValue { name field { ...FieldName } }
                ... on ProjectV2ItemFieldTextValue { text field { ...FieldName } }
                ... on ProjectV2ItemFieldNumberValue { number field { ...FieldName } }
                ... on ProjectV2ItemFieldDateValue { date field { ...FieldName } }
                ... on ProjectV2ItemFieldIterationValue { title field { ...FieldName } }
              }
            }
          }
        }
      }
    }
    owner {
      ... on Organization { projectsV2(first: 20) { nodes { ...Board } } }
      ... on User { projectsV2(first: 20) { nodes { ...Board } } }
    }
  }
}
fragment FieldName on ProjectV2FieldConfiguration {
  ... on ProjectV2FieldCommon { name }
}
fragment Board on ProjectV2 {
  id
  closed
  fields(first: 50) { nodes { ... on ProjectV2FieldCommon { name dataType } } }
  field(name: "Status") { ... on ProjectV2SingleSelectField { options { name } } }
}`

/** What the panel says when the issues cannot load, from the error the CLI run gave. */
export function loadErrorMessage(error: { message?: string; notFound?: boolean }, tool: 'orca' | 'gh'): string {
  const message = error.message ?? ''
  if (tool === 'orca') {
    return 'Could not reach the Orca CLI. Check that Orca is running, then try again.'
  }
  if (error.notFound) {
    return 'The GitHub CLI (gh) was not found. Install it, run gh auth login, then try again.'
  }
  if (/gh auth login|Bad credentials|HTTP 401/i.test(message)) {
    return 'gh is not signed in. Run gh auth login in a terminal, then try again.'
  }
  return `GitHub could not load the issues: ${message.replace(/^gh:\s*/, '') || 'unknown error'}`
}

// Field types a board owner adds and fills in; the rest mirror the issue itself.
const OWN_FIELD_TYPES = new Set(['SINGLE_SELECT', 'TEXT', 'NUMBER', 'DATE', 'ITERATION'])

type Named = { name?: string } | null
type FieldValue = {
  name?: string
  text?: string
  number?: number | null
  date?: string
  title?: string
  field?: { name?: string } | null
} | null
type GqlIssue = {
  number?: number
  title?: string
  url?: string
  author?: { login?: string } | null
  assignees?: { nodes?: ({ login?: string } | null)[] }
  milestone?: { title?: string } | null
  issueType?: Named
  labels?: { nodes?: Named[] }
  projectItems?: { nodes?: ({ project?: { id?: string }; fieldValues?: { nodes?: FieldValue[] } } | null)[] }
}
type GqlBoard = {
  id?: string
  closed?: boolean
  fields?: { nodes?: ({ name?: string; dataType?: string } | null)[] }
  field?: { options?: Named[] } | null
} | null
type GqlResponse = {
  errors?: { message?: string }[]
  data?: {
    viewer?: { login?: string } | null
    repository?: { issues?: { nodes?: (GqlIssue | null)[] }; owner?: { projectsV2?: { nodes?: GqlBoard[] } } }
  }
}

const names = (list: Named[] | undefined): string[] => (list ?? []).flatMap((n) => (n?.name ? [n.name] : []))

function valueOf(value: FieldValue): string | null {
  if (!value) {
    return null
  }
  if (value.name ?? value.text ?? value.date ?? value.title) {
    return (value.name ?? value.text ?? value.date ?? value.title) as string
  }
  return typeof value.number === 'number' ? String(value.number) : null
}

/** Each field's value on the issue's boards; the first board that sets a field wins. */
function fieldsOf(issue: GqlIssue, own: Set<string>, boards: Set<string>): Record<string, string> {
  const fields: Record<string, string> = Object.create(null)
  for (const item of issue.projectItems?.nodes ?? []) {
    if (!item?.project?.id || !boards.has(item.project.id)) {
      continue
    }
    for (const value of item?.fieldValues?.nodes ?? []) {
      const field = value?.field?.name
      const text = valueOf(value)
      if (field && text && own.has(field) && !(field in fields)) {
        fields[field] = text
      }
    }
  }
  return { ...fields }
}

function dataOf(json: string): NonNullable<GqlResponse['data']> & { repository: { issues: { nodes: (GqlIssue | null)[] } } } {
  const response = JSON.parse(json) as GqlResponse
  if (response.errors?.length) {
    throw new Error(response.errors.map((error) => error.message ?? 'GitHub query failed').join('; '))
  }
  if (!response.data?.repository?.issues?.nodes) {
    throw new Error('GitHub did not return the repository issues.')
  }
  return response.data as ReturnType<typeof dataOf>
}

export const NO_BOARDS: BoardFields = { fields: [], states: [], values: {} }

/** The open boards' own fields and states, and each issue's values on them, from BOARDS_QUERY. */
export function parseBoards(json: string): BoardFields {
  const repository = dataOf(json).repository
  const boards = (repository.owner?.projectsV2?.nodes ?? []).filter((b) => b && !b.closed)
  const fields = [
    ...new Set(
      boards.flatMap((b) =>
        (b?.fields?.nodes ?? []).flatMap((f) => (f?.name && f.dataType && OWN_FIELD_TYPES.has(f.dataType) ? [f.name] : []))
      )
    )
  ]
  const own = new Set(fields)
  const boardIds = new Set(boards.flatMap((b) => (b?.id ? [b.id] : [])))
  const values: Record<number, Record<string, string>> = {}
  for (const issue of repository.issues.nodes) {
    if (issue?.number) {
      values[issue.number] = fieldsOf(issue, own, boardIds)
    }
  }
  return { fields, states: [...new Set(boards.flatMap((b) => names(b?.field?.options)))], values }
}

/** The repo's open issues and the signed-in login, from ISSUES_QUERY. */
export function parseRepoIssues(json: string): { issues: Issue[]; viewer: string | null } {
  const data = dataOf(json)
  const issues = data.repository.issues.nodes.flatMap((issue): Issue[] => {
    if (!issue?.number || !issue.title || !issue.url) {
      return []
    }
    return [
      {
        number: issue.number,
        title: issue.title,
        url: issue.url,
        labels: names(issue.labels?.nodes),
        assignees: (issue.assignees?.nodes ?? []).flatMap((a) => (a?.login ? [a.login] : [])),
        author: issue.author?.login ?? null,
        milestone: issue.milestone?.title ?? null,
        type: issue.issueType?.name ?? null
      }
    ]
  })
  return { issues, viewer: data.viewer?.login ?? null }
}

const AGENT_LABELS: Record<string, string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', gemini: 'Gemini' }

export const agentLabel = (agent: string): string =>
  AGENT_LABELS[agent] ?? agent.charAt(0).toUpperCase() + agent.slice(1)

/** `issue-<n>-<first four words of the title>`, the worktree and branch name. */
export function worktreeName(issue: Pick<Issue, 'number' | 'title'>): string {
  const words = issue.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .split('-')
    .filter(Boolean)
    .slice(0, 4)
  return ['issue', String(issue.number), ...words].join('-')
}

/** Arguments for `orca worktree create`: a top-level worktree linked to the issue. */
export function createArgs(input: {
  projectId: string
  issue: Pick<Issue, 'number' | 'title'>
  agent: string | null
  prompt: string
}): string[] {
  const args = [
    'worktree',
    'create',
    '--project',
    input.projectId,
    '--name',
    worktreeName(input.issue),
    '--issue',
    String(input.issue.number),
    '--no-parent',
    '--json'
  ]
  return input.agent ? [...args, '--agent', input.agent, '--prompt', input.prompt] : args
}
