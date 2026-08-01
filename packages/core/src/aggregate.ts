/**
 * Turns a raw scan into the synthesized views that answer "what does my
 * agentic harness actually look like?".
 *
 * The scanner tells you which files exist. This module reads them, extracts
 * the meaningful declarations inside, and cross-references those declarations
 * across every tool so duplicates and conflicts become visible.
 */

import { createHash } from 'node:crypto';
import { parseContent } from './parsers.js';
import {
  REDACTED_PLACEHOLDER,
  detectSecretValue,
  isPlaceholderValue,
  isSecretKey,
} from './redact.js';
import type { DiscoveredFile, ScanResult } from './scanner.js';
import { readRegularText } from './safe-file.js';
import type { ConfigScope, FileFormat, FileKind } from './types.js';

/** How an MCP client reaches a server. */
export type McpTransport = 'stdio' | 'http' | 'sse' | 'websocket' | 'unknown';

/** One MCP server definition, as declared by a single file. */
export interface McpDefinition {
  /** Id of the file that declares it. */
  readonly fileId: string;
  readonly filePath: string;
  readonly displayPath: string;
  readonly providerId: string;
  readonly providerName: string;
  readonly scope: ConfigScope;
  /** Project root when this definition came from a project-scoped file. */
  readonly projectRoot?: string;
  readonly transport: McpTransport;
  /** Executable for stdio servers. */
  readonly command?: string;
  readonly args?: readonly string[];
  /** Endpoint for network servers. */
  readonly url?: string;
  /**
   * Catalog reference for servers the tool launches on your behalf, such as
   * Docker MCP Toolkit entries that name a catalog entry instead of a command.
   */
  readonly reference?: string;
  /** Environment variable names only — values are never surfaced here. */
  readonly envKeys: readonly string[];
  /** True when the definition embeds a credential-looking literal. */
  readonly hasInlineSecret: boolean;
  /** True when the tool's own config marks the server disabled. */
  readonly disabled: boolean;
  /**
   * Normalized signature used to decide whether two definitions of the same
   * name actually describe the same server.
   */
  readonly signature: string;
}

/** Every declaration of one MCP server name, across all tools. */
export interface McpServerEntry {
  readonly name: string;
  readonly definitions: readonly McpDefinition[];
  /** Distinct providers that declare this name. */
  readonly providerIds: readonly string[];
  /** True when two or more definitions disagree about what the server is. */
  readonly conflicting: boolean;
  /** True when more than one file declares this name. */
  readonly duplicated: boolean;
}

/** An instruction document that shapes agent behaviour. */
export interface InstructionEntry {
  readonly fileId: string;
  readonly displayPath: string;
  readonly providerId: string;
  readonly providerName: string;
  readonly scope: ConfigScope;
  readonly projectRoot?: string;
  /** Title from front matter, a leading heading, or the file name. */
  readonly title: string;
  /** Front matter `description`, `applyTo`, or similar when present. */
  readonly description?: string;
  /** Glob the instruction applies to, for scoped instruction files. */
  readonly appliesTo?: string;
  readonly bytes: number;
  readonly lineCount: number;
  /**
   * Lower numbers are overridden by higher ones. Project-scoped guidance wins
   * over user-scoped guidance, which wins over machine-managed defaults.
   */
  readonly precedence: number;
}

/** An agent, skill, command, prompt, or chat mode the harness can invoke. */
export interface CapabilityEntry {
  readonly fileId: string;
  readonly displayPath: string;
  readonly providerId: string;
  readonly providerName: string;
  readonly scope: ConfigScope;
  readonly kind: Extract<FileKind, 'agent' | 'skill' | 'command' | 'prompt' | 'chatmode'>;
  /** Invocation name, derived from front matter or the file name. */
  readonly name: string;
  readonly description?: string;
  /** Tools the capability declares, when it declares any. */
  readonly tools?: readonly string[];
  readonly model?: string;
}

/** A permission rule, hook, or ignore file constraining agent behaviour. */
export interface GuardrailEntry {
  readonly fileId: string;
  readonly displayPath: string;
  readonly providerId: string;
  readonly providerName: string;
  readonly scope: ConfigScope;
  readonly kind: Extract<FileKind, 'permissions' | 'ignore' | 'settings'>;
  readonly allow: readonly string[];
  readonly deny: readonly string[];
  readonly ask: readonly string[];
  /** Names of lifecycle hooks declared in the file. */
  readonly hooks: readonly string[];
  /** Ignore-file patterns. */
  readonly ignorePatterns: readonly string[];
}

