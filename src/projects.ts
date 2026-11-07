// Orca projects backed by GitHub repos. Plugins have no host method for projects, so the worker
// asks the `orca` CLI and keeps the answer for a few minutes.
import { run } from './cli'
import type { ProjectRef } from './protocol'

const CACHE_MS = 5 * 60 * 1000

type Project = { id?: string; displayName?: string; providerIdentity?: { owner?: string; repo?: string } }

let cache: { at: number; projects: ProjectRef[] } | null = null

/** GitHub-backed projects from `orca project list --json`, sorted by name. */
export function parseProjectList(json: string): ProjectRef[] {
  const projects = (JSON.parse(json) as { result?: { projects?: Project[] } }).result?.projects ?? []
  return projects
    .flatMap((project) => {
      const { owner, repo } = project.providerIdentity ?? {}
      return owner && repo && project.displayName
        ? [{ id: project.id ?? `github:${owner}/${repo}`, repo: `${owner}/${repo}`, name: project.displayName }]
        : []
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

export async function listProjects(log: (message: string) => void, refresh = false): Promise<ProjectRef[]> {
  if (!refresh && cache && Date.now() - cache.at < CACHE_MS) {
    return cache.projects
  }
  try {
    cache = { at: Date.now(), projects: parseProjectList(await run('orca', ['project', 'list', '--json'])) }
    return cache.projects
  } catch (error) {
    log(`could not read Orca projects: ${(error as Error).message}`)
    throw new Error('Could not read your Orca projects.')
  }
}
