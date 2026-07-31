# Contributing

AI Harness Helper is in discovery. Contributions should reduce uncertainty or
implement behavior supported by an accepted product decision.

## Before writing code

1. Read `README.md`, `BACKLOG.md`, and `SECURITY.md`.
2. Open a product-decision issue for any unresolved P0 choice.
3. Include repository evidence, alternatives, risks, and testable acceptance
   criteria.
4. Do not introduce a runtime, provider, credential flow, external service, or
   licensing term as an incidental implementation detail.

## Changes

- Keep each change focused on one accepted outcome.
- Never commit credentials, tokens, private prompts, customer data, or
  sensitive model outputs.
- Add tests for behavior changes once a test stack exists.
- Keep examples synthetic and safe to publish.
- Update `README.md` and `BACKLOG.md` when a decision changes setup, behavior,
  support, or remaining work.

Run the dependency-free baseline checks before opening a pull request:

```bash
bash .github/scripts/validate-repository.sh
```

Additional build and test commands will be added after the runtime decision is
made.

## Pull requests

Pull requests should explain:

- The user or engineering outcome.
- The evidence supporting the change.
- The alternatives considered.
- Security, privacy, reliability, accessibility, and compatibility impact.
- The validation performed.

Use the pull request template and keep unrelated changes separate.