/** Severity of a health finding. */
export type FindingSeverity = 'info' | 'warning' | 'error';

/** Machine-detected issue category. */
export type FindingCode =
  | 'mcp-duplicate'
  | 'mcp-conflict'
  | 'plaintext-secret'
  | 'unparseable-file'
  | 'empty-file'
  | 'deprecated-format'
  | 'unattributed-file'
  | 'scan-problem'
  | 'credential-store';

/** Something worth the user's attention. */
export interface HealthFinding {
  readonly id: string;
  readonly code: FindingCode;
  readonly severity: FindingSeverity;
  readonly title: string;
  readonly detail: string;
  /** Files the finding refers to. */
  readonly fileIds: readonly string[];
  /** Human-readable paths, for display without a file lookup. */
  readonly displayPaths: readonly string[];
  /** Suggested next step, when there is an obvious one. */
  readonly remediation?: string;
}

/** Counts for the dashboard. */
export interface HarnessSummary {
  readonly providerCount: number;
  readonly fileCount: number;
  readonly mcpServerCount: number;
  readonly mcpDefinitionCount: number;
  readonly instructionCount: number;
  readonly capabilityCount: number;
  readonly guardrailCount: number;
  readonly findingCount: number;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly totalBytes: number;
}

/** The complete synthesized view of a harness. */
export interface HarnessInventory {
  readonly summary: HarnessSummary;
  readonly mcpServers: readonly McpServerEntry[];
  readonly instructions: readonly InstructionEntry[];
  readonly capabilities: readonly CapabilityEntry[];
  readonly guardrails: readonly GuardrailEntry[];
  readonly findings: readonly HealthFinding[];
  /** Parsed values keyed by file id, for callers that want the raw tree. */
  readonly parsedFileIds: readonly string[];
}

/** Injectable file reader, so tests can aggregate without touching disk. */
export type ContentLoader = (file: DiscoveredFile) => Promise<string | undefined>;

export interface AggregateOptions {
  /** Overrides the default `fs.readFile` loader. */
  readonly loadContent?: ContentLoader;
  /** Maximum file reads in flight while preserving deterministic processing. */
  readonly concurrency?: number;
}

/** Formats a tool parses strictly, where any syntax error breaks the file. */
const STRUCTURED_FORMATS = new Set<FileFormat>(['json', 'jsonc', 'toml', 'yaml']);

/** Keys under which tools nest their MCP server maps. */
const MCP_CONTAINER_KEYS = [
  'mcpServers',
  'mcp_servers',
  'servers',
  'context_servers',
  'contextServers',
];

/**
 * Kinds whose contents configure an MCP client.
 *
 * Restricting harvesting to these keeps `catalog` files — which list every
 * server a marketplace offers — out of the inventory.
 */
const MCP_BEARING_KINDS = new Set<FileKind>(['mcp', 'settings', 'extension']);

/** Kinds that represent an invocable capability. */
const CAPABILITY_KINDS = new Set<FileKind>(['agent', 'skill', 'command', 'prompt', 'chatmode']);

/** Kinds that represent behavioural guidance. */
const INSTRUCTION_KINDS = new Set<FileKind>(['instructions']);

/**
 * Reads and cross-references every discovered file.
 *
 * Files marked `credential-store` are never read; they are reported as
 * findings so the user knows they exist without their contents entering the
 * process.
 */
