/**
 * Localhost HTTP surface.
 *
 * This process can read every credential-adjacent file on the machine, so the
 * server is treated as a privileged endpoint rather than a convenience:
 *
 * - it binds the loopback interface only;
 * - every request must carry a token minted for this run;
 * - `Origin` and `Host` are validated, so a web page the user happens to have
 *   open cannot drive the API through the browser or via DNS rebinding;
 * - file access is allowlisted to paths the scanner actually found.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import {
  InvalidProjectRootError,
  MAX_DOCUMENT_BYTES,
  type HarnessService,
} from '@ai-harness-helper/core';

export interface ServerOptions {
  readonly service: HarnessService;
  /** Directory holding the built web bundle. Omit to run API-only. */
  readonly publicDir?: string;
  /** Overrides the generated token. Tests use this for determinism. */
  readonly token?: string;
  /** Host the browser will use, for Host-header validation. */
  readonly host?: string;
}

export interface HarnessServer {
  readonly app: FastifyInstance;
  readonly token: string;
}

/** 32 bytes of entropy, url-safe so it survives a query string. */
export function createToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Compares tokens without leaking their contents through timing. */
function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Hosts a browser may legitimately present for a loopback server. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const MAX_REQUEST_OVERHEAD_BYTES = 64 * 1024;
/** A one-byte control character can expand to six ASCII bytes as `\u00XX`. */
const MAX_JSON_STRING_EXPANSION = 6;
const MAX_IDENTIFIER_CHARS = 256;
const MAX_PATH_CHARS = 4096;
const MAX_SEARCH_QUERY_CHARS = 512;
const MAX_FILTER_VALUES = 64;
const MAX_CAPABILITY_DESCRIPTION_CHARS = 4096;
const MAX_CAPABILITY_TOOLS = 256;

function hostIsLoopback(header: string | undefined): boolean {
  if (!header) return false;
  const withoutPort = header.replace(/:\d+$/, '');
  return LOOPBACK_HOSTS.has(withoutPort.toLowerCase());
}

