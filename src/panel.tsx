// The Task Launcher panel: the prompt template of the focused workspace's project, which fields each
// issue card shows, filters, and the project's open issues, each with Start. No build step: Orca
// strips the types and compiles the JSX when it loads. Template edits save to the plugin's storage
// after a pause, where Start and the hook read them.
import {
  atom,
  Badge,
  Box,
  Button,
  Checkbox,
  Code,
  Collapsible,
  EmptyState,
  IconButton,
  Link,
  on,
  plugin,
  read,
  Row,
  Select,
  set,
  Spinner,
  Stack,
  storage,
  Text,
  Textarea,
  update,
  type PanelContext
} from 'orca'
import { agentLabel, NO_BOARDS } from './issues'
import { TEMPLATES_KEY, type BoardFields, type Issue, type IssueList, type ProjectRef, type Templates } from './protocol'
import { readTemplates } from './rewrite'

const SAVE_DELAY_MS = 600
// Actual GitHub values are encoded separately from the filter controls.
const ANY = '*any'
const NONE = '*none'
const ME = '*me'

type ReadyIssueList = Extract<IssueList, { kind: 'ready' }>
type CachedList = { list: ReadyIssueList; boards: BoardFields }
type Filters = { status: string; assignee: string; label: string; author: string; milestone: string; type: string }
type Display = { labels: boolean; fields: string[] }
type Sections = { template: boolean; display: boolean; filter: boolean }

const NO_FILTERS: Filters = { status: ANY, assignee: ANY, label: ANY, author: ANY, milestone: ANY, type: ANY }

// The last issue list of each project, kept across panel runs: reopening shows the selected project's
// own list at once while a fresh one loads, never another project's. Its board fields come along.
const cache = atom<Record<string, CachedList>>('issueLists', {}, { persist: 'plugin' })
// The project the worker last named as selected: on open, its cached list shows before the worker answers.
const lastProjectId = atom<string | null>('lastProjectId', null, { persist: 'plugin' })
const display = atom<Display>('display', { labels: true, fields: ['Size'] }, { persist: 'plugin' })
const filters = atom<Filters>('filters', NO_FILTERS, { persist: 'plugin', version: 2, migrate: () => NO_FILTERS })
const sections = atom<Sections>('sections', { template: true, display: false, filter: false }, { persist: 'plugin' })
const issueList = atom<IssueList | null>(null)
// The shown project's GitHub project board fields: they fill in after the issues and never block them.
const boards = atom<BoardFields>(NO_BOARDS)
const panelError = atom<string | null>(null)
const templates = atom<Templates | null>(null)
// Keyed by project and issue number, so another project's issue of the same number is unaffected.
const starting = atom<Record<string, boolean>>({})
const startErrors = atom<Record<string, string>>({})
const startKey = (project: ProjectRef, issue: Issue): string => `${project.id}#${issue.number}`

let saveTimer: ReturnType<typeof setTimeout> | null = null
let loadSeq = 0
// The project the shown list and board fields belong to, once the worker has named it.
let shownProject: ProjectRef | null = null
// Board answers can land out of order: an older one never replaces a newer one.
let boardSeq = 0
let boardApplied = 0
let saving: Promise<void> = Promise.resolve()
let pendingSaves = 0

/** Shows the project's cached list and board fields, unless its list is already shown. */
function showProject(project: ProjectRef | null): void {
  shownProject = project
  const shown = read(issueList)
  if (project && shown?.kind === 'ready' && shown.project.id === project.id && shown.project.repo === project.repo) {
    return
  }
  const cached = project ? read(cache)[project.id] : undefined
  const usable = Boolean(project && cached?.list.project.repo === project.repo)
  set(issueList, usable ? cached!.list : null)
  set(boards, usable ? cached!.boards : NO_BOARDS)
}

