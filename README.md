# Task Launcher

Turn GitHub issues into active coding sessions, right from Orca’s sidebar. Choose an issue,
give your agent a prompt, and start working in a dedicated branch and worktree.

![Task Launcher in dark and light themes](assets/cover.png)

## Features

- **Browse issues in Orca.** See open GitHub issues for your selected project without switching apps.
- **Start work with one click.** Launch your default coding agent in a dedicated branch and worktree linked to the issue.
- **Make prompts your own.** Save a separate prompt template for each project to guide how your agent approaches the work.
- **Use your prompt from Tasks too.** Starting an issue from Orca’s Tasks view fills the agent’s input with your template, ready to edit.
- **Find what matters.** Filter by assignee, label, milestone, author, or issue type, and by status when you use GitHub Projects.
- **Keep track of progress.** See linked worktrees and running agents, and jump back into ongoing work.
- **Bring in GitHub Projects.** Choose which available board fields appear alongside your issues.

## Get started

Requires **Orca 1.4.248+** and **GitHub CLI (`gh`)** signed in with access to your repository.

Install Task Launcher from the Orca community catalog:

- [Open in Orca](https://onorca.dev/plugins/rr235.task-launcher?catalog=community)
- [Plugin page](https://onorca.dev/plugins/rr235/orca-task-launcher)

Orca asks to add the community catalog if you haven’t yet. Review the requested access, then
press **Install**. Orca keeps it updated.

Once installed:

1. In Orca’s left sidebar, select a workspace of a project whose repository is on GitHub.
2. Open **Task Launcher**, the rocket panel in the right sidebar.
3. Set your prompt template and press **Start** (the play button) on an issue.

Your agent receives the prompt and starts in the linked worktree.

## Your prompt, every time

Templates save automatically for each project. Start with `Complete {{issue_url}}`, or add
your own instructions:

```text
Work on {{issue_url}}.
Follow the repository instructions, run the relevant checks,
and summarize your changes.
```

| Variable | Value |
| --- | --- |
| `{{issue_url}}` | Link to the issue |
| `{{issue_number}}` | Issue number |
| `{{repo}}` | Repository as `owner/name` |

## GitHub Projects

Task Launcher works without GitHub Projects. If your issues are on a project board, you can show
its fields on each issue, and a board with a Status field adds a Status filter. This needs the
`read:project` scope on your `gh` sign-in:

```sh
gh auth refresh -s read:project
```

## What it runs

Task Launcher runs code on your machine, so Orca asks you to approve it. It:

- reads issues and board fields with `gh`, signed in as you
- creates and opens worktrees with the Orca CLI (`orca-ide` on Linux)
- reads your default agent from Orca’s settings
- fills in your template when an agent starts from the Tasks view (not on Windows)

It shows up to 100 open issues per project.

## Development

```sh
orca plugin validate .
orca plugin test .
orca plugin check .
orca plugin dev watch .
```

## License

[MIT](LICENSE)
