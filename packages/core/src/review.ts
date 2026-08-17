/**
 * Quality review of the harness: is what you have any *good*?
 *
 * The inventory answers "what exists" and "what collides". Neither question
 * catches the failure that actually costs people time — a skill the model
 * never selects because it has no description, an instruction file pointing at
 * a document that was deleted six months ago, an MCP server whose API-key
 * variable was never exported. Those files parse cleanly, do not duplicate
 * anything, and are simply wrong.
 *
 * Every rule here obeys three constraints:
 *
 * 1. **Local only.** Nothing is fetched, nothing is executed, no model is
 *    called. Every judgement comes from bytes already on disk plus the
 *    environment this process was started with.
 * 2. **Precision over recall.** A false positive teaches the user to ignore
 *    the whole view, which costs more than the finding was worth. Where a rule
 *    cannot be sure it stays quiet, and where it is merely suggestive it is
 *    reported at `info`.
 * 3. **Every issue names its fix.** A finding the user cannot act on is
 *    noise wearing a severity badge.
 */

import { access, readFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { isAbsolute, resolve, dirname } from 'node:path';

import { mapConcurrent } from './concurrency.js';
import { parseContent } from './parsers.js';
import { redactText } from './redact.js';
import { assessModel, MODEL_RECORDS, normalizeModelReference } from './models.js';
import type {
  CapabilityEntry,
  GuardrailEntry,
  HarnessInventory,
  InstructionEntry,
  McpDefinition,
} from './aggregate.js';
import type { DiscoveredFile, ScanResult } from './scanner.js';
import type { ConfigScope, FileKind } from './types.js';

/** Which part of the harness a rule is about. */
export type ReviewCategory = 'capability' | 'instruction' | 'mcp' | 'guardrail' | 'freshness';

/** How badly a rule failure is likely to hurt. Mirrors {@link FindingSeverity}. */
export type ReviewSeverity = 'info' | 'warning' | 'error';

/** Stable identifier for every check this module performs. */
export type ReviewRuleId =
  // Capabilities
  | 'capability-missing-description'
  | 'capability-description-too-long'
  | 'capability-description-too-terse'
  | 'capability-missing-frontmatter'
  | 'capability-name-mismatch'
  | 'capability-empty-body'
  | 'capability-oversized'
  | 'capability-unknown-tool'
  // Instructions
  | 'instruction-missing-applyto'
  | 'instruction-oversized'
  | 'instruction-no-guidance'
  // Shared document rules
  | 'broken-reference'
  | 'stale-date'
  | 'renamed-product'
  | 'model-in-prose'
  // MCP
  | 'mcp-env-var-unset'
  | 'mcp-command-missing'
  | 'mcp-unpinned-package'
  | 'mcp-disabled'
  | 'mcp-insecure-endpoint'
  // Guardrails
  | 'guardrail-overbroad-allow'
  | 'guardrail-allow-shadows-deny'
  | 'guardrail-empty';

/** What a rule checks and why it is worth checking. Shown in the UI. */
export interface ReviewRuleMeta {
  readonly id: ReviewRuleId;
  readonly title: string;
  readonly category: ReviewCategory;
  /** Severity the rule reports at, or its worst severity when it varies. */
  readonly severity: ReviewSeverity;
  /** One sentence on why this matters, in the user's terms. */
  readonly rationale: string;
}

/** One rule failure against one subject. */
export interface ReviewIssue {
  /** Stable across runs, so the UI can keep a row selected through a rescan. */
  readonly id: string;
  readonly ruleId: ReviewRuleId;
  readonly category: ReviewCategory;
  readonly severity: ReviewSeverity;
  /** What the issue is about, e.g. a skill name or a server name. */
  readonly subject: string;
  /** Subject-specific headline. */
  readonly title: string;
  readonly detail: string;
  readonly remediation: string;
  readonly fileId: string;
  readonly displayPath: string;
  readonly directory: string;
  readonly providerId: string;
  readonly providerName: string;
  readonly scope: ConfigScope;
  readonly projectRoot?: string;
  /** Short, credential-safe excerpt showing what tripped the rule. */
  readonly evidence?: string;
}

/** Counts and a headline grade for the whole review. */
export interface ReviewSummary {
  readonly issueCount: number;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly infoCount: number;
  /** Files that produced at least one issue. */
  readonly affectedFileCount: number;
  /** Subjects reviewed: capabilities, instructions, servers, guardrails. */
  readonly reviewedSubjectCount: number;
  readonly ruleCount: number;
  /** 0–100. 100 means no rule fired. */
  readonly score: number;
  readonly grade: 'A' | 'B' | 'C' | 'D' | 'F';
  readonly byCategory: Readonly<Record<ReviewCategory, number>>;
}

/** The full result of a review pass. */
export interface ReviewReport {
  readonly generatedAt: string;
  readonly summary: ReviewSummary;
  readonly issues: readonly ReviewIssue[];
  /** Every rule that ran, so "nothing found" can name what was checked. */
  readonly rules: readonly ReviewRuleMeta[];
}

/** Tunable limits, exposed so a large-context user can raise them. */
export interface ReviewThresholds {
  /** Longest useful capability description, in characters. */
  readonly maxDescriptionChars: number;
  /** Below this a description carries no routing signal. */
  readonly minDescriptionChars: number;
  /** Capability body size that starts costing real context, in bytes. */
  readonly maxCapabilityBytes: number;
  /** Always-on instruction file size that starts costing real context. */
  readonly maxInstructionBytes: number;
  /** A body shorter than this says nothing. */
  readonly minBodyChars: number;
  /** Age, in days, at which a self-declared "as of" date reads as stale. */
  readonly staleDateDays: number;
}

export const DEFAULT_REVIEW_THRESHOLDS: ReviewThresholds = {
  // Claude's skill front matter caps `description` at 1024 characters, and a
  // description longer than that is silently truncated rather than rejected.
  maxDescriptionChars: 1024,
  minDescriptionChars: 16,
  maxCapabilityBytes: 16 * 1024,
  maxInstructionBytes: 16 * 1024,
  minBodyChars: 40,
  staleDateDays: 365,
};

export interface ReviewOptions {
  /** Overrides the default `fs.readFile` loader. */
  readonly loadContent?: (file: DiscoveredFile) => Promise<string | undefined>;
  /** Clock, injectable so date-sensitive rules do not drift in tests. */
  readonly now?: Date;
  /** Environment consulted for `${VAR}` references. Names only are read. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Existence probe for referenced paths. Injectable for tests. */
  readonly pathExists?: (path: string) => Promise<boolean>;
  readonly thresholds?: Partial<ReviewThresholds>;
}

/**
 * Every check, as data.
 *
 * Exported so the UI can list what was verified even when nothing fired —
 * "no issues" is only reassuring if you can see what was looked for.
 */
export const REVIEW_RULES: readonly ReviewRuleMeta[] = [
  {
    id: 'capability-missing-description',
    title: 'Capability has no description',
    category: 'capability',
    severity: 'error',
    rationale:
      'Skills and subagents are selected by their description. Without one the model has nothing to match against, so the capability is effectively invisible however good its instructions are.',
  },
  {
    id: 'capability-description-too-long',
    title: 'Description exceeds the front-matter limit',
    category: 'capability',
    severity: 'warning',
    rationale:
      'A description past the tool’s cap is truncated silently, so the part that explains when to use the capability may never reach the model.',
  },
  {
    id: 'capability-description-too-terse',
    title: 'Description is too short to route on',
    category: 'capability',
    severity: 'info',
    rationale:
      'A few words restating the name gives the model no trigger conditions, so the capability is picked by luck rather than by fit.',
  },
  {
    id: 'capability-missing-frontmatter',
    title: 'Capability file has no front matter',
    category: 'capability',
    severity: 'warning',
    rationale:
      'Without a front-matter block the tool has no name, description, or model to read, and generally falls back to the file name.',
  },
  {
    id: 'capability-name-mismatch',
    title: 'Declared name disagrees with the file name',
    category: 'capability',
    severity: 'warning',
    rationale:
      'Several tools invoke a capability by its directory or file name and display the declared one, so a mismatch means the name you see is not the name you type.',
  },
  {
    id: 'capability-empty-body',
    title: 'Capability has metadata but no instructions',
    category: 'capability',
    severity: 'warning',
    rationale:
      'A capability whose body is empty still occupies a name and a description, so the model can select it and then receive no guidance at all.',
  },
  {
    id: 'capability-oversized',
    title: 'Capability body is very large',
    category: 'capability',
    severity: 'info',
    rationale:
      'Large capability bodies are loaded whole once selected, crowding out the actual task. Splitting rarely used detail into a referenced file keeps the trigger cheap.',
  },
  {
    id: 'capability-unknown-tool',
    title: 'Tool allowlist names an MCP server that is not configured',
    category: 'capability',
    severity: 'warning',
    rationale:
      'An allowlist entry pointing at a server no file declares grants nothing, so the capability quietly runs without the tool it was written around.',
  },
  {
    id: 'instruction-missing-applyto',
    title: 'Scoped instruction file declares no applyTo',
    category: 'instruction',
    severity: 'warning',
    rationale:
      'Files in an instructions directory are matched to work by their applyTo glob. Without one the file is either ignored or applied everywhere, and which of those happens depends on the tool.',
  },
  {
    id: 'instruction-oversized',
    title: 'Always-on instruction file is very large',
    category: 'instruction',
    severity: 'warning',
    rationale:
      'This file is prepended to every single request. Every kilobyte here is paid for on every turn, whether or not it is relevant.',
  },
  {
    id: 'instruction-no-guidance',
    title: 'Instruction file contains no actual guidance',
    category: 'instruction',
    severity: 'info',
    rationale:
      'A file holding only headings or a title still loads on every request while telling the model nothing.',
  },
  {
    id: 'broken-reference',
    title: 'Links a file that does not exist',
    category: 'freshness',
    severity: 'warning',
    rationale:
      'A link to a moved or deleted document is the clearest signal that instructions have drifted from the repository they describe, and the model will confidently follow the dead pointer.',
  },
  {
    id: 'stale-date',
    title: 'Self-declared date is old',
    category: 'freshness',
    severity: 'info',
    rationale:
      'The document states when it was last verified, and that was long enough ago that anything it asserts about a fast-moving product deserves rechecking.',
  },
  {
    id: 'renamed-product',
    title: 'Uses a retired product name',
    category: 'freshness',
    severity: 'info',
    rationale:
      'A renamed product is a reliable marker of an instruction written against an older world, and the old name steers the model towards outdated documentation.',
  },
  {
    id: 'model-in-prose',
    title: 'Prose names a retired model',
    category: 'freshness',
    severity: 'info',
    rationale:
      'A model id written into the instructions rather than front matter is invisible to the model checker, and telling an agent to "use" a model that no longer exists wastes a turn.',
  },
  {
    id: 'mcp-env-var-unset',
    title: 'Server needs an environment variable that is not set',
    category: 'mcp',
    severity: 'warning',
    rationale:
      'The definition expands a variable this machine does not export, so the server starts without its credential and fails at first use rather than at launch.',
  },
  {
    id: 'mcp-command-missing',
    title: 'Server command does not exist on this machine',
    category: 'mcp',
    severity: 'warning',
    rationale:
      'The declared executable or script is an absolute path that is not there, so the server cannot start at all.',
  },
  {
    id: 'mcp-unpinned-package',
    title: 'Server runs an unpinned package',
    category: 'mcp',
    severity: 'info',
    rationale:
      'Resolving the newest version on every launch means the tools in your context can change without you changing anything, and a compromised release is executed automatically.',
  },
  {
    id: 'mcp-disabled',
    title: 'Server is declared but disabled',
    category: 'mcp',
    severity: 'info',
    rationale:
      'A disabled server contributes nothing but still has to be read, understood, and maintained by whoever next opens the file.',
  },
  {
    id: 'mcp-insecure-endpoint',
    title: 'Server endpoint is plain HTTP',
    category: 'mcp',
    severity: 'warning',
    rationale:
      'Traffic to a non-loopback HTTP endpoint, including any token sent with it, crosses the network unencrypted.',
  },
  {
    id: 'guardrail-overbroad-allow',
    title: 'Permission rule allows everything',
    category: 'guardrail',
    severity: 'warning',
    rationale:
      'A wildcard allow pre-approves every command in its class, which removes the prompt that would otherwise be your last chance to stop a destructive one.',
  },
  {
    id: 'guardrail-allow-shadows-deny',
    title: 'The same pattern is both allowed and denied',
    category: 'guardrail',
    severity: 'warning',
    rationale:
      'One of the two rules is dead, and which one depends on the tool, so the file does not say what it appears to say.',
  },
  {
    id: 'guardrail-empty',
    title: 'Guardrail file declares no rules',
    category: 'guardrail',
    severity: 'info',
    rationale:
      'An empty permissions or ignore file constrains nothing while reading as though it does.',
  },
];

const RULES_BY_ID = new Map<ReviewRuleId, ReviewRuleMeta>(REVIEW_RULES.map((r) => [r.id, r]));

/** Kinds whose content the review needs to read. */
const DOCUMENT_KINDS = new Set<FileKind>([
  'agent',
  'skill',
  'command',
  'prompt',
  'chatmode',
  'instructions',
  'memory',
]);

const READ_CONCURRENCY = 8;

/**
 * Product renames with an unambiguous current name.
 *
 * Deliberately short. Every entry has to be a rename the vendor actually
 * announced, matched with word boundaries, because a near-miss here produces
 * exactly the kind of confident wrong finding that discredits the whole view.
 * Reported at `info` for the same reason.
 */
interface RenamedProduct {
  readonly pattern: RegExp;
  readonly was: string;
  readonly now: string;
}

const RENAMED_PRODUCTS: readonly RenamedProduct[] = [
  {
    pattern: /\bAzure Active Directory\b/i,
    was: 'Azure Active Directory',
    now: 'Microsoft Entra ID',
  },
  { pattern: /\bAzure AD B2C\b/i, was: 'Azure AD B2C', now: 'Microsoft Entra External ID' },
  { pattern: /\bAzure AD\b/i, was: 'Azure AD', now: 'Microsoft Entra ID' },
  {
    pattern: /\bAzure Cognitive Services\b/i,
    was: 'Azure Cognitive Services',
    now: 'Azure AI services',
  },
  { pattern: /\bCognitive Search\b/i, was: 'Azure Cognitive Search', now: 'Azure AI Search' },
  { pattern: /\bAzure OpenAI Studio\b/i, was: 'Azure OpenAI Studio', now: 'Microsoft Foundry' },
  { pattern: /\bAzure AI Studio\b/i, was: 'Azure AI Studio', now: 'Microsoft Foundry' },
  { pattern: /\bAzure AI Foundry\b/i, was: 'Azure AI Foundry', now: 'Microsoft Foundry' },
  {
    pattern: /\bMicrosoft Endpoint Manager\b/i,
    was: 'Microsoft Endpoint Manager',
    now: 'Microsoft Intune',
  },
  {
    pattern: /\bWindows Virtual Desktop\b/i,
    was: 'Windows Virtual Desktop',
    now: 'Azure Virtual Desktop',
  },
  { pattern: /\bMicrosoft Flow\b/i, was: 'Microsoft Flow', now: 'Power Automate' },
  { pattern: /\bPowerApps\b/, was: 'PowerApps', now: 'Power Apps' },
  { pattern: /\bPower Apps Portals\b/i, was: 'Power Apps Portals', now: 'Power Pages' },
  { pattern: /\bVisual Studio Online\b/i, was: 'Visual Studio Online', now: 'Azure DevOps' },
  {
    pattern: /\bAzure Container Service\b/i,
    was: 'Azure Container Service',
    now: 'Azure Kubernetes Service',
  },
];

/**
 * Reviews the harness for quality problems the inventory cannot see.
 *
 * Reads only capability and instruction documents, because every other rule
 * runs off the already-synthesized inventory. Nothing is written, executed, or
 * sent anywhere.
 */
export async function reviewHarness(
  scan: ScanResult,
  inventory: HarnessInventory,
  options: ReviewOptions = {},
): Promise<ReviewReport> {
  const now = options.now ?? new Date();
  const env = options.env ?? process.env;
  const exists = options.pathExists ?? defaultPathExists;
  const load = options.loadContent ?? defaultLoader;
  const thresholds: ReviewThresholds = { ...DEFAULT_REVIEW_THRESHOLDS, ...options.thresholds };

  const filesById = new Map(scan.files.map((file) => [file.id, file]));
  const issues: ReviewIssue[] = [];

  const documentIds = new Set<string>();
  for (const entry of [...inventory.capabilities, ...inventory.instructions]) {
    const file = filesById.get(entry.fileId);
    if (file && DOCUMENT_KINDS.has(file.kind) && file.sensitivity !== 'credential-store') {
      documentIds.add(entry.fileId);
    }
  }

  const documents = [...documentIds]
    .map((id) => filesById.get(id))
    .filter((file): file is DiscoveredFile => file !== undefined);

  const texts = await mapConcurrent(documents, READ_CONCURRENCY, async (file) => {
    try {
      return await load(file);
    } catch {
      return undefined;
    }
  });
  const textById = new Map<string, string>();
  documents.forEach((file, index) => {
    const text = texts[index];
    if (text !== undefined) textById.set(file.id, text);
  });

  const knownServers = new Set(inventory.mcpServers.map((server) => server.name.toLowerCase()));

  for (const capability of inventory.capabilities) {
    const file = filesById.get(capability.fileId);
    if (!file) continue;
    const text = textById.get(capability.fileId);
    issues.push(...reviewCapability(capability, file, text, knownServers, thresholds));
    if (text !== undefined) {
      issues.push(
        ...(await reviewDocumentText(capability.name, file, text, { now, exists, thresholds })),
      );
    }
  }

  for (const instruction of inventory.instructions) {
    const file = filesById.get(instruction.fileId);
    if (!file) continue;
    const text = textById.get(instruction.fileId);
    issues.push(...reviewInstruction(instruction, file, text, thresholds));
    if (text !== undefined) {
      issues.push(
        ...(await reviewDocumentText(instruction.title, file, text, { now, exists, thresholds })),
      );
    }
  }

  for (const server of inventory.mcpServers) {
    for (const definition of server.definitions) {
      issues.push(...(await reviewMcpDefinition(server.name, definition, env, exists)));
    }
  }

  for (const guardrail of inventory.guardrails) {
    issues.push(...reviewGuardrail(guardrail));
  }

  const deduped = dedupe(issues);
  deduped.sort(compareIssues);

  const reviewedSubjectCount =
    inventory.capabilities.length +
    inventory.instructions.length +
    inventory.mcpServers.length +
    inventory.guardrails.length;

  return {
    generatedAt: now.toISOString(),
    issues: deduped,
    rules: REVIEW_RULES,
    summary: summarize(deduped, reviewedSubjectCount),
  };
}

// ---------------------------------------------------------------------------
// Capability rules
// ---------------------------------------------------------------------------

function reviewCapability(
  capability: CapabilityEntry,
  file: DiscoveredFile,
  text: string | undefined,
  knownServers: ReadonlySet<string>,
  thresholds: ReviewThresholds,
): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  const emit = issueFactory(capability.name, file, {
    ...(capability.projectRoot !== undefined ? { projectRoot: capability.projectRoot } : {}),
  });

  const parsed = text === undefined ? undefined : parseContent(text, file.format);
  const frontmatter = parsed?.frontmatter;
  const body = parsed?.body ?? '';

  // A prompt or command is often a bare instruction with no metadata at all,
  // and that is a legitimate shape for both. Only agents, skills, and chat
  // modes are routed by description, so only they are held to it.
  const routedByDescription =
    capability.kind === 'agent' || capability.kind === 'skill' || capability.kind === 'chatmode';

  if (text !== undefined && frontmatter === undefined && routedByDescription) {
    // "No front matter" and "front matter that never closes" need opposite
    // advice, and the second is the more common failure: the file looks
    // correct at a glance and the tool silently reads the whole thing as prose.
    const unterminated = /^\uFEFF?---\r?\n/.test(text);
    issues.push(
      unterminated
        ? emit(
            'capability-missing-frontmatter',
            'warning',
            `${capability.name} has front matter that is never closed`,
            `${file.displayPath} opens with \`---\` but no closing \`---\` line follows, so ${file.providerName} reads the metadata as body text and sees no name, description, or model.`,
            'Add the closing `---` on its own line, directly after the last metadata key.',
          )
        : emit(
            'capability-missing-frontmatter',
            'warning',
            `${capability.name} has no front matter`,
            `${file.displayPath} is loaded as ${describeKind(capability.kind)} but opens straight into prose, so ${file.providerName} has no declared name, description, or model to read.`,
            'Add a `---` front-matter block declaring at least `name` and `description`.',
          ),
    );
  }

  const description = capability.description?.trim() ?? '';

  if (routedByDescription && description.length === 0 && frontmatter !== undefined) {
    issues.push(
      emit(
        'capability-missing-description',
        'error',
        `${capability.name} has no description`,
        `Nothing in ${file.displayPath} tells ${file.providerName} when this ${describeKind(capability.kind)} should be used, so it is unlikely ever to be selected.`,
        'Add a `description` naming the task it handles and the conditions that should trigger it.',
      ),
    );
  } else if (description.length > thresholds.maxDescriptionChars) {
    issues.push(
      emit(
        'capability-description-too-long',
        'warning',
        `${capability.name} has an over-long description`,
        `The description is ${description.length} characters, past the ${thresholds.maxDescriptionChars}-character limit most tools enforce, so the end of it is dropped without warning.`,
        'Move the detail into the body and keep the description to the trigger conditions.',
      ),
    );
  } else if (
    routedByDescription &&
    description.length > 0 &&
    description.length < thresholds.minDescriptionChars
  ) {
    issues.push(
      emit(
        'capability-description-too-terse',
        'info',
        `${capability.name} has a description too short to route on`,
        `"${description}" gives ${file.providerName} no trigger conditions to match a request against.`,
        'Say what the capability does and when it should be chosen over the alternatives.',
        description,
      ),
    );
  }

  const declaredName = asTrimmedString(frontmatter?.['name']);
  if (declaredName) {
    const expected = expectedNameFor(file);
    if (expected && !namesAgree(declaredName, expected)) {
      issues.push(
        emit(
          'capability-name-mismatch',
          'warning',
          `${capability.name} is declared under a different name than its file`,
          `Front matter says \`${declaredName}\` but the file resolves to \`${expected}\`. Tools that invoke by path will not find \`${declaredName}\`.`,
          `Rename the file to match \`${declaredName}\`, or change the front matter to \`${expected}\`.`,
          `${declaredName} ≠ ${expected}`,
        ),
      );
    }
  }

  if (text !== undefined) {
    const bodyText = body.trim();
    if (frontmatter !== undefined && bodyText.length < thresholds.minBodyChars) {
      issues.push(
        emit(
          'capability-empty-body',
          'warning',
          `${capability.name} declares itself but gives no instructions`,
          `${file.displayPath} has front matter and ${bodyText.length === 0 ? 'no body at all' : `only ${bodyText.length} characters of body`}, so selecting it contributes nothing.`,
          'Write the instructions, or delete the file so it stops competing for selection.',
        ),
      );
    }

    const bodyBytes = Buffer.byteLength(body, 'utf8');
    if (bodyBytes > thresholds.maxCapabilityBytes) {
      issues.push(
        emit(
          'capability-oversized',
          'info',
          `${capability.name} is ${formatBytes(bodyBytes)} of instructions`,
          `Once selected, the whole body is loaded, which is roughly ${estimateTokens(bodyBytes).toLocaleString()} tokens of context spent before the task starts.`,
          'Keep the trigger path short and move reference material into a linked file the agent can open when it needs it.',
        ),
      );
    }
  }

  for (const tool of capability.tools ?? []) {
    const server = mcpServerNameFrom(tool);
    if (server && !knownServers.has(server.toLowerCase())) {
      issues.push(
        emit(
          'capability-unknown-tool',
          'warning',
          `${capability.name} allowlists a server that is not configured`,
          `\`${tool}\` names the MCP server \`${server}\`, which no file in this harness declares.`,
          `Configure \`${server}\`, or remove the entry so the allowlist reflects what is actually available.`,
          tool,
        ),
      );
    }
  }

  return issues;
}

