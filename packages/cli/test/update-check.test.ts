/**
 * Cover for the one module that is allowed to reach the network.
 *
 * Two things matter more than the happy path here. First, that a check which
 * fails — offline, rate limited, timed out, or answered with nonsense — never
 * throws, because it runs on the startup path of a tool whose actual job is
 * scanning the filesystem. Second, that a hostile response cannot put an
 * arbitrary link or version string in front of the user.
 *
 * Every test injects `fetchImpl`, so the suite itself never opens a socket.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  REPOSITORY_URL,
  checkForUpdates,
  formatUpdateNotice,
  isNewer,
  parseVersion,
  readLatestTag,
} from '../src/update-check.js';

function release(body: unknown, status = 200): typeof fetch {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

describe('parseVersion', () => {
  it('accepts the shapes this project publishes, with or without a v', () => {
    expect(parseVersion('1.2.3')?.release).toEqual([1, 2, 3]);
    expect(parseVersion('v1.2.3')?.release).toEqual([1, 2, 3]);
    expect(parseVersion('1.2.3-rc.1')?.prerelease).toBe('rc.1');
    expect(parseVersion('1.2.3+build.5')?.release).toEqual([1, 2, 3]);
  });

  it('rejects anything it cannot compare rather than guessing', () => {
    for (const value of ['', '1.2', 'latest', 'v1.2.3.4', '1.2.x', 'nightly-2026-01-01']) {
      expect(parseVersion(value)).toBeUndefined();
    }
  });
});

describe('isNewer', () => {
  it('compares each component numerically, not as text', () => {
    // The string comparison this replaces would call 0.9.0 newer than 0.10.0.
    expect(isNewer('0.10.0', '0.9.0')).toBe(true);
    expect(isNewer('0.9.0', '0.10.0')).toBe(false);
    expect(isNewer('1.0.0', '0.99.99')).toBe(true);
  });

  it('treats an equal version as not newer', () => {
    expect(isNewer('1.2.3', '1.2.3')).toBe(false);
    expect(isNewer('v1.2.3', '1.2.3')).toBe(false);
  });

  it('sorts a prerelease below the release it leads to', () => {
    expect(isNewer('1.2.0-rc.1', '1.2.0')).toBe(false);
    expect(isNewer('1.2.0', '1.2.0-rc.1')).toBe(true);
  });

  it('reports "cannot tell" instead of a wrong answer', () => {
    expect(isNewer('latest', '1.0.0')).toBeUndefined();
    expect(isNewer('1.0.0', 'unknown')).toBeUndefined();
  });
});

describe('readLatestTag', () => {
  it('reads a usable tag', () => {
    expect(readLatestTag({ tag_name: 'v2.0.0' })).toBe('v2.0.0');
  });

  it('ignores a payload that is not a release object', () => {
    for (const payload of [undefined, null, 'v1.0.0', 42, []]) {
      expect(readLatestTag(payload)).toBeUndefined();
    }
  });

  it('refuses a tag that is not a version, however plausible it looks', () => {
    expect(readLatestTag({ tag_name: 'latest' })).toBeUndefined();
    expect(readLatestTag({ tag_name: '' })).toBeUndefined();
    expect(readLatestTag({ tag_name: 'v1.0.0 <script>' })).toBeUndefined();
  });

  it('refuses an oversized tag rather than rendering it', () => {
    expect(readLatestTag({ tag_name: `v1.0.0-${'a'.repeat(200)}` })).toBeUndefined();
  });
});

describe('checkForUpdates', () => {
  it('reports an available update and links the release it verified', async () => {
    const result = await checkForUpdates('0.1.0', { fetchImpl: release({ tag_name: 'v0.2.0' }) });
    expect(result).toEqual({
      status: 'outdated',
      currentVersion: '0.1.0',
      latestVersion: '0.2.0',
      releaseUrl: `${REPOSITORY_URL}/releases/tag/v0.2.0`,
    });
  });

  it('builds the release link from the repository constant, not from the response', async () => {
    // A spoofed endpoint must not be able to hand the user an arbitrary URL.
    const result = await checkForUpdates('0.1.0', {
      fetchImpl: release({ tag_name: 'v0.2.0', html_url: 'https://evil.example/pwn' }),
    });
    expect(result.status).toBe('outdated');
    if (result.status !== 'outdated') return;
    expect(result.releaseUrl.startsWith(REPOSITORY_URL)).toBe(true);
    expect(result.releaseUrl).not.toContain('evil.example');
  });

  it('reports being current when the published release matches', async () => {
    const result = await checkForUpdates('1.0.0', { fetchImpl: release({ tag_name: 'v1.0.0' }) });
    expect(result.status).toBe('current');
  });

  it('does not offer a downgrade when the local build is ahead', async () => {
    const result = await checkForUpdates('2.0.0', { fetchImpl: release({ tag_name: 'v1.0.0' }) });
    expect(result.status).toBe('current');
  });

  it('explains a repository with no releases yet', async () => {
    const result = await checkForUpdates('0.1.0', { fetchImpl: release({}, 404) });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.reason).toContain('No releases');
  });

  it('reports a rate limit as a failure rather than as being up to date', async () => {
    const result = await checkForUpdates('0.1.0', { fetchImpl: release({}, 403) });
    expect(result.status).toBe('failed');
  });

  it('survives an unreachable network', async () => {
    const offline = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const result = await checkForUpdates('0.1.0', {
      fetchImpl: offline as unknown as typeof fetch,
    });
    expect(result.status).toBe('failed');
  });

  it('survives a response that is not JSON at all', async () => {
    const garbage = vi
      .fn()
      .mockResolvedValue(new Response('<html>proxy login</html>', { status: 200 }));
    const result = await checkForUpdates('0.1.0', {
      fetchImpl: garbage as unknown as typeof fetch,
    });
    expect(result.status).toBe('failed');
  });

  it('gives up rather than hanging when the endpoint never answers', async () => {
    const hang = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    );
    const result = await checkForUpdates('0.1.0', {
      fetchImpl: hang as unknown as typeof fetch,
      timeoutMs: 10,
    });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.reason).toContain('timed out');
  });

  it('sends no credentials and identifies itself', async () => {
    const spy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ tag_name: 'v0.1.0' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await checkForUpdates('0.1.0', { fetchImpl: spy as unknown as typeof fetch });

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url.startsWith('https://api.github.com/repos/russrimm/ai-harness-helper/')).toBe(true);
    const headers = init.headers as Record<string, string>;
    expect(headers['user-agent']).toContain('ai-harness-helper/');
    expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toContain('authorization');
  });
});

describe('formatUpdateNotice', () => {
  it('says nothing at all when the check never ran', () => {
    expect(formatUpdateNotice({ status: 'disabled' })).toBeUndefined();
  });

  it('names both versions when an update exists', () => {
    const notice = formatUpdateNotice({
      status: 'outdated',
      currentVersion: '0.1.0',
      latestVersion: '0.2.0',
      releaseUrl: `${REPOSITORY_URL}/releases/tag/v0.2.0`,
    });
    expect(notice).toContain('0.1.0');
    expect(notice).toContain('0.2.0');
  });
});
