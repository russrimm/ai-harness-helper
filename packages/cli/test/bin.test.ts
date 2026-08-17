import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { ReviewIssue } from '@ai-harness-helper/core';

import { formatReview, parseArgs } from '../src/bin.js';

describe('parseArgs', () => {
  it('defaults to opening a browser with editing enabled', () => {
    const options = parseArgs([]);
    expect(options).toEqual({
      port: undefined,
      open: true,
      readOnly: false,
      projects: [],
      projectsOnly: false,
      help: false,
      version: false,
      report: undefined,
      review: false,
      failOn: undefined,
    });
  });

  it('parses flags in long and short form', () => {
    expect(parseArgs(['--port', '9000']).port).toBe(9000);
    expect(parseArgs(['--port=9001']).port).toBe(9001);
    expect(parseArgs(['-p', '9000']).port).toBe(9000);
    expect(parseArgs(['--no-open']).open).toBe(false);
    expect(parseArgs(['--read-only']).readOnly).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-v']).version).toBe(true);
  });

  it('accepts repeated project roots and resolves them to absolute paths', () => {
    const options = parseArgs(['--project', 'a', '--project=b']);
    expect(options.projects).toEqual([resolve('a'), resolve('b')]);
  });

  it('enables project-only scanning when a project root is present', () => {
    const options = parseArgs(['--projects-only', '--project', 'repo']);
    expect(options.projectsOnly).toBe(true);
    expect(options.projects).toEqual([resolve('repo')]);
  });

  it('requires a project root for project-only scanning', () => {
    expect(() => parseArgs(['--projects-only'])).toThrow(
      '--projects-only requires at least one --project <path>.',
    );
  });

  it('does not treat a project path as a flag', () => {
    expect(parseArgs(['--project', 'repo', '--read-only']).projects).toEqual([resolve('repo')]);
  });

  it('rejects a port that is not a valid number', () => {
    for (const value of ['abc', '-1', '1.5', '9000oops', '70000', '']) {
      expect(() => parseArgs(['--port', value])).toThrow(/--port/);
    }
  });

  it('rejects a missing project path', () => {
    expect(() => parseArgs(['--project'])).toThrow(/--project/);
    expect(() => parseArgs(['--project', '--read-only'])).toThrow(/--project/);
  });

  it('rejects an unknown flag rather than ignoring it', () => {
    expect(() => parseArgs(['--dangerous'])).toThrow(/Unknown option.*--help/);
  });

  it('rejects positional arguments with a project hint', () => {
    expect(() => parseArgs(['my-project'])).toThrow(
      'Unexpected argument "my-project". Use --project <path> to scan a folder.',
    );
  });

  it('combines flags', () => {
    const options = parseArgs(['--read-only', '--no-open', '-p', '8080', '--project', '.']);
    expect(options.readOnly).toBe(true);
    expect(options.open).toBe(false);
    expect(options.port).toBe(8080);
    expect(options.projects).toEqual([resolve('.')]);
  });
});

describe('parseArgs - headless reporting', () => {
  it('treats --json as a request for a JSON report', () => {
    expect(parseArgs(['--json']).report).toBe('json');
  });

  it('parses --report in both spaced and equals form', () => {
    expect(parseArgs(['--report', 'json']).report).toBe('json');
    expect(parseArgs(['--report=markdown']).report).toBe('markdown');
    expect(parseArgs(['--report', 'md']).report).toBe('markdown');
  });

  it('rejects a report format it cannot produce', () => {
    expect(() => parseArgs(['--report', 'yaml'])).toThrow(/--report/);
    expect(() => parseArgs(['--report'])).toThrow(/--report/);
    expect(() => parseArgs(['--report='])).toThrow(/--report/);
  });

  it('parses --fail-on in both spaced and equals form', () => {
    expect(parseArgs(['--fail-on', 'warning']).failOn).toBe('warning');
    expect(parseArgs(['--fail-on=info']).failOn).toBe('info');
  });

  it('rejects a severity that is not a real level', () => {
    expect(() => parseArgs(['--fail-on', 'critical'])).toThrow(/--fail-on/);
    expect(() => parseArgs(['--fail-on'])).toThrow(/--fail-on/);
  });

  it('defaults --check to failing on errors only', () => {
    expect(parseArgs(['--check']).failOn).toBe('error');
  });

  it('lets an explicit --fail-on win over the --check default', () => {
    expect(parseArgs(['--fail-on', 'warning', '--check']).failOn).toBe('warning');
    expect(parseArgs(['--fail-on=warning', '--check']).failOn).toBe('warning');
  });

  it('never opens a browser when the output is going to stdout', () => {
    // stdout is the report, so a browser would only be noise.
    for (const args of [
      ['--json'],
      ['--report=markdown'],
      ['--check'],
      ['--fail-on', 'info'],
      ['--review'],
    ]) {
      expect(parseArgs(args).open).toBe(false);
    }
  });

  it('treats --review as a headless request for the quality review', () => {
    expect(parseArgs(['--review']).review).toBe(true);
    expect(parseArgs(['--review']).report).toBeUndefined();
  });

  it('still serves the UI when no headless flag is present', () => {
    expect(parseArgs(['--read-only']).open).toBe(true);
  });
});

describe('formatReview', () => {
  it('leads with the score and groups issues under the file they belong to', () => {
    const text = formatReview({
      generatedAt: '2026-08-16T00:00:00.000Z',
      rules: [],
      summary: {
        issueCount: 2,
        errorCount: 1,
        warningCount: 1,
        infoCount: 0,
        affectedFileCount: 1,
        reviewedSubjectCount: 5,
        ruleCount: 23,
        score: 92,
        grade: 'A',
        byCategory: { capability: 2, instruction: 0, mcp: 0, guardrail: 0, freshness: 0 },
      },
      issues: [
        issue('capability-missing-description', 'error', 'reviewer has no description'),
        issue('capability-empty-body', 'warning', 'reviewer gives no instructions'),
      ],
    });

    expect(text).toContain('92/100 (A)');
    expect(text).toContain('~/.claude/agents/reviewer.md');
    // One heading per file, however many issues that file produced.
    expect(text.split('~/.claude/agents/reviewer.md').length - 1).toBe(1);
    expect(text).toContain('Fix: Do the thing.');
  });

  it('says so plainly when nothing fired', () => {
    const text = formatReview({
      generatedAt: '2026-08-16T00:00:00.000Z',
      rules: [],
      issues: [],
      summary: {
        issueCount: 0,
        errorCount: 0,
        warningCount: 0,
        infoCount: 0,
        affectedFileCount: 0,
        reviewedSubjectCount: 5,
        ruleCount: 23,
        score: 100,
        grade: 'A',
        byCategory: { capability: 0, instruction: 0, mcp: 0, guardrail: 0, freshness: 0 },
      },
    });

    expect(text).toContain('Nothing to fix.');
  });
});

function issue(
  ruleId: ReviewIssue['ruleId'],
  severity: ReviewIssue['severity'],
  title: string,
): ReviewIssue {
  return {
    id: `${ruleId}:file`,
    ruleId,
    category: 'capability',
    severity,
    subject: 'reviewer',
    title,
    detail: 'Detail text.',
    remediation: 'Do the thing.',
    fileId: 'file',
    displayPath: '~/.claude/agents/reviewer.md',
    directory: '~/.claude/agents',
    providerId: 'claude-code',
    providerName: 'Claude Code',
    scope: 'user',
  };
}