async function loadIssues(): Promise<void> {
  const seq = ++loadSeq
  // The shown list, on open the last project's cached one, stays until the selected project is known
  // and is swapped only when that project differs, so neither opening nor a refresh flashes a spinner.
  let project: ProjectRef | null = null
  try {
    project = await plugin.request('project.active', undefined, { timeoutMs: 15000 })
    if (seq !== loadSeq) {
      return
    }
    set(lastProjectId, project?.id ?? null)
    if (!project) {
      showProject(null)
      set(issueList, { kind: 'no-project' })
      set(panelError, null)
      return
    }
    showProject(project)
    void loadBoardFields(project)
    const next = await plugin.request('issues.load', { projectId: project.id }, { timeoutMs: 60000 })
    if (seq !== loadSeq) {
      return
    }
    if (next.kind === 'error') {
      set(panelError, next.message)
      return
    }
    set(issueList, next)
    set(panelError, null)
    if (next.kind === 'ready') {
      update(cache, (all) => ({ ...all, [next.project.id]: { list: next, boards: read(boards) } }))
    }
  } catch {
    if (seq === loadSeq) {
      if (!project) {
        // Without the selected project, the shown list may be another project's.
        showProject(null)
      }
      set(panelError, 'Could not load the issues.')
    }
  }
}

/** Fills in the project's board fields. A slow or failed board query leaves the list as it is. */
async function loadBoardFields(project: ProjectRef): Promise<void> {
  const seq = ++boardSeq
  let next: BoardFields
  try {
    next = await plugin.request('boardFields.load', { repo: project.repo }, { timeoutMs: 60000 })
  } catch {
    return
  }
  if (seq <= boardApplied || project.id !== shownProject?.id || project.repo !== shownProject.repo) {
    return
  }
  boardApplied = seq
  set(boards, next)
  update(cache, (all) => (all[project.id] ? { ...all, [project.id]: { ...all[project.id]!, boards: next } } : all))
}

async function loadTemplates(): Promise<void> {
  if (pendingSaves) {
    return
  }
  const before = read(templates)
  const stored = await storage.get(TEMPLATES_KEY)
  if (!pendingSaves && !saveTimer && read(templates) === before) {
    set(templates, readTemplates(stored))
  }
}

export function setup(ctx: PanelContext): () => void {
  ctx.subscriptions.push(
    // Orca first delivers the current context to each new subscriber, which makes the first load.
    on('workspace.changed', () => void loadIssues()),
    storage.onDidChange(({ key }) => {
      if (key === TEMPLATES_KEY) {
        void loadTemplates()
      }
    })
  )
  void loadTemplates()
  // Opening shows the last project's cached list at once; the first load swaps it if the project differs.
  const last = read(lastProjectId)
  const cached = last ? read(cache)[last] : undefined
  if (cached) {
    set(issueList, cached.list)
    set(boards, cached.boards)
  }
  return () => {
    ++loadSeq
    boardApplied = boardSeq
    shownProject = null
    if (saveTimer) {
      void saveTemplates().catch(() => {})
    }
  }
}

// Rows that show the whole template in the sidebar, where about 48 characters fit on a line.
const CHARS_PER_ROW = 48
const MIN_ROWS = 4
const MAX_ROWS = 24

function rowsFor(text: string): number {
  const rows = text.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / CHARS_PER_ROW)), 0)
  return Math.min(MAX_ROWS, Math.max(MIN_ROWS, rows + 1))
}

/** The project's own template, else the default every project starts from. */
function templateOf(all: Templates, project: ProjectRef): string {
  return all.projects.find((p) => p.repo.toLowerCase() === project.repo.toLowerCase())?.template ?? all.default
}

function editTemplate(project: ProjectRef, template: string): void {
  update(templates, (all) => {
    if (!all) {
      return all
    }
    const others = all.projects.filter((p) => p.repo.toLowerCase() !== project.repo.toLowerCase())
    return { ...all, projects: [...others, { repo: project.repo, name: project.name, template }] }
  })
  if (saveTimer) {
    clearTimeout(saveTimer)
  }
  saveTimer = setTimeout(() => {
    void saveTemplates().catch(() => set(panelError, 'Could not save the prompt template.'))
  }, SAVE_DELAY_MS)
}

