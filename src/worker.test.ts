// Runs the hook as Orca would, with this worker as the only plugin in the chain.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { execFileSync } from 'node:child_process'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { mock } from 'node:test'
import { BOARDS_QUERY, ISSUES_QUERY } from './issues'
import { parseProjectList } from './projects'
import { TEMPLATES_KEY, type Templates } from './protocol'
import { applyIssueTemplate, readTemplates } from './rewrite'
import * as main from './worker'

const URL = 'https://github.com/acme/web/issues/14'
const launch = (command: string) => ({
  agent: 'claude',
  workspaceId: 'repo::/tmp/issue-14',
  workspaceKind: 'worktree' as const,
  terminalId: 'term_1',
  command,
  env: {}
})
const withTemplates = (templates?: Templates) => ({
  host: mockHost({
    capabilities: ['storage:own'],
    storage: templates ? { [TEMPLATES_KEY]: templates } : {}
  }),
  hooks: ['agent.launch.before']
})
const TEMPLATES: Templates = {
  default: 'Default #{{issue_number}}',
  projects: [
    { repo: 'acme/web', name: 'Web', template: 'Plan #{{issue_number}} in {{repo}}:\n{{issue_url}}' },
    { repo: 'acme/docs', name: 'Docs', template: '  ' }
  ]
}

type Worker = Awaited<ReturnType<typeof mountWorker>>

/** Runs `body` against the worker with the `orca` and `gh` CLIs stubbed: each GraphQL query is
 *  recorded with its owner and name, and answered by `answer`. */
async function withCli(answer: (query: string) => string, body: (worker: Worker, queries: string[][]) => Promise<void>) {
  const queries: string[][] = []
  const stub = mock.method(childProcess, 'execFile', (_file, args, _options, callback) => {
    const query = args.find((arg: string) => arg.startsWith('query='))?.slice(6)
    let stdout: string
    if (query) {
      queries.push(args.filter((arg: string) => /^(owner|name)=/.test(arg)).concat(query))
      stdout = answer(query)
    } else if (args[0] === 'project') {
      stdout = JSON.stringify({ result: { projects: [{ id: 'github:acme/web', displayName: 'Web', providerIdentity: { owner: 'acme', repo: 'web' } }] } })
    } else {
      stdout = JSON.stringify({ result: { worktrees: [] } })
    }
    callback(null, stdout, '')
    return {} as ReturnType<typeof childProcess.execFile>
  })
  syncBuiltinESMExports()
  const worker = await mountWorker(main, withTemplates())
  try {
    await body(worker, queries)
  } finally {
    await worker.deactivate()
    stub.mock.restore()
    syncBuiltinESMExports()
  }
}

test('issues load from the repo alone, never waiting on boards, and report required response failures', async () => {
  let issues = JSON.stringify({ data: { repository: { issues: { nodes: [{ number: 14, title: 'Fix', url: URL }] } } } })
  await withCli(
    (query) => (query === ISSUES_QUERY ? issues : JSON.stringify({ errors: [{ message: 'read:project scope required' }] })),
    async (worker, queries) => {
      const first = await worker.request('issues.load', { projectId: 'github:acme/web' })
      assert.equal(first.kind, 'ready')
      if (first.kind === 'ready') {
        assert.equal(first.issues.length, 1)
      }
      assert.deepEqual(queries, [['owner=acme', 'name=web', ISSUES_QUERY]])
      for (const response of [{ data: { repository: null } }, { errors: [{ message: 'Repository access denied' }] }]) {
        issues = JSON.stringify(response)
        const failed = await worker.request('issues.load', { projectId: 'github:acme/web' })
        assert.equal(failed.kind, 'error')
        if (failed.kind === 'error') {
          assert.match(failed.message, /GitHub could not load the issues:/)
          assert.match(failed.message, /repository issues|Repository access denied/)
        }
      }
      assert.ok(queries.every((query) => query.at(-1) !== BOARDS_QUERY))
    }
  )
})

