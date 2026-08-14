/**
 * The one delete affordance, shared by every view that lists an entry backed
 * by its own file.
 *
 * Deleting is the only action in this app that cannot be undone by editing, so
 * the interaction is fixed in one place rather than reinvented per view:
 *
 * - the trigger is an icon button with a real accessible name, because a bare
 *   glyph in a list of twelve skills says nothing about which one it removes;
 * - when the file holds more than the entry shown it is marked `aria-disabled`
 *   rather than `disabled`, so it stays focusable and the reason is actually
 *   reachable by keyboard and screen reader instead of being a mouse-only
 *   tooltip;
 * - confirming happens inline, names the exact path, and moves focus to the
 *   heading so the step is not silent to a screen reader.
 *
 * The `compact` variant is the same control at the size a filename in a dense
 * list can carry. It is only ever smaller visually: the accessible name, the
 * reason, and the target size floor are identical.
 */

import { useEffect, useRef } from 'react';
import type { ReactElement } from 'react';
import type { WriteRefusal } from '../api/types.js';

/** What the button is about to remove, for the confirmation copy. */
export interface DeleteTarget {
  /** What the user thinks they are deleting, e.g. a skill name. */
  readonly label: string;
  /** Kind noun used in the prompt, e.g. "skill" or "instruction file". */
  readonly noun: string;
  /** Home-abbreviated path that will actually be unlinked. */
  readonly displayPath: string;
}

export function DeleteButton({
  target,
  deletable,
  reason,
  expanded,
  busy,
  controls,
  compact = false,
  onClick,
}: {
  target: DeleteTarget;
  deletable: boolean;
  reason: string | undefined;
  expanded: boolean;
  busy: boolean;
  controls: string;
  /** Sits beside a filename in a list rather than in a row of actions. */
  compact?: boolean;
  onClick: () => void;
}): ReactElement {
  const name = `Delete ${target.noun} ${target.label}`;
  return (
    <button
      type="button"
      className={compact ? 'danger icon-button icon-button-compact' : 'danger icon-button'}
      onClick={deletable ? onClick : undefined}
      // Only the transient states truly disable the control. A file that may
      // never be deleted stays focusable so its reason can be read.
      disabled={deletable && (expanded || busy)}
      aria-disabled={!deletable}
      aria-expanded={expanded}
      aria-controls={controls}
      title={deletable ? name : reason}
    >
      <span aria-hidden="true">🗑</span>
      <span className="visually-hidden">{name}</span>
      {!deletable && reason ? <span className="visually-hidden"> — {reason}</span> : null}
    </button>
  );
}

/**
 * The inline "are you sure?" panel.
 *
 * The full path is spelled out rather than summarised because two tools
 * routinely ship a skill of the same name, and the only thing that
 * distinguishes them is the folder they live in.
 */
export function DeleteConfirm({
  id,
  target,
  busy,
  onConfirm,
  onCancel,
}: {
  id: string;
  target: DeleteTarget;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): ReactElement {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <section className="delete-confirm" id={id} aria-labelledby={`${id}-heading`}>
      <h4 id={`${id}-heading`} ref={headingRef} tabIndex={-1}>
        Delete {target.noun} “{target.label}”?
      </h4>
      <p>
        This removes the whole file <code>{target.displayPath}</code>. A copy is kept in the backup
        folder first, and the path is reported here so you can restore it.
      </p>
      <div className="delete-confirm-actions">
        <button type="button" className="danger" disabled={busy} onClick={onConfirm}>
          {busy ? 'Deleting…' : 'Delete file'}
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}

/**
 * The outcome banner.
 *
 * Rendered above whatever the delete removed rather than inside it, because
 * the backup path in a success message is the only record of where the file
 * went — and the panel that hosted the button is usually gone by the time the
 * message appears.
 */
export function DeleteNoticeBanner({
  notice,
  onDismiss,
}: {
  notice: { kind: 'ok' | 'error'; message: string } | undefined;
  onDismiss: () => void;
}): ReactElement | null {
  if (!notice) return null;
  return (
    <div
      role={notice.kind === 'error' ? 'alert' : 'status'}
      aria-live="polite"
      className={notice.kind === 'error' ? 'notice notice-error' : 'notice notice-ok'}
    >
      <p>{notice.message}</p>
      <div className="notice-actions">
        <button type="button" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

/**
 * A DOM id for one file's confirmation panel.
 *
 * Shared so the trigger's `aria-controls` and the panel's `id` cannot drift
 * apart in the four places that now render this pair. File ids contain path
 * separators, so they are escaped into something valid in an id.
 */
export function deleteConfirmId(prefix: string, fileId: string): string {
  return `${prefix}-delete-${encodeURIComponent(fileId).replace(/%/g, '-')}`;
}

/** Turns a refusal into advice, rather than echoing an error code. */
export function deleteRefusalMessage(outcome: WriteRefusal): string {
  switch (outcome.code) {
    case 'read-only':
      return 'This session is read-only, so nothing was deleted. Restart without --read-only.';
    case 'credential-store':
      return 'Credential stores are never modified here. Use the owning tool to remove this file.';
    case 'not-deletable':
      return outcome.message;
    case 'hash-mismatch':
      return 'This file changed on disk since it was loaded, so nothing was deleted. Rescan and look at it again before deleting.';
    case 'not-found':
      return 'This file is already gone. Rescan to update the view.';
    default:
      return outcome.message;
  }
}
