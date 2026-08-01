import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { hashContent, validateContent, writeConfigFile } from '../src/writer.js';
import { createFixture, type Fixture } from './fixture.js';

let fixture: Fixture;
let backupRoot: string;

beforeEach(() => {
  fixture = createFixture();
  backupRoot = join(fixture.root, 'backups');
});

afterEach(() => {
  fixture.cleanup();
});

const VALID = JSON.stringify({ mcpServers: {} }, null, 2);

describe('validateContent', () => {
  it('accepts well-formed JSON', () => {
    expect(validateContent('{"a":1}', 'json')).toEqual({ valid: true });
  });

  it('rejects malformed JSON with a message', () => {
    const result = validateContent('{"a":', 'json');

    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.issues.length).toBeGreaterThan(0);
  });

  it('accepts comments in JSONC', () => {
    expect(validateContent('{\n// hi\n"a":1}', 'jsonc')).toEqual({ valid: true });
  });

  it('rejects malformed TOML and YAML', () => {
    expect(validateContent('a = = 1', 'toml').valid).toBe(false);
    expect(validateContent('a:\n - b\n  c: d', 'yaml').valid).toBe(false);
  });

  it('does not gate free-form formats', () => {
    expect(validateContent('# anything goes', 'markdown')).toEqual({ valid: true });
    expect(validateContent('anything', 'text')).toEqual({ valid: true });
  });
});

