import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { aggregate } from '../src/aggregate.js';
import { reviewHarness, REVIEW_RULES, type ReviewIssue, type ReviewRuleId } from '../src/review.js';
import { scan } from '../src/scanner.js';
import { createFixture, samples, type Fixture } from './fixture.js';

let fixture: Fixture;

beforeEach(() => {
  fixture = createFixture();
});

afterEach(() => {
  fixture.cleanup();
});

/** A clock every date-sensitive assertion is written against. */
const NOW = new Date('2026-08-16T00:00:00Z');

interface ReviewOverrides {
  projectRoots?: string[];
  env?: Record<string, string | undefined>;
  now?: Date;
}

async function review(overrides: ReviewOverrides = {}): Promise<readonly ReviewIssue[]> {
  const result = await scan({
    environment: fixture.environment,
    projectRoots: overrides.projectRoots ?? [],
  });
  const inv = await aggregate(result, { now: overrides.now ?? NOW });
  const report = await reviewHarness(result, inv, {
    now: overrides.now ?? NOW,
    env: overrides.env ?? {},
  });
  return report.issues;
}

function rules(issues: readonly ReviewIssue[]): ReviewRuleId[] {
  return issues.map((issue) => issue.ruleId);
}

function find(issues: readonly ReviewIssue[], ruleId: ReviewRuleId): ReviewIssue | undefined {
  return issues.find((issue) => issue.ruleId === ruleId);
}

describe('review - rule catalogue', () => {
  it('exposes every rule with a rationale and a unique id', () => {
    const ids = REVIEW_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of REVIEW_RULES) {
      expect(rule.rationale.length).toBeGreaterThan(20);
      expect(rule.title.length).toBeGreaterThan(0);
    }
  });

  it('reports how many rules ran even when nothing fired', async () => {
    const result = await scan({ environment: fixture.environment });
    const report = await reviewHarness(result, await aggregate(result, { now: NOW }), {
      now: NOW,
      env: {},
    });

    expect(report.summary.ruleCount).toBe(REVIEW_RULES.length);
    expect(report.summary.score).toBe(100);
    expect(report.summary.grade).toBe('A');
  });
});

