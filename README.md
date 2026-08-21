# AI Harness Helper

This discovery-stage repository contains the AI Harness Helper, a local tool for
making agentic coding-tool configuration visible and manageable.

Your agentic coding tools scatter their configuration across a dozen unrelated
places: `%APPDATA%`, `~/.claude`, `~/.codex`, `~/.cursor`, `~/.copilot`,
`~/.codeium`, `~/.docker/mcp`, `.github/`, `.vscode/`, plus stray `mcp.json`,
`AGENTS.md`, and rules files inside every repository.

The result is that almost nobody can answer a simple question: **what is my
agentic harness actually configured to do?** Duplicate and conflicting MCP
servers, stale instruction files, and forgotten permission rules go unnoticed
because there is no single place to look.

AI Harness Helper finds every one of those files, parses them, and shows you
the whole picture in one browsable, searchable, editable view.

```bash
npx ai-harness-helper
```

That scans your machine and opens a local browser UI. Nothing is uploaded,
there is no telemetry, and the tool makes no outbound network requests unless
you explicitly ask it to check for a new release with `--check-updates`.

## What you get

- **Overview** — every tool detected, every file found, how many directories
  they live in, and health findings: duplicates and conflicts of every kind,
  plaintext secrets, empty or unparseable files, and deprecated config
  locations.
- **Review** — the quality pass. Everything above tells you what your harness
  _contains_; this tells you what it gets _wrong_. A skill with no description
  the model will never select, an instruction file linking a document that was
  deleted six months ago, an MCP server whose API-key variable was never
  exported, a permission rule that pre-approves every command in its class.
  Every issue names its fix, and a single score makes "did that edit help?"
  answerable at a glance.
- **Context budget** — what the harness costs you on every request, split by
  when the bytes are actually paid: always, only when a glob matches, or only
  when a capability is selected. This is the view that makes streamlining
  possible, because nobody deletes an instruction file they think is free.
- **Sources** — the "where does this come from?" map: every supported tool,
  every location it reads, the directory each one resolves to on this machine,
  and whether anything is actually there. Locations that were checked and found
  empty are listed too, because "why is this tool ignoring my config?" is
  usually answered by a path the tool never looks at.
- **Files** — a tree grouped by tool and scope, with a syntax-highlighted
  viewer. Secrets are masked by default; you reveal one value at a time.
- **MCP servers** — every server from every tool in one table, showing which
  tools define it, which directories the definitions live in, where they
  disagree, and which differently named servers appear to do the same job. Any
  server can be deleted straight out of the file that declares it.
- **Instructions, capabilities and guardrails** — CLAUDE.md, AGENTS.md,
  copilot-instructions, `.cursorrules` and friends in precedence order, plus
  your agents, skills, prompts, chat modes, commands, permission rules, hooks
  and ignore files. Every row shows the tool, location, directory and file it
  came from, is flagged if something else declares the same thing, and carries a
  delete button when the file holds nothing but that one entry.
- **Skills & agents** — a form editor for the capability files themselves.
  Rename a skill, point an agent at a different model, bump its version, change
  its tool allowlist, or rewrite its instructions, without hand-editing YAML.
  Front-matter keys this build does not model are preserved exactly where they
  sit, and every change is confirmed field by field before it is written.
- **Effective configuration** — what each tool actually ends up using once
  precedence is applied, per tool: which declaration wins, which ones are
  shadowed by it, and whether a shadowed copy is merely redundant or genuinely
  says something different.
- **Models** — every model id pinned anywhere in your configuration, checked
  against published vendor lifecycle dates.
- **Search** — full-text across everything discovered, honoring redaction.
- **Export** — the whole harness as JSON or a Markdown report, including the
  source map, duplicate flags, review issues, and context budget. Metadata
  only, with credentials masked, so it is safe to attach to a bug report.
- **About** — which version you are running, where it came from, and, if you
  asked for it with `--check-updates`, whether a newer release exists.

Press <kbd>Ctrl</kbd>+<kbd>K</kbd> (<kbd>⌘</kbd>+<kbd>K</kbd> on macOS)
anywhere in the UI to jump straight to a view, a file, a skill, or a server
without navigating to it.

You can also **edit** any config file in place, with backups, validation, and
conflict detection, and **delete** the ones that hold a single entry.

### Duplicates and conflicts

Every entity — MCP server, agent, skill, prompt, command, chat mode,
instruction file, and guardrail — is compared against every other one:

- **Duplicate** means more than one file declares the same thing. That is often
  deliberate (a project `AGENTS.md` refining a user-level one), so it is a flag,
  not a complaint.
