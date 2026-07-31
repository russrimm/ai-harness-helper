# Product and Engineering Backlog

This backlog records decisions that cannot safely be inferred from the current
repository. Priorities reflect dependency order, not estimated effort.

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

## P0 - Decisions required before implementation

### P0.1 Define the user, problem, and outcomes

**Evidence:** `README.md` and repository metadata did not state a target user,
problem, expected outcome, or non-goal.

**Decision needed:** Identify who uses AI Harness Helper, the problem it solves,
and the smallest valuable workflow.

**Acceptance criteria:**

- One primary user and one concrete problem are named.
- Three representative workflows include inputs, outputs, and failure cases.
- Success measures and explicit non-goals are documented.
- The repository description and `README.md` are updated to match.

### P0.2 Select the interaction model and supported runtime

**Evidence:** There is no source tree, manifest, runtime declaration, API
contract, CLI contract, or interface design.

**Decision needed:** Choose whether the first release is a CLI, library,
service, or user interface, then select a supported language and runtime.

**Acceptance criteria:**

- The interface choice is justified against the P0.1 workflows.
- Supported operating systems and runtime versions are listed.
- Installation, update, and removal paths are defined.
- Local development and validation commands are added to `README.md`.

### P0.3 Define the AI and data boundary

**Evidence:** No provider, model, credential flow, data classification,
retention policy, telemetry policy, or offline behavior is documented.

**Decision needed:** Define what data may enter the system, where it may be
sent or stored, how credentials are supplied, and whether provider-specific
behavior is allowed.

**Acceptance criteria:**

- Allowed and prohibited input classifications are documented.
- Credential loading, redaction, logging, retention, and deletion behavior is
  specified.
- Provider and model selection behavior, including offline/failure behavior,
  is explicit.
- Prompt injection, untrusted tool output, excessive permissions, and data
  exfiltration are included in a lightweight threat model.

### P0.4 Decide distribution and licensing

**Evidence:** GitHub metadata reports no license, and `README.md` previously
provided no distribution intent.

**Decision needed:** Keep the project private/internal or select approved
distribution terms and a license.

**Acceptance criteria:**

- Internal-only or distributable status is explicit.
- A license is added only if approved by the owner.
- Third-party notice and source-attribution requirements are defined before
  dependencies are introduced.

## P1 - First usable vertical slice

### P1.1 Implement one end-to-end workflow

**Depends on:** P0.1, P0.2, and P0.3.

**Evidence:** There is no runnable implementation or product behavior to test.

**Acceptance criteria:**

- One representative workflow succeeds from documented setup through output.
- Invalid input, missing configuration, provider failure, timeout, and
  cancellation produce actionable errors without exposing sensitive data.
- Unit tests cover core logic; an integration test covers the public boundary.
- Examples use synthetic, non-sensitive data.

### P1.2 Extend CI for the selected stack

**Depends on:** P0.2 and P1.1.

**Evidence:** `.github/workflows/repository-baseline.yml` can validate repository
hygiene, but no build, type-check, lint, test, dependency, or packaging command
exists.

**Acceptance criteria:**

- CI runs the repository's canonical build, test, lint, and type-check commands.
- Dependency manifests and lockfiles are committed and reproducible.
- Third-party actions are pinned to immutable commit SHAs.
- Least-privilege workflow permissions and job timeouts remain explicit.

### P1.3 Establish security and privacy verification

**Depends on:** P0.3 and P1.1.

**Evidence:** `SECURITY.md` provides reporting guidance, but there is no code or
data flow to assess. Private vulnerability reporting could not be confirmed
through the GitHub API.

**Acceptance criteria:**

- The threat model is reviewed against the implementation.
- Secret and dependency scanning are enabled or an alternative is documented.
- Logs and errors are tested for credential and sensitive-data leakage.
- A maintainer verifies a private reporting path end to end.

### P1.4 Protect changes to the default branch

**Evidence:** GitHub reported that branch protection and repository rulesets
require a plan upgrade or a public repository.

**Acceptance criteria:**

- If repository settings become available, require pull requests and passing
  checks for `main`.
- Until then, maintainers use pull requests and run the baseline workflow
  before merge.
- The owner decides whether Actions should be restricted from "all actions" to
  an approved allowlist.

## P2 - Quality once the interface is known

### P2.1 Define reliability and performance budgets

**Evidence:** No workload, execution model, scale, or service-level objective
exists, so meaningful budgets cannot yet be selected.

**Acceptance criteria:**

- Timeouts, retry limits, concurrency, rate-limit behavior, and resource bounds
  are explicit.
- Representative benchmarks guard any user-visible latency or throughput
  target.

### P2.2 Verify user experience and accessibility

**Evidence:** No user interface or interaction contract exists to review.

**Acceptance criteria:**

- CLI output is scriptable and usable with assistive technology, or UI behavior
  meets WCAG 2.2 AA as applicable.
- Destructive actions require clear confirmation and support recovery where
  practical.
- Errors state what failed, why it matters, and the next corrective action.

### P2.3 Define release and support policy

**Evidence:** There are no tags, releases, versioning rules, compatibility
claims, or supported versions.

**Acceptance criteria:**

- Versioning, changelog, compatibility, deprecation, and support policies are
  documented.
- Release artifacts are reproducible and include provenance appropriate to the
  selected distribution model.
