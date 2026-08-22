# Product and Engineering Backlog

This backlog records decisions that cannot safely be inferred from the current
repository. Priorities reflect dependency order, not estimated effort.

## Resolved decisions

Decided 2026-08-01. P0.1, P0.2, and P0.3 are resolved and implemented; the
detail below is retained for provenance.

### P0.1 User, problem, and outcomes — RESOLVED

**Primary user:** a developer who uses several agentic coding tools at once.

**Problem:** harness configuration is scattered across a dozen unrelated
locations, so nobody can say what their harness is actually configured to do.
Duplicate and conflicting MCP servers, stale instruction files, and forgotten
permission rules go unnoticed.

**Workflows:**

1. _See everything._ Run `npx ai-harness-helper`; every discovered file appears
   grouped by tool and scope, with contents rendered and secrets masked.
   Failure case: an unparseable or unreadable file is shown with an
   explanation rather than dropped.
2. _Reconcile MCP servers._ One table lists every server from every tool, with
   duplicates and genuine conflicts flagged. Failure case: a definition with
   no command (a Docker `ref`) still resolves to a transport instead of
   reading as broken.
3. _Fix something._ Edit a config in place, with validation, a backup, and
   optimistic concurrency. Failure case: an external edit aborts the write.

**Success measures:** every config file the user knows about is found; findings
contain no false positives on a real machine; a first run needs no
configuration.

**Non-goals:** editing credential stores, crawling the whole drive, any
outbound network access, any telemetry, and managing or launching MCP servers.

### P0.2 Interaction model and runtime — RESOLVED

A CLI (`npx ai-harness-helper`) that scans, starts a loopback server, and opens
a browser UI. A pure CLI cannot render a whole harness legibly, and a
persistent service is the wrong trust posture for something reading
credentials.

- **Runtime:** TypeScript on Node.js 20.11+.
- **Stack:** Fastify API, React + Vite UI, pnpm workspaces monorepo.
- **Platforms:** Windows, macOS, and Linux from v1.
- **Install/update/remove:** none — `npx` runs the current version and leaves
  nothing behind except backups the user creates by editing.

### P0.3 AI and data boundary — RESOLVED

The product calls no AI provider by default. It reads local configuration and
renders it. One optional pass, off unless `--advise` is passed on the command
line, sends a redacted harness summary to a model endpoint the user names.

- **Input:** local config files, discovered from a declarative registry, plus
  project roots the user explicitly registers.
- **Egress:** none by default. Two opt-in exceptions, each requiring an
  explicit command-line flag for that run: `--check-updates` (a release
  lookup, sending only a `User-Agent`) and `--advise` (a harness summary to a
  user-named OpenAI-compatible endpoint). Neither can be enabled by a config
  file, an environment variable, or a request to the local API. There is no
  telemetry and the listener remains loopback-only.
- **What `--advise` sends:** capability and instruction metadata — names,
  descriptions, tool lists, scopes, sizes — the findings the deterministic
  rules already produced, and excerpts capped at 400 characters per document.
  Never whole files, never absolute paths, never credential-store contents.
  Everything is passed through `redactText` first, the payload is capped at
  64 KB, and `--advise-dry-run` prints the exact body without sending it.
  Plaintext HTTP is refused for any non-loopback host, so a remote endpoint
  cannot receive the summary or the API key in the clear. A loopback endpoint
  keeps the whole feature on-machine.
- **Credentials:** never loaded. Credential stores are listed with metadata
  only and are never rendered or editable. Other secrets are masked by default
  by key name and value shape, revealed only per-value on explicit request,
  and never cached, persisted, or logged. The advisor API key is read from the
  environment, sent only as an `Authorization` header, and never written to
  the response body, the console, or the browser.
- **Retention:** nothing is stored except timestamped backups the user's own
  edits create, under `~/.ai-harness-helper/backups/`.
- **Threat model:** documented in [SECURITY.md](SECURITY.md). Prompt injection
  is out of scope for the default configuration, where no content reaches a
  model; config files are parsed as data and rendered as text, never executed.
  It is **in scope for `--advise`**, because the excerpts come from files this
  tool did not author. It is contained rather than prevented: the model is
  given no tools and no ability to act, its reply is read only as data against
  a fixed schema, provenance is attached from the local index rather than from
  the reply, and no recommendation can write to disk or affect the exit code.
  The residual risk is a misleading suggestion in a panel labelled as
  model-generated.

**Deliberately not chosen:** GitHub Models, which was retired on 30 July 2026
and now answers `410`. There is no bundled provider or key, so the destination
is always one the user picked.