export async function aggregate(
  scan: ScanResult,
  options: AggregateOptions = {},
): Promise<HarnessInventory> {
  const load = options.loadContent ?? defaultLoader;
  const concurrency = Math.max(1, options.concurrency ?? 16);

  const mcpDefinitions = new Map<string, McpDefinition[]>();
  const instructions: InstructionEntry[] = [];
  const capabilities: CapabilityEntry[] = [];
  const guardrails: GuardrailEntry[] = [];
  const findings: HealthFinding[] = [];
  const parsedFileIds: string[] = [];

  const pendingLoads = new Map<number, Promise<string | undefined>>();
  const scheduleLoad = (index: number): void => {
    const file = scan.files[index];
    if (!file || file.sensitivity === 'credential-store' || file.hash === '') return;
    pendingLoads.set(index, load(file));
  };
  for (let index = 0; index < Math.min(concurrency, scan.files.length); index += 1) {
    scheduleLoad(index);
  }

  for (const [index, file] of scan.files.entries()) {
    const textPromise = pendingLoads.get(index);
    pendingLoads.delete(index);

    if (file.sensitivity === 'credential-store') {
      scheduleLoad(index + concurrency);
      findings.push({
        id: `credential-store:${file.id}`,
        code: 'credential-store',
        severity: 'info',
        title: `${file.providerName} stores credentials here`,
        detail: `${file.displayPath} holds authentication material. Its contents are never read or displayed.`,
        fileIds: [file.id],
        displayPaths: [file.displayPath],
      });
      continue;
    }

    if (file.deprecated) {
      findings.push({
        id: `deprecated:${file.id}`,
        code: 'deprecated-format',
        severity: 'info',
        title: `${file.name} uses a superseded location`,
        detail: `${file.displayPath} still works but its tool has moved on.`,
        fileIds: [file.id],
        displayPaths: [file.displayPath],
        ...(file.note !== undefined ? { remediation: file.note } : {}),
      });
    }

    if (file.hash === '') {
      scheduleLoad(index + concurrency);
      continue;
    }

    const text = await textPromise;
    scheduleLoad(index + concurrency);
    if (text === undefined) continue;

    if (text.trim().length === 0) {
      findings.push({
        id: `empty:${file.id}`,
        code: 'empty-file',
        severity: 'info',
        title: `${file.name} is empty`,
        detail: `${file.displayPath} exists but has no content, so it has no effect.`,
        fileIds: [file.id],
        displayPaths: [file.displayPath],
        remediation: 'Remove the file or fill it in.',
      });
      continue;
    }

    const parsed = parseContent(text, file.format);
    parsedFileIds.push(file.id);

    // The parsers here are deliberately tolerant so a broken file still
    // renders, but the tool that owns the file is not. Any syntax issue in a
    // structured format means that tool is almost certainly rejecting the
    // file outright, so it is reported as an error rather than a nicety.
    if (parsed.issues.length > 0) {
      const first = parsed.issues[0];
      const structured = STRUCTURED_FORMATS.has(file.format);
      const where = first?.line !== undefined ? ` (line ${first.line})` : '';
      findings.push({
        id: `unparseable:${file.id}`,
        code: 'unparseable-file',
        severity: structured ? 'error' : 'warning',
        title: structured
          ? `${file.name} has invalid ${file.format.toUpperCase()} syntax`
          : `${file.name} has invalid front matter`,
        detail: `${file.displayPath}${where}: ${first?.message ?? 'invalid content'}`,
        fileIds: [file.id],
        displayPaths: [file.displayPath],
        remediation: structured
          ? `Fix the syntax; ${file.providerName} is very likely ignoring this file.`
          : 'Fix the YAML front matter so the document metadata is applied.',
      });
    }

    if (MCP_BEARING_KINDS.has(file.kind)) {
      collectMcpDefinitions(file, parsed.value, mcpDefinitions);
    }

    if (INSTRUCTION_KINDS.has(file.kind)) {
      instructions.push(buildInstruction(file, text, parsed.frontmatter, parsed.body ?? text));
    }

    if (CAPABILITY_KINDS.has(file.kind)) {
      capabilities.push(buildCapability(file, parsed.frontmatter, parsed.body ?? text));
    }

    const guardrail = buildGuardrail(file, parsed.value, text);
    if (guardrail) guardrails.push(guardrail);

    const secretPaths = file.kind === 'catalog' ? [] : findPlaintextSecrets(parsed.value);
    if (secretPaths.length > 0) {
      findings.push({
        id: `secret:${file.id}`,
        code: 'plaintext-secret',
        severity: 'warning',
        title: `${file.name} contains credential-looking values`,
        detail: `${file.displayPath} has ${secretPaths.length} value${
          secretPaths.length === 1 ? '' : 's'
        } that look like secrets (${secretPaths.slice(0, 3).join(', ')}${
          secretPaths.length > 3 ? ', …' : ''
        }). They are masked in this app.`,
        fileIds: [file.id],
        displayPaths: [file.displayPath],
        remediation:
          'Move the value into an environment variable or a secret manager and reference it instead.',
      });
    }

    if (file.providerId === 'unattributed') {
      findings.push({
        id: `unattributed:${file.id}`,
        code: 'unattributed-file',
        severity: 'info',
        title: `${file.name} is not claimed by a known tool`,
        detail: `${file.displayPath} looks like harness configuration but no supported tool declares this path.`,
        fileIds: [file.id],
        displayPaths: [file.displayPath],
      });
    }
  }

  for (const problem of scan.problems) {
    findings.push({
      id: `scan-problem:${problem.path}:${problem.code}`,
      code: 'scan-problem',
      severity: problem.code === 'permission-denied' ? 'warning' : 'info',
      title: describeProblem(problem.code),
      detail: `${problem.path}: ${problem.message}`,
      fileIds: [],
      displayPaths: [problem.path],
      remediation:
        problem.code === 'permission-denied'
          ? 'Run with an account that can read this path, or exclude it.'
          : undefined,
    });
  }

  const mcpServers = buildMcpEntries(mcpDefinitions);
  findings.push(...mcpFindings(mcpServers));

  instructions.sort(
    (a, b) => b.precedence - a.precedence || a.displayPath.localeCompare(b.displayPath),
  );
  capabilities.sort(
    (a, b) => a.providerId.localeCompare(b.providerId) || a.name.localeCompare(b.name),
  );
  guardrails.sort((a, b) => a.displayPath.localeCompare(b.displayPath));
  findings.sort(
    (a, b) => severityRank(b.severity) - severityRank(a.severity) || a.id.localeCompare(b.id),
  );

  const definitionCount = mcpServers.reduce((sum, entry) => sum + entry.definitions.length, 0);

  return {
    summary: {
      providerCount: scan.detectedProviders.length,
      fileCount: scan.files.length,
      mcpServerCount: mcpServers.length,
      mcpDefinitionCount: definitionCount,
      instructionCount: instructions.length,
      capabilityCount: capabilities.length,
      guardrailCount: guardrails.length,
      findingCount: findings.length,
      errorCount: findings.filter((f) => f.severity === 'error').length,
      warningCount: findings.filter((f) => f.severity === 'warning').length,
      totalBytes: scan.files.reduce((sum, f) => sum + f.size, 0),
    },
    mcpServers,
    instructions,
    capabilities,
    guardrails,
    findings,
    parsedFileIds,
  };
}

