/**
 * Overlap detection between differently named MCP servers.
 *
 * The interesting behaviour is not "did it group these two" but *which*
 * explanation wins: the suppression rule is what keeps the panel from
 * restating one relationship four times, and the noise-token stripping is what
 * lets two very different-looking package names collapse to one capability.
 */

import { describe, expect, it } from 'vitest';

import { detectMcpOverlaps, packageComponent, packageIdentity } from '@ai-harness-helper/core';
import type { McpDefinition, McpServerEntry } from '@ai-harness-helper/core';

function definition(overrides: Partial<McpDefinition> = {}): McpDefinition {
  return {
    fileId: 'file-1',
    filePath: '/home/u/.config/tool/mcp.json',
    displayPath: '~/.config/tool/mcp.json',
    directory: '~/.config/tool',
    fileName: 'mcp.json',
    providerId: 'claude-code',
    providerName: 'Claude Code',
    locationLabel: 'User config',
    scope: 'user',
    transport: 'stdio',
    envKeys: [],
    hasInlineSecret: false,
    disabled: false,
    signature: 'sig',
    ...overrides,
  };
}

function server(name: string, definitions: readonly Partial<McpDefinition>[]): McpServerEntry {
  const built = definitions.map((partial) => definition(partial));
  return {
    name,
    definitions: built,
    providerIds: [...new Set(built.map((entry) => entry.providerId))],
    directories: [...new Set(built.map((entry) => entry.directory))],
    conflicting: false,
    duplicated: built.length > 1,
  };
}

/** A stdio server whose signature is derived from what it launches. */
function stdio(name: string, command: string, args: readonly string[]): McpServerEntry {
  return server(name, [{ command, args, signature: `stdio:${command}:${args.join(' ')}` }]);
}

function remote(name: string, url: string): McpServerEntry {
  return server(name, [{ transport: 'http', url, signature: `http:${url}` }]);
}

describe('packageComponent', () => {
  it('reduces MCP naming conventions to the capability they name', () => {
    expect(packageComponent('npm:@modelcontextprotocol/server-github')).toBe('github');
    expect(packageComponent('npm:github-mcp-server')).toBe('github');
    expect(packageComponent('oci:ghcr.io/github/github-mcp-server')).toBe('github');
  });

  it('ignores the publisher half of a registry id', () => {
    // `io.github.*` says who published the server, not what it does.
    expect(packageComponent('npm:io.github.upstash/context7')).toBe('context7');
    expect(packageComponent('ref:com.microsoft/azure')).toBe('azure');
  });

  it('reads through a catalog locator to the entry it points at', () => {
    expect(
      packageComponent(
        'ref:github:docker/labs-ai-tools-for-devs?ref=main&path=prompts/mcp/fetch.md',
      ),
    ).toBe('fetch');
  });

  it('falls back to the owner when stripping noise leaves nothing', () => {
    expect(packageComponent('npm:@playwright/mcp')).toBe('playwright');
    expect(packageComponent('oci:docker.io/notion/mcp-server')).toBe('notion');
  });
});