### P1.1 First end-to-end workflow — RESOLVED

Implemented and verified against a real machine as well as synthetic fixtures.

### P1.2 CI for the selected stack — RESOLVED

`.github/workflows/ci.yml` runs typecheck, build, lint, format check, `pnpm
audit`, and the test suite across Windows, macOS, and Linux, plus the declared
minimum Node version. Actions are SHA-pinned, permissions are read-only, and
every job has a timeout. The baseline workflow is retained.

## P0 - Decisions required before implementation

### P0.4 Decide distribution and licensing

**Evidence:** GitHub metadata reports no license. The project now has
dependencies, so third-party notice obligations are live.

**Decision needed:** Keep the project private/internal or select approved
distribution terms and a license. **This is an owner decision and has
deliberately not been made on the owner's behalf.** Publishing to npm is
blocked until it is resolved.

**Acceptance criteria:**

- Internal-only or distributable status is explicit.
- A license is added only if approved by the owner.
- Third-party notice and source-attribution requirements are defined.

## P1 - Remaining hardening

### P1.3 Establish security and privacy verification

**Evidence:** the threat model in `SECURITY.md` now describes a real
implementation, and the test suite covers token auth, `Host` and `Origin`
validation, the path allowlist, credential-store blocking, and redaction. Two
items remain outside the code.

**Acceptance criteria:**

- Secret and dependency scanning are enabled on the repository, or an
  alternative is documented.
- A maintainer verifies a private reporting path end to end.

### P1.4 Protect changes to the default branch

**Evidence:** GitHub reported that branch protection and repository rulesets
require a plan upgrade or a public repository.

**Acceptance criteria:**

- If repository settings become available, require pull requests and passing
  checks for `main`.
- Until then, maintainers use pull requests and run CI before merge.
- The owner decides whether Actions should be restricted from "all actions" to
  an approved allowlist.

## P2 - Quality

### P2.0 Decide how the bundled model lifecycle table stays current

**Evidence:** `packages/core/src/models.ts` carries vendor deprecation dates
transcribed from the OpenAI, Anthropic, and Google deprecation pages, stamped
with `MODEL_DATA_VERIFIED_ON`. Nothing refreshes it. The design already fails
safe — status is derived by comparing today against an announced shutdown date,
and an unrecognized model is never flagged — so staleness costs coverage rather
than correctness. It still decays.

**Decision needed:** whether refreshing the table is a manual step at release
time, a scheduled job that opens a pull request, or a runtime fetch. A runtime
fetch would contradict the no-outbound-network guarantee in SECURITY.md, so it
is the one option that cannot be chosen without revisiting that promise.

**Acceptance criteria:**

- A documented owner and cadence for refreshing the table.
- The verified-on date is surfaced wherever the checker reports, so a user can
  judge how stale it is. (Done: shown in the Models view.)
- Table integrity stays enforced by tests, including that every recommended
  replacement resolves to a model that is itself still alive.

### P2.1 Define reliability and performance budgets

**Evidence:** a first scan of a real machine reads roughly 30 files in well
under a second, but no budget is enforced and no large-monorepo benchmark
exists.

**Acceptance criteria:**

- Scan time, file-size caps, and glob depth bounds are explicit and tested.
- A benchmark guards scan latency against a large registered project root.

### P2.2 Verify user experience and accessibility

**Evidence:** the UI targets WCAG 2.2 AA with keyboard operation, semantic
markup, and a light/dark theme, but this has not been verified with assistive
technology.

**Acceptance criteria:**

- A screen-reader pass over each view.
- Automated accessibility checks in CI.
- Destructive actions require clear confirmation and support recovery.

### P2.3 Define release and support policy

**Depends on:** P0.4.

**Evidence:** There are no tags, releases, versioning rules, compatibility
claims, or supported versions.

**Acceptance criteria:**

- Versioning, changelog, compatibility, deprecation, and support policies are
  documented.
- Release artifacts are reproducible and include provenance appropriate to the
  selected distribution model.

## Evidence baseline

Audit date: 2026-07-30

- `README.md` was the only file on `main` and contained only the repository
  title.
- The sole `main` commit was the initial commit. Local checkpoint refs had the
  same tree and contained no removed implementation.
- GitHub repository metadata had no description, topics, language, license,
  releases, workflows, issues, or pull requests.
- The repository is private. GitHub reported no plan access to branch
  protection or repository rulesets.
- GitHub Actions allowed all actions and did not require SHA pinning. Default
  workflow token permissions were read-only.
- No prior indexed session supplied additional product intent.