async function defaultLoader(file: DiscoveredFile): Promise<string | undefined> {
  try {
    return await readRegularText(file.path, 8 * 1024 * 1024);
  } catch {
    return undefined;
  }
}

function describeProblem(code: string): string {
  switch (code) {
    case 'permission-denied':
      return 'A path could not be read';
    case 'too-large':
      return 'A file was too large to inspect';
    default:
      return 'A path could not be scanned';
  }
}

function severityRank(severity: FindingSeverity): number {
  return severity === 'error' ? 2 : severity === 'warning' ? 1 : 0;
}

/* ------------------------------------------------------------------ MCP -- */

/**
 * Walks a parsed config looking for MCP server maps.
 *
 * Tools disagree about where the map lives (`mcpServers`, `servers`,
 * `mcp_servers`, `context_servers`) and Claude Code additionally nests
 * per-project maps under `projects`, so both the top level and one level of
 * project nesting are inspected.
 */
function collectMcpDefinitions(
  file: DiscoveredFile,
  value: unknown,
  out: Map<string, McpDefinition[]>,
): void {
  if (!isRecord(value)) return;

  for (const key of MCP_CONTAINER_KEYS) {
    addServersFrom(file, value[key], out, undefined);
  }

  // Docker's MCP Toolkit registry keys servers directly under `registry`.
  if (file.providerId === 'docker') {
    addServersFrom(file, value['registry'], out, undefined);
  }

  // `~/.claude.json` carries a per-project map keyed by absolute path.
  const projects = value['projects'];
  if (isRecord(projects)) {
    for (const [projectPath, projectValue] of Object.entries(projects)) {
      if (!isRecord(projectValue)) continue;
      for (const key of MCP_CONTAINER_KEYS) {
        addServersFrom(file, projectValue[key], out, projectPath);
      }
    }
  }
}

function addServersFrom(
  file: DiscoveredFile,
  container: unknown,
  out: Map<string, McpDefinition[]>,
  projectPath: string | undefined,
): void {
  if (Array.isArray(container)) {
    // Continue's YAML form is a list of objects that carry their own name.
    for (const item of container) {
      if (!isRecord(item)) continue;
      const name = typeof item['name'] === 'string' ? item['name'] : undefined;
      if (!name) continue;
      push(out, name, buildDefinition(file, item, projectPath));
    }
    return;
  }

  if (!isRecord(container)) return;
  for (const [name, definition] of Object.entries(container)) {
    if (!isRecord(definition)) continue;
    push(out, name, buildDefinition(file, definition, projectPath));
  }
}