- **Conflict** means one tool, at one scope, has two declarations of the same
  name whose contents differ. Only one of them can win, and which one is rarely
  obvious, so this is raised as a finding.
- **Identical copy** catches the same file content living under two different
  names — the `CLAUDE.md` you copied to `AGENTS.md` and then edited only one of.

### Overlapping MCP servers

Duplicates only catch one _name_ declared twice. The more expensive problem is
three separately named servers that all do the same job, each one spending
context window on tool descriptions the model will never use. The MCP view
groups servers that appear to overlap, strongest evidence first:

| Evidence             | Confidence | What it means                                    |
| -------------------- | ---------- | ------------------------------------------------ |
| Same launch command  | high       | identical normalized command, args included      |
| Same package         | high       | same npm/PyPI/OCI package behind different names |
| Same endpoint        | high       | same remote URL, path included                   |
| Same host            | medium     | same remote host on different paths              |
| Same capability area | low        | names and packages describing the same domain    |

Nothing is executed and nothing is contacted — the inference comes entirely
from what the declarations already say. Because that ranges from certain to
merely suggestive, every group shows its confidence and the exact evidence that
produced it, and a weaker explanation is suppressed when a stronger one already
covers the same pair of servers.

### Removing a server

The MCP view can delete a server from the file that declares it, including from
every file at once when the same name is declared in several. The edit is
surgical rather than a rewrite: comments, key ordering, and formatting outside
the removed declaration survive intact, and the containing `mcpServers` map is
left in place even when it ends up empty, because a missing map and an empty one
do not mean the same thing to every tool. Removal goes through the same write
chain as the editor below, so it is refused in `--read-only` mode, backed up
first, and written atomically. Credentials the server used are left wherever
they already live — this tool never edits a credential store.

### What actually wins

Duplicates tell you two files declare the same thing. They do not tell you which
one the tool obeys. The Effective view answers that, one tool at a time, because
precedence only means anything inside a single tool — two tools both declaring a
`github` server is not a disagreement.

Two things resolve differently, so they are treated differently:

- **Override** — MCP servers, agents, skills, prompts and commands. The nearest
  declaration wins outright and the others are inert. Project beats user beats
  machine.
- **Merge** — instruction files and guardrails. Everything applies, so the
  question is ordering rather than survival. Guardrails invert the direction:
  machine-managed policy outranks user, which outranks project, because a rule a
  project could switch off would not be a policy.

A shadowed declaration is only called **contested** when its content actually
differs from the winner. A byte-identical copy sitting under a losing scope is
just redundant, and saying otherwise would bury the real conflicts.

### Outdated models

Every model id pinned anywhere — agent and skill front matter, chat modes,
settings files, nested keys — is collected and checked against the vendors'
published deprecation notices. A model whose shutdown date has passed is an
error; one with an announced date still in the future is a warning, along with
the date you have left and the vendor's own recommended replacement.

Two rules keep this honest:

- **An unrecognized model is never flagged.** Vendors ship faster than any
  bundled table can track, and wrongly telling you a working model is dead is
  far worse than staying quiet.
- **Nothing is inferred from version numbers.** Status is computed by comparing
  today's date against the shutdown date the vendor announced, so the table
  stays correct as the calendar moves rather than as this package is republished.

The lifecycle data is sourced from the OpenAI, Anthropic and Google deprecation
pages, and every finding links back to the page it came from. The date it was
last verified ships with the data and is shown in the Models view, so you can
tell at a glance how stale the checker itself is.

### Reviewing skills, agents and instructions

Duplicates, conflicts and model pins are all judgements about _structure_. They
say nothing about whether an individual skill is any good. A skill with no
description parses cleanly, duplicates nothing, pins no dead model, and is
still invisible to the model that was supposed to choose it.

The Review view runs 23 rules over every capability, instruction file, MCP
server and guardrail, and reports what it finds grouped by the file you would
open to fix it:

| Area                | What is checked                                                                                                                                                                                                                                                                                                                                          |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Skills & agents** | Missing description; a description past the 1024-character cap, where the end is silently truncated; front matter that opens but never closes; a declared `name` that disagrees with the file or folder a tool invokes it by; metadata with no instructions; a body large enough to matter; a `tools:` allowlist naming an MCP server nothing configures |
| **Instructions**    | An always-on file large enough to be worth splitting; a `*.instructions.md` with no `applyTo`, so it either never applies or always does depending on the tool; a file that is headings only                                                                                                                                                             |
| **Freshness**       | A Markdown link to a file that no longer exists; a self-declared "last verified" date more than a year old; a retired product name; a retired model id named in prose, where the model checker cannot see it                                                                                                                                             |
| **MCP servers**     | A `${VAR}` the definition expands that this machine does not export — the usual reason a server starts and then fails at first use; an absolute command path that is not there; an unpinned `npx` package; a plain-HTTP non-loopback endpoint; a server declared but disabled                                                                            |
| **Guardrails**      | An allow rule that pre-approves a whole class, like `Bash(*)`; the same pattern in both allow and deny, where one of the two is dead; a permissions file with no rules at all                                                                                                                                                                            |

