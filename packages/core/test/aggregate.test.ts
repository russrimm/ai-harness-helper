import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { aggregate } from '../src/aggregate.js';
import { scan } from '../src/scanner.js';
import type { HarnessInventory } from '../src/aggregate.js';
import { createFixture, samples, type Fixture } from './fixture.js';

let fixture: Fixture;

beforeEach(() => {
  fixture = createFixture();
});

afterEach(() => {
  fixture.cleanup();
});

async function inventory(projectRoots: string[] = []): Promise<HarnessInventory> {
  const result = await scan({ environment: fixture.environment, projectRoots });
  return aggregate(result);
}

describe('aggregate - MCP inventory', () => {
  it('collects servers from the mcpServers container', async () => {
    fixture.write('.claude/settings.json', samples.claudeMcp);

    const result = await inventory();
    const names = result.mcpServers.map((server) => server.name);

    expect(names).toContain('github');
    expect(names).toContain('filesystem');
  });

  it('collects servers from the servers container used by VS Code', async () => {
    fixture.write('.config/Code/User/mcp.json', samples.vscodeMcp);
    fixture.write('AppData/Roaming/Code/User/mcp.json', samples.vscodeMcp);

    const result = await inventory();
    const playwright = result.mcpServers.find((server) => server.name === 'playwright');

    expect(playwright).toBeDefined();
    expect(playwright?.definitions[0]?.command).toBe('npx');
  });

  it('collects servers from the mcp_servers container used by Codex TOML', async () => {
    fixture.write('.codex/config.toml', samples.codexConfig);

    const result = await inventory();
    const github = result.mcpServers.find((server) => server.name === 'github');

    expect(github).toBeDefined();
    expect(github?.definitions[0]?.command).toBe('npx');
    expect(github?.definitions[0]?.transport).toBe('stdio');
  });

  it('collects per-project servers nested under a projects map', async () => {
    fixture.write(
      '.claude.json',
      JSON.stringify({
        projects: {
          '/work/api': {
            mcpServers: { postgres: { command: 'uvx', args: ['mcp-server-postgres'] } },
          },
        },
      }),
    );

    const result = await inventory();
    const postgres = result.mcpServers.find((server) => server.name === 'postgres');

    expect(postgres).toBeDefined();
    expect(postgres?.definitions[0]?.projectRoot).toBe('/work/api');
  });

  it('records which providers declare each server', async () => {
    fixture.write('.claude/settings.json', samples.claudeMcp);
    fixture.write('.cursor/mcp.json', samples.claudeMcp);

    const result = await inventory();
    const github = result.mcpServers.find((server) => server.name === 'github');

    expect(github?.providerIds).toContain('claude-code');
    expect(github?.providerIds).toContain('cursor');
  });

  it('infers http transport from a url', async () => {
    fixture.write(
      '.cursor/mcp.json',
      JSON.stringify({ mcpServers: { remote: { url: 'https://mcp.example.com/sse' } } }),
    );

    const result = await inventory();

    expect(result.mcpServers[0]?.transport ?? result.mcpServers[0]?.definitions[0]?.transport).toBe(
      'http',
    );
  });

  it('honours an explicitly declared transport over the inferred one', async () => {
    fixture.write(
      '.cursor/mcp.json',
      JSON.stringify({ mcpServers: { remote: { type: 'sse', url: 'https://mcp.example.com' } } }),
    );

    const result = await inventory();

    expect(result.mcpServers[0]?.definitions[0]?.transport).toBe('sse');
  });

  it('lists environment variable names without their values', async () => {
    fixture.write('.claude/settings.json', samples.claudeMcp);

    const result = await inventory();
    const github = result.mcpServers.find((server) => server.name === 'github');
    const serialized = JSON.stringify(github);

    expect(github?.definitions[0]?.envKeys).toEqual(['GITHUB_PERSONAL_ACCESS_TOKEN']);
    expect(serialized).not.toContain('******');
  });

  it('marks a server disabled when the tool disables it', async () => {
    fixture.write(
      '.cursor/mcp.json',
      JSON.stringify({ mcpServers: { paused: { command: 'npx', disabled: true } } }),
    );

    const result = await inventory();

    expect(result.mcpServers[0]?.definitions[0]?.disabled).toBe(true);
  });

  it('treats a catalog reference as a stdio server launched by the tool gateway', async () => {
    fixture.write(
      '.docker/mcp/registry.yaml',
      'registry:\n  context7:\n    ref: "github:docker/labs?path=context7.md"\n',
    );

    const result = await inventory();
    const definition = result.mcpServers.find((s) => s.name === 'context7')?.definitions[0];

    expect(definition?.transport).toBe('stdio');
    expect(definition?.reference).toBe('github:docker/labs?path=context7.md');
  });

  it('excludes marketplace catalogs so available servers are not read as configured ones', async () => {
    // Docker ships a catalog of every server it offers alongside the small
    // registry of servers the user actually enabled. Only the latter is part
    // of the harness.
    fixture.write('.docker/mcp/registry.yaml', 'registry:\n  enabled-one:\n    ref: ""\n');
    fixture.write(
      '.docker/mcp/catalogs/docker-mcp.yaml',
      'registry:\n  offered-a:\n    ref: ""\n  offered-b:\n    ref: ""\n',
    );

    const result = await inventory();
    const names = result.mcpServers.map((server) => server.name);

    expect(names).toContain('enabled-one');
    expect(names).not.toContain('offered-a');
    expect(names).not.toContain('offered-b');
  });
});

