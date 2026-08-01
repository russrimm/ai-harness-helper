import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createEnvironment } from '../src/paths.js';
import type { ResolverEnvironment } from '../src/types.js';

/**
 * A throwaway HOME directory populated with realistic harness files.
 *
 * Tests never touch the developer's real configuration; every scan runs
 * against one of these sandboxes.
 */
export interface Fixture {
  readonly root: string;
  readonly home: string;
  readonly project: string;
  readonly environment: ResolverEnvironment;
  write(relativePath: string, content: string): string;
  writeProject(relativePath: string, content: string): string;
  cleanup(): void;
}

export function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'harness-fixture-'));
  const home = join(root, 'home');
  const project = join(root, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });

  const environment = createEnvironment({
    home,
    env: {
      APPDATA: join(home, 'AppData', 'Roaming'),
      LOCALAPPDATA: join(home, 'AppData', 'Local'),
      ProgramData: join(root, 'ProgramData'),
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_DATA_HOME: join(home, '.local', 'share'),
    },
  });

  function writeAt(base: string, relativePath: string, content: string): string {
    const target = join(base, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
    return target;
  }

  return {
    root,
    home,
    project,
    environment,
    write: (relativePath, content) => writeAt(home, relativePath, content),
    writeProject: (relativePath, content) => writeAt(project, relativePath, content),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Realistic sample content used across scanner and aggregator tests. */
export const samples = {
  claudeSettings: JSON.stringify(
    {
      model: 'claude-sonnet-4',
      permissions: { allow: ['Bash(npm test)'], deny: ['Bash(rm -rf *)'] },
      env: { ANTHROPIC_API_KEY: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345' },
    },
    null,
    2,
  ),

  claudeMcp: JSON.stringify(
    {
      mcpServers: {
        github: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' },
        },
        filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] },
      },
    },
    null,
    2,
  ),

  vscodeMcp: `{
  // VS Code writes JSONC with comments
  "servers": {
    "github": {
      "command": "docker",
      "args": ["run", "-i", "ghcr.io/github/github-mcp-server"]
    },
    "playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] }
  }
}`,

  copilotConfig: `{
  // User settings belong in settings.json.
  "theme": "dark",
  "banner": "always"
}`,

  codexConfig: `model = "gpt-5"\napproval_policy = "on-request"\n\n[mcp_servers.github]\ncommand = "npx"\nargs = ["-y", "@modelcontextprotocol/server-github"]\n`,

  dockerRegistry: 'registry:\n  github-official:\n    ref: ""\n  playwright:\n    ref: ""\n',

  agentsMd: '# AGENTS.md\n\nRun `npm test` before committing.\n',

  claudeMd: '# CLAUDE.md\n\nThis project uses TypeScript strict mode.\n',

  agentFile: `---
name: reviewer
description: Reviews pull requests
tools: ['read', 'grep']
---

You are a meticulous code reviewer.
`,

  cursorRule: `---
description: TypeScript conventions
globs: ['**/*.ts']
alwaysApply: false
---

Prefer named exports.
`,
} as const;
