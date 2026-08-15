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

/** Ordering for `--fail-on`, so a threshold includes everything above it. */
const SEVERITY_RANK = { info: 0, warning: 1, error: 2 } as const;

interface Options {
  port: number | undefined;
  open: boolean;
  readOnly: boolean;
  projects: string[];
  projectsOnly: boolean;
  /** Emit a report to stdout instead of serving the UI. */
  report: 'json' | 'markdown' | undefined;
  /**
   * Exit non-zero when a finding at or above this severity exists.
   * `undefined` means findings never affect the exit code.
   */
  failOn: 'error' | 'warning' | 'info' | undefined;
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
      --projects-only    Scan project folders without user or machine configuration.
      --read-only        Disable all editing for this session.
      --no-open          Do not launch a browser.
      --json             Print the full report as JSON and exit. Implies --no-open.
      --report <format>  Print a report and exit: json or markdown.
      --check            Exit 2 when anything at error severity was found.
      --fail-on <level>  Threshold for --check: error, warning, or info.
  -h, --help             Show this help.
  -v, --version          Show the version.

Exit codes
  0  Ran successfully, nothing at or above the failure threshold.
  1  The command itself failed.
  2  Findings at or above the failure threshold exist (--check / --fail-on).

The server binds 127.0.0.1 only and requires a token that is generated fresh
on every run. Nothing is sent anywhere: there is no telemetry and no outbound
network access.
`.trimStart();

function parsePort(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) {
    throw new Error(`--port needs a whole number between 0 and 65535, got "${value ?? ''}".`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 65535) {
    throw new Error(`--port needs a whole number between 0 and 65535, got "${value}".`);
  }
  return parsed;
}

function addProject(options: Options, value: string | undefined): void {
  if (!value || value.startsWith('-')) {
    throw new Error('--project needs a path. Example: --project ./my-app');
  }
  options.projects.push(resolve(value));
}

function parseReport(value: string | undefined): 'json' | 'markdown' {
  if (value === 'json') return 'json';
  if (value === 'markdown' || value === 'md') return 'markdown';
  throw new Error(`--report needs "json" or "markdown", got "${value ?? ''}".`);
}

function parseSeverity(value: string | undefined): 'error' | 'warning' | 'info' {
  if (value === 'error' || value === 'warning' || value === 'info') return value;
  throw new Error(`--fail-on needs "error", "warning", or "info", got "${value ?? ''}".`);
}

export function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    port: undefined,
    open: true,
    readOnly: false,
    projects: [],
    projectsOnly: false,
    report: undefined,
    failOn: undefined,
    help: false,
    version: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg?.startsWith('--port=')) {
      options.port = parsePort(arg.slice('--port='.length));
      continue;
    }
    if (arg?.startsWith('--project=')) {
      addProject(options, arg.slice('--project='.length));
      continue;
    }
    if (arg?.startsWith('--report=')) {
      options.report = parseReport(arg.slice('--report='.length));
      continue;
    }
    if (arg?.startsWith('--fail-on=')) {
      options.failOn = parseSeverity(arg.slice('--fail-on='.length));
      continue;
    }
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
      case '--projects-only':
        options.projectsOnly = true;
        break;
      case '--json':
        options.report = 'json';
        break;
      case '--check':
        // `--check` on its own means "fail on anything serious". A separate
        // --fail-on can widen it, so only the default is set here.
        options.failOn ??= 'error';
        break;
      case '--report': {
        const value = argv[index + 1];
        index += 1;
        options.report = parseReport(value);
        break;
      }
      case '--fail-on': {
        const value = argv[index + 1];
        index += 1;
        options.failOn = parseSeverity(value);
        break;
      }
      case '-p':
      case '--port': {
        const value = argv[index + 1];
        index += 1;
        options.port = parsePort(value);
        break;
      }
      case '--project': {
        const value = argv[index + 1];
        index += 1;
        addProject(options, value);
        break;
      }
      default:
        if (arg?.startsWith('-')) {
          throw new Error(`Unknown option "${arg}". Run with --help to see valid options.`);
        }
        throw new Error(
          `Unexpected argument "${arg ?? ''}". Use --project <path> to scan a folder.`,
        );
    }
  }

  if (options.projectsOnly && options.projects.length === 0) {
    throw new Error('--projects-only requires at least one --project <path>.');
  }

  // A report goes to stdout, so opening a browser would be noise, and a bare
  // --check has nothing to show a browser either.
  if (options.report !== undefined || options.failOn !== undefined) options.open = false;

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
    projectsOnly: options.projectsOnly,
    readOnly: options.readOnly,
  });

  const headless = options.report !== undefined || options.failOn !== undefined;

  // Progress goes to stderr in headless mode so `--json` can be piped straight
  // into jq without the caller having to strip a banner off the front.
  const progress = headless ? process.stderr : process.stdout;
  progress.write(
    options.projectsOnly
      ? 'Scanning project harness configuration only...\n'
      : 'Scanning for agentic harness configuration...\n',
  );
  const result = await service.refresh();
  const inventory = await service.getInventory();

  if (headless) {
    if (options.report === 'json') {
      process.stdout.write(`${JSON.stringify(await service.exportJson(), null, 2)}\n`);
    } else if (options.report === 'markdown') {
      process.stdout.write(await service.exportMarkdown());
    }

    if (options.failOn !== undefined) {
      const threshold = SEVERITY_RANK[options.failOn];
      const failing = inventory.findings.filter(
        (finding) => SEVERITY_RANK[finding.severity] >= threshold,
      );

      if (options.report === undefined) {
        progress.write(
          `\n  ${result.files.length} files across ${result.detectedProviders.length} tools` +
            ` — ${inventory.summary.findingCount} findings` +
            ` (${inventory.summary.errorCount} error, ${inventory.summary.warningCount} warning).\n`,
        );
        for (const finding of failing) {
          process.stdout.write(`${finding.severity}: ${finding.title} — ${finding.detail}\n`);
        }
      }

      if (failing.length > 0) {
        progress.write(
          `\n  ${failing.length} finding${failing.length === 1 ? '' : 's'} at or above` +
            ` "${options.failOn}".\n`,
        );
        process.exitCode = 2;
      } else {
        progress.write(`\n  Nothing at or above "${options.failOn}".\n`);
      }
    }
    return;
  }

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
      (options.projectsOnly
        ? '  Projects only: user and machine configuration was skipped.\n'
        : '') +
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