describe('aggregate - duplicate and conflict detection', () => {
  it('flags a server defined identically in two tools as duplicated, not conflicting', async () => {
    const definition = JSON.stringify({
      mcpServers: {
        github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
      },
    });
    fixture.write('.claude/settings.json', definition);
    fixture.write('.cursor/mcp.json', definition);

    const result = await inventory();
    const github = result.mcpServers.find((server) => server.name === 'github');

    expect(github?.duplicated).toBe(true);
    expect(github?.conflicting).toBe(false);
    expect(result.findings.some((f) => f.code === 'mcp-duplicate')).toBe(true);
    expect(result.findings.some((f) => f.code === 'mcp-conflict')).toBe(false);
  });

  it('flags a server two tools start differently as conflicting', async () => {
    fixture.write(
      '.claude/settings.json',
      JSON.stringify({ mcpServers: { github: { command: 'npx', args: ['server-github'] } } }),
    );
    fixture.write(
      '.cursor/mcp.json',
      JSON.stringify({ mcpServers: { github: { command: 'docker', args: ['run', 'gh-mcp'] } } }),
    );

    const result = await inventory();
    const github = result.mcpServers.find((server) => server.name === 'github');
    const conflict = result.findings.find((f) => f.code === 'mcp-conflict');

    expect(github?.conflicting).toBe(true);
    expect(conflict?.severity).toBe('error');
    expect(conflict?.displayPaths).toHaveLength(2);
  });

  it('does not treat differing credentials as a conflict', async () => {
    fixture.write(
      '.claude/settings.json',
      JSON.stringify({
        mcpServers: {
          gh: { command: 'npx', args: ['x'], env: { TOKEN: 'ghp_aaaaaaaaaaaaaaaaaaaa' } },
        },
      }),
    );
    fixture.write(
      '.cursor/mcp.json',
      JSON.stringify({
        mcpServers: {
          gh: { command: 'npx', args: ['x'], env: { TOKEN: 'ghp_bbbbbbbbbbbbbbbbbbbb' } },
        },
      }),
    );

    const result = await inventory();

    expect(result.mcpServers.find((server) => server.name === 'gh')?.conflicting).toBe(false);
  });

  it('treats the same executable reached by different paths as the same server', async () => {
    fixture.write(
      '.claude/settings.json',
      JSON.stringify({ mcpServers: { fs: { command: 'npx', args: ['server-fs'] } } }),
    );
    fixture.write(
      '.cursor/mcp.json',
      JSON.stringify({
        mcpServers: { fs: { command: '/usr/local/bin/npx.cmd', args: ['server-fs'] } },
      }),
    );

    const result = await inventory();

    expect(result.mcpServers.find((server) => server.name === 'fs')?.conflicting).toBe(false);
  });

  it('ignores a trailing slash when comparing urls', async () => {
    fixture.write(
      '.claude/settings.json',
      JSON.stringify({ mcpServers: { api: { url: 'https://mcp.example.com/' } } }),
    );
    fixture.write(
      '.cursor/mcp.json',
      JSON.stringify({ mcpServers: { api: { url: 'https://mcp.example.com' } } }),
    );

    const result = await inventory();

    expect(result.mcpServers.find((server) => server.name === 'api')?.conflicting).toBe(false);
  });
});

