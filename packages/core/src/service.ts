/**
 * Stateful facade over the scanner, aggregator, and writer.
 *
 * The server is deliberately thin: it owns transport and authorization, and
 * every decision about *what* a caller may see or change lives here, where it
 * can be tested without a socket.
 */

import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';

import { aggregate, type HarnessInventory } from './aggregate.js';
import {
  applyCapabilityEdits,
  isCapabilityFormat,
  parseCapabilityDocument,
  validateCapabilityDocument,
  type CapabilityDocumentBody,
} from './capability-doc.js';
import { removeMcpServerFromText } from './mcp-edit.js';
import { fileDeletability } from './deletable.js';
import { mapConcurrent, mapConcurrentBatches } from './concurrency.js';
import { editorLanguage, parseContent, type ParseIssue } from './parsers.js';
import { createEnvironment, selectPlatformTemplates, toDisplayPath } from './paths.js';
import {
  redactDocumentText,
  resolveRedactionPath,
  REDACTED_PLACEHOLDER,
  type RedactionRecord,
} from './redact.js';
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
import {
  deleteConfigFile,
  hashContent,
  writeConfigFile,
  type DeleteOutcome,
  type WriteOutcome,
  type WriteRefusal,
  type WriteSuccess,
  type WriterOptions,
} from './writer.js';

/** A successful removal, plus what was taken out and from where. */
export interface McpRemovalSuccess extends WriteSuccess {
  readonly serverName: string;
  /** Dotted paths inside the file the declaration was removed from. */
  readonly removedFrom: readonly string[];
}

/**
 * The result of deleting an MCP server declaration.
 *
 * Shares the writer's refusal shape so callers already handling `read-only`
 * or `hash-mismatch` need no second error vocabulary.
 */
export type McpRemovalOutcome = McpRemovalSuccess | WriteRefusal;

/** A requested project root cannot be scanned safely. */
export class InvalidProjectRootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidProjectRootError';
  }
}

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
  /** True when the whole file may be deleted from here. */
  readonly deletable: boolean;
  /** Why deleting is not offered, when it is not. */
  readonly notDeletableReason?: string;
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
  /** True when the whole file may be deleted from here. */
  readonly deletable: boolean;
  /** Why deleting is not offered, when it is not. */
  readonly notDeletableReason?: string;
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
  readonly projectsOnly?: boolean;
  readonly readOnly?: boolean;
  readonly writerOptions?: WriterOptions;
}

/** Kinds the structured capability editor can open. */
export type EditableCapabilityKind = Extract<
  FileKind,
  'agent' | 'skill' | 'command' | 'prompt' | 'chatmode'
>;

const EDITABLE_CAPABILITY_KINDS = new Set<FileKind>([
  'agent',
  'skill',
  'command',
  'prompt',
  'chatmode',
]);

/** One capability as it appears in the editor's list. */
export interface CapabilitySummary {
  readonly fileId: string;
  readonly kind: EditableCapabilityKind;
  /** Front-matter `name`, falling back to the file name. */
  readonly name: string;
  readonly description?: string;
  readonly model?: string;
  readonly version?: string;
  readonly tools: readonly string[];
  readonly providerId: string;
  readonly providerName: string;
  readonly locationLabel: string;
  readonly scope: ConfigScope;
  readonly fileName: string;
  readonly directory: string;
  readonly displayPath: string;
  readonly projectRoot?: string;
  readonly size: number;
  readonly modified: string;
  /** True when this session would accept an edit to the file. */
  readonly editable: boolean;
  readonly notEditableReason?: string;
  /** True when the whole file may be deleted from here. */
  readonly deletable: boolean;
  readonly notDeletableReason?: string;
  /** True when the front matter could not be parsed. */
  readonly malformed: boolean;
}

/** The capability list, plus the vocabulary the editor offers as suggestions. */
export interface CapabilityListResult {
  readonly capabilities: readonly CapabilitySummary[];
  /**
   * Every distinct model already named by a capability on this machine.
   *
   * Offered as suggestions rather than as the only permitted values: a closed
   * list would go stale the week after it shipped and would block a user from
   * naming a model this build has never heard of.
   */
  readonly knownModels: readonly string[];
  /** Every distinct tool name already declared, for the same reason. */
  readonly knownTools: readonly string[];
  readonly readOnly: boolean;
}

