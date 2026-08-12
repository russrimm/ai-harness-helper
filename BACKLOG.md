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
- **Stack:** Fastify API, React + Vite UI, npm workspaces monorepo.
- **Platforms:** Windows, macOS, and Linux from v1.
- **Install/update/remove:** none — `npx` runs the current version and leaves
  nothing behind except backups the user creates by editing.

### P0.3 AI and data boundary — RESOLVED

The product calls no AI provider and no model. It reads local configuration and
renders it.

- **Input:** local config files, discovered from a declarative registry, plus
  project roots the user explicitly registers.
- **Egress:** none. No telemetry, no outbound network access, loopback-only
  listener.
- **Credentials:** never loaded. Credential stores are listed with metadata
  only and are never rendered or editable. Other secrets are masked by default
  by key name and value shape, revealed only per-value on explicit request,
  and never cached, persisted, or logged.
- **Retention:** nothing is stored except timestamped backups the user's own
  edits create, under `~/.ai-harness-helper/backups/`.
- **Threat model:** documented in [SECURITY.md](SECURITY.md). Prompt injection
  is out of scope because no content is ever sent to a model; config files are
  parsed as data and rendered as text, never executed.

### P1.1 First end-to-end workflow — RESOLVED

Implemented and verified against a real machine as well as synthetic fixtures.

### P1.2 CI for the selected stack — RESOLVED

`.github/workflows/ci.yml` runs typecheck, build, lint, format check, `npm
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
