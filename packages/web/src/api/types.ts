/**
 * Mirrors of the API contract exposed by `@ai-harness-helper/cli`'s server.
 *
 * These types are intentionally duplicated rather than imported from
 * `@ai-harness-helper/core` so the web package can build and ship on its own.
 */

export type ConfigScope = 'managed' | 'user' | 'project';

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
  | 'catalog'
  | 'credential'
  | 'unknown';

export type FileFormat =
  'json' | 'jsonc' | 'toml' | 'yaml' | 'markdown' | 'md-frontmatter' | 'text';

export type Sensitivity = 'normal' | 'contains-secrets' | 'credential-store';

export interface DiscoveredFile {
  id: string;
  path: string;
  displayPath: string;
  directory: string;
  name: string;
  providerId: string;
  providerName: string;
  locationId: string;
  locationLabel: string;
  scope: ConfigScope;
  kind: FileKind;
  format: FileFormat;
  sensitivity: Sensitivity;
  size: number;
  modified: string;
  hash: string;
  projectRoot?: string;
  note?: string;
  deprecated?: boolean;
  unattributed?: boolean;
}

export interface MissingLocation {
  providerId: string;
  providerName: string;
  locationId: string;
  locationLabel: string;
  scope: ConfigScope;
  kind: FileKind;
  checkedPaths: string[];
  projectRoot?: string;
}

export interface ScanProblem {
  path: string;
  providerId?: string;
  locationId?: string;
  message: string;
  code: 'permission-denied' | 'read-error' | 'too-large';
}

export interface ProjectRootInfo {
  path: string;
  name: string;
  fileCount: number;
}

export interface ScanResult {
  scannedAt: string;
  platform: string;
  home: string;
  files: DiscoveredFile[];
  missing: MissingLocation[];
  problems: ScanProblem[];
  projectRoots: ProjectRootInfo[];
  detectedProviders: string[];
  durationMs: number;
}

export interface ProviderGroup {
  providerId: string;
  providerName: string;
  files: DiscoveredFile[];
}

export interface ScanResponse extends ScanResult {
  tree: ProviderGroup[];
}

export type RedactionReason = 'key-name' | 'value-shape';

export interface RedactionRecord {
  path: string;
  id: string;
  reason: RedactionReason;
  detector?: string;
  length: number;
}

export interface ParseIssue {
  message: string;
  line?: number;
  column?: number;
}

export interface FileDocument {
  file: DiscoveredFile;
  content: string;
  revealed: boolean;
  redactions: RedactionRecord[];
  hash: string;
  language: 'json' | 'yaml' | 'markdown' | 'text';
  issues: ParseIssue[];
  readOnly: boolean;
  readOnlyReason?: string;
}

export type McpTransport = 'stdio' | 'http' | 'sse' | 'websocket' | 'unknown';

/** Where a declaration came from. Carried on every synthesized entry. */
export interface EntryProvenance {
  fileId: string;
  filePath: string;
  displayPath: string;
  directory: string;
  fileName: string;
  providerId: string;
  providerName: string;
  locationLabel: string;
  scope: ConfigScope;
}

export interface DuplicateInfo {
  key: string;
  duplicated: boolean;
  conflicting: boolean;
  siblingFileIds: string[];
  siblingDisplayPaths: string[];
  identicalFileIds: string[];
}

export interface McpDefinition extends EntryProvenance {
  projectRoot?: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  reference?: string;
  envKeys: string[];
  hasInlineSecret: boolean;
  disabled: boolean;
  signature: string;
}

export interface McpServerEntry {
  name: string;
  definitions: McpDefinition[];
  providerIds: string[];
  directories: string[];
  conflicting: boolean;
  duplicated: boolean;
}

export interface InstructionEntry extends EntryProvenance {
  projectRoot?: string;
  title: string;
  description?: string;
  appliesTo?: string;
  bytes: number;
  lineCount: number;
  precedence: number;
  duplicate: DuplicateInfo;
}

export type CapabilityKind = 'agent' | 'skill' | 'command' | 'prompt' | 'chatmode';

export interface CapabilityEntry extends EntryProvenance {
  kind: CapabilityKind;
  name: string;
  description?: string;
  tools?: string[];
  model?: string;
  projectRoot?: string;
  duplicate: DuplicateInfo;
}