function push(out: Map<string, McpDefinition[]>, name: string, definition: McpDefinition): void {
  const list = out.get(name);
  if (list) list.push(definition);
  else out.set(name, [definition]);
}

function buildDefinition(
  file: DiscoveredFile,
  raw: Record<string, unknown>,
  projectPath: string | undefined,
): McpDefinition {
  const command = firstString(raw, ['command', 'cmd', 'executable']);
  const rawUrl = firstString(raw, ['url', 'serverUrl', 'httpUrl', 'endpoint', 'uri']);
  const reference = firstString(raw, ['ref', 'reference']);
  const rawArgs = stringArray(raw['args']);

  // Masked before anything downstream sees them, including the signature.
  // Folding secrets out of the signature is deliberate: two definitions of one
  // server that differ only by API key are a duplicate, not a conflict — the
  // same reasoning that keeps `env` out of the signature.
  const args = maskArgs(rawArgs);
  const url = rawUrl === undefined ? undefined : maskUrl(rawUrl);

  const env = isRecord(raw['env'])
    ? raw['env']
    : isRecord(raw['environment'])
      ? raw['environment']
      : undefined;
  const envKeys = env ? Object.keys(env).sort() : [];

  const declaredType = firstString(raw, ['type', 'transport'])?.toLowerCase();
  const transport = resolveTransport(declaredType, command, url, reference);

  const disabled =
    raw['disabled'] === true ||
    raw['enabled'] === false ||
    (isRecord(raw['metadata']) && raw['metadata']['disabled'] === true);

  const hasInlineSecret = containsSecretLiteral(raw);
  const safeCommand = command === undefined ? undefined : maskScalar(command);
  const safeReference = reference === undefined ? undefined : maskScalar(reference);
  const signature = signatureOf(transport, safeCommand, args, url, safeReference);

  return {
    fileId: file.id,
    filePath: file.path,
    displayPath: file.displayPath,
    providerId: file.providerId,
    providerName: file.providerName,
    scope: file.scope,
    ...(projectPath !== undefined
      ? { projectRoot: projectPath }
      : file.projectRoot !== undefined
        ? { projectRoot: file.projectRoot }
        : {}),
    transport,
    ...(safeCommand !== undefined ? { command: safeCommand } : {}),
    ...(args.length > 0 ? { args } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(safeReference !== undefined ? { reference: safeReference } : {}),
    envKeys,
    hasInlineSecret,
    disabled,
    signature,
  };
}

function resolveTransport(
  declared: string | undefined,
  command: string | undefined,
  url: string | undefined,
  reference: string | undefined,
): McpTransport {
  if (declared === 'stdio' || declared === 'local') return 'stdio';
  if (declared === 'sse') return 'sse';
  if (declared === 'http' || declared === 'streamable-http' || declared === 'streamablehttp') {
    return 'http';
  }
  if (declared === 'ws' || declared === 'websocket') return 'websocket';
  if (command) return 'stdio';
  if (url) return url.startsWith('ws') ? 'websocket' : 'http';
  // A catalog reference is launched by the tool's own gateway, which speaks
  // stdio even though no command appears in the file.
  if (reference) return 'stdio';
  return 'unknown';
}

/**
 * Two definitions are "the same server" when they agree on transport and on
 * whatever identifies the endpoint. Environment values are deliberately
 * excluded so a differing API key does not read as a conflict.
 */
function signatureOf(
  transport: McpTransport,
  command: string | undefined,
  args: readonly string[],
  url: string | undefined,
  reference: string | undefined,
): string {
  let canonical: string;
  if (transport === 'stdio') {
    canonical =
      !command && reference
        ? `ref|${reference}`
        : `stdio|${normalizeCommand(command)}|${args.join(' ')}`;
  } else {
    canonical = `${transport}|${(url ?? '').replace(/\/+$/, '')}`;
  }
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

function maskScalar(value: string): string {
  return detectSecretValue(value) === undefined ? value : REDACTED_PLACEHOLDER;
}

/** Strips directory and extension so `npx` and `/usr/bin/npx.cmd` match. */
function normalizeCommand(command: string | undefined): string {
  if (!command) return '';
  const base = command.split(/[\\/]/).pop() ?? command;
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
}

/**
 * Masks credentials embedded in an argument vector.
 *
 * Inline secrets in `args` are common — `-e GITHUB_TOKEN=ghp_…`,
 * `--api-key sk-…`, `Authorization: Bearer …`. These values reach the MCP
 * table and the export, both of which users share, so they are masked here
 * rather than at the view layer: masking in one place means no future caller
 * of the inventory can leak them by accident.
 */
function maskArgs(args: readonly string[]): string[] {
  let maskNext = false;

  return args.map((arg) => {
    if (maskNext) {
      maskNext = false;
      // A flag-style follower is the next flag, not the flag's value.
      if (!arg.startsWith('-') && !isPlaceholderValue(arg)) return REDACTED_PLACEHOLDER;
    }

    // Header-style pairs are commonly passed as one argument:
    // `Authorization: ****** They must be masked before the bare-flag
    // branch, which otherwise treats the whole string as a key.
    const colon = arg.indexOf(':');
    if (colon > 0) {
      const name = arg.slice(0, colon).trim().replace(/^-+/, '');
      const value = arg.slice(colon + 1).trim();
      if (
        value.length > 0 &&
        !isPlaceholderValue(value) &&
        (isSecretKey(name) || detectSecretValue(value) !== undefined)
      ) {
        return `${arg.slice(0, colon + 1)} ${REDACTED_PLACEHOLDER}`;
      }
    }

    // `--api-key=sk-…` and `KEY=value` both split on the first `=`.
    const equals = arg.indexOf('=');
    if (equals > 0) {
      const name = arg.slice(0, equals).replace(/^-+/, '');
      const value = arg.slice(equals + 1);
      if (value.length > 0 && !isPlaceholderValue(value)) {
        const maskedPair = maskInlinePair(value);
        if (maskedPair !== value) return `${arg.slice(0, equals)}=${maskedPair}`;
        if (isSecretKey(name) || detectSecretValue(value) !== undefined) {
          return `${arg.slice(0, equals)}=${REDACTED_PLACEHOLDER}`;
        }
      }
      return arg;
    }

    if (isSecretKey(arg.replace(/^-+/, ''))) {
      maskNext = true;
      return arg;
    }

    return detectSecretValue(arg) !== undefined ? REDACTED_PLACEHOLDER : arg;
  });
}

function maskInlinePair(value: string): string {
  const colon = value.indexOf(':');
  if (colon <= 0) return value;
  const name = value.slice(0, colon).trim();
  const credential = value.slice(colon + 1).trim();
  if (
    credential.length === 0 ||
    isPlaceholderValue(credential) ||
    (!isSecretKey(name) && detectSecretValue(credential) === undefined)
  ) {
    return value;
  }
  return `${value.slice(0, colon + 1)} ${REDACTED_PLACEHOLDER}`;
}

/**
 * Masks credentials carried in a URL's query string or userinfo.
 *
 * Hosted MCP endpoints often authenticate with `?api_key=…`, and the path is
 * kept intact so the server is still recognizable.
 */
function maskUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return detectSecretValue(url) !== undefined ? REDACTED_PLACEHOLDER : url;
  }

  let changed = false;
  for (const [name, value] of [...parsed.searchParams]) {
    if (value.length === 0 || isPlaceholderValue(value)) continue;
    if (isSecretKey(name) || detectSecretValue(value) !== undefined) {
      parsed.searchParams.set(name, REDACTED_PLACEHOLDER);
      changed = true;
    }
  }

  if (parsed.password !== '') {
    parsed.password = REDACTED_PLACEHOLDER;
    changed = true;
  }

  return changed ? parsed.toString() : url;
}