/** One capability file opened for structured editing. */
export interface CapabilityDocument {
  readonly file: DiscoveredFile;
  readonly kind: EditableCapabilityKind;
  /** Front-matter fields the form owns. */
  readonly fields: {
    readonly name?: string;
    readonly description?: string;
    readonly model?: string;
    readonly version?: string;
    readonly tools?: readonly string[];
  };
  /** Markdown body, masked unless secrets were explicitly requested. */
  readonly body: string;
  /** Whole file as text, for the preview and the save diff. */
  readonly content: string;
  /** True when `body` and `content` still contain live secrets. */
  readonly revealed: boolean;
  readonly redactions: readonly RedactionRecord[];
  /** True when the file opened with a `---` block. */
  readonly hasFrontmatter: boolean;
  /** Front-matter keys preserved on write but not editable in the form. */
  readonly extraKeys: readonly string[];
  /** Hash of the unmasked file, for optimistic concurrency on write. */
  readonly hash: string;
  readonly issues: readonly ParseIssue[];
  readonly readOnly: boolean;
  readonly readOnlyReason?: string;
}

/** A structured edit. Omitted fields are left exactly as they are on disk. */
export interface CapabilityEdit {
  readonly name?: string;
  readonly description?: string;
  readonly model?: string;
  readonly version?: string;
  readonly tools?: readonly string[];
  readonly body?: string;
}

/** Maximum bytes of a single file returned to the client. */
export const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;

/** Default cap on search hits, to keep responses bounded. */
const DEFAULT_SEARCH_LIMIT = 200;
const FILE_READ_CONCURRENCY = 8;

