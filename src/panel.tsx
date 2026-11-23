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
  EmptyState,
  Grid,
  env,
  IconButton,
  Image,
  Link,
  List,
  ListItem,
  on,
  plugin,
  read,
  Row,
  Select,
  Separator,
  set,
  shell,
  Spinner,
  Stack,
  storage,
  Text,
  Textarea,
  update,
  type JsonValue,
  type IconName,
  type OrcaNode,
  type PanelContext,
  type SelectProps
} from 'orca'
import { agentIcon, agentLabel, NO_BOARDS } from './issues'
import { TEMPLATES_KEY, type AgentSession, type BoardFields, type Issue, type IssueList, type ProjectRef, type Session, type Templates } from './protocol'
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
// A list cached by an older version has sessions without `agents` or `branch`: IssueCard allows for them.
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
// The stored templates, which Orca loads before the first render: opening never waits on a storage read.
// Read only; edits save through saveTemplates.
const storedTemplates = atom<JsonValue>(TEMPLATES_KEY, null, { persist: 'storage' })
// Keyed by project and issue number, so another project's issue of the same number is unaffected.
const starting = atom<Record<string, boolean>>({})
const startErrors = atom<Record<string, string>>({})
const startKey = (project: ProjectRef, issue: Issue): string => `${project.id}#${issue.number}`
// This run's version from the worker, never persisted: an update must not show the old one.
const pluginVersion = atom<string | null>(null)

const NEW_ISSUE = 'https://github.com/rr235/orca-task-launcher/issues/new'
const BUG_FORM = `${NEW_ISSUE}?template=bug_report.yml`
const FEATURE_FORM = `${NEW_ISSUE}?template=feature_request.yml`

/** The bug report form, with the plugin version filled in when it is known. */
export function bugReportUrl(version: string | null): string {
  return version ? `${BUG_FORM}&version=${encodeURIComponent(version)}` : BUG_FORM
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
let loadSeq = 0
// The project the shown list and board fields belong to, once the worker has named it.
let shownProject: ProjectRef | null = null
// Board answers can land out of order: an older one never replaces a newer one.
let boardSeq = 0
let boardApplied = 0
let saving: Promise<void> = Promise.resolve()
let pendingSaves = 0
// The project the latest load is for (null: none selected, undefined: unknown), and whether a
// check of the selected project is in flight.
let loadedProjectId: string | null | undefined
let checking = false

// Orca sends `workspace.changed` only when the branch, name or terminals differ, so switching
// between two `main` workspaces sends nothing. While the panel shows, the selected project is
// checked on this interval too.
const CHECK_INTERVAL_MS = 2000

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
    project = (await plugin.request('project.active', undefined, { timeoutMs: 15000 })).project
    if (seq !== loadSeq) {
      return
    }
    set(lastProjectId, project?.id ?? null)
    loadedProjectId = project?.id ?? null
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
        loadedProjectId = undefined
      }
      set(panelError, 'Could not load the issues.')
    }
  }
}