The same constraints that govern the rest of the tool govern the rules:

- **Local only.** Nothing is fetched, nothing is executed, and no model is
  called. Every judgement comes from bytes already on disk plus the environment
  this process was started in — and for environment variables, only whether a
  name is set, never its value.
- **Precision over recall.** A false positive teaches you to ignore the whole
  view, which costs more than the finding was worth. Broken-link checking looks
  at Markdown link targets and deliberately ignores backticked paths, because
  those are usually illustrative. Prose model ids are only flagged once the
  vendor has actually shut the model down. Product renames are a short curated
  list of announced renames, matched on word boundaries, reported at `info`.
- **Every issue names its fix.** A finding you cannot act on is noise wearing a
  severity badge.

The score is a weighted deduction from 100 — errors cost more than warnings,
warnings more than suggestions — and exists to make one question answerable:
did that edit help? It is not a measurement, and the view says so.

### What your harness costs on every request

An instruction file grows a section at a time until it is prepended, in full,
to every question you ever ask. Nobody notices, because no single edit was
unreasonable and nothing ever breaks — the model just has less room and more to
ignore.

The Context view puts a number on it, split by when the bytes are actually
paid:

- **Always** — root instruction files and memories, plus the name and
  description of every capability, because progressive disclosure still has to
  advertise what is available before the model can choose it. A folder of forty
  skills is not free before you have used any of them.
- **Conditional** — instruction files scoped by an `applyTo` glob, paid only
  when the work touches matching files.
- **On demand** — capability bodies, paid only once selected.

That split matters more than the total. A 40 KB skill nobody has invoked this
month costs almost nothing; a 12 KB always-on instruction file costs that much
on every turn forever, and one number covering both would tell you to delete
the wrong thing.

Two things are deliberately not estimated. MCP servers publish their tool
schemas at runtime, and their real context cost can only be known by launching
them, which this tool never does — they are reported as a count and named as an
unmeasured factor rather than given a fabricated size. And token counts are an
explicit approximation at four bytes per token, because bundling a tokenizer
per vendor would be a large dependency in service of a number that only needs
to be right to an order of magnitude.

## Usage

```bash
npx ai-harness-helper [options]
```

| Option                  | Description                                                   |
| ----------------------- | ------------------------------------------------------------- |
| `-p`, `--port <number>` | Port to listen on. Defaults to the first free port from 7777. |
| `--project <path>`      | Also scan a project folder. Repeatable.                       |
| `--projects-only`       | Scan project folders without user or machine configuration.   |
| `--read-only`           | Disable all editing for this session.                         |
| `--no-open`             | Do not launch a browser.                                      |
| `--json`                | Print the full report as JSON and exit. Implies `--no-open`.  |
| `--report <format>`     | Print a report and exit: `json` or `markdown`.                |
| `--review`              | Print the quality review and exit. Implies `--no-open`.       |
| `--check`               | Exit 2 when anything at error severity was found.             |
| `--fail-on <level>`     | Threshold for `--check`: `error`, `warning`, or `info`.       |
| `--check-updates`       | Look up the latest release on GitHub. Off by default.         |
| `-h`, `--help`          | Show help.                                                    |
| `-v`, `--version`       | Show the version.                                             |

Global and user-level configuration is scanned automatically. Project
configuration is **opt-in** — the tool never crawls your whole drive:

```bash
npx ai-harness-helper --project ~/code/my-app --project ~/code/other-app
```

To inspect only those project folders, without reading user- or machine-level
configuration, add `--projects-only`. This mode requires at least one `--project`:

```bash
npx ai-harness-helper --projects-only --project ~/code/my-app
```

### Without the browser

Any of `--json`, `--report`, `--review`, `--check` or `--fail-on` runs the scan,
prints the result, and exits without starting a server. Progress goes to stderr
so stdout stays a clean document:

```bash
npx ai-harness-helper --json | jq '.summary'
npx ai-harness-helper --json | jq '.review.summary'
npx ai-harness-helper --report markdown > harness.md
npx ai-harness-helper --review
```

`--review` prints the quality pass on its own, grouped by file so you can work
through it one document at a time.