function buildMcpEntries(definitions: Map<string, McpDefinition[]>): McpServerEntry[] {
  const entries: McpServerEntry[] = [];

  for (const [name, defs] of definitions) {
    const providerIds = [...new Set(defs.map((d) => d.providerId))].sort();
    const signatures = new Set(defs.map((d) => d.signature));
    entries.push({
      name,
      definitions: defs,
      providerIds,
      conflicting: signatures.size > 1,
      duplicated: defs.length > 1,
    });
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

function mcpFindings(entries: readonly McpServerEntry[]): HealthFinding[] {
  const findings: HealthFinding[] = [];

  for (const entry of entries) {
    if (entry.conflicting) {
      findings.push({
        id: `mcp-conflict:${entry.name}`,
        code: 'mcp-conflict',
        severity: 'error',
        title: `"${entry.name}" resolves differently per tool`,
        detail: `${entry.definitions.length} definitions of "${entry.name}" disagree about how to start the server: ${[
          ...new Set(entry.definitions.map(describeDefinition)),
        ].join(' vs ')}.`,
        fileIds: entry.definitions.map((d) => d.fileId),
        displayPaths: [...new Set(entry.definitions.map((d) => d.displayPath))],
        remediation:
          'Pick the definition you want and make the others match, or rename one server so the two are clearly distinct.',
      });
    } else if (entry.duplicated) {
      findings.push({
        id: `mcp-duplicate:${entry.name}`,
        code: 'mcp-duplicate',
        severity: 'info',
        title: `"${entry.name}" is defined ${entry.definitions.length} times`,
        detail: `The same server is declared identically in ${[
          ...new Set(entry.definitions.map((d) => d.displayPath)),
        ].join(', ')}.`,
        fileIds: entry.definitions.map((d) => d.fileId),
        displayPaths: [...new Set(entry.definitions.map((d) => d.displayPath))],
        remediation:
          'Harmless, but consolidating to one place makes future changes easier to keep in sync.',
      });
    }
  }

  return findings;
}

function describeDefinition(definition: McpDefinition): string {
  if (definition.transport === 'stdio') {
    if (!definition.command && definition.reference) return definition.reference;
    return `${definition.command ?? '(no command)'} ${(definition.args ?? []).join(' ')}`.trim();
  }
  return definition.url ?? `(${definition.transport} with no url)`;
}

/* --------------------------------------------------------- Instructions -- */

function buildInstruction(
  file: DiscoveredFile,
  text: string,
  frontmatter: Record<string, unknown> | undefined,
  body: string,
): InstructionEntry {
  const description = frontmatter
    ? firstString(frontmatter, ['description', 'summary'])
    : undefined;
  const appliesTo = frontmatter
    ? firstString(frontmatter, ['applyTo', 'apply_to', 'globs', 'glob'])
    : undefined;

  return {
    fileId: file.id,
    displayPath: file.displayPath,
    providerId: file.providerId,
    providerName: file.providerName,
    scope: file.scope,
    ...(file.projectRoot !== undefined ? { projectRoot: file.projectRoot } : {}),
    title: instructionTitle(file, frontmatter, body),
    ...(description !== undefined ? { description } : {}),
    ...(appliesTo !== undefined ? { appliesTo } : {}),
    bytes: file.size,
    lineCount: countLines(text),
    precedence: precedenceOf(file.scope),
  };
}

function instructionTitle(
  file: DiscoveredFile,
  frontmatter: Record<string, unknown> | undefined,
  body: string,
): string {
  const declared = frontmatter ? firstString(frontmatter, ['title', 'name']) : undefined;
  if (declared) return declared;
  const heading = /^\s*#\s+(.+)$/m.exec(body);
  if (heading?.[1]) return heading[1].trim();
  return file.name;
}

/** Project guidance overrides user guidance, which overrides managed defaults. */
function precedenceOf(scope: ConfigScope): number {
  switch (scope) {
    case 'project':
      return 3;
    case 'user':
      return 2;
    default:
      return 1;
  }
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let count = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) count += 1;
  }
  return count;
}

