import { describe, expect, it } from 'vitest';

import {
  applyCapabilityEdits,
  composeCapabilityDocument,
  isCapabilityFormat,
  parseCapabilityDocument,
  validateCapabilityDocument,
} from '../src/capability-doc.js';
import { samples } from './fixture.js';

describe('parseCapabilityDocument', () => {
  it('splits managed fields, extras, and body', () => {
    const parsed = parseCapabilityDocument(samples.skillFile);

    expect(parsed.hasFrontmatter).toBe(true);
    expect(parsed.name).toBe('pdf-extractor');
    expect(parsed.model).toBe('claude-opus-4.5');
    expect(parsed.version).toBe('1.2.0');
    expect(parsed.tools).toEqual(['read', 'bash']);
    expect(parsed.extraKeys).toEqual(['license']);
    expect(parsed.body.trim().startsWith('# PDF extractor')).toBe(true);
    expect(parsed.issues).toEqual([]);
  });

  it('treats a file with no front matter as all body', () => {
    const parsed = parseCapabilityDocument('Just prose.\n');

    expect(parsed.hasFrontmatter).toBe(false);
    expect(parsed.body).toBe('Just prose.\n');
    expect(parsed.name).toBeUndefined();
    expect(parsed.extraKeys).toEqual([]);
  });

  it('presents non-string scalars as the text a user would type', () => {
    const parsed = parseCapabilityDocument('---\nversion: 1.2\n---\n\nBody\n');
    expect(parsed.version).toBe('1.2');
  });

  it('accepts a comma-separated tools string', () => {
    const parsed = parseCapabilityDocument('---\ntools: read, bash , edit\n---\n\nBody\n');
    expect(parsed.tools).toEqual(['read', 'bash', 'edit']);
  });

  it('reports malformed front matter without losing the body', () => {
    const parsed = parseCapabilityDocument('---\nname: [unclosed\n---\n\nBody text\n');

    expect(parsed.issues.length).toBeGreaterThan(0);
    expect(parsed.body).toContain('Body text');
  });
});

describe('applyCapabilityEdits', () => {
  it('preserves an unmodelled key in its original position', () => {
    const next = applyCapabilityEdits(samples.skillFile, { name: 'pdf-reader' });

    expect(next).toContain('license: Apache-2.0');
    const keys = [...next.matchAll(/^([a-z-]+):/gm)].map((match) => match[1]);
    expect(keys).toEqual(['name', 'description', 'model', 'version', 'tools', 'license']);
    expect(parseCapabilityDocument(next).name).toBe('pdf-reader');
  });

  it('leaves fields absent from the edit untouched', () => {
    const next = parseCapabilityDocument(
      applyCapabilityEdits(samples.skillFile, { model: 'gpt-5' }),
    );

    expect(next.model).toBe('gpt-5');
    expect(next.name).toBe('pdf-extractor');
    expect(next.description).toBe('Extracts text and tables from PDF files');
  });

  it('deletes a key when the field is cleared rather than writing an empty value', () => {
    const next = applyCapabilityEdits(samples.skillFile, { model: '   ' });

    expect(next).not.toContain('model:');
    expect(parseCapabilityDocument(next).model).toBeUndefined();
  });

  it('deletes tools when the list is emptied', () => {
    const next = applyCapabilityEdits(samples.skillFile, { tools: [] });

    expect(next).not.toContain('tools:');
    expect(parseCapabilityDocument(next).tools).toBeUndefined();
  });

  it('appends new keys in template order', () => {
    const next = applyCapabilityEdits('---\ndescription: Does a thing\n---\n\nBody\n', {
      name: 'thing-doer',
      model: 'claude-opus-4.5',
    });
    const keys = [...next.matchAll(/^([a-z-]+):/gm)].map((match) => match[1]);

    expect(keys).toEqual(['name', 'description', 'model']);
  });

  it('slots a new key into template order rather than after unmodelled keys', () => {
    const source = '---\nname: a\nmodel: m\ntools:\n  - read\nlicense: MIT\n---\n\nBody\n';
    const next = applyCapabilityEdits(source, { version: '2.0.0' });
    const keys = [...next.matchAll(/^([a-z-]+):/gm)].map((match) => match[1]);

    expect(keys).toEqual(['name', 'model', 'version', 'tools', 'license']);
  });

  it('adds front matter to a file that had none', () => {
    const next = applyCapabilityEdits('Plain body\n', { name: 'new-skill' });

    expect(next.startsWith('---\nname: new-skill\n---\n')).toBe(true);
    expect(next).toContain('Plain body');
  });

  it('replaces the body without disturbing front matter', () => {
    const next = parseCapabilityDocument(
      applyCapabilityEdits(samples.skillFile, { body: '# Replaced\n' }),
    );

    expect(next.body.trim()).toBe('# Replaced');
    expect(next.name).toBe('pdf-extractor');
    expect(next.extraKeys).toEqual(['license']);
  });

  it('keeps a long description on one line', () => {
    const description = 'A '.repeat(80) + 'description';
    const next = applyCapabilityEdits(samples.skillFile, { description });

    expect(next).toContain(`description: ${description}`);
    expect(parseCapabilityDocument(next).description).toBe(description);
  });
});

describe('composeCapabilityDocument', () => {
  it('returns only the body when there is no front matter', () => {
    expect(composeCapabilityDocument({}, 'Body\n')).toBe('Body\n');
  });

  it('strips a leading byte order mark from the body', () => {
    expect(composeCapabilityDocument({}, '\uFEFFBody\n')).toBe('Body\n');
  });
});

describe('validateCapabilityDocument', () => {
  it('accepts a well-formed document', () => {
    expect(validateCapabilityDocument(samples.skillFile)).toEqual([]);
  });

  it('accepts a document with no front matter', () => {
    expect(validateCapabilityDocument('Body only\n')).toEqual([]);
  });

  it('rejects front matter that is not a mapping', () => {
    expect(validateCapabilityDocument('---\n- one\n- two\n---\n\nBody\n')).toHaveLength(1);
  });

  it('reports a YAML syntax error', () => {
    expect(validateCapabilityDocument('---\nname: [unclosed\n---\n\nBody\n')).toHaveLength(1);
  });
});

describe('isCapabilityFormat', () => {
  it('accepts markdown formats and rejects the rest', () => {
    expect(isCapabilityFormat('markdown')).toBe(true);
    expect(isCapabilityFormat('md-frontmatter')).toBe(true);
    expect(isCapabilityFormat('json')).toBe(false);
    expect(isCapabilityFormat('toml')).toBe(false);
  });
});
