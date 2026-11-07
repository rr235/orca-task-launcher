// Pure rewrite of an agent launch command. A Projects issue pick launches the agent with the issue
// URL as its only `--prefill` draft, so that exact shape identifies the pick.
import { DEFAULT_TEMPLATES, type Templates } from './protocol'

const PREFILL_AT_END = /^(.*\s--prefill\s+)'((?:[^']|'\\'')*)'\s*$/s
const ISSUE_URL = /^https?:\/\/[^/\s]+\/([^/\s]+\/[^/\s]+)\/issues\/(\d+)\/?$/

const unquote = (value: string): string => value.replaceAll(`'\\''`, `'`)
const quote = (value: string): string => `'${value.replaceAll(`'`, `'\\''`)}'`

export type IssueRef = { url: string; issue: string; repo: string }
export type IssueLaunch = IssueRef & { prefix: string }

/** The issue a launch was started from, or null when this launch is not an issue pick. */
export function parseIssueLaunch(command: string): IssueLaunch | null {
  const prefill = PREFILL_AT_END.exec(command)
  if (!prefill) {
    return null
  }
  const url = unquote(prefill[2]).trim()
  const issue = ISSUE_URL.exec(url)
  return issue ? { prefix: prefill[1], url, issue: issue[2], repo: issue[1] } : null
}

/** Stored templates, or the defaults when storage is empty or holds another shape. */
export function readTemplates(value: unknown): Templates {
  const stored = value as Partial<Templates> | null
  if (!stored || typeof stored.default !== 'string' || !Array.isArray(stored.projects)) {
    return DEFAULT_TEMPLATES
  }
  return {
    default: stored.default,
    projects: stored.projects.filter(
      (p) => typeof p?.repo === 'string' && typeof p.name === 'string' && typeof p.template === 'string'
    )
  }
}

/** The project's template when it has one, else the default; null when both are blank. */
export function pickTemplate(templates: Templates, repo: string): string | null {
  const project = templates.projects.find((p) => p.repo.toLowerCase() === repo.toLowerCase() && p.template.trim())
  return project?.template.trim() || templates.default.trim() || null
}

export function renderTemplate(template: string, issue: IssueRef): string {
  return template
    .replaceAll('{{issue_url}}', issue.url)
    .replaceAll('{{issue_number}}', issue.issue)
    .replaceAll('{{repo}}', issue.repo)
}

/** The command with the chosen template as its draft, or null to leave the launch unchanged. */
export function applyIssueTemplate(command: string, templates: Templates): string | null {
  const launch = parseIssueLaunch(command)
  const template = launch ? pickTemplate(templates, launch.repo) : null
  return launch && template ? `${launch.prefix}${quote(renderTemplate(template, launch))}` : null
}
