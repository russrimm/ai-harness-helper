/**
 * Effective configuration — what each tool actually ends up using.
 *
 * The inventory answers "where is this declared?". That is the right question
 * while you are hunting for copies, but it is the wrong one when you are about
 * to delete something: a file that looks redundant may be the only one a tool
 * ever reads, and a file that looks authoritative may be silently shadowed by a
 * closer one. This module answers the follow-up question instead — for one
 * tool, given everything on disk, which declaration wins and which are dead
 * weight?
 *
 * Two resolution strategies are modelled, because tools genuinely do both:
 *
 * - **override** — the nearest declaration replaces the rest. This is how named
 *   things behave: an MCP server or an agent called `reviewer` is one thing,
 *   and a tool that finds two picks one. Everything it did not pick is inert.
 * - **merge** — every declaration contributes. This is how guidance and policy
 *   behave: a project `AGENTS.md` layers onto a user one rather than replacing
 *   it, and deny rules accumulate rather than cancel.
 *
 * Direction of precedence is also kind-aware, which matters more than it looks.
 * For guidance the closest file wins, because a project is allowed to refine
 * what a user set globally. For policy the direction inverts: a machine-managed
 * deny rule that a project could override would not be policy at all. Getting
 * this backwards would produce confidently wrong advice, so the two are kept
 * deliberately separate rather than sharing one number.
 */

import type {
  CapabilityEntry,
  GuardrailEntry,
  HarnessInventory,
  InstructionEntry,
  McpServerEntry,
} from './aggregate.js';
import type { ConfigScope } from './types.js';

/** How a tool combines multiple declarations of the same key. */
export type ResolutionStrategy = 'override' | 'merge';

/** What happens to one declaration once resolution has run. */
export type DeclarationStatus =
  /** The declaration a tool using override semantics would load. */
  | 'active'
  /** Superseded by a closer declaration of the same key; never loaded. */
  | 'shadowed'
  /** Layered together with the others rather than replaced. */
  | 'merged'
  /** Present but switched off by the tool's own config. */
  | 'disabled';

/** One file's claim on a key, plus the verdict on that claim. */
export interface EffectiveDeclaration {
  readonly fileId: string;
  readonly displayPath: string;
  readonly directory: string;
  readonly locationLabel: string;
  readonly scope: ConfigScope;
  readonly providerId: string;
  readonly providerName: string;
  readonly projectRoot?: string;
  /** Higher wins. Comparable only within one entry. */
  readonly rank: number;
  readonly status: DeclarationStatus;
  /** Plain-language reason for the status, written for the person deciding. */
  readonly reason: string;
  /** True when this declaration differs from the winning one. */
  readonly differs: boolean;
}

/** The kinds of thing precedence is resolved for. */
export type EffectiveKind = 'mcp' | 'capability' | 'instruction' | 'guardrail';

/** One resolved key — a server name, capability name, or guidance document. */
export interface EffectiveEntry {
  /** Stable identity, e.g. `mcp:github` or `agent:reviewer`. */
  readonly key: string;
  readonly kind: EffectiveKind;
  /** Human-facing name of the thing being resolved. */
  readonly name: string;
  readonly strategy: ResolutionStrategy;
  /** File id of the declaration that wins, for override entries. */
  readonly winnerFileId?: string;
  readonly declarations: readonly EffectiveDeclaration[];
  /** Declarations a tool will never load. */
  readonly shadowedCount: number;
  /**
   * True when a shadowed declaration says something different from the winner.
   * An identical shadowed copy is merely redundant; a differing one means the
   * behaviour you are reading in one file is not the behaviour you will get.
   */
  readonly contested: boolean;
}

/** Everything one tool resolves, grouped so a page can render it per tool. */
export interface EffectiveProvider {
  readonly providerId: string;
  readonly providerName: string;
  readonly entries: readonly EffectiveEntry[];
  /** Entries where at least one declaration is shadowed. */
  readonly shadowedEntryCount: number;
  /** Entries where a shadowed declaration disagrees with the winner. */
  readonly contestedEntryCount: number;
}

/** The resolved view of every tool on the machine. */
export interface EffectiveConfig {
  readonly providers: readonly EffectiveProvider[];
  readonly totalEntries: number;
  readonly totalShadowed: number;
  readonly totalContested: number;
}