describe('writeConfigFile - refusals', () => {
  it('refuses every write in read-only mode', async () => {
    const path = fixture.write('.cursor/mcp.json', VALID);

    const result = await writeConfigFile(
      {
        path,
        content: '{}',
        format: 'json',
        sensitivity: 'normal',
        expectedHash: hashContent(VALID),
      },
      { readOnly: true, backupRoot },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('read-only');
    expect(readFileSync(path, 'utf8')).toBe(VALID);
  });

  it('refuses to edit a credential store', async () => {
    const path = fixture.write('.codex/auth.json', '{"token":"x"}');

    const result = await writeConfigFile(
      {
        path,
        content: '{}',
        format: 'json',
        sensitivity: 'credential-store',
        expectedHash: hashContent('{"token":"x"}'),
      },
      { backupRoot },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('credential-store');
    expect(readFileSync(path, 'utf8')).toBe('{"token":"x"}');
  });

  it('refuses content that does not parse, leaving the file untouched', async () => {
    const path = fixture.write('.cursor/mcp.json', VALID);

    const result = await writeConfigFile(
      {
        path,
        content: '{ "mcpServers": ',
        format: 'json',
        sensitivity: 'normal',
        expectedHash: hashContent(VALID),
      },
      { backupRoot },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('invalid-content');
      expect(result.issues?.length).toBeGreaterThan(0);
    }
    expect(readFileSync(path, 'utf8')).toBe(VALID);
  });

  it('aborts when the file changed on disk after it was loaded', async () => {
    const path = fixture.write('.cursor/mcp.json', VALID);
    const staleHash = hashContent(VALID);
    fixture.write('.cursor/mcp.json', '{"mcpServers":{"added":{}}}');

    const result = await writeConfigFile(
      { path, content: '{}', format: 'json', sensitivity: 'normal', expectedHash: staleHash },
      { backupRoot },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('hash-mismatch');
      expect(result.currentHash).toBe(hashContent('{"mcpServers":{"added":{}}}'));
    }
    expect(readFileSync(path, 'utf8')).toBe('{"mcpServers":{"added":{}}}');
  });

  it('reports a missing file rather than silently recreating it', async () => {
    const result = await writeConfigFile(
      {
        path: join(fixture.home, '.cursor', 'gone.json'),
        content: '{}',
        format: 'json',
        sensitivity: 'normal',
        expectedHash: hashContent('{}'),
      },
      { backupRoot },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not-found');
  });

  it('refuses to create over a file that already exists', async () => {
    const path = fixture.write('.cursor/mcp.json', VALID);

    const result = await writeConfigFile(
      { path, content: '{}', format: 'json', sensitivity: 'normal', expectedHash: null },
      { backupRoot },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('hash-mismatch');
    expect(readFileSync(path, 'utf8')).toBe(VALID);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses to write through a file symlink (Windows requires symlink privilege)',
    async () => {
      const outside = fixture.write('outside.json', VALID);
      const path = join(fixture.home, '.cursor', 'mcp.json');
      mkdirSync(join(fixture.home, '.cursor'), { recursive: true });
      symlinkSync(outside, path);

      const result = await writeConfigFile(
        {
          path,
          content: '{}',
          format: 'json',
          sensitivity: 'normal',
          expectedHash: hashContent(VALID),
        },
        { backupRoot },
      );

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('write-failed');
      expect(readFileSync(outside, 'utf8')).toBe(VALID);
    },
  );

  it('refuses to write through a directory junction', async () => {
    const linkedDirectory = join(fixture.home, '.cursor');
    const originalDirectory = join(fixture.home, '.cursor-original');
    const outsideDirectory = join(fixture.root, 'outside-cursor');
    const path = join(linkedDirectory, 'mcp.json');
    mkdirSync(linkedDirectory, { recursive: true });
    writeFileSync(path, VALID);
    mkdirSync(outsideDirectory, { recursive: true });
    writeFileSync(join(outsideDirectory, 'mcp.json'), VALID);
    renameSync(linkedDirectory, originalDirectory);
    symlinkSync(outsideDirectory, linkedDirectory, 'junction');

    const result = await writeConfigFile(
      {
        path,
        content: '{}',
        format: 'json',
        sensitivity: 'normal',
        expectedHash: hashContent(VALID),
      },
      { backupRoot },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('write-failed');
      expect(result.message).toMatch(/symbolic link|junction/i);
    }
    expect(readFileSync(join(outsideDirectory, 'mcp.json'), 'utf8')).toBe(VALID);
  });
});

describe('writeConfigFile - successful writes', () => {
  it('writes the new content and returns its hash', async () => {
    const path = fixture.write('.cursor/mcp.json', VALID);
    const next = JSON.stringify({ mcpServers: { fs: { command: 'npx' } } }, null, 2);

    const result = await writeConfigFile(
      {
        path,
        content: next,
        format: 'json',
        sensitivity: 'normal',
        expectedHash: hashContent(VALID),
      },
      { backupRoot },
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.hash).toBe(hashContent(next));
    expect(readFileSync(path, 'utf8')).toBe(next);
  });

  it('preserves the previous contents in a backup', async () => {
    const path = fixture.write('.cursor/mcp.json', VALID);

    const result = await writeConfigFile(
      {
        path,
        content: '{}',
        format: 'json',
        sensitivity: 'normal',
        expectedHash: hashContent(VALID),
      },
      { backupRoot },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(existsSync(result.backupPath)).toBe(true);
      expect(readFileSync(result.backupPath, 'utf8')).toBe(VALID);
    }
  });

  it('keeps backups of same-named files from different tools apart', async () => {
    const a = fixture.write('.cursor/settings.json', '{"a":1}');
    const b = fixture.write('.claude/settings.json', '{"b":2}');
    const now = () => new Date('2024-05-01T12:00:00.000Z');

    const first = await writeConfigFile(
      {
        path: a,
        content: '{}',
        format: 'json',
        sensitivity: 'normal',
        expectedHash: hashContent('{"a":1}'),
      },
      { backupRoot, now },
    );
    const second = await writeConfigFile(
      {
        path: b,
        content: '{}',
        format: 'json',
        sensitivity: 'normal',
        expectedHash: hashContent('{"b":2}'),
      },
      { backupRoot, now },
    );

    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.backupPath).not.toBe(second.backupPath);
      expect(readFileSync(first.backupPath, 'utf8')).toBe('{"a":1}');
      expect(readFileSync(second.backupPath, 'utf8')).toBe('{"b":2}');
    }
  });

  it('creates a file that does not exist when no hash is expected', async () => {
    const path = join(fixture.home, '.cursor', 'mcp.json');

    const result = await writeConfigFile(
      { path, content: VALID, format: 'json', sensitivity: 'normal', expectedHash: null },
      { backupRoot },
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.backupPath).toBe('');
    expect(readFileSync(path, 'utf8')).toBe(VALID);
  });

  it('allows editing a file that may contain secrets', async () => {
    const path = fixture.write('.claude/settings.json', '{"env":{}}');

    const result = await writeConfigFile(
      {
        path,
        content: '{"env":{"A":"b"}}',
        format: 'json',
        sensitivity: 'contains-secrets',
        expectedHash: hashContent('{"env":{}}'),
      },
      { backupRoot },
    );

    expect(result.ok).toBe(true);
  });

  it('leaves no temporary files behind', async () => {
    const path = fixture.write('.cursor/mcp.json', VALID);

    await writeConfigFile(
      {
        path,
        content: '{}',
        format: 'json',
        sensitivity: 'normal',
        expectedHash: hashContent(VALID),
      },
      { backupRoot },
    );

    expect(existsSync(join(fixture.home, '.cursor', `.mcp.json.aihh-${process.pid}.tmp`))).toBe(
      false,
    );
  });

  it('round-trips so a second edit can follow the first', async () => {
    const path = fixture.write('.cursor/mcp.json', VALID);

    const first = await writeConfigFile(
      {
        path,
        content: '{"a":1}',
        format: 'json',
        sensitivity: 'normal',
        expectedHash: hashContent(VALID),
      },
      { backupRoot },
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await writeConfigFile(
      { path, content: '{"a":2}', format: 'json', sensitivity: 'normal', expectedHash: first.hash },
      { backupRoot },
    );

    expect(second.ok).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('{"a":2}');
  });

  it('writes markdown without demanding it parse as structured data', async () => {
    const path = fixture.write('.claude/CLAUDE.md', '# Old\n');

    const result = await writeConfigFile(
      {
        path,
        content: '# New\n\nBe concise.\n',
        format: 'markdown',
        sensitivity: 'normal',
        expectedHash: hashContent('# Old\n'),
      },
      { backupRoot },
    );

    expect(result.ok).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('# New\n\nBe concise.\n');
  });
});
