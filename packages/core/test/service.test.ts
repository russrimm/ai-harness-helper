import { readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HarnessService } from '../src/service.js';
import { createFixture, samples, type Fixture } from './fixture.js';

let fixture: Fixture;

function service(options: { readOnly?: boolean } = {}): HarnessService {
  return new HarnessService({
    environment: fixture.environment,
    projectRoots: [fixture.project],
    readOnly: options.readOnly ?? false,
    writerOptions: { backupRoot: `${fixture.root}/backups` },
  });
}

beforeEach(() => {
  fixture = createFixture();
  fixture.write('.claude/settings.json', samples.claudeSettings);
  fixture.write('.claude/CLAUDE.md', samples.claudeMd);
  fixture.write('.claude/agents/reviewer.md', samples.agentFile);
  fixture.write('.claude/.credentials.json', '{"claudeAiOauth":{"accessToken":"sk-ant-secret"}}');
  fixture.write('.cursor/mcp.json', samples.claudeMcp);
  fixture.writeProject('AGENTS.md', samples.agentsMd);
});

afterEach(() => {
  fixture.cleanup();
});

describe('scanning and inventory', () => {
  it('discovers files and caches the scan', async () => {
    const harness = service();
    const first = await harness.getScan();
    expect(first.files.length).toBeGreaterThan(0);
    expect(await harness.getScan()).toBe(first);
  });

  it('produces an inventory with MCP servers', async () => {
    const inventory = await service().getInventory();
    expect(inventory.mcpServers.map((entry) => entry.name)).toContain('github');
    expect(inventory.summary.fileCount).toBeGreaterThan(0);
  });

  it('groups the tree by provider', async () => {
    const tree = await service().getTree();
    expect(tree.length).toBeGreaterThan(0);
    expect(tree.every((group) => group.files.length > 0)).toBe(true);
  });
});

describe('authorization', () => {
  it('only authorizes paths the scan actually found', async () => {
    const harness = service();
    const result = await harness.getScan();
    const known = result.files[0];
    expect(known).toBeDefined();
    expect(harness.isAuthorized(known?.path ?? '')).toBe(true);

    expect(harness.isAuthorized(`${fixture.home}/not-scanned.json`)).toBe(false);
    expect(harness.isAuthorized('relative/path.json')).toBe(false);
    expect(harness.isAuthorized(`${fixture.home}/.claude/../../etc/passwd`)).toBe(false);
  });

  it('returns undefined for an unknown file id', async () => {
    const harness = service();
    await harness.getScan();
    expect(await harness.getDocument('nope')).toBeUndefined();
    expect(await harness.revealValue('nope', 'r0')).toBeUndefined();
    expect(await harness.writeDocument('nope', '{}', 'hash')).toBeUndefined();
  });
});