describe('review - capabilities', () => {
  it('flags an agent with no description as an error', async () => {
    fixture.write(
      '.claude/agents/silent.md',
      '---\nname: silent\n---\n\nDo the thing carefully.\n',
    );

    const issues = await review();
    const issue = find(issues, 'capability-missing-description');

    expect(issue?.severity).toBe('error');
    expect(issue?.subject).toBe('silent');
  });

  it('does not ask a prompt file for a description', async () => {
    fixture.write('.copilot/prompts/refactor.prompt.md', 'Refactor the selected code.\n');

    const issues = await review();

    expect(rules(issues)).not.toContain('capability-missing-description');
  });

  it('flags a description past the front-matter limit', async () => {
    fixture.write(
      '.claude/agents/verbose.md',
      `---\nname: verbose\ndescription: ${'x'.repeat(1200)}\n---\n\nBody text that is long enough to count.\n`,
    );

    const issues = await review();

    expect(rules(issues)).toContain('capability-description-too-long');
  });

  it('distinguishes unterminated front matter from no front matter', async () => {
    fixture.write(
      '.claude/agents/broken.md',
      '---\nname: broken\ndescription: never closed\n\n# Heading\n\nSome instructions here.\n',
    );

    const issues = await review();
    const issue = find(issues, 'capability-missing-frontmatter');

    expect(issue?.title).toContain('never closed');
  });

  it('flags a declared name that disagrees with the file name', async () => {
    fixture.write(
      '.claude/agents/reviewer.md',
      '---\nname: totally-different\ndescription: Reviews pull requests carefully\n---\n\nReview the diff.\n',
    );

    const issues = await review();
    const issue = find(issues, 'capability-name-mismatch');

    expect(issue?.evidence).toContain('totally-different');
  });

  it('accepts a name that differs only by case or separator', async () => {
    fixture.write(
      '.claude/agents/pr-reviewer.md',
      '---\nname: PR_Reviewer\ndescription: Reviews pull requests carefully\n---\n\nReview the diff.\n',
    );

    const issues = await review();

    expect(rules(issues)).not.toContain('capability-name-mismatch');
  });

  it('resolves a skill name from its containing directory', async () => {
    fixture.write(
      '.claude/skills/deploy/SKILL.md',
      '---\nname: deploy\ndescription: Ships the service to production safely\n---\n\nRun the deploy pipeline.\n',
    );

    const issues = await review();

    expect(rules(issues)).not.toContain('capability-name-mismatch');
  });

  it('flags a capability that declares itself but gives no instructions', async () => {
    fixture.write(
      '.claude/agents/hollow.md',
      '---\nname: hollow\ndescription: Claims to do something useful\n---\n',
    );

    const issues = await review();

    expect(rules(issues)).toContain('capability-empty-body');
  });

  it('flags an allowlisted MCP server that no file declares', async () => {
    fixture.write(
      '.claude/agents/ghost.md',
      '---\nname: ghost\ndescription: Uses a server that is not configured anywhere\ntools:\n  - mcp__nowhere__query\n---\n\nQuery the thing.\n',
    );

    const issues = await review();
    const issue = find(issues, 'capability-unknown-tool');

    expect(issue?.evidence).toBe('mcp__nowhere__query');
  });

  it('does not treat a built-in tool name as an MCP server', async () => {
    fixture.write(
      '.claude/agents/plain.md',
      '---\nname: plain\ndescription: Uses only built-in tools for its work\ntools:\n  - Read\n  - Bash\n  - WebSearch\n---\n\nRead the file.\n',
    );

    const issues = await review();

    expect(rules(issues)).not.toContain('capability-unknown-tool');
  });

  it('accepts an allowlist entry naming a server that is configured', async () => {
    fixture.write('.claude/settings.json', samples.claudeMcp);
    fixture.write(
      '.claude/agents/real.md',
      '---\nname: real\ndescription: Uses the configured GitHub server for reviews\ntools:\n  - mcp__github__search\n---\n\nSearch GitHub.\n',
    );

    const issues = await review();

    expect(rules(issues)).not.toContain('capability-unknown-tool');
  });
});

describe('review - freshness', () => {
  it('flags a markdown link to a file that does not exist', async () => {
    fixture.write(
      '.claude/agents/linker.md',
      '---\nname: linker\ndescription: Points at a document that has since been deleted\n---\n\nSee [the runbook](./runbook.md) before starting.\n',
    );

    const issues = await review();
    const issue = find(issues, 'broken-reference');

    expect(issue?.evidence).toBe('./runbook.md');
  });

  it('accepts a link that resolves next to the file', async () => {
    fixture.write('.claude/agents/runbook.md', '# Runbook\n');
    fixture.write(
      '.claude/agents/linker.md',
      '---\nname: linker\ndescription: Points at a document that is genuinely there\n---\n\nSee [the runbook](./runbook.md) before starting.\n',
    );

    const issues = await review();

    expect(rules(issues)).not.toContain('broken-reference');
  });

  it('ignores external URLs and bare anchors', async () => {
    fixture.write(
      '.claude/agents/linker.md',
      '---\nname: linker\ndescription: Links out to the web rather than to local files\n---\n\n' +
        'See [docs](https://example.com/guide) and [below](#later) and [mail](mailto:a@b.c).\n',
    );

    const issues = await review();

    expect(rules(issues)).not.toContain('broken-reference');
  });

  it('flags a self-declared verification date that has gone stale', async () => {
    fixture.write(
      '.claude/agents/dated.md',
      '---\nname: dated\ndescription: Asserts its own currency with an old date\n---\n\nLast verified 2023-01-15. The API still works this way.\n',
    );

    const issues = await review();
    const issue = find(issues, 'stale-date');

    expect(issue?.detail).toContain('Last verified 2023-01-15');
  });

  it('leaves a recent verification date alone', async () => {
    fixture.write(
      '.claude/agents/fresh.md',
      '---\nname: fresh\ndescription: Asserts its own currency with a recent date\n---\n\nLast verified 2026-07-01. The API still works this way.\n',
    );

    const issues = await review();

    expect(rules(issues)).not.toContain('stale-date');
  });

  it('flags a retired product name and names its replacement', async () => {
    fixture.write(
      '.claude/agents/legacy.md',
      '---\nname: legacy\ndescription: Written before the product was renamed by the vendor\n---\n\nGrant the app registration in Azure Active Directory.\n',
    );

    const issues = await review();
    const issue = find(issues, 'renamed-product');

    expect(issue?.remediation).toContain('Microsoft Entra ID');
  });

  it('flags a retired model named in prose but not one that is still supported', async () => {
    fixture.write(
      '.claude/agents/prose.md',
      '---\nname: prose\ndescription: Names a model in its body rather than its front matter\n---\n\nAlways use gpt-4-32k for this task.\n',
    );

    const issues = await review();
    const issue = find(issues, 'model-in-prose');

    expect(issue?.evidence).toBe('gpt-4-32k');
  });
});