async function saveTemplates(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  const next = read(templates)
  if (next) {
    ++pendingSaves
    saving = saving.catch(() => {}).then(() => storage.set(TEMPLATES_KEY, next))
    try {
      await saving
    } finally {
      --pendingSaves
    }
  }
}

async function start(project: ProjectRef, issue: Issue): Promise<void> {
  const key = startKey(project, issue)
  if (read(starting)[key]) {
    return
  }
  update(starting, (s) => ({ ...s, [key]: true }))
  update(startErrors, ({ [key]: _, ...rest }) => rest)
  let failed = false
  try {
    await saveTemplates()
    await plugin.request('issue.start', { projectId: project.id, repo: project.repo, issue }, { timeoutMs: 120000 })
  } catch {
    failed = true
  }
  // A create that timed out here can still finish in Orca, so the reloaded list decides what happened:
  // pressing Start again would make a second worktree.
  await loadIssues()
  const current = read(issueList)
  const landed = current?.kind === 'ready' && current.project.id === project.id && Boolean(current.sessions[issue.number])
  if (failed && !landed) {
    update(startErrors, (e) => ({ ...e, [key]: 'Could not confirm this start. Check Orca worktrees before retrying.' }))
  }
  update(starting, ({ [key]: _, ...rest }) => rest)
}

function openWorktree(worktreeId: string): void {
  void plugin.request('worktree.open', { worktreeId }).catch(() => set(panelError, 'Could not open the worktree.'))
}

function setFilter(key: keyof Filters, value: string): void {
  update(filters, (f) => ({ ...f, [key]: value }))
}

function toggleField(field: string, checked: boolean, boardFields: string[]): void {
  update(display, (d) => ({
    ...d,
    fields: checked ? boardFields.filter((f) => f === field || d.fields.includes(f)) : d.fields.filter((f) => f !== field)
  }))
}

// Status comes from the project boards, so without a board Status field there is nothing to filter.
const hasStatus = (board: BoardFields): boolean => board.fields.includes('Status')

/** The filters in use: a saved Status filter is ignored while the project has no board Status. */
const activeFilters = (board: BoardFields): Filters => (hasStatus(board) ? read(filters) : { ...read(filters), status: ANY })

/** The issue's values on the project boards, by field name. */
const valuesOf = (board: BoardFields, issue: Issue): Record<string, string> => board.values[issue.number] ?? {}

function matches(issue: Issue, values: Record<string, string>, f: Filters, viewer: string | null): boolean {
  const status = values.Status === undefined ? NONE : `=${values.Status}`
  const assigned =
    f.assignee === ANY ||
    (f.assignee === NONE ? issue.assignees.length === 0 : issue.assignees.includes(f.assignee === ME ? (viewer ?? '') : f.assignee.slice(1)))
  return (
    (f.status === ANY || status === f.status) &&
    assigned &&
    (f.label === ANY || issue.labels.includes(f.label.slice(1))) &&
    (f.author === ANY || issue.author === f.author.slice(1)) &&
    (f.milestone === ANY || (issue.milestone === null ? NONE : `=${issue.milestone}`) === f.milestone) &&
    (f.type === ANY || issue.type === f.type.slice(1))
  )
}

type Option = { value: string; label: string }

/** The given values as options, plus the current value when no issue has it any more. */
function options(first: Option[], values: (string | null)[], current: string, order?: string[]): Option[] {
  const present = [...new Set(values.filter((v): v is string => Boolean(v)))]
  const sorted = order ? order.filter((v) => present.includes(v)).concat(present.filter((v) => !order.includes(v))) : present.sort()
  const all = [...first, ...sorted.map((v) => ({ value: `=${v}`, label: v }))]
  return all.some((o) => o.value === current) ? all : [...all, { value: current, label: current.startsWith('=') ? current.slice(1) : current }]
}

function pill(text: string) {
  return (
    <Box border radius="full" paddingX="sm" paddingY="xs">
      <Text size="xs" muted>
        {text}
      </Text>
    </Box>
  )
}

