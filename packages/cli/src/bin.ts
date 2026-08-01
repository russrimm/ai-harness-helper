#!/usr/bin/env node
/**
 * `ai-harness-helper` — scans this machine for agentic-tool configuration and
 * opens a local browser UI showing the whole harness in one place.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { HarnessService } from '@ai-harness-helper/core';

import { createServer } from './server.js';

const HERE = dirname(fileURLToPath(import.meta.url));

interface Options {
  port: number | undefined;
  open: boolean;
  readOnly: boolean;
  projects: string[];
  help: boolean;
  version: boolean;
}

const USAGE = `
ai-harness-helper — see every agentic-tool config on this machine

Usage
  npx ai-harness-helper [options]

Options
  -p, --port <number>    Port to listen on. Defaults to the first free port from 7777.
      --project <path>   Also scan a project folder. Repeatable.
      --read-only        Disable all editing for this session.
      --no-open          Do not launch a browser.
  -h, --help             Show this help.
  -v, --version          Show the version.

The server binds 127.0.0.1 only and requires a token that is generated fresh
on every run. Nothing is sent anywhere: there is no telemetry and no outbound
network access.
`.trimStart();

export function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    port: undefined,
    open: true,
    readOnly: false,
    projects: [],
    help: false,
    version: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '-v':
      case '--version':
        options.version = true;
        break;
      case '--read-only':
        options.readOnly = true;
        break;
      case '--no-open':
        options.open = false;
        break;
      case '-p':
      case '--port': {
        const value = argv[index + 1];
        index += 1;
        const parsed = Number.parseInt(value ?? '', 10);
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
          throw new Error(`--port needs a number between 0 and 65535, got "${value ?? ''}".`);
        }
        options.port = parsed;
        break;
      }
      case '--project': {
        const value = argv[index + 1];
        index += 1;
        if (!value) throw new Error('--project needs a path.');
        options.projects.push(resolve(value));
        break;
      }
      default:
        if (arg?.startsWith('-')) throw new Error(`Unknown option "${arg}".`);
    }
  }

  return options;
}

/** True when nothing is already listening on the port. */
function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const probe = createNetServer();
    probe.once('error', () => resolvePromise(false));
    probe.once('listening', () => probe.close(() => resolvePromise(true)));
    probe.listen(port, '127.0.0.1');
  });
}

/**
 * Finds a usable port.
 *
 * An explicit `--port` is honoured exactly, so a user who scripted a port gets
 * a clear failure instead of a silently different one.
 */
export async function choosePort(requested: number | undefined): Promise<number> {
  if (requested !== undefined) {
    if (requested === 0 || (await portIsFree(requested))) return requested;
    throw new Error(`Port ${requested} is already in use.`);
  }
  for (let port = 7777; port < 7797; port += 1) {
    if (await portIsFree(port)) return port;
  }
  return 0; // Let the OS pick.
}

/**
 * Opens the default browser.
 *
 * Done with the platform's own opener rather than a dependency, so the tool
 * that reads your credentials pulls in as little third-party code as possible.
 */
function openBrowser(url: string): void {
  const [command, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];

  try {
    const child = spawn(command as string, args as string[], {
      stdio: 'ignore',
      detached: true,
    });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // A missing opener is not worth failing the run over; the URL is printed.
  }
}

/** Locates the bundled web assets, tolerating both source and built layouts. */
export function findPublicDir(): string | undefined {
  const candidates = [join(HERE, '..', 'public'), join(HERE, 'public')];
  return candidates.find((candidate) => existsSync(join(candidate, 'index.html')));
}

async function readVersion(): Promise<string> {
  try {
    const raw = await readFile(join(HERE, '..', 'package.json'), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  let options: Options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }

  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (options.version) {
    process.stdout.write(`${await readVersion()}\n`);
    return;
  }

  const service = new HarnessService({
    projectRoots: options.projects,
    readOnly: options.readOnly,
  });

  process.stdout.write('Scanning for agentic harness configuration...\n');
  const result = await service.refresh();
  const inventory = await service.getInventory();

  const port = await choosePort(options.port);
  const publicDir = findPublicDir();
  const { app, token } = await createServer({ service, ...(publicDir ? { publicDir } : {}) });

  await app.listen({ port, host: '127.0.0.1' });
  const address = app.server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const url = `http://127.0.0.1:${actualPort}/?token=${token}`;

  process.stdout.write(
    `\n  Found ${result.files.length} files across ${result.detectedProviders.length} tools` +
      ` — ${inventory.summary.mcpServerCount} MCP servers, ${inventory.summary.findingCount} findings.\n` +
      (options.readOnly ? '  Read-only: editing is disabled.\n' : '') +
      (publicDir ? '' : '  No web bundle found; serving the API only.\n') +
      `\n  ${url}\n\n  Press Ctrl+C to stop.\n`,
  );

  if (options.open) openBrowser(url);

  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    process.stdout.write('\nShutting down.\n');
    void app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Comparing URLs rather than paths is what makes this correct on Windows,
// where a drive-letter path becomes `file:///C:/...`.
const entry = process.argv[1];
const invokedDirectly = entry !== undefined && import.meta.url === pathToFileURL(entry).href;

if (invokedDirectly) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
