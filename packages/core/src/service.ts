/**
 * Stateful facade over the scanner, aggregator, and writer.
 *
 * The server is deliberately thin: it owns transport and authorization, and
 * every decision about *what* a caller may see or change lives here, where it
 * can be tested without a socket.
 */

import { isAbsolute, resolve, sep } from 'node:path';

import { aggregate, type HarnessInventory } from './aggregate.js';
import { editorLanguage, parseContent, type ParseIssue } from './parsers.js';
import { createEnvironment, toDisplayPath } from './paths.js';
import { redactDocumentText, resolveRedactionPath, type RedactionRecord } from './redact.js';
import { readRegularText } from './safe-file.js';
import { groupByProvider, scan, type DiscoveredFile, type ScanResult } from './scanner.js';
import type { ResolverEnvironment } from './types.js';
import { hashContent, writeConfigFile, type WriteOutcome, type WriterOptions } from './writer.js';

/** A file's contents prepared for display or editing. */
export interface FileDocument {
  readonly file: DiscoveredFile;
  /** Content, masked unless secrets were explicitly requested. */
  readonly content: string;
  /** True when `content` still contains live secrets. */
  readonly revealed: boolean;
  /** One record per masked value. Empty when `revealed` is true. */
  readonly redactions: readonly RedactionRecord[];
  /** Hash of the *unmasked* content, for optimistic concurrency on write. */
  readonly hash: string;
  /** Syntax highlighting mode for the editor. */
  readonly language: 'json' | 'yaml' | 'markdown' | 'text';
  /** Parse problems, so a broken file is explained rather than blank. */
  readonly issues: readonly ParseIssue[];
  /** True when the file may not be edited. */
  readonly readOnly: boolean;
  /** Why the file may not be edited. */
  readonly readOnlyReason?: string;
}

/** One hit from a content search. */
export interface SearchHit {
  readonly fileId: string;
  readonly displayPath: string;
  readonly providerId: string;
  readonly providerName: string;
  readonly line: number;
  /** The matching line, with secrets masked. */
  readonly text: string;
}

export interface SearchOptions {
  readonly query: string;
  readonly providerIds?: readonly string[];
  readonly kinds?: readonly string[];
  readonly scopes?: readonly string[];
  readonly limit?: number;
}

export interface SearchResult {
  readonly query: string;
  readonly hits: readonly SearchHit[];
  /** True when results were cut off by the limit. */
  readonly truncated: boolean;
  readonly filesSearched: number;
}

export interface HarnessServiceOptions {
  readonly environment?: ResolverEnvironment;
  readonly projectRoots?: readonly string[];
  readonly readOnly?: boolean;
  readonly writerOptions?: WriterOptions;
}

/** Maximum bytes of a single file returned to the client. */
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;

/** Default cap on search hits, to keep responses bounded. */
const DEFAULT_SEARCH_LIMIT = 200;

export class HarnessService {
  readonly #environment: ResolverEnvironment;
  readonly #readOnly: boolean;
  readonly #writerOptions: WriterOptions;
  #projectRoots: string[];
  #scan: ScanResult | undefined;
  #inventory: HarnessInventory | undefined;
  /** Absolute paths the scan discovered, used as the authorization set. */
  #authorized = new Set<string>();

  constructor(options: HarnessServiceOptions = {}) {
    this.#environment = options.environment ?? createEnvironment();
    this.#readOnly = options.readOnly ?? false;
    this.#writerOptions = options.writerOptions ?? {};
    this.#projectRoots = [...(options.projectRoots ?? [])].map((root) => resolve(root));
  }

  get readOnly(): boolean {
    return this.#readOnly;
  }

  get projectRoots(): readonly string[] {
    return this.#projectRoots;
  }

  /** Re-reads the filesystem and recomputes the inventory. */
  async refresh(signal?: AbortSignal): Promise<ScanResult> {
    const result = await scan({
      environment: this.#environment,
      projectRoots: this.#projectRoots,
      signal,
    });
    signal?.throwIfAborted();
    const inventory = await aggregate(result);
    signal?.throwIfAborted();
    this.#scan = result;
    this.#inventory = inventory;
    this.#authorized = new Set(result.files.map((file) => normalizeKey(file.path)));
    return result;
  }

