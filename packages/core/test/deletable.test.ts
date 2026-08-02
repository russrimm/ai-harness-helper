import { describe, expect, it } from 'vitest';

import { DELETABLE_KINDS, fileDeletability } from '../src/deletable.js';
import type { FileKind, Sensitivity } from '../src/types.js';

const ALL_KINDS: readonly FileKind[] = [
  'instructions',
  'agent',
  'skill',
  'prompt',
  'command',
  'chatmode',
  'permissions',
  'ignore',
  'memory',
  'settings',
  'mcp',
  'catalog',
  'credential',
  'extension',
  'unknown',
];

function check(kind: FileKind, sensitivity: Sensitivity = 'normal') {
  return fileDeletability({ kind, sensitivity });
}

describe('fileDeletability', () => {
  it('allows every kind where the file is the entry', () => {
    for (const kind of DELETABLE_KINDS) {
      expect(check(kind)).toEqual({ deletable: true });
    }
  });

  it('refuses every other kind with a reason the user can act on', () => {
    for (const kind of ALL_KINDS) {
      if (DELETABLE_KINDS.has(kind)) continue;
      const result = check(kind);
      expect(result.deletable).toBe(false);
      expect(result.reason ?? '').not.toBe('');
    }
  });

  it('points a settings file at the editor rather than offering a delete', () => {
    expect(check('settings').reason).toContain('editor');
  });

  it('points an mcp file at per-server removal', () => {
    expect(check('mcp').reason).toContain('MCP');
  });

  it('refuses a credential store whatever kind it was classified as', () => {
    for (const kind of ALL_KINDS) {
      const result = check(kind, 'credential-store');
      expect(result.deletable).toBe(false);
      expect(result.reason).toContain('credentials');
    }
  });

  it('still allows a file that merely may contain secrets', () => {
    expect(check('agent', 'contains-secrets')).toEqual({ deletable: true });
  });
});
