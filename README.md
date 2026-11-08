# Task Launcher

An Orca plugin. The **Task Launcher** panel (rocket icon) lists the open GitHub issues of the project
you have selected in the sidebar, and starts any of them in a new worktree with your prompt
template.

## The Task Launcher panel

- **Prompt template** is the selected project's own template. Edits save after a short pause.
  A project without one starts from the default, `Complete {{issue_url}}`.
- **Display fields** chooses what each issue card shows: its labels, and any of the fields on the
  owner's GitHub project boards, such as Status, Size or Priority. Field values follow the board's
  field order. Size is shown to start with.
- **Filter** narrows the list by Status (with a project board), assignee ("Assigned to me" or "No assignee" included),
  label, author, milestone and issue type. Its title counts the filters in use, and **Clear all**
  resets them.
- Each card links its number to the issue on GitHub. **Start** (the play button) creates a
  worktree named `issue-<number>-<title words>`, linked to the issue, and starts your default
  agent in it with the rendered template sent as its first prompt. The agent opens as a chat or a
  terminal per your Orca setting.
- A started issue shows its worktree (open it with a click) and the agent running in it. Any
  worktree linked to the issue counts, including ones made outside this panel.
- Each project's last list is kept, so reopening the panel shows it at once while it refreshes.

Variables:

| Variable | Value |
| --- | --- |
| `{{issue_url}}` | Issue URL |
| `{{issue_number}}` | Issue number |
| `{{repo}}` | `owner/name` |

## Starting an issue from Projects

When you start a GitHub issue from Projects in the Tasks view, the agent's input is filled with
the project's template instead of the bare issue URL, unsent, so you can edit it first. This needs
an agent launched in a terminal with a `--prefill` flag (Claude Code or OpenClaude); native chat
launches and other agents keep Orca's default. Pull requests keep Orca's default. On Windows the
draft is left as Orca made it, because the rewrite quotes for a POSIX shell.

## Limits

- Reads the repo's issues with `gh`, signed in as you. Project boards are optional: their fields
  and the Status filter appear only when the owner has boards and `gh` has the `read:project`
  scope (`gh auth refresh -s read:project`). Creates worktrees
  with the `orca` CLI. Both are found on `PATH` or at their usual install locations; the Orca CLI
  is `ORCA_CLI_COMMAND` when set, and `orca-ide` on Linux, where `orca` is the screen reader.
- The default agent is read from Orca's stored settings on macOS; if they cannot be read, Start
  uses Claude. A default of no agent creates the worktree without one.
- Shows up to 100 open issues per project, with up to 20 labels and 10 assignees each. Reads up to
  20 boards of the owner with 50 fields each, and an issue's values on up to 10 boards.
- A Start that times out may still finish in Orca. Start checks for a linked worktree first, so it
  does not make a second one, and after a timeout it waits 5 minutes before trying that issue again.

## Develop

    orca plugin validate .
    orca plugin test .
    orca plugin check .
    orca plugin dev watch .

The plugin page cover is `assets/cover.html` rendered at 1600 by 1000 around two captures of the
`demo` scenario in `src/panel.check.ts`, a made-up project with every worker request stubbed, so no
real issue reaches the image. Minimize Orca, then:

    orca plugin shot . --scenario demo --theme dark --width 440 --out assets/panel-dark.png
    orca plugin shot . --scenario demo --theme light --width 440 --out assets/panel-light.png
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars \
      --window-size=1600,1000 --screenshot="$PWD/assets/cover.png" "file://$PWD/assets/cover.html"

## License

MIT, see `LICENSE`.