/* --------------------------------------------------------- Capabilities -- */

function buildCapability(
  file: DiscoveredFile,
  frontmatter: Record<string, unknown> | undefined,
  body: string,
): CapabilityEntry {
  const declaredName = frontmatter ? firstString(frontmatter, ['name', 'title']) : undefined;
  const description = frontmatter
    ? firstString(frontmatter, ['description', 'summary'])
    : undefined;
  const model = frontmatter ? firstString(frontmatter, ['model']) : undefined;
  const tools = frontmatter ? toolList(frontmatter['tools']) : [];

  return {
    fileId: file.id,
    displayPath: file.displayPath,
    providerId: file.providerId,
    providerName: file.providerName,
    scope: file.scope,
    kind: file.kind as CapabilityEntry['kind'],
    name: declaredName ?? capabilityNameFromFile(file.name) ?? headingOf(body) ?? file.name,
    ...(description !== undefined ? { description } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(model !== undefined ? { model } : {}),
  };
}

/**
 * Derives an invocation name from a file name, dropping the compound
 * extensions these tools use (`review.prompt.md` invokes as `review`).
 */
function capabilityNameFromFile(fileName: string): string | undefined {
  const stripped = fileName.replace(
    /\.(prompt|instructions|chatmode|agent|skill|toolsets)?\.(md|markdown|mdc|json|jsonc|yaml|yml|toml)$/i,
    '',
  );
  return stripped.length > 0 && stripped !== fileName ? stripped : undefined;
}

function headingOf(body: string): string | undefined {
  const heading = /^\s*#\s+(.+)$/m.exec(body);
  return heading?.[1]?.trim();
}

function toolList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  }
  return [];
}

