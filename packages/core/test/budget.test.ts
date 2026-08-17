import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { aggregate } from '../src/aggregate.js';
import { computeContextBudget, type ContextBudgetReport } from '../src/budget.js';
import { estimateTokens } from '../src/review.js';
import { scan } from '../src/scanner.js';
import { createFixture, type Fixture } from './fixture.js';

let fixture: Fixture;

beforeEach(() => {
  fixture = createFixture();
});

afterEach(() => {
  fixture.cleanup();
});

async function budget(projectRoots: string[] = []): Promise<ContextBudgetReport> {
  const result = await scan({ environment: fixture.environment, projectRoots });
  return computeContextBudget(result, await aggregate(result));
}

describe('context budget', () => {
  it('counts an unscoped instruction file as always loaded', async () => {
    fixture.writeProject('CLAUDE.md', '# Rules\n\nAlways run the tests.\n');

    const report = await budget([fixture.project]);
    const contributor = report.providers
      .flatMap((provider) => provider.contributors)
      .find((entry) => entry.displayPath.endsWith('CLAUDE.md'));

    expect(contributor?.timing).toBe('always');
    expect(contributor?.alwaysBytes).toBeGreaterThan(0);
    expect(contributor?.situationalBytes).toBe(0);
  });

  it('counts a glob-scoped instruction file as conditional, not always', async () => {
    fixture.writeProject(
      '.github/instructions/ts.instructions.md',
      '---\napplyTo: "**/*.ts"\n---\n\nPrefer named exports.\n',
    );

    const report = await budget([fixture.project]);
    const contributor = report.providers
      .flatMap((provider) => provider.contributors)
      .find((entry) => entry.displayPath.endsWith('ts.instructions.md'));

    expect(contributor?.timing).toBe('conditional');
    expect(contributor?.alwaysBytes).toBe(0);
    expect(contributor?.appliesTo).toBe('**/*.ts');
    expect(report.totals.conditionalBytes).toBeGreaterThan(0);
  });

  /**
   * Progressive disclosure is the whole reason this split exists: a folder of
   * skills is not free before you use any of them, because their names and
   * descriptions still have to be advertised.
   */
  it('charges a capability for its advertised name and description, and the rest on demand', async () => {
    fixture.write(
      '.claude/skills/deploy/SKILL.md',
      '---\nname: deploy\ndescription: Ships the service to production\n---\n\n' +
        `${'A very long deployment runbook. '.repeat(60)}\n`,
    );

    const report = await budget();
    const contributor = report.providers
      .flatMap((provider) => provider.contributors)
      .find((entry) => entry.label === 'deploy');

    expect(contributor?.timing).toBe('on-demand');
    expect(contributor?.alwaysBytes).toBeGreaterThan(0);
    expect(contributor?.situationalBytes).toBeGreaterThan(contributor?.alwaysBytes ?? 0);
    expect((contributor?.alwaysBytes ?? 0) + (contributor?.situationalBytes ?? 0)).toBe(
      contributor?.fileBytes,
    );
  });

  it('estimates tokens from bytes at the documented divisor', async () => {
    fixture.writeProject('CLAUDE.md', 'x'.repeat(4000));

    const report = await budget([fixture.project]);

    expect(report.bytesPerToken).toBe(4);
    expect(report.totals.alwaysTokens).toBe(estimateTokens(report.totals.alwaysBytes));
  });

  it('names the single heaviest always-on file', async () => {
    fixture.writeProject('CLAUDE.md', 'x'.repeat(9000));
    fixture.write('.claude/CLAUDE.md', 'y'.repeat(100));

    const report = await budget([fixture.project]);

    expect(report.heaviest?.alwaysBytes).toBe(9000);
  });

  it('counts MCP servers per tool without inventing a size for them', async () => {
    fixture.write(
      '.cursor/mcp.json',
      JSON.stringify({ mcpServers: { a: { command: 'a' }, b: { command: 'b' } } }),
    );
    fixture.writeProject('.cursorrules', 'Prefer named exports.\n');

    const report = await budget([fixture.project]);
    const cursor = report.providers.find((provider) => provider.providerId === 'cursor');

    expect(cursor?.mcpServerCount).toBe(2);
    // Server tool schemas are published at runtime, so they must not appear as
    // bytes anywhere in the totals.
    expect(cursor?.alwaysBytes).toBeLessThan(200);
  });

  it('splits always-loaded bytes by scope', async () => {
    fixture.write('.claude/CLAUDE.md', 'user level rules\n');
    fixture.writeProject('CLAUDE.md', 'project level rules\n');

    const report = await budget([fixture.project]);
    const claude = report.providers.find((provider) => provider.providerId === 'claude-code');

    expect(claude?.alwaysByScope.user).toBeGreaterThan(0);
    expect(claude?.alwaysByScope.project).toBeGreaterThan(0);
    expect(claude?.alwaysByScope.managed).toBe(0);
  });

  it('returns empty totals for a machine with no harness at all', async () => {
    const report = await budget();

    expect(report.providers).toHaveLength(0);
    expect(report.totals.alwaysBytes).toBe(0);
    expect(report.heaviest).toBeUndefined();
  });
});