/**
 * The name a tool would infer from where the file sits.
 *
 * Skills are addressed by their containing directory (`skills/deploy/SKILL.md`
 * is `deploy`); everything else by its file name with the tool's compound
 * suffix removed. Returns undefined when neither convention applies, because
 * guessing would produce a mismatch finding on a file that is perfectly fine.
 */
function expectedNameFor(file: DiscoveredFile): string | undefined {
  const lower = file.name.toLowerCase();
  if (lower === 'skill.md' || lower === 'agent.md') {
    const parent = dirname(file.path).split(/[\\/]/).pop();
    return parent && parent.length > 0 ? parent : undefined;
  }
  const stem = file.name.replace(/\.(md|markdown|mdc|toml|ya?ml|json)$/i, '');
  const withoutSuffix = stem.replace(/\.(instructions|prompt|chatmode|agent|skill|mode)$/i, '');
  return withoutSuffix.length > 0 ? withoutSuffix : undefined;
}

/** Compares names the way a tool would: case- and separator-insensitively. */
function namesAgree(declared: string, expected: string): boolean {
  const normalize = (value: string): string => value.toLowerCase().replace(/[\s_-]+/g, '');
  return normalize(declared) === normalize(expected);
}

/**
 * Extracts the MCP server a tool allowlist entry refers to.
 *
 * Recognizes the `mcp__server__tool` convention Claude Code and Copilot use,
 * and the `mcp:server` / `server/tool` spellings other tools accept. A bare
 * word is deliberately *not* treated as a server, because built-ins like
 * `Read`, `Bash`, and `WebSearch` share that shape and flagging them would
 * make the rule useless.
 */