`--check` turns the scan into a gate. It exits 2 when anything at error severity
was found, 0 when nothing was, and 1 only if the command itself failed. Health
findings and review issues are weighed together, so a skill with no description
fails a build exactly the way an unparseable settings file does. Lower the bar
with `--fail-on warning` to fail on conflicts, models with an announced
shutdown, broken links, and unset server variables as well:

```bash
npx ai-harness-helper --check --project . --projects-only
```

Editing is irrelevant in this mode, so nothing is written and no token is
issued.

## Supported tools

| Tool                      | What is found                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude Code               | `~/.claude/` settings, CLAUDE.md, agents, commands, skills, plugins; `~/.claude.json`; managed settings; project `.claude/**`, `.mcp.json` |
| Claude Desktop            | `claude_desktop_config.json`, installed extensions                                                                                         |
| GitHub Copilot CLI        | `~/.copilot/` config, personal `copilot-instructions.md`, saved permissions, MCP config, agents, skills, prompts                           |
| GitHub Copilot in editors | `.github/copilot-instructions.md`, `instructions/`, `prompts/`, `chatmodes/`, `agents/`                                                    |
| VS Code                   | user and profile `settings.json` / `mcp.json`, `prompts/`, project `.vscode/**`                                                            |
| Cursor                    | `~/.cursor/mcp.json`, rules, project `.cursor/**`, `.cursorrules`, `.cursorignore`                                                         |
| OpenAI Codex CLI          | `config.toml`, `mcp.json`, `AGENTS.md`, prompts                                                                                            |
| Windsurf / Codeium        | `mcp_config.json`, memories, `.windsurfrules`, `.windsurf/rules/`                                                                          |
| Docker                    | `config.json`, `daemon.json`, and the MCP Toolkit tree                                                                                     |
| Gemini CLI                | `~/.gemini/` settings and extensions, `GEMINI.md`                                                                                          |
| Continue                  | `~/.continue/config.{json,yaml}`, project `.continue/`                                                                                     |
| Cline / Roo               | MCP settings, `.roomodes`, `.roo/`                                                                                                         |
| Aider                     | `~/.aider.conf.yml`, model settings                                                                                                        |
| Zed                       | `~/.config/zed/settings.json`, project `.zed/`                                                                                             |
| Amazon Q                  | `~/.aws/amazonq/mcp.json`, project `.amazonq/`                                                                                             |
| OpenCode                  | `opencode.json` global and project config, global `AGENTS.md`                                                                              |
| Universal                 | `AGENTS.md` at any level, bare `mcp.json` / `.mcp.json`                                                                                    |

Anything harness-shaped that no tool claims is reported as **unattributed**
rather than silently dropped.

A directory location contributes at most 200 files to the inventory. Some tools
write unbounded per-session or per-server files into directories that also hold
real configuration — one machine carried over a thousand OAuth token files
beside a handful of settings — and walking those in full makes the whole
inventory unreadable. When the limit bites, the overflow is reported as a scan
problem rather than dropped quietly.

This table is a summary; the **Sources** view in the UI is the authoritative
list, because it shows the same registry resolved against _your_ machine — the
exact directories, which locations hold files, and which were checked and found
empty.

Adding a tool means adding a row to the provider registry in
[`packages/core/src/registry.ts`](packages/core/src/registry.ts) — it is data,
not code.

## Security

This tool reads highly sensitive local files, so that is treated as a
first-class design constraint rather than an afterthought.

- The server binds `127.0.0.1` only, never `0.0.0.0`.
- Every API call requires a token generated fresh on each run and passed in
  the URL the tool opens. This blocks other local processes and DNS-rebinding
  attacks. `Origin` and `Host` are validated too.
- **Path allowlist**: the API will only read or write files the scanner
  actually discovered. Nothing else is ever in the authorized set, so
  traversal is structurally impossible rather than filtered.
- **Redaction by default**: values are masked when the key name looks secret
  (`token`, `apiKey`, `password`, `authorization`) or the value matches a
  known credential shape (`sk-`, `ghp_`, `github_pat_`, `AKIA`, `xox[bpsa]-`,
  JWTs, PEM blocks). Templated values like `${input:api-key}` are recognized
  and left alone. Revealing is per-value, explicit, and never persisted.
- **Credential stores are never rendered.** `~/.codex/auth.json`,
  `~/.claude/.credentials.json`, and `~/.docker/config.json` are listed as
  present, with metadata only. Editing them is blocked outright.
- Search redacts before matching, so a query cannot be used to confirm a
  secret character by character.
