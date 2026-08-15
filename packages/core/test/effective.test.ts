/**
 * Effective-configuration tests.
 *
 * The behaviour worth guarding is not "shadowing exists" but the two rules
 * that make it useful: precedence direction flips for policy, and an identical
 * shadowed copy is not reported as a contested one.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { aggregate } from '../src/aggregate.js';
import { resolveEffective } from '../src/effective.js';
import { scan } from '../src/scanner.js';
import type { EffectiveConfig, EffectiveEntry } from '../src/effective.js';
import { createFixture, type Fixture } from './fixture.js';

let fixture: Fixture;

beforeEach(() => {
  fixture = createFixture();
});

afterEach(() => {
  fixture.cleanup();
});

async function effective(projectRoots: string[] = []): Promise<EffectiveConfig> {
  const result = await scan({ environment: fixture.environment, projectRoots });
  return resolveEffective(await aggregate(result));
}

function find(config: EffectiveConfig, key: string): EffectiveEntry | undefined {
  for (const provider of config.providers) {
    const entry = provider.entries.find((candidate) => candidate.key === key);
    if (entry) return entry;
  }
  return undefined;
}

describe('resolveEffective - MCP servers', () => {
  it('does not treat two tools declaring one name as a contest', async () => {
    const config = JSON.stringify({
      mcpServers: {
        github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
      },
    });
    fixture.write('.claude/settings.json', config);
    fixture.write('.cursor/mcp.json', config);

    const resolved = await effective();

    // Each tool reads its own file, so each resolves cleanly on its own.
    expect(resolved.totalContested).toBe(0);
    for (const provider of resolved.providers) {
      const entry = provider.entries.find((candidate) => candidate.key === 'mcp:github');
      if (entry) expect(entry.shadowedCount).toBe(0);
    }
  });

  it('marks a disabled definition as disabled rather than as the winner', async () => {
    fixture.write(
      '.cursor/mcp.json',
      JSON.stringify({ mcpServers: { github: { command: 'npx', disabled: true } } }),
    );

    const resolved = await effective();
    const entry = find(resolved, 'mcp:github');

    expect(entry?.declarations[0]?.status).toBe('disabled');
  });

  it('reports every declaration with its own provenance', async () => {
    fixture.write(
      '.claude/settings.json',
      JSON.stringify({ mcpServers: { github: { command: 'npx' } } }),
    );

    const resolved = await effective();
    const entry = find(resolved, 'mcp:github');

    expect(entry?.strategy).toBe('override');
    expect(entry?.declarations).toHaveLength(1);
    expect(entry?.declarations[0]?.status).toBe('active');
    expect(entry?.winnerFileId).toBe(entry?.declarations[0]?.fileId);
  });
});

describe('resolveEffective - precedence direction', () => {
  it('lets the closest scope win for guidance', async () => {
    fixture.write('.claude/CLAUDE.md', '# House rules\n\nUser-level guidance.\n');
    fixture.writeProject('CLAUDE.md', '# House rules\n\nProject guidance.\n');

    const resolved = await effective([fixture.project]);
    const instructions = resolved.providers
      .flatMap((provider) => provider.entries)
      .filter((entry) => entry.kind === 'instruction')
      .flatMap((entry) => entry.declarations);

    const project = instructions.find((declaration) => declaration.scope === 'project');
    const user = instructions.find((declaration) => declaration.scope === 'user');

    expect(project).toBeDefined();
    expect(user).toBeDefined();
    // Instructions layer, so both apply; project ranks above user in a clash.
    expect(project?.rank).toBeGreaterThan(user?.rank ?? 0);
  });

  it('inverts precedence for guardrails, so the broader scope outranks the project', async () => {
    const permissions = JSON.stringify({ permissions: { deny: ['Bash(rm:*)'] } });
    fixture.write('.claude/settings.json', permissions);
    fixture.writeProject('.claude/settings.json', permissions);

    const resolved = await effective([fixture.project]);
    const guardrails = resolved.providers
      .flatMap((provider) => provider.entries)
      .filter((entry) => entry.kind === 'guardrail')
      .flatMap((entry) => entry.declarations);

    const project = guardrails.find((declaration) => declaration.scope === 'project');
    const user = guardrails.find((declaration) => declaration.scope === 'user');

    expect(project).toBeDefined();
    expect(user).toBeDefined();
    // A policy a project could override would not constrain anything, so the
    // ordering is deliberately the reverse of the guidance one above.
    expect(user?.rank).toBeGreaterThan(project?.rank ?? 0);
  });
});

describe('resolveEffective - contested versus merely redundant', () => {
  it('does not call an identical shadowed copy contested', async () => {
    const skill = '---\nname: reviewer\ndescription: Reviews code\n---\n\nBody.\n';
    fixture.write('.claude/skills/reviewer/SKILL.md', skill);
    fixture.writeProject('.claude/skills/reviewer/SKILL.md', skill);

    const resolved = await effective([fixture.project]);
    const entry = find(resolved, 'skill:reviewer');

    expect(entry?.shadowedCount).toBe(1);
    expect(entry?.contested).toBe(false);
  });

  it('calls a differing shadowed copy contested', async () => {
    fixture.write(
      '.claude/skills/reviewer/SKILL.md',
      '---\nname: reviewer\ndescription: Reviews code\n---\n\nUser body.\n',
    );
    fixture.writeProject(
      '.claude/skills/reviewer/SKILL.md',
      '---\nname: reviewer\ndescription: Reviews infrastructure\n---\n\nProject body.\n',
    );

    const resolved = await effective([fixture.project]);
    const entry = find(resolved, 'skill:reviewer');

    expect(entry?.shadowedCount).toBe(1);
    expect(entry?.contested).toBe(true);
    // The project copy is the closest, so it is the one that loads.
    expect(entry?.declarations.find((declaration) => declaration.status === 'active')?.scope).toBe(
      'project',
    );
  });

  it('explains every verdict in words, not just a status', async () => {
    fixture.write('.claude/skills/reviewer/SKILL.md', '---\nname: reviewer\n---\n\nUser body.\n');

    const resolved = await effective();
    const entry = find(resolved, 'skill:reviewer');

    expect(entry?.declarations.length).toBeGreaterThan(0);
    for (const declaration of entry?.declarations ?? []) {
      expect(declaration.reason.length).toBeGreaterThan(0);
    }
  });
});