describe('review - instructions', () => {
  it('flags an always-on instruction file that is very large', async () => {
    fixture.writeProject('CLAUDE.md', `# Rules\n\n${'Always be careful. '.repeat(1200)}`);

    const issues = await review({ projectRoots: [fixture.project] });

    expect(rules(issues)).toContain('instruction-oversized');
  });

  it('flags an instructions-directory file with no applyTo', async () => {
    fixture.writeProject(
      '.github/instructions/style.instructions.md',
      '---\ndescription: Style rules\n---\n\nUse two-space indentation everywhere in this repository.\n',
    );

    const issues = await review({ projectRoots: [fixture.project] });

    expect(rules(issues)).toContain('instruction-missing-applyto');
  });

  it('accepts an instructions file that declares applyTo', async () => {
    fixture.writeProject(
      '.github/instructions/style.instructions.md',
      '---\napplyTo: "**/*.ts"\ndescription: Style rules\n---\n\nUse two-space indentation everywhere in this repository.\n',
    );

    const issues = await review({ projectRoots: [fixture.project] });

    expect(rules(issues)).not.toContain('instruction-missing-applyto');
  });

  it('flags an instruction file that is headings only', async () => {
    fixture.writeProject('CLAUDE.md', '# Project rules\n\n## Testing\n\n## Style\n');

    const issues = await review({ projectRoots: [fixture.project] });

    expect(rules(issues)).toContain('instruction-no-guidance');
  });
});

