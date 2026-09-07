#!/usr/bin/env node
/**
 * `ai-harness-helper` — scans this machine for agentic-tool configuration and
 * opens a local browser UI showing the whole harness in one place.
 */

import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { HarnessService, type ReviewReport } from '@ai-harness-helper/core';

import { createServer } from './server.js';
import { checkForUpdates, formatUpdateNotice, type UpdateCheck } from './update-check.js';
import {
  BASE_URL_VAR,
  MODEL_VAR,
  API_KEY_VAR,
  collectAdvisorInput,
  formatAdvisorNotice,
  isLoopbackEndpoint,
  resolveAdvisorSetup,
  runAdvisor,
  type AdvisorRun,
  type AdvisorSetup,
} from './advisor.js';

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
  /** Print the quality review to stdout and exit. */
  review: boolean;
  /**
   * Exit non-zero when a finding at or above this severity exists.
   * `undefined` means findings never affect the exit code.
   */
  failOn: 'error' | 'warning' | 'info' | undefined;
  help: boolean;
  version: boolean;
  /**
   * Ask GitHub whether a newer release exists.
   *
   * Off unless this flag is present, because it is the only thing in the tool
   * that reaches the network.
   */
  checkUpdates: boolean;
  /**
   * Ask a model to review the harness alongside the deterministic rules.
   *
   * Off unless this flag is present. The endpoint comes from the environment,
   * but only this flag decides whether anything is sent, so an exported
   * variable left in a shell profile cannot enable egress on its own.
   */
  advise: boolean;
  /** Print exactly what `--advise` would send, without sending it. */
  adviseDryRun: boolean;
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
      --review           Print the quality review and exit. Implies --no-open.
      --check            Exit 2 when anything at error severity was found.
      --fail-on <level>  Threshold for --check: error, warning, or info.
      --check-updates    Ask GitHub whether a newer release exists. Off by
                         default; this is the only network request the tool
                         makes on its own.
      --advise           Also ask a model to review your capabilities and
                         instructions, alongside the offline rules. Off by
                         default. Needs an endpoint in the environment:
                           ${BASE_URL_VAR} — OpenAI-compatible base URL
                           ${MODEL_VAR} — model to ask for
                           ${API_KEY_VAR} — optional; local models need none
      --advise-dry-run   Print exactly what --advise would send, then exit.
                         Contacts nothing.
  -h, --help             Show this help.
  -v, --version          Show the version.

Exit codes
  0  Ran successfully, nothing at or above the failure threshold.
  1  The command itself failed.
  2  Findings at or above the failure threshold exist (--check / --fail-on).

--check and --fail-on weigh health findings and review issues together, so a
skill with no description fails a build the same way an unparseable settings
file does. Model recommendations never affect the exit code: a suggestion that
could fail a build would make builds depend on a model's mood.

