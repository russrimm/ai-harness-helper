# Security Policy

## Supported versions

There are no released or supported product versions. Repository documentation
and automation on `main` receive security fixes as needed.

## Reporting a vulnerability

Do not disclose suspected vulnerabilities in a public issue, discussion, pull
request, commit message, or sample.

Use a private GitHub Security Advisory for this repository when that option is
available. If it is not available, contact the repository owner through a
previously established private channel and request a secure reporting path.
Do not include exploit details or sensitive data until that path is confirmed.

Include:

- The affected file, commit, or future version.
- Reproduction steps using synthetic data.
- Expected and observed behavior.
- Potential impact and known mitigations.

The repository does not currently publish response-time commitments. A
maintainer should acknowledge receipt, coordinate disclosure, and document the
remediation before a supported release is created.

## Sensitive data

- Never commit credentials, access tokens, private keys, customer data, private
  prompts, or sensitive model outputs.
- Use clearly fake values in documentation and tests.
- Remove secrets from history and rotate them immediately if exposure occurs;
  deleting only the latest file is not sufficient.
- Treat prompts, retrieved content, tool output, logs, and generated content as
  untrusted until the product's data boundary and threat model are defined.

## Threat model

AI Harness Helper reads and writes the files that hold your AI tooling
credentials and instructions. That makes it a high-value target on your own
machine, so the design assumes an attacker already has some local foothold.

### What is in scope

**Another local process reading your secrets through the API.**
The server binds `127.0.0.1` only and requires a token generated fresh on each
run, delivered in the URL the tool opens. A process that cannot read that URL
cannot call the API. Tokens are 256 bits of entropy and compared in constant
time. The browser strips the token from the address bar on load and keeps it in
`sessionStorage`, so it survives a page reload but not closing the tab, and
remains unreadable to other origins and other local processes.

**A malicious web page driving the API from your browser.**
`Origin` is validated, so a page on the internet cannot issue authenticated
cross-origin requests. `Host` is validated against loopback names, which is
what defeats DNS rebinding: an attacker-controlled hostname that resolves to
`127.0.0.1` is rejected before any route runs.

**Path traversal or symlink escape to an arbitrary file.**
Authorization is an allowlist, not a filter. Only absolute paths the scanner
actually discovered are readable or writable. A crafted id, a `..` sequence,
or a symlink cannot reach a file outside the discovered set, because nothing
outside it is ever in the set.

**Accidental secret disclosure through the UI.**
Values are masked by default, both by key name and by value shape. Revealing
is per-value, requires an explicit action, and is never cached or persisted.
Search redacts before matching, so a query cannot be used as an oracle to
confirm a secret one character at a time.

**Secrets embedded in MCP command lines.**
An MCP server definition routinely carries credentials outside of `env` — as a
`--api-key sk-...` flag, a `-e TOKEN=ghp_...` argument, or an `?api_key=` query
string on an HTTP transport URL. These are masked in the aggregated inventory
before it reaches the UI or an export, so every consumer of the inventory sees
the redacted form. Masking happens before the duplicate/conflict signature is
computed, so two definitions that differ only by credential are reported as
duplicates rather than as a spurious conflict.

**Exports.**
JSON and Markdown exports contain metadata only — no file contents, and
environment variable names without their values. Combined with the command-line
masking above, an export is safe to attach to a bug report.

**Credential stores.**
Files whose entire purpose is to hold live credentials are listed as present
with metadata only. Their contents are never read for display and never
editable, regardless of any other setting.

**Destroying a credential through an edit.**
Every write is validated, backed up, and applied atomically, and a stale
content hash aborts the write rather than clobbering an external change. The
editor is always handed the unmasked document, because saving masked text
would write the mask into the real file.

### What is out of scope

- An attacker who already has read access to your home directory. They can
  read the same files directly; this tool adds no new exposure.
- Malicious content inside the config files themselves. Files are parsed as
  data and rendered as text; they are never executed.
- Supply-chain compromise of a dependency. Mitigated by a small dependency
  surface, `npm audit` in CI, and SHA-pinned GitHub Actions, but not
  eliminated.
- Physical access to an unlocked machine.

### Data handling

- There is no telemetry, and no outbound network access by default.
- The one exception is `--check-updates`, which is off unless that flag is
  passed on the command line. It performs a single unauthenticated `GET`
  against the GitHub releases API for this repository and sends nothing but a
  `User-Agent` naming the tool and its version — no configuration data, no file
  names, no machine or user identifiers. It cannot be enabled by a config file
  or an environment variable, so "did this run touch the network?" is answered
  entirely by the command line you typed.
- The response is treated as untrusted. Only `tag_name` is read, it must be
  under 64 characters and parse as a version, and the release link shown to you
  is rebuilt from the hard-coded repository URL plus that validated tag rather
  than taken from the payload. Nothing is downloaded or executed; updating is
  left to your package manager.
- File contents are never written to logs.
- No configuration data ever leaves the machine. The only network listener is
  loopback.
- Backups written to `~/.ai-harness-helper/backups/` contain the original file
  contents, including secrets. On POSIX systems the backup directories are
  restricted to the current user (`0700`) and backup files to owner read/write
  (`0600`). Treat that directory as sensitive.

### Running with reduced privilege

Use `--read-only` to disable every write route at the server level when you
only want to inspect a harness.
