/**
 * Thin fetch wrapper around the CLI's localhost API.
 *
 * The server mints a one-time token and puts it in the page URL. It must be
 * read once, sent as a header on every request, and then stripped from the
 * visible address bar so it never ends up in browser history or a screenshot.
 */

import type {
  CapabilityDocument,
  CapabilityEdit,
  CapabilityListResponse,
  DeleteOutcome,
  EffectiveConfig,
  FileDocument,
  HarnessInventory,
  HealthResponse,
  McpRemovalOutcome,
  OverviewResponse,
  ProjectsResponse,
  ScanResponse,
  SearchResponse,
  SourcesResponse,
  WriteOutcome,
} from './types.js';

let token = '';

/**
 * Where the token lives between reloads.
 *
 * `sessionStorage` is scoped to this origin and this tab, and is cleared when
 * the tab closes — so it is no more reachable than the in-memory copy is to
 * the two attackers the token exists to stop: another local process (which
 * cannot read another origin's storage) and DNS rebinding (blocked earlier by
 * the Host and Origin checks). Keeping it only in memory meant pressing F5
 * left the app permanently unusable with no way back short of re-copying the
 * URL from the terminal.
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

/**
 * Raised when the request never reached the server at all.
 *
 * This is the *expected* end state for this app rather than an exotic one: the
 * UI is served by a CLI the user eventually stops, and because routing is
 * hash-based a stale tab keeps rendering happily until some view fetches. It
 * is kept distinct from `ApiError` because the two need opposite advice —
 * an HTTP failure may be worth retrying, a missing server never is.
 */
export class NetworkError extends Error {
  constructor(cause?: unknown) {
    super('The local server did not respond.');
    this.name = 'NetworkError';
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Normalises the rejection produced when a connection cannot be made.
 *
 * Both `fetch` and dynamic `import()` reject with a `TypeError` in that case
 * — the browser strings are "Failed to fetch" and "Failed to fetch
 * dynamically imported module". Anything else (an abort, a real programming
 * error) is passed through untouched so it is not mislabelled as an outage.
 */
export function asTransportError(caught: unknown): unknown {
  return caught instanceof TypeError ? new NetworkError(caught) : caught;
}

/**
 * `fetch` rejects with a bare `TypeError` whose message is the browser's own
 * "Failed to fetch" when a connection cannot be made. Translating it at the
 * single point where it can occur means no caller has to recognise that
 * string, and the user never sees it.
 */
async function fetchOrThrow(input: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (caught) {
    throw asTransportError(caught);
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
  const response = await fetchOrThrow(path, {
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

export function getEffective(): Promise<EffectiveConfig> {
  return request('/api/effective');
}

export function getSources(): Promise<SourcesResponse> {
  return request('/api/sources');
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
 * the user, not a transport error. A genuinely unreachable server still
 * throws `NetworkError`, since no outcome was ever decided.
 */
export async function putFile(
  id: string,
  content: string,
  expectedHash: string,
): Promise<WriteOutcome> {
  const response = await fetchOrThrow(`/api/files/${encodeURIComponent(id)}`, {
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

/** Lists every agent, skill, prompt, command, and chat mode found on this machine. */
export function getCapabilities(): Promise<CapabilityListResponse> {
  return request('/api/capabilities');
}

/**
 * Loads one capability as structured fields plus a body.
 *
 * `reveal` follows the same contract as {@link getFile}: the form is populated
 * from a masked copy for reading, and only entering edit mode asks for the
 * real text — saving a masked body would write the mask into the user's own
 * instructions.
 */
export function getCapability(id: string, reveal = false): Promise<CapabilityDocument> {
  const query = reveal ? '?reveal=true' : '';
  return request(`/api/capabilities/${encodeURIComponent(id)}${query}`);
}

/**
 * Applies a structured edit. Like {@link putFile} this returns its refusal
 * shape rather than throwing, because a stale-hash conflict is an outcome the
 * user has to be shown, not a transport failure.
 */
export async function putCapability(
  id: string,
  edit: CapabilityEdit,
  expectedHash: string,
): Promise<WriteOutcome> {
  const response = await fetchOrThrow(`/api/capabilities/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      'x-harness-token': token,
    },
    body: JSON.stringify({ ...edit, expectedHash }),
  });
  const body = await readJson(response);
  return body as WriteOutcome;
}

export function getProjects(): Promise<ProjectsResponse> {
  return request('/api/projects');
}

/**
 * Deletes one MCP server declaration from one file.
 *
 * Mirrors {@link putFile} in returning its refusal shape rather than throwing:
 * "that server is not in this file any more" and "this session is read-only"
 * are answers the user needs to read, not transport failures.
 */
export async function deleteMcpServer(
  fileId: string,
  serverName: string,
): Promise<McpRemovalOutcome> {
  const response = await fetchOrThrow(
    `/api/files/${encodeURIComponent(fileId)}/mcp/${encodeURIComponent(serverName)}`,
    { method: 'DELETE', headers: { 'x-harness-token': token } },
  );
  const body = await readJson(response);
  if (body && typeof body === 'object' && 'ok' in body) return body as McpRemovalOutcome;
  const message =
    body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
      ? body.error
      : `Removing "${serverName}" failed with status ${response.status}.`;
  return { ok: false, code: 'write-failed', message };
}

/**
 * Deletes a whole discovered file.
 *
 * Follows {@link deleteMcpServer} in returning its refusal shape rather than
 * throwing: "this file holds more than that entry" and "it changed on disk"
 * are answers the user has to read before deciding what to do next.
 */
export async function deleteFile(fileId: string, expectedHash?: string): Promise<DeleteOutcome> {
  const response = await fetchOrThrow(`/api/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', 'x-harness-token': token },
    body: JSON.stringify(expectedHash === undefined ? {} : { expectedHash }),
  });
  const body = await readJson(response);
  if (body && typeof body === 'object' && 'ok' in body) return body as DeleteOutcome;
  const message =
    body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
      ? body.error
      : `Deleting the file failed with status ${response.status}.`;
  return { ok: false, code: 'write-failed', message };
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
  const response = await fetchOrThrow(`/api/export?format=${format}`, {
    headers: { 'x-harness-token': token },
  });
  if (!response.ok) {
    throw new ApiError(`Export failed with status ${response.status}.`, response.status);
  }
  const text = await response.text();
  return { text, contentType: response.headers.get('content-type') ?? 'text/plain' };
}
