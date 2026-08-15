/**
 * Model lifecycle tests.
 *
 * Every assertion pins a clock, because the whole point of the design is that
 * status is computed from an announced date rather than hardcoded. A test that
 * used the real clock would start failing on the day a shutdown date passed,
 * which is exactly the behaviour being verified.
 */

import { describe, expect, it } from 'vitest';

import {
  assessModel,
  collectModelReferences,
  isModelOutdated,
  MODEL_DATA_VERIFIED_ON,
  MODEL_RECORDS,
  MODEL_SOURCES,
  normalizeModelReference,
} from '../src/models.js';

/** Before every shutdown date in the table, so nothing is retired yet. */
const EARLY = new Date('2024-01-01T00:00:00Z');
/** After every shutdown date in the table. */
const LATE = new Date('2099-01-01T00:00:00Z');

describe('normalizeModelReference', () => {
  it('strips routing prefixes tools put in front of the id', () => {
    expect(normalizeModelReference('openai/gpt-4')).toBe('gpt-4');
    expect(normalizeModelReference('anthropic.claude-3-opus-20240229')).toBe(
      'claude-3-opus-20240229',
    );
    expect(normalizeModelReference('models/gemini-1.5-pro')).toBe('gemini-1.5-pro');
  });

  it('strips stacked routing and Bedrock region prefixes', () => {
    expect(normalizeModelReference('bedrock/us.anthropic.claude-3-haiku-20240307-v1:0')).toBe(
      'claude-3-haiku-20240307',
    );
  });

  it('turns a Vertex @snapshot into the dashed form', () => {
    expect(normalizeModelReference('claude-3-5-sonnet@20240620')).toBe(
      'claude-3-5-sonnet-20240620',
    );
  });

  it('drops a trailing routing tag', () => {
    expect(normalizeModelReference('gpt-4-turbo:latest')).toBe('gpt-4-turbo');
  });

  it('is case and whitespace insensitive', () => {
    expect(normalizeModelReference('  GPT-4-32K  ')).toBe('gpt-4-32k');
  });
});

describe('assessModel', () => {
  it('reports a model as deprecated before its announced shutdown', () => {
    const assessment = assessModel('gpt-4-32k', EARLY);
    expect(assessment.status).toBe('deprecated');
    expect(assessment.vendor).toBe('openai');
    expect(assessment.shutdownDate).toBeDefined();
    expect(assessment.daysUntilShutdown).toBeGreaterThan(0);
  });

  it('reports the same model as retired once the date has passed', () => {
    const assessment = assessModel('gpt-4-32k', LATE);
    expect(assessment.status).toBe('retired');
    expect(assessment.daysUntilShutdown).toBeLessThan(0);
  });

  it('matches dotted and dashed spellings of one id', () => {
    const dashed = assessModel('claude-3-5-sonnet-20240620', LATE);
    const dotted = assessModel('claude-3.5-sonnet-20240620', LATE);
    expect(dotted.canonicalId).toBe(dashed.canonicalId);
    expect(dotted.status).toBe('retired');
  });

  it('never flags a model it does not know', () => {
    const assessment = assessModel('some-model-shipped-yesterday', LATE);
    expect(assessment.status).toBe('unknown');
    expect(isModelOutdated(assessment)).toBe(false);
  });

  it('never flags a floating alias, which always names whatever ships today', () => {
    for (const alias of ['sonnet', 'opus', 'auto', 'default', 'inherit']) {
      expect(assessModel(alias, LATE).status).toBe('unknown');
    }
  });

  it('follows the replacement chain past models that are themselves retired', () => {
    const assessment = assessModel('gpt-4-32k', LATE);
    expect(assessment.replacement).toBeDefined();
    const suggested = assessModel(assessment.replacement as string, LATE);
    expect(suggested.status).not.toBe('retired');
  });

  it('cites the vendor page every verdict came from', () => {
    expect(assessModel('gpt-4-32k', LATE).sourceUrl).toBe(MODEL_SOURCES.openai);
    expect(assessModel('claude-3-opus-20240229', LATE).sourceUrl).toBe(MODEL_SOURCES.anthropic);
    expect(assessModel('gemini-1.5-pro', LATE).sourceUrl).toBe(MODEL_SOURCES.google);
  });

  it('retires models the vendor delisted without publishing a date', () => {
    // Google stopped publishing a shutdown date for Gemini 1.x, so the record
    // carries a note instead of an invented date.
    const assessment = assessModel('gemini-1.5-pro', EARLY);
    expect(assessment.status).toBe('retired');
    expect(assessment.shutdownDate).toBeUndefined();
    expect(assessment.note).toBeDefined();
  });

  it('leaves a currently supported model alone', () => {
    const assessment = assessModel('claude-sonnet-4-5-20250929', EARLY);
    expect(assessment.status).toBe('active');
    expect(isModelOutdated(assessment)).toBe(false);
  });
});

describe('the bundled model table', () => {
  it('records a verification date so the data can be audited', () => {
    expect(MODEL_DATA_VERIFIED_ON).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('uses ISO dates everywhere a shutdown is announced', () => {
    for (const record of MODEL_RECORDS) {
      if (record.shutdownDate === undefined) continue;
      expect(record.shutdownDate, record.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(record.shutdownDate)), record.id).toBe(false);
    }
  });

  it('declares every id exactly once', () => {
    const seen = new Set<string>();
    for (const record of MODEL_RECORDS) {
      expect(seen.has(record.id), record.id).toBe(false);
      seen.add(record.id);
    }
  });

  it('only recommends replacements that are themselves in the table', () => {
    for (const record of MODEL_RECORDS) {
      if (record.replacement === undefined) continue;
      const target = assessModel(record.replacement, EARLY);
      expect(target.status, `${record.id} -> ${record.replacement}`).not.toBe('unknown');
    }
  });
});

describe('collectModelReferences', () => {
  it('finds a model in capability front matter', () => {
    expect(collectModelReferences({ name: 'reviewer', model: 'gpt-4' })).toEqual([
      { path: 'model', reference: 'gpt-4' },
    ]);
  });

  it('finds models nested in arrays, as editor settings store them', () => {
    const sites = collectModelReferences({
      models: [
        { title: 'Fast', model: 'gpt-4-turbo' },
        { title: 'Deep', model: 'o1' },
      ],
    });
    expect(sites).toEqual([
      { path: 'models.0.model', reference: 'gpt-4-turbo' },
      { path: 'models.1.model', reference: 'o1' },
    ]);
  });

  it('finds the alternate key names tools use', () => {
    const sites = collectModelReferences({
      defaultModel: 'gpt-4',
      weak_model: 'gpt-3.5-turbo',
      editor_model: 'o3-mini',
    });
    expect(sites.map((site) => site.path).sort()).toEqual([
      'defaultModel',
      'editor_model',
      'weak_model',
    ]);
  });

  it('ignores keys that merely contain the word model', () => {
    // `modelContextProtocol` is the reason the key list is closed rather than
    // a substring match.
    expect(collectModelReferences({ modelContextProtocol: 'enabled' })).toEqual([]);
  });

  it('ignores non-string and empty values', () => {
    expect(collectModelReferences({ model: '' })).toEqual([]);
    expect(collectModelReferences({ model: 42 })).toEqual([]);
  });

  it('yields nothing for a plain string document', () => {
    expect(collectModelReferences('# Just some markdown about gpt-4')).toEqual([]);
  });
});
