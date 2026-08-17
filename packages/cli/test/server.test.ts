import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
  fixture.write('.claude/skills/pdf-extractor/SKILL.md', samples.skillFile);
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

  it('accepts the token as a bearer credential but never from a query parameter', async () => {
    const bearer = await call({
      url: '/api/overview',
      token: null,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(bearer.statusCode).toBe(200);

    const query = await call({ url: `/api/overview?token=${TOKEN}`, token: null });
    expect(query.statusCode).toBe(401);
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

  it('resolves effective configuration per provider', async () => {
    const body = (await call({ url: '/api/effective' })).json() as {
      providers: {
        providerId: string;
        entries: { key: string; name: string; strategy: string; winnerFileId?: string }[];
      }[];
      totalEntries: number;
      totalShadowed: number;
      totalContested: number;
    };
    expect(body.providers.length).toBeGreaterThan(0);
    expect(body.totalEntries).toBeGreaterThan(0);
    expect(body.totalShadowed).toBeGreaterThanOrEqual(0);
    expect(body.totalContested).toBeLessThanOrEqual(body.totalShadowed);
    for (const provider of body.providers) {
      expect(provider.providerId).toBeTruthy();
      for (const entry of provider.entries) {
        expect(entry.key).toBeTruthy();
        expect(entry.name).toBeTruthy();
        // Only an override picks a single winner; a merge layers everything.
        if (entry.strategy === 'override') expect(entry.winnerFileId).toBeTruthy();
      }
    }
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

  it('returns the source map with directories for each location', async () => {
    const body = (await call({ url: '/api/sources' })).json() as {
      providers: Array<{
        providerId: string;
        detected: boolean;
        directories: string[];
        locations: Array<{ status: string; directories: string[] }>;
      }>;
      totals: { providers: number; files: number };
    };
    const claude = body.providers.find((provider) => provider.providerId === 'claude-code');

    expect(body.totals.providers).toBeGreaterThan(0);
    expect(claude?.detected).toBe(true);
    expect(claude?.directories.length).toBeGreaterThan(0);
    expect(
      claude?.locations
        .filter((location) => location.status === 'active')
        .every((location) => location.directories.length > 0),
    ).toBe(true);
  });

  it('requires a token for the source map, like every other data route', async () => {
    const response = await call({ url: '/api/sources', token: null });
    expect(response.statusCode).toBe(401);
  });

  it('returns a review with a score, issues, and the rules that ran', async () => {
    const body = (await call({ url: '/api/review' })).json() as {
      summary: { score: number; ruleCount: number; reviewedSubjectCount: number };
      issues: { ruleId: string; remediation: string; fileId: string }[];
      rules: { id: string; rationale: string }[];
    };

    expect(body.rules.length).toBeGreaterThan(0);
    expect(body.summary.ruleCount).toBe(body.rules.length);
    expect(body.summary.reviewedSubjectCount).toBeGreaterThan(0);
    expect(body.summary.score).toBeGreaterThanOrEqual(0);
    expect(body.summary.score).toBeLessThanOrEqual(100);
    // Every issue must be actionable and traceable to a file, or it is noise.
    for (const issue of body.issues) {
      expect(issue.remediation.length).toBeGreaterThan(0);
      expect(issue.fileId.length).toBeGreaterThan(0);
    }
  });

  it('requires a token for the review', async () => {
    const response = await call({ url: '/api/review', token: null });
    expect(response.statusCode).toBe(401);
  });

  it('returns a context budget split by when the bytes are loaded', async () => {
    const body = (await call({ url: '/api/budget' })).json() as {
      providers: { providerId: string; alwaysBytes: number; contributors: unknown[] }[];
      totals: { alwaysBytes: number; alwaysTokens: number };
      bytesPerToken: number;
    };

    expect(body.bytesPerToken).toBeGreaterThan(0);
    expect(body.providers.length).toBeGreaterThan(0);
    expect(body.totals.alwaysBytes).toBeGreaterThan(0);
    expect(body.totals.alwaysTokens).toBeGreaterThan(0);
  });

  it('carries the always-loaded context weight on the overview', async () => {
    const body = (await call({ url: '/api/overview' })).json() as {
      contextBudget: { alwaysBytes: number; alwaysTokens: number; bytesPerToken: number };
    };

    expect(body.contextBudget.alwaysBytes).toBeGreaterThan(0);
    expect(body.contextBudget.bytesPerToken).toBeGreaterThan(0);
  });

  it('recomputes the review after a rescan rather than serving a stale one', async () => {
    const before = (
      (await call({ url: '/api/review' })).json() as {
        summary: { reviewedSubjectCount: number };
      }
    ).summary.reviewedSubjectCount;

    fixture.write('.claude/agents/undescribed.md', '---\nname: undescribed\n---\n\nDo the work.\n');
    await call({ method: 'POST', url: '/api/scan' });

    const after = (await call({ url: '/api/review' })).json() as {
      summary: { reviewedSubjectCount: number };
      issues: { ruleId: string }[];
    };

    expect(after.summary.reviewedSubjectCount).toBeGreaterThan(before);
    expect(after.issues.map((issue) => issue.ruleId)).toContain('capability-missing-description');
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

  it('rejects a document larger than the display and edit boundary', async () => {
    const { id } = await settings();
    const response = await call({
      method: 'PUT',
      url: `/api/files/${id}`,
      payload: { content: 'x'.repeat(2 * 1024 * 1024 + 1), expectedHash: 'hash' },
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ error: expect.stringContaining('2097152') });
  });

  it('accepts bounded content even when JSON escaping expands the request', async () => {
    const { id, hash, path } = await settings();
    const content = JSON.stringify({ note: '\\'.repeat(600_000) });
    expect(Buffer.byteLength(JSON.stringify({ content, expectedHash: hash }))).toBeGreaterThan(
      2 * 1024 * 1024 + 64 * 1024,
    );

    const response = await call({
      method: 'PUT',
      url: `/api/files/${id}`,
      payload: { content, expectedHash: hash },
    });

    expect(response.statusCode).toBe(200);
    expect(readFileSync(path, 'utf8')).toBe(content);
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

describe('removing an MCP server', () => {
  it('deletes the server and reports where it was removed from', async () => {
    const id = await firstFileId('.cursor/mcp.json');
    const response = await call({ method: 'DELETE', url: `/api/files/${id}/mcp/filesystem` });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { ok: boolean; serverName: string; removedFrom: string[] };
    expect(body.ok).toBe(true);
    expect(body.serverName).toBe('filesystem');
    expect(body.removedFrom).toEqual(['mcpServers']);

    const inventory = (await call({ url: '/api/inventory' })).json() as {
      mcpServers: { name: string }[];
    };
    expect(inventory.mcpServers.map((entry) => entry.name)).not.toContain('filesystem');
  });

  it('404s a server the file does not declare', async () => {
    const id = await firstFileId('.cursor/mcp.json');
    const response = await call({ method: 'DELETE', url: `/api/files/${id}/mcp/absent` });

    expect(response.statusCode).toBe(404);
    expect((response.json() as { code: string }).code).toBe('not-declared');
  });

  it('404s an unknown file id', async () => {
    const response = await call({ method: 'DELETE', url: '/api/files/nope/mcp/github' });
    expect(response.statusCode).toBe(404);
  });

  it('409s a stale hash rather than editing the file', async () => {
    const id = await firstFileId('.cursor/mcp.json');
    const response = await call({
      method: 'DELETE',
      url: `/api/files/${id}/mcp/github`,
      payload: { expectedHash: 'stale' },
    });

    expect(response.statusCode).toBe(409);
    expect((response.json() as { code: string }).code).toBe('hash-mismatch');
  });

  it('403s in read-only mode', async () => {
    await app.close();
    await start({ readOnly: true });

    const id = await firstFileId('.cursor/mcp.json');
    const response = await call({ method: 'DELETE', url: `/api/files/${id}/mcp/github` });

    expect(response.statusCode).toBe(403);
    expect((response.json() as { code: string }).code).toBe('read-only');
  });

  it('requires a token like every other mutating route', async () => {
    const id = await firstFileId('.cursor/mcp.json');
    const response = await call({
      method: 'DELETE',
      url: `/api/files/${id}/mcp/github`,
      token: null,
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('deleting a file', () => {
  async function claudeMd() {
    const id = await firstFileId('.claude/CLAUDE.md');
    const document = (await call({ url: `/api/files/${id}` })).json() as {
      hash: string;
      deletable: boolean;
      file: { path: string };
    };
    return { id, hash: document.hash, path: document.file.path, deletable: document.deletable };
  }

  it('deletes the file and reports the backup', async () => {
    const { id, hash, path } = await claudeMd();

    const response = await call({
      method: 'DELETE',
      url: `/api/files/${id}`,
      payload: { expectedHash: hash },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { ok: boolean; backupPath: string; bytesRemoved: number };
    expect(body.ok).toBe(true);
    expect(readFileSync(body.backupPath, 'utf8')).toBe(samples.claudeMd);
    expect(body.bytesRemoved).toBeGreaterThan(0);
    expect(existsSync(path)).toBe(false);

    const scan = (await call({ url: '/api/scan' })).json() as { files: { id: string }[] };
    expect(scan.files.some((entry) => entry.id === id)).toBe(false);
  });

  it('deletes without an expected hash', async () => {
    const { id, path } = await claudeMd();
    const response = await call({ method: 'DELETE', url: `/api/files/${id}` });

    expect(response.statusCode).toBe(200);
    expect(existsSync(path)).toBe(false);
  });

  it('409s a stale hash rather than removing the file', async () => {
    const { id, path } = await claudeMd();
    const response = await call({
      method: 'DELETE',
      url: `/api/files/${id}`,
      payload: { expectedHash: 'stale' },
    });

    expect(response.statusCode).toBe(409);
    expect((response.json() as { code: string }).code).toBe('hash-mismatch');
    expect(existsSync(path)).toBe(true);
  });

  it('403s a file that holds more than the entry shown', async () => {
    const id = await firstFileId('.claude/settings.json');
    const response = await call({ method: 'DELETE', url: `/api/files/${id}` });

    expect(response.statusCode).toBe(403);
    expect((response.json() as { code: string }).code).toBe('not-deletable');
  });

  it('403s a credential store', async () => {
    const id = await firstFileId('.claude/.credentials.json');
    const response = await call({ method: 'DELETE', url: `/api/files/${id}` });

    expect(response.statusCode).toBe(403);
    expect((response.json() as { code: string }).code).toBe('not-deletable');
  });

  it('400s an expectedHash that is not a bounded string', async () => {
    const { id } = await claudeMd();

    expect(
      (
        await call({
          method: 'DELETE',
          url: `/api/files/${id}`,
          payload: { expectedHash: 42 },
        })
      ).statusCode,
    ).toBe(400);

    expect(
      (
        await call({
          method: 'DELETE',
          url: `/api/files/${id}`,
          payload: { expectedHash: 'x'.repeat(1000) },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('404s an unknown file id', async () => {
    const response = await call({ method: 'DELETE', url: '/api/files/nope' });
    expect(response.statusCode).toBe(404);
  });

  it('403s in read-only mode', async () => {
    await app.close();
    await start({ readOnly: true });

    const { id, path } = await claudeMd();
    const response = await call({ method: 'DELETE', url: `/api/files/${id}` });

    expect(response.statusCode).toBe(403);
    expect((response.json() as { code: string }).code).toBe('read-only');
    expect(existsSync(path)).toBe(true);
  });

  it('marks a read-only session undeletable in the document itself', async () => {
    await app.close();
    await start({ readOnly: true });

    const { deletable } = await claudeMd();
    expect(deletable).toBe(false);
  });

  it('requires a token like every other mutating route', async () => {
    const { id } = await claudeMd();
    const response = await call({ method: 'DELETE', url: `/api/files/${id}`, token: null });
    expect(response.statusCode).toBe(401);
  });
});

describe('capability routes', () => {
  interface CapabilityListBody {
    capabilities: { fileId: string; name: string; kind: string; model?: string }[];
    knownModels: string[];
    readOnly: boolean;
  }

  async function skill() {
    const list = (await call({ url: '/api/capabilities' })).json() as CapabilityListBody;
    const entry = list.capabilities.find((item) => item.name === 'pdf-extractor');
    if (!entry) throw new Error('fixture missing pdf-extractor');

    const document = (
      await call({ url: `/api/capabilities/${entry.fileId}?reveal=true` })
    ).json() as { hash: string; file: { path: string } };

    return { id: entry.fileId, hash: document.hash, path: document.file.path };
  }

  it('requires a token', async () => {
    expect((await call({ url: '/api/capabilities', token: null })).statusCode).toBe(401);
  });

  it('lists capabilities with the models already in use', async () => {
    const response = await call({ url: '/api/capabilities' });
    expect(response.statusCode).toBe(200);

    const body = response.json() as CapabilityListBody;
    expect(body.capabilities.map((entry) => entry.name)).toContain('pdf-extractor');
    expect(body.knownModels).toContain('claude-opus-4.5');
    expect(body.readOnly).toBe(false);
  });

  it('returns fields and a body, revealed only when asked', async () => {
    const list = (await call({ url: '/api/capabilities' })).json() as CapabilityListBody;
    const id = list.capabilities.find((entry) => entry.name === 'pdf-extractor')?.fileId ?? '';

    const masked = (await call({ url: `/api/capabilities/${id}` })).json() as {
      fields: { name?: string; tools?: string[] };
      extraKeys: string[];
      revealed: boolean;
    };
    expect(masked.fields.name).toBe('pdf-extractor');
    expect(masked.fields.tools).toEqual(['read', 'bash']);
    expect(masked.extraKeys).toEqual(['license']);
    expect(masked.revealed).toBe(false);

    const revealed = (await call({ url: `/api/capabilities/${id}?reveal=true` })).json() as {
      revealed: boolean;
    };
    expect(revealed.revealed).toBe(true);
  });

  it('404s for a file that is not a capability', async () => {
    const id = await firstFileId('.claude/settings.json');
    expect((await call({ url: `/api/capabilities/${id}` })).statusCode).toBe(404);
    expect(
      (
        await call({
          method: 'PUT',
          url: `/api/capabilities/${id}`,
          payload: { expectedHash: 'x', name: 'nope' },
        })
      ).statusCode,
    ).toBe(404);
  });

  it('saves a field edit and preserves unmodelled front matter', async () => {
    const { id, hash, path } = await skill();

    const response = await call({
      method: 'PUT',
      url: `/api/capabilities/${id}`,
      payload: { expectedHash: hash, name: 'pdf-reader', model: 'gpt-5', tools: ['read'] },
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as { ok: boolean; backupPath: string }).backupPath).toBeTruthy();

    const text = readFileSync(path, 'utf8');
    expect(text).toContain('name: pdf-reader');
    expect(text).toContain('model: gpt-5');
    expect(text).toContain('license: Apache-2.0');
  });

  it('400s on a missing hash or a mistyped field', async () => {
    const { id, hash } = await skill();

    expect(
      (await call({ method: 'PUT', url: `/api/capabilities/${id}`, payload: { name: 'x' } }))
        .statusCode,
    ).toBe(400);

    expect(
      (
        await call({
          method: 'PUT',
          url: `/api/capabilities/${id}`,
          payload: { expectedHash: hash, name: 42 },
        })
      ).statusCode,
    ).toBe(400);

    expect(
      (
        await call({
          method: 'PUT',
          url: `/api/capabilities/${id}`,
          payload: { expectedHash: hash, tools: 'read' },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('bounds capability fields and tool lists', async () => {
    const { id, hash } = await skill();

    const longName = await call({
      method: 'PUT',
      url: `/api/capabilities/${id}`,
      payload: { expectedHash: hash, name: 'x'.repeat(257) },
    });
    expect(longName.statusCode).toBe(400);

    const tooManyTools = await call({
      method: 'PUT',
      url: `/api/capabilities/${id}`,
      payload: { expectedHash: hash, tools: Array.from({ length: 257 }, () => 'read') },
    });
    expect(tooManyTools.statusCode).toBe(400);
  });

  it('409s on a stale hash', async () => {
    const { id, path } = await skill();
    const before = readFileSync(path, 'utf8');

    const response = await call({
      method: 'PUT',
      url: `/api/capabilities/${id}`,
      payload: { expectedHash: 'stale', name: 'renamed' },
    });

    expect(response.statusCode).toBe(409);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('403s every capability write in read-only mode', async () => {
    const { id } = await skill();
    await app.close();
    await start({ readOnly: true });

    const response = await call({
      method: 'PUT',
      url: `/api/capabilities/${id}`,
      payload: { expectedHash: 'x', name: 'renamed' },
    });

    expect(response.statusCode).toBe(403);
    expect((response.json() as { code: string }).code).toBe('read-only');
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

  it('rejects an unbounded or null-containing project path', async () => {
    expect(
      (
        await call({
          method: 'POST',
          url: '/api/projects',
          payload: { path: 'x'.repeat(4097) },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await call({
          method: 'POST',
          url: '/api/projects',
          payload: { path: 'bad\0path' },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('returns an actionable error for missing roots and files', async () => {
    const missing = await call({
      method: 'POST',
      url: '/api/projects',
      payload: { path: `${fixture.root}/missing` },
    });
    expect(missing.statusCode).toBe(400);
    expect((missing.json() as { error: string }).error).toMatch(/does not exist.*--project/);

    const file = fixture.write('not-a-project.txt', 'content');
    const notDirectory = await call({
      method: 'POST',
      url: '/api/projects',
      payload: { path: file },
    });
    expect(notDirectory.statusCode).toBe(400);
    expect((notDirectory.json() as { error: string }).error).toMatch(/not a directory/);
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

  it('bounds search queries and filter fan-out', async () => {
    expect((await call({ url: `/api/search?q=${'x'.repeat(513)}` })).statusCode).toBe(400);

    const filters = Array.from({ length: 65 }, (_, index) => `p${String(index)}`).join(',');
    expect((await call({ url: `/api/search?q=x&provider=${filters}` })).statusCode).toBe(400);
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
});

describe('unknown endpoints', () => {
  it('404s an unknown API route', async () => {
    expect((await call({ url: '/api/nope' })).statusCode).toBe(404);
  });
});

describe('serving the built web bundle', () => {
  // `publicDir` is the branch that turns the API into an actual app, and it is
  // only reachable when a bundle exists on disk, so it gets its own server.
  let bundleApp: FastifyInstance;
  let publicDir: string;

  beforeEach(async () => {
    publicDir = join(fixture.root, 'public');
    mkdirSync(join(publicDir, 'assets'), { recursive: true });
    writeFileSync(join(publicDir, 'index.html'), '<!doctype html><title>AI Harness Helper</title>');
    writeFileSync(join(publicDir, 'assets', 'app.js'), 'export const ok = true;\n');

    const service = new HarnessService({
      environment: fixture.environment,
      writerOptions: { backupRoot: join(fixture.root, 'backups') },
    });
    ({ app: bundleApp } = await createServer({ service, token: TOKEN, publicDir }));
  });

  afterEach(async () => {
    await bundleApp.close();
  });

  const get = async (url: string) =>
    bundleApp.inject({ method: 'GET', url, headers: { host: '127.0.0.1:7777' } });

  it('serves index.html at the root without a token, so the app can boot', async () => {
    const response = await get('/');

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('AI Harness Helper');
  });

  it('serves hashed assets', async () => {
    const response = await get('/assets/app.js');

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('export const ok');
  });

  it('falls back to the shell for a client-side route', async () => {
    const response = await get('/files/abc123');

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('AI Harness Helper');
  });

  it('still 404s unknown API routes rather than returning the shell', async () => {
    const response = await bundleApp.inject({
      method: 'GET',
      url: '/api/nope',
      headers: { host: '127.0.0.1:7777', 'x-harness-token': TOKEN },
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('<!doctype html>');
  });

  it('does not serve API data to an unauthenticated request just because a bundle exists', async () => {
    expect((await get('/api/scan')).statusCode).toBe(401);
  });
});
