/**
 * Surgical removal of one MCP server declaration.
 *
 * These tests care about what *survives* as much as what disappears: the file
 * being edited often holds the only copy of a credential or a hand-written
 * comment, so a removal that reformats the document is a bug even when it
 * removes the right key.
 */

import { describe, expect, it } from 'vitest';

import { declaresMcpServer, removeMcpServerFromText } from '@ai-harness-helper/core';

describe('removeMcpServerFromText', () => {
  it('removes a server from JSON while preserving comments and siblings', () => {
    const text = [
      '{',
      '  // Keep this one, it is the good one.',
      '  "mcpServers": {',
      '    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] },',
      '    "stale": { "command": "node", "args": ["old.js"] }',
      '  }',
      '}',
      '',
    ].join('\n');

    const result = removeMcpServerFromText(text, 'jsonc', 'stale');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.content).toContain('// Keep this one');
    expect(result.content).toContain('"github"');
    expect(result.content).not.toContain('"stale"');
    expect(JSON.parse(result.content.replace(/^\s*\/\/.*$/gm, '')).mcpServers.github).toBeDefined();
    expect(result.removedFrom).toEqual(['mcpServers']);
  });

  it('leaves an empty container in place', () => {
    // A missing `mcpServers` and an empty one do not mean the same thing to
    // every tool, so removal never deletes the map itself.
    const result = removeMcpServerFromText(
      '{"mcpServers":{"only":{"command":"x"}}}',
      'json',
      'only',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.parse(result.content)).toEqual({ mcpServers: {} });
  });

  it('removes every occurrence in a file that declares one server twice', () => {
    const text = JSON.stringify(
      {
        mcpServers: { shared: { command: 'npx' } },
        projects: {
          '/home/u/work': { mcpServers: { shared: { command: 'npx' }, other: { command: 'y' } } },
        },
      },
      undefined,
      2,
    );

    const result = removeMcpServerFromText(text, 'json', 'shared');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const parsed = JSON.parse(result.content);
    expect(parsed.mcpServers).toEqual({});
    expect(parsed.projects['/home/u/work'].mcpServers).toEqual({ other: { command: 'y' } });
    expect(result.removedFrom).toEqual(['mcpServers', 'projects./home/u/work.mcpServers']);
  });

  it('only treats `registry` as a server map for Docker', () => {
    const text = JSON.stringify({ registry: { github: { ref: 'x' } } }, undefined, 2);

    expect(removeMcpServerFromText(text, 'json', 'github').ok).toBe(false);
    expect(removeMcpServerFromText(text, 'json', 'github', { providerId: 'docker' }).ok).toBe(true);
  });

  it('removes a server from a YAML map without disturbing comments', () => {
    const text = [
      '# machine config',
      'mcpServers:',
      '  keep:',
      '    command: a',
      '  drop:',
      '    command: b',
      '',
    ].join('\n');

    const result = removeMcpServerFromText(text, 'yaml', 'drop');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.content).toContain('# machine config');
    expect(result.content).toContain('keep:');
    expect(result.content).not.toContain('drop:');
  });

  it("removes a server from Continue's list-of-objects form", () => {
    const text = [
      'mcpServers:',
      '  - name: keep',
      '    command: a',
      '  - name: drop',
      '    command: b',
      '',
    ].join('\n');

    const result = removeMcpServerFromText(text, 'yaml', 'drop');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.content).toContain('name: keep');
    expect(result.content).not.toContain('name: drop');
  });

  it('excises a TOML server table and its sub-tables', () => {
    const text = [
      '# Codex config',
      'model = "gpt-5"',
      '',
      '[mcp_servers.keep]',
      'command = "npx"',
      '',
      '[mcp_servers.drop]',
      'command = "node"',
      'args = ["old.js"]',
      '',
      '[mcp_servers.drop.env]',
      'TOKEN = "x"',
      '',
      '[history]',
      'persistence = "none"',
      '',
    ].join('\n');

    const result = removeMcpServerFromText(text, 'toml', 'drop');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.content).toContain('# Codex config');
    expect(result.content).toContain('[mcp_servers.keep]');
    expect(result.content).toContain('[history]');
    expect(result.content).not.toContain('drop');
    expect(result.content).not.toContain('TOKEN');
  });

  it('excises an inline TOML server without touching its neighbours', () => {
    const text = [
      '[mcp_servers]',
      'keep = { command = "npx" }',
      'drop = { command = "node", args = ["old.js"] }',
      '',
    ].join('\n');

    const result = removeMcpServerFromText(text, 'toml', 'drop');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.content).toContain('keep = { command = "npx" }');
    expect(result.content).not.toContain('drop');
  });

  it('does not mistake a longer table name for the target', () => {
    const text = ['[mcp_servers.dropbox]', 'command = "npx"', ''].join('\n');
    const result = removeMcpServerFromText(text, 'toml', 'drop');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('not-declared');
  });

  it('reports a server that is not there rather than writing a no-op', () => {
    const result = removeMcpServerFromText('{"mcpServers":{"a":{}}}', 'json', 'b');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('not-declared');
  });

  it('refuses formats it cannot edit structurally', () => {
    const result = removeMcpServerFromText('# notes', 'markdown', 'anything');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('unsupported-format');
  });

  it('refuses to guess at a file it cannot parse', () => {
    const result = removeMcpServerFromText('{ this is not json', 'json', 'a');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('invalid-content');
  });

  it('preserves CRLF line endings', () => {
    const text = '{\r\n  "mcpServers": {\r\n    "a": {},\r\n    "b": {}\r\n  }\r\n}\r\n';
    const result = removeMcpServerFromText(text, 'json', 'b');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain('\r\n');
  });
});

describe('declaresMcpServer', () => {
  it('finds servers in every container the aggregator harvests', () => {
    const text = JSON.stringify({
      servers: { a: {} },
      projects: { '/p': { mcpServers: { b: {} } } },
    });
    expect(declaresMcpServer(text, 'json', 'a')).toBe(true);
    expect(declaresMcpServer(text, 'json', 'b')).toBe(true);
    expect(declaresMcpServer(text, 'json', 'c')).toBe(false);
  });

  it('is false for a file it cannot parse rather than throwing', () => {
    expect(declaresMcpServer('{{{', 'json', 'a')).toBe(false);
  });
});