export type GuardrailKind = 'permissions' | 'ignore' | 'settings';

export interface GuardrailEntry extends EntryProvenance {
  kind: GuardrailKind;
  allow: string[];
  deny: string[];
  ask: string[];
  hooks: string[];
  ignorePatterns: string[];
  projectRoot?: string;
  duplicate: DuplicateInfo;
}

export type FindingSeverity = 'info' | 'warning' | 'error';

export type FindingCode =
  | 'mcp-duplicate'
  | 'mcp-conflict'
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

export interface HealthFinding {
  id: string;
  code: FindingCode;
  severity: FindingSeverity;
  title: string;
  detail: string;
  fileIds: string[];
  displayPaths: string[];
  remediation?: string;
}

export interface HarnessSummary {
  providerCount: number;
  fileCount: number;
  mcpServerCount: number;
  mcpDefinitionCount: number;
  instructionCount: number;
  capabilityCount: number;
  guardrailCount: number;
  findingCount: number;
  errorCount: number;
  warningCount: number;
  duplicateCount: number;
  conflictCount: number;
  directoryCount: number;
  totalBytes: number;
}

export interface HarnessInventory {
  summary: HarnessSummary;
  mcpServers: McpServerEntry[];
  instructions: InstructionEntry[];
  capabilities: CapabilityEntry[];
  guardrails: GuardrailEntry[];
  findings: HealthFinding[];
  parsedFileIds: string[];
}

export interface OverviewResponse {
  summary: HarnessSummary;
  findings: HealthFinding[];
  platform: string;
  scannedAt: string;
  durationMs: number;
  projectRoots: ProjectRootInfo[];
  detectedProviders: string[];
  missingCount: number;
  tree: ProviderGroup[];
}

export interface SearchHit {
  fileId: string;
  displayPath: string;
  providerId: string;
  providerName: string;
  line: number;
  text: string;
}

export interface SearchResponse {
  query: string;
  hits: SearchHit[];
  truncated: boolean;
  filesSearched: number;
}

export interface ProjectsResponse {
  roots: string[];
}

export interface SourceFileRef {
  fileId: string;
  name: string;
  displayPath: string;
  directory: string;
  kind: FileKind;
  format: FileFormat;
  sensitivity: Sensitivity;
  size: number;
  modified: string;
  editable: boolean;
  notEditableReason?: string;
  deprecated?: boolean;
  unattributed?: boolean;
}

export interface SourceLocation {
  providerId: string;
  providerName: string;
  locationId: string;
  locationLabel: string;
  scope: ConfigScope;
  kind: FileKind;
  format: FileFormat;
  sensitivity: Sensitivity;
  status: 'active' | 'absent';
  directories: string[];
  checkedPaths: string[];
  templates: string[];
  files: SourceFileRef[];
  note?: string;
  deprecated?: boolean;
  projectRoot?: string;
}

export interface SourceProvider {
  providerId: string;
  providerName: string;
  description: string;
  category: 'agent-cli' | 'editor' | 'desktop-app' | 'runtime' | 'universal';
  docsUrl?: string;
  detected: boolean;
  fileCount: number;
  locationCount: number;
  activeLocationCount: number;
  directories: string[];
  locations: SourceLocation[];
}

export interface SourcesResponse {
  platform: string;
  home: string;
  scannedAt: string;
  readOnly: boolean;
  projectRoots: string[];
  providers: SourceProvider[];
  totals: {
    providers: number;
    detectedProviders: number;
    locations: number;
    activeLocations: number;
    files: number;
    directories: number;
  };
}

export type WriteRefusalCode =
  | 'read-only'
  | 'credential-store'
  | 'invalid-content'
  | 'hash-mismatch'
  | 'not-found'
  | 'write-failed';

export interface WriteRefusal {
  ok: false;
  code: WriteRefusalCode;
  message: string;
  issues?: ParseIssue[];
  currentHash?: string;
}

export interface WriteSuccess {
  ok: true;
  path: string;
  hash: string;
  backupPath: string;
  bytesWritten: number;
}

export type WriteOutcome = WriteSuccess | WriteRefusal;

export interface HealthResponse {
  ok: boolean;
  readOnly: boolean;
}
