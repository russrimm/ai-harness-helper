import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { glob } from 'tinyglobby';
import { runBounded } from './bounded.js';
import { expandTemplates, toDisplayPath } from './paths.js';
import { editorLanguage, inferFormat } from './parsers.js';
import { allLocations, providersById } from './registry.js';
import { readRegularFile } from './safe-file.js';
import type {
  ConfigScope,
  FileFormat,
  FileKind,
  ProviderDefinition,
  ResolverEnvironment,
  Sensitivity,
} from './types.js';

/** A configuration file that exists on disk. */
export interface DiscoveredFile {
  /** Stable identifier derived from the absolute path. */
  readonly id: string;
  /** Absolute path on this machine. */
  readonly path: string;
  /** Path with the home directory abbreviated to `~`. */
  readonly displayPath: string;
  /** File name only. */
  readonly name: string;
  readonly providerId: string;
  readonly providerName: string;
  readonly locationId: string;
  readonly locationLabel: string;
  readonly scope: ConfigScope;
  readonly kind: FileKind;
  readonly format: FileFormat;
  readonly sensitivity: Sensitivity;
  /** Size in bytes. */
  readonly size: number;
  /** Last modification time, ISO 8601. */
  readonly modified: string;
  /** SHA-256 of the file content, used for optimistic concurrency on write. */
  readonly hash: string;
  /** Project root this file belongs to, for `project` scope only. */
  readonly projectRoot?: string;
  /** Location note carried through from the registry. */
  readonly note?: string;
  /** True when the registry marks this location as a legacy format. */
  readonly deprecated?: boolean;
  /**
   * True when no provider claimed this file and it was found by the
   * unattributed sweep.
   */
  readonly unattributed?: boolean;
}

/** A location that was checked but produced no files. */
export interface MissingLocation {
  readonly providerId: string;
  readonly providerName: string;
  readonly locationId: string;
  readonly locationLabel: string;
  readonly scope: ConfigScope;
  readonly kind: FileKind;
  readonly checkedPaths: readonly string[];
  readonly projectRoot?: string;
}

/** A location that could not be read. */
export interface ScanProblem {
  readonly path: string;
  readonly providerId?: string;
  readonly locationId?: string;
  readonly message: string;
  readonly code: 'permission-denied' | 'read-error' | 'too-large';
}

/** A project root the user asked to include in the scan. */
export interface ProjectRootInfo {
  readonly path: string;
  readonly name: string;
  readonly fileCount: number;
}

/** The complete result of a scan. */
export interface ScanResult {
  readonly scannedAt: string;
  readonly platform: string;
  readonly home: string;
  readonly files: readonly DiscoveredFile[];
  readonly missing: readonly MissingLocation[];
  readonly problems: readonly ScanProblem[];
  readonly projectRoots: readonly ProjectRootInfo[];
  /** Provider ids that produced at least one file. */
  readonly detectedProviders: readonly string[];
  readonly durationMs: number;
}

export interface ScanOptions {
  readonly environment: ResolverEnvironment;
  /** Absolute project roots to include in the scan. */
  readonly projectRoots?: readonly string[];
  /** Skip user- and machine-level locations, scanning only project roots. */
  readonly projectsOnly?: boolean;
  /** Largest file to read, in bytes. Larger files are listed but flagged. */
  readonly maxFileBytes?: number;
  /** Depth limit for the unattributed-file sweep inside project roots. */
  readonly sweepDepth?: number;
  /** Maximum number of registry locations inspected concurrently. */
  readonly concurrency?: number;
  /** Cancels an in-progress scan. */
  readonly signal?: AbortSignal;
}

/** Files above this size are reported without a content hash. */
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;

/** Directories never descended into during the unattributed sweep. */
const SWEEP_IGNORES = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/target/**',
  '**/vendor/**',
  '**/.venv/**',
  '**/venv/**',
  '**/__pycache__/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/coverage/**',
  '**/.gradle/**',
  '**/bin/**',
  '**/obj/**',
];

/**
 * File names that are recognisably part of an agentic harness but that no
 * provider location claimed, e.g. an `mcp.json` in an unexpected folder.
 */