describe('packageIdentity', () => {
  it('reads the package out of an npm runner invocation', () => {
    expect(
      packageIdentity(
        definition({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-github@1.2.3'] }),
      ),
    ).toBe('npm:@modelcontextprotocol/server-github');
  });

  it('ignores a Windows path and extension on the runner itself', () => {
    expect(
      packageIdentity(
        definition({ command: 'C:\\Program Files\\nodejs\\npx.cmd', args: ['@scope/thing'] }),
      ),
    ).toBe('npm:@scope/thing');
  });

  it('reads the python package out of a uvx invocation', () => {
    expect(packageIdentity(definition({ command: 'uvx', args: ['mcp-server-fetch>=0.2'] }))).toBe(
      'pypi:mcp-server-fetch',
    );
  });

  it('does not mistake a flag value for a container image', () => {
    expect(
      packageIdentity(
        definition({
          command: 'docker',
          args: ['run', '-i', '--rm', '-e', 'GITHUB_TOKEN', 'ghcr.io/github/github-mcp-server:v1'],
        }),
      ),
    ).toBe('oci:ghcr.io/github/github-mcp-server');
  });

  it('refuses to treat a bare entry-point script as an identity', () => {
    expect(packageIdentity(definition({ command: 'node', args: ['/srv/thing/index.js'] }))).toBe(
      undefined,
    );
  });

  it('uses a catalog reference when the tool launches the server for you', () => {
    expect(packageIdentity(definition({ reference: 'docker/github-mcp-server@sha256:abc' }))).toBe(
      'ref:docker/github-mcp-server',
    );
  });
});

describe('detectMcpOverlaps', () => {
  it('reports nothing when servers do different jobs', () => {
    const groups = detectMcpOverlaps([
      stdio('github', 'npx', ['-y', '@modelcontextprotocol/server-github']),
      stdio('postgres', 'uvx', ['mcp-server-postgres']),
    ]);
    expect(groups).toEqual([]);
  });

  it('ignores a single name declared in two places', () => {
    // Already reported as a duplicate; restating it here would be noise.
    const entry = server('github', [
      { fileId: 'a', command: 'npx', args: ['@modelcontextprotocol/server-github'] },
      { fileId: 'b', command: 'npx', args: ['@modelcontextprotocol/server-github'] },
    ]);
    expect(detectMcpOverlaps([entry])).toEqual([]);
  });

  it('groups two names that resolve to the identical launch target', () => {
    const groups = detectMcpOverlaps([
      stdio('fetch', 'uvx', ['mcp-server-fetch']),
      stdio('web-fetch', 'uvx', ['mcp-server-fetch']),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.kind).toBe('same-target');
    expect(groups[0]?.confidence).toBe('high');
    expect(groups[0]?.serverNames).toEqual(['fetch', 'web-fetch']);
  });

  it('groups the same package launched through different runtimes', () => {
    const groups = detectMcpOverlaps([
      stdio('gh', 'npx', ['-y', '@modelcontextprotocol/server-github']),
      stdio('github-tools', 'npx', ['-y', 'github-mcp-server']),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.kind).toBe('same-package');
    expect(groups[0]?.serverNames).toEqual(['gh', 'github-tools']);
    expect(groups[0]?.members[0]?.evidence).toContain('github');
  });

  it('separates the same endpoint from merely the same host', () => {
    const groups = detectMcpOverlaps([
      remote('notion', 'https://mcp.notion.com/mcp'),
      remote('notion-alt', 'https://mcp.notion.com/mcp/'),
      remote('notion-search', 'https://mcp.notion.com/search'),
    ]);

    const endpoint = groups.find((group) => group.kind === 'same-endpoint');
    expect(endpoint?.serverNames).toEqual(['notion', 'notion-alt']);

    const host = groups.find((group) => group.kind === 'same-host');
    expect(host?.confidence).toBe('medium');
    expect(host?.serverNames).toContain('notion-search');
  });

  it('infers a shared capability area from names alone', () => {
    const groups = detectMcpOverlaps([
      stdio('brave', 'npx', ['-y', '@brave/brave-search-mcp-server']),
      stdio('tavily', 'npx', ['-y', 'tavily-mcp']),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.kind).toBe('shared-domain');
    expect(groups[0]?.confidence).toBe('low');
    expect(groups[0]?.label).toBe('Web search');
  });

  it('does not let a domain token match a longer word', () => {
    // `git` must not sweep in every GitHub server.
    const groups = detectMcpOverlaps([
      stdio('git', 'uvx', ['mcp-server-git']),
      stdio('github', 'npx', ['-y', '@modelcontextprotocol/server-github']),
    ]);
    expect(groups).toEqual([]);
  });

  it('does not restate a strong relationship as a weak one', () => {
    const groups = detectMcpOverlaps([
      stdio('gh', 'npx', ['-y', '@modelcontextprotocol/server-github']),
      stdio('github', 'npx', ['-y', '@modelcontextprotocol/server-github']),
    ]);

    // Same package and shared GitHub domain both apply; only the stronger
    // explanation is worth showing for the same pair of names.
    expect(groups).toHaveLength(1);
    expect(groups[0]?.kind).toBe('same-target');
  });

  it('still reports a weaker group that explains a new pair', () => {
    const groups = detectMcpOverlaps([
      stdio('gh', 'npx', ['-y', '@modelcontextprotocol/server-github']),
      stdio('github', 'npx', ['-y', '@modelcontextprotocol/server-github']),
      stdio('gh-cli', 'docker', ['run', '-i', 'ghcr.io/github/github-mcp-server']),
    ]);

    // The first two launch identically; the containerized one is the same
    // package by a different route, which is a claim the first group cannot
    // make, so both survive.
    expect(groups.map((group) => group.kind)).toEqual(['same-target', 'same-package']);
    expect(groups[0]?.serverNames).toEqual(['gh', 'github']);
    expect(groups[1]?.serverNames).toEqual(['gh', 'gh-cli', 'github']);
  });

  it('does not group registry entries by their publisher', () => {
    // Everything in the MCP registry is `io.github.*`; that must not make the
    // whole catalog look like a pile of GitHub servers.
    const groups = detectMcpOverlaps([
      stdio('io.github.upstash/context7', 'npx', ['@upstash/context7-mcp']),
      stdio('io.github.modelcontextprotocol/memory', 'npx', [
        '@modelcontextprotocol/server-memory',
      ]),
    ]);
    expect(groups).toEqual([]);
  });

  it('does not group Docker catalog entries by the catalog that hosts them', () => {
    const catalog = (name: string, entry: string): McpServerEntry =>
      server(name, [
        {
          reference: `github:docker/labs-ai-tools-for-devs?ref=main&path=prompts/mcp/${entry}.md`,
          signature: `ref:${entry}`,
        },
      ]);

    const groups = detectMcpOverlaps([
      catalog('fetch', 'fetch'),
      catalog('playwright', 'playwright'),
      catalog('github-official', 'github-official'),
    ]);
    expect(groups).toEqual([]);
  });

  it('carries provenance so the UI can link to every source file', () => {
    const groups = detectMcpOverlaps([
      server('fetch', [
        {
          fileId: 'file-a',
          displayPath: '~/.a.json',
          command: 'uvx',
          args: ['mcp-server-fetch'],
          signature: 'x',
        },
      ]),
      server('web-fetch', [
        {
          fileId: 'file-b',
          displayPath: '~/.b.json',
          providerId: 'codex',
          providerName: 'Codex',
          command: 'uvx',
          args: ['mcp-server-fetch'],
          signature: 'x',
          disabled: true,
        },
      ]),
    ]);

    expect(groups[0]?.fileIds).toEqual(['file-a', 'file-b']);
    expect(groups[0]?.displayPaths).toEqual(['~/.a.json', '~/.b.json']);
    expect(groups[0]?.members[1]?.providerNames).toEqual(['Codex']);
    expect(groups[0]?.members[1]?.disabled).toBe(true);
  });
});