describe('documents', () => {
  async function findId(harness: HarnessService, suffix: string): Promise<string> {
    const result = await harness.getScan();
    const file = result.files.find((entry) => entry.path.replace(/\\/g, '/').endsWith(suffix));
    if (!file) throw new Error(`fixture missing ${suffix}`);
    return file.id;
  }

  it('masks secrets by default and records them', async () => {
    const harness = service();
    const id = await findId(harness, '.claude/settings.json');
    const document = await harness.getDocument(id);

    expect(document?.revealed).toBe(false);
    expect(document?.content).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345');
    expect(document?.redactions.length).toBeGreaterThan(0);
    expect(document?.language).toBe('json');
    expect(document?.readOnly).toBe(false);
  });

  it('returns raw content when secrets are explicitly requested', async () => {
    const harness = service();
    const id = await findId(harness, '.claude/settings.json');
    const document = await harness.getDocument(id, true);

    expect(document?.revealed).toBe(true);
    expect(document?.content).toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345');
    expect(document?.redactions).toEqual([]);
  });

  it('never renders credential stores', async () => {
    const harness = service();
    const id = await findId(harness, '.claude/.credentials.json');

    for (const includeSecrets of [false, true]) {
      const document = await harness.getDocument(id, includeSecrets);
      expect(document?.content).toBe('');
      expect(document?.revealed).toBe(false);
      expect(document?.readOnly).toBe(true);
      expect(document?.readOnlyReason).toMatch(/credential/i);
    }
  });

  it('marks every document read-only in read-only mode', async () => {
    const harness = service({ readOnly: true });
    const id = await findId(harness, '.claude/settings.json');
    const document = await harness.getDocument(id);
    expect(document?.readOnly).toBe(true);
    expect(document?.readOnlyReason).toMatch(/read-only/i);
  });

  it('reveals a single masked value on request', async () => {
    const harness = service();
    const id = await findId(harness, '.claude/settings.json');
    const document = await harness.getDocument(id);
    const record = document?.redactions[0];
    expect(record).toBeDefined();

    const value = await harness.revealValue(id, record?.id ?? '');
    expect(value).toBe('sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345');
  });

  it('reveals the requested nested value instead of a same-named root value', async () => {
    fixture.write(
      '.claude/settings.json',
      JSON.stringify(
        {
          token: 'synthetic-root-value-0001',
          mcpServers: { demo: { env: { token: 'synthetic-nested-value-0002' } } },
        },
        null,
        2,
      ),
    );
    const harness = service();
    const id = await findId(harness, '.claude/settings.json');
    const document = await harness.getDocument(id);
    const nested = document?.redactions.find(
      (entry) => entry.length === 'synthetic-nested-value-0002'.length,
    );

    expect(await harness.revealValue(id, nested?.id ?? '')).toBe('synthetic-nested-value-0002');
  });

  it('refuses to reveal an unknown redaction id', async () => {
    const harness = service();
    const id = await findId(harness, '.claude/settings.json');
    await harness.getDocument(id);
    expect(await harness.revealValue(id, 'r999')).toBeUndefined();
  });

  it('refuses to reveal anything from a credential store', async () => {
    const harness = service();
    const id = await findId(harness, '.claude/.credentials.json');
    expect(await harness.revealValue(id, 'r0')).toBeUndefined();
  });

  it('surfaces parse issues instead of failing', async () => {
    const harness = service();
    const id = await findId(harness, '.cursor/mcp.json');
    const file = harness.findFile(id);
    writeFileSync(file?.path ?? '', '{ "mcpServers": ', 'utf8');

    const document = await harness.getDocument(id);
    expect(document?.issues.length).toBeGreaterThan(0);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a file replaced by a symlink after scanning',
    async () => {
      const harness = service();
      const id = await findId(harness, '.claude/settings.json');
      const file = harness.findFile(id);
      const outside = fixture.write('outside.json', '{"password":"synthetic-outside-value"}');
      unlinkSync(file?.path ?? '');
      symlinkSync(outside, file?.path ?? '');

      const document = await harness.getDocument(id);
      expect(document?.content).toBe('');
      expect(document?.issues[0]?.message).toMatch(/regular file|symbolic/i);
    },
  );

  it('bounds a file that grows after scanning', async () => {
    const harness = service();
    const id = await findId(harness, '.claude/settings.json');
    const file = harness.findFile(id);
    writeFileSync(file?.path ?? '', 'x'.repeat(2 * 1024 * 1024 + 1));

    const document = await harness.getDocument(id);
    expect(document?.content).toBe('');
    expect(document?.issues[0]?.message).toMatch(/read limit/i);
  });
});

describe('writing', () => {
  async function loadSettings(harness: HarnessService) {
    const result = await harness.getScan();
    const file = result.files.find((entry) =>
      entry.path.replace(/\\/g, '/').endsWith('.claude/settings.json'),
    );
    if (!file) throw new Error('fixture missing settings.json');
    const document = await harness.getDocument(file.id, true);
    if (!document) throw new Error('document missing');
    return { id: file.id, path: file.path, document };
  }

  it('writes valid content and rescans', async () => {
    const harness = service();
    const { id, path, document } = await loadSettings(harness);
    const next = JSON.stringify({ model: 'claude-opus-4' }, null, 2);

    const outcome = await harness.writeDocument(id, next, document.hash);
    expect(outcome?.ok).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(next);
    if (outcome?.ok) expect(outcome.backupPath).toBeTruthy();
  });

  it('rejects a stale hash rather than clobbering an external edit', async () => {
    const harness = service();
    const { id, path } = await loadSettings(harness);
    writeFileSync(path, '{"model":"changed-underneath"}', 'utf8');

    const outcome = await harness.writeDocument(id, '{"model":"mine"}', 'stale-hash');
    expect(outcome?.ok).toBe(false);
    if (outcome && !outcome.ok) expect(outcome.code).toBe('hash-mismatch');
    expect(readFileSync(path, 'utf8')).toBe('{"model":"changed-underneath"}');
  });

  it('rejects content that does not parse', async () => {
    const harness = service();
    const { id, path, document } = await loadSettings(harness);
    const before = readFileSync(path, 'utf8');

    const outcome = await harness.writeDocument(id, '{ not json', document.hash);
    expect(outcome?.ok).toBe(false);
    if (outcome && !outcome.ok) expect(outcome.code).toBe('invalid-content');
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('refuses every write in read-only mode', async () => {
    const harness = service({ readOnly: true });
    const { id, path, document } = await loadSettings(harness);
    const before = readFileSync(path, 'utf8');

    const outcome = await harness.writeDocument(id, '{}', document.hash);
    expect(outcome?.ok).toBe(false);
    if (outcome && !outcome.ok) expect(outcome.code).toBe('read-only');
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('refuses to write a credential store', async () => {
    const harness = service();
    const result = await harness.getScan();
    const file = result.files.find((entry) => entry.sensitivity === 'credential-store');
    expect(file).toBeDefined();

    const outcome = await harness.writeDocument(file?.id ?? '', '{}', file?.hash ?? '');
    expect(outcome?.ok).toBe(false);
    if (outcome && !outcome.ok) expect(outcome.code).toBe('credential-store');
  });
});

describe('search', () => {
  it('finds matching lines', async () => {
    const result = await service().search({ query: 'claude-sonnet-4' });
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0]?.line).toBeGreaterThan(0);
    expect(result.filesSearched).toBeGreaterThan(0);
  });

  it('returns nothing for a blank query without touching the disk', async () => {
    const result = await service().search({ query: '   ' });
    expect(result.hits).toEqual([]);
    expect(result.filesSearched).toBe(0);
  });

  it('cannot be used to confirm a secret', async () => {
    const result = await service().search({ query: 'sk-ant-api03-abcdefghij' });
    expect(result.hits).toEqual([]);
  });

  it('honours provider, kind, and scope filters', async () => {
    const harness = service();
    const byProvider = await harness.search({ query: 'a', providerIds: ['claude-code'] });
    expect(byProvider.hits.every((hit) => hit.providerId === 'claude-code')).toBe(true);

    const byNothing = await harness.search({ query: 'a', providerIds: ['does-not-exist'] });
    expect(byNothing.hits).toEqual([]);

    const byScope = await harness.search({ query: 'a', scopes: ['project'] });
    expect(byScope.filesSearched).toBeGreaterThan(0);
  });

  it('caps and flags oversized result sets', async () => {
    const result = await service().search({ query: 'a', limit: 2 });
    expect(result.hits.length).toBeLessThanOrEqual(2);
    expect(result.truncated).toBe(true);
  });
});

describe('project roots', () => {
  it('adds, deduplicates, and removes roots', async () => {
    const harness = new HarnessService({ environment: fixture.environment });
    expect(harness.projectRoots).toEqual([]);

    const added = await harness.addProjectRoot(fixture.project);
    expect(added).toHaveLength(1);
    expect(await harness.addProjectRoot(fixture.project)).toHaveLength(1);

    expect(await harness.removeProjectRoot(fixture.project)).toEqual([]);
    expect(await harness.removeProjectRoot(fixture.project)).toEqual([]);
  });

  it('picks up project files once a root is registered', async () => {
    const harness = new HarnessService({ environment: fixture.environment });
    const before = await harness.getScan();
    await harness.addProjectRoot(fixture.project);
    const after = await harness.getScan();
    expect(after.files.length).toBeGreaterThan(before.files.length);
  });
});

describe('export', () => {
  it('exports JSON without leaking raw file contents', async () => {
    const payload = await service().exportJson();
    expect(payload['summary']).toBeDefined();
    expect(payload['mcpServers']).toBeDefined();
    expect(JSON.stringify(payload)).not.toContain('sk-ant-api03-abcdefghij');
  });

  it('exports a readable Markdown report', async () => {
    const markdown = await service().exportMarkdown();
    expect(markdown).toContain('# Agentic harness report');
    expect(markdown).toContain('## MCP servers');
    expect(markdown).not.toContain('sk-ant-api03-abcdefghij');
  });
});
