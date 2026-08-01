/**
 * Stateful facade over the scanner, aggregator, and writer.
 *
 * The server is deliberately thin: it owns transport and authorization, and
 * every decision about *what* a caller may see or change lives here, where it
 * can be tested without a socket.
 */

import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';

import { aggregate, type HarnessInventory } from './aggregate.js';
import { editorLanguage, parseContent, type ParseIssue } from './parsers.js';
import { createEnvironment, selectPlatformTemplates, toDisplayPath } from './paths.js';
import { redactDocumentText, resolveRedactionPath, type RedactionRecord } from './redact.js';
import { providers as registryProviders } from './registry.js';
import { groupByProvider, scan, type DiscoveredFile, type ScanResult } from './scanner.js';
import type {
  ConfigScope,
  FileFormat,
  FileKind,
  ProviderDefinition,
  ResolverEnvironment,
  Sensitivity,
} from './types.js';
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

/** A discovered file as it appears in the sources map. */
export interface SourceFileRef {
  readonly fileId: string;
  readonly name: string;
  readonly displayPath: string;
  readonly directory: string;
  readonly kind: FileKind;
  readonly format: FileFormat;
  readonly sensitivity: Sensitivity;
  readonly size: number;
  readonly modified: string;
  /** True when this session would accept an edit to the file. */
  readonly editable: boolean;
  /** Why an edit would be refused, when it would be. */
  readonly notEditableReason?: string;
  readonly deprecated?: boolean;
  readonly unattributed?: boolean;
}

/**
 * One place a tool reads configuration from, whether or not anything is there.
 *
 * Absent locations are as important as present ones: "Copilot would read
 * `~/.copilot/mcp-config.json`, and there is no such file" is the answer to
 * half the questions people have about their harness.
 */
export interface SourceLocation {
  readonly providerId: string;
  readonly providerName: string;
  readonly locationId: string;
  readonly locationLabel: string;
  readonly scope: ConfigScope;
  readonly kind: FileKind;
  readonly format: FileFormat;
  readonly sensitivity: Sensitivity;
  readonly status: 'active' | 'absent';
  /** Folders configuration was actually found in. */
  readonly directories: readonly string[];
  /** Concrete paths this machine checked, home-abbreviated. */
  readonly checkedPaths: readonly string[];
  /** Raw registry templates for this platform, e.g. `{project}/.vscode/mcp.json`. */
  readonly templates: readonly string[];
  readonly files: readonly SourceFileRef[];
  readonly note?: string;
  readonly deprecated?: boolean;
  readonly projectRoot?: string;
}

/** Every location one tool reads, grouped for display. */
export interface SourceProvider {
  readonly providerId: string;
  readonly providerName: string;
  readonly description: string;
  readonly category: ProviderDefinition['category'];
  readonly docsUrl?: string;
  /** True when at least one file was found for this tool. */
  readonly detected: boolean;
  readonly fileCount: number;
  readonly locationCount: number;
  readonly activeLocationCount: number;
  readonly directories: readonly string[];
  readonly locations: readonly SourceLocation[];
}