function mcpServerNameFrom(tool: string): string | undefined {
  const trimmed = tool.trim();
  const doubleUnderscore = /^mcp__([^_][^_]*(?:_[^_]+)*)__/.exec(trimmed);
  if (doubleUnderscore?.[1]) return doubleUnderscore[1];
  const prefixed = /^mcp[:/]([A-Za-z0-9._-]+)/.exec(trimmed);
  if (prefixed?.[1]) return prefixed[1];
  return undefined;
}

// ---------------------------------------------------------------------------
// Instruction rules
// ---------------------------------------------------------------------------

function reviewInstruction(
  instruction: InstructionEntry,
  file: DiscoveredFile,
  text: string | undefined,
  thresholds: ReviewThresholds,
): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  const emit = issueFactory(instruction.title, file, {
    ...(instruction.projectRoot !== undefined ? { projectRoot: instruction.projectRoot } : {}),
  });

  // Only files that live in a dedicated instructions directory are matched by
  // glob. A root CLAUDE.md or AGENTS.md is unconditional by design, so asking
  // it for an applyTo would be wrong.
  const isScoped = /\.instructions\.(md|mdc)$/i.test(file.name) || file.format === 'md-frontmatter';
  if (isScoped && !instruction.appliesTo && /\.instructions\./i.test(file.name)) {
    issues.push(
      emit(
        'instruction-missing-applyto',
        'warning',
        `${file.name} declares no applyTo`,
        `${file.displayPath} sits in an instructions directory, where files are attached to work by an \`applyTo\` glob. Without one ${file.providerName} either ignores it or applies it to everything.`,
        'Add `applyTo: "**"` to apply it everywhere deliberately, or a narrower glob to scope it.',
      ),
    );
  }

  if (instruction.bytes > thresholds.maxInstructionBytes && !instruction.appliesTo) {
    issues.push(
      emit(
        'instruction-oversized',
        'warning',
        `${instruction.title} is ${formatBytes(instruction.bytes)} loaded on every request`,
        `That is roughly ${estimateTokens(instruction.bytes).toLocaleString()} tokens spent before ${file.providerName} reads your actual question, on every single turn.`,
        'Move situational guidance into a scoped instruction file or a skill, and keep the always-on file to rules that apply to everything.',
      ),
    );
  }

  if (text !== undefined) {
    const prose = stripFrontmatter(text)
      .replace(/^\s*#{1,6}\s.*$/gm, '')
      .replace(/^\s*[-*+]\s*$/gm, '')
      .trim();
    if (prose.length < thresholds.minBodyChars && instruction.bytes > 0) {
      issues.push(
        emit(
          'instruction-no-guidance',
          'info',
          `${instruction.title} contains no actual guidance`,
          `${file.displayPath} is ${prose.length === 0 ? 'headings only' : `only ${prose.length} characters once headings are removed`}, yet it is still read on every request.`,
          'Fill it in or delete it.',
        ),
      );
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Shared document rules: references, dates, product names, prose models
// ---------------------------------------------------------------------------

interface DocumentRuleContext {
  readonly now: Date;
  readonly exists: (path: string) => Promise<boolean>;
  readonly thresholds: ReviewThresholds;
}

async function reviewDocumentText(
  subject: string,
  file: DiscoveredFile,
  text: string,
  context: DocumentRuleContext,
): Promise<ReviewIssue[]> {
  const issues: ReviewIssue[] = [];
  const emit = issueFactory(subject, file, {
    ...(file.projectRoot !== undefined ? { projectRoot: file.projectRoot } : {}),
  });

  for (const target of collectLocalLinks(text)) {
    const found = await resolvesToSomething(target, file, context.exists);
    if (found) continue;
    issues.push(
      emit(
        'broken-reference',
        'warning',
        `${subject} links a file that is not there`,
        `${file.displayPath} points at \`${target}\`, which does not exist relative to ${file.directory}${file.projectRoot ? ' or the project root' : ''}.`,
        'Update the link, or remove the reference so the agent is not sent somewhere that no longer exists.',
        target,
      ),
    );
  }

  const stale = findStaleDate(text, context.now, context.thresholds.staleDateDays);
  if (stale) {
    issues.push(
      emit(
        'stale-date',
        'info',
        `${subject} was last verified ${stale.ageDays} days ago`,
        `${file.displayPath} states "${stale.evidence}". Anything it asserts about a product that has shipped since then is worth rechecking.`,
        'Reverify the content and update the date, or drop the claim if it no longer holds.',
        stale.evidence,
      ),
    );
  }

  for (const rename of RENAMED_PRODUCTS) {
    if (!rename.pattern.test(text)) continue;
    issues.push(
      emit(
        'renamed-product',
        'info',
        `${subject} still says "${rename.was}"`,
        `That product is now called ${rename.now}. The old name steers the model towards documentation that has been superseded.`,
        `Replace "${rename.was}" with "${rename.now}".`,
        rename.was,
      ),
    );
  }

  for (const found of findRetiredModelsInProse(text, context.now)) {
    issues.push(
      emit(
        'model-in-prose',
        'info',
        `${subject} names the retired model ${found.reference}`,
        `${file.displayPath} mentions \`${found.reference}\` in its prose, where the model checker cannot see it. ${found.detail}`,
        found.replacement
          ? `Update the text to \`${found.replacement}\`.`
          : 'Update the text to a model that is still available.',
        found.reference,
      ),
    );
  }

  return issues;
}

/**
 * Markdown link targets that look like local files.
 *
 * Restricted to `[text](target)` on purpose. Backticked paths are far more
 * common in instructions but are usually illustrative rather than real
 * references, and checking them would bury every genuine broken link under
 * complaints about `~/.claude/settings.json` appearing in a sentence.
 */
function collectLocalLinks(text: string): string[] {
  const targets = new Set<string>();
  const pattern = /\[[^\]\n]*\]\(\s*<?([^)>\s]+)>?(?:\s+"[^"]*")?\s*\)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const raw = match[1];
    if (!raw) continue;
    const target = raw.split('#')[0]?.trim() ?? '';
    if (target.length === 0) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // http:, mailto:, vscode:, …
    if (target.startsWith('//')) continue;
    if (target.includes('*') || target.includes('{') || target.includes('$')) continue;
    if (target.startsWith('~')) continue; // home-relative, not repo-relative
    targets.add(target);
  }

  return [...targets];
}

/** True when a link target exists relative to the file, or to its project root. */
async function resolvesToSomething(
  target: string,
  file: DiscoveredFile,
  exists: (path: string) => Promise<boolean>,
): Promise<boolean> {
  const decoded = safeDecode(target);
  const candidates: string[] = [];

  if (isAbsolute(decoded)) {
    candidates.push(decoded);
  } else {
    candidates.push(resolve(dirname(file.path), decoded));
    if (file.projectRoot) candidates.push(resolve(file.projectRoot, decoded.replace(/^\.\//, '')));
  }

  for (const candidate of candidates) {
    if (await exists(candidate)) return true;
  }
  return false;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

interface StaleDate {
  readonly evidence: string;
  readonly ageDays: number;
}

/**
 * Finds a date the document itself offers as its freshness claim.
 *
 * Only phrases that explicitly assert currency count. A date appearing in an
 * example or a changelog entry says nothing about whether the guidance is
 * still true, so matching every date in the file would flag documents that are
 * perfectly current.
 */
function findStaleDate(text: string, now: Date, maxAgeDays: number): StaleDate | undefined {
  const pattern =
    /\b(?:as of|last updated|last verified|current as of|verified on|updated on|accurate as of)\b[:\s]+((?:\d{4}-\d{2}-\d{2})|(?:[A-Z][a-z]{2,8}\s+\d{1,2},?\s+\d{4})|(?:\d{1,2}\s+[A-Z][a-z]{2,8}\s+\d{4}))/gi;

  let oldest: StaleDate | undefined;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const raw = match[1];
    if (!raw) continue;
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) continue;
    const ageDays = Math.floor((now.getTime() - parsed.getTime()) / 86_400_000);
    if (ageDays < maxAgeDays) continue;
    if (!oldest || ageDays > oldest.ageDays) {
      oldest = { evidence: match[0].replace(/\s+/g, ' ').trim(), ageDays };
    }
  }

  return oldest;
}

interface ProseModel {
  readonly reference: string;
  readonly detail: string;
  readonly replacement?: string;
}

/**
 * Retired model ids named in prose.
 *
 * Matched against the bundled table rather than by pattern, and limited to
 * models that are already shut down. A model with a future shutdown date
 * mentioned in prose is not yet wrong, and flagging it would mean nagging
 * about a sentence that is still accurate.
 */
function findRetiredModelsInProse(text: string, now: Date): ProseModel[] {
  const found = new Map<string, ProseModel>();
  const body = stripFrontmatter(text);

  for (const record of MODEL_RECORDS) {
    if (record.shutdownDate === undefined) continue;
    for (const candidate of [record.id, ...(record.aliases ?? [])]) {
      if (candidate.length < 6) continue;
      const pattern = new RegExp(`(?<![A-Za-z0-9._-])${escapeRegExp(candidate)}(?![A-Za-z0-9._-])`);
      if (!pattern.test(body)) continue;
      const assessment = assessModel(candidate, now);
      if (assessment.status !== 'retired') continue;
      const key = normalizeModelReference(candidate);
      if (found.has(key)) continue;
      found.set(key, {
        reference: candidate,
        detail: `It was shut down on ${assessment.shutdownDate}.`,
        ...(assessment.replacement !== undefined ? { replacement: assessment.replacement } : {}),
      });
    }
  }

  return [...found.values()];
}

// ---------------------------------------------------------------------------
// MCP rules
// ---------------------------------------------------------------------------

async function reviewMcpDefinition(
  serverName: string,
  definition: McpDefinition,
  env: Readonly<Record<string, string | undefined>>,
  exists: (path: string) => Promise<boolean>,
): Promise<ReviewIssue[]> {
  const issues: ReviewIssue[] = [];
  const file: McpFileLike = {
    id: definition.fileId,
    path: definition.filePath,
    displayPath: definition.displayPath,
    directory: definition.directory,
    providerId: definition.providerId,
    providerName: definition.providerName,
    scope: definition.scope,
  };
  const emit = issueFactory(serverName, file, {
    ...(definition.projectRoot !== undefined ? { projectRoot: definition.projectRoot } : {}),
  });

  if (definition.disabled) {
    issues.push(
      emit(
        'mcp-disabled',
        'info',
        `${serverName} is configured but disabled`,
        `${definition.displayPath} declares ${serverName} with the disabled flag set, so ${definition.providerName} loads nothing from it.`,
        'Re-enable it if you still want it, or delete the declaration so the file stops describing a server you do not use.',
      ),
    );
  }

  const missing = definition.envVarRefs.filter((name) => {
    const value = env[name];
    return value === undefined || value.length === 0;
  });
  if (missing.length > 0) {
    issues.push(
      emit(
        'mcp-env-var-unset',
        'warning',
        `${serverName} needs ${missing.length === 1 ? 'a variable' : 'variables'} this machine does not set`,
        `The declaration expands ${missing.map((name) => `\`${name}\``).join(', ')}, but ${missing.length === 1 ? 'it is' : 'they are'} not set in this environment, so the value reaches the server empty.`,
        `Export ${missing.map((name) => `\`${name}\``).join(', ')} where ${definition.providerName} is launched from, or move the credential into the tool's own secret store.`,
        missing.join(', '),
      ),
    );
  }

  const command = definition.command;
  if (command !== undefined && isAbsolute(command) && !(await exists(command))) {
    issues.push(
      emit(
        'mcp-command-missing',
        'warning',
        `${serverName} points at a command that is not on this machine`,
        `${definition.displayPath} launches \`${command}\`, and nothing exists at that path, so the server cannot start.`,
        'Fix the path, reinstall the server, or remove the declaration.',
        command,
      ),
    );
  }

  const unpinned = findUnpinnedPackage(definition);
  if (unpinned) {
    issues.push(
      emit(
        'mcp-unpinned-package',
        'info',
        `${serverName} resolves its package fresh on every launch`,
        `\`${unpinned}\` has no version pin, so the tools this server contributes can change without you changing anything, and a compromised release would be executed automatically.`,
        `Pin a version, for example \`${unpinned}@1.2.3\`.`,
        unpinned,
      ),
    );
  }

  const url = definition.url;
  if (url !== undefined && isInsecureRemote(url)) {
    issues.push(
      emit(
        'mcp-insecure-endpoint',
        'warning',
        `${serverName} talks to a plain HTTP endpoint`,
        `${definition.displayPath} points at \`${url}\`, so anything sent to it — including an authorization header — crosses the network unencrypted.`,
        'Switch the endpoint to HTTPS.',
        url,
      ),
    );
  }

  return issues;
}

/** The package spec an `npx`/`uvx`/`pipx` launch resolves without a version. */
function findUnpinnedPackage(definition: McpDefinition): string | undefined {
  const command = definition.command?.toLowerCase() ?? '';
  const runner = /(^|[\\/])(npx|uvx|pipx|bunx|pnpm dlx)(\.cmd|\.exe)?$/.test(command);
  if (!runner) return undefined;

  for (const arg of definition.args ?? []) {
    if (arg.startsWith('-')) continue;
    if (arg.endsWith('@latest')) return arg.slice(0, -'@latest'.length);
    // A scoped name carries one leading `@`; a pinned one carries a second.
    const versioned = arg.startsWith('@') ? arg.indexOf('@', 1) > 0 : arg.includes('@');
    if (versioned) return undefined;
    if (/^[@a-z0-9][\w@./-]*$/i.test(arg)) return arg;
    return undefined;
  }
  return undefined;
}

/** True for an HTTP endpoint that is not loopback. */
function isInsecureRemote(url: string): boolean {
  if (!/^http:\/\//i.test(url)) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return !(
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '[::1]' ||
      host.endsWith('.localhost')
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Guardrail rules
// ---------------------------------------------------------------------------

/**
 * Allow patterns that approve an entire class of command.
 *
 * Matched exactly rather than by substring: `Bash(git *)` is a considered
 * decision, `Bash(*)` is the absence of one.
 */
const OVERBROAD_ALLOW = /^(\*|\*:\*|[A-Za-z]+\(\s*\*\s*\)|[A-Za-z]+\(\s*\*\s*:\s*\*\s*\))$/;

function reviewGuardrail(guardrail: GuardrailEntry): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  const file: McpFileLike = {
    id: guardrail.fileId,
    path: guardrail.filePath,
    displayPath: guardrail.displayPath,
    directory: guardrail.directory,
    providerId: guardrail.providerId,
    providerName: guardrail.providerName,
    scope: guardrail.scope,
  };
  const emit = issueFactory(guardrail.fileName, file, {
    ...(guardrail.projectRoot !== undefined ? { projectRoot: guardrail.projectRoot } : {}),
  });

  const overbroad = guardrail.allow.filter((rule) => OVERBROAD_ALLOW.test(rule.trim()));
  if (overbroad.length > 0) {
    issues.push(
      emit(
        'guardrail-overbroad-allow',
        'warning',
        `${guardrail.fileName} pre-approves everything in a class`,
        `${guardrail.displayPath} allows ${overbroad.map((rule) => `\`${rule}\``).join(', ')}, which removes the confirmation prompt for every command it covers, including destructive ones.`,
        'Replace the wildcard with the specific commands you actually want approved without a prompt.',
        overbroad.join(', '),
      ),
    );
  }

  const denied = new Set(guardrail.deny.map((rule) => rule.trim()));
  const shadowed = guardrail.allow.filter((rule) => denied.has(rule.trim()));
  if (shadowed.length > 0) {
    issues.push(
      emit(
        'guardrail-allow-shadows-deny',
        'warning',
        `${guardrail.fileName} both allows and denies the same rule`,
        `${shadowed.map((rule) => `\`${rule}\``).join(', ')} appears in allow and in deny. One of the two is dead, and which one depends on how ${guardrail.providerName} resolves the tie.`,
        'Delete whichever entry you did not mean, so the file says what it does.',
        shadowed.join(', '),
      ),
    );
  }

  const empty =
    guardrail.allow.length === 0 &&
    guardrail.deny.length === 0 &&
    guardrail.ask.length === 0 &&
    guardrail.hooks.length === 0 &&
    guardrail.ignorePatterns.length === 0;
  if (empty && guardrail.kind !== 'settings') {
    issues.push(
      emit(
        'guardrail-empty',
        'info',
        `${guardrail.fileName} declares no rules`,
        `${guardrail.displayPath} exists as a guardrail file but constrains nothing, which reads to anyone opening it as though limits are in place.`,
        'Add the rules you intended, or remove the file.',
      ),
    );
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

/** The subset of provenance an issue needs. Both files and definitions supply it. */
interface McpFileLike {
  readonly id: string;
  readonly path: string;
  readonly displayPath: string;
  readonly directory: string;
  readonly providerId: string;
  readonly providerName: string;
  readonly scope: ConfigScope;
}

type IssueEmitter = (
  ruleId: ReviewRuleId,
  severity: ReviewSeverity,
  title: string,
  detail: string,
  remediation: string,
  evidence?: string,
) => ReviewIssue;

/**
 * Builds issues for one subject with its provenance already bound.
 *
 * Evidence is redacted on the way out. A rule quoting a link target or an
 * allow rule is not expected to catch a credential, but "not expected to" is
 * not the standard this codebase holds itself to elsewhere.
 */
function issueFactory(
  subject: string,
  file: McpFileLike,
  extra: { projectRoot?: string },
): IssueEmitter {
  return (ruleId, severity, title, detail, remediation, evidence) => {
    const rule = RULES_BY_ID.get(ruleId);
    return {
      id: `${ruleId}:${file.id}:${slug(subject)}`,
      ruleId,
      category: rule?.category ?? 'freshness',
      severity,
      subject,
      title,
      detail,
      remediation,
      fileId: file.id,
      displayPath: file.displayPath,
      directory: file.directory,
      providerId: file.providerId,
      providerName: file.providerName,
      scope: file.scope,
      ...(extra.projectRoot !== undefined ? { projectRoot: extra.projectRoot } : {}),
      ...(evidence !== undefined ? { evidence: redactText(truncate(evidence, 200)).value } : {}),
    };
  };
}

/**
 * A rule can legitimately fire twice for one subject — a document reached
 * through both a capability and an instruction entry, say — and the id is
 * built to be stable rather than unique, so the last write wins.
 */
function dedupe(issues: readonly ReviewIssue[]): ReviewIssue[] {
  const seen = new Map<string, ReviewIssue>();
  for (const issue of issues) {
    const key = `${issue.id}:${issue.evidence ?? ''}`;
    if (!seen.has(key)) seen.set(key, issue);
  }
  return [...seen.values()];
}

const SEVERITY_RANK: Record<ReviewSeverity, number> = { error: 0, warning: 1, info: 2 };

function compareIssues(a: ReviewIssue, b: ReviewIssue): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    a.category.localeCompare(b.category) ||
    a.providerName.localeCompare(b.providerName) ||
    a.subject.localeCompare(b.subject) ||
    a.ruleId.localeCompare(b.ruleId)
  );
}

/**
 * Weighted deduction from 100.
 *
 * Deliberately weighted per issue rather than per affected file, and floored
 * at zero: a score is a prompt to look, not a measurement, and its only real
 * job is to make "did that edit help?" answerable at a glance.
 */
const SEVERITY_WEIGHT: Record<ReviewSeverity, number> = { error: 6, warning: 2, info: 0.5 };

function summarize(issues: readonly ReviewIssue[], reviewedSubjectCount: number): ReviewSummary {
  const byCategory: Record<ReviewCategory, number> = {
    capability: 0,
    instruction: 0,
    mcp: 0,
    guardrail: 0,
    freshness: 0,
  };
  let errorCount = 0;
  let warningCount = 0;
  let infoCount = 0;
  let penalty = 0;
  const files = new Set<string>();

  for (const issue of issues) {
    byCategory[issue.category] += 1;
    files.add(issue.fileId);
    penalty += SEVERITY_WEIGHT[issue.severity];
    if (issue.severity === 'error') errorCount += 1;
    else if (issue.severity === 'warning') warningCount += 1;
    else infoCount += 1;
  }

  const score = Math.max(0, Math.round(100 - penalty));

  return {
    issueCount: issues.length,
    errorCount,
    warningCount,
    infoCount,
    affectedFileCount: files.size,
    reviewedSubjectCount,
    ruleCount: REVIEW_RULES.length,
    score,
    grade: gradeFor(score),
    byCategory,
  };
}

function gradeFor(score: number): ReviewSummary['grade'] {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

/**
 * Rough token count for a byte count.
 *
 * Four bytes per token is the widely used English-prose approximation. It is
 * presented as an estimate everywhere it surfaces, because the real number
 * depends on a tokenizer this tool deliberately does not bundle.
 */
export const BYTES_PER_TOKEN = 4;

export function estimateTokens(bytes: number): number {
  return Math.round(bytes / BYTES_PER_TOKEN);
}

function stripFrontmatter(text: string): string {
  return text.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '');
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function describeKind(kind: CapabilityEntry['kind']): string {
  switch (kind) {
    case 'agent':
      return 'a subagent';
    case 'skill':
      return 'a skill';
    case 'chatmode':
      return 'a chat mode';
    case 'prompt':
      return 'a prompt';
    case 'command':
      return 'a command';
    default:
      return 'a capability';
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kilobytes = bytes / 1024;
  if (kilobytes < 1024) return `${kilobytes.toFixed(1)} KB`;
  return `${(kilobytes / 1024).toFixed(1)} MB`;
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function defaultLoader(file: DiscoveredFile): Promise<string | undefined> {
  try {
    return await readFile(file.path, 'utf8');
  } catch {
    return undefined;
  }
}

/** Existence probe. Never throws, so a permission error reads as "present". */
async function defaultPathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch (error) {
    // EACCES means something is there that this process may not stat. Treating
    // that as missing would produce a broken-link finding for a file that is
    // demonstrably present.
    return (error as NodeJS.ErrnoException)?.code === 'EACCES';
  }
}