- Credentials passed on an MCP command line — `--api-key`, `-e TOKEN=...`, or
  an `?api_key=` query string — are masked in the inventory and in exports, not
  just the ones declared under `env`.
- File contents are never logged. There is no telemetry.
- **The network is opt-in and does nothing but read a version.** Every scan,
  parse, review, and edit happens offline. The single outbound request the tool
  can make is a GitHub release lookup, it happens only when a run is started
  with `--check-updates`, and it sends nothing but a `User-Agent` naming the
  tool and its version. No configuration, no file names, no identifiers. The
  release link shown afterwards is rebuilt from the repository URL and a tag
  that had to parse as a version, so a spoofed response cannot put an arbitrary
  link in front of you.

See [SECURITY.md](SECURITY.md) for the full threat model.

### Edit safety

Editing real credentials is powerful and dangerous, so every write goes
through the same chain:

1. Refused outright in `--read-only` mode.
2. Refused outright for credential stores.
3. Content must parse as its declared format.
4. The content hash you loaded must still match on disk, so an external edit
   is never clobbered.
5. A timestamped backup is written to `~/.ai-harness-helper/backups/`.
6. The file is replaced atomically via a temporary file and rename.

The editor is always given the **unmasked** document. Handing an editor masked
text and saving it would write the mask into your real configuration,
destroying the credentials the masking was protecting.

Structured edits from the **Skills & agents** form go through the same chain,
with two additions. The merge happens on the server against the bytes currently
on disk, so front matter the browser never saw cannot be dropped or reordered
by it. And a save is rejected if it would write a masked placeholder into a
file that did not already contain one.

Clearing a field removes the key rather than writing an empty value: several
tools read `model: ''` as a request for a model literally named the empty
string.

### Deleting a file

Instructions, agents, skills, prompts, commands, chat modes, memories,
dedicated permission files, and ignore files can be deleted outright from the
UI. These are the kinds where one file holds exactly one entry, so removing the
file removes precisely the thing you pointed at and nothing else.

Deletion reuses the write chain: refused in `--read-only` mode, refused for
credential stores, checked against the content hash you loaded so a file that
changed underneath you is never removed blind, and backed up to
`~/.ai-harness-helper/backups/` before the file is unlinked. Recovering from a
mistake is a file copy.

Everything else shows a disabled button explaining why, rather than a delete
that quietly takes more than it offered:

- **Settings files** hold a permission block _alongside_ unrelated settings, so
  deleting one to drop a guardrail would also drop the tool's model choice and
  everything else it keeps there. Open the file in the editor and remove the
  part you want gone.
- **MCP files** declare many servers, and one of them (`~/.claude.json`) also
  holds per-project history. Use the surgical per-server removal above instead.
- **Catalogs** are published by the tool and reappear on its next launch.
- **Credential files** and anything marked as a credential store are never
  touched here at all.
- **Extensions** are managed by their installer.
- **Unknown** files are of a shape this build cannot classify confidently.

Only the discovered file is removed. A skill that lives in its own folder as
`SKILL.md` leaves the folder behind, and the confirmation names the exact path
so there is no ambiguity about what goes.

## Development

Requires Node.js 20.11 or newer.

```bash
pnpm install
pnpm run build
pnpm test
pnpm start -- --no-open
```

| Command              | Purpose                                             |
| -------------------- | --------------------------------------------------- |
| `pnpm run bootstrap` | Install and build only if either output is missing. |
| `pnpm run build`     | Build all packages.                                 |
| `pnpm test`          | Run the test suite.                                 |
| `pnpm run typecheck` | Typecheck all packages.                             |
| `pnpm run lint`      | Lint.                                               |
| `pnpm run format`    | Format with Prettier.                               |

`pnpm start` runs `pnpm run bootstrap` first, so a fresh clone or a new git
worktree can go straight to `pnpm start` without a separate install and build.
Warm starts skip both steps.

The repository is a pnpm workspaces monorepo:

- `packages/core` — pure TypeScript. Registry, path resolution, scanner,
  parsers, redactor, aggregator, writer. No network, no server, fully unit
  tested against a synthetic fixture home.
- `packages/cli` — the Fastify API and the `ai-harness-helper` binary. Also
  holds `update-check.ts`, the only module in the repository that reaches the
  network, kept out of `core` so that package's offline guarantee stays whole.
- `packages/web` — the React browser UI. Never touches the filesystem.

See [CONTRIBUTING.md](CONTRIBUTING.md) for review expectations and
[BACKLOG.md](BACKLOG.md) for open decisions.

## License

No license has been selected. Until the owner explicitly adds one, no license
is granted for reuse, modification, or distribution.
