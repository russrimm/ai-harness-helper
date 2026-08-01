/**
 * Thin fetch wrapper around the CLI's localhost API.
 *
 * The server mints a one-time token and puts it in the page URL. It must be
 * read once, sent as a header on every request, and then stripped from the
 * visible address bar so it never ends up in browser history or a screenshot.
 */

import type {
  FileDocument,
  HarnessInventory,
  HealthResponse,
  OverviewResponse,
  ProjectsResponse,
  ScanResponse,
  SearchResponse,
  WriteOutcome,
} from './types.js';

let token = '';

/**
 * Where the token lives between reloads.
 *
 * `sessionStorage` is scoped to this origin and this tab, and is cleared when
 * the tab closes. This limits browser-side exposure and DNS rebinding is
 * blocked by the Host and Origin checks; it is not a boundary against a
 * malicious process running as the same OS user. Keeping the token only in
 * memory meant pressing F5 left the app permanently unusable with no way back
 * short of re-copying the URL from the terminal.
 */
const TOKEN_KEY = 'ai-harness-helper.token';

function rememberToken(value: string): void {
  token = value;
  try {
    window.sessionStorage.setItem(TOKEN_KEY, value);
  } catch {
    // Private modes and storage-disabled setups still work for this tab.
  }
}

/** Reads `?token=` from the current URL once, then scrubs it from the bar. */
export function initAuthToken(): void {
  const url = new URL(window.location.href);
  const found = url.searchParams.get('token');

  if (!found) {
    try {
      token = window.sessionStorage.getItem(TOKEN_KEY) ?? '';
    } catch {
      token = '';
    }
    return;
  }

  rememberToken(found);
  url.searchParams.delete('token');
  const query = url.searchParams.toString();
  const next = `${url.pathname}${query ? `?${query}` : ''}${url.hash}`;
  window.history.replaceState(null, '', next);
}

/** Raised for any non-2xx response outside the write-file endpoint, which has its own outcome shape. */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      'x-harness-token': token,
    },
  });

  const body = await readJson(response);
  if (!response.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
        ? body.error
        : `Request to ${path} failed with status ${response.status}.`;
    throw new ApiError(message, response.status);
  }
  return body as T;
}

export function getHealth(): Promise<HealthResponse> {
  return request('/api/health');
}

export function getOverview(): Promise<OverviewResponse> {
  return request('/api/overview');
}

export function getScan(): Promise<ScanResponse> {
  return request('/api/scan');
}

export function postScan(): Promise<ScanResponse> {
  return request('/api/scan', { method: 'POST' });
}

export function getInventory(): Promise<HarnessInventory> {
  return request('/api/inventory');
}

export function getFile(id: string, reveal = false): Promise<FileDocument> {
  const query = reveal ? '?reveal=true' : '';
  return request(`/api/files/${encodeURIComponent(id)}${query}`);
}

export function revealFileValue(id: string, redactionId: string): Promise<{ value: string }> {
  return request(`/api/files/${encodeURIComponent(id)}/reveal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redactionId }),
  });
}

/**
 * Writes a file. Unlike other endpoints this returns its failure shape
 * (`WriteOutcome` with `ok: false`) instead of throwing, because a refusal
 * such as `hash-mismatch` is an expected outcome the caller must present to
 * the user, not a transport error.
 */
export async function putFile(
  id: string,
  content: string,
  expectedHash: string,
): Promise<WriteOutcome> {
  const response = await fetch(`/api/files/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      'x-harness-token': token,
    },
    body: JSON.stringify({ content, expectedHash }),
  });
  const body = await readJson(response);
  return body as WriteOutcome;
}

export function getProjects(): Promise<ProjectsResponse> {
  return request('/api/projects');
}

export function addProject(path: string): Promise<ProjectsResponse> {
  return request('/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  });
}

export function removeProject(path: string): Promise<ProjectsResponse> {
  return request('/api/projects', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  });
}

export interface SearchParams {
  q: string;
  provider?: string[];
  kind?: string[];
  scope?: string[];
}

export function search(params: SearchParams): Promise<SearchResponse> {
  const query = new URLSearchParams();
  query.set('q', params.q);
  if (params.provider?.length) query.set('provider', params.provider.join(','));
  if (params.kind?.length) query.set('kind', params.kind.join(','));
  if (params.scope?.length) query.set('scope', params.scope.join(','));
  return request(`/api/search?${query.toString()}`);
}

/** Downloads an export. Fetched (rather than linked) so the auth header can be attached. */
export async function fetchExport(
  format: 'json' | 'markdown',
): Promise<{ text: string; contentType: string }> {
  const response = await fetch(`/api/export?format=${format}`, {
    headers: { 'x-harness-token': token },
  });
  if (!response.ok) {
    throw new ApiError(`Export failed with status ${response.status}.`, response.status);
  }
  const text = await response.text();
  return { text, contentType: response.headers.get('content-type') ?? 'text/plain' };
}