describe('aggregate - instructions', () => {
  it('collects instruction files and orders project guidance above user guidance', async () => {
    fixture.write('.claude/CLAUDE.md', '# Global\n\nAlways be terse.\n');
    fixture.writeProject('CLAUDE.md', samples.claudeMd);

    const result = await inventory([fixture.project]);

    expect(result.instructions.length).toBeGreaterThanOrEqual(2);
    expect(result.instructions[0]?.scope).toBe('project');
  });

  it('uses a leading heading as the title when no front matter declares one', async () => {
    fixture.writeProject('AGENTS.md', samples.agentsMd);

    const result = await inventory([fixture.project]);
    const agents = result.instructions.find((entry) => entry.displayPath.endsWith('AGENTS.md'));

    expect(agents?.title).toBe('AGENTS.md');
  });

  it('extracts the applyTo glob from instruction front matter', async () => {
    fixture.writeProject(
      '.github/instructions/ts.instructions.md',
      '---\napplyTo: "**/*.ts"\ndescription: TypeScript rules\n---\n\nUse strict mode.\n',
    );

    const result = await inventory([fixture.project]);
    const entry = result.instructions.find((i) => i.displayPath.endsWith('ts.instructions.md'));

    expect(entry?.appliesTo).toBe('**/*.ts');
    expect(entry?.description).toBe('TypeScript rules');
  });

  it('counts lines so the UI can show instruction weight', async () => {
    fixture.writeProject('AGENTS.md', 'a\nb\nc\n');

    const result = await inventory([fixture.project]);
    const agents = result.instructions.find((entry) => entry.displayPath.endsWith('AGENTS.md'));

    expect(agents?.lineCount).toBe(4);
  });
});

describe('aggregate - capabilities', () => {
  it('reads name, description, and tools from agent front matter', async () => {
    fixture.write('.claude/agents/reviewer.md', samples.agentFile);

    const result = await inventory();
    const reviewer = result.capabilities.find((entry) => entry.name === 'reviewer');

    expect(reviewer).toBeDefined();
    expect(reviewer?.description).toBe('Reviews pull requests');
    expect(reviewer?.tools).toEqual(['read', 'grep']);
    expect(reviewer?.kind).toBe('agent');
  });

  it('derives an invocation name from a compound file extension', async () => {
    fixture.writeProject('.github/prompts/review.prompt.md', '# Review\n\nReview the diff.\n');

    const result = await inventory([fixture.project]);
    const prompt = result.capabilities.find((entry) =>
      entry.displayPath.endsWith('review.prompt.md'),
    );

    expect(prompt?.name).toBe('review');
    expect(prompt?.kind).toBe('prompt');
  });

  it('accepts a comma-separated tools string as well as a list', async () => {
    fixture.write(
      '.claude/agents/tester.md',
      '---\nname: tester\ntools: read, bash, edit\n---\n\nRun the tests.\n',
    );

    const result = await inventory();
    const tester = result.capabilities.find((entry) => entry.name === 'tester');

    expect(tester?.tools).toEqual(['read', 'bash', 'edit']);
  });
});