function originIsLoopback(header: string | undefined): boolean {
  if (!header) return true; // Same-origin navigations and curl send no Origin.
  try {
    const url = new URL(header);
    return LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export async function createServer(options: ServerOptions): Promise<HarnessServer> {
  const token = options.token ?? createToken();
  const { service } = options;

  const app = Fastify({
    logger: false,
    // Transport size includes worst-case JSON escaping; parsed content is still
    // held to MAX_DOCUMENT_BYTES below.
    bodyLimit: MAX_DOCUMENT_BYTES * MAX_JSON_STRING_EXPANSION + MAX_REQUEST_OVERHEAD_BYTES,
  });

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!hostIsLoopback(request.headers.host)) {
      await reply.code(403).send({ error: 'Requests must be addressed to localhost.' });
      return;
    }
    if (!originIsLoopback(request.headers.origin)) {
      await reply.code(403).send({ error: 'Cross-origin requests are not allowed.' });
      return;
    }

    // Static assets are unauthenticated so the page can bootstrap; the token
    // guards every route that touches the filesystem.
    if (!request.url.startsWith('/api/')) return;
    if (request.url.startsWith('/api/health')) return;

    const provided = extractToken(request);
    if (!provided || !tokensMatch(provided, token)) {
      return reply.code(401).send({ error: 'Missing or invalid token.' });
    }
  });

  app.get('/api/health', async () => ({ ok: true, readOnly: service.readOnly }));

  app.get('/api/scan', async () => {
    const result = await service.getScan();
    return { ...result, tree: await service.getTree() };
  });

  app.post('/api/scan', async () => {
    const result = await service.refresh();
    return { ...result, tree: await service.getTree() };
  });

  app.get('/api/inventory', async () => service.getInventory());

  app.get('/api/effective', async () => service.getEffective());

  app.get('/api/sources', async () => service.getSources());

  app.get('/api/review', async () => service.getReview());

  app.get('/api/budget', async () => service.getContextBudget());

  app.get('/api/overview', async () => {
    const [result, inventory] = await Promise.all([service.getScan(), service.getInventory()]);
    const budget = await service.getContextBudget();
    return {
      summary: inventory.summary,
      findings: inventory.findings,
      platform: result.platform,
      scannedAt: result.scannedAt,
      durationMs: result.durationMs,
      projectRoots: result.projectRoots,
      detectedProviders: result.detectedProviders,
      missingCount: result.missing.length,
      contextBudget: {
        alwaysBytes: budget.totals.alwaysBytes,
        alwaysTokens: budget.totals.alwaysTokens,
        bytesPerToken: budget.bytesPerToken,
      },
      tree: await service.getTree(),
    };
  });

  app.get<{ Params: { id: string }; Querystring: { reveal?: string } }>(
    '/api/files/:id',
    async (request, reply) => {
      const wantsSecrets = request.query.reveal === 'true';
      const document = await service.getDocument(request.params.id, wantsSecrets);
      if (!document) {
        return reply.code(404).send({ error: 'No such file, or it is not in the scanned set.' });
      }
      return document;
    },
  );

  app.post<{ Params: { id: string }; Body: { redactionId?: string } }>(
    '/api/files/:id/reveal',
    async (request, reply) => {
      const redactionId = request.body?.redactionId;
      if (typeof redactionId !== 'string') {
        return reply.code(400).send({ error: 'redactionId is required.' });
      }
      if (redactionId.length === 0 || redactionId.length > MAX_IDENTIFIER_CHARS) {
        return reply
          .code(400)
          .send({ error: `redactionId must be 1-${MAX_IDENTIFIER_CHARS} characters.` });
      }
      const value = await service.revealValue(request.params.id, redactionId);
      if (value === undefined) {
        return reply.code(404).send({ error: 'That value could not be revealed.' });
      }
      return { value };
    },
  );

  app.put<{ Params: { id: string }; Body: { content?: string; expectedHash?: string } }>(
    '/api/files/:id',
    async (request, reply) => {
      if (service.readOnly) {
        return reply.code(403).send({ error: 'This session is read-only.', code: 'read-only' });
      }
      const { content, expectedHash } = request.body ?? {};
      if (typeof content !== 'string' || typeof expectedHash !== 'string') {
        return reply.code(400).send({ error: 'content and expectedHash are required.' });
      }
      if (Buffer.byteLength(content, 'utf8') > MAX_DOCUMENT_BYTES) {
        return reply
          .code(413)
          .send({ error: `content must be no larger than ${MAX_DOCUMENT_BYTES} bytes.` });
      }
      if (expectedHash.length === 0 || expectedHash.length > MAX_IDENTIFIER_CHARS) {
        return reply
          .code(400)
          .send({ error: `expectedHash must be 1-${MAX_IDENTIFIER_CHARS} characters.` });
      }

      const outcome = await service.writeDocument(request.params.id, content, expectedHash);
      if (!outcome) {
        return reply.code(404).send({ error: 'No such file, or it is not in the scanned set.' });
      }
      if (!outcome.ok) {
        return reply.code(statusForRefusal(outcome.code)).send(outcome);
      }
      return outcome;
    },
  );

  app.delete<{ Params: { id: string }; Body?: { expectedHash?: string } }>(
    '/api/files/:id',
    async (request, reply) => {
      if (service.readOnly) {
        return reply.code(403).send({ error: 'This session is read-only.', code: 'read-only' });
      }

      const expectedHash = request.body?.expectedHash;
      if (expectedHash !== undefined && typeof expectedHash !== 'string') {
        return reply.code(400).send({ error: 'expectedHash must be a string when supplied.' });
      }
      if (
        typeof expectedHash === 'string' &&
        (expectedHash.length === 0 || expectedHash.length > MAX_IDENTIFIER_CHARS)
      ) {
        return reply
          .code(400)
          .send({ error: `expectedHash must be 1-${MAX_IDENTIFIER_CHARS} characters.` });
      }

      const outcome = await service.deleteFile(request.params.id, expectedHash);
      if (!outcome) {
        return reply.code(404).send({ error: 'No such file, or it is not in the scanned set.' });
      }
      if (!outcome.ok) {
        return reply.code(statusForRefusal(outcome.code)).send(outcome);
      }
      return outcome;
    },
  );

  app.delete<{ Params: { id: string; name: string }; Body?: { expectedHash?: string } }>(
    '/api/files/:id/mcp/:name',
    async (request, reply) => {
      if (service.readOnly) {
        return reply.code(403).send({ error: 'This session is read-only.', code: 'read-only' });
      }
      const serverName = request.params.name;
      if (serverName.length === 0 || serverName.length > MAX_IDENTIFIER_CHARS) {
        return reply
          .code(400)
          .send({ error: `Server name must be 1-${MAX_IDENTIFIER_CHARS} characters.` });
      }

      const expectedHash = request.body?.expectedHash;
      if (expectedHash !== undefined && typeof expectedHash !== 'string') {
        return reply.code(400).send({ error: 'expectedHash must be a string when supplied.' });
      }
      if (
        typeof expectedHash === 'string' &&
        (expectedHash.length === 0 || expectedHash.length > MAX_IDENTIFIER_CHARS)
      ) {
        return reply
          .code(400)
          .send({ error: `expectedHash must be 1-${MAX_IDENTIFIER_CHARS} characters.` });
      }

      const outcome = await service.removeMcpServer(request.params.id, serverName, expectedHash);
      if (!outcome) {
        return reply.code(404).send({ error: 'No such file, or it is not in the scanned set.' });
      }
      if (!outcome.ok) {
        return reply.code(statusForRefusal(outcome.code)).send(outcome);
      }
      return outcome;
    },
  );

  app.get('/api/capabilities', async () => service.listCapabilities());

  app.get<{ Params: { id: string }; Querystring: { reveal?: string } }>(
    '/api/capabilities/:id',
    async (request, reply) => {
      const wantsSecrets = request.query.reveal === 'true';
      const document = await service.getCapabilityDocument(request.params.id, wantsSecrets);
      if (!document) {
        return reply
          .code(404)
          .send({ error: 'No such agent or skill, or it is not in the scanned set.' });
      }
      return document;
    },
  );

  app.put<{
    Params: { id: string };
    Body: {
      expectedHash?: string;
      name?: string;
      description?: string;
      model?: string;
      version?: string;
      tools?: unknown;
      body?: string;
    };
  }>('/api/capabilities/:id', async (request, reply) => {
    if (service.readOnly) {
      return reply.code(403).send({ error: 'This session is read-only.', code: 'read-only' });
    }

    const payload = request.body ?? {};
    if (typeof payload.expectedHash !== 'string') {
      return reply.code(400).send({ error: 'expectedHash is required.' });
    }
    if (payload.expectedHash.length === 0 || payload.expectedHash.length > MAX_IDENTIFIER_CHARS) {
      return reply
        .code(400)
        .send({ error: `expectedHash must be 1-${MAX_IDENTIFIER_CHARS} characters.` });
    }

    const edit = readCapabilityEdit(payload);
    if ('error' in edit) {
      return reply.code(400).send({ error: edit.error });
    }

    const outcome = await service.writeCapabilityDocument(
      request.params.id,
      edit.value,
      payload.expectedHash,
    );
    if (!outcome) {
      return reply
        .code(404)
        .send({ error: 'No such agent or skill, or it is not in the scanned set.' });
    }
    if (!outcome.ok) {
      return reply.code(statusForRefusal(outcome.code)).send(outcome);
    }
    return outcome;
  });

  app.get('/api/projects', async () => ({ roots: service.projectRoots }));

  app.post<{ Body: { path?: string } }>('/api/projects', async (request, reply) => {
    const path = request.body?.path;
    if (typeof path !== 'string' || path.length === 0) {
      return reply.code(400).send({ error: 'path is required.' });
    }
    if (path.length > MAX_PATH_CHARS || path.includes('\0')) {
      return reply
        .code(400)
        .send({ error: `path must be no longer than ${MAX_PATH_CHARS} characters.` });
    }
    try {
      return { roots: await service.addProjectRoot(path) };
    } catch (error) {
      if (error instanceof InvalidProjectRootError) {
        return reply.code(400).send({ error: error.message });
      }
      throw error;
    }
  });

  app.delete<{ Body: { path?: string } }>('/api/projects', async (request, reply) => {
    const path = request.body?.path;
    if (typeof path !== 'string' || path.length === 0) {
      return reply.code(400).send({ error: 'path is required.' });
    }
    if (path.length > MAX_PATH_CHARS || path.includes('\0')) {
      return reply
        .code(400)
        .send({ error: `path must be no longer than ${MAX_PATH_CHARS} characters.` });
    }
    return { roots: await service.removeProjectRoot(path) };
  });

  app.get<{
    Querystring: { q?: string; provider?: string; kind?: string; scope?: string };
  }>('/api/search', async (request, reply) => {
    const query = request.query.q ?? '';
    if (query.length > MAX_SEARCH_QUERY_CHARS) {
      return reply
        .code(400)
        .send({ error: `q must be no longer than ${MAX_SEARCH_QUERY_CHARS} characters.` });
    }
    const providerIds = splitList(request.query.provider);
    const kinds = splitList(request.query.kind);
    const scopes = splitList(request.query.scope);
    if (providerIds === null || kinds === null || scopes === null) {
      return reply
        .code(400)
        .send({ error: `Each filter accepts at most ${MAX_FILTER_VALUES} values.` });
    }
    return service.search({
      query,
      providerIds,
      kinds,
      scopes,
    });
  });

  app.get<{ Querystring: { format?: string } }>('/api/export', async (request, reply) => {
    if (request.query.format === 'markdown') {
      const markdown = await service.exportMarkdown();
      return reply
        .header('content-type', 'text/markdown; charset=utf-8')
        .header('content-disposition', 'attachment; filename="harness-report.md"')
        .send(markdown);
    }
    return service.exportJson();
  });

  if (options.publicDir) {
    await app.register(fastifyStatic, { root: options.publicDir, index: ['index.html'] });

    // The UI is a single-page app, so unknown non-API paths render the shell
    // rather than 404ing.
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'Unknown endpoint.' });
      }
      return reply.sendFile('index.html');
    });
  }

  return { app, token };
}

