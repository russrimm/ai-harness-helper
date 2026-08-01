import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseArgs } from '../src/bin.js';

describe('parseArgs', () => {
  it('defaults to opening a browser with editing enabled', () => {
    const options = parseArgs([]);
    expect(options).toEqual({
      port: undefined,
      open: true,
      readOnly: false,
      projects: [],
      help: false,
      version: false,
    });
  });

  it('parses flags in long and short form', () => {
    expect(parseArgs(['--port', '9000']).port).toBe(9000);
    expect(parseArgs(['-p', '9000']).port).toBe(9000);
    expect(parseArgs(['--no-open']).open).toBe(false);
    expect(parseArgs(['--read-only']).readOnly).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-v']).version).toBe(true);
  });

  it('accepts repeated project roots and resolves them to absolute paths', () => {
    const options = parseArgs(['--project', 'a', '--project', 'b']);
    expect(options.projects).toEqual([resolve('a'), resolve('b')]);
  });

  it('does not treat a project path as a flag', () => {
    expect(parseArgs(['--project', 'repo', '--read-only']).projects).toEqual([resolve('repo')]);
  });

  it('rejects a port that is not a valid number', () => {
    for (const value of ['abc', '-1', '70000', '']) {
      expect(() => parseArgs(['--port', value])).toThrow(/--port/);
    }
  });

  it('rejects a missing project path', () => {
    expect(() => parseArgs(['--project'])).toThrow(/--project/);
  });

  it('rejects an unknown flag rather than ignoring it', () => {
    expect(() => parseArgs(['--dangerous'])).toThrow(/Unknown option/);
  });

  it('combines flags', () => {
    const options = parseArgs(['--read-only', '--no-open', '-p', '8080', '--project', '.']);
    expect(options.readOnly).toBe(true);
    expect(options.open).toBe(false);
    expect(options.port).toBe(8080);
    expect(options.projects).toEqual([resolve('.')]);
  });
});
