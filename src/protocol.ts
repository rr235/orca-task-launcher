// The panel <-> worker contract and the stored template shape, read by both sides.

/** An Orca project backed by a GitHub repo: `id` is Orca's project id, `repo` is `owner/name`. */
export type ProjectRef = { id: string; repo: string; name: string }
/** A stored per-project template; matched by `repo`, so renaming the project in Orca keeps it. */
export type ProjectTemplate = { repo: string; name: string; template: string }
export type Templates = { default: string; projects: ProjectTemplate[] }

export const TEMPLATES_KEY = 'templates'
export const DEFAULT_TEMPLATES: Templates = { default: 'Complete {{issue_url}}', projects: [] }

/** An open GitHub issue, with its values on the owner's GitHub project boards keyed by field name. */
export type Issue = {
  number: number
  title: string
  url: string
  labels: string[]
  assignees: string[]
  author: string | null
  milestone: string | null
  type: string | null
  fields: Record<string, string>
}
/** The Orca worktree already linked to an issue, and the agent running in it. */
export type Session = { worktreeId: string; name: string; agent: string | null }

/** What the panel shows: the focused workspace's project, its open issues and their worktrees. */
export type IssueList =
  | { kind: 'no-project' }
  /** The issues could not load; `message` says why and what to do. */
  | { kind: 'error'; message: string }
  | {
      kind: 'ready'
      project: ProjectRef
      issues: Issue[]
      sessions: Record<number, Session>
      /** The boards' Status options, in board order. */
      states: string[]
      /** The boards' own fields, such as Status and Size, in board order. */
      fields: string[]
      /** The GitHub login `gh` is signed in as, for "Assigned to me". */
      viewer: string | null
    }

declare module 'orca' {
  interface PluginRequests {
    /** The project of the worktree selected in the sidebar, fast: no GitHub call. */
    'project.active': { output: ProjectRef | null }
    /** The issue list for the project of the focused workspace. */
    'issues.load': { input: { projectId: string }; output: IssueList }
    /** Creates a worktree for the issue and starts the default agent on the rendered template. */
    'issue.start': { input: { projectId: string; repo: string; issue: Issue }; output: null }
    /** Shows the worktree in Orca. */
    'worktree.open': { input: { worktreeId: string }; output: null }
  }
}
