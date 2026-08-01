# Contributing

Contributions should reduce uncertainty or implement behavior supported by an
accepted product decision.

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
- Add tests for behavior changes.
- Keep examples synthetic and safe to publish.
- Update `README.md` and `BACKLOG.md` when a decision changes setup, behavior,
  support, or remaining work.

### Where things live

- `packages/core` owns all logic and has no I/O surface of its own.
- In core, `registry.ts` declares provider support as data. `paths.ts` resolves
  locations, `scanner.ts` discovers files, and `parsers.ts` parses them.
- `aggregate.ts` synthesizes MCP servers, instructions, capabilities,
  guardrails, duplicates, and findings. `redact.ts` masks secrets.
- `writer.ts` edits with backups and optimistic concurrency. `service.ts` is
  the API facade for authorization, documents, search, sources, and exports.
- `packages/cli` contains `bin.ts`, the `npx ai-harness-helper` entry point, and
  `server.ts`, the loopback Fastify API serving the built UI and `/api/*`.
- `packages/web` is the React and Vite UI. Views live in `src/views/`, shared
  pieces in `src/components/`, and `src/api/types.ts` deliberately mirrors the
  core API contract without importing core. Update both in lockstep.

Before opening a pull request, run the primary checks:

```bash
npm run typecheck
npm test
npm run lint
npm run build
```

The dependency-free repository baseline is also available:

```bash
bash .github/scripts/validate-repository.sh
```

The root scripts are `build`, `typecheck`, `lint`, `lint:fix`, `format`,
`format:check`, `test`, `test:watch`, `start`, and `clean`.

On Windows, the repo-wide `npm run format:check` currently reports 67 files
because of a known CRLF checkout condition. Check only files you touched with
`npx prettier --check --end-of-line auto <paths>`. Do not reformat the whole
repository to make the repo-wide check pass.

## Pull requests

Pull requests should explain:

- The user or engineering outcome.
- The evidence supporting the change.
- The alternatives considered.
- Security, privacy, reliability, accessibility, and compatibility impact.
- The validation performed.

Use the pull request template and keep unrelated changes separate.