describe('aggregate - model pins', () => {
  // Fixed clocks, because the point of the feature is that status is derived
  // from an announced date rather than baked into the table.
  const BEFORE_SHUTDOWNS = new Date('2024-01-01T00:00:00Z');
  const AFTER_SHUTDOWNS = new Date('2099-01-01T00:00:00Z');

  async function withClock(now: Date, projectRoots: string[] = []): Promise<HarnessInventory> {
    const result = await scan({ environment: fixture.environment, projectRoots });
    return aggregate(result, { now });
  }

  it('finds a model pinned in agent front matter', async () => {
    fixture.write(
      '.claude/agents/reviewer.md',
      '---\nname: reviewer\nmodel: gpt-4-32k\n---\n\nGo.\n',
    );

    const result = await withClock(AFTER_SHUTDOWNS);
    const pin = result.modelUsage.find((entry) => entry.reference === 'gpt-4-32k');

    expect(pin).toBeDefined();
    expect(pin?.path).toBe('model');
    expect(pin?.entityName).toBe('reviewer');
    expect(pin?.assessment.status).toBe('retired');
  });

  it('finds a model pinned deep inside a settings file', async () => {
    fixture.write(
      '.cursor/mcp.json',
      JSON.stringify({ assistant: { default_model: 'gpt-4-32k' } }),
    );

    const result = await withClock(AFTER_SHUTDOWNS);

    expect(result.modelUsage.some((entry) => entry.path === 'assistant.default_model')).toBe(true);
  });

  it('raises an error finding for a model that is already shut down', async () => {
    fixture.write(
      '.claude/agents/reviewer.md',
      '---\nname: reviewer\nmodel: gpt-4-32k\n---\n\nGo.\n',
    );

    const result = await withClock(AFTER_SHUTDOWNS);
    const finding = result.findings.find((entry) => entry.code === 'outdated-model');

    expect(finding?.severity).toBe('error');
    expect(finding?.remediation).toContain('Repoint');
  });

  it('raises only a warning while the shutdown is still in the future', async () => {
    fixture.write(
      '.claude/agents/reviewer.md',
      '---\nname: reviewer\nmodel: gpt-4-32k\n---\n\nGo.\n',
    );

    const result = await withClock(BEFORE_SHUTDOWNS);
    const finding = result.findings.find((entry) => entry.code === 'outdated-model');

    expect(finding?.severity).toBe('warning');
  });

  it('raises one finding per model rather than one per file', async () => {
    const agent = '---\nname: reviewer\nmodel: gpt-4-32k\n---\n\nGo.\n';
    fixture.write('.claude/agents/reviewer.md', agent);
    fixture.write(
      '.claude/agents/auditor.md',
      '---\nname: auditor\nmodel: gpt-4-32k\n---\n\nGo.\n',
    );

    const result = await withClock(AFTER_SHUTDOWNS);
    const findings = result.findings.filter((entry) => entry.code === 'outdated-model');

    expect(findings).toHaveLength(1);
    expect(findings[0]?.fileIds).toHaveLength(2);
  });

  it('says nothing about a model it does not recognize', async () => {
    fixture.write(
      '.claude/agents/reviewer.md',
      '---\nname: reviewer\nmodel: brand-new-model-2099\n---\n\nGo.\n',
    );

    const result = await withClock(AFTER_SHUTDOWNS);

    expect(result.modelUsage).toHaveLength(1);
    expect(result.modelUsage[0]?.assessment.status).toBe('unknown');
    expect(result.findings.some((entry) => entry.code === 'outdated-model')).toBe(false);
    expect(result.summary.outdatedModelCount).toBe(0);
  });

  it('attaches the lifecycle verdict to the capability that declares it', async () => {
    fixture.write(
      '.claude/agents/reviewer.md',
      '---\nname: reviewer\nmodel: gpt-4-32k\n---\n\nGo.\n',
    );

    const result = await withClock(AFTER_SHUTDOWNS);
    const reviewer = result.capabilities.find((entry) => entry.name === 'reviewer');

    expect(reviewer?.modelStatus?.status).toBe('retired');
  });

  it('counts retired pins separately from merely scheduled ones', async () => {
    fixture.write(
      '.claude/agents/reviewer.md',
      '---\nname: reviewer\nmodel: gpt-4-32k\n---\n\nGo.\n',
    );

    const scheduled = await withClock(BEFORE_SHUTDOWNS);
    expect(scheduled.summary.outdatedModelCount).toBe(1);
    expect(scheduled.summary.retiredModelCount).toBe(0);

    const retired = await withClock(AFTER_SHUTDOWNS);
    expect(retired.summary.retiredModelCount).toBe(1);
  });
});

