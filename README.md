# AI Harness Helper

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
there is no telemetry, and the tool makes no outbound network requests at all.

## What you get

- **Overview** — every tool detected, every file found, how many directories
  they live in, and health findings: duplicates and conflicts of every kind,
  plaintext secrets, empty or unparseable files, and deprecated config
  locations.
- **Sources** — the "where does this come from?" map: every supported tool,
  every location it reads, the directory each one resolves to on this machine,
  and whether anything is actually there. Locations that were checked and found
  empty are listed too, because "why is this tool ignoring my config?" is
  usually answered by a path the tool never looks at.
- **Files** — a tree grouped by tool and scope, with a syntax-highlighted
  viewer. Secrets are masked by default; you reveal one value at a time.
- **MCP servers** — every server from every tool in one table, showing which
  tools define it, which directories the definitions live in, and where they
  disagree.
- **Instructions, capabilities and guardrails** — CLAUDE.md, AGENTS.md,
  copilot-instructions, `.cursorrules` and friends in precedence order, plus
  your agents, skills, prompts, chat modes, commands, permission rules, hooks
  and ignore files. Every row shows the tool, location, directory and file it
  came from, and is flagged if something else declares the same thing.
- **Search** — full-text across everything discovered, honoring redaction.
- **Export** — the whole harness as JSON or a Markdown report, including the
  source map and duplicate flags. Metadata only, with credentials masked, so it
  is safe to attach to a bug report.

You can also **edit** any config file in place, with backups, validation, and
conflict detection.

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

## Usage

```bash
npx ai-harness-helper [options]
```

| Option                  | Description                                                   |
| ----------------------- | ------------------------------------------------------------- |
| `-p`, `--port <number>` | Port to listen on. Defaults to the first free port from 7777. |
| `--project <path>`      | Also scan a project folder. Repeatable.                       |
| `--read-only`           | Disable all editing for this session.                         |
| `--no-open`             | Do not launch a browser.                                      |
| `-h`, `--help`          | Show help.                                                    |
| `-v`, `--version`       | Show the version.                                             |

Global and user-level configuration is scanned automatically. Project
configuration is **opt-in** — the tool never crawls your whole drive:

```bash
npx ai-harness-helper --project ~/code/my-app --project ~/code/other-app
```

## Supported tools

| Tool                      | What is found                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude Code               | `~/.claude/` settings, CLAUDE.md, agents, commands, skills, plugins; `~/.claude.json`; managed settings; project `.claude/**`, `.mcp.json` |
| Claude Desktop            | `claude_desktop_config.json`, installed extensions                                                                                         |
| GitHub Copilot CLI        | `~/.copilot/` config, MCP config, agents, skills, prompts                                                                                  |
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
| Universal                 | `AGENTS.md` at any level, bare `mcp.json` / `.mcp.json`                                                                                    |

Anything harness-shaped that no tool claims is reported as **unattributed**
rather than silently dropped.

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

## Development

Requires Node.js 20.11 or newer.

```bash
npm install
npm run build
npm test
npm start -- --no-open
```

| Command             | Purpose                 |
| ------------------- | ----------------------- |
| `npm run build`     | Build all packages.     |
| `npm test`          | Run the test suite.     |
| `npm run typecheck` | Typecheck all packages. |
| `npm run lint`      | Lint.                   |
| `npm run format`    | Format with Prettier.   |

The repository is an npm workspaces monorepo:

- `packages/core` — pure TypeScript. Registry, path resolution, scanner,
  parsers, redactor, aggregator, writer. No network, no server, fully unit
  tested against a synthetic fixture home.
- `packages/cli` — the Fastify API and the `ai-harness-helper` binary.
- `packages/web` — the React browser UI. Never touches the filesystem.

See [CONTRIBUTING.md](CONTRIBUTING.md) for review expectations and
[BACKLOG.md](BACKLOG.md) for open decisions.

## License

No license has been selected. Until the owner explicitly adds one, no license
is granted for reuse, modification, or distribution.
