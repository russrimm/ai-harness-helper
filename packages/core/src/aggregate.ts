/**
 * Turns a raw scan into the synthesized views that answer "what does my
 * agentic harness actually look like?".
 *
 * The scanner tells you which files exist. This module reads them, extracts
 * the meaningful declarations inside, and cross-references those declarations
 * across every tool so duplicates and conflicts become visible.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { detectMcpOverlaps } from './overlap.js';
import { mapConcurrent } from './concurrency.js';
import { parseContent } from './parsers.js';
import {
  REDACTED_PLACEHOLDER,
  detectSecretValue,
  isPlaceholderValue,
  isSecretKey,
} from './redact.js';
import type { McpOverlapGroup } from './overlap.js';
import type { DiscoveredFile, ScanResult } from './scanner.js';
import type { ConfigScope, FileFormat, FileKind } from './types.js';

/** How an MCP client reaches a server. */
export type McpTransport = 'stdio' | 'http' | 'sse' | 'websocket' | 'unknown';

/**
 * Where a declaration came from.
 *
 * Every synthesized entry carries this, because the product's core promise is
 * that you can always tell which tool, which file, and which folder a setting
 * is coming from without going hunting for it.
 */
export interface EntryProvenance {
  /** Id of the file that declares it. */
  readonly fileId: string;
  readonly filePath: string;
  readonly displayPath: string;
  /** Containing folder, home-abbreviated. */
  readonly directory: string;
  readonly fileName: string;
  readonly providerId: string;
  readonly providerName: string;
  /** Registry location that produced the file, e.g. "Global agents". */
  readonly locationLabel: string;
  readonly scope: ConfigScope;
}

/**
 * How one entry relates to others that declare the same thing.
 *
 * `duplicated` is deliberately generous — any repeat of a name is surfaced, so
 * the user sees every copy — while `conflicting` is deliberately strict: it
 * only fires when a *single tool at a single scope* would see two different
 * definitions and have to pick one. That split keeps the badges informative
 * without turning legitimate layering (a project `AGENTS.md` refining a user
 * one) into a false alarm.
 */
export interface DuplicateInfo {
  /** Normalized identity, e.g. `agent:reviewer`. */
  readonly key: string;
  /** True when more than one file declares this key. */
  readonly duplicated: boolean;
  /** True when one tool sees two differing definitions of this key. */
  readonly conflicting: boolean;
  /** Other files declaring the same key. */
  readonly siblingFileIds: readonly string[];
  readonly siblingDisplayPaths: readonly string[];
  /** Files whose content is byte-identical, whatever they are named. */
  readonly identicalFileIds: readonly string[];
}

/** One MCP server definition, as declared by a single file. */
export interface McpDefinition {
  /** Id of the file that declares it. */
  readonly fileId: string;
  readonly filePath: string;
  readonly displayPath: string;
  /** Containing folder, home-abbreviated. */
  readonly directory: string;
  readonly fileName: string;
  readonly providerId: string;
  readonly providerName: string;
  /** Registry location that produced the file. */
  readonly locationLabel: string;
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
  /** Distinct folders the definitions live in, for at-a-glance provenance. */
  readonly directories: readonly string[];
  /** True when two or more definitions disagree about what the server is. */
  readonly conflicting: boolean;
  /** True when more than one file declares this name. */
  readonly duplicated: boolean;
}

/** An instruction document that shapes agent behaviour. */
export interface InstructionEntry extends EntryProvenance {
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
  /** How this document relates to others with the same title or content. */
  readonly duplicate: DuplicateInfo;
}

/** An agent, skill, command, prompt, or chat mode the harness can invoke. */
export interface CapabilityEntry extends EntryProvenance {
  readonly kind: Extract<FileKind, 'agent' | 'skill' | 'command' | 'prompt' | 'chatmode'>;
  /** Invocation name, derived from front matter or the file name. */
  readonly name: string;
  readonly description?: string;
  /** Tools the capability declares, when it declares any. */
  readonly tools?: readonly string[];
  readonly model?: string;
  readonly projectRoot?: string;
  /** How this capability relates to others with the same name or content. */
  readonly duplicate: DuplicateInfo;
}