const SWEEP_PATTERNS = [
  '**/AGENTS.md',
  '**/.mcp.json',
  '**/mcp.json',
  '**/.cursorrules',
  '**/.windsurfrules',
  '**/CLAUDE.md',
  '**/GEMINI.md',
];

function fileId(path: string): string {
  return createHash('sha256').update(path).digest('hex').slice(0, 16);
}

/** Hashes file content so writes can detect external modification. */
async function hashFile(path: string, size: number, maxBytes: number): Promise<string> {
  if (size > maxBytes) return '';
  const content = await readRegularFile(path, maxBytes);
  return createHash('sha256').update(content).digest('hex');
}

function classifyError(error: unknown): ScanProblem['code'] {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EACCES' || code === 'EPERM') return 'permission-denied';
  return 'read-error';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Walks the provider registry against the current machine and returns every
 * configuration file that exists.
 *
 * The scan is resilient by design: an unreadable directory produces a
 * `ScanProblem` rather than aborting, and a location that simply does not
 * exist is reported as `missing` rather than as an error.
 */
export async function scan(options: ScanOptions): Promise<ScanResult> {
  const started = Date.now();
  const { environment } = options;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const projectRoots = (options.projectRoots ?? []).map((root) => resolve(root));
  const concurrency = Math.max(1, options.concurrency ?? 16);

  const files: DiscoveredFile[] = [];
  const missing: MissingLocation[] = [];
  const problems: ScanProblem[] = [];
  const claimed = new Set<string>();

  const tasks: Array<() => Promise<void>> = [];

  for (const { provider, location } of allLocations()) {
    if (location.scope === 'project') {
      for (const root of projectRoots) {
        tasks.push(() =>
          collectLocation(
            provider,
            location,
            environment,
            maxFileBytes,
            files,
            missing,
            problems,
            claimed,
            root,
          ),
        );
      }
    } else if (!options.projectsOnly) {
      tasks.push(() =>
        collectLocation(
          provider,
          location,
          environment,
          maxFileBytes,
          files,
          missing,
          problems,
          claimed,
        ),
      );
    }
  }

  await runBounded(tasks, concurrency, options.signal);

  // The sweep runs after every provider has claimed its files so it only
  // reports genuinely unattributed ones.
  await runBounded(
    projectRoots.map(
      (root) => () =>
        sweepProject(
          root,
          environment,
          maxFileBytes,
          options.sweepDepth ?? 4,
          files,
          problems,
          claimed,
          concurrency,
          options.signal,
        ),
    ),
    concurrency,
    options.signal,
  );

  files.sort((a, b) => a.path.localeCompare(b.path));

  const detectedProviders = [...new Set(files.map((file) => file.providerId))].sort();
  const projectRootInfos: ProjectRootInfo[] = projectRoots.map((root) => ({
    path: root,
    name: basename(root) || root,
    fileCount: files.filter((file) => file.projectRoot === root).length,
  }));

  return {
    scannedAt: new Date().toISOString(),
    platform: environment.platform,
    home: environment.home,
    files,
    missing,
    problems,
    projectRoots: projectRootInfos,
    detectedProviders,
    durationMs: Date.now() - started,
  };
}

async function collectLocation(
  provider: ProviderDefinition,
  location: ProviderDefinition['locations'][number],
  environment: ResolverEnvironment,
  maxFileBytes: number,
  files: DiscoveredFile[],
  missing: MissingLocation[],
  problems: ScanProblem[],
  claimed: Set<string>,
  projectRoot?: string,
): Promise<void> {
  const candidates = expandTemplates(location.paths, environment, projectRoot);
  if (candidates.length === 0) return;

  let found = 0;

  for (const candidate of candidates) {
    if (location.directory) {
      found += await collectDirectory(
        provider,
        location,
        candidate,
        environment,
        maxFileBytes,
        files,
        problems,
        claimed,
        projectRoot,
      );
    } else {
      const added = await collectFile(
        provider,
        location,
        candidate,
        environment,
        maxFileBytes,
        files,
        problems,
        claimed,
        projectRoot,
      );
      if (added) found += 1;
    }
  }

  if (found === 0) {
    missing.push({
      providerId: provider.id,
      providerName: provider.name,
      locationId: location.id,
      locationLabel: location.label,
      scope: location.scope,
      kind: location.kind,
      checkedPaths: candidates,
      ...(projectRoot !== undefined ? { projectRoot } : {}),
    });
  }
}

async function collectFile(
  provider: ProviderDefinition,
  location: ProviderDefinition['locations'][number],
  path: string,
  environment: ResolverEnvironment,
  maxFileBytes: number,
  files: DiscoveredFile[],
  problems: ScanProblem[],
  claimed: Set<string>,
  projectRoot?: string,
  formatOverride?: FileFormat,
): Promise<boolean> {
  const key = claimKey(path, environment);
  if (claimed.has(key)) return false;
  claimed.add(key);

  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      claimed.delete(key);
      return false;
    }

    const hash = await hashFile(path, stats.size, maxFileBytes);
    if (hash === '') {
      problems.push({
        path,
        providerId: provider.id,
        locationId: location.id,
        message: `File exceeds the ${maxFileBytes} byte read limit and was not hashed.`,
        code: 'too-large',
      });
    }

    files.push({
      id: fileId(path),
      path,
      displayPath: toDisplayPath(path, environment),
      name: basename(path),
      providerId: provider.id,
      providerName: provider.name,
      locationId: location.id,
      locationLabel: location.label,
      scope: location.scope,
      kind: refineKind(basename(path), location.kind),
      format: formatOverride ?? location.format,
      sensitivity: location.sensitivity,
      size: stats.size,
      modified: stats.mtime.toISOString(),
      hash,
      ...(projectRoot !== undefined ? { projectRoot } : {}),
      ...(location.note !== undefined ? { note: location.note } : {}),
      ...(location.deprecated ? { deprecated: true } : {}),
    });
    return true;
  } catch (error) {
    claimed.delete(key);
    const code = classifyError(error);
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    problems.push({
      path,
      providerId: provider.id,
      locationId: location.id,
      message: errorMessage(error),
      code,
    });
    return false;
  }
}

