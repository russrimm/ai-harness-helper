import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HarnessService } from '@ai-harness-helper/core';
import type { FastifyInstance } from 'fastify';

import { createServer, createToken } from '../src/server.js';
import { createFixture, samples, type Fixture } from '../../core/test/fixture.js';

const TOKEN = 'test-token-0000000000000000';

let fixture: Fixture;
let app: FastifyInstance;

interface InjectOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  token?: string | null;
  headers?: Record<string, string>;
  payload?: unknown;
}

async function start(options: { readOnly?: boolean } = {}): Promise<void> {
  const service = new HarnessService({
    environment: fixture.environment,
    projectRoots: [fixture.project],
    readOnly: options.readOnly ?? false,
    writerOptions: { backupRoot: `${fixture.root}/backups` },
  });
  ({ app } = await createServer({ service, token: TOKEN }));
}

async function call(options: InjectOptions) {
  const headers: Record<string, string> = { host: '127.0.0.1:7777', ...options.headers };
  if (options.token !== null) headers['x-harness-token'] = options.token ?? TOKEN;

  return app.inject({
    method: options.method ?? 'GET',
    url: options.url,
    headers,
    ...(options.payload !== undefined ? { payload: options.payload as object } : {}),
  });
}

async function firstFileId(match: string): Promise<string> {
  const response = await call({ url: '/api/scan' });
  const body = response.json() as { files: { id: string; path: string }[] };
  const file = body.files.find((entry) => entry.path.replace(/\\/g, '/').endsWith(match));
  if (!file) throw new Error(`fixture missing ${match}`);
  return file.id;
}

beforeEach(async () => {
  fixture = createFixture();
  fixture.write('.claude/settings.json', samples.claudeSettings);
  fixture.write('.claude/CLAUDE.md', samples.claudeMd);
  fixture.write('.claude/.credentials.json', '{"claudeAiOauth":{"accessToken":"sk-ant-secret"}}');
  fixture.write('.cursor/mcp.json', samples.claudeMcp);
  fixture.writeProject('AGENTS.md', samples.agentsMd);
  await start();
});

afterEach(async () => {
  await app.close();
  fixture.cleanup();
});

