/**
 * What your harness costs you on every single request.
 *
 * Duplicates and conflicts explain why a tool behaves oddly. They say nothing
 * about the quieter tax: an instruction file grows a section at a time until
 * it is prepended, in full, to every question you ever ask. Nobody notices,
 * because no single edit was unreasonable and nothing ever breaks — the model
 * just has less room and more to ignore.
 *
 * This module puts a number on it, split by when the bytes are actually paid:
 *
 * - **Always** — read on every request. Root instruction files and memories,
 *   plus the name and description of every capability, because progressive
 *   disclosure still has to advertise what is available before the model can
 *   choose it.
 * - **Conditional** — instruction files scoped by an `applyTo` glob, paid only
 *   when the work touches matching files.
 * - **On demand** — capability bodies, paid only once selected.
 *
 * Two things are deliberately *not* estimated. MCP servers publish their tool
 * schemas at runtime, and their real context cost can only be known by
 * launching them, which this tool never does; they are reported as a count and
 * named as an unmeasured factor rather than given a fabricated size. And token
 * counts are an explicit approximation, because bundling a tokenizer per
 * vendor would be a large dependency in service of a number that only needs to
 * be right to an order of magnitude.
 */

import { estimateTokens, BYTES_PER_TOKEN } from './review.js';
import type { CapabilityEntry, HarnessInventory, InstructionEntry } from './aggregate.js';
import type { DiscoveredFile, ScanResult } from './scanner.js';
import type { ConfigScope, FileKind } from './types.js';

/** When the bytes are actually loaded. */
export type LoadTiming = 'always' | 'conditional' | 'on-demand';

/** One file's contribution to a provider's context cost. */
export interface BudgetContributor {
  readonly fileId: string;
  readonly displayPath: string;
  readonly directory: string;
  readonly providerId: string;
  readonly providerName: string;
  readonly scope: ConfigScope;
  readonly projectRoot?: string;
  readonly kind: FileKind;
  /** Instruction title or capability name. */
  readonly label: string;
  readonly timing: LoadTiming;
  /** Bytes read on every request, whatever the task. */
  readonly alwaysBytes: number;
  /** Bytes read only when selected, or when the applyTo glob matches. */
  readonly situationalBytes: number;
  /** Size of the whole file, for reference. */
  readonly fileBytes: number;
  /** The glob that gates a conditional contributor. */
  readonly appliesTo?: string;
}

/** One tool's total context cost. */
export interface ProviderBudget {
  readonly providerId: string;
  readonly providerName: string;
  readonly alwaysBytes: number;
  readonly alwaysTokens: number;
  readonly conditionalBytes: number;
  readonly onDemandBytes: number;
  /** MCP servers this tool loads, whose tool schemas also cost context. */
  readonly mcpServerCount: number;
  readonly contributors: readonly BudgetContributor[];
  /** Bytes always loaded, split by where the file came from. */
  readonly alwaysByScope: Readonly<Record<ConfigScope, number>>;
}

/** The whole-machine picture. */
export interface ContextBudgetReport {
  readonly generatedAt: string;
  readonly providers: readonly ProviderBudget[];
  readonly totals: {
    readonly alwaysBytes: number;
    readonly alwaysTokens: number;
    readonly conditionalBytes: number;
    readonly onDemandBytes: number;
    readonly contributorCount: number;
  };
  /** The divisor used to turn bytes into an estimated token count. */
  readonly bytesPerToken: number;
  /** The single heaviest always-on contributor, when there is one. */
  readonly heaviest?: BudgetContributor;
}

export interface BudgetOptions {
  readonly now?: Date;
}

/**
 * Computes the context budget from the inventory alone.
 *
 * Reads nothing from disk: every input is already carried on the scan result
 * or the synthesized entries, so this is safe to compute on every request
 * without a second pass over the filesystem.
 */
