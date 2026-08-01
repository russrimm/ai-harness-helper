/**
 * Regression cover for a tab left open after the CLI exits.
 *
 * Hash routing means the shell keeps rendering long after the server is gone,
 * so the first symptom a user sees is a view failing to load. Before this was
 * handled the UI showed the browser's raw "Failed to fetch" beside a retry
 * button that could never succeed.
 *
 * These are logic-level tests: the repo has no DOM test environment yet, so
 * the rendered output was verified by hand against a stopped server.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ApiError,
  NetworkError,
  asTransportError,
  fetchExport,
  getInventory,
  putFile,
} from '../src/api/client.js';
import { ViewErrorBoundary } from '../src/components/ViewErrorBoundary.js';
import { describeError, isRetryable } from '../src/hooks/useAsync.js';

/** What a browser actually throws when nothing is listening on the port. */
function connectionRefused(): TypeError {
  return new TypeError('Failed to fetch');
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('client translates transport failures', () => {
  it('turns a refused connection into a NetworkError', async () => {
    fetchMock.mockRejectedValue(connectionRefused());
    await expect(getInventory()).rejects.toBeInstanceOf(NetworkError);
  });

  it('translates the export endpoint too', async () => {
    fetchMock.mockRejectedValue(connectionRefused());
    await expect(fetchExport('json')).rejects.toBeInstanceOf(NetworkError);
  });

  it('translates writes, which otherwise report failure by return value', async () => {
    fetchMock.mockRejectedValue(connectionRefused());
    await expect(putFile('id', 'content', 'hash')).rejects.toBeInstanceOf(NetworkError);
  });

  it('keeps the original error when a request was deliberately aborted', async () => {
    const aborted = new Error('The user aborted a request.');
    aborted.name = 'AbortError';
    fetchMock.mockRejectedValue(aborted);
    await expect(getInventory()).rejects.toBe(aborted);
  });

  it('still reports HTTP failures as ApiError, which carry a status', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { error: 'Boom.' }));
    await expect(getInventory()).rejects.toBeInstanceOf(ApiError);
  });

  it('preserves the original failure as the cause', async () => {
    const refused = connectionRefused();
    fetchMock.mockRejectedValue(refused);
    await expect(getInventory()).rejects.toMatchObject({ cause: refused });
  });
});

describe('asTransportError', () => {
  it('recognises a failed dynamic import, which is how lazy views would fail', () => {
    const failure = new TypeError(
      'Failed to fetch dynamically imported module: http://127.0.0.1:7820/assets/view.js',
    );
    expect(asTransportError(failure)).toBeInstanceOf(NetworkError);
  });

  it('leaves a genuine defect alone rather than blaming the network', () => {
    const bug = new ReferenceError('thing is not defined');
    expect(asTransportError(bug)).toBe(bug);
  });
});

describe('describeError', () => {
  it('explains a stopped server instead of echoing the browser string', () => {
    const message = describeError(new NetworkError(connectionRefused()));
    expect(message).not.toContain('Failed to fetch');
    expect(message).toContain('no longer running');
    expect(message).toContain('token changes every run');
  });

  it('keeps explaining a stale token separately', () => {
    expect(describeError(new ApiError('Missing or invalid token.', 401))).toContain(
      'not authorized',
    );
  });

  it('passes other messages through unchanged', () => {
    expect(describeError(new ApiError('Boom.', 500))).toBe('Boom.');
  });
});

describe('isRetryable', () => {
  it('refuses to offer a retry that cannot work', () => {
    expect(isRetryable(new NetworkError())).toBe(false);
    expect(isRetryable(new ApiError('Missing or invalid token.', 401))).toBe(false);
  });

  it('allows a retry for failures that may be transient', () => {
    expect(isRetryable(new ApiError('Boom.', 500))).toBe(true);
    expect(isRetryable(new Error('anything else'))).toBe(true);
  });
});

describe('ViewErrorBoundary', () => {
  it('normalises a transport failure thrown during render', () => {
    const { error } = ViewErrorBoundary.getDerivedStateFromError(connectionRefused());
    expect(error).toBeInstanceOf(NetworkError);
    expect(describeError(error)).toContain('no longer running');
    expect(isRetryable(error)).toBe(false);
  });

  it('keeps an ordinary render failure intact so it stays retryable', () => {
    const bug = new Error('Something in the view is broken.');
    const { error } = ViewErrorBoundary.getDerivedStateFromError(bug);
    expect(error).toBe(bug);
    expect(describeError(error)).toBe('Something in the view is broken.');
    expect(isRetryable(error)).toBe(true);
  });
});