/** The complete "where does this come from?" map. */
export interface SourcesResult {
  readonly platform: string;
  readonly home: string;
  readonly scannedAt: string;
  readonly readOnly: boolean;
  readonly projectRoots: readonly string[];
  readonly providers: readonly SourceProvider[];
  readonly totals: {
    readonly providers: number;
    readonly detectedProviders: number;
    readonly locations: number;
    readonly activeLocations: number;
    readonly files: number;
    readonly directories: number;
  };
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
  async refresh(): Promise<ScanResult> {
    const result = await scan({
      environment: this.#environment,
      projectRoots: this.#projectRoots,
    });
    this.#scan = result;
    this.#inventory = await aggregate(result);
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

  /**
   * Every configuration source this machine has, present or not.
   *
   * Built from the scan rather than from a fresh resolve, so what is reported
   * is exactly what was consulted — a map that disagreed with the scan would
   * be worse than no map at all.
   */
  async getSources(): Promise<SourcesResult> {
    const result = await this.getScan();

    const filesByLocation = new Map<string, DiscoveredFile[]>();
    for (const file of result.files) {
      const key = locationKey(file.providerId, file.locationId, file.projectRoot);
      const bucket = filesByLocation.get(key);
      if (bucket) bucket.push(file);
      else filesByLocation.set(key, [file]);
    }

    const checkedByLocation = new Map<string, readonly string[]>();
    for (const entry of result.missing) {
      checkedByLocation.set(
        locationKey(entry.providerId, entry.locationId, entry.projectRoot),
        entry.checkedPaths,
      );
    }

    const providers: SourceProvider[] = registryProviders.map((provider) =>
      this.#describeProvider(provider, filesByLocation, checkedByLocation),
    );

    // Files the sweep found belong to no registry provider, but leaving them
    // out of the source map would hide the very files most likely to surprise
    // someone.
    const claimed = new Set(registryProviders.map((provider) => provider.id));
    const strays = [...new Set(result.files.map((file) => file.providerId))].filter(
      (id) => !claimed.has(id),
    );
    for (const providerId of strays) {
      providers.push(this.#describeStrayProvider(providerId, result.files));
    }

    providers.sort(
      (a, b) =>
        Number(b.detected) - Number(a.detected) || a.providerName.localeCompare(b.providerName),
    );

    const allLocationsFlat = providers.flatMap((provider) => provider.locations);

    return {
      platform: result.platform,
      home: toDisplayPath(result.home, this.#environment),
      scannedAt: result.scannedAt,
      readOnly: this.#readOnly,
      projectRoots: this.#projectRoots,
      providers,
      totals: {
        providers: providers.length,
        detectedProviders: providers.filter((provider) => provider.detected).length,
        locations: allLocationsFlat.length,
        activeLocations: allLocationsFlat.filter((location) => location.status === 'active').length,
        files: result.files.length,
        directories: new Set(result.files.map((file) => file.directory)).size,
      },
    };
  }

  #describeProvider(
    provider: ProviderDefinition,
    filesByLocation: ReadonlyMap<string, DiscoveredFile[]>,
    checkedByLocation: ReadonlyMap<string, readonly string[]>,
  ): SourceProvider {
    const locations: SourceLocation[] = [];

    for (const definition of provider.locations) {
      const templates = selectPlatformTemplates(definition.paths, this.#environment.platform);
      // A project-scope location is checked once per registered root, so the
      // same definition can legitimately produce several rows.
      const roots =
        definition.scope === 'project'
          ? this.#projectRoots.length > 0
            ? this.#projectRoots
            : [undefined]
          : [undefined];

      for (const root of roots) {
        const key = locationKey(provider.id, definition.id, root);
        const files = filesByLocation.get(key) ?? [];
        const checked = checkedByLocation.get(key) ?? [];

        locations.push({
          providerId: provider.id,
          providerName: provider.name,
          locationId: definition.id,
          locationLabel: definition.label,
          scope: definition.scope,
          kind: definition.kind,
          format: definition.format,
          sensitivity: definition.sensitivity,
          status: files.length > 0 ? 'active' : 'absent',
          directories: [...new Set(files.map((file) => file.directory))].sort(),
          checkedPaths: (files.length > 0 ? files.map((file) => file.path) : checked).map((path) =>
            toDisplayPath(path, this.#environment),
          ),
          templates,
          files: files.map((file) => this.#describeFile(file)),
          ...(definition.note !== undefined ? { note: definition.note } : {}),
          ...(definition.deprecated ? { deprecated: true } : {}),
          ...(root !== undefined ? { projectRoot: root } : {}),
        });
      }
    }

    const fileCount = locations.reduce((sum, location) => sum + location.files.length, 0);

    return {
      providerId: provider.id,
      providerName: provider.name,
      description: provider.description,
      category: provider.category,
      ...(provider.docsUrl !== undefined ? { docsUrl: provider.docsUrl } : {}),
      detected: fileCount > 0,
      fileCount,
      locationCount: locations.length,
      activeLocationCount: locations.filter((location) => location.status === 'active').length,
      directories: [...new Set(locations.flatMap((location) => location.directories))].sort(),
      locations,
    };
  }

  #describeStrayProvider(providerId: string, files: readonly DiscoveredFile[]): SourceProvider {
    const owned = files.filter((file) => file.providerId === providerId);
    const first = owned[0];
    const locations: SourceLocation[] = owned.map((file) => ({
      providerId,
      providerName: file.providerName,
      locationId: file.locationId,
      locationLabel: file.locationLabel,
      scope: file.scope,
      kind: file.kind,
      format: file.format,
      sensitivity: file.sensitivity,
      status: 'active',
      directories: [file.directory],
      checkedPaths: [file.displayPath],
      templates: [],
      files: [this.#describeFile(file)],
      ...(file.note !== undefined ? { note: file.note } : {}),
      ...(file.projectRoot !== undefined ? { projectRoot: file.projectRoot } : {}),
    }));

    return {
      providerId,
      providerName: first?.providerName ?? providerId,
      description: 'Harness-shaped configuration that no supported tool claims.',
      category: 'universal',
      detected: owned.length > 0,
      fileCount: owned.length,
      locationCount: locations.length,
      activeLocationCount: locations.length,
      directories: [...new Set(owned.map((file) => file.directory))].sort(),
      locations,
    };
  }

  #describeFile(file: DiscoveredFile): SourceFileRef {
    const blocked = this.#editBlockReason(file);
    return {
      fileId: file.id,
      name: file.name,
      displayPath: file.displayPath,
      directory: file.directory,
      kind: file.kind,
      format: file.format,
      sensitivity: file.sensitivity,
      size: file.size,
      modified: file.modified,
      editable: blocked === undefined,
      ...(blocked !== undefined ? { notEditableReason: blocked } : {}),
      ...(file.deprecated ? { deprecated: true } : {}),
      ...(file.unattributed ? { unattributed: true } : {}),
    };
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
      text = await readFile(file.path, 'utf8');
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

    const redacted = redactDocumentText(text);
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
      text = await readFile(file.path, 'utf8');
    } catch {
      return undefined;
    }

    const redacted = redactDocumentText(text);
    const record = redacted.redactions.find((entry) => entry.id === redactionId);
    if (!record) return undefined;

    // `key@line` records point at a line; `lineN[i]` records point at a token.
    const parsed = parseContent(text, file.format);
    const structured = resolveRedactionPath(parsed.value, record.path.split('@')[0] ?? '');
    if (typeof structured === 'string') return structured;

    return extractFromLine(text, record);
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
        text = await readFile(file.path, 'utf8');
      } catch {
        continue;
      }
      filesSearched += 1;
      if (!text.toLowerCase().includes(needle)) continue;

      // Redact first, then match on the masked text, so a query can never be
      // used to confirm a secret's contents character by character.
      const masked = redactDocumentText(text).value;
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
    const sources = await this.getSources();
    return {
      generatedAt: new Date().toISOString(),
      platform: result.platform,
      home: toDisplayPath(result.home, this.#environment),
      projectRoots: this.#projectRoots,
      summary: inventory.summary,
      providers: groupByProvider(result.files).map((group) => ({
        providerId: group.providerId,
        providerName: group.providerName,
        directories: [...new Set(group.files.map((file) => file.directory))].sort(),
        files: group.files.map((file) => ({
          displayPath: file.displayPath,
          directory: file.directory,
          locationLabel: file.locationLabel,
          scope: file.scope,
          kind: file.kind,
          format: file.format,
          size: file.size,
          modified: file.modified,
        })),
      })),
      sources: sources.providers.map((provider) => ({
        providerId: provider.providerId,
        providerName: provider.providerName,
        detected: provider.detected,
        fileCount: provider.fileCount,
        directories: provider.directories,
        locations: provider.locations.map((location) => ({
          locationId: location.locationId,
          locationLabel: location.locationLabel,
          scope: location.scope,
          kind: location.kind,
          status: location.status,
          directories: location.directories,
          checkedPaths: location.checkedPaths,
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
    const sources = await this.getSources();
    const lines: string[] = [];

    lines.push('# Agentic harness report', '');
    lines.push(`Generated ${new Date().toISOString()} on ${result.platform}.`, '');
    lines.push(
      `**${inventory.summary.providerCount}** tools · **${inventory.summary.fileCount}** files · ` +
        `**${inventory.summary.directoryCount}** directories · ` +
        `**${inventory.summary.mcpServerCount}** MCP servers · ` +
        `**${inventory.summary.duplicateCount}** duplicates ` +
        `(**${inventory.summary.conflictCount}** conflicting) · ` +
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
      lines.push('| Server | Transport | Defined by | Directory | Status |');
      lines.push('| --- | --- | --- | --- | --- |');
      for (const server of inventory.mcpServers) {
        const status = server.conflicting ? 'conflict' : server.duplicated ? 'duplicate' : 'ok';
        lines.push(
          `| ${server.name} | ${server.definitions[0]?.transport ?? 'unknown'} | ` +
            `${server.providerIds.join(', ')} | ${server.directories.join(', ')} | ${status} |`,
        );
      }
      lines.push('');
    }

    if (inventory.instructions.length > 0) {
      lines.push('## Instructions', '');
      lines.push('| Title | Scope | Tool | Directory | Duplicate |');
      lines.push('| --- | --- | --- | --- | --- |');
      for (const entry of inventory.instructions) {
        lines.push(
          `| ${entry.title} | ${entry.scope} | ${entry.providerName} | ` +
            `${entry.directory} | ${describeDuplicate(entry.duplicate)} |`,
        );
      }
      lines.push('');
    }

    if (inventory.capabilities.length > 0) {
      lines.push('## Capabilities', '');
      lines.push('| Name | Kind | Tool | Directory | Duplicate |');
      lines.push('| --- | --- | --- | --- | --- |');
      for (const entry of inventory.capabilities) {
        lines.push(
          `| ${entry.name} | ${entry.kind} | ${entry.providerName} | ` +
            `${entry.directory} | ${describeDuplicate(entry.duplicate)} |`,
        );
      }
      lines.push('');
    }

    lines.push('## Sources', '');
    for (const provider of sources.providers) {
      lines.push(
        `### ${provider.providerName}${provider.detected ? '' : ' (nothing found)'}`,
        '',
      );
      for (const location of provider.locations) {
        const where =
          location.checkedPaths.length > 0
            ? location.checkedPaths.join(', ')
            : location.templates.join(', ');
        lines.push(`- ${location.locationLabel} (${location.scope}) — ${location.status}: ${where}`);
      }
      lines.push('');
    }

    lines.push('## Files', '');
    for (const group of groupByProvider(result.files)) {
      lines.push(`### ${group.providerName}`, '');
      for (const file of group.files) {
        lines.push(`- \`${file.displayPath}\` — ${file.kind}, ${file.scope}, in ${file.directory}`);
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

  const quoted = /["']([^"']+)["']\s*,?\s*$/.exec(line);
  if (quoted?.[1] !== undefined && quoted[1].length === record.length) return quoted[1];

  for (const candidate of line.match(/[A-Za-z0-9_\-./+=:~]{8,}/g) ?? []) {
    if (candidate.length === record.length) return candidate;
  }
  return undefined;
}

/** Windows paths compare case-insensitively; POSIX paths do not. */
function normalizeKey(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

/** Identifies one provider location, per project root where that applies. */
function locationKey(providerId: string, locationId: string, projectRoot?: string): string {
  return `${providerId}|${locationId}|${projectRoot === undefined ? '' : normalizeKey(projectRoot)}`;
}

function samePath(a: string, b: string): boolean {
  return normalizeKey(a.replace(/[\\/]+$/, '')) === normalizeKey(b.replace(/[\\/]+$/, ''));
}

/** One-word summary of an entry's duplicate status, for the Markdown report. */
function describeDuplicate(info: { duplicated: boolean; conflicting: boolean }): string {
  if (info.conflicting) return 'conflict';
  return info.duplicated ? 'duplicate' : 'unique';
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
