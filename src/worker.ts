// Serves the Task Launcher panel and rewrites the agent's draft when an issue is started from Projects.
// Orca transpiles this file when it loads: no build step. Plugins have no host method for projects,
// issues or worktree creation, so the worker asks the `orca` and `gh` CLIs, which run as the same
// user. A hook failure passes, leaving Orca's default draft.
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import type { OrcaWorkerApi } from 'orca/worker'
import {
  activeProjectId,
  BOARDS_QUERY,
  boardLoadMessage,
  createArgs,
  defaultAgent,
  ISSUES_QUERY,
  NO_BOARDS,
  parseBoards,
  parseRepoIssues,
  sessionsFor
} from './board'
import { run } from './cli'
import { listProjects } from './projects'
import { TEMPLATES_KEY, type Board, type Issue, type ProjectRef } from './protocol'
import { applyIssueTemplate, parseIssueLaunch, pickTemplate, readTemplates, renderTemplate } from './rewrite'

// Orca keeps the person's settings here; `settings.defaultTuiAgent` is the new-workspace agent.
const ORCA_DATA = join(homedir(), 'Library/Application Support/orca/profiles/local-default/orca-data.json')
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

  async function loadBoard({ projectId }: { projectId: string }): Promise<Board> {
    let projects: ProjectRef[], psJson: string, listJson: string
    try {
      ;[projects, psJson, listJson] = await Promise.all([
        listProjects(log),
        run('orca', ['worktree', 'ps', '--json']),
        run('orca', ['worktree', 'list', '--json'])
      ])
    } catch (error) {
      log(`board.load: orca failed: ${(error as Error).message}`)
      return { kind: 'error', message: boardLoadMessage(error as Error, 'orca') }
    }
    const project = projects.find((p) => p.id === projectId)
    if (!project) {
      return { kind: 'no-project' }
    }
    const [owner, name] = project.repo.split('/')
    const graphql = (query: string) =>
      run('gh', ['api', 'graphql', '-f', `owner=${owner}`, '-f', `name=${name}`, '-f', `query=${query}`])
    // Boards are optional: without the read:project scope or any boards, the issues show without them.
    const boards = graphql(BOARDS_QUERY)
      .then(parseBoards)
      .catch((error: Error) => {
        log(`board.load: no board fields: ${error.message}`)
        return NO_BOARDS
      })
    let issuesJson: string
    try {
      issuesJson = await graphql(ISSUES_QUERY)
    } catch (error) {
      log(`board.load: gh failed: ${(error as Error).message}`)
      return { kind: 'error', message: boardLoadMessage(error as Error, 'gh') }
    }
    const { issues, states, fields, viewer } = parseRepoIssues(issuesJson, await boards)
    return { kind: 'ready', project, issues, sessions: sessionsFor(project.id, listJson, psJson), states, fields, viewer }
  }

  async function readDefaultAgent(): Promise<string | null> {
    try {
      return defaultAgent(await readFile(ORCA_DATA, 'utf8'))
    } catch {
      log('could not read Orca settings, so Start uses Claude')
      return defaultAgent(null)
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
    const agent = await readDefaultAgent()
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
  orca.panels.handle('board.load', loadBoard)
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