async function collectDirectory(
  provider: ProviderDefinition,
  location: ProviderDefinition['locations'][number],
  directory: string,
  environment: ResolverEnvironment,
  maxFileBytes: number,
  files: DiscoveredFile[],
  problems: ScanProblem[],
  claimed: Set<string>,
  projectRoot?: string,
): Promise<number> {
  try {
    const stats = await lstat(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) return 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    problems.push({
      path: directory,
      providerId: provider.id,
      locationId: location.id,
      message: errorMessage(error),
      code: classifyError(error),
    });
    return 0;
  }

  let matches: string[];
  try {
    matches = await glob(location.patterns ?? ['**/*'], {
      cwd: directory,
      absolute: true,
      dot: true,
      onlyFiles: true,
      followSymbolicLinks: false,
      ignore: SWEEP_IGNORES,
    });
  } catch (error) {
    problems.push({
      path: directory,
      providerId: provider.id,
      locationId: location.id,
      message: errorMessage(error),
      code: classifyError(error),
    });
    return 0;
  }

  let count = 0;
  for (const match of matches) {
    const normalized = environment.platform === 'win32' ? match.replace(/\//g, sep) : match;
    const added = await collectFile(
      provider,
      location,
      normalized,
      environment,
      maxFileBytes,
      files,
      problems,
      claimed,
      projectRoot,
      resolveDirectoryFormat(basename(normalized), location.format),
    );
    if (added) count += 1;
  }
  return count;
}

/**
 * Chooses a format for a file inside a directory collection.
 *
 * Directory locations often mix formats — VS Code's `prompts` folder holds
 * both `*.prompt.md` and `*.toolsets.jsonc` — so the extension decides when it
 * disagrees with the declared format at the language level. When they agree
 * (`.md` in an `md-frontmatter` location) the declared format wins because it
 * is the more specific of the two.
 */
function resolveDirectoryFormat(fileName: string, declared: FileFormat): FileFormat {
  const inferred = inferFormat(fileName);
  if (inferred === 'text') return declared;
  if (editorLanguage(inferred) === editorLanguage(declared)) return declared;
  return inferred;
}

/**
 * Suffixes that name a capability more precisely than its folder does.
 *
 * A single directory routinely mixes these — VS Code's `prompts` folder holds
 * `*.prompt.md`, `*.chatmode.md`, and `*.instructions.md` side by side — so
 * without this every chat mode would be filed as a prompt.
 */
const KIND_SUFFIXES: readonly (readonly [string, FileKind])[] = [
  ['.chatmode.md', 'chatmode'],
  ['.prompt.md', 'prompt'],
  ['.instructions.md', 'instructions'],
  ['.agent.md', 'agent'],
  ['.skill.md', 'skill'],
];

function refineKind(fileName: string, declared: FileKind): FileKind {
  const lower = fileName.toLowerCase();
  return KIND_SUFFIXES.find(([suffix]) => lower.endsWith(suffix))?.[1] ?? declared;
}

/**
 * Finds harness-shaped files inside a project that no provider location
 * claimed, so unusual layouts are surfaced instead of silently ignored.
 */
async function sweepProject(
  root: string,
  environment: ResolverEnvironment,
  maxFileBytes: number,
  depth: number,
  files: DiscoveredFile[],
  problems: ScanProblem[],
  claimed: Set<string>,
  concurrency: number,
  signal?: AbortSignal,
): Promise<void> {
  let matches: string[];
  try {
    matches = await glob(SWEEP_PATTERNS, {
      cwd: root,
      absolute: true,
      dot: true,
      onlyFiles: true,
      followSymbolicLinks: false,
      deep: depth,
      ignore: SWEEP_IGNORES,
    });
  } catch (error) {
    problems.push({ path: root, message: errorMessage(error), code: classifyError(error) });
    return;
  }

  const sweepTasks: Array<() => Promise<void>> = [];
  for (const match of matches) {
    const path = environment.platform === 'win32' ? match.replace(/\//g, sep) : match;
    const key = claimKey(path, environment);
    if (claimed.has(key)) continue;
    claimed.add(key);

    sweepTasks.push(async () => {
      try {
        const stats = await lstat(path);
        if (stats.isSymbolicLink() || !stats.isFile()) return;
        const hash = await hashFile(path, stats.size, maxFileBytes);
        const name = basename(path);

        files.push({
          id: fileId(path),
          path,
          displayPath: toDisplayPath(path, environment),
          name,
          providerId: 'unattributed',
          providerName: 'Unattributed',
          locationId: 'sweep',
          locationLabel: `Found under ${relative(root, dirname(path)) || '.'}`,
          scope: 'project',
          kind: name.toLowerCase().includes('mcp') ? 'mcp' : 'instructions',
          format: inferFormat(name),
          sensitivity: name.toLowerCase().includes('mcp') ? 'contains-secrets' : 'normal',
          size: stats.size,
          modified: stats.mtime.toISOString(),
          hash,
          projectRoot: root,
          note: 'No provider claims this path. It may be read by a tool that is not in the registry.',
          unattributed: true,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        problems.push({ path, message: errorMessage(error), code: classifyError(error) });
      }
    });
  }
  await runBounded(sweepTasks, concurrency, signal);
}

/** Windows paths are compared case-insensitively when deduplicating. */
function claimKey(path: string, environment: ResolverEnvironment): string {
  return environment.platform === 'win32' ? path.toLowerCase() : path;
}

/** Groups discovered files by provider for UI navigation. */
export function groupByProvider(
  files: readonly DiscoveredFile[],
): Array<{ providerId: string; providerName: string; files: DiscoveredFile[] }> {
  const groups = new Map<
    string,
    { providerId: string; providerName: string; files: DiscoveredFile[] }
  >();

  for (const file of files) {
    let group = groups.get(file.providerId);
    if (!group) {
      group = { providerId: file.providerId, providerName: file.providerName, files: [] };
      groups.set(file.providerId, group);
    }
    group.files.push(file);
  }

  return [...groups.values()].sort((a, b) => {
    const orderA = providerOrder(a.providerId);
    const orderB = providerOrder(b.providerId);
    if (orderA !== orderB) return orderA - orderB;
    return a.providerName.localeCompare(b.providerName);
  });
}

/** Known providers sort before the unattributed bucket. */
function providerOrder(providerId: string): number {
  if (providerId === 'unattributed') return 2;
  return providersById.has(providerId) ? 0 : 1;
}

/** Absolute path to a file inside a project root, used by tests and the API. */
export function projectFile(root: string, ...segments: string[]): string {
  return join(root, ...segments);
}