describe('aggregate - guardrails', () => {
  it('extracts permission allow and deny rules', async () => {
    fixture.write('.claude/settings.json', samples.claudeSettings);

    const result = await inventory();
    const guardrail = result.guardrails.find((entry) => entry.providerId === 'claude-code');

    expect(guardrail?.allow).toEqual(['Bash(npm test)']);
    expect(guardrail?.deny).toEqual(['Bash(rm -rf *)']);
  });

  it('lists declared hook names', async () => {
    fixture.write(
      '.claude/settings.json',
      JSON.stringify({ hooks: { PreToolUse: [], PostToolUse: [] } }),
    );

    const result = await inventory();

    expect(result.guardrails[0]?.hooks).toEqual(['PostToolUse', 'PreToolUse']);
  });

  it('reads ignore patterns and skips comments and blank lines', async () => {
    fixture.writeProject('.cursorignore', '# comment\n\nsecrets/\n*.pem\n');

    const result = await inventory([fixture.project]);
    const ignore = result.guardrails.find((entry) => entry.kind === 'ignore');

    expect(ignore?.ignorePatterns).toEqual(['secrets/', '*.pem']);
  });

  it('omits settings files that declare no guardrails', async () => {
    fixture.write('.copilot/config.json', samples.copilotConfig);

    const result = await inventory();

    expect(result.guardrails.some((entry) => entry.providerId === 'copilot-cli')).toBe(false);
  });
});

describe('aggregate - health findings', () => {
  it('reports a plaintext secret by path without echoing the value', async () => {
    fixture.write('.claude/settings.json', samples.claudeSettings);

    const result = await inventory();
    const finding = result.findings.find((entry) => entry.code === 'plaintext-secret');

    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('warning');
    expect(JSON.stringify(finding)).not.toContain('sk-ant-api03');
  });

  it('does not flag environment variable placeholders as secrets', async () => {
    fixture.write(
      '.cursor/mcp.json',
      JSON.stringify({ mcpServers: { gh: { command: 'npx', env: { TOKEN: '${GITHUB_TOKEN}' } } } }),
    );

    const result = await inventory();

    expect(result.findings.some((entry) => entry.code === 'plaintext-secret')).toBe(false);
  });

  it('does not flag the template syntaxes these tools actually use', async () => {
    // Every one of these appeared on a real machine and was previously a
    // false positive: VS Code inputs, Claude extension user config, and
    // shell- and Windows-style variable references.
    fixture.write(
      '.cursor/mcp.json',
      JSON.stringify({
        mcpServers: {
          a: { url: 'https://a.example', headers: { Authorization: '${input:api-key}' } },
          b: { command: 'npx', env: { KEY: '${user_config.api_key}' } },
          c: { command: 'npx', env: { KEY: '$GITHUB_TOKEN', OTHER: '%GITHUB_TOKEN%' } },
          d: { command: 'npx', env: { KEY: '{{ .Env.TOKEN }}' } },
        },
      }),
    );

    const result = await inventory();

    expect(result.findings.filter((entry) => entry.code === 'plaintext-secret')).toEqual([]);
  });

  it('does not scan vendor catalogs for secrets, since their examples are not yours', async () => {
    fixture.write(
      '.docker/mcp/catalogs/docker-mcp.yaml',
      'registry:\n  mongodb:\n    secrets:\n      - example: "sk-abcdefghijklmnopqrstuvwxyz0123"\n',
    );

    const result = await inventory();

    expect(result.findings.some((entry) => entry.code === 'plaintext-secret')).toBe(false);
  });

  it('does not flag obvious stand-in text as a secret', async () => {
    fixture.write(
      '.cursor/mcp.json',
      JSON.stringify({ mcpServers: { gh: { command: 'npx', env: { API_KEY: 'your-api-key' } } } }),
    );

    const result = await inventory();

    expect(result.findings.some((entry) => entry.code === 'plaintext-secret')).toBe(false);
  });

  it('reports an unparseable file as an error', async () => {
    fixture.write('.cursor/mcp.json', '{ "mcpServers": ');

    const result = await inventory();
    const finding = result.findings.find((entry) => entry.code === 'unparseable-file');

    expect(finding?.severity).toBe('error');
    expect(result.summary.errorCount).toBeGreaterThan(0);
  });

  it('reports an empty file', async () => {
    fixture.write('.cursor/mcp.json', '   \n');

    const result = await inventory();

    expect(result.findings.some((entry) => entry.code === 'empty-file')).toBe(true);
  });

  it('reports a deprecated location with migration advice', async () => {
    fixture.writeProject('.cursorrules', 'Prefer named exports.\n');

    const result = await inventory([fixture.project]);
    const finding = result.findings.find((entry) => entry.code === 'deprecated-format');

    expect(finding).toBeDefined();
    expect(finding?.remediation).toContain('.cursor/rules');
  });

  it('reports unattributed harness files', async () => {
    fixture.writeProject('tools/mcp.json', JSON.stringify({ mcpServers: {} }));

    const result = await inventory([fixture.project]);

    expect(result.findings.some((entry) => entry.code === 'unattributed-file')).toBe(true);
  });
});

