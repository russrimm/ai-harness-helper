import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { groupByProvider, scan } from '../src/scanner.js';
import { createFixture, samples, type Fixture } from './fixture.js';

let fixture: Fixture;

beforeEach(() => {
  fixture = createFixture();
});

afterEach(() => {
  fixture.cleanup();
});

describe('scan - user scope', () => {
  it('finds Claude Code settings and reports the owning provider', async () => {
    fixture.write('.claude/settings.json', samples.claudeSettings);

    const result = await scan({ environment: fixture.environment });
    const file = result.files.find((f) => f.path.endsWith(join('.claude', 'settings.json')));

    expect(file).toBeDefined();
    expect(file?.providerId).toBe('claude-code');
    expect(file?.locationId).toBe('user-settings');
    expect(file?.scope).toBe('user');
    expect(file?.format).toBe('json');
    expect(result.detectedProviders).toContain('claude-code');
  });

  it('records size, modification time, and a content hash', async () => {
    fixture.write('.claude/settings.json', samples.claudeSettings);
    const result = await scan({ environment: fixture.environment });
    const file = result.files.find((f) => f.providerId === 'claude-code');

    expect(file?.size).toBe(Buffer.byteLength(samples.claudeSettings));
    expect(file?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(() => new Date(file?.modified ?? '')).not.toThrow();
  });

  it('abbreviates the home directory in the display path', async () => {
    fixture.write('.claude/settings.json', samples.claudeSettings);
    const result = await scan({ environment: fixture.environment });
    const file = result.files.find((f) => f.providerId === 'claude-code');
    expect(file?.displayPath.startsWith('~')).toBe(true);
  });

  it('discovers files across multiple providers in one pass', async () => {
    fixture.write('.claude/settings.json', samples.claudeSettings);
    fixture.write('.codex/config.toml', samples.codexConfig);
    fixture.write('.copilot/config.json', samples.copilotConfig);
    fixture.write('.docker/mcp/registry.yaml', samples.dockerRegistry);
    fixture.write('.cursor/mcp.json', samples.claudeMcp);

    const result = await scan({ environment: fixture.environment });

    expect(result.detectedProviders).toEqual(
      expect.arrayContaining(['claude-code', 'codex', 'copilot-cli', 'docker', 'cursor']),
    );
  });

  it('marks credential stores with credential-store sensitivity', async () => {
    fixture.write('.codex/auth.json', '{"OPENAI_API_KEY":"sk-secret"}');
    const result = await scan({ environment: fixture.environment });
    const auth = result.files.find((f) => f.name === 'auth.json');
    expect(auth?.sensitivity).toBe('credential-store');
    expect(auth?.kind).toBe('credential');
  });

  it('reports locations that do not exist as missing rather than as errors', async () => {
    const result = await scan({ environment: fixture.environment });
    expect(result.problems).toEqual([]);
    expect(result.missing.length).toBeGreaterThan(0);
    expect(result.missing.every((m) => m.checkedPaths.length > 0)).toBe(true);
  });
});

describe('scan - directory locations', () => {
  it('expands glob patterns into individual files', async () => {
    fixture.write('.copilot/agents/reviewer.agent.md', samples.agentFile);
    fixture.write('.copilot/agents/planner.agent.md', samples.agentFile);

    const result = await scan({ environment: fixture.environment });
    const agents = result.files.filter(
      (f) => f.locationId === 'user-agents' && f.providerId === 'copilot-cli',
    );

    expect(agents).toHaveLength(2);
    expect(agents.map((a) => a.name).sort()).toEqual(['planner.agent.md', 'reviewer.agent.md']);
    expect(agents[0]?.kind).toBe('agent');
  });

  it('infers per-file formats inside mixed directories', async () => {
    fixture.write('AppData/Roaming/Code/User/prompts/dev.prompt.md', samples.agentFile);
    fixture.write('AppData/Roaming/Code/User/prompts/Basic.toolsets.jsonc', '{ /* c */ "a": 1 }');
    fixture.write('.config/Code/User/prompts/dev.prompt.md', samples.agentFile);
    fixture.write('.config/Code/User/prompts/Basic.toolsets.jsonc', '{ /* c */ "a": 1 }');

    const result = await scan({ environment: fixture.environment });
    const prompts = result.files.filter(
      (f) => f.locationId === 'user-prompts' && f.providerId === 'vscode',
    );

    expect(prompts.length).toBeGreaterThanOrEqual(2);
    expect(prompts.find((p) => p.name.endsWith('.jsonc'))?.format).toBe('jsonc');
    expect(prompts.find((p) => p.name.endsWith('.md'))?.format).toBe('md-frontmatter');
  });

  it('refines file kind from a capability suffix, not just the folder', async () => {
    fixture.write('AppData/Roaming/Code/User/prompts/dev.prompt.md', samples.agentFile);
    fixture.write('AppData/Roaming/Code/User/prompts/Beast.chatmode.md', samples.agentFile);
    fixture.write('AppData/Roaming/Code/User/prompts/repo.instructions.md', samples.agentFile);
    fixture.write('.config/Code/User/prompts/dev.prompt.md', samples.agentFile);
    fixture.write('.config/Code/User/prompts/Beast.chatmode.md', samples.agentFile);
    fixture.write('.config/Code/User/prompts/repo.instructions.md', samples.agentFile);

    const result = await scan({ environment: fixture.environment });
    const byName = new Map(
      result.files
        .filter((f) => f.locationId === 'user-prompts' && f.providerId === 'vscode')
        .map((f) => [f.name, f.kind]),
    );

    expect(byName.get('dev.prompt.md')).toBe('prompt');
    expect(byName.get('Beast.chatmode.md')).toBe('chatmode');
    expect(byName.get('repo.instructions.md')).toBe('instructions');
  });

  it('does not descend into ignored directories', async () => {
    fixture.write('.claude/skills/node_modules/evil/SKILL.md', '# nope');
    fixture.write('.claude/skills/real/SKILL.md', '# yes');

    const result = await scan({ environment: fixture.environment });
    const skills = result.files.filter((f) => f.locationId === 'user-skills');

    expect(skills).toHaveLength(1);
    expect(skills[0]?.path).toContain('real');
  });
});

describe('scan - project scope', () => {
  it('finds project files only when a root is supplied', async () => {
    fixture.writeProject('.mcp.json', samples.claudeMcp);

    const without = await scan({ environment: fixture.environment });
    expect(without.files.some((f) => f.path.endsWith('.mcp.json'))).toBe(false);

    const withRoot = await scan({
      environment: fixture.environment,
      projectRoots: [fixture.project],
    });
    const file = withRoot.files.find((f) => f.name === '.mcp.json');

    expect(file).toBeDefined();
    expect(file?.scope).toBe('project');
    expect(file?.projectRoot).toBe(fixture.project);
  });

  it('counts files per project root', async () => {
    fixture.writeProject('.mcp.json', samples.claudeMcp);
    fixture.writeProject('CLAUDE.md', samples.claudeMd);
    fixture.writeProject('.github/copilot-instructions.md', '# Instructions');

    const result = await scan({
      environment: fixture.environment,
      projectRoots: [fixture.project],
    });

    expect(result.projectRoots).toHaveLength(1);
    expect(result.projectRoots[0]?.fileCount).toBeGreaterThanOrEqual(3);
  });

  it('supports scanning several project roots at once', async () => {
    const second = join(fixture.root, 'other-project');
    mkdirSync(second, { recursive: true });
    writeFileSync(join(second, 'AGENTS.md'), samples.agentsMd);
    fixture.writeProject('AGENTS.md', samples.agentsMd);

    const result = await scan({
      environment: fixture.environment,
      projectRoots: [fixture.project, second],
    });

    expect(result.projectRoots).toHaveLength(2);
    expect(result.files.filter((f) => f.name === 'AGENTS.md')).toHaveLength(2);
  });

  it('skips user-scope locations when projectsOnly is set', async () => {
    fixture.write('.claude/settings.json', samples.claudeSettings);
    fixture.writeProject('AGENTS.md', samples.agentsMd);

    const result = await scan({
      environment: fixture.environment,
      projectRoots: [fixture.project],
      projectsOnly: true,
    });

    expect(result.files.every((f) => f.scope === 'project')).toBe(true);
  });
});

describe('scan - unattributed sweep', () => {
  it('surfaces harness-shaped files no provider claims', async () => {
    fixture.writeProject('tools/config/mcp.json', '{"servers":{}}');

    const result = await scan({
      environment: fixture.environment,
      projectRoots: [fixture.project],
    });
    const stray = result.files.find((f) => f.unattributed === true);

    expect(stray).toBeDefined();
    expect(stray?.providerId).toBe('unattributed');
    expect(stray?.kind).toBe('mcp');
    expect(stray?.note).toContain('No provider claims this path');
  });

  it('does not double-report a file a provider already claimed', async () => {
    fixture.writeProject('.mcp.json', samples.claudeMcp);
    fixture.writeProject('AGENTS.md', samples.agentsMd);

    const result = await scan({
      environment: fixture.environment,
      projectRoots: [fixture.project],
    });

    expect(result.files.filter((f) => f.name === '.mcp.json')).toHaveLength(1);
    expect(result.files.filter((f) => f.name === 'AGENTS.md')).toHaveLength(1);
    expect(result.files.filter((f) => f.unattributed)).toHaveLength(0);
  });

  it('respects the sweep depth limit', async () => {
    fixture.writeProject('a/b/c/d/e/f/mcp.json', '{}');

    const result = await scan({
      environment: fixture.environment,
      projectRoots: [fixture.project],
      sweepDepth: 2,
    });

    expect(result.files.filter((f) => f.unattributed)).toHaveLength(0);
  });

  it('ignores node_modules during the sweep', async () => {
    fixture.writeProject('node_modules/pkg/AGENTS.md', '# vendored');

    const result = await scan({
      environment: fixture.environment,
      projectRoots: [fixture.project],
    });

    expect(result.files.filter((f) => f.unattributed)).toHaveLength(0);
  });
});

describe('scan - resilience', () => {
  it('never claims the same absolute path twice', async () => {
    fixture.write('.claude/settings.json', samples.claudeSettings);
    fixture.writeProject('AGENTS.md', samples.agentsMd);

    const result = await scan({
      environment: fixture.environment,
      projectRoots: [fixture.project],
    });
    const paths = result.files.map((f) => f.path);

    expect(new Set(paths).size).toBe(paths.length);
  });

  it('assigns a stable id derived from the path', async () => {
    fixture.write('.claude/settings.json', samples.claudeSettings);
    const first = await scan({ environment: fixture.environment });
    const second = await scan({ environment: fixture.environment });

    expect(first.files[0]?.id).toBe(second.files[0]?.id);
  });

  it('flags oversized files instead of hashing them', async () => {
    fixture.write('.claude/settings.json', 'x'.repeat(2048));

    const result = await scan({ environment: fixture.environment, maxFileBytes: 1024 });
    const file = result.files.find((f) => f.providerId === 'claude-code');

    expect(file?.hash).toBe('');
    expect(result.problems.some((p) => p.code === 'too-large')).toBe(true);
  });

  it('honours an already-aborted scan signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      scan({ environment: fixture.environment, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it.skipIf(process.platform === 'win32')(
    'does not follow a directly configured symlink',
    async () => {
      const outside = fixture.write('outside.json', samples.claudeSettings);
      const target = join(fixture.home, '.claude', 'settings.json');
      mkdirSync(join(fixture.home, '.claude'), { recursive: true });
      symlinkSync(outside, target);

      const result = await scan({ environment: fixture.environment });
      expect(result.files.some((file) => file.path === target)).toBe(false);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'reports an unreadable directory as a problem and keeps scanning',
    async () => {
      fixture.write('.claude/settings.json', samples.claudeSettings);
      const locked = join(fixture.home, '.claude', 'agents');
      mkdirSync(locked, { recursive: true });
      writeFileSync(join(locked, 'a.md'), '# a');
      chmodSync(locked, 0o000);

      try {
        const result = await scan({ environment: fixture.environment });
        expect(result.files.some((f) => f.locationId === 'user-settings')).toBe(true);
      } finally {
        chmodSync(locked, 0o755);
      }
    },
  );

  it('returns a duration and timestamp', async () => {
    const result = await scan({ environment: fixture.environment });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(Date.parse(result.scannedAt))).toBe(false);
  });
});

describe('groupByProvider', () => {
  it('groups files and sorts unattributed entries last', async () => {
    fixture.write('.claude/settings.json', samples.claudeSettings);
    fixture.writeProject('deep/nested/mcp.json', '{}');

    const result = await scan({
      environment: fixture.environment,
      projectRoots: [fixture.project],
    });
    const groups = groupByProvider(result.files);

    expect(groups.length).toBeGreaterThan(0);
    expect(groups[groups.length - 1]?.providerId).toBe('unattributed');
  });
});