/**
 * Precedence for guidance and named things: the closest file wins.
 *
 * A project is expected to refine what a user set globally, and a user is
 * expected to refine a machine default.
 */
const GUIDANCE_RANK: Record<ConfigScope, number> = {
  project: 3,
  user: 2,
  managed: 1,
};

/**
 * Precedence for policy: the furthest file wins.
 *
 * A managed guardrail that a project could override would not constrain
 * anything, so the ordering inverts rather than being reused.
 */
const POLICY_RANK: Record<ConfigScope, number> = {
  managed: 3,
  user: 2,
  project: 1,
};

function rankFor(kind: EffectiveKind, scope: ConfigScope): number {
  return kind === 'guardrail' ? POLICY_RANK[scope] : GUIDANCE_RANK[scope];
}

function scopeLabel(scope: ConfigScope): string {
  switch (scope) {
    case 'project':
      return 'project';
    case 'user':
      return 'user';
    default:
      return 'machine-managed';
  }
}

/**
 * Resolves an inventory into per-tool effective configuration.
 *
 * Resolution is done per provider rather than globally, because precedence is
 * only meaningful inside one tool. Two tools declaring `github` is not a
 * conflict — each reads its own file — and treating it as one would flood the
 * view with shadowing that does not exist.
 */
export function resolveEffective(inventory: HarnessInventory): EffectiveConfig {
  const byProvider = new Map<string, { name: string; entries: EffectiveEntry[] }>();

  const push = (providerId: string, providerName: string, entry: EffectiveEntry): void => {
    const bucket = byProvider.get(providerId);
    if (bucket) bucket.entries.push(entry);
    else byProvider.set(providerId, { name: providerName, entries: [entry] });
  };

  for (const entry of resolveMcp(inventory.mcpServers))
    push(entry.providerId, entry.providerName, entry.entry);
  for (const entry of resolveCapabilities(inventory.capabilities))
    push(entry.providerId, entry.providerName, entry.entry);
  for (const entry of resolveInstructions(inventory.instructions))
    push(entry.providerId, entry.providerName, entry.entry);
  for (const entry of resolveGuardrails(inventory.guardrails))
    push(entry.providerId, entry.providerName, entry.entry);

  const providers: EffectiveProvider[] = [];
  let totalEntries = 0;
  let totalShadowed = 0;
  let totalContested = 0;

  for (const [providerId, bucket] of byProvider) {
    const entries = [...bucket.entries].sort(compareEntries);
    const shadowedEntryCount = entries.filter((entry) => entry.shadowedCount > 0).length;
    const contestedEntryCount = entries.filter((entry) => entry.contested).length;

    totalEntries += entries.length;
    totalShadowed += entries.reduce((sum, entry) => sum + entry.shadowedCount, 0);
    totalContested += contestedEntryCount;

    providers.push({
      providerId,
      providerName: bucket.name,
      entries,
      shadowedEntryCount,
      contestedEntryCount,
    });
  }

  providers.sort(
    (a, b) =>
      b.contestedEntryCount - a.contestedEntryCount ||
      b.shadowedEntryCount - a.shadowedEntryCount ||
      a.providerName.localeCompare(b.providerName),
  );

  return { providers, totalEntries, totalShadowed, totalContested };
}

/** Contested entries first, then shadowed, so the actionable rows lead. */
function compareEntries(a: EffectiveEntry, b: EffectiveEntry): number {
  if (a.contested !== b.contested) return a.contested ? -1 : 1;
  if (a.shadowedCount !== b.shadowedCount) return b.shadowedCount - a.shadowedCount;
  return a.key.localeCompare(b.key);
}

interface ProviderScoped {
  readonly providerId: string;
  readonly providerName: string;
  readonly entry: EffectiveEntry;
}

/**
 * MCP servers: one name, one server, nearest scope wins.
 *
 * A disabled definition is called out separately rather than being folded into
 * "shadowed", because the two have opposite fixes — one is a file to delete,
 * the other is a flag to flip.
 */