describe('review - MCP servers', () => {
  it('flags an environment variable the definition expands but nothing sets', async () => {
    fixture.write(
      '.cursor/mcp.json',
      JSON.stringify({
        mcpServers: { gh: { command: 'gh-mcp', env: { TOKEN: '${GH_MCP_TOKEN}' } } },
      }),
    );

    const issues = await review({ env: {} });
    const issue = find(issues, 'mcp-env-var-unset');

    expect(issue?.evidence).toBe('GH_MCP_TOKEN');
  });

  it('stays quiet when the variable is set in the environment', async () => {
    fixture.write(
      '.cursor/mcp.json',
      JSON.stringify({
        mcpServers: { gh: { command: 'gh-mcp', env: { TOKEN: '${GH_MCP_TOKEN}' } } },
      }),
    );

    const issues = await review({ env: { GH_MCP_TOKEN: 'present' } });

    expect(rules(issues)).not.toContain('mcp-env-var-unset');
  });

  it('flags an unpinned npx package', async () => {
    fixture.write(
      '.cursor/mcp.json',
      JSON.stringify({ mcpServers: { pw: { command: 'npx', args: ['-y', '@playwright/mcp'] } } }),
    );

    const issues = await review();
    const issue = find(issues, 'mcp-unpinned-package');

    expect(issue?.evidence).toBe('@playwright/mcp');
  });

  it('treats @latest as unpinned and reports the bare package name', async () => {
    fixture.write(
      '.cursor/mcp.json',
      JSON.stringify({
        mcpServers: { pw: { command: 'npx', args: ['@playwright/mcp@latest'] } },
      }),
    );

    const issues = await review();

    expect(find(issues, 'mcp-unpinned-package')?.evidence).toBe('@playwright/mcp');
  });

  it('accepts a pinned scoped package', async () => {
    fixture.write(
      '.cursor/mcp.json',
      JSON.stringify({
        mcpServers: { pw: { command: 'npx', args: ['-y', '@playwright/mcp@1.2.3'] } },
      }),
    );

    const issues = await review();

    expect(rules(issues)).not.toContain('mcp-unpinned-package');
  });

  it('flags a plain HTTP endpoint but not a loopback one', async () => {
    fixture.write(
      '.cursor/mcp.json',
      JSON.stringify({
        mcpServers: {
          remote: { url: 'http://mcp.example.com/sse' },
          local: { url: 'http://localhost:3000/sse' },
        },
      }),
    );

    const issues = await review();
    const insecure = issues.filter((issue) => issue.ruleId === 'mcp-insecure-endpoint');

    expect(insecure).toHaveLength(1);
    expect(insecure[0]?.subject).toBe('remote');
  });

  it('flags a server that is declared but disabled', async () => {
    fixture.write(
      '.cursor/mcp.json',
      JSON.stringify({ mcpServers: { old: { command: 'old-mcp', disabled: true } } }),
    );

    const issues = await review();

    expect(rules(issues)).toContain('mcp-disabled');
  });

  it('flags a stdio command whose absolute path is not on this machine', async () => {
    const missing = process.platform === 'win32' ? 'C:\\nope\\mcp-server.exe' : '/nope/mcp-server';
    fixture.write(
      '.cursor/mcp.json',
      JSON.stringify({ mcpServers: { local: { command: missing } } }),
    );

    const issues = await review();

    expect(rules(issues)).toContain('mcp-command-missing');
  });
});

describe('review - guardrails', () => {
  it('flags a wildcard allow rule', async () => {
    fixture.write(
      '.claude/settings.json',
      JSON.stringify({ permissions: { allow: ['Bash(*)'], deny: [] } }),
    );

    const issues = await review();
    const issue = find(issues, 'guardrail-overbroad-allow');

    expect(issue?.evidence).toBe('Bash(*)');
  });

  it('leaves a scoped allow rule alone', async () => {
    fixture.write(
      '.claude/settings.json',
      JSON.stringify({ permissions: { allow: ['Bash(git status)', 'Bash(npm test)'], deny: [] } }),
    );

    const issues = await review();

    expect(rules(issues)).not.toContain('guardrail-overbroad-allow');
  });

  it('flags a rule that appears in both allow and deny', async () => {
    fixture.write(
      '.claude/settings.json',
      JSON.stringify({ permissions: { allow: ['Bash(git push)'], deny: ['Bash(git push)'] } }),
    );

    const issues = await review();

    expect(rules(issues)).toContain('guardrail-allow-shadows-deny');
  });
});

describe('review - scoring', () => {
  it('deducts more for an error than for a suggestion', async () => {
    fixture.write(
      '.claude/agents/silent.md',
      '---\nname: silent\n---\n\nDo the thing carefully.\n',
    );

    const result = await scan({ environment: fixture.environment });
    const report = await reviewHarness(result, await aggregate(result, { now: NOW }), {
      now: NOW,
      env: {},
    });

    expect(report.summary.errorCount).toBeGreaterThan(0);
    expect(report.summary.score).toBeLessThan(100);
    expect(report.summary.byCategory.capability).toBeGreaterThan(0);
  });

  it('never scores below zero', async () => {
    for (let index = 0; index < 30; index += 1) {
      fixture.write(`.claude/agents/a${index}.md`, `---\nname: a${index}\n---\n\nDo the thing.\n`);
    }

    const result = await scan({ environment: fixture.environment });
    const report = await reviewHarness(result, await aggregate(result, { now: NOW }), {
      now: NOW,
      env: {},
    });

    expect(report.summary.score).toBe(0);
    expect(report.summary.grade).toBe('F');
  });
});