function IssueCard({ project, issue, shown }: { project: ProjectRef; issue: Issue; shown: string[] }) {
  const ready = read(issueList)
  const session = ready?.kind === 'ready' ? ready.sessions[issue.number] : undefined
  const busy = read(starting)[startKey(project, issue)]
  const error = read(startErrors)[startKey(project, issue)]
  const values = valuesOf(read(boards), issue)
  return (
    <Box border radius="md" padding="sm">
      <Stack gap="xs">
        <Text size="sm">
          <Link href={issue.url}>#{issue.number}</Link> {issue.title}
        </Text>
        <Row justify="between" align="center" gap="xs" wrap>
          <Row gap="xs" align="center" wrap>
            {read(display).labels ? issue.labels.map((label) => <Badge tone="neutral">{label}</Badge>) : null}
            {shown.map((field) => (values[field] ? pill(values[field]) : null))}
          </Row>
          {session ? null : busy ? (
            <Spinner label={`Starting #${issue.number}`} labelHidden />
          ) : (
            <IconButton
              size="xs"
              variant="solid"
              tone="accent"
              icon="play"
              label={`Start #${issue.number}`}
              tooltip="Start"
              onPress={() => start(project, issue)}
            />
          )}
        </Row>
        {session ? (
          <Row justify="between" align="center" gap="xs" wrap>
            <Row gap="xs" align="center">
              <IconButton
                size="xs"
                variant="ghost"
                icon="branch"
                label={`Open ${session.name}`}
                tooltip={`Open ${session.name}`}
                onPress={() => openWorktree(session.worktreeId)}
              />
              <Text size="sm">
                <Link onPress={() => openWorktree(session.worktreeId)}>{session.name}</Link>
              </Text>
            </Row>
            {session.agent ? <Badge tone="success">{agentLabel(session.agent)}</Badge> : null}
          </Row>
        ) : null}
        {error ? (
          <Text size="sm" tone="danger">
            {error}
          </Text>
        ) : null}
      </Stack>
    </Box>
  )
}

function DisplayFields({ boardFields }: { boardFields: string[] }) {
  const d = read(display)
  return (
    <Stack gap="sm">
      <Checkbox label="Labels" checked={d.labels} onChange={(checked) => update(display, (v) => ({ ...v, labels: checked }))} />
      {boardFields.length ? (
        <Text size="sm" muted>
          Board fields
        </Text>
      ) : null}
      {boardFields.map((field) => (
        <Checkbox label={field} checked={d.fields.includes(field)} onChange={(checked) => toggleField(field, checked, boardFields)} />
      ))}
    </Stack>
  )
}

function FilterControls({ current, board, applied }: { current: ReadyIssueList; board: BoardFields; applied: number }) {
  const f = read(filters)
  const { issues } = current
  const statuses = issues.map((i) => valuesOf(board, i).Status ?? null)
  const hasNoMilestone = issues.some((i) => !i.milestone)
  return (
    <Stack gap="sm">
      {hasStatus(board) ? (
        <Select
          label="Status"
          value={f.status}
          onChange={(v) => setFilter('status', v)}
          options={options(
            [{ value: ANY, label: 'All states' }, ...(statuses.some((s) => !s) ? [{ value: NONE, label: 'No status' }] : [])],
            statuses,
            f.status,
            board.states
          )}
        />
      ) : null}
      <Select
        label="Assignee"
        value={f.assignee}
        onChange={(v) => setFilter('assignee', v)}
        options={options(
          [
            { value: ANY, label: 'Anyone' },
            ...(current.viewer ? [{ value: ME, label: 'Assigned to me' }] : []),
            { value: NONE, label: 'No assignee' }
          ],
          issues.flatMap((i) => i.assignees),
          f.assignee
        )}
      />
      <Select
        label="Label"
        value={f.label}
        onChange={(v) => setFilter('label', v)}
        options={options([{ value: ANY, label: 'Any label' }], issues.flatMap((i) => i.labels), f.label)}
      />
      <Select
        label="Author"
        value={f.author}
        onChange={(v) => setFilter('author', v)}
        options={options([{ value: ANY, label: 'Anyone' }], issues.map((i) => i.author), f.author)}
      />
      <Select
        label="Milestone"
        value={f.milestone}
        onChange={(v) => setFilter('milestone', v)}
        options={options(
          [{ value: ANY, label: 'Any milestone' }, ...(hasNoMilestone ? [{ value: NONE, label: 'No milestone' }] : [])],
          issues.map((i) => i.milestone),
          f.milestone
        )}
      />
      <Select
        label="Issue type"
        value={f.type}
        onChange={(v) => setFilter('type', v)}
        options={options([{ value: ANY, label: 'Any type' }], issues.map((i) => i.type), f.type)}
      />
      {applied ? (
        <Row>
          <Button size="xs" variant="ghost" icon="close" onPress={() => set(filters, NO_FILTERS)}>
            Clear all
          </Button>
        </Row>
      ) : null}
    </Stack>
  )
}

