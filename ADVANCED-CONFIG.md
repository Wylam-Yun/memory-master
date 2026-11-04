# Advanced Configuration

For getting started and the interactive wizard overview, see [README.md](README.md#-configuration).

## Configuration Commands

| Action      | Example                                              |
|-------------|------------------------------------------------------|
| View all configs | `memaster config list` |
| Get specific config | `memaster config get defaultEditor` |
| Set config value | `memaster config set defaultEditor "code --wait"` |
| Enable auto-commit | `memaster config set autoCommit true` |
| Bypass git hooks | `memaster config set bypassGitHooks true` |
| Enable cross-branch check | `memaster config set checkActiveBranches true` |
| Set active branch days | `memaster config set activeBranchDays 30` |
| Set default assignees | `memaster config set defaultAssignee "@alice,@bob"` |

Running `memaster config` with no arguments launches the interactive advanced wizard, including guided Definition of Done defaults editing (add/remove/reorder/clear).

## Available Configuration Options

| Key               | Purpose            | Default                       |
|-------------------|--------------------|-------------------------------|
| `defaultAssignee` | Assignees for new tasks created without `-a` | `[]`             |
| `defaultStatus`   | First column       | `To Do`                       |
| `definition_of_done` | Default DoD checklist items for new tasks | `(not set)` |
| `statuses`        | Board columns      | `[To Do, In Progress, Done]`  |
| `priorities`      | Ordered task priority labels | `[High, Medium, Low]` |
| `projects`        | Allowed project values for monorepo memasters | `(not set)` |
| `dateFormat`      | Display-only date format | `yyyy-mm-dd`            |
| `includeDatetimeInDates` | Add time to new dates | `true`              |
| `defaultEditor`   | Editor for 'E' key | Platform default (nano/notepad) |
| `defaultPort`     | Web UI port        | `6420`                        |
| `autoOpenBrowser` | Open browser automatically | `true`            |
| `remoteOperations`| Enable remote git operations | `true`           |
| `autoCommit`      | Automatically commit task changes | `false`       |
| `bypassGitHooks`  | Skip git hooks when committing (uses --no-verify) | `false`       |
| `zeroPaddedIds`   | Pad all IDs (tasks, docs, etc.) with leading zeros | `(disabled)`  |
| `checkActiveBranches` | Check task states across active branches for accuracy | `true` |
| `activeBranchDays` | How many days a branch is considered active | `30` |
| `onStatusChange`  | Shell command to run on status change | `(disabled)` |
| `memaster_directory` | Project-relative memaster folder, chosen at `memaster init` and read from `memaster.config.yml` in the project root | `memaster` |

## Detailed Notes

> Editor setup guide: See [Configuring VIM and Neovim as Default Editor](memaster/docs/doc-002%20-%20Configuring-VIM-and-Neovim-as-Default-Editor.md) for configuration tips and troubleshooting interactive editors.

> **Note**: Set `remoteOperations: false` to work offline. This disables git fetch operations and loads tasks from local branches only, useful when working without network connectivity.

> **Git Control**: By default, `autoCommit` is set to `false`, giving you full control over your git history. Task operations will modify files but won't automatically commit changes. Set `autoCommit: true` if you prefer automatic commits for each task operation.

> **Git Hooks**: If you have pre-commit hooks (like conventional commits or linters) that interfere with memory-master's automated commits, set `bypassGitHooks: true` to skip them using the `--no-verify` flag.

> **Performance**: Cross-branch checking ensures accurate task tracking across all active branches but may impact performance on large repositories. You can disable it by setting `checkActiveBranches: false` for maximum speed, or adjust `activeBranchDays` to control how far back to look for branch activity (lower values = better performance).

> **Status Change Callbacks**: Set `onStatusChange` to run a shell command whenever a task's status changes. Available variables: `$TASK_ID`, `$OLD_STATUS`, `$NEW_STATUS`, `$TASK_TITLE`. Per-task override via `onStatusChange` in task frontmatter. Example: `'if [ "$NEW_STATUS" = "In Progress" ]; then claude "Task $TASK_ID ($TASK_TITLE) has been assigned to you. Please implement it." & fi'`

> **Default Assignee**: `defaultAssignee` is a list, so `memaster config set defaultAssignee "@alice,@bob"` stores both names. Every create surface (CLI `task create` and `draft create`, the creation wizard, TUI, Web, MCP) applies it when no assignee is supplied. An explicit assignee replaces the default entirely instead of merging with it, and setting the value to an empty string clears the default so new tasks start unassigned. To keep a single task unassigned while the default stays configured, pass an explicit empty assignee: `memaster task create "Title" -a ""`. The same value clears existing assignees on edit: `memaster task edit BACK-1 -a ""` (MCP `task_create`/`task_edit` use an empty `assignee` array). When editing `config.yml` by hand, quote the names (`default_assignee: ["@alice"]`) because `@` starts a reserved YAML character; a value YAML cannot read is ignored rather than guessed at.

> **Priority Values**: Set `priorities` to an ordered list of labels such as `["Very High", "High", "Medium", "Low", "Very Low"]`. The first value sorts highest. CLI, MCP, and Web inputs accept configured values case-insensitively and store normalized lowercase values in task frontmatter.

> **Project Values**: `projects` tags each task with one project in a monorepo-style memaster. It has no default, so the field stays inert until you set it — until then no surface offers it, and `--project` fails with a message naming the config file. Set it by editing the project config file directly (like `statuses`, `labels`, `types`, and `priorities`, it cannot be changed with `memaster config set`):
>
> ```yaml
> projects: ["web", "api", "mobile"]
> ```
>
> Once configured, CLI, MCP, and Web inputs accept the values case-insensitively and store the configured spelling in task frontmatter. Filter with `memaster task list --project web`, `memaster search --project web`, or repeat/comma-separate values for OR semantics. Clear a task's project with `memaster task edit <id> --project ""`. Read current values with `memaster config get projects`.

> **Date/Time Support**: Newly generated creation and update timestamps carry explicit UTC, for example `2026-10-19T11:48:00Z`. Decision and comment timestamps use the same format. Precision remains one minute. Existing timezone-less timestamps such as `2026-10-19 11:48` continue to mean UTC; hand-authored timestamps should include `Z` or an explicit offset. Reading or editing a record does not migrate its unchanged historical creation value. Existing date-only entries and due dates remain `YYYY-MM-DD`, without a timezone.

> **Date Display Format**: `dateFormat` only changes how dates are *displayed* in the web UI and TUI; it does not change stored timestamps or date-only values. The format string is split at the first whitespace into a date part and an optional time part. Date part tokens (case-insensitive, each exactly once): `yyyy`, `mm` (month), `dd`; any other characters are kept literally. Time part tokens: `hh` and `mm` (minutes) — `mm` means month in the date part and minutes in the time part. If a stored value includes a time it is always shown: through the format's time part when present, otherwise appended as ` hh:mm`. Date-only values never invent a time. Invalid formats fall back to the canonical display. Agent-facing output (`--plain` CLI output and MCP responses) always stays canonical regardless of this setting. Example: `dateFormat: dd/mm/yyyy` renders `2026-07-04 21:54` as `04/07/2026 21:54`.

> **Custom Memaster Folder**: `memaster_directory` is chosen when the project is initialized — select "Custom project-relative path" in the wizard or run `memaster init --memaster-dir my-memaster --config-location root` — and init refuses to move the folder afterwards. Unlike every other key here it is read only from `memaster.config.yml` in the project root: the same key inside `memaster/config.yml` is ignored, and `memaster config` cannot set, get, or list it. The path is only checked lexically: absolute values and paths that normalize to outside the project are ignored, while a relative path that symlinks outside the repository is accepted. When the value is ignored Memaster uses `memaster/` or `.memaster/` if one exists, and otherwise reports that no project was found.