function resolveMcp(servers: readonly McpServerEntry[]): ProviderScoped[] {
  const out: ProviderScoped[] = [];

  for (const server of servers) {
    const groups = groupBy(server.definitions, (definition) => definition.providerId);

    for (const [providerId, definitions] of groups) {
      const providerName = definitions[0]?.providerName ?? providerId;
      const ranked = [...definitions].sort(
        (a, b) =>
          rankFor('mcp', b.scope) - rankFor('mcp', a.scope) ||
          a.displayPath.localeCompare(b.displayPath),
      );
      const winner = ranked.find((definition) => !definition.disabled) ?? ranked[0];
      if (!winner) continue;

      const declarations = ranked.map((definition) =>
        declarationOf(definition, 'mcp', {
          status: definition.disabled ? 'disabled' : definition === winner ? 'active' : 'shadowed',
          differs: definition.signature !== winner.signature,
          reason: definition.disabled
            ? 'Marked disabled in this file, so it is never launched.'
            : definition === winner
              ? `Nearest declaration (${scopeLabel(definition.scope)} scope), so this is the one that runs.`
              : `Shadowed by the ${scopeLabel(winner.scope)} declaration in ${winner.directory}.`,
        }),
      );

      out.push({
        providerId,
        providerName,
        entry: entryOf({
          key: `mcp:${server.name}`,
          kind: 'mcp',
          name: server.name,
          strategy: 'override',
          winnerFileId: winner.fileId,
          declarations,
        }),
      });
    }
  }

  return out;
}

/** Capabilities: invocation names collide the same way server names do. */
function resolveCapabilities(capabilities: readonly CapabilityEntry[]): ProviderScoped[] {
  return resolveOverride(
    capabilities,
    'capability',
    (entry) => `${entry.kind}:${entry.name.toLowerCase()}`,
    (entry) => entry.name,
  );
}

/**
 * Instructions layer rather than replace, so every document is `merged`.
 *
 * Rank still matters — it is the order the documents are applied in, and the
 * last one applied is the one that wins an argument — but nothing here is dead
 * weight unless it is byte-identical to another document, which the duplicate
 * finding already reports.
 */
function resolveInstructions(instructions: readonly InstructionEntry[]): ProviderScoped[] {
  return resolveMerge(
    instructions,
    'instruction',
    (entry) => `instructions:${entry.title.toLowerCase()}`,
    (entry) => entry.title,
  );
}

/** Guardrails accumulate, and managed policy outranks the rest. */
function resolveGuardrails(guardrails: readonly GuardrailEntry[]): ProviderScoped[] {
  return resolveMerge(
    guardrails,
    'guardrail',
    (entry) => `${entry.kind}:${entry.fileName.toLowerCase()}`,
    (entry) => entry.fileName,
  );
}

interface ResolvableEntry {
  readonly fileId: string;
  readonly displayPath: string;
  readonly directory: string;
  readonly fileName: string;
  readonly locationLabel: string;
  readonly scope: ConfigScope;
  readonly providerId: string;
  readonly providerName: string;
  readonly projectRoot?: string;
  readonly duplicate: {
    readonly identicalFileIds: readonly string[];
    readonly contentHash?: string;
  };
}

/**
 * True when two declarations are the same document.
 *
 * Checks the content hash first, because that is the only answer that is
 * certain. `identicalFileIds` is a useful fallback but deliberately excludes
 * same-named siblings, so it cannot decide this case on its own. When neither
 * is available the answer is "no", which errs toward showing the user a
 * difference that turns out to be cosmetic rather than hiding a real one.
 */
function sameDocument(a: ResolvableEntry, b: ResolvableEntry): boolean {
  if (a.fileId === b.fileId) return true;
  const left = a.duplicate.contentHash;
  const right = b.duplicate.contentHash;
  if (left !== undefined && right !== undefined) return left === right;
  return a.duplicate.identicalFileIds.includes(b.fileId);
}