describe('authentication', () => {
  it('serves health without a token so the page can bootstrap', async () => {
    const response = await call({ url: '/api/health', token: null });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, readOnly: false });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('rejects an API call with no token', async () => {
    const response = await call({ url: '/api/overview', token: null });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a wrong token, including one of a different length', async () => {
    expect((await call({ url: '/api/overview', token: 'wrong' })).statusCode).toBe(401);
    expect((await call({ url: '/api/overview', token: 'x'.repeat(TOKEN.length) })).statusCode).toBe(
      401,
    );
  });

  it('accepts the token as a bearer credential or a query parameter', async () => {
    const bearer = await call({
      url: '/api/overview',
      token: null,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(bearer.statusCode).toBe(200);

    const query = await call({ url: `/api/overview?token=${TOKEN}`, token: null });
    expect(query.statusCode).toBe(200);
  });

  it('rejects a non-loopback Host, which is how DNS rebinding arrives', async () => {
    const response = await call({ url: '/api/health', headers: { host: 'evil.example.com' } });
    expect(response.statusCode).toBe(403);
  });

  it('accepts localhost and IPv6 loopback hosts', async () => {
    for (const host of ['localhost:7777', '127.0.0.1:7777', '[::1]:7777']) {
      expect((await call({ url: '/api/health', headers: { host } })).statusCode).toBe(200);
    }
  });

  it('rejects a cross-origin request', async () => {
    const response = await call({
      url: '/api/overview',
      headers: { origin: 'https://evil.example.com' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('allows a loopback origin', async () => {
    const response = await call({
      url: '/api/overview',
      headers: { origin: 'http://127.0.0.1:7777' },
    });
    expect(response.statusCode).toBe(200);
  });

  it('mints a distinct high-entropy token per run', () => {
    const a = createToken();
    const b = createToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('read routes', () => {
  it('returns an overview with a summary, findings, and a tree', async () => {
    const body = (await call({ url: '/api/overview' })).json() as {
      summary: { fileCount: number };
      findings: unknown[];
      tree: unknown[];
      detectedProviders: unknown[];
      projectRoots: string[];
    };
    expect(body.summary.fileCount).toBeGreaterThan(0);
    expect(Array.isArray(body.findings)).toBe(true);
    expect(body.tree.length).toBeGreaterThan(0);
    expect(body.detectedProviders.length).toBeGreaterThan(0);
  });

  it('rescans on POST', async () => {
    // The GET establishes a cached scan; the new file must not appear until a
    // rescan is explicitly requested.
    const before = ((await call({ url: '/api/scan' })).json() as { files: unknown[] }).files.length;
    fixture.write('.codex/mcp.json', samples.claudeMcp);

    const stale = ((await call({ url: '/api/scan' })).json() as { files: unknown[] }).files.length;
    expect(stale).toBe(before);

    const after = (
      (await call({ method: 'POST', url: '/api/scan' })).json() as { files: unknown[] }
    ).files.length;
    expect(after).toBeGreaterThan(before);
  });

  it('returns the MCP inventory', async () => {
    const body = (await call({ url: '/api/inventory' })).json() as {
      mcpServers: { name: string }[];
    };
    expect(body.mcpServers.map((entry) => entry.name)).toContain('github');
  });

  it('masks secrets in a file by default', async () => {
    const id = await firstFileId('.claude/settings.json');
    const body = (await call({ url: `/api/files/${id}` })).json() as {
      content: string;
      revealed: boolean;
      redactions: unknown[];
    };
    expect(body.revealed).toBe(false);
    expect(body.content).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345');
    expect(body.redactions.length).toBeGreaterThan(0);
  });

  it('returns raw content only when reveal is explicitly requested', async () => {
    const id = await firstFileId('.claude/settings.json');
    const body = (await call({ url: `/api/files/${id}?reveal=true` })).json() as {
      content: string;
      revealed: boolean;
    };
    expect(body.revealed).toBe(true);
    expect(body.content).toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345');
  });

  it('404s on an unknown or guessed file id', async () => {
    expect((await call({ url: '/api/files/does-not-exist' })).statusCode).toBe(404);
    expect(
      (await call({ url: `/api/files/${encodeURIComponent('../../../etc/passwd')}` })).statusCode,
    ).toBe(404);
  });

  it('reveals a single value on request', async () => {
    const id = await firstFileId('.claude/settings.json');
    const document = (await call({ url: `/api/files/${id}` })).json() as {
      redactions: { id: string }[];
    };
    const response = await call({
      method: 'POST',
      url: `/api/files/${id}/reveal`,
      payload: { redactionId: document.redactions[0]?.id },
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { value: string }).value).toContain('sk-ant-api03');
  });

  it('rejects a reveal with no redaction id, and an unknown one', async () => {
    const id = await firstFileId('.claude/settings.json');
    expect(
      (await call({ method: 'POST', url: `/api/files/${id}/reveal`, payload: {} })).statusCode,
    ).toBe(400);
    expect(
      (
        await call({
          method: 'POST',
          url: `/api/files/${id}/reveal`,
          payload: { redactionId: 'r999' },
        })
      ).statusCode,
    ).toBe(404);
  });

  it('never renders a credential store', async () => {
    const id = await firstFileId('.claude/.credentials.json');
    const body = (await call({ url: `/api/files/${id}?reveal=true` })).json() as {
      content: string;
      readOnly: boolean;
    };
    expect(body.content).toBe('');
    expect(body.readOnly).toBe(true);
  });
});

describe('write routes', () => {
  async function settings() {
    const id = await firstFileId('.claude/settings.json');
    const document = (await call({ url: `/api/files/${id}?reveal=true` })).json() as {
      hash: string;
      file: { path: string };
    };
    return { id, hash: document.hash, path: document.file.path };
  }

  it('writes valid content and reports the backup', async () => {
    const { id, hash, path } = await settings();
    const content = JSON.stringify({ model: 'claude-opus-4' }, null, 2);

    const response = await call({
      method: 'PUT',
      url: `/api/files/${id}`,
      payload: { content, expectedHash: hash },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { ok: boolean; backupPath: string };
    expect(body.ok).toBe(true);
    expect(body.backupPath).toBeTruthy();
    expect(readFileSync(path, 'utf8')).toBe(content);
  });

  it('409s on a stale hash', async () => {
    const { id } = await settings();
    const response = await call({
      method: 'PUT',
      url: `/api/files/${id}`,
      payload: { content: '{}', expectedHash: 'stale' },
    });
    expect(response.statusCode).toBe(409);
    expect((response.json() as { code: string }).code).toBe('hash-mismatch');
  });

  it('422s on content that does not parse', async () => {
    const { id, hash, path } = await settings();
    const before = readFileSync(path, 'utf8');
    const response = await call({
      method: 'PUT',
      url: `/api/files/${id}`,
      payload: { content: '{ not json', expectedHash: hash },
    });
    expect(response.statusCode).toBe(422);
    expect((response.json() as { code: string }).code).toBe('invalid-content');
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('403s on a credential store', async () => {
    const id = await firstFileId('.claude/.credentials.json');
    const response = await call({
      method: 'PUT',
      url: `/api/files/${id}`,
      payload: { content: '{}', expectedHash: 'x' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('400s when the body is incomplete', async () => {
    const { id } = await settings();
    const response = await call({
      method: 'PUT',
      url: `/api/files/${id}`,
      payload: { content: '{}' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('403s every write in read-only mode', async () => {
    await app.close();
    await start({ readOnly: true });

    expect((await call({ url: '/api/health' })).json()).toEqual({ ok: true, readOnly: true });

    const id = await firstFileId('.claude/settings.json');
    const path = fixture.write('.claude/settings.json', samples.claudeSettings);
    const before = readFileSync(path, 'utf8');

    const response = await call({
      method: 'PUT',
      url: `/api/files/${id}`,
      payload: { content: '{}', expectedHash: 'x' },
    });
    expect(response.statusCode).toBe(403);
    expect((response.json() as { code: string }).code).toBe('read-only');
    expect(readFileSync(path, 'utf8')).toBe(before);
  });
});

describe('project roots', () => {
  it('lists, adds, and removes roots', async () => {
    expect((await call({ url: '/api/projects' })).json()).toEqual({ roots: [fixture.project] });

    const removed = await call({
      method: 'DELETE',
      url: '/api/projects',
      payload: { path: fixture.project },
    });
    expect((removed.json() as { roots: string[] }).roots).toEqual([]);

    const added = await call({
      method: 'POST',
      url: '/api/projects',
      payload: { path: fixture.project },
    });
    expect((added.json() as { roots: string[] }).roots).toHaveLength(1);
  });

  it('400s without a path', async () => {
    expect((await call({ method: 'POST', url: '/api/projects', payload: {} })).statusCode).toBe(
      400,
    );
    expect(
      (await call({ method: 'DELETE', url: '/api/projects', payload: { path: '' } })).statusCode,
    ).toBe(400);
  });
});

describe('search and export', () => {
  it('searches file contents', async () => {
    const body = (await call({ url: '/api/search?q=claude-sonnet-4' })).json() as {
      hits: { line: number }[];
    };
    expect(body.hits.length).toBeGreaterThan(0);
  });

  it('applies filters and handles an empty query', async () => {
    const filtered = (await call({ url: '/api/search?q=a&provider=claude-code' })).json() as {
      hits: { providerId: string }[];
    };
    expect(filtered.hits.every((hit) => hit.providerId === 'claude-code')).toBe(true);

    const empty = (await call({ url: '/api/search?q=' })).json() as { hits: unknown[] };
    expect(empty.hits).toEqual([]);
  });

  it('exports JSON and Markdown without leaking secrets', async () => {
    const json = await call({ url: '/api/export?format=json' });
    expect(json.statusCode).toBe(200);
    expect(json.body).not.toContain('sk-ant-api03-abcdefghij');

    const markdown = await call({ url: '/api/export?format=markdown' });
    expect(markdown.headers['content-type']).toContain('text/markdown');
    expect(markdown.body).toContain('# Agentic harness report');
    expect(markdown.body).not.toContain('sk-ant-api03-abcdefghij');
  });

  it('redacts inline MCP credentials from inventory and every export format', async () => {
    const argumentSecret = `ghp_${'S'.repeat(20)}`;
    const querySecret = 'synthetic-query-secret-0001';
    fixture.write(
      '.claude/settings.json',
      JSON.stringify({
        mcpServers: {
          shared: { command: 'npx', args: ['server-one', '--token', argumentSecret] },
        },
      }),
    );
    fixture.write(
      '.cursor/mcp.json',
      JSON.stringify({
        mcpServers: {
          shared: { url: `https://mcp.example.test/sse?access_token=${querySecret}` },
        },
      }),
    );

    for (const url of [
      '/api/inventory',
      '/api/export?format=json',
      '/api/export?format=markdown',
    ]) {
      const response = await call({ url });
      expect(response.body).not.toContain(argumentSecret);
      expect(response.body).not.toContain(querySecret);
    }
  });
});

describe('unknown endpoints', () => {
  it('404s an unknown API route', async () => {
    expect((await call({ url: '/api/nope' })).statusCode).toBe(404);
  });
});