async function assertProjectRoot(root: string): Promise<void> {
  let metadata;
  try {
    metadata = await stat(root);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new InvalidProjectRootError(
        `Project root does not exist: "${root}". Check the path passed to --project.`,
      );
    }
    throw new InvalidProjectRootError(
      `Project root cannot be read: "${root}". ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!metadata.isDirectory()) {
    throw new InvalidProjectRootError(`Project root is not a directory: "${root}".`);
  }
}

export class HarnessService {
  readonly #environment: ResolverEnvironment;
  readonly #projectsOnly: boolean;
  readonly #readOnly: boolean;
  readonly #writerOptions: WriterOptions;
  #projectRoots: string[];
  #scan: ScanResult | undefined;
  #inventory: HarnessInventory | undefined;
  /** Absolute paths the scan discovered, used as the authorization set. */
  #authorized = new Set<string>();

  constructor(options: HarnessServiceOptions = {}) {
    this.#environment = options.environment ?? createEnvironment();
    this.#projectsOnly = options.projectsOnly ?? false;
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
    await mapConcurrent(this.#projectRoots, FILE_READ_CONCURRENCY, assertProjectRoot);
    const result = await scan({
      environment: this.#environment,
      projectRoots: this.#projectRoots,
      projectsOnly: this.#projectsOnly,
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

    const providers: SourceProvider[] = registryProviders
      .map((provider) => this.#describeProvider(provider, filesByLocation, checkedByLocation))
      .filter((provider) => provider.locations.length > 0);

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
      if (this.#projectsOnly && definition.scope !== 'project') continue;
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
    const undeletable = this.#deleteBlockReason(file);
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
      deletable: undeletable === undefined,
      ...(undeletable !== undefined ? { notDeletableReason: undeletable } : {}),
      ...(file.deprecated ? { deprecated: true } : {}),
      ...(file.unattributed ? { unattributed: true } : {}),
    };
  }

  async addProjectRoot(root: string): Promise<readonly string[]> {
    const resolved = resolve(root);
    await assertProjectRoot(resolved);
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
    const undeletable = this.#deleteBlockReason(file);
    const deletion = {
      deletable: undeletable === undefined,
      ...(undeletable !== undefined ? { notDeletableReason: undeletable } : {}),
    };

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
        ...deletion,
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
        ...deletion,
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
        ...deletion,
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
        ...deletion,
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
      ...deletion,
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

  /**
   * Deletes one MCP server declaration from one file.
   *
   * The removal is computed from the file's *current* contents rather than
   * from the cached inventory, so a server the user already deleted by hand
   * reports `not-declared` instead of a bewildering success. Everything after
   * that is the ordinary write path — validation, backup, hash check, atomic
   * rename — because a delete is exactly as destructive as an edit.
   */
  async removeMcpServer(
    id: string,
    serverName: string,
    expectedHash?: string,
  ): Promise<McpRemovalOutcome | undefined> {
    const file = this.findFile(id);
    if (!file || !this.isAuthorized(file.path)) return undefined;

    if (this.#readOnly) {
      return {
        ok: false,
        code: 'read-only',
        message: 'This session is read-only. Restart without --read-only to make changes.',
      };
    }

    if (file.sensitivity === 'credential-store') {
      return {
        ok: false,
        code: 'credential-store',
        message:
          'This file exists to hold credentials and is never editable here. Use the owning tool to change it.',
      };
    }

    let text: string;
    try {
      text = await readFile(file.path, 'utf8');
    } catch {
      return {
        ok: false,
        code: 'not-found',
        message: 'The file no longer exists. Re-scan before editing it.',
      };
    }

    const currentHash = hashContent(text);
    if (expectedHash !== undefined && expectedHash !== currentHash) {
      return {
        ok: false,
        code: 'hash-mismatch',
        message:
          'The file changed on disk since you loaded it. Reload to see the current contents, then try again.',
        currentHash,
      };
    }

    const removal = removeMcpServerFromText(text, file.format, serverName, {
      providerId: file.providerId,
    });
    if (!removal.ok) {
      return { ok: false, code: removal.code, message: removal.message };
    }

    const outcome = await writeConfigFile(
      {
        path: file.path,
        content: removal.content,
        format: file.format,
        sensitivity: file.sensitivity,
        expectedHash: currentHash,
      },
      { ...this.#writerOptions, readOnly: this.#readOnly },
    );

    if (!outcome.ok) return outcome;
    await this.refresh();
    return { ...outcome, serverName, removedFrom: removal.removedFrom };
  }

  /**
   * Deletes a whole discovered file.
   *
   * Offered only for files that *are* the thing the UI showed — an agent, a
   * skill, an instruction document, an ignore file — so the user never removes
   * more than the row they clicked. A settings file that happens to contain a
   * permission block is refused here rather than in the UI, because a rule
   * enforced only in the browser is not a rule.
   *
   * `expectedHash` is optional but strongly preferred: passing the hash the
   * client loaded turns "delete this file" into "delete the file I read",
   * which is the difference between removing a stale skill and removing the
   * rewrite someone made while the page sat open.
   */
  async deleteFile(id: string, expectedHash?: string): Promise<DeleteOutcome | undefined> {
    const file = this.findFile(id);
    if (!file || !this.isAuthorized(file.path)) return undefined;

    if (this.#readOnly) {
      return {
        ok: false,
        code: 'read-only',
        message: 'This session is read-only. Restart without --read-only to make changes.',
      };
    }

    const deletion = fileDeletability(file);
    if (!deletion.deletable) {
      return {
        ok: false,
        code: 'not-deletable',
        message: deletion.reason ?? 'This file cannot be deleted.',
      };
    }

    const outcome = await deleteConfigFile(
      {
        path: file.path,
        sensitivity: file.sensitivity,
        ...(expectedHash !== undefined ? { expectedHash } : {}),
      },
      { ...this.#writerOptions, readOnly: this.#readOnly },
    );

    // The file is gone, so every derived view that still lists it is wrong.
    if (outcome.ok) await this.refresh();
    return outcome;
  }

  /* ------------------------------------------- Structured capability edit -- */

  /**
   * Lists every agent, skill, command, prompt, and chat mode the form editor
   * can open.
   *
   * Built by re-reading each file rather than by reusing the inventory,
   * because the inventory deliberately normalizes a capability's name (falling
   * back to the file name and then to the first heading) and the editor has to
   * show what the front matter literally says — otherwise a file with no
   * `name:` would appear to have one, and saving would write it in.
   */
  async listCapabilities(): Promise<CapabilityListResult> {
    const result = await this.getScan();
    const capabilities: CapabilitySummary[] = [];
    const models = new Set<string>();
    const tools = new Set<string>();
    const files = result.files.filter((file) => this.#isCapabilityFile(file));
    for await (const { item: file, result: parsed } of mapConcurrentBatches(
      files,
      FILE_READ_CONCURRENCY,
      async (entry) => {
        try {
          return parseCapabilityDocument(await readFile(entry.path, 'utf8'));
        } catch {
          // An unreadable file is still listed below with a reason.
          return undefined;
        }
      },
    )) {
      const blocked = this.#editBlockReason(file);
      const undeletable = this.#deleteBlockReason(file);
      if (parsed?.model) models.add(parsed.model);
      for (const tool of parsed?.tools ?? []) tools.add(tool);

      capabilities.push({
        fileId: file.id,
        kind: file.kind as EditableCapabilityKind,
        name: parsed?.name ?? fallbackCapabilityName(file),
        ...(parsed?.description !== undefined ? { description: parsed.description } : {}),
        ...(parsed?.model !== undefined ? { model: parsed.model } : {}),
        ...(parsed?.version !== undefined ? { version: parsed.version } : {}),
        tools: parsed?.tools ?? [],
        providerId: file.providerId,
        providerName: file.providerName,
        locationLabel: file.locationLabel,
        scope: file.scope,
        fileName: file.name,
        directory: file.directory,
        displayPath: file.displayPath,
        ...(file.projectRoot !== undefined ? { projectRoot: file.projectRoot } : {}),
        size: file.size,
        modified: file.modified,
        editable: blocked === undefined && parsed !== undefined,
        ...(blocked !== undefined
          ? { notEditableReason: blocked }
          : parsed === undefined
            ? { notEditableReason: 'The file could not be read.' }
            : {}),
        deletable: undeletable === undefined,
        ...(undeletable !== undefined ? { notDeletableReason: undeletable } : {}),
        malformed: (parsed?.issues.length ?? 0) > 0,
      });
    }

    capabilities.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));

    return {
      capabilities,
      knownModels: [...models].sort((a, b) => a.localeCompare(b)),
      knownTools: [...tools].sort((a, b) => a.localeCompare(b)),
      readOnly: this.#readOnly,
    };
  }

  /**
   * Opens one capability as structured fields plus a body.
   *
   * `includeSecrets` follows the same two-step contract as
   * {@link getDocument}: the form is populated from a masked copy for reading,
   * and only entering edit mode fetches the real text. Saving a masked body
   * would write `••••` into the user's instructions.
   */
  async getCapabilityDocument(
    id: string,
    includeSecrets = false,
  ): Promise<CapabilityDocument | undefined> {
    const file = this.findFile(id);
    if (!file || !this.#isCapabilityFile(file)) return undefined;

    const document = await this.getDocument(id, includeSecrets);
    if (!document) return undefined;

    const parsed = parseCapabilityDocument(document.content);

    return {
      file,
      kind: file.kind as EditableCapabilityKind,
      fields: {
        ...(parsed.name !== undefined ? { name: parsed.name } : {}),
        ...(parsed.description !== undefined ? { description: parsed.description } : {}),
        ...(parsed.model !== undefined ? { model: parsed.model } : {}),
        ...(parsed.version !== undefined ? { version: parsed.version } : {}),
        ...(parsed.tools !== undefined ? { tools: parsed.tools } : {}),
      },
      body: parsed.body,
      content: document.content,
      revealed: document.revealed,
      redactions: document.redactions,
      hasFrontmatter: parsed.hasFrontmatter,
      extraKeys: parsed.extraKeys,
      hash: document.hash,
      issues: [...document.issues, ...parsed.issues],
      readOnly: document.readOnly,
      ...(document.readOnlyReason !== undefined ? { readOnlyReason: document.readOnlyReason } : {}),
    };
  }

  /**
   * Applies a structured edit.
   *
   * The merge happens here, against the bytes currently on disk, so front
   * matter this build does not model cannot be dropped by a client that never
   * saw it. The caller supplies only the fields it means to change.
   */
  async writeCapabilityDocument(
    id: string,
    edit: CapabilityEdit,
    expectedHash: string,
  ): Promise<WriteOutcome | undefined> {
    const file = this.findFile(id);
    if (!file || !this.#isCapabilityFile(file)) return undefined;
    if (!this.isAuthorized(file.path)) return undefined;

    if (this.#readOnly) {
      return {
        ok: false,
        code: 'read-only',
        message: 'This session is read-only. Restart without --read-only to make changes.',
      };
    }

    let current: string;
    try {
      current = await readFile(file.path, 'utf8');
    } catch (error) {
      return {
        ok: false,
        code: 'not-found',
        message: `The file could not be read: ${describe(error)}`,
      };
    }

    const currentHash = hashContent(current);
    if (currentHash !== expectedHash) {
      return {
        ok: false,
        code: 'hash-mismatch',
        message:
          'The file changed on disk since you loaded it. Reload to see the current contents, then reapply your edit.',
        currentHash,
      };
    }

    const edits: Partial<CapabilityDocumentBody> = {
      ...(edit.name !== undefined ? { name: edit.name } : {}),
      ...(edit.description !== undefined ? { description: edit.description } : {}),
      ...(edit.model !== undefined ? { model: edit.model } : {}),
      ...(edit.version !== undefined ? { version: edit.version } : {}),
      ...(edit.tools !== undefined ? { tools: edit.tools } : {}),
      ...(edit.body !== undefined ? { body: edit.body } : {}),
    };

    const content = applyCapabilityEdits(current, edits);

    const maskWouldBeWritten =
      content.includes(REDACTED_PLACEHOLDER.slice(0, 4)) &&
      !current.includes(REDACTED_PLACEHOLDER.slice(0, 4));
    if (maskWouldBeWritten) {
      return {
        ok: false,
        code: 'invalid-content',
        message:
          'The edit contains masked placeholders, which would overwrite real values. Reopen the capability for editing and try again.',
      };
    }

    const issues = validateCapabilityDocument(content);
    if (issues.length > 0) {
      return {
        ok: false,
        code: 'invalid-content',
        message: `Front matter is not valid YAML: ${issues[0]?.message ?? 'parse failed'}`,
        issues,
      };
    }

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

    if (outcome.ok) await this.refresh();
    return outcome;
  }

  /** True when a discovered file is a capability the form editor understands. */
  #isCapabilityFile(file: DiscoveredFile): boolean {
    return (
      EDITABLE_CAPABILITY_KINDS.has(file.kind) &&
      isCapabilityFormat(file.format) &&
      file.sensitivity !== 'credential-store'
    );
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
      mcpOverlaps: inventory.mcpOverlaps,
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

    if (inventory.mcpOverlaps.length > 0) {
      lines.push('## Overlapping MCP servers', '');
      lines.push('| Servers | Overlap | Confidence | Shared |');
      lines.push('| --- | --- | --- | --- |');
      for (const group of inventory.mcpOverlaps) {
        lines.push(
          `| ${group.serverNames.join(', ')} | ${group.kind} | ` +
            `${group.confidence} | ${group.label} |`,
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
      lines.push(`### ${provider.providerName}${provider.detected ? '' : ' (nothing found)'}`, '');
      for (const location of provider.locations) {
        const where =
          location.checkedPaths.length > 0
            ? location.checkedPaths.join(', ')
            : location.templates.join(', ');
        lines.push(
          `- ${location.locationLabel} (${location.scope}) — ${location.status}: ${where}`,
        );
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

  /**
   * Why a file may not be deleted, or `undefined` when it may.
   *
   * The session-level `--read-only` check comes first so a read-only run
   * reports the flag rather than a kind-specific rule the user cannot act on.
   */
  #deleteBlockReason(file: DiscoveredFile): string | undefined {
    if (this.#readOnly) return 'This session is read-only.';
    const deletion = fileDeletability(file);
    return deletion.deletable ? undefined : (deletion.reason ?? 'This file cannot be deleted.');
  }
}

/**
 * Names a capability that declares no `name:` in its front matter.
 *
 * A file named `reviewer.agent.md` invokes as `reviewer`. A `SKILL.md` is
 * named by the folder that contains it, which is how every tool that ships
 * skills-in-folders resolves them — falling back to the literal string
 * "SKILL" would label every skill on the machine identically.
 */
function fallbackCapabilityName(file: DiscoveredFile): string {
  const stripped = file.name.replace(
    /(?:\.(?:prompt|instructions|chatmode|agent|skill))?\.(?:md|markdown|mdc)$/i,
    '',
  );
  if (/^(skill|agent|readme|index)$/i.test(stripped)) {
    const folder = basename(dirname(file.path));
    if (folder.length > 0) return folder;
  }
  return stripped.length > 0 ? stripped : file.name;
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