export function computeContextBudget(
  scan: ScanResult,
  inventory: HarnessInventory,
  options: BudgetOptions = {},
): ContextBudgetReport {
  const filesById = new Map(scan.files.map((file) => [file.id, file]));
  const byProvider = new Map<string, BudgetContributor[]>();

  const add = (contributor: BudgetContributor): void => {
    const list = byProvider.get(contributor.providerId);
    if (list) list.push(contributor);
    else byProvider.set(contributor.providerId, [contributor]);
  };

  for (const instruction of inventory.instructions) {
    const file = filesById.get(instruction.fileId);
    add(instructionContributor(instruction, file));
  }

  for (const capability of inventory.capabilities) {
    const file = filesById.get(capability.fileId);
    add(capabilityContributor(capability, file));
  }

  // A memory file is an instruction the tool wrote to itself, and no synthesized
  // entry covers it, so it is picked up straight off the scan.
  for (const file of scan.files) {
    if (file.kind !== 'memory') continue;
    add({
      fileId: file.id,
      displayPath: file.displayPath,
      directory: file.directory,
      providerId: file.providerId,
      providerName: file.providerName,
      scope: file.scope,
      ...(file.projectRoot !== undefined ? { projectRoot: file.projectRoot } : {}),
      kind: file.kind,
      label: file.name,
      timing: 'always',
      alwaysBytes: file.size,
      situationalBytes: 0,
      fileBytes: file.size,
    });
  }

  const mcpCounts = new Map<string, number>();
  for (const server of inventory.mcpServers) {
    for (const providerId of server.providerIds) {
      mcpCounts.set(providerId, (mcpCounts.get(providerId) ?? 0) + 1);
    }
  }

  const providers: ProviderBudget[] = [];
  for (const [providerId, contributors] of byProvider) {
    contributors.sort(
      (a, b) => b.alwaysBytes - a.alwaysBytes || b.situationalBytes - a.situationalBytes,
    );
    const alwaysBytes = sum(contributors, (c) => c.alwaysBytes);
    const alwaysByScope: Record<ConfigScope, number> = { managed: 0, user: 0, project: 0 };
    for (const contributor of contributors)
      alwaysByScope[contributor.scope] += contributor.alwaysBytes;

    providers.push({
      providerId,
      providerName: contributors[0]?.providerName ?? providerId,
      alwaysBytes,
      alwaysTokens: estimateTokens(alwaysBytes),
      conditionalBytes: sum(contributors, (c) =>
        c.timing === 'conditional' ? c.situationalBytes : 0,
      ),
      onDemandBytes: sum(contributors, (c) => (c.timing === 'on-demand' ? c.situationalBytes : 0)),
      mcpServerCount: mcpCounts.get(providerId) ?? 0,
      contributors,
      alwaysByScope,
    });
  }

  providers.sort(
    (a, b) => b.alwaysBytes - a.alwaysBytes || a.providerName.localeCompare(b.providerName),
  );

  const everyContributor = providers.flatMap((provider) => provider.contributors);
  const heaviest = [...everyContributor].sort((a, b) => b.alwaysBytes - a.alwaysBytes)[0];
  const totalAlways = sum(providers, (p) => p.alwaysBytes);

  return {
    generatedAt: (options.now ?? new Date()).toISOString(),
    providers,
    totals: {
      alwaysBytes: totalAlways,
      alwaysTokens: estimateTokens(totalAlways),
      conditionalBytes: sum(providers, (p) => p.conditionalBytes),
      onDemandBytes: sum(providers, (p) => p.onDemandBytes),
      contributorCount: everyContributor.length,
    },
    bytesPerToken: BYTES_PER_TOKEN,
    ...(heaviest !== undefined && heaviest.alwaysBytes > 0 ? { heaviest } : {}),
  };
}

function instructionContributor(
  instruction: InstructionEntry,
  file: DiscoveredFile | undefined,
): BudgetContributor {
  const scoped = instruction.appliesTo !== undefined && instruction.appliesTo.length > 0;
  const bytes = instruction.bytes || (file?.size ?? 0);

  return {
    fileId: instruction.fileId,
    displayPath: instruction.displayPath,
    directory: instruction.directory,
    providerId: instruction.providerId,
    providerName: instruction.providerName,
    scope: instruction.scope,
    ...(instruction.projectRoot !== undefined ? { projectRoot: instruction.projectRoot } : {}),
    kind: file?.kind ?? 'instructions',
    label: instruction.title,
    timing: scoped ? 'conditional' : 'always',
    alwaysBytes: scoped ? 0 : bytes,
    situationalBytes: scoped ? bytes : 0,
    fileBytes: file?.size ?? bytes,
    ...(scoped && instruction.appliesTo !== undefined ? { appliesTo: instruction.appliesTo } : {}),
  };
}

/**
 * A capability's cost, split the way progressive disclosure actually splits it.
 *
 * The name and description are advertised to the model on every request — that
 * is how it knows the capability exists — while the body is only read once the
 * capability is chosen. Counting the whole file as on-demand would understate
 * what a folder of forty skills costs you before you have used any of them.
 */
function capabilityContributor(
  capability: CapabilityEntry,
  file: DiscoveredFile | undefined,
): BudgetContributor {
  const fileBytes = file?.size ?? 0;
  const advertised = `${capability.name}: ${capability.description ?? ''}`;
  const alwaysBytes = Math.min(Buffer.byteLength(advertised, 'utf8'), fileBytes || Infinity);
  const catalogBytes = Number.isFinite(alwaysBytes) ? alwaysBytes : 0;

  return {
    fileId: capability.fileId,
    displayPath: capability.displayPath,
    directory: capability.directory,
    providerId: capability.providerId,
    providerName: capability.providerName,
    scope: capability.scope,
    ...(capability.projectRoot !== undefined ? { projectRoot: capability.projectRoot } : {}),
    kind: capability.kind,
    label: capability.name,
    timing: 'on-demand',
    alwaysBytes: catalogBytes,
    situationalBytes: Math.max(0, fileBytes - catalogBytes),
    fileBytes,
  };
}

function sum<T>(items: readonly T[], pick: (item: T) => number): number {
  let total = 0;
  for (const item of items) total += pick(item);
  return total;
}