describe('aggregate - credential stores', () => {
  it('reports a credential store without reading it', async () => {
    fixture.write(
      '.codex/auth.json',
      JSON.stringify({ OPENAI_API_KEY: 'sk-live-abcdefghij0123456789' }),
    );

    const loaded: string[] = [];
    const result = await aggregate(await scan({ environment: fixture.environment }), {
      loadContent: async (file) => {
        loaded.push(file.path);
        return undefined;
      },
    });

    const finding = result.findings.find((entry) => entry.code === 'credential-store');
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('info');
    expect(loaded.some((path) => path.endsWith('auth.json'))).toBe(false);
  });

  it('loads ordinary files concurrently without scheduling credential stores', async () => {
    for (let index = 0; index < 12; index += 1) {
      fixture.write(`.claude/agents/agent-${String(index)}.md`, `# Agent ${String(index)}\n`);
    }
    fixture.write('.codex/auth.json', '{"OPENAI_API_KEY":"not-read"}');

    const scanned = await scan({ environment: fixture.environment });
    let active = 0;
    let peak = 0;
    const loaded: string[] = [];
    await aggregate(scanned, {
      loadContent: async (file) => {
        loaded.push(file.path);
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return '# content\n';
      },
    });

    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
    expect(loaded.some((path) => path.endsWith('auth.json'))).toBe(false);
  });

  it('never surfaces credential store contents in the inventory', async () => {
    fixture.write(
      '.codex/auth.json',
      JSON.stringify({ OPENAI_API_KEY: 'sk-live-abcdefghij0123456789' }),
    );

    const result = await inventory();

    expect(JSON.stringify(result)).not.toContain('sk-live-abcdefghij0123456789');
  });
});