export default function Panel() {
  const current = read(issueList)
  const problem = read(panelError)
  if (problem && !current) {
    return (
      <Stack gap="sm">
        <Text tone="danger">{problem}</Text>
        <Row>
          <Button size="sm" variant="outline" icon="refresh" onPress={loadIssues}>
            Try again
          </Button>
        </Row>
      </Stack>
    )
  }
  const all = read(templates)
  if (!current || !all) {
    return <Spinner label="Loading issues" />
  }
  if (current.kind !== 'ready') {
    return (
      <EmptyState
        title="No GitHub project"
        description="Select a workspace of a GitHub-backed project in the sidebar."
        icon="branch"
      />
    )
  }
  const { project, issues } = current
  const board = read(boards)
  const f = activeFilters(board)
  const applied = (Object.keys(NO_FILTERS) as (keyof Filters)[]).filter((k) => f[k] !== ANY).length
  const visible = issues.filter((issue) => matches(issue, valuesOf(board, issue), f, current.viewer))
  const shown = board.fields.filter((field) => read(display).fields.includes(field))
  const open = read(sections)
  const toggle = (key: keyof Sections) => (value: boolean) => update(sections, (s) => ({ ...s, [key]: value }))
  return (
    <Stack gap="md">
      <Collapsible title="Prompt template" open={open.template} onChange={toggle('template')}>
        <Stack gap="xs">
          <Textarea
            label={`${project.name} prompt template`}
            labelHidden
            rows={rowsFor(templateOf(all, project))}
            value={templateOf(all, project)}
            onChange={(value) => editTemplate(project, value)}
          />
          <Text size="sm" muted>
            Variables: <Code>{'{{issue_url}}'}</Code> <Code>{'{{issue_number}}'}</Code> <Code>{'{{repo}}'}</Code>
          </Text>
        </Stack>
      </Collapsible>
      <Collapsible title="Display fields" open={open.display} onChange={toggle('display')}>
        <DisplayFields boardFields={board.fields} />
      </Collapsible>
      <Collapsible title={applied ? `Filter (${applied})` : 'Filter'} open={open.filter} onChange={toggle('filter')}>
        <FilterControls current={current} board={board} applied={applied} />
      </Collapsible>
      {problem ? (
        <Row justify="between" align="center" gap="xs" wrap>
          <Text size="sm" tone="danger">
            {problem}
          </Text>
          <Button size="xs" variant="ghost" icon="refresh" onPress={loadIssues}>
            Try again
          </Button>
        </Row>
      ) : null}
      {issues.length === 0 ? (
        <EmptyState title="No open issues" description={`${project.repo} has no open issues.`} icon="check" />
      ) : visible.length === 0 ? (
        <Text size="sm" muted>
          No issues match these filters.
        </Text>
      ) : (
        <Stack gap="xs">
          {visible.map((issue) => (
            <IssueCard project={project} issue={issue} shown={shown} />
          ))}
        </Stack>
      )}
    </Stack>
  )
}
