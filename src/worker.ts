// Serves the Task Launcher panel and rewrites the agent's draft when an issue is started from Projects.
// Orca transpiles this file when it loads: no build step. Plugins have no host method for projects,
// issues or worktree creation, so the worker asks the `orca` and `gh` CLIs, which run as the same
// user. A hook failure passes, leaving Orca's default draft.
import process from 'node:process'
import type { OrcaWorkerApi } from 'orca/worker'
import {
  activeProjectId,
  BOARDS_QUERY,
  loadErrorMessage,
  createArgs,
  ISSUES_QUERY,
  parseBoards,
  parseRepoIssues,
  sessionsFor
} from './issues'
import { run } from './cli'
import { listProjects } from './projects'
import { TEMPLATES_KEY, type BoardFields, type Issue, type IssueList, type ProjectRef } from './protocol'
import { applyIssueTemplate, parseIssueLaunch, pickTemplate, readTemplates, renderTemplate } from './rewrite'
import { readDefaultAgent } from './settings'

const CREATE_TIMEOUT_MS = 110000
const RETRY_AFTER_TIMEOUT_MS = 5 * 60 * 1000

export default function activate(orca: OrcaWorkerApi): void {
  const log = (message: string) => orca.log(message)

  async function activeProject(): Promise<{ project: ProjectRef | null; psJson: string; listJson: string }> {
    const [psJson, listJson] = await Promise.all([
      run('orca', ['worktree', 'ps', '--json']),
      run('orca', ['worktree', 'list', '--json'])
    ])
    const projectId = activeProjectId(psJson, listJson)
    let project = projectId ? ((await listProjects(log)).find((p) => p.id === projectId) ?? null) : null
    if (projectId && !project) {
      project = (await listProjects(log, true)).find((p) => p.id === projectId) ?? null
    }
    return { project, psJson, listJson }
  }

  const graphql = (repo: string, query: string) => {
    const [owner, name] = repo.split('/')
    return run('gh', ['api', 'graphql', '-f', `owner=${owner}`, '-f', `name=${name}`, '-f', `query=${query}`])
  }
  const orcaFailed = (error: unknown): IssueList => {
    log(`issues.load: orca failed: ${(error as Error).message}`)
    return { kind: 'error', message: loadErrorMessage(error as Error, 'orca') }
  }

  /** The repo's issues and their worktrees. Board fields never hold this up: see loadBoardFields. */
  async function loadIssues({ projectId }: { projectId: string }): Promise<IssueList> {
    const worktrees = Promise.all([run('orca', ['worktree', 'ps', '--json']), run('orca', ['worktree', 'list', '--json'])])
    // Awaited below; this keeps an early return from leaving the rejection unhandled.
    worktrees.catch(() => undefined)
    let project: ProjectRef | undefined
    try {
      project = (await listProjects(log)).find((p) => p.id === projectId)
    } catch (error) {
      return orcaFailed(error)
    }
    if (!project) {
      return { kind: 'no-project' }
    }
    // The issues query needs only the repo, so it runs while the worktree reads finish.
    const issuesJson = graphql(project.repo, ISSUES_QUERY)
    issuesJson.catch(() => undefined)
    let psJson: string, listJson: string
    try {
      ;[psJson, listJson] = await worktrees
    } catch (error) {
      return orcaFailed(error)
    }
    let loaded: ReturnType<typeof parseRepoIssues>
    try {
      loaded = parseRepoIssues(await issuesJson)
    } catch (error) {
      log(`issues.load: gh failed: ${(error as Error).message}`)
      return { kind: 'error', message: loadErrorMessage(error as Error, 'gh') }
    }
    return { kind: 'ready', project, issues: loaded.issues, sessions: sessionsFor(project.id, listJson, psJson), viewer: loaded.viewer }
  }

  /** The repo's project board fields. Boards are optional: without the read:project scope or any
   *  boards this rejects, and the panel keeps the list as it is. */
  async function loadBoardFields({ repo }: { repo: string }): Promise<BoardFields> {
    try {
      return parseBoards(await graphql(repo, BOARDS_QUERY))
    } catch (error) {
      log(`boardFields.load: no board fields: ${(error as Error).message}`)
      throw new Error('Could not load the board fields.')
    }
  }

  const starts = new Map<string, Promise<null>>()
  // When a create timed out, keyed by issue: Orca may still finish it, so a retry waits.
  const timedOut = new Map<string, number>()

  async function create(input: { projectId: string; repo: string; issue: Issue }): Promise<null> {
    const listJson = await run('orca', ['worktree', 'list', '--json'])
    if (sessionsFor(input.projectId, listJson, '{}')[input.issue.number]) {
      return null
    }
    const key = `${input.projectId}#${input.issue.number}`
    if (Date.now() - (timedOut.get(key) ?? 0) < RETRY_AFTER_TIMEOUT_MS) {
      throw new Error('The last Start for this issue timed out and may still finish. Try again in a few minutes.')
    }
    const templates = readTemplates(await orca.storage.get(TEMPLATES_KEY))
    const template = pickTemplate(templates, input.repo) ?? input.issue.url
    const prompt = renderTemplate(template, {
      url: input.issue.url,
      issue: String(input.issue.number),
      repo: input.repo
    })
    const agent = await readDefaultAgent(log)
    try {
      await run('orca', createArgs({ projectId: input.projectId, issue: input.issue, agent, prompt }), CREATE_TIMEOUT_MS)
    } catch (error) {
      if ((error as { timedOut?: boolean }).timedOut) {
        timedOut.set(key, Date.now())
      }
      throw error
    }
    return null
  }

  orca.panels.handle('project.active', async () => (await activeProject()).project)
  orca.panels.handle('issues.load', loadIssues)
  orca.panels.handle('boardFields.load', loadBoardFields)
  orca.panels.handle('issue.start', (input) => {
    const key = `${input.projectId}#${input.issue.number}`
    const existing = starts.get(key)
    if (existing) {
      return existing
    }
    const pending = create(input).finally(() => starts.delete(key))
    starts.set(key, pending)
    return pending
  })
  orca.panels.handle('worktree.open', async ({ worktreeId }) => {
    await run('orca', ['worktree', 'activate', '--worktree', `id:${worktreeId}`, '--json'])
    return null
  })

  orca.hooks.on('agent.launch.before', async (event, next) => {
    if (process.platform === 'win32' || !parseIssueLaunch(event.command)) {
      return undefined
    }
    const command = applyIssueTemplate(event.command, readTemplates(await orca.storage.get(TEMPLATES_KEY)))
    return command ? next({ ...event, command }) : undefined
  })
}