test('board fields load on their own request, and a failed board query rejects', async () => {
  const board = {
    data: {
      repository: {
        issues: {
          nodes: [
            {
              number: 14,
              projectItems: { nodes: [{ project: { id: 'b1' }, fieldValues: { nodes: [{ name: 'Ready', field: { name: 'Status' } }] } }] }
            }
          ]
        },
        owner: {
          projectsV2: {
            nodes: [{ id: 'b1', closed: false, fields: { nodes: [{ name: 'Status', dataType: 'SINGLE_SELECT' }] }, field: { options: [{ name: 'Ready' }] } }]
          }
        }
      }
    }
  }
  let boardResponse = JSON.stringify(board)
  await withCli(
    () => boardResponse,
    async (worker, queries) => {
      assert.deepEqual(await worker.request('boardFields.load', { repo: 'acme/web' }), {
        fields: ['Status'],
        states: ['Ready'],
        values: { 14: { Status: 'Ready' } }
      })
      assert.deepEqual(queries, [['owner=acme', 'name=web', BOARDS_QUERY]])
      for (const response of [JSON.stringify({ errors: [{ message: 'read:project scope required' }] }), 'invalid JSON']) {
        boardResponse = response
        await assert.rejects(worker.request('boardFields.load', { repo: 'acme/web' }))
      }
    }
  )
})

test('shell metacharacters in templates stay literal draft text', () => {
  const draft = "Don't run $(printf injected); `printf injected` \"quoted\"\nnext line"
  const command = applyIssueTemplate(`printf '%s' --prefill '${URL}'`, { default: draft, projects: [] })!
  assert.equal(execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8' }), `--prefill${draft}`)
})

test('a project template turns an issue pick into its rendered draft, without logging', async () => {
  const worker = await mountWorker(main, withTemplates(TEMPLATES))
  const event = launch(`claude --dangerously-skip-permissions --prefill '${URL}'`)
  assert.deepEqual(await worker.hooks.fire('agent.launch.before', event), {
    kind: 'continue',
    event: {
      ...event,
      command: `claude --dangerously-skip-permissions --prefill 'Plan #14 in acme/web:\n${URL}'`
    }
  })
  assert.deepEqual(worker.logs, [])
  await worker.deactivate()
})

test('nothing stored yet uses the built-in default', async () => {
  const worker = await mountWorker(main, withTemplates())
  const event = launch(`claude --prefill '${URL}'`)
  assert.deepEqual(await worker.hooks.fire('agent.launch.before', event), {
    kind: 'continue',
    event: { ...event, command: `claude --prefill 'Complete ${URL}'` }
  })
  await worker.deactivate()
})

test('leaves every other launch unchanged', async () => {
  const worker = await mountWorker(main, withTemplates(TEMPLATES))
  for (const command of [
    'claude --dangerously-skip-permissions',
    `claude --prefill 'my own note ${URL}'`,
    `claude --prefill '${URL.replace('issues', 'pull')}'`,
    `claude '${URL}'`
  ]) {
    const event = launch(command)
    assert.deepEqual(await worker.hooks.fire('agent.launch.before', event), { kind: 'continue', event })
  }
  await worker.deactivate()
})

test('a blank project template falls back to the default, matching the repo in any case', () => {
  const draft = (url: string) => applyIssueTemplate(`claude --prefill '${url}'`, TEMPLATES)
  assert.equal(draft('https://github.com/acme/Docs/issues/3'), `claude --prefill 'Default #3'`)
  assert.equal(draft('https://github.com/ACME/Web/issues/1')?.startsWith(`claude --prefill 'Plan #1`), true)
})

test('blank default and no project template keeps the launch unchanged', () => {
  assert.equal(applyIssueTemplate(`claude --prefill '${URL}'`, { default: ' ', projects: [] }), null)
})

test('storage of another shape reads as the defaults', () => {
  assert.equal(readTemplates({ default: 3 }).default, 'Complete {{issue_url}}')
})

test('reads GitHub-backed projects from orca project list output', () => {
  const json = JSON.stringify({
    result: {
      projects: [
        { displayName: 'Web', providerIdentity: { owner: 'acme', repo: 'web' } },
        { displayName: 'Notes', kind: 'folder' }
      ]
    }
  })
  assert.deepEqual(parseProjectList(json), [{ id: 'github:acme/web', repo: 'acme/web', name: 'Web' }])
})