  /** The last scan, running one first if needed. */
  async getScan(): Promise<ScanResult> {
    return this.#scan ?? (await this.refresh());
  }

  async getInventory(): Promise<HarnessInventory> {
    if (!this.#inventory) await this.refresh();
    // refresh always assigns both, but the compiler cannot know that.
    return this.#inventory as HarnessInventory;
  }

  /** Files grouped by provider, for the browser tree. */
  async getTree(): Promise<ReturnType<typeof groupByProvider>> {
    const result = await this.getScan();
    return groupByProvider(result.files);
  }

  async addProjectRoot(root: string): Promise<readonly string[]> {
    const resolved = resolve(root);
    if (!this.#projectRoots.some((existing) => samePath(existing, resolved))) {
      this.#projectRoots.push(resolved);
      await this.refresh();
    }
    return this.#projectRoots;
  }

  async removeProjectRoot(root: string): Promise<readonly string[]> {
    const resolved = resolve(root);
    const next = this.#projectRoots.filter((existing) => !samePath(existing, resolved));
    if (next.length !== this.#projectRoots.length) {
      this.#projectRoots = next;
      await this.refresh();
    }
    return this.#projectRoots;
  }

  /**
   * True when a path may be read or written.
   *
   * Authorization is allowlist-based: only paths the scan actually produced
   * qualify. A caller cannot reach an arbitrary file by guessing an id or
   * smuggling `..` into a path, because nothing outside the discovered set is
   * ever in the set.
   */
  isAuthorized(path: string): boolean {
    if (!isAbsolute(path)) return false;
    return this.#authorized.has(normalizeKey(path));
  }

  findFile(id: string): DiscoveredFile | undefined {
    return this.#scan?.files.find((file) => file.id === id);
  }

  /**
   * Loads a file for display or editing.
   *
   * `includeSecrets` is what the UI sets when the user enters edit mode. It is
   * required, because handing a *masked* document to an editor and then saving
   * it would write the mask into the user's real configuration — silently
   * destroying the credentials it was trying to protect.
   */
  async getDocument(id: string, includeSecrets = false): Promise<FileDocument | undefined> {
    const file = this.findFile(id);
    if (!file) return undefined;
    if (!this.isAuthorized(file.path)) return undefined;

    const blocked = this.#editBlockReason(file);

    if (file.sensitivity === 'credential-store') {
      return {
        file,
        content: '',
        revealed: false,
        redactions: [],
        hash: file.hash,
        language: editorLanguage(file.format),
        issues: [],
        readOnly: true,
        readOnlyReason: blocked,
      };
    }

    if (file.size > MAX_DOCUMENT_BYTES) {
      return {
        file,
        content: '',
        revealed: false,
        redactions: [],
        hash: file.hash,
        language: editorLanguage(file.format),
        issues: [{ message: `File is too large to display (${formatBytes(file.size)}).` }],
        readOnly: true,
        readOnlyReason: 'Too large to edit here.',
      };
    }

    let text: string;
    try {
      text = await readRegularText(file.path, MAX_DOCUMENT_BYTES);
    } catch (error) {
      return {
        file,
        content: '',
        revealed: false,
        redactions: [],
        hash: file.hash,
        language: editorLanguage(file.format),
        issues: [{ message: `Could not read the file: ${describe(error)}` }],
        readOnly: true,
        readOnlyReason: 'Unreadable.',
      };
    }

    const parsed = parseContent(text, file.format);

    if (includeSecrets) {
      return {
        file,
        content: text,
        revealed: true,
        redactions: [],
        hash: hashContent(text),
        language: editorLanguage(file.format),
        issues: parsed.issues,
        readOnly: blocked !== undefined,
        ...(blocked !== undefined ? { readOnlyReason: blocked } : {}),
      };
    }

    const redacted = redactDocumentText(text, parsed.value);
    return {
      file,
      content: redacted.value,
      revealed: false,
      redactions: redacted.redactions,
      hash: hashContent(text),
      language: editorLanguage(file.format),
      issues: parsed.issues,
      readOnly: blocked !== undefined,
      ...(blocked !== undefined ? { readOnlyReason: blocked } : {}),
    };
  }

  /**
   * Returns a single masked value in the clear.
   *
   * Reveal is per-value and per-request on purpose: nothing is cached, so a
   * revealed secret exists only in the response that asked for it.
   */
  async revealValue(id: string, redactionId: string): Promise<string | undefined> {
    const file = this.findFile(id);
    if (!file || !this.isAuthorized(file.path)) return undefined;
    if (file.sensitivity === 'credential-store') return undefined;

    let text: string;
    try {
      text = await readRegularText(file.path, MAX_DOCUMENT_BYTES);
    } catch {
      return undefined;
    }

    const parsed = parseContent(text, file.format);
    const redacted = redactDocumentText(text, parsed.value);
    const record = redacted.redactions.find((entry) => entry.id === redactionId);
    if (!record) return undefined;

    // `key@line` records point at a line; `lineN[i]` records point at a token.
    if (record.path.includes('@')) return extractFromLine(text, record);

    return resolveRedactionPath(parsed.value, record.path);
  }

  /** Applies an edit, subject to every writer guard. */
  async writeDocument(
    id: string,
    content: string,
    expectedHash: string,
  ): Promise<WriteOutcome | undefined> {
    const file = this.findFile(id);
    if (!file || !this.isAuthorized(file.path)) return undefined;

    const outcome = await writeConfigFile(
      {
        path: file.path,
        content,
        format: file.format,
        sensitivity: file.sensitivity,
        expectedHash,
      },
      { ...this.#writerOptions, readOnly: this.#readOnly },
    );

    // Size, hash, and mtime all changed, and the inventory derived from them
    // is now stale, so the cheapest correct move is a fresh scan.
    if (outcome.ok) await this.refresh();
    return outcome;
  }

  /** Full-text search across discovered files, honouring redaction. */
  async search(options: SearchOptions): Promise<SearchResult> {
    const result = await this.getScan();
    const query = options.query.trim();
    const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;

    if (query.length === 0) {
      return { query, hits: [], truncated: false, filesSearched: 0 };
    }

    const needle = query.toLowerCase();
    const hits: SearchHit[] = [];
    let filesSearched = 0;
    let truncated = false;

    for (const file of result.files) {
      if (!matchesFilters(file, options)) continue;
      if (file.sensitivity === 'credential-store') continue;
      if (file.size > MAX_DOCUMENT_BYTES) continue;

      let text: string;
      try {
        text = await readRegularText(file.path, MAX_DOCUMENT_BYTES);
      } catch {
        continue;
      }
      filesSearched += 1;
      if (!text.toLowerCase().includes(needle)) continue;

      // Redact first, then match on the masked text, so a query can never be
      // used to confirm a secret's contents character by character.
      const parsed = parseContent(text, file.format);
      const masked = redactDocumentText(text, parsed.value).value;
      const lines = masked.split(/\r?\n/);

      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? '';
        if (!line.toLowerCase().includes(needle)) continue;
        if (hits.length >= limit) {
          truncated = true;
          break;
        }
        hits.push({
          fileId: file.id,
          displayPath: file.displayPath,
          providerId: file.providerId,
          providerName: file.providerName,
          line: index + 1,
          text: line.trim().slice(0, 400),
        });
      }
      if (truncated) break;
    }

    return { query, hits, truncated, filesSearched };
  }

  /** Serializable snapshot of the whole harness. */
  async exportJson(): Promise<Record<string, unknown>> {
    const result = await this.getScan();
    const inventory = await this.getInventory();
    return {
      generatedAt: new Date().toISOString(),
      platform: result.platform,
      home: toDisplayPath(result.home, this.#environment),
      projectRoots: this.#projectRoots,
      summary: inventory.summary,
      providers: groupByProvider(result.files).map((group) => ({
        providerId: group.providerId,
        providerName: group.providerName,
        files: group.files.map((file) => ({
          displayPath: file.displayPath,
          scope: file.scope,
          kind: file.kind,
          format: file.format,
          size: file.size,
          modified: file.modified,
        })),
      })),
      mcpServers: inventory.mcpServers,
      instructions: inventory.instructions,
      capabilities: inventory.capabilities,
      guardrails: inventory.guardrails,
      findings: inventory.findings,
      missing: result.missing.length,
      problems: result.problems,
    };
  }

  /** Human-readable report of the whole harness. */
  async exportMarkdown(): Promise<string> {
    const result = await this.getScan();
    const inventory = await this.getInventory();
    const lines: string[] = [];

    lines.push('# Agentic harness report', '');
    lines.push(`Generated ${new Date().toISOString()} on ${result.platform}.`, '');
    lines.push(
      `**${inventory.summary.providerCount}** tools · **${inventory.summary.fileCount}** files · ` +
        `**${inventory.summary.mcpServerCount}** MCP servers · ` +
        `**${inventory.summary.findingCount}** findings`,
      '',
    );

    if (inventory.findings.length > 0) {
      lines.push('## Findings', '');
      for (const finding of inventory.findings) {
        lines.push(`- **[${finding.severity}]** ${finding.title} — ${finding.detail}`);
        if (finding.remediation) lines.push(`  - ${finding.remediation}`);
      }
      lines.push('');
    }

    if (inventory.mcpServers.length > 0) {
      lines.push('## MCP servers', '');
      lines.push('| Server | Transport | Defined by | Status |');
      lines.push('| --- | --- | --- | --- |');
      for (const server of inventory.mcpServers) {
        const status = server.conflicting ? 'conflict' : server.duplicated ? 'duplicate' : 'ok';
        lines.push(
          `| ${server.name} | ${server.definitions[0]?.transport ?? 'unknown'} | ` +
            `${server.providerIds.join(', ')} | ${status} |`,
        );
      }
      lines.push('');
    }

    if (inventory.instructions.length > 0) {
      lines.push('## Instructions', '');
      for (const entry of inventory.instructions) {
        lines.push(`- \`${entry.displayPath}\` (${entry.scope}) — ${entry.title}`);
      }
      lines.push('');
    }

    if (inventory.capabilities.length > 0) {
      lines.push('## Capabilities', '');
      for (const entry of inventory.capabilities) {
        lines.push(`- **${entry.name}** (${entry.kind}, ${entry.providerName})`);
      }
      lines.push('');
    }

    lines.push('## Files', '');
    for (const group of groupByProvider(result.files)) {
      lines.push(`### ${group.providerName}`, '');
      for (const file of group.files) {
        lines.push(`- \`${file.displayPath}\` — ${file.kind}, ${file.scope}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  #editBlockReason(file: DiscoveredFile): string | undefined {
    if (this.#readOnly) return 'This session is read-only.';
    if (file.sensitivity === 'credential-store') {
      return 'Credential stores are never editable here.';
    }
    return undefined;
  }
}

function matchesFilters(file: DiscoveredFile, options: SearchOptions): boolean {
  if (options.providerIds?.length && !options.providerIds.includes(file.providerId)) return false;
  if (options.kinds?.length && !options.kinds.includes(file.kind)) return false;
  if (options.scopes?.length && !options.scopes.includes(file.scope)) return false;
  return true;
}

/** Pulls the original value a line-scoped redaction record refers to. */
function extractFromLine(text: string, record: RedactionRecord): string | undefined {
  const lineNumber = Number.parseInt(record.path.replace(/^\D*/, ''), 10);
  const line = text.split(/\r?\n/)[lineNumber - 1];
  if (line === undefined) return undefined;

  const key = record.path.split('@')[0];
  if (key) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const quotedPair = new RegExp(
      `["']${escaped}["']\\s*[:=]\\s*(["'])((?:\\\\.|(?!\\1).)*)\\1`,
    ).exec(line);
    if (quotedPair?.[2] !== undefined) {
      const value = quotedPair[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      if (value.length === record.length) return value;
    }
    const barePair = new RegExp(`["']?${escaped}["']?\\s*[:=]\\s*([^\\s,#]+)`).exec(line);
    if (barePair?.[1] !== undefined && barePair[1].length === record.length) return barePair[1];
  }

  for (const candidate of line.match(/[A-Za-z0-9_\-./+=:~]{8,}/g) ?? []) {
    if (candidate.length === record.length) return candidate;
  }
  return undefined;
}

/** Windows paths compare case-insensitively; POSIX paths do not. */
function normalizeKey(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

function samePath(a: string, b: string): boolean {
  return normalizeKey(a.replace(/[\\/]+$/, '')) === normalizeKey(b.replace(/[\\/]+$/, ''));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { sep as pathSeparator };