function resolveOverride<T extends ResolvableEntry>(
  entries: readonly T[],
  kind: EffectiveKind,
  keyOf: (entry: T) => string,
  nameOf: (entry: T) => string,
): ProviderScoped[] {
  const out: ProviderScoped[] = [];
  const groups = groupBy(entries, (entry) => `${entry.providerId}\u0000${keyOf(entry)}`);

  for (const [, group] of groups) {
    const ranked = [...group].sort(
      (a, b) =>
        rankFor(kind, b.scope) - rankFor(kind, a.scope) ||
        a.displayPath.localeCompare(b.displayPath),
    );
    const winner = ranked[0];
    if (!winner) continue;

    const declarations = ranked.map((entry) => {
      const identical = sameDocument(entry, winner);
      return declarationOf(entry, kind, {
        status: entry === winner ? 'active' : 'shadowed',
        differs: entry !== winner && !identical,
        reason:
          entry === winner
            ? `Nearest declaration (${scopeLabel(entry.scope)} scope), so this is the one that loads.`
            : identical
              ? `Identical copy shadowed by the ${scopeLabel(winner.scope)} version in ${winner.directory}.`
              : `Shadowed by the ${scopeLabel(winner.scope)} version in ${winner.directory}, which says something different.`,
      });
    });

    out.push({
      providerId: winner.providerId,
      providerName: winner.providerName,
      entry: entryOf({
        key: keyOf(winner),
        kind,
        name: nameOf(winner),
        strategy: 'override',
        winnerFileId: winner.fileId,
        declarations,
      }),
    });
  }

  return out;
}

function resolveMerge<T extends ResolvableEntry>(
  entries: readonly T[],
  kind: EffectiveKind,
  keyOf: (entry: T) => string,
  nameOf: (entry: T) => string,
): ProviderScoped[] {
  const out: ProviderScoped[] = [];
  const groups = groupBy(entries, (entry) => `${entry.providerId}\u0000${keyOf(entry)}`);

  for (const [, group] of groups) {
    const ranked = [...group].sort(
      (a, b) =>
        rankFor(kind, b.scope) - rankFor(kind, a.scope) ||
        a.displayPath.localeCompare(b.displayPath),
    );
    const first = ranked[0];
    if (!first) continue;

    const declarations = ranked.map((entry, index) => {
      const identical = index > 0 && sameDocument(entry, first);
      return declarationOf(entry, kind, {
        // Redundant copies are the one thing merge semantics still make dead
        // weight: layering a file onto an identical file changes nothing.
        status: identical ? 'shadowed' : 'merged',
        differs: false,
        reason: identical
          ? `Byte-identical to ${first.displayPath}, so layering it adds nothing.`
          : kind === 'guardrail'
            ? `Applied alongside the others; ${scopeLabel(entry.scope)} rules take priority in a disagreement.`
            : `Applied alongside the others; ${scopeLabel(entry.scope)} guidance takes priority in a disagreement.`,
      });
    });

    out.push({
      providerId: first.providerId,
      providerName: first.providerName,
      entry: entryOf({
        key: keyOf(first),
        kind,
        name: nameOf(first),
        strategy: 'merge',
        declarations,
      }),
    });
  }

  return out;
}

interface DeclarationSource {
  readonly fileId: string;
  readonly displayPath: string;
  readonly directory: string;
  readonly locationLabel: string;
  readonly scope: ConfigScope;
  readonly providerId: string;
  readonly providerName: string;
  readonly projectRoot?: string;
}

function declarationOf(
  source: DeclarationSource,
  kind: EffectiveKind,
  verdict: { status: DeclarationStatus; differs: boolean; reason: string },
): EffectiveDeclaration {
  return {
    fileId: source.fileId,
    displayPath: source.displayPath,
    directory: source.directory,
    locationLabel: source.locationLabel,
    scope: source.scope,
    providerId: source.providerId,
    providerName: source.providerName,
    ...(source.projectRoot !== undefined ? { projectRoot: source.projectRoot } : {}),
    rank: rankFor(kind, source.scope),
    status: verdict.status,
    reason: verdict.reason,
    differs: verdict.differs,
  };
}

function entryOf(input: {
  key: string;
  kind: EffectiveKind;
  name: string;
  strategy: ResolutionStrategy;
  winnerFileId?: string;
  declarations: readonly EffectiveDeclaration[];
}): EffectiveEntry {
  const shadowed = input.declarations.filter(
    (declaration) => declaration.status === 'shadowed' || declaration.status === 'disabled',
  );

  return {
    key: input.key,
    kind: input.kind,
    name: input.name,
    strategy: input.strategy,
    ...(input.winnerFileId !== undefined ? { winnerFileId: input.winnerFileId } : {}),
    declarations: input.declarations,
    shadowedCount: shadowed.length,
    contested: shadowed.some((declaration) => declaration.differs),
  };
}

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}
