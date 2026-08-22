/**
 * Cover for the second module that is allowed to reach the network.
 *
 * The happy path matters least here. What these tests exist to hold down is
 * the boundary: that the feature is off unless the command line turned it on,
 * that an endpoint which would leak the payload or the key in plaintext is
 * refused, that what gets assembled is metadata rather than files, and that a
 * hostile reply cannot put an invented file path in front of the user.
 *
 * Every test injects `fetchImpl`, so the suite itself never opens a socket.
 */

import { describe, expect, it, vi } from 'vitest';

import type { CapabilityEntry, InstructionEntry, ReviewIssue } from '@ai-harness-helper/core';

import {
  API_KEY_VAR,
  BASE_URL_VAR,
  MODEL_VAR,
  buildAdvisorPayload,
  extractJsonObject,
  formatAdvisorNotice,
  isLoopbackEndpoint,
  parseRecommendations,
  readMessageContent,
  requestRecommendations,
  resolveAdvisorSetup,
  validateEndpoint,
} from '../src/advisor.js';

const ENV = {
  [BASE_URL_VAR]: 'https://api.example.com/v1',
  [MODEL_VAR]: 'test-model',
  [API_KEY_VAR]: 'secret-key',
};

function capability(overrides: Partial<CapabilityEntry> = {}): CapabilityEntry {
  return {
    kind: 'skill',
    name: 'deploy-helper',
    description: 'Deploys things.',
    fileId: 'file-1',
    filePath: '/home/u/.claude/skills/deploy.md',
    displayPath: '~/.claude/skills/deploy.md',
    directory: '~/.claude/skills',
    fileName: 'deploy.md',
    providerId: 'claude',
    providerName: 'Claude Code',
    locationLabel: 'User skills',
    scope: 'user',
    deletable: true,
    duplicate: { isDuplicate: false, conflict: false, identical: false, otherFileIds: [] },
    ...overrides,
  } as CapabilityEntry;
}

function instruction(overrides: Partial<InstructionEntry> = {}): InstructionEntry {
  return {
    title: 'AGENTS.md',
    bytes: 2048,
    lineCount: 40,
    precedence: 1,
    fileId: 'file-2',
    filePath: '/home/u/project/AGENTS.md',
    displayPath: '~/project/AGENTS.md',
    directory: '~/project',
    fileName: 'AGENTS.md',
    providerId: 'agents',
    providerName: 'AGENTS.md',
    locationLabel: 'Project root',
    scope: 'project',
    deletable: true,
    duplicate: { isDuplicate: false, conflict: false, identical: false, otherFileIds: [] },
    ...overrides,
  } as InstructionEntry;
}

function issue(overrides: Partial<ReviewIssue> = {}): ReviewIssue {
  return {
    id: 'issue-1',
    ruleId: 'capability-missing-description',
    category: 'capability',
    severity: 'error',
    subject: 'deploy-helper',
    title: 'Capability has no description',
    detail: 'detail',
    remediation: 'Add one.',
    fileId: 'file-1',
    displayPath: '~/.claude/skills/deploy.md',
    directory: '~/.claude/skills',
    providerId: 'claude',
    providerName: 'Claude Code',
    scope: 'user',
    ...overrides,
  } as ReviewIssue;
}

