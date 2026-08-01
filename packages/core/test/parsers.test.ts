import { describe, expect, it } from 'vitest';
import { inferFormat, parseContent, parseMarkdown } from '../src/parsers.js';

describe('parseContent - JSON and JSONC', () => {
  it('parses strict JSON', () => {
    const result = parseContent('{"mcpServers":{"github":{"command":"npx"}}}', 'json');
    expect(result.issues).toEqual([]);
    expect(result.value).toEqual({ mcpServers: { github: { command: 'npx' } } });
  });

  it('parses JSONC with comments and trailing commas', () => {
    const text = `{
  // Copilot CLI writes comments into config.json
  "model": "claude",
  "tools": ["a", "b",],
}`;
    const result = parseContent(text, 'jsonc');
    expect(result.issues).toEqual([]);
    expect(result.value).toEqual({ model: 'claude', tools: ['a', 'b'] });
  });

  it('recovers a partial value from malformed JSON and reports a position', () => {
    const text = '{\n  "a": 1,\n  "b": \n}';
    const result = parseContent(text, 'json');
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues[0]?.line).toBeGreaterThan(0);
    expect(result.issues[0]?.column).toBeGreaterThan(0);
  });

  it('never throws on arbitrary input', () => {
    expect(() => parseContent('not json at all {{{', 'json')).not.toThrow();
    expect(() => parseContent('', 'json')).not.toThrow();
  });
});

describe('parseContent - TOML', () => {
  it('parses Codex-style configuration', () => {
    const text = `model = "gpt-5"\n\n[mcp_servers.github]\ncommand = "npx"\nargs = ["-y", "server"]\n`;
    const result = parseContent(text, 'toml');
    expect(result.issues).toEqual([]);
    expect(result.value).toMatchObject({
      model: 'gpt-5',
      mcp_servers: { github: { command: 'npx', args: ['-y', 'server'] } },
    });
  });

  it('reports an error for malformed TOML without throwing', () => {
    const result = parseContent('model = = "broken"', 'toml');
    expect(result.value).toBeUndefined();
    expect(result.issues.length).toBeGreaterThan(0);
  });
});

describe('parseContent - YAML', () => {
  it('parses Docker MCP registry style documents', () => {
    const text = 'registry:\n  github:\n    ref: ""\n  playwright:\n    ref: ""\n';
    const result = parseContent(text, 'yaml');
    expect(result.issues).toEqual([]);
    expect(result.value).toEqual({ registry: { github: { ref: '' }, playwright: { ref: '' } } });
  });

  it('reports an error with a line number for malformed YAML', () => {
    const result = parseContent('a:\n  - b\n c: broken indent\n', 'yaml');
    expect(result.issues.length).toBeGreaterThan(0);
  });
});

describe('parseMarkdown', () => {
  it('extracts YAML front matter and body', () => {
    const text = `---\ndescription: A test agent\ntools: ['read', 'write']\n---\n# Heading\n\nBody text.\n`;
    const result = parseMarkdown(text);
    expect(result.frontmatter).toEqual({ description: 'A test agent', tools: ['read', 'write'] });
    expect(result.body).toBe('# Heading\n\nBody text.\n');
    expect(result.issues).toEqual([]);
  });

  it('handles CRLF line endings', () => {
    const text = '---\r\napplyTo: "**/*.ts"\r\n---\r\nUse tabs.\r\n';
    const result = parseMarkdown(text);
    expect(result.frontmatter).toEqual({ applyTo: '**/*.ts' });
    expect(result.body).toBe('Use tabs.\r\n');
  });

  it('treats a document without front matter as pure body', () => {
    const result = parseMarkdown('# CLAUDE.md\n\nInstructions.\n');
    expect(result.frontmatter).toBeUndefined();
    expect(result.body).toBe('# CLAUDE.md\n\nInstructions.\n');
    expect(result.issues).toEqual([]);
  });

  it('does not treat a horizontal rule mid-document as front matter', () => {
    const result = parseMarkdown('Intro\n\n---\n\nMore text\n');
    expect(result.frontmatter).toBeUndefined();
  });

  it('rejects non-mapping front matter', () => {
    const result = parseMarkdown('---\n- one\n- two\n---\nBody\n');
    expect(result.frontmatter).toBeUndefined();
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it('reports malformed front matter but still returns the body', () => {
    const result = parseMarkdown('---\na: [unclosed\n---\nBody\n');
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.body).toBe('Body\n');
  });

  it('strips a UTF-8 byte order mark before the delimiter', () => {
    const result = parseMarkdown('\uFEFF---\nname: test\n---\nBody\n');
    expect(result.frontmatter).toEqual({ name: 'test' });
  });
});

describe('inferFormat', () => {
  it.each([
    ['settings.json', 'json'],
    ['config.jsonc', 'jsonc'],
    ['config.toml', 'toml'],
    ['registry.yaml', 'yaml'],
    ['tools.yml', 'yaml'],
    ['rule.mdc', 'md-frontmatter'],
    ['CLAUDE.md', 'markdown'],
    ['.cursorignore', 'text'],
  ])('maps %s to %s', (name, expected) => {
    expect(inferFormat(name)).toBe(expected);
  });
});

describe('parseContent - text', () => {
  it('returns raw text unchanged', () => {
    const result = parseContent('node_modules\ndist\n', 'text');
    expect(result.value).toBe('node_modules\ndist\n');
    expect(result.issues).toEqual([]);
  });
});