/* ----------------------------------------------------------- Guardrails -- */

/**
 * Extracts permission rules, hooks, and ignore patterns.
 *
 * Returns `undefined` when a file declares nothing relevant, so settings files
 * that only carry preferences do not clutter the guardrail view.
 */
function buildGuardrail(
  file: DiscoveredFile,
  value: unknown,
  text: string,
): GuardrailEntry | undefined {
  if (file.kind === 'ignore') {
    const patterns = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
    if (patterns.length === 0) return undefined;
    return {
      fileId: file.id,
      displayPath: file.displayPath,
      providerId: file.providerId,
      providerName: file.providerName,
      scope: file.scope,
      kind: 'ignore',
      allow: [],
      deny: [],
      ask: [],
      hooks: [],
      ignorePatterns: patterns,
    };
  }

  if (file.kind !== 'permissions' && file.kind !== 'settings') return undefined;
  if (!isRecord(value)) return undefined;

  const permissions = isRecord(value['permissions']) ? value['permissions'] : value;
  const allow = stringArray(permissions['allow']);
  const deny = stringArray(permissions['deny']).concat(stringArray(permissions['denied']));
  const ask = stringArray(permissions['ask']);
  const hooks = isRecord(value['hooks']) ? Object.keys(value['hooks']).sort() : [];

  if (allow.length === 0 && deny.length === 0 && ask.length === 0 && hooks.length === 0) {
    return undefined;
  }

  return {
    fileId: file.id,
    displayPath: file.displayPath,
    providerId: file.providerId,
    providerName: file.providerName,
    scope: file.scope,
    kind: file.kind,
    allow,
    deny,
    ask,
    hooks,
    ignorePatterns: [],
  };
}

/* -------------------------------------------------------------- Secrets -- */

/** Depth limit for the plaintext-secret walk; configs are never deeper. */
const MAX_SECRET_DEPTH = 12;

/**
 * Returns dotted paths to values that look like live credentials.
 *
 * Only the *paths* are returned — never the values — so a finding can be
 * displayed without leaking the secret it is warning about.
 */
function findPlaintextSecrets(value: unknown): string[] {
  const hits: string[] = [];
  const seen = new WeakSet<object>();

  const walk = (node: unknown, path: string, depth: number): void => {
    if (depth > MAX_SECRET_DEPTH || hits.length >= 25) return;

    if (typeof node === 'string') {
      if (detectSecretValue(node) && !isPlaceholder(node)) hits.push(path || '(root)');
      return;
    }

    if (Array.isArray(node)) {
      if (seen.has(node)) return;
      seen.add(node);
      node.forEach((item, index) => walk(item, `${path}[${index}]`, depth + 1));
      return;
    }

    if (isRecord(node)) {
      if (seen.has(node)) return;
      seen.add(node);
      for (const [key, child] of Object.entries(node)) {
        const childPath = path ? `${path}.${key}` : key;
        if (typeof child === 'string' && isSecretKey(key) && child.length > 0) {
          if (!isPlaceholder(child)) hits.push(childPath);
          continue;
        }
        walk(child, childPath, depth + 1);
      }
    }
  };

  walk(value, '', 0);
  return hits;
}

/**
 * Recognises the conventional stand-ins people write instead of a real
 * secret, so `"apiKey": "${input:my-key}"` does not raise a false alarm.
 */
const isPlaceholder = isPlaceholderValue;

/** True when the record embeds a credential-looking literal anywhere shallow. */
function containsSecretLiteral(raw: Record<string, unknown>): boolean {
  return findPlaintextSecrets(raw).length > 0;
}

/* --------------------------------------------------------------- Utils -- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstString(source: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}