function completion(content: string, status = 200): typeof fetch {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

describe('resolveAdvisorSetup', () => {
  it('stays off when the flag was not passed, however complete the environment is', () => {
    // The whole boundary rests on this: an exported variable in a shell
    // profile must not be able to enable egress on its own.
    expect(resolveAdvisorSetup(false, ENV)).toEqual({ status: 'disabled' });
  });

  it('names every missing variable at once rather than one per run', () => {
    const setup = resolveAdvisorSetup(true, {});
    expect(setup).toMatchObject({ status: 'incomplete' });
    if (setup.status !== 'incomplete') throw new Error('expected incomplete');
    expect(setup.missing).toEqual([BASE_URL_VAR, MODEL_VAR]);
  });

  it('treats an API key as optional, because a local model needs none', () => {
    const setup = resolveAdvisorSetup(true, {
      [BASE_URL_VAR]: 'http://localhost:11434/v1',
      [MODEL_VAR]: 'llama3.1',
    });
    expect(setup).toMatchObject({ status: 'ready' });
    if (setup.status !== 'ready') throw new Error('expected ready');
    expect(setup.config.apiKey).toBeUndefined();
  });

  it('ignores surrounding whitespace, which a copied key usually carries', () => {
    const setup = resolveAdvisorSetup(true, {
      [BASE_URL_VAR]: '  https://api.example.com/v1  ',
      [MODEL_VAR]: ' m ',
      [API_KEY_VAR]: ' k ',
    });
    if (setup.status !== 'ready') throw new Error('expected ready');
    expect(setup.config).toEqual({
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
      apiKey: 'k',
    });
  });

  it('treats a blank key as absent rather than sending an empty bearer token', () => {
    const setup = resolveAdvisorSetup(true, { ...ENV, [API_KEY_VAR]: '   ' });
    if (setup.status !== 'ready') throw new Error('expected ready');
    expect(setup.config.apiKey).toBeUndefined();
  });
});

describe('validateEndpoint', () => {
  it('accepts https anywhere', () => {
    expect(validateEndpoint('https://api.example.com/v1')).toBeUndefined();
  });

  it('accepts plaintext http only for loopback, where it never hits a network', () => {
    expect(validateEndpoint('http://localhost:11434/v1')).toBeUndefined();
    expect(validateEndpoint('http://127.0.0.1:1234/v1')).toBeUndefined();
  });

  it('refuses plaintext http to a remote host, which would leak the payload and key', () => {
    const reason = validateEndpoint('http://api.example.com/v1');
    expect(reason).toContain('plaintext');
    expect(reason).toContain('api.example.com');
  });

  it('refuses a scheme that is not http at all', () => {
    expect(validateEndpoint('file:///etc/passwd')).toContain('http or https');
    expect(validateEndpoint('not a url')).toContain('not a valid URL');
  });

  it('recognises a loopback endpoint so the UI can say nothing leaves the machine', () => {
    expect(isLoopbackEndpoint('http://localhost:11434/v1')).toBe(true);
    expect(isLoopbackEndpoint('https://api.example.com/v1')).toBe(false);
    expect(isLoopbackEndpoint('nonsense')).toBe(false);
  });
});

describe('buildAdvisorPayload', () => {
  it('sends metadata and a short excerpt, never the whole document', () => {
    const body = 'x'.repeat(5000);
    const payload = buildAdvisorPayload({
      capabilities: [capability()],
      instructions: [],
      issues: [],
      loadExcerpt: () => body,
    });

    const [subject] = payload.subjects;
    expect(subject?.excerpt).toBeDefined();
    expect(subject?.excerpt?.length).toBeLessThan(body.length);
    expect(JSON.stringify(payload)).not.toContain(body);
  });

  it('redacts a secret that a document body happens to contain', () => {
    const payload = buildAdvisorPayload({
      capabilities: [capability()],
      instructions: [],
      issues: [],
      loadExcerpt: () => 'api_key: ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    });
    expect(JSON.stringify(payload)).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('never sends an absolute filesystem path, which names the user', () => {
    const payload = buildAdvisorPayload({
      capabilities: [capability()],
      instructions: [instruction()],
      issues: [issue()],
    });
    const encoded = JSON.stringify(payload);
    expect(encoded).not.toContain('/home/u/');
  });

  it('passes the deterministic findings along so the model does not repeat them', () => {
    const payload = buildAdvisorPayload({
      capabilities: [capability()],
      instructions: [],
      issues: [issue()],
    });
    expect(payload.knownIssues).toEqual([
      {
        subject: 'deploy-helper',
        ruleId: 'capability-missing-description',
        severity: 'error',
        title: 'Capability has no description',
      },
    ]);
  });

  it('caps a large harness and says so, rather than sending everything', () => {
    const many = Array.from({ length: 200 }, (_, index) =>
      capability({ name: `skill-${index}`, fileId: `file-${index}` }),
    );
    const payload = buildAdvisorPayload({ capabilities: many, instructions: [], issues: [] });
    expect(payload.subjects.length).toBeLessThan(many.length);
    expect(payload.truncated).toBe(true);
  });

  it('trims by measured bytes, because one long description can outweigh twenty short ones', () => {
    const fat = Array.from({ length: 40 }, (_, index) =>
      capability({
        name: `skill-${index}`,
        fileId: `file-${index}`,
        description: 'y'.repeat(500),
      }),
    );
    const payload = buildAdvisorPayload({
      capabilities: fat,
      instructions: [],
      issues: [],
      loadExcerpt: () => 'z'.repeat(400),
    });
    expect(Buffer.byteLength(JSON.stringify(payload), 'utf8')).toBeLessThanOrEqual(64 * 1024);
  });

  it('omits an excerpt entirely when the document could not be read', () => {
    const payload = buildAdvisorPayload({
      capabilities: [capability()],
      instructions: [],
      issues: [],
      loadExcerpt: () => undefined,
    });
    expect(payload.subjects[0]?.excerpt).toBeUndefined();
  });
});

describe('readMessageContent', () => {
  it('reads the one field that matters', () => {
    expect(readMessageContent(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }))).toBe(
      'hi',
    );
  });

  it('rejects anything shaped differently instead of probing further', () => {
    for (const raw of [
      'not json',
      '{}',
      JSON.stringify({ choices: [] }),
      JSON.stringify({ choices: [{}] }),
      JSON.stringify({ choices: [{ message: {} }] }),
      JSON.stringify({ choices: [{ message: { content: 42 } }] }),
    ]) {
      expect(readMessageContent(raw)).toBeUndefined();
    }
  });
});

describe('extractJsonObject', () => {
  it('reads a bare object', () => {
    expect(extractJsonObject('{"recommendations":[]}')).toEqual({ recommendations: [] });
  });

  it('reads one wrapped in a fence, which models produce constantly', () => {
    expect(extractJsonObject('```json\n{"recommendations":[]}\n```')).toEqual({
      recommendations: [],
    });
  });

  it('reads one buried in prose rather than failing the whole pass', () => {
    expect(
      extractJsonObject('Sure! Here you go:\n{"recommendations":[]}\nHope that helps.'),
    ).toEqual({ recommendations: [] });
  });

  it('gives up on something that is not an object at all', () => {
    expect(extractJsonObject('no braces here')).toBeUndefined();
  });
});

describe('parseRecommendations', () => {
  const index = new Map([
    ['deploy-helper', { fileId: 'file-1', displayPath: '~/.claude/skills/deploy.md' }],
  ]);

  function reply(recommendations: unknown): string {
    return JSON.stringify({ recommendations });
  }

  it('attaches provenance from the local index, not from the reply', () => {
    const parsed = parseRecommendations(
      reply([
        {
          subject: 'deploy-helper',
          severity: 'warning',
          title: 'Description is vague',
          detail: 'It does not say when to use this.',
          remediation: 'Name the trigger conditions.',
          // A reply claiming its own path must not be believed.
          fileId: 'file-999',
          displayPath: '/etc/shadow',
        },
      ]),
      index,
    );

    expect(parsed?.[0]?.fileId).toBe('file-1');
    expect(parsed?.[0]?.displayPath).toBe('~/.claude/skills/deploy.md');
  });

  it('leaves a subject it never sent unlinked rather than inventing a file', () => {
    const parsed = parseRecommendations(
      reply([
        {
          subject: 'a-skill-that-does-not-exist',
          title: 'Something',
          remediation: 'Do something.',
        },
      ]),
      index,
    );
    expect(parsed?.[0]?.fileId).toBeUndefined();
    expect(parsed?.[0]?.displayPath).toBeUndefined();
  });

  it('drops an entry with no fix, which is the noise the rules already refuse to emit', () => {
    const parsed = parseRecommendations(
      reply([
        { subject: 'deploy-helper', title: 'Vague', remediation: '' },
        { subject: '', title: 'Vague', remediation: 'Fix it.' },
        { subject: 'deploy-helper', title: '', remediation: 'Fix it.' },
      ]),
      index,
    );
    expect(parsed).toEqual([]);
  });

  it('falls back to info for a severity it does not recognise', () => {
    const parsed = parseRecommendations(
      reply([{ subject: 'deploy-helper', severity: 'catastrophic', title: 'T', remediation: 'R' }]),
      index,
    );
    expect(parsed?.[0]?.severity).toBe('info');
  });

  it('caps a flood of suggestions', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({
      subject: 'deploy-helper',
      title: `T${i}`,
      remediation: 'R',
    }));
    expect(parseRecommendations(reply(many), index)?.length).toBeLessThanOrEqual(40);
  });

  it('truncates an over-long field instead of rendering it', () => {
    const parsed = parseRecommendations(
      reply([
        { subject: 'deploy-helper', title: 'T', remediation: 'R', detail: 'd'.repeat(50_000) },
      ]),
      index,
    );
    expect(parsed?.[0]?.detail.length).toBeLessThan(2000);
  });

  it('distinguishes "nothing to add" from "not the requested shape"', () => {
    expect(parseRecommendations(reply([]), index)).toEqual([]);
    expect(parseRecommendations('{"something":"else"}', index)).toBeUndefined();
    expect(parseRecommendations('prose only', index)).toBeUndefined();
  });
});

describe('requestRecommendations', () => {
  const config = { baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: 'k' };
  const payload = { subjects: [], knownIssues: [], truncated: false };
  const index = new Map<string, { fileId: string; displayPath: string }>();

  it('posts to the chat-completions route under the configured base', async () => {
    const fetchImpl = completion('{"recommendations":[]}');
    await requestRecommendations(config, payload, index, { fetchImpl });

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    expect(init.method).toBe('POST');
  });

  it('does not double the slash when the base URL has a trailing one', async () => {
    const fetchImpl = completion('{"recommendations":[]}');
    await requestRecommendations(
      { ...config, baseUrl: 'https://api.example.com/v1/' },
      payload,
      index,
      {
        fetchImpl,
      },
    );
    const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe('https://api.example.com/v1/chat/completions');
  });

  it('sends the key as a bearer header and never in the body', async () => {
    const fetchImpl = completion('{"recommendations":[]}');
    const distinctive = 'sk-do-not-put-me-in-a-body-9f3a';
    await requestRecommendations({ ...config, apiKey: distinctive }, payload, index, { fetchImpl });

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect((init.headers as Record<string, string>)['authorization']).toBe(`Bearer ${distinctive}`);
    expect(String(init.body)).not.toContain(distinctive);
  });

  it('omits the authorization header entirely when there is no key', async () => {
    const fetchImpl = completion('{"recommendations":[]}');
    await requestRecommendations({ baseUrl: config.baseUrl, model: 'm' }, payload, index, {
      fetchImpl,
    });
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect((init.headers as Record<string, string>)['authorization']).toBeUndefined();
  });

  it('explains an auth failure in terms of the variable to fix', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
    const run = await requestRecommendations(config, payload, index, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(run).toMatchObject({ status: 'failed' });
    if (run.status !== 'failed') throw new Error('expected failed');
    expect(run.reason).toContain(API_KEY_VAR);
  });

  it('explains a 404 as a base-URL problem, which is what it almost always is', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 404 }));
    const run = await requestRecommendations(config, payload, index, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    if (run.status !== 'failed') throw new Error('expected failed');
    expect(run.reason).toContain(BASE_URL_VAR);
  });

  it('never throws when the endpoint is unreachable', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    await expect(
      requestRecommendations(config, payload, index, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toMatchObject({ status: 'failed' });
  });

  it('reports a timeout as its own thing, so the advice is "try again" not "check the URL"', async () => {
    const fetchImpl = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    });

    const run = await requestRecommendations(config, payload, index, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 10,
    });
    if (run.status !== 'failed') throw new Error('expected failed');
    expect(run.reason).toContain('in time');
  });

  it('rejects a reply that is not the requested shape rather than rendering prose', async () => {
    const run = await requestRecommendations(config, payload, index, {
      fetchImpl: completion('I would rather not.'),
    });
    expect(run).toMatchObject({ status: 'failed' });
  });

  it('returns recommendations on the happy path', async () => {
    const run = await requestRecommendations(
      config,
      payload,
      new Map([['deploy-helper', { fileId: 'file-1', displayPath: '~/skills/deploy.md' }]]),
      {
        fetchImpl: completion(
          '{"recommendations":[{"subject":"deploy-helper","severity":"warning","title":"Vague","detail":"d","remediation":"r"}]}',
        ),
      },
    );

    expect(run).toMatchObject({ status: 'ok', model: 'm' });
    if (run.status !== 'ok') throw new Error('expected ok');
    expect(run.recommendations).toHaveLength(1);
    expect(run.recommendations[0]?.fileId).toBe('file-1');
  });
});

describe('formatAdvisorNotice', () => {
  it('says nothing at all when the feature is off', () => {
    expect(formatAdvisorNotice({ status: 'disabled' })).toBeUndefined();
  });

  it('shows a runnable example when the endpoint is not configured', () => {
    const notice = formatAdvisorNotice({ status: 'incomplete', missing: [BASE_URL_VAR] });
    expect(notice).toContain(BASE_URL_VAR);
    expect(notice).toContain('localhost');
  });

  it('counts what came back', () => {
    expect(
      formatAdvisorNotice({
        status: 'ok',
        model: 'm',
        endpoint: 'e',
        truncated: false,
        recommendations: [
          {
            id: 'a',
            subject: 's',
            severity: 'info',
            title: 't',
            detail: 'd',
            remediation: 'r',
          },
        ],
      }),
    ).toContain('1 model recommendation');
  });
});
