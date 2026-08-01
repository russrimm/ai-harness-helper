/**
 * Shared domain types for AI Harness Helper.
 *
 * The discovery model is deliberately data-driven: a provider registry
 * describes *where* configuration lives and *what shape* it has, and the
 * scanner turns that description into a concrete inventory of files found on
 * the current machine.
 */

/** Operating-system families the resolver understands. */
export type PlatformId = 'win32' | 'darwin' | 'linux';

/**
 * Where a configuration file sits in the precedence chain.
 *
 * - `managed`  administrator/enterprise policy, highest precedence
 * - `user`     per-user global configuration
 * - `project`  repository-local configuration, usually highest precedence
 *              for the project it lives in
 */
export type ConfigScope = 'managed' | 'user' | 'project';

/** What a discovered file *is*, independent of its serialization format. */
export type FileKind =
  | 'settings'
  | 'mcp'
  | 'instructions'
  | 'agent'
  | 'skill'
  | 'prompt'
  | 'command'
  | 'chatmode'
  | 'permissions'
  | 'ignore'
  | 'memory'
  | 'extension'
  /**
   * A listing of servers or tools that are *available* to install, as opposed
   * to ones the user has configured. Catalogs are displayed but deliberately
   * excluded from the harness inventory, because treating a marketplace of
   * hundreds of offerings as "your servers" would be actively misleading.
   */
  | 'catalog'
  | 'credential'
  | 'unknown';

/** How a file is serialized. Drives parser selection and editor highlighting. */
export type FileFormat =
  'json' | 'jsonc' | 'toml' | 'yaml' | 'markdown' | 'md-frontmatter' | 'text';

/**
 * How carefully the file must be handled.
 *
 * - `normal`            no special handling
 * - `contains-secrets`  may embed credentials inline; redact values
 * - `credential-store`  exists purely to hold credentials; never render,
 *                       never edit
 */
export type Sensitivity = 'normal' | 'contains-secrets' | 'credential-store';

/** A provider is a tool whose harness configuration we know how to find. */
export interface ProviderDefinition {
  /** Stable machine identifier, e.g. `claude-code`. */
  readonly id: string;
  /** Human-readable name shown in the UI. */
  readonly name: string;
  /** One-line description of the tool. */
  readonly description: string;
  /** Grouping used by the UI for navigation. */
  readonly category: 'agent-cli' | 'editor' | 'desktop-app' | 'runtime' | 'universal';
  /** Optional documentation URL for the tool's configuration reference. */
  readonly docsUrl?: string;
  /** Locations this provider reads configuration from. */
  readonly locations: readonly LocationDefinition[];
}

/**
 * A single place a provider stores configuration.
 *
 * Exactly one of `path` or `glob` is used per platform entry. Path templates
 * use `{token}` placeholders resolved by {@link PathResolver}.
 */
export interface LocationDefinition {
  /** Unique within the owning provider, e.g. `user-settings`. */
  readonly id: string;
  /** Human-readable label, e.g. "Global settings". */
  readonly label: string;
  /** Precedence scope. */
  readonly scope: ConfigScope;
  /** What the file represents. */
  readonly kind: FileKind;
  /** Serialization format. */
  readonly format: FileFormat;
  /** Handling requirements. */
  readonly sensitivity: Sensitivity;
  /**
   * Path templates per platform. A location may exist on some platforms only.
   * `project` scope locations use the `{project}` token and are the same on
   * every platform, so they may supply a single `all` entry.
   */
  readonly paths: PlatformPaths;
  /**
   * When true the resolved path is a directory whose matching children are
   * each treated as a separate discovered file.
   */
  readonly directory?: boolean;
  /** Glob patterns applied inside `directory` locations, relative to it. */
  readonly patterns?: readonly string[];
  /** Optional note surfaced in the UI, e.g. deprecation guidance. */
  readonly note?: string;
  /** Marks legacy formats that a newer file supersedes. */
  readonly deprecated?: boolean;
}

/** Path templates keyed by platform, or `all` for platform-independent paths. */
export interface PlatformPaths {
  readonly all?: readonly string[];
  readonly win32?: readonly string[];
  readonly darwin?: readonly string[];
  readonly linux?: readonly string[];
}

/** The environment the resolver expands `{token}` placeholders against. */
export interface ResolverEnvironment {
  readonly platform: PlatformId;
  readonly home: string;
  readonly appData: string;
  readonly localAppData: string;
  readonly programData: string;
  readonly xdgConfig: string;
  readonly appSupport: string;
  readonly pathSeparator: string;
}

/** A location definition resolved to concrete absolute paths. */
export interface ResolvedLocation {
  readonly providerId: string;
  readonly locationId: string;
  readonly definition: LocationDefinition;
  /** Absolute, normalized candidate paths on this machine. */
  readonly candidates: readonly string[];
  /** Project root this resolution belongs to, for `project` scope only. */
  readonly projectRoot?: string;
}
