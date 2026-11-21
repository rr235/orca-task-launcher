// The panel <-> worker contract and the stored template shape, read by both sides.

/** An Orca project backed by a GitHub repo: `id` is Orca's project id, `repo` is `owner/name`. */
export type ProjectRef = { id: string; repo: string; name: string }
/** A stored per-project template; matched by `repo`, so renaming the project in Orca keeps it. */
export type ProjectTemplate = { repo: string; name: string; template: string }
export type Templates = { default: string; projects: ProjectTemplate[] }

export const TEMPLATES_KEY = 'templates'
export const DEFAULT_TEMPLATES: Templates = { default: 'Complete {{issue_url}}', projects: [] }

/** An open GitHub issue, from the repo alone. */
export type Issue = {
  number: number
  title: string
  url: string
  labels: string[]
  assignees: string[]
  author: string | null
  milestone: string | null
  type: string | null
}
/** What the owner's GitHub project boards add to the issues: optional, loaded after them. */
export type BoardFields = {
  /** The boards' own fields, such as Status and Size, in board order. */
  fields: string[]
  /** The boards' Status options, in board order. */
  states: string[]
  /** Each issue's values on the boards, by issue number and field name. */
  values: Record<number, Record<string, string>>
}
/** A top-level agent session: `key` is its Orca pane, `title` its name as Orca shows it, `chat` whether it runs in a chat tab, `working` whether the agent is mid-turn. */
export type AgentSession = { key: string; title: string; agent: string | null; chat: boolean; working: boolean }
/** The Orca worktree already linked to an issue, its branch, and the agent sessions running in it. */
export type Session = { worktreeId: string; name: string; branch: string | null; path: string | null; agents: AgentSession[] }

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
      /** The GitHub login `gh` is signed in as, for "Assigned to me". */
      viewer: string | null
    }

declare module 'orca' {
  interface PluginRequests {
    /** The project of the worktree selected in the sidebar and its issues' sessions, fast: no GitHub call. */
    'project.active': { output: { project: ProjectRef | null; sessions: Record<number, Session> } }
    /** The issue list for the project of the focused workspace. */
    'issues.load': { input: { projectId: string }; output: IssueList }
    /** The repo's GitHub project board fields; rejects when the board query fails. */
    'boardFields.load': { input: { repo: string }; output: BoardFields }
    /** Creates a worktree for the issue and starts the default agent on the rendered template. */
    'issue.start': { input: { projectId: string; repo: string; issue: Issue }; output: null }
    /** Shows the worktree, then brings the session's tab to the front where Orca allows it. */
    'session.focus': { input: { worktreeId: string; path: string | null; key: string }; output: null }
    /** The plugin's version from its manifest; null when it cannot be read. */
    'plugin.version': { output: string | null }
  }
}