describe('aggregate - inline credential masking', () => {
  it('masks a secret passed as a --flag value in args', async () => {
    fixture.write(
      '.mcp.json',
      JSON.stringify({
        mcpServers: {
          leaky: {
            command: 'npx',
            args: ['server', '--api-key', 'sk-live-abcdefghij0123456789', '--verbose'],
          },
        },
      }),
    );

    const result = await inventory();
    const server = result.mcpServers.find((entry) => entry.name === 'leaky');

    expect(server?.definitions[0]?.args).toEqual(['server', '--api-key', '••••••••', '--verbose']);
    expect(JSON.stringify(result)).not.toContain('sk-live-abcdefghij0123456789');
  });

  it('masks a secret passed as KEY=value in args', async () => {
    fixture.write(
      '.mcp.json',
      JSON.stringify({
        mcpServers: {
          docker: {
            command: 'docker',
            args: ['run', '-e', 'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'img'],
          },
        },
      }),
    );

    const result = await inventory();

    expect(result.mcpServers[0]?.definitions[0]?.args).toContain('GITHUB_TOKEN=••••••••');
    expect(JSON.stringify(result)).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('masks a credential in a URL query string but keeps the endpoint readable', async () => {
    fixture.write(
      '.mcp.json',
      JSON.stringify({
        mcpServers: {
          hosted: { type: 'http', url: 'https://mcp.example.com/sse?api_key=sk-live-abcdefghij01' },
        },
      }),
    );

    const result = await inventory();
    const url = result.mcpServers[0]?.definitions[0]?.url ?? '';

    expect(url).toContain('https://mcp.example.com/sse');
    expect(url).not.toContain('sk-live-abcdefghij01');
  });

  it('leaves ordinary args and URLs untouched', async () => {
    fixture.write(
      '.mcp.json',
      JSON.stringify({
        mcpServers: {
          plain: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp/data'],
          },
          hosted: { type: 'http', url: 'https://learn.microsoft.com/api/mcp' },
        },
      }),
    );

    const result = await inventory();
    const plain = result.mcpServers.find((entry) => entry.name === 'plain');
    const hosted = result.mcpServers.find((entry) => entry.name === 'hosted');

    expect(plain?.definitions[0]?.args).toEqual([
      '-y',
      '@modelcontextprotocol/server-filesystem',
      '/tmp/data',
    ]);
    expect(hosted?.definitions[0]?.url).toBe('https://learn.microsoft.com/api/mcp');
  });

  it('does not mask a documented placeholder', async () => {
    fixture.write(
      '.mcp.json',
      JSON.stringify({
        mcpServers: {
          template: { command: 'npx', args: ['--token', '${input:apiKey}'] },
        },
      }),
    );

    const result = await inventory();

    expect(result.mcpServers[0]?.definitions[0]?.args).toEqual(['--token', '${input:apiKey}']);
  });

  it('treats two definitions differing only by API key as duplicates, not conflicts', async () => {
    const withKey = (key: string): string =>
      JSON.stringify({
        mcpServers: { shared: { command: 'npx', args: ['srv', `--api-key=${key}`] } },
      });

    fixture.write('.claude/settings.json', withKey('sk-live-aaaaaaaaaaaaaaaaaaaa'));
    fixture.write('.cursor/mcp.json', withKey('sk-live-bbbbbbbbbbbbbbbbbbbb'));

    const result = await inventory();
    const shared = result.mcpServers.find((entry) => entry.name === 'shared');

    expect(shared?.duplicated).toBe(true);
    expect(shared?.conflicting).toBe(false);
  });
});

describe('aggregate - summary', () => {
  it('counts what the dashboard needs', async () => {
    fixture.write('.claude/settings.json', samples.claudeSettings);
    fixture.write('.claude/agents/reviewer.md', samples.agentFile);
    fixture.writeProject('AGENTS.md', samples.agentsMd);

    const result = await inventory([fixture.project]);

    expect(result.summary.fileCount).toBeGreaterThanOrEqual(3);
    expect(result.summary.providerCount).toBeGreaterThanOrEqual(2);
    expect(result.summary.capabilityCount).toBeGreaterThanOrEqual(1);
    expect(result.summary.instructionCount).toBeGreaterThanOrEqual(1);
    expect(result.summary.totalBytes).toBeGreaterThan(0);
  });

  it('sorts findings with errors first', async () => {
    fixture.write('.cursor/mcp.json', '{ broken');
    fixture.write('.claude/settings.json', samples.claudeSettings);

    const result = await inventory();

    expect(result.findings[0]?.severity).toBe('error');
  });

  it('produces an empty but valid inventory when nothing is installed', async () => {
    const result = await inventory();

    expect(result.mcpServers).toEqual([]);
    expect(result.summary.fileCount).toBe(0);
    expect(result.summary.mcpServerCount).toBe(0);
  });
});

describe('aggregate - provenance', () => {
  it('records the tool, location, directory, and file name for every entry', async () => {
    fixture.write('.claude/agents/reviewer.md', samples.agentFile);
    fixture.write('.claude/CLAUDE.md', samples.claudeMd);
    fixture.write('.claude/settings.json', samples.claudeSettings);

    const result = await inventory();
    const capability = result.capabilities.find((entry) => entry.name === 'reviewer');
    const instruction = result.instructions[0];
    const guardrail = result.guardrails[0];

    expect(capability?.providerName).toBe('Claude Code');
    expect(capability?.locationLabel).toBe('User subagents');
    expect(capability?.fileName).toBe('reviewer.md');
    expect(capability?.directory).toContain('agents');
    expect(instruction?.directory).toBeDefined();
    expect(instruction?.providerId).toBe('claude-code');
    expect(guardrail?.fileName).toBe('settings.json');
    expect(guardrail?.directory).toBe(capability?.directory?.replace(/[\\/]agents$/, ''));
  });

  it('points every entry at a file the scan actually found', async () => {
    fixture.write('.claude/agents/reviewer.md', samples.agentFile);
    fixture.write('.claude/CLAUDE.md', samples.claudeMd);

    const scanned = await scan({ environment: fixture.environment, projectRoots: [] });
    const result = await aggregate(scanned);
    const fileIds = new Set(scanned.files.map((file) => file.id));

    for (const entry of [...result.capabilities, ...result.instructions, ...result.guardrails]) {
      expect(fileIds.has(entry.fileId)).toBe(true);
    }
  });
});

describe('aggregate - duplicates across entity types', () => {
  it('flags a capability of the same name declared in two tools', async () => {
    fixture.write('.claude/agents/reviewer.md', samples.agentFile);
    fixture.write('.copilot/agents/reviewer.agent.md', samples.agentFile);

    const result = await inventory();
    const reviewers = result.capabilities.filter((entry) => entry.name === 'reviewer');

    expect(reviewers).toHaveLength(2);
    for (const reviewer of reviewers) {
      expect(reviewer.duplicate.duplicated).toBe(true);
      expect(reviewer.duplicate.siblingFileIds).toHaveLength(1);
    }
    // Same content in two tools is layering, not a contradiction.
    expect(reviewers.every((reviewer) => reviewer.duplicate.conflicting)).toBe(false);
    expect(result.findings.some((entry) => entry.code === 'capability-duplicate')).toBe(true);
  });

  it('flags two same-named agents in one tool with different bodies as conflicting', async () => {
    fixture.write('.claude/agents/reviewer.md', samples.agentFile);
    fixture.write(
      '.claude/agents/reviewer-copy.md',
      samples.agentFile.replace('meticulous code reviewer', 'lenient code reviewer'),
    );

    const result = await inventory();
    const reviewers = result.capabilities.filter((entry) => entry.name === 'reviewer');

    expect(reviewers).toHaveLength(2);
    expect(reviewers.every((reviewer) => reviewer.duplicate.conflicting)).toBe(true);
    expect(result.findings.some((entry) => entry.code === 'capability-conflict')).toBe(true);
  });

  it('flags the same instruction title reached through two tools', async () => {
    fixture.write('.claude/CLAUDE.md', samples.claudeMd);
    fixture.write('AGENTS.md', samples.claudeMd);

    const result = await inventory();
    const duplicated = result.instructions.filter((entry) => entry.duplicate.duplicated);

    expect(duplicated.length).toBeGreaterThanOrEqual(2);
    expect(result.findings.some((entry) => entry.code === 'instruction-duplicate')).toBe(true);
  });

  it('spots a file copied under another tool name, which no title match would catch', async () => {
    // No heading, so each file is titled after itself: the names differ even
    // though the guidance is byte-identical.
    const body = 'Always run the tests before committing.\n';
    fixture.write('.claude/CLAUDE.md', body);
    fixture.write('AGENTS.md', body);

    const result = await inventory();
    const claude = result.instructions.find((entry) => entry.fileName === 'CLAUDE.md');

    expect(claude?.duplicate.duplicated).toBe(false);
    expect(claude?.duplicate.identicalFileIds).toHaveLength(1);
  });

  it('leaves a single declaration unflagged', async () => {
    fixture.write('.claude/agents/reviewer.md', samples.agentFile);

    const result = await inventory();
    const reviewer = result.capabilities.find((entry) => entry.name === 'reviewer');

    expect(reviewer?.duplicate.duplicated).toBe(false);
    expect(reviewer?.duplicate.conflicting).toBe(false);
    expect(reviewer?.duplicate.identicalFileIds).toEqual([]);
    expect(reviewer?.duplicate.siblingFileIds).toEqual([]);
  });

  it('counts duplicates, conflicts, and directories in the summary', async () => {
    fixture.write('.claude/agents/reviewer.md', samples.agentFile);
    fixture.write('.copilot/agents/reviewer.agent.md', samples.agentFile);
    fixture.write('.claude/CLAUDE.md', samples.claudeMd);

    const result = await inventory();

    expect(result.summary.duplicateCount).toBeGreaterThanOrEqual(1);
    expect(result.summary.conflictCount).toBe(0);
    expect(result.summary.directoryCount).toBeGreaterThanOrEqual(3);
  });
});