The server binds 127.0.0.1 only and requires a token that is generated fresh
on every run. There is no telemetry. Two things can leave this machine, both
off unless you ask for them: the release lookup behind --check-updates, and
the harness summary behind --advise. Without those flags nothing leaves. Use
--advise-dry-run to read the payload before you ever send one.
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
    review: false,
    failOn: undefined,
    help: false,
    version: false,
    checkUpdates: false,
    advise: false,
    adviseDryRun: false,
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
      case '--review':
        options.review = true;
        break;
      case '--check-updates':
        options.checkUpdates = true;
        break;
      case '--advise':
        options.advise = true;
        break;
      case '--advise-dry-run':
        options.adviseDryRun = true;
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
  // --check has nothing to show a browser either. A dry run is pure stdout too.
  if (
    options.report !== undefined ||
    options.failOn !== undefined ||
    options.review ||
    options.adviseDryRun
  ) {
    options.open = false;
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

/**
 * Renders the review for a terminal.
 *
 * Grouped by file rather than by rule, because the user fixes one file at a
 * time; a list sorted by severity would have them jumping between documents.
 */
export function formatReview(report: ReviewReport): string {
  const lines: string[] = [];
  const { summary } = report;

  lines.push(
    '',
    `  Harness review — ${summary.score}/100 (${summary.grade})`,
    `  ${summary.issueCount} issue${summary.issueCount === 1 ? '' : 's'} ` +
      `(${summary.errorCount} error, ${summary.warningCount} warning, ${summary.infoCount} info) ` +
      `across ${summary.affectedFileCount} file${summary.affectedFileCount === 1 ? '' : 's'}.`,
    `  ${summary.ruleCount} rules run against ${summary.reviewedSubjectCount} subjects.`,
    '',
  );

  if (report.issues.length === 0) {
    lines.push('  Nothing to fix.', '');
    return lines.join('\n');
  }

  const byFile = new Map<string, typeof report.issues>();
  for (const issue of report.issues) {
    const existing = byFile.get(issue.displayPath);
    byFile.set(issue.displayPath, existing ? [...existing, issue] : [issue]);
  }

  for (const [displayPath, issues] of byFile) {
    lines.push(`  ${displayPath}`);
    for (const issue of issues) {
      lines.push(`    [${issue.severity}] ${issue.title}`);
      lines.push(`      ${issue.detail}`);
      lines.push(`      Fix: ${issue.remediation}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Renders model recommendations for a terminal.
 *
 * Kept visually distinct from the rule output above it, and always labelled
 * with the model that produced it, because the two carry very different
 * weight: a rule fired on bytes that are definitely there, a recommendation is
 * a machine's opinion the user is free to reject.
 */
export function formatRecommendations(run: AdvisorRun): string {
  if (run.status !== 'ok') return formatAdvisorNotice(run) ?? '';

  const lines: string[] = ['', `  Model recommendations — ${run.model}`];
  if (run.truncated) {
    lines.push('  (a large harness was sampled, so this is a partial view)');
  }
  lines.push('');

  if (run.recommendations.length === 0) {
    lines.push('  The model had nothing to add.', '');
    return lines.join('\n');
  }

  for (const item of run.recommendations) {
    lines.push(`  ${item.subject}`);
    lines.push(`    [${item.severity}] ${item.title}`);
    if (item.detail) lines.push(`      ${item.detail}`);
    lines.push(`      Suggested: ${item.remediation}`);
    if (item.displayPath) lines.push(`      ${item.displayPath}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * One line in the startup banner saying whether a model is in play.
 *
 * Silent when the feature is off, so the default run reads exactly as it
 * always has. When it is on, the destination is named up front rather than
 * being something the user discovers later in a network log.
 */
function describeAdvisorBanner(setup: AdvisorSetup): string {
  switch (setup.status) {
    case 'disabled':
      return '';
    case 'ready':
      return isLoopbackEndpoint(setup.config.baseUrl)
        ? `  Recommendations: ${setup.config.model} on a local endpoint. Nothing leaves this machine.\n`
        : `  Recommendations: ${setup.config.model} at ${originOf(setup.config.baseUrl)}.` +
            ' A harness summary is sent when you ask for it.\n';
    case 'incomplete':
      return `  Recommendations are off: set ${setup.missing.join(' and ')}.\n`;
    case 'invalid':
      return `  Recommendations are off: ${setup.reason}\n`;
  }
}

/** Origin only, so a path carrying a key or tenant id never reaches the console. */
function originOf(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return 'the configured endpoint';
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

  const headless =
    options.report !== undefined ||
    options.failOn !== undefined ||
    options.review ||
    options.adviseDryRun;

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
    // Goes to stderr with the rest of the progress output, so a piped --json
    // report stays parseable.
    if (options.checkUpdates) {
      const notice = formatUpdateNotice(await checkForUpdates(await readVersion()));
      if (notice) progress.write(notice);
    }

    // Answered before anything is sent, and without an endpoint being
    // configured at all, so "what would you upload?" is a question the user
    // can settle first and separately.
    if (options.adviseDryRun) {
      const { payload } = await collectAdvisorInput(service);
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      return;
    }

    if (options.report === 'json') {
      process.stdout.write(`${JSON.stringify(await service.exportJson(), null, 2)}\n`);
    } else if (options.report === 'markdown') {
      process.stdout.write(await service.exportMarkdown());
    }

    if (options.review && options.report === undefined) {
      process.stdout.write(formatReview(await service.getReview()));
      if (options.advise) {
        const setup = resolveAdvisorSetup(true, process.env);
        process.stdout.write(formatRecommendations(await runAdvisor(service, setup)));
      }
    }

    if (options.failOn !== undefined) {
      const threshold = SEVERITY_RANK[options.failOn];
      // Health findings and review issues answer the same question — "is
      // something wrong here?" — so a gate that weighed only one of them would
      // pass a harness whose skills are all unroutable.
      const review = await service.getReview();
      const gated: { severity: 'error' | 'warning' | 'info'; title: string; detail: string }[] = [
        ...inventory.findings,
        ...review.issues,
      ].filter((entry) => SEVERITY_RANK[entry.severity] >= threshold);

      if (options.report === undefined && !options.review) {
        progress.write(
          `\n  ${result.files.length} files across ${result.detectedProviders.length} tools` +
            ` — ${inventory.summary.findingCount} findings` +
            ` (${inventory.summary.errorCount} error, ${inventory.summary.warningCount} warning),` +
            ` ${review.summary.issueCount} review issues, score ${review.summary.score}/100.\n`,
        );
        for (const entry of gated) {
          process.stdout.write(`${entry.severity}: ${entry.title} — ${entry.detail}\n`);
        }
      }

      if (gated.length > 0) {
        progress.write(
          `\n  ${gated.length} item${gated.length === 1 ? '' : 's'} at or above` +
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
  const version = await readVersion();

  // Resolved before the server starts so the About page can render the answer
  // immediately rather than the browser triggering a second network request.
  const updateCheck: UpdateCheck = options.checkUpdates
    ? await checkForUpdates(version)
    : { status: 'disabled' };

  // Resolved once, here, from the command line. The server is handed the
  // answer rather than the ability to work it out, so no request arriving at
  // the API can turn egress on for a run that did not ask for it.
  const advisor = resolveAdvisorSetup(options.advise, process.env);

  const { app, token } = await createServer({
    service,
    version,
    updateCheck,
    advisor,
    ...(publicDir ? { publicDir } : {}),
  });

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
      describeAdvisorBanner(advisor) +
      (formatUpdateNotice(updateCheck) ?? '') +
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

/**
 * Whether this module is the process entry point rather than an import.
 *
 * Comparing URLs rather than paths is what makes this correct on Windows,
 * where a drive-letter path becomes `file:///C:/...`. That is not enough on
 * its own: Node resolves symlinks when it builds `import.meta.url`, but
 * `process.argv[1]` keeps whatever path the caller actually typed. Any link
 * between the two — a Windows junction, an `npm link`, a Homebrew-managed
 * prefix, a pnpm global bin — makes the raw comparison false, and the CLI then
 * exits 0 having silently done nothing at all.
 *
 * Resolving argv[1] the same way Node resolved the module URL is what keeps
 * those installs working. A path that cannot be resolved is compared as-is,
 * because a missing entry file is not this function's problem to report.
 */
export function isDirectInvocation(
  entryPath: string | undefined,
  moduleUrl: string = import.meta.url,
): boolean {
  if (entryPath === undefined) return false;
  let resolved = entryPath;
  try {
    resolved = realpathSync(entryPath);
  } catch {
    // Fall through with the original path.
  }
  return moduleUrl === pathToFileURL(resolved).href;
}

if (isDirectInvocation(process.argv[1])) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