/** A permission rule, hook, or ignore file constraining agent behaviour. */
export interface GuardrailEntry extends EntryProvenance {
  readonly kind: Extract<FileKind, 'permissions' | 'ignore' | 'settings'>;
  readonly allow: readonly string[];
  readonly deny: readonly string[];
  readonly ask: readonly string[];
  /** Names of lifecycle hooks declared in the file. */
  readonly hooks: readonly string[];
  /** Ignore-file patterns. */
  readonly ignorePatterns: readonly string[];
  readonly projectRoot?: string;
  /** How this guardrail relates to others with the same name or content. */
  readonly duplicate: DuplicateInfo;
}

/** Severity of a health finding. */
export type FindingSeverity = 'info' | 'warning' | 'error';

/** Machine-detected issue category. */
export type FindingCode =
  | 'mcp-duplicate'
  | 'mcp-conflict'
  | 'mcp-overlap'
  | 'capability-duplicate'
  | 'capability-conflict'
  | 'instruction-duplicate'
  | 'instruction-conflict'
  | 'guardrail-duplicate'
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
  /** Groups of differently named servers that appear to do the same job. */
  readonly mcpOverlapCount: number;
  readonly instructionCount: number;
  readonly capabilityCount: number;
  readonly guardrailCount: number;
  readonly findingCount: number;
  readonly errorCount: number;
  readonly warningCount: number;
  /** Distinct names declared in more than one file, across every entity type. */
  readonly duplicateCount: number;
  /** Duplicate groups where one tool would see two differing definitions. */
  readonly conflictCount: number;
  /** Distinct folders configuration was found in. */
  readonly directoryCount: number;
  readonly totalBytes: number;
}

/** The complete synthesized view of a harness. */
export interface HarnessInventory {
  readonly summary: HarnessSummary;
  readonly mcpServers: readonly McpServerEntry[];
  /** Functional overlap between servers with different names. */
  readonly mcpOverlaps: readonly McpOverlapGroup[];
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
}

/** Formats a tool parses strictly, where any syntax error breaks the file. */
const STRUCTURED_FORMATS = new Set<FileFormat>(['json', 'jsonc', 'toml', 'yaml']);

/**
 * Keys under which tools nest their MCP server maps.
 *
 * Exported because removal has to look in exactly the same places harvesting
 * does; two lists that could drift apart would mean the UI offering to delete
 * a server it cannot actually find.
 */