/** Reloads when the selected project is not the one the latest load is for, else refreshes its sessions. */
export async function checkActiveProject(): Promise<void> {
  if (checking) {
    return
  }
  const seq = loadSeq
  checking = true
  try {
    const { project, sessions } = await plugin.request('project.active', undefined, { timeoutMs: 15000 })
    if (seq !== loadSeq) {
      return
    }
    if ((project?.id ?? null) !== loadedProjectId) {
      void loadIssues()
      return
    }
    // Agents rename their sessions as they work, which sends no workspace event.
    const shown = read(issueList)
    if (project && shown?.kind === 'ready' && shown.project.id === project.id && JSON.stringify(shown.sessions) !== JSON.stringify(sessions)) {
      const next = { ...shown, sessions }
      set(issueList, next)
      update(cache, (all) => ({ ...all, [project.id]: { list: next, boards: read(boards) } }))
    }
  } catch {
    // The next check tries again.
  } finally {
    checking = false
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
  loadedProjectId = undefined
  const check = setInterval(() => {
    if (read(ctx.visible)) {
      void checkActiveProject()
    }
  }, CHECK_INTERVAL_MS)
  ctx.subscriptions.push(
    { dispose: () => clearInterval(check) },
    // Orca first delivers the current context to each new subscriber, which makes the first load.
    on('workspace.changed', () => void loadIssues()),
    storage.onDidChange(({ key }) => {
      if (key === TEMPLATES_KEY) {
        void loadTemplates()
      }
    })
  )
  set(templates, readTemplates(read(storedTemplates)))
  // Without an answer the link still opens the form, with the version left for the reporter.
  void plugin.request('plugin.version', undefined, { timeoutMs: 15000 }).then(
    (version) => set(pluginVersion, version),
    () => {}
  )
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

function openSession(session: Session, agent: AgentSession): void {
  void plugin
    .request('session.focus', { worktreeId: session.worktreeId, path: session.path ?? null, key: agent.key })
    .catch(() => set(panelError, 'Could not open the session.'))
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

// Icon sizes in pixels: an agent beside a session's name, and a detail icon beside its worktree or branch.
const AGENT_ICON_PX = 14
const DETAIL_ICON_PX = 12
// The plugin's rocket beside the project name above the prompt template.
const PROJECT_ICON_PX = 16
// The slot a working session's dot sits in, kept on every row.
const DOT_PX = 16

function Icon({ src, alt, px }: { src: string; alt: string; px: number }) {
  return (
    <Box width={px} minWidth={px} shrink={false}>
      <Image src={src} alt={alt} size="xs" />
    </Box>
  )
}

/**
 * An agent session as Orca's sidebar shows it: the agent's icon and the session's name, which opens it,
 * then a button that shows its tab (terminal, or chat for a chat). The button sits beside the ListItem,
 * which cannot hold other controls.
 */
function SessionLine({ session, agent }: { session: Session; agent: AgentSession }) {
  const icon = agentIcon(agent.agent)
  const open = () => openSession(session, agent)
  const label = `Show ${agent.title} tab`
  return (
    <Box direction="row" align="center" gap="none" minWidth={0}>
      <Box grow minWidth={0}>
        <List>
          <ListItem onPress={open}>
            <Box direction="row" align="center" gap="xs" minWidth={0}>
              {icon ? <Icon src={icon} alt={agentLabel(agent.agent ?? 'agent')} px={AGENT_ICON_PX} /> : null}
              <Box grow minWidth={0}>
                <Text size="sm" truncate>
                  {agent.title}
                </Text>
              </Box>
              {/* Every row keeps the dot's slot, so names end at the same place; only a working session has a dot. */}
              <Box direction="row" align="center" justify="center" width={DOT_PX} minWidth={DOT_PX} shrink={false}>
                {agent.working ? (
                  <Text size="xs" tone="success">
                    ●
                  </Text>
                ) : null}
              </Box>
            </Box>
          </ListItem>
        </List>
      </Box>
      {agent.chat ? (
        // Orca's IconButton has no chat icon, so a chat's button is a PNG drawn like the terminal button.
        <Box shrink={false}>
          <List>
            <ListItem onPress={open}>
              <Icon src={`assets/details/chat-tab-${env.theme.colorScheme}.png`} alt={label} px={24} />
            </ListItem>
          </List>
        </Box>
      ) : (
        <Box paddingX="sm" shrink={false}>
          <IconButton icon="terminal" label={label} tooltip={label} size="xs" variant="solid" tone="success" onPress={open} />
        </Box>
      )}
    </Box>
  )
}

/** The worktree or branch of an issue's session, or both when they share a name, muted under its agent sessions. */
const DETAIL_ALT = { worktree: 'Worktree', branch: 'Branch' } as const

function DetailLine({ icons, text }: { icons: (keyof typeof DETAIL_ALT)[]; text: string }) {
  return (
    <Box direction="row" align="center" gap="xs" minWidth={0} paddingX="sm">
      {icons.map((icon) => (
        <Icon src={`assets/details/${icon}-${env.theme.colorScheme}.png`} alt={DETAIL_ALT[icon]} px={DETAIL_ICON_PX} />
      ))}
      <Box grow minWidth={0}>
        <Text size="sm" muted truncate>
          {text}
        </Text>
      </Box>
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
          {session || busy ? null : (
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
          <Stack gap="none">
            {(session.agents ?? []).map((agent) => (
              <SessionLine session={session} agent={agent} />
            ))}
            {/* A branch named like its worktree shares the worktree's line. */}
            {session.branch === session.name ? (
              <DetailLine icons={['worktree', 'branch']} text={session.name} />
            ) : (
              <>
                <DetailLine icons={['worktree']} text={session.name} />
                {session.branch ? <DetailLine icons={['branch']} text={session.branch} /> : null}
              </>
            )}
          </Stack>
        ) : busy ? (
          <Row gap="xs" align="center">
            <Spinner label={`Starting #${issue.number}`} labelHidden />
            <Text size="sm" muted>
              Starting
            </Text>
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
    <Grid columns={2} gap="sm">
      <Checkbox label="Labels" checked={d.labels} onChange={(checked) => update(display, (v) => ({ ...v, labels: checked }))} />
      {/* Board fields, when the project has a board, are listed like Labels: no heading of their own. */}
      {boardFields.map((field) => (
        <Checkbox label={field} checked={d.fields.includes(field)} onChange={(checked) => toggleField(field, checked, boardFields)} />
      ))}
    </Grid>
  )
}

// How far an xs icon button's glyph sits inside its control slot, in pixels: descriptions start under the arrow.
const ICON_INSET_PX = 7

// A section header like Power Sessions': an arrow that points right when closed and down when open,
// then the section's icon and neutral title, and while open a one-line description above the content.
// A ListItem has one icon slot, so the arrow is its own button beside it, and only the arrow opens and closes.
function Section({
  title,
  icon,
  description,
  open,
  onToggle,
  children
}: {
  title: string
  icon: IconName
  description: string
  open: boolean
  onToggle: () => void
  children?: OrcaNode
}) {
  return (
    <Box shrink={false} gap="none">
      <Box direction="row" align="center" gap="none" minWidth={0}>
        <Box shrink={false}>
          <IconButton icon={open ? 'expand' : 'next'} label={`${open ? 'Close' : 'Open'} ${title}`} size="xs" variant="ghost" onPress={onToggle} />
        </Box>
        <Box grow minWidth={0}>
          <List>
            <ListItem icon={icon}>
              <Text weight="medium" tone="neutral">
                {title}
              </Text>
            </ListItem>
          </List>
        </Box>
      </Box>
      {open ? <SectionBody description={description}>{children}</SectionBody> : null}
    </Box>
  )
}

// A one-line description, then the content, inset by the arrow button's glyph inset so both start
// under a section's arrow.
function SectionBody({ description, children }: { description: string; children?: OrcaNode }) {
  return (
    <Box direction="row" gap="none" shrink={false}>
      <Box width={ICON_INSET_PX} minWidth={ICON_INSET_PX} shrink={false} />
      <Box grow minWidth={0}>
        <Stack gap="md">
          <Text size="sm" muted>
            {description}
          </Text>
          {children}
        </Stack>
      </Box>
    </Box>
  )
}

// Width of the label column, so every filter's dropdown starts at the same edge.
const FILTER_LABEL_PX = 96

// A filter dropdown on one row with its label in front, instead of the label stacked above it.
function FilterSelect(props: Omit<SelectProps, 'labelHidden'>) {
  return (
    <Box direction="row" align="center" gap="sm" minWidth={0}>
      <Box width={FILTER_LABEL_PX} minWidth={FILTER_LABEL_PX} shrink={false}>
        <Text size="sm">{props.label}</Text>
      </Box>
      <Box grow minWidth={0}>
        <Select {...props} labelHidden />
      </Box>
    </Box>
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
        <FilterSelect
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
      <FilterSelect
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
      <FilterSelect
        label="Label"
        value={f.label}
        onChange={(v) => setFilter('label', v)}
        options={options([{ value: ANY, label: 'Any label' }], issues.flatMap((i) => i.labels), f.label)}
      />
      <FilterSelect
        label="Author"
        value={f.author}
        onChange={(v) => setFilter('author', v)}
        options={options([{ value: ANY, label: 'Anyone' }], issues.map((i) => i.author), f.author)}
      />
      <FilterSelect
        label="Milestone"
        value={f.milestone}
        onChange={(v) => setFilter('milestone', v)}
        options={options(
          [{ value: ANY, label: 'Any milestone' }, ...(hasNoMilestone ? [{ value: NONE, label: 'No milestone' }] : [])],
          issues.map((i) => i.milestone),
          f.milestone
        )}
      />
      <FilterSelect
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

// Pinned below the scrolling content in every state, a failed load included.
function Feedback() {
  return (
    <Row justify="end" gap="xs">
      <IconButton
        icon="rocket"
        label="Request a feature"
        tooltip="Request a feature. Opens an external link to request a feature."
        variant="ghost"
        size="xs"
        onPress={() => void shell.openExternal(FEATURE_FORM)}
      />
      <IconButton
        icon="bug"
        label="Report a bug"
        tooltip="Report a bug. Opens an external link to file a bug."
        variant="ghost"
        size="xs"
        onPress={() => void shell.openExternal(bugReportUrl(read(pluginVersion)))}
      />
    </Row>
  )
}

export default function Panel() {
  return (
    <Box height="100%" gap="sm">
      <Box grow scroll="y">
        <PanelBody />
      </Box>
      <Feedback />
    </Box>
  )
}

function PanelBody() {
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
        title="No GitHub repository"
        description="Select a workspace with a GitHub repository to see the issues."
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
  const toggle = (key: keyof Sections) => () => update(sections, (s) => ({ ...s, [key]: !s[key] }))
  return (
    <Stack gap="md">
      {/* The sections sit a wider gap apart than the rest of the column, as in Power Sessions. */}
      <Stack gap="lg">
        <Section
          title="Prompt template"
          icon="bot"
          description="Set initial prompt at issue start per Orca project"
          open={open.template}
          onToggle={toggle('template')}
        >
          <Stack gap="md">
            <Row gap="xs" align="center">
              <Icon src="assets/icon.png" alt="" px={PROJECT_ICON_PX} />
              <Text size="md" muted>
                {project.name}
              </Text>
            </Row>
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
        </Section>
        <Separator />
        <Section title="Display fields" icon="layers" description="Fields to be shown inside the issue list below." open={open.display} onToggle={toggle('display')}>
          <DisplayFields boardFields={board.fields} />
        </Section>
        <Separator />
        <Section
          title={applied ? `Filter (${applied})` : 'Filter'}
          icon="filter"
          description="Narrow the issue list below."
          open={open.filter}
          onToggle={toggle('filter')}
        >
          <FilterControls current={current} board={board} applied={applied} />
        </Section>
        <Separator />
      </Stack>
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