/** Accepts API credentials only from headers so request URLs never carry them. */
function extractToken(request: FastifyRequest): string | undefined {
  const header = request.headers['x-harness-token'];
  if (typeof header === 'string' && header.length > 0) return header;

  const authorization = request.headers.authorization;
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    return authorization.slice('Bearer '.length);
  }

  return undefined;
}

/**
 * Validates a structured capability edit from an untrusted body.
 *
 * Absent fields mean "leave this alone" and empty strings mean "remove this
 * key", so the two are kept distinct all the way through rather than being
 * collapsed by a default. Anything of the wrong type is rejected outright
 * instead of being coerced, because a coerced `tools: "read"` would silently
 * rewrite a list as a string.
 */
function readCapabilityEdit(payload: {
  name?: unknown;
  description?: unknown;
  model?: unknown;
  version?: unknown;
  tools?: unknown;
  body?: unknown;
}): { value: Parameters<HarnessService['writeCapabilityDocument']>[1] } | { error: string } {
  const edit: {
    name?: string;
    description?: string;
    model?: string;
    version?: string;
    tools?: string[];
    body?: string;
  } = {};

  for (const key of ['name', 'description', 'model', 'version', 'body'] as const) {
    const value = payload[key];
    if (value === undefined) continue;
    if (typeof value !== 'string') return { error: `${key} must be a string.` };
    const max =
      key === 'body'
        ? MAX_DOCUMENT_BYTES
        : key === 'description'
          ? MAX_CAPABILITY_DESCRIPTION_CHARS
          : MAX_IDENTIFIER_CHARS;
    const size = key === 'body' ? Buffer.byteLength(value, 'utf8') : value.length;
    if (size > max) {
      return {
        error: `${key} must be no longer than ${max} ${key === 'body' ? 'bytes' : 'characters'}.`,
      };
    }
    edit[key] = value;
  }

  if (payload.tools !== undefined) {
    if (!Array.isArray(payload.tools) || payload.tools.some((item) => typeof item !== 'string')) {
      return { error: 'tools must be an array of strings.' };
    }
    if (payload.tools.length > MAX_CAPABILITY_TOOLS) {
      return { error: `tools must contain at most ${MAX_CAPABILITY_TOOLS} entries.` };
    }
    if (payload.tools.some((item) => (item as string).length > MAX_IDENTIFIER_CHARS)) {
      return { error: `Each tool must be no longer than ${MAX_IDENTIFIER_CHARS} characters.` };
    }
    edit.tools = payload.tools as string[];
  }

  return { value: edit };
}

function statusForRefusal(code: string): number {
  switch (code) {
    case 'read-only':
    case 'credential-store':
    case 'not-deletable':
      return 403;
    case 'invalid-content':
    case 'unsupported-format':
      return 422;
    case 'hash-mismatch':
      return 409;
    case 'not-found':
    case 'not-declared':
      return 404;
    default:
      return 500;
  }
}

function splitList(value: string | undefined): string[] | undefined | null {
  if (!value) return undefined;
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (
    parts.length > MAX_FILTER_VALUES ||
    parts.some((part) => part.length > MAX_IDENTIFIER_CHARS)
  ) {
    return null;
  }
  return parts.length > 0 ? parts : undefined;
}