export const MCP_CONTAINER_KEYS: readonly string[] = [
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
const FILE_READ_CONCURRENCY = 8;

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

  const mcpDefinitions = new Map<string, McpDefinition[]>();
  const instructionDrafts: InstructionDraft[] = [];
  const capabilityDrafts: CapabilityDraft[] = [];
  const guardrailDrafts: GuardrailDraft[] = [];
  const findings: HealthFinding[] = [];
  const parsedFileIds: string[] = [];
  /** Content digests keyed by file id, used to tell a copy from a conflict. */
  const contentHashes = new Map<string, string>();
  const contents = await mapConcurrent(scan.files, FILE_READ_CONCURRENCY, async (file) => {
    if (file.sensitivity === 'credential-store') return undefined;
    return load(file);
  });

  for (let index = 0; index < scan.files.length; index += 1) {
    const file = scan.files[index];
    if (!file) continue;
    if (file.sensitivity === 'credential-store') {
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

    const text = contents[index];
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
    contentHashes.set(file.id, digest(text));

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
      instructionDrafts.push(buildInstruction(file, text, parsed.frontmatter, parsed.body ?? text));
    }

    if (CAPABILITY_KINDS.has(file.kind)) {
      capabilityDrafts.push(buildCapability(file, parsed.frontmatter, parsed.body ?? text));
    }

    const guardrail = buildGuardrail(file, parsed.value, text);
    if (guardrail) guardrailDrafts.push(guardrail);

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
  const mcpOverlaps = detectMcpOverlaps(mcpServers);
  findings.push(...mcpFindings(mcpServers), ...overlapFindings(mcpOverlaps));

  const instructions = attachDuplicates(
    instructionDrafts,
    (entry) => `instructions:${normalizeIdentity(entry.title)}`,
    contentHashes,
  );
  const capabilities = attachDuplicates(
    capabilityDrafts,
    (entry) => `${entry.kind}:${normalizeIdentity(entry.name)}`,
    contentHashes,
  );
  const guardrails = attachDuplicates(
    guardrailDrafts,
    (entry) => `${entry.kind}:${normalizeIdentity(entry.fileName)}`,
    contentHashes,
  );

  findings.push(
    ...duplicateFindings(instructions, {
      duplicateCode: 'instruction-duplicate',
      conflictCode: 'instruction-conflict',
      noun: 'instruction document',
      labelOf: (entry) => entry.title,
    }),
    ...duplicateFindings(capabilities, {
      duplicateCode: 'capability-duplicate',
      conflictCode: 'capability-conflict',
      noun: 'capability',
      labelOf: (entry) => `${entry.kind} "${entry.name}"`,
    }),
    ...duplicateFindings(guardrails, {
      duplicateCode: 'guardrail-duplicate',
      noun: 'guardrail file',
      labelOf: (entry) => entry.fileName,
    }),
  );

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
  const duplicateGroups = countDuplicateGroups(mcpServers, instructions, capabilities, guardrails);

  return {
    summary: {
      providerCount: scan.detectedProviders.length,
      fileCount: scan.files.length,
      mcpServerCount: mcpServers.length,
      mcpDefinitionCount: definitionCount,
      mcpOverlapCount: mcpOverlaps.length,
      instructionCount: instructions.length,
      capabilityCount: capabilities.length,
      guardrailCount: guardrails.length,
      findingCount: findings.length,
      errorCount: findings.filter((f) => f.severity === 'error').length,
      warningCount: findings.filter((f) => f.severity === 'warning').length,
      duplicateCount: duplicateGroups.duplicated,
      conflictCount: duplicateGroups.conflicting,
      directoryCount: new Set(scan.files.map((file) => file.directory)).size,
      totalBytes: scan.files.reduce((sum, f) => sum + f.size, 0),
    },
    mcpServers,
    mcpOverlaps,
    instructions,
    capabilities,
    guardrails,
    findings,
    parsedFileIds,
  };
}

/** SHA-256 of a document, used only to compare two documents to each other. */
function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

async function defaultLoader(file: DiscoveredFile): Promise<string | undefined> {
  try {
    return await readFile(file.path, 'utf8');
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

/* ------------------------------------------------------------ Duplicates -- */

/** An entry before duplicate analysis has been attached to it. */
type InstructionDraft = Omit<InstructionEntry, 'duplicate'>;
type CapabilityDraft = Omit<CapabilityEntry, 'duplicate'>;
type GuardrailDraft = Omit<GuardrailEntry, 'duplicate'>;

/** The fields duplicate analysis needs, whatever kind of entry it is. */
interface DuplicateCandidate {
  readonly fileId: string;
  readonly displayPath: string;
  readonly providerId: string;
  readonly scope: ConfigScope;
}

/** Case- and punctuation-insensitive identity, so `Reviewer` matches `reviewer`. */
function normalizeIdentity(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.(md|markdown|mdc|json|jsonc|yaml|yml|toml)$/i, '')
    .replace(/[\s_]+/g, '-');
}

/**
 * Cross-references entries of one type and records how each relates to the
 * others.
 *
 * Two passes are needed rather than one: a name group answers "what else is
 * called this?", and a content group answers "what else *is* this?" — the
 * common case of a single document copied under several names for several
 * tools, which no name comparison would ever catch.
 */
function attachDuplicates<T extends DuplicateCandidate>(
  drafts: readonly T[],
  keyOf: (draft: T) => string,
  hashes: ReadonlyMap<string, string>,
): Array<T & { duplicate: DuplicateInfo }> {
  const byKey = new Map<string, T[]>();
  const byHash = new Map<string, T[]>();

  for (const draft of drafts) {
    const key = keyOf(draft);
    const keyGroup = byKey.get(key);
    if (keyGroup) keyGroup.push(draft);
    else byKey.set(key, [draft]);

    const hash = hashes.get(draft.fileId);
    if (hash === undefined) continue;
    const hashGroup = byHash.get(hash);
    if (hashGroup) hashGroup.push(draft);
    else byHash.set(hash, [draft]);
  }

  return drafts.map((draft) => {
    const key = keyOf(draft);
    const group = byKey.get(key) ?? [draft];
    const siblings = group.filter((other) => other.fileId !== draft.fileId);

    const hash = hashes.get(draft.fileId);
    const identical =
      hash === undefined
        ? []
        : (byHash.get(hash) ?? []).filter(
            (other) => other.fileId !== draft.fileId && keyOf(other) !== key,
          );

    return {
      ...draft,
      duplicate: {
        key,
        duplicated: siblings.length > 0,
        conflicting: groupConflicts(group, hashes),
        siblingFileIds: siblings.map((entry) => entry.fileId),
        siblingDisplayPaths: siblings.map((entry) => entry.displayPath),
        identicalFileIds: identical.map((entry) => entry.fileId),
      },
    };
  });
}

/**
 * True when one tool, at one scope, would see two *different* definitions of
 * the same name.
 *
 * The provider and scope partition matters: a project `AGENTS.md` refining a
 * user-level one is layering the tools are designed for, not a conflict, and
 * reporting it as one would train users to ignore the finding that matters.
 */
function groupConflicts<T extends DuplicateCandidate>(
  group: readonly T[],
  hashes: ReadonlyMap<string, string>,
): boolean {
  const byOwner = new Map<string, Set<string>>();

  for (const entry of group) {
    const hash = hashes.get(entry.fileId);
    if (hash === undefined) continue;
    const owner = `${entry.providerId}|${entry.scope}`;
    const seen = byOwner.get(owner);
    if (seen) seen.add(hash);
    else byOwner.set(owner, new Set([hash]));
  }

  return [...byOwner.values()].some((hashSet) => hashSet.size > 1);
}

interface DuplicateFindingConfig<T> {
  readonly duplicateCode: FindingCode;
  /** Omitted for entity types where "one tool sees two" is not meaningful. */
  readonly conflictCode?: FindingCode;
  readonly noun: string;
  readonly labelOf: (entry: T) => string;
}

/** Turns duplicate analysis into findings, one per group rather than per file. */
function duplicateFindings<T extends DuplicateCandidate & { duplicate: DuplicateInfo }>(
  entries: readonly T[],
  config: DuplicateFindingConfig<T>,
): HealthFinding[] {
  const findings: HealthFinding[] = [];
  const seenKeys = new Set<string>();
  const seenCopies = new Set<string>();
  const byId = new Map(entries.map((entry) => [entry.fileId, entry]));

  for (const entry of entries) {
    const { duplicate } = entry;

    if (duplicate.duplicated && !seenKeys.has(duplicate.key)) {
      seenKeys.add(duplicate.key);
      const fileIds = [entry.fileId, ...duplicate.siblingFileIds];
      const displayPaths = [entry.displayPath, ...duplicate.siblingDisplayPaths];
      const label = config.labelOf(entry);

      if (duplicate.conflicting && config.conflictCode) {
        findings.push({
          id: `${config.conflictCode}:${duplicate.key}`,
          code: config.conflictCode,
          severity: 'warning',
          title: `${label} is defined differently in the same place`,
          detail: `${fileIds.length} files declare ${label} for the same tool and scope, with different content: ${displayPaths.join(', ')}. Which one wins is up to the tool.`,
          fileIds,
          displayPaths,
          remediation: `Keep one ${config.noun} and delete or rename the others.`,
        });
      } else {
        findings.push({
          id: `${config.duplicateCode}:${duplicate.key}`,
          code: config.duplicateCode,
          severity: 'info',
          title: `${label} is declared in ${fileIds.length} places`,
          detail: `${displayPaths.join(', ')} all declare ${label}.`,
          fileIds,
          displayPaths,
          remediation:
            'Expected when several tools need the same thing; consolidating makes future edits easier to keep in sync.',
        });
      }
    }

    if (duplicate.identicalFileIds.length === 0) continue;

    const copyGroup = [entry.fileId, ...duplicate.identicalFileIds].sort();
    const copyKey = copyGroup.join('+');
    if (seenCopies.has(copyKey)) continue;
    seenCopies.add(copyKey);

    const copyPaths = copyGroup.map((id) => byId.get(id)?.displayPath ?? id);
    findings.push({
      id: `${config.duplicateCode}:copy:${copyKey}`,
      code: config.duplicateCode,
      severity: 'info',
      title: `${copyGroup.length} ${config.noun}s have identical content`,
      detail: `${copyPaths.join(', ')} are byte-for-byte the same file under different names.`,
      fileIds: copyGroup,
      displayPaths: copyPaths,
      remediation:
        'Usually one document copied for several tools. Edits to one will not reach the others.',
    });
  }

  return findings;
}

/** Counts duplicate and conflicting groups across every entity type. */
function countDuplicateGroups(
  mcpServers: readonly McpServerEntry[],
  ...lists: ReadonlyArray<readonly { duplicate: DuplicateInfo }[]>
): { duplicated: number; conflicting: number } {
  let duplicated = mcpServers.filter((server) => server.duplicated).length;
  let conflicting = mcpServers.filter((server) => server.conflicting).length;

  for (const list of lists) {
    const seen = new Set<string>();
    for (const entry of list) {
      if (!entry.duplicate.duplicated || seen.has(entry.duplicate.key)) continue;
      seen.add(entry.duplicate.key);
      duplicated += 1;
      if (entry.duplicate.conflicting) conflicting += 1;
    }
  }

  return { duplicated, conflicting };
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

  return {
    fileId: file.id,
    filePath: file.path,
    displayPath: file.displayPath,
    directory: file.directory,
    fileName: file.name,
    providerId: file.providerId,
    providerName: file.providerName,
    locationLabel: file.locationLabel,
    scope: file.scope,
    ...(projectPath !== undefined
      ? { projectRoot: projectPath }
      : file.projectRoot !== undefined
        ? { projectRoot: file.projectRoot }
        : {}),
    transport,
    ...(command !== undefined ? { command } : {}),
    ...(args.length > 0 ? { args } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(reference !== undefined ? { reference } : {}),
    envKeys,
    hasInlineSecret,
    disabled,
    signature: signatureOf(transport, command, args, url, reference),
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
  if (transport === 'stdio') {
    if (!command && reference) return `ref|${reference}`;
    return `stdio|${normalizeCommand(command)}|${args.join(' ')}`;
  }
  return `${transport}|${(url ?? '').replace(/\/+$/, '')}`;
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

    // `--api-key=sk-…` and `KEY=value` both split on the first `=`.
    const equals = arg.indexOf('=');
    if (equals > 0) {
      const name = arg.slice(0, equals).replace(/^-+/, '');
      const value = arg.slice(equals + 1);
      if (value.length > 0 && !isPlaceholderValue(value)) {
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
    const directories = [...new Set(defs.map((d) => d.directory))].sort();
    const signatures = new Set(defs.map((d) => d.signature));
    entries.push({
      name,
      definitions: defs,
      providerIds,
      directories,
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

/**
 * Turns overlap groups into findings for the overview.
 *
 * Severity tracks confidence rather than being fixed: "two names, one launch
 * command" is a real problem worth flagging, whereas "both of these look like
 * search servers" is an observation, and presenting the two identically would
 * teach users to ignore both.
 */
function overlapFindings(groups: readonly McpOverlapGroup[]): HealthFinding[] {
  return groups.map((group) => ({
    id: group.id,
    code: 'mcp-overlap' as const,
    severity: group.confidence === 'high' ? ('warning' as const) : ('info' as const),
    title: group.title,
    detail: group.detail,
    fileIds: [...group.fileIds],
    displayPaths: [...group.displayPaths],
    remediation: group.remediation,
  }));
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
): InstructionDraft {
  const description = frontmatter
    ? firstString(frontmatter, ['description', 'summary'])
    : undefined;
  const appliesTo = frontmatter
    ? firstString(frontmatter, ['applyTo', 'apply_to', 'globs', 'glob'])
    : undefined;

  return {
    ...provenanceOf(file),
    ...(file.projectRoot !== undefined ? { projectRoot: file.projectRoot } : {}),
    title: instructionTitle(file, frontmatter, body),
    ...(description !== undefined ? { description } : {}),
    ...(appliesTo !== undefined ? { appliesTo } : {}),
    bytes: file.size,
    lineCount: countLines(text),
    precedence: precedenceOf(file.scope),
  };
}

/** The provenance every synthesized entry carries, in one place. */
function provenanceOf(file: DiscoveredFile): EntryProvenance {
  return {
    fileId: file.id,
    filePath: file.path,
    displayPath: file.displayPath,
    directory: file.directory,
    fileName: file.name,
    providerId: file.providerId,
    providerName: file.providerName,
    locationLabel: file.locationLabel,
    scope: file.scope,
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
): CapabilityDraft {
  const declaredName = frontmatter ? firstString(frontmatter, ['name', 'title']) : undefined;
  const description = frontmatter
    ? firstString(frontmatter, ['description', 'summary'])
    : undefined;
  const model = frontmatter ? firstString(frontmatter, ['model']) : undefined;
  const tools = frontmatter ? toolList(frontmatter['tools']) : [];

  return {
    ...provenanceOf(file),
    ...(file.projectRoot !== undefined ? { projectRoot: file.projectRoot } : {}),
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
): GuardrailDraft | undefined {
  if (file.kind === 'ignore') {
    const patterns = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
    if (patterns.length === 0) return undefined;
    return {
      ...provenanceOf(file),
      ...(file.projectRoot !== undefined ? { projectRoot: file.projectRoot } : {}),
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
    ...provenanceOf(file),
    ...(file.projectRoot !== undefined ? { projectRoot: file.projectRoot } : {}),
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
