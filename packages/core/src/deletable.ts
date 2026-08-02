/**
 * Which discovered files the UI may offer to delete outright.
 *
 * Deleting a file is the only destructive action here that cannot be undone by
 * editing, so the rule is deliberately narrow: a file is deletable only when
 * the file *is* the thing shown in the UI. An agent, a skill, a prompt, a
 * `CLAUDE.md`, a `.cursorignore` — remove the file and exactly the entry the
 * user pointed at disappears.
 *
 * Everything else is refused with a reason, because the alternative is a
 * button that silently takes more than it offered:
 *
 * - `settings` files hold a permission block *alongside* unrelated settings,
 *   so deleting one to drop a guardrail would also drop the tool's model
 *   choice, theme, and everything else it keeps there.
 * - `mcp` files declare many servers, and one of them (`~/.claude.json`) also
 *   holds per-project history. MCP servers already have surgical per-server
 *   removal, which is the right tool for that job.
 * - `catalog` files are shipped by the tool rather than authored by the user,
 *   and reappear on the next launch.
 * - `credential` files, and anything marked `credential-store`, are never
 *   touched here at all.
 * - `extension` and `unknown` files are managed by an installer or are of a
 *   shape this build does not understand well enough to remove confidently.
 */

import type { FileKind, Sensitivity } from './types.js';

/** Kinds where one file holds exactly one entry, so removing it is precise. */
export const DELETABLE_KINDS: ReadonlySet<FileKind> = new Set<FileKind>([
  'instructions',
  'agent',
  'skill',
  'prompt',
  'command',
  'chatmode',
  'permissions',
  'ignore',
  'memory',
]);

/** The subset of a discovered file the deletability rule depends on. */
export interface DeletabilityInput {
  readonly kind: FileKind;
  readonly sensitivity: Sensitivity;
}

/** Whether a file may be deleted, and the reason when it may not. */
export interface Deletability {
  readonly deletable: boolean;
  /** Present only when `deletable` is false. Written for the user, not the log. */
  readonly reason?: string;
}

const KIND_REASONS: Partial<Record<FileKind, string>> = {
  settings:
    'This is a settings file that holds more than this entry. Open it in the editor and remove just the part you want gone.',
  mcp: 'This file declares MCP servers. Remove individual servers from the MCP view so the rest of the file survives.',
  catalog:
    'Catalogs are published by the tool rather than authored by you, and are recreated when it next runs.',
  credential: 'Credential files are never modified here. Use the owning tool to change them.',
  extension:
    'Extensions are managed by their installer. Uninstall it from the tool rather than deleting files.',
  unknown:
    'This file\u2019s purpose could not be identified, so it is not deleted from here. Open it in the editor to decide what it is.',
};

/**
 * Decides whether a file may be deleted.
 *
 * Applied in three places that must agree: the inventory (to decide whether to
 * render a button), the sources and capability listings (same), and the
 * service (to enforce it). Sharing one function is what stops the UI offering
 * a deletion the API would refuse.
 */
export function fileDeletability(file: DeletabilityInput): Deletability {
  if (file.sensitivity === 'credential-store') {
    return {
      deletable: false,
      reason:
        'This file exists to hold credentials and is never modified here. Use the owning tool to remove it.',
    };
  }

  const reason = KIND_REASONS[file.kind];
  if (reason !== undefined) return { deletable: false, reason };

  if (!DELETABLE_KINDS.has(file.kind)) {
    return {
      deletable: false,
      reason: 'Files of this kind are not deleted from here.',
    };
  }

  return { deletable: true };
}
