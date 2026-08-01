# AI Harness Helper

AI Harness Helper is currently a **discovery-stage repository**. It does not
yet define a product contract or contain a runnable implementation.

The repository name alone is not enough to determine whether this should be a
CLI, library, service, or user interface. Those choices affect security,
privacy, accessibility, packaging, and testing, so they are intentionally
deferred rather than guessed.

## Current status

- No runtime, language, or framework has been selected.
- No AI provider, model, or external integration has been selected.
- No installation, API, CLI, or user workflow has been defined.
- No released or supported version exists.
- No license has been selected.

The decision-first work needed to begin implementation is tracked in
[BACKLOG.md](BACKLOG.md).

## Repository map

- [`BACKLOG.md`](BACKLOG.md): prioritized product and engineering decisions.
- [`CONTRIBUTING.md`](CONTRIBUTING.md): contribution and review expectations.
- [`SECURITY.md`](SECURITY.md): vulnerability reporting and data-safety guidance.
- [Product-decision issue form](.github/ISSUE_TEMPLATE/product-decision.yml):
  structured proposals for unresolved decisions.
- [Repository validation script](.github/scripts/validate-repository.sh):
  dependency-free baseline checks.

## Getting started

1. Read [BACKLOG.md](BACKLOG.md), starting with the P0 decisions.
2. Open a product-decision issue with evidence, alternatives, and acceptance
   criteria.
3. Resolve the relevant P0 decisions before introducing a runtime or external
   integration.
4. Follow [CONTRIBUTING.md](CONTRIBUTING.md) when preparing a change.

Run the current repository checks from Git Bash, Linux, or macOS:

```bash
bash .github/scripts/validate-repository.sh
```

The checks require only Bash, Git, and standard command-line utilities. Product
build, test, lint, dependency, and release commands will be documented here
after a runtime is selected.

## Security

Do not commit credentials, model inputs, customer data, or generated outputs
containing sensitive information. Report suspected vulnerabilities privately
as described in [SECURITY.md](SECURITY.md).

## License

No license has been selected. Until the owner explicitly adds one, no license
is granted for reuse, modification, or distribution.
