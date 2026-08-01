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
import { type HarnessService } from '@ai-harness-helper/core';

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
    // Config files are small; a low cap limits the damage of a rogue client.
    bodyLimit: 8 * 1024 * 1024,
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

    // Fastify decodes paths before routing, so checking the raw request target
    // would let `/%61pi/...` reach an API handler without passing this gate.
    const encodedPath = request.url.split('?', 1)[0] ?? '';
    let routePath: string;
    try {
      routePath = decodeURIComponent(encodedPath);
    } catch {
      await reply.code(400).send({ error: 'Malformed request path.' });
      return;
    }
    if (!routePath.startsWith('/api/')) return;
    if (routePath === '/api/health') return;

    const provided = extractToken(request);
    if (!provided || !tokensMatch(provided, token)) {
      await reply.code(401).send({ error: 'Missing or invalid token.' });
    }
  });

  app.addHook('onSend', async (_request, reply) => {
    void reply
      .header('cache-control', 'no-store')
      .header(
        'content-security-policy',
        "default-src 'self'; connect-src 'self'; img-src 'self' data:",
      )
      .header('referrer-policy', 'no-referrer')
      .header('x-content-type-options', 'nosniff');
  });

  app.get('/api/health', async () => ({ ok: true, readOnly: service.readOnly }));

  app.get('/api/scan', async () => {
    const result = await service.getScan();
    return { ...result, tree: await service.getTree() };
  });

  app.post('/api/scan', async (request) => {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    request.raw.once('aborted', abort);
    try {
      const result = await service.refresh(controller.signal);
      return { ...result, tree: await service.getTree() };
    } finally {
      request.raw.off('aborted', abort);
    }
  });

  app.get('/api/inventory', async () => service.getInventory());

  app.get('/api/overview', async () => {
    const [result, inventory] = await Promise.all([service.getScan(), service.getInventory()]);
    return {
      summary: inventory.summary,
      findings: inventory.findings,
      platform: result.platform,
      scannedAt: result.scannedAt,
      durationMs: result.durationMs,
      projectRoots: result.projectRoots,
      detectedProviders: result.detectedProviders,
      missingCount: result.missing.length,
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

  app.get('/api/projects', async () => ({ roots: service.projectRoots }));

  app.post<{ Body: { path?: string } }>('/api/projects', async (request, reply) => {
    const path = request.body?.path;
    if (typeof path !== 'string' || path.length === 0) {
      return reply.code(400).send({ error: 'path is required.' });
    }
    return { roots: await service.addProjectRoot(path) };
  });

  app.delete<{ Body: { path?: string } }>('/api/projects', async (request, reply) => {
    const path = request.body?.path;
    if (typeof path !== 'string' || path.length === 0) {
      return reply.code(400).send({ error: 'path is required.' });
    }
    return { roots: await service.removeProjectRoot(path) };
  });

  app.get<{
    Querystring: { q?: string; provider?: string; kind?: string; scope?: string };
  }>('/api/search', async (request) => {
    return service.search({
      query: request.query.q ?? '',
      providerIds: splitList(request.query.provider),
      kinds: splitList(request.query.kind),
      scopes: splitList(request.query.scope),
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

/** Accepts the token from a header, a bearer credential, or the query string. */
function extractToken(request: FastifyRequest): string | undefined {
  const header = request.headers['x-harness-token'];
  if (typeof header === 'string' && header.length > 0) return header;

  const authorization = request.headers.authorization;
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    return authorization.slice('Bearer '.length);
  }

  const query = (request.query as { token?: unknown } | undefined)?.token;
  return typeof query === 'string' && query.length > 0 ? query : undefined;
}

function statusForRefusal(code: string): number {
  switch (code) {
    case 'read-only':
    case 'credential-store':
      return 403;
    case 'invalid-content':
      return 422;
    case 'hash-mismatch':
      return 409;
    case 'not-found':
      return 404;
    default:
      return 500;
  }
}

function splitList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts : undefined;
}
