/**
 * Provenance and duplicate indicators shared by every rollup view.
 *
 * These exist as components rather than as per-view markup so that "which
 * tool, which folder, which file, and is it a duplicate?" is answered
 * identically everywhere. A view that renders provenance its own way is a view
 * that eventually forgets to render part of it.
 */

import type { ReactElement } from 'react';
import { Badge, scopeVariant } from './Badge.js';
import { SCOPE_LABELS } from '../lib/scope.js';
import type { DuplicateInfo, EntryProvenance } from '../api/types.js';

export function Provenance({
  entry,
  showScope = true,
}: {
  entry: EntryProvenance;
  showScope?: boolean;
}): ReactElement {
  return (
    <p className="provenance">
      {showScope ? (
        <Badge variant={scopeVariant(entry.scope)}>{SCOPE_LABELS[entry.scope]}</Badge>
      ) : null}
      <span className="chip">{entry.providerName}</span>
      <span className="chip chip-quiet">{entry.locationLabel}</span>
      <span className="provenance-directory">
        <span className="visually-hidden">Directory: </span>
        <code title={entry.filePath}>{entry.directory}</code>
      </span>
      <a className="provenance-file" href={`#/files/${encodeURIComponent(entry.fileId)}`}>
        {entry.fileName}
        <span className="visually-hidden"> — open in the file editor</span>
      </a>
    </p>
  );
}

/**
 * Summarises how one entry relates to others declaring the same thing.
 *
 * Returns `null` for a unique entry rather than an "OK" pill: a badge on every
 * row would make the rows that matter harder to spot, not easier.
 */
export function DuplicateBadge({ info }: { info: DuplicateInfo }): ReactElement | null {
  const copies = info.siblingFileIds.length + 1;

  if (info.conflicting) {
    return <Badge variant="conflict">Conflict &middot; {copies} definitions</Badge>;
  }
  if (info.duplicated) {
    return <Badge variant="duplicate">Duplicate &middot; {copies} places</Badge>;
  }
  if (info.identicalFileIds.length > 0) {
    return (
      <Badge variant="duplicate">
        Identical copy &middot; {info.identicalFileIds.length + 1} files
      </Badge>
    );
  }
  return null;
}

/** True when an entry is worth showing under a "duplicates only" filter. */
export function isDuplicated(info: DuplicateInfo): boolean {
  return info.duplicated || info.identicalFileIds.length > 0;
}

/** The other files declaring the same thing, as links. */
export function DuplicateSiblings({ info }: { info: DuplicateInfo }): ReactElement | null {
  if (info.siblingFileIds.length === 0) return null;
  return (
    <p className="muted small duplicate-siblings">
      Also declared in:{' '}
      {info.siblingFileIds.map((fileId, index) => (
        <span key={fileId}>
          {index > 0 ? ', ' : ''}
          <a href={`#/files/${encodeURIComponent(fileId)}`}>
            {info.siblingDisplayPaths[index] ?? fileId}
          </a>
        </span>
      ))}
    </p>
  );
}
