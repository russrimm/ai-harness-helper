import { readFileSync, writeFileSync } from 'node:fs';
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
  fixture.write('.claude/skills/pdf-extractor/SKILL.md', samples.skillFile);
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

  it('passes project-only mode through to scans and source descriptions', async () => {
    const harness = new HarnessService({
      environment: fixture.environment,
      projectRoots: [fixture.project],
      projectsOnly: true,
    });

    const result = await harness.getScan();
    expect(result.files.every((file) => file.scope === 'project')).toBe(true);

    const sources = await harness.getSources();
    expect(
      sources.providers
        .flatMap((provider) => provider.locations)
        .every((location) => location.scope === 'project'),
    ).toBe(true);
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

describe('removing an MCP server', () => {
  async function mcpFile(harness: HarnessService): Promise<{ id: string; path: string }> {
    const result = await harness.getScan();
    const file = result.files.find((entry) =>
      entry.path.replace(/\\/g, '/').endsWith('.cursor/mcp.json'),
    );
    if (!file) throw new Error('fixture missing mcp.json');
    return { id: file.id, path: file.path };
  }

  it('removes one server, backs up the file, and rescans', async () => {
    const harness = service();
    const { id, path } = await mcpFile(harness);
    expect((await harness.getInventory()).mcpServers.map((entry) => entry.name)).toContain(
      'filesystem',
    );

    const outcome = await harness.removeMcpServer(id, 'filesystem');
    expect(outcome?.ok).toBe(true);
    if (!outcome?.ok) return;

    expect(outcome.serverName).toBe('filesystem');
    expect(outcome.removedFrom).toEqual(['mcpServers']);
    expect(outcome.backupPath).toBeTruthy();

    const after = JSON.parse(readFileSync(path, 'utf8'));
    expect(after.mcpServers.filesystem).toBeUndefined();
    expect(after.mcpServers.github).toBeDefined();

    // The cached inventory would otherwise still list the removed server.
    const names = (await harness.getInventory()).mcpServers.map((entry) => entry.name);
    expect(names).not.toContain('filesystem');
  });

  it('reports a server that is not in the file without touching it', async () => {
    const harness = service();
    const { id, path } = await mcpFile(harness);
    const before = readFileSync(path, 'utf8');

    const outcome = await harness.removeMcpServer(id, 'never-configured');
    expect(outcome?.ok).toBe(false);
    if (outcome && !outcome.ok) expect(outcome.code).toBe('not-declared');
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('refuses in read-only mode', async () => {
    const harness = service({ readOnly: true });
    const { id, path } = await mcpFile(harness);
    const before = readFileSync(path, 'utf8');

    const outcome = await harness.removeMcpServer(id, 'github');
    expect(outcome?.ok).toBe(false);
    if (outcome && !outcome.ok) expect(outcome.code).toBe('read-only');
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('refuses to edit a credential store', async () => {
    const harness = service();
    const result = await harness.getScan();
    const file = result.files.find((entry) => entry.sensitivity === 'credential-store');

    const outcome = await harness.removeMcpServer(file?.id ?? '', 'anything');
    expect(outcome?.ok).toBe(false);
    if (outcome && !outcome.ok) expect(outcome.code).toBe('credential-store');
  });

  it('rejects a stale hash rather than editing a file that moved on', async () => {
    const harness = service();
    const { id, path } = await mcpFile(harness);

    const outcome = await harness.removeMcpServer(id, 'github', 'stale-hash');
    expect(outcome?.ok).toBe(false);
    if (outcome && !outcome.ok) expect(outcome.code).toBe('hash-mismatch');
    expect(readFileSync(path, 'utf8')).toContain('github');
  });

  it('returns undefined for an unknown file id', async () => {
    const harness = service();
    await harness.getScan();
    expect(await harness.removeMcpServer('nope', 'github')).toBeUndefined();
  });
});

describe('capabilities', () => {
  async function capability(harness: HarnessService, name: string) {
    const list = await harness.listCapabilities();
    const entry = list.capabilities.find((item) => item.name === name);
    if (!entry) throw new Error(`fixture missing capability ${name}`);
    return entry;
  }

  /** Loads a capability for editing and returns what a save needs. */
  async function open(harness: HarnessService, name: string) {
    const entry = await capability(harness, name);
    const document = await harness.getCapabilityDocument(entry.fileId, true);
    if (!document) throw new Error(`capability ${name} could not be opened`);
    return { id: entry.fileId, path: document.file.path, hash: document.hash, document };
  }

  it('lists agents and skills with their declared metadata', async () => {
    const list = await service().listCapabilities();
    const names = list.capabilities.map((entry) => entry.name);

    expect(names).toContain('reviewer');
    expect(names).toContain('pdf-extractor');
    expect(list.readOnly).toBe(false);

    const skill = list.capabilities.find((entry) => entry.name === 'pdf-extractor');
    expect(skill?.kind).toBe('skill');
    expect(skill?.model).toBe('claude-opus-4.5');
    expect(skill?.version).toBe('1.2.0');
    expect(skill?.tools).toEqual(['read', 'bash']);
    expect(skill?.editable).toBe(true);
  });

  it('aggregates the models and tools already in use', async () => {
    const list = await service().listCapabilities();

    expect(list.knownModels).toContain('claude-opus-4.5');
    expect(list.knownTools).toEqual(expect.arrayContaining(['bash', 'grep', 'read']));
  });

  it('never lists a credential store', async () => {
    const list = await service().listCapabilities();
    expect(list.capabilities.every((entry) => !entry.fileName.includes('credentials'))).toBe(true);
  });

  it('marks everything read-only when the session is', async () => {
    const list = await service({ readOnly: true }).listCapabilities();

    expect(list.readOnly).toBe(true);
    expect(list.capabilities.every((entry) => !entry.editable)).toBe(true);
  });

  it('falls back to the folder name for a file named SKILL.md', async () => {
    fixture.write('.claude/skills/csv-loader/SKILL.md', '# CSV loader\n');
    const list = await service().listCapabilities();

    expect(list.capabilities.map((entry) => entry.name)).toContain('csv-loader');
  });

  it('opens a capability masked, and revealed on request', async () => {
    const harness = service();
    const entry = await capability(harness, 'pdf-extractor');

    const masked = await harness.getCapabilityDocument(entry.fileId);
    expect(masked?.fields.name).toBe('pdf-extractor');
    expect(masked?.fields.tools).toEqual(['read', 'bash']);
    expect(masked?.extraKeys).toEqual(['license']);
    expect(masked?.hasFrontmatter).toBe(true);
    expect(masked?.revealed).toBe(false);

    const revealed = await harness.getCapabilityDocument(entry.fileId, true);
    expect(revealed?.revealed).toBe(true);
    expect(revealed?.body).toContain('pdftotext');
  });

  it('returns undefined for a file that is not a capability', async () => {
    const harness = service();
    const scan = await harness.getScan();
    const settings = scan.files.find((file) =>
      file.path.replace(/\\/g, '/').endsWith('.claude/settings.json'),
    );

    expect(await harness.getCapabilityDocument(settings?.id ?? '')).toBeUndefined();
    expect(
      await harness.writeCapabilityDocument(settings?.id ?? '', { name: 'x' }, 'hash'),
    ).toBeUndefined();
  });

  it('applies a field edit while preserving unmodelled front matter', async () => {
    const harness = service();
    const { id, path, hash } = await open(harness, 'pdf-extractor');

    const outcome = await harness.writeCapabilityDocument(
      id,
      { name: 'pdf-reader', model: 'gpt-5', tools: ['read'] },
      hash,
    );

    expect(outcome?.ok).toBe(true);
    if (outcome?.ok) expect(outcome.backupPath).toBeTruthy();

    const text = readFileSync(path, 'utf8');
    expect(text).toContain('name: pdf-reader');
    expect(text).toContain('model: gpt-5');
    expect(text).toContain('license: Apache-2.0');
    expect(text).toContain('pdftotext');
    expect(text).not.toContain('- bash');
  });

  it('deletes a key when the field is cleared', async () => {
    const harness = service();
    const { id, path, hash } = await open(harness, 'pdf-extractor');

    const outcome = await harness.writeCapabilityDocument(id, { version: '' }, hash);

    expect(outcome?.ok).toBe(true);
    expect(readFileSync(path, 'utf8')).not.toContain('version:');
  });

  it('rejects a stale hash', async () => {
    const harness = service();
    const { id, path } = await open(harness, 'pdf-extractor');
    const before = readFileSync(path, 'utf8');

    const outcome = await harness.writeCapabilityDocument(id, { name: 'renamed' }, 'stale-hash');

    expect(outcome?.ok).toBe(false);
    if (outcome && !outcome.ok) expect(outcome.code).toBe('hash-mismatch');
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('refuses a structured edit in read-only mode', async () => {
    const harness = service({ readOnly: true });
    const { id, path, hash } = await open(harness, 'pdf-extractor');
    const before = readFileSync(path, 'utf8');

    const outcome = await harness.writeCapabilityDocument(id, { name: 'renamed' }, hash);

    expect(outcome?.ok).toBe(false);
    if (outcome && !outcome.ok) expect(outcome.code).toBe('read-only');
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('refuses to write a masked value back into a file', async () => {
    const harness = service();
    const { id, path, hash } = await open(harness, 'pdf-extractor');

    const outcome = await harness.writeCapabilityDocument(id, { description: '••••••••' }, hash);

    expect(outcome?.ok).toBe(false);
    if (outcome && !outcome.ok) expect(outcome.code).toBe('invalid-content');
    expect(readFileSync(path, 'utf8')).toContain('Extracts text and tables');
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

  it('keeps inline credentials out of both export formats', async () => {
    // The Export view promises the download is safe to attach to a bug report,
    // so every place a secret can hide in an MCP definition is checked here.
    fixture.write(
      '.mcp.json',
      JSON.stringify({
        mcpServers: {
          viaFlag: { command: 'npx', args: ['srv', '--api-key', 'sk-live-flagsecret012345'] },
          viaEquals: { command: 'docker', args: ['run', '-e', 'TOKEN=ghp_equalssecret012345'] },
          viaUrl: { type: 'http', url: 'https://mcp.example.com/?api_key=sk-live-urlsecret01234' },
          viaEnv: { command: 'npx', env: { API_KEY: 'sk-live-envsecret012345' } },
        },
      }),
    );

    const svc = service();
    const json = JSON.stringify(await svc.exportJson());
    const markdown = await svc.exportMarkdown();

    for (const secret of [
      'sk-live-flagsecret012345',
      'ghp_equalssecret012345',
      'sk-live-urlsecret01234',
      'sk-live-envsecret012345',
    ]) {
      expect(json).not.toContain(secret);
      expect(markdown).not.toContain(secret);
    }

    // Redaction must not cost the report its usefulness.
    expect(json).toContain('viaUrl');
    expect(json).toContain('mcp.example.com');
  });
});

describe('sources', () => {
  it('describes every supported tool, whether or not it was found', async () => {
    const sources = await service().getSources();
    const claude = sources.providers.find((provider) => provider.providerId === 'claude-code');

    expect(sources.providers.length).toBeGreaterThan(5);
    expect(claude?.detected).toBe(true);
    expect(claude?.fileCount).toBeGreaterThan(0);
    expect(sources.providers.some((provider) => !provider.detected)).toBe(true);
    expect(sources.totals.detectedProviders).toBeLessThanOrEqual(sources.totals.providers);
  });

  it('resolves the directory of every location that holds a file', async () => {
    const sources = await service().getSources();
    const active = sources.providers
      .flatMap((provider) => provider.locations)
      .filter((location) => location.status === 'active');

    expect(active.length).toBeGreaterThan(0);
    for (const location of active) {
      expect(location.directories.length).toBeGreaterThan(0);
      expect(location.files.length).toBeGreaterThan(0);
    }
  });

  it('explains an empty location by listing the paths it checked', async () => {
    const sources = await service().getSources();
    const absent = sources.providers
      .flatMap((provider) => provider.locations)
      .filter((location) => location.status === 'absent');

    expect(absent.length).toBeGreaterThan(0);
    // Every absent location is explainable: either the exact paths that were
    // probed, or the templates for a scope that has no root registered.
    for (const location of absent) {
      expect(location.checkedPaths.length + location.templates.length).toBeGreaterThan(0);
    }
  });

  it('accounts for every scanned file exactly once', async () => {
    const harness = service();
    const scanned = await harness.getScan();
    const sources = await harness.getSources();
    const listed = sources.providers.flatMap((provider) =>
      provider.locations.flatMap((location) => location.files.map((file) => file.fileId)),
    );

    expect(new Set(listed).size).toBe(listed.length);
    expect(listed.sort()).toEqual(scanned.files.map((file) => file.id).sort());
  });

  it('keeps a swept-up file visible under a synthesized provider', async () => {
    fixture.writeProject('tools/mcp.json', JSON.stringify({ mcpServers: {} }));

    const sources = await service().getSources();
    const stray = sources.providers.find((provider) => provider.providerId === 'unattributed');

    expect(stray?.detected).toBe(true);
    expect(stray?.locations[0]?.files.length).toBeGreaterThan(0);
  });

  it('never exposes the contents of a credential store', async () => {
    const sources = await service().getSources();

    expect(JSON.stringify(sources)).not.toContain('sk-ant-secret');
  });
});
