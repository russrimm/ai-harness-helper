/**
 * Two-pane file browser: a provider/scope/file tree on the left, and a
 * viewer/editor for the selected file on the right.
 *
 * Editing is a two-step process by design. The masked document is fetched by
 * default; only entering edit mode fetches the raw content via `?reveal=true`.
 * Saving *always* uses that raw copy, never the masked one — writing back a
 * document full of `••••` placeholders would destroy the user's real
 * credentials, which is precisely the failure this UI exists to prevent.
 */

import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { getFile, getScan, putFile, revealFileValue } from '../api/client.js';
import { Badge, scopeVariant } from '../components/Badge.js';
import { CodeEditor } from '../components/CodeEditor.js';
import { DeleteButton, DeleteConfirm, DeleteNoticeBanner } from '../components/DeleteControl.js';
import { FileTree } from '../components/FileTree.js';
import { EmptyState, ErrorState, LoadingState } from '../components/StatusStates.js';
import { describeError, useAsync } from '../hooks/useAsync.js';
import { useFileDeletion, type FileDeletion } from '../hooks/useFileDeletion.js';
import { useTheme } from '../hooks/useTheme.js';
import { diffLines } from '../lib/diff.js';
import { SCOPE_LABELS } from '../lib/scope.js';
import type { FileDocument, RedactionRecord, WriteRefusal } from '../api/types.js';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Labels a masked value by where it is, not why it was masked.
 *
 * A file can easily hold several secrets, and "Reveal key-name" repeated three
 * times tells the user nothing about which one they are about to expose.
 * Redaction paths are `key@line` for assignments and `lineN[i]` for bare
 * tokens.
 */
/**
 * Turns a redaction path into a label a person can act on.
 *
 * Paths arrive in three shapes: `key@line` from the document redactor,
 * `line{n}[{i}]` when no key could be attributed (a bare token in prose), and
 * dotted `a.b.c` from the parsed-value redactor. Without this, two secrets in
 * one file produced two identically-labelled "Reveal" buttons.
 */
function describeRedaction(redaction: RedactionRecord): string {
  const size = `${String(redaction.length)} chars`;
  const at = redaction.path.lastIndexOf('@');

  if (at > 0) {
    return `${redaction.path.slice(0, at)} (line ${redaction.path.slice(at + 1)}), ${size}`;
  }

  const bare = /^line(\d+)/.exec(redaction.path);
  if (bare) return `line ${bare[1] ?? '?'}, ${size}`;

  return `${redaction.path}, ${size}`;
}

export function FilesView({ initialFileId }: { initialFileId: string | undefined }): ReactElement {
  const scan = useAsync(getScan, []);
  const theme = useTheme();

  const [doc, setDoc] = useState<FileDocument | undefined>(undefined);
  const [docLoading, setDocLoading] = useState(false);
  const [docError, setDocError] = useState<string | undefined>(undefined);

  const [editing, setEditing] = useState(false);
  const [editDoc, setEditDoc] = useState<FileDocument | undefined>(undefined);
  const [editContent, setEditContent] = useState('');
  const [editLoading, setEditLoading] = useState(false);

  const [revealed, setRevealed] = useState<Map<string, string>>(new Map());
  const [revealingId, setRevealingId] = useState<string | undefined>(undefined);

  const [showConfirm, setShowConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [writeRefusal, setWriteRefusal] = useState<WriteRefusal | undefined>(undefined);
  const [successMessage, setSuccessMessage] = useState<string | undefined>(undefined);

  useEffect(() => {
    setEditing(false);
    setEditDoc(undefined);
    setRevealed(new Map());
    setWriteRefusal(undefined);
    setShowConfirm(false);
    setSuccessMessage(undefined);

    if (!initialFileId) {
      setDoc(undefined);
      return;
    }

    let cancelled = false;
    setDocLoading(true);
    setDocError(undefined);
    getFile(initialFileId)
      .then((result) => {
        if (!cancelled) setDoc(result);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setDocError(describeError(caught));
      })
      .finally(() => {
        if (!cancelled) setDocLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [initialFileId]);

  const startEdit = async (): Promise<void> => {
    if (!doc || !initialFileId) return;
    setEditLoading(true);
    try {
      const revealedDoc = await getFile(initialFileId, true);
      setEditDoc(revealedDoc);
      setEditContent(revealedDoc.content);
      setEditing(true);
      setWriteRefusal(undefined);
    } catch (caught) {
      setDocError(describeError(caught));
    } finally {
      setEditLoading(false);
    }
  };

  const cancelEdit = (): void => {
    setEditing(false);
    setEditDoc(undefined);
    setShowConfirm(false);
    setWriteRefusal(undefined);
  };

  const confirmSave = async (): Promise<void> => {
    if (!editDoc || !initialFileId) return;
    setSaving(true);
    try {
      const outcome = await putFile(initialFileId, editContent, editDoc.hash);
      if (outcome.ok) {
        setSuccessMessage(`Saved. Previous version backed up to ${outcome.backupPath}.`);
        setEditing(false);
        setEditDoc(undefined);
        setShowConfirm(false);
        setWriteRefusal(undefined);
        const refreshed = await getFile(initialFileId);
        setDoc(refreshed);
      } else {
        setWriteRefusal(outcome);
        setShowConfirm(false);
      }
    } catch (caught) {
      setWriteRefusal({ ok: false, code: 'write-failed', message: describeError(caught) });
      setShowConfirm(false);
    } finally {
      setSaving(false);
    }
  };

  const reloadAfterConflict = async (): Promise<void> => {
    if (!initialFileId) return;
    setWriteRefusal(undefined);
    const revealedDoc = await getFile(initialFileId, true);
    setEditDoc(revealedDoc);
    setEditContent(revealedDoc.content);
    const masked = await getFile(initialFileId);
    setDoc(masked);
  };

  const revealChip = async (redactionId: string): Promise<void> => {
    if (!initialFileId) return;
    setRevealingId(redactionId);
    try {
      const result = await revealFileValue(initialFileId, redactionId);
      setRevealed((prev) => new Map(prev).set(redactionId, result.value));
    } catch (caught) {
      setDocError(describeError(caught));
    } finally {
      setRevealingId(undefined);
    }
  };

  const reloadScan = scan.reload;
  // Once the file is gone the tree still lists it until the scan is redone,
  // and the detail pane would be showing a file that no longer exists, so the
  // selection is dropped back to "nothing selected".
  const deletion = useFileDeletion(() => {
    setDoc(undefined);
    setEditing(false);
    setEditDoc(undefined);
    window.location.hash = '#/files';
    reloadScan();
  });

  if (scan.loading) return <LoadingState label="Loading discovered files…" />;
  if (scan.error) {
    return (
      <ErrorState message={scan.error} {...(scan.retryable ? { onRetry: scan.reload } : {})} />
    );
  }
  if (!scan.data || scan.data.tree.length === 0) {
    return (
      <div className="view view-files">
        <DeleteNoticeBanner notice={deletion.notice} onDismiss={deletion.dismissNotice} />
        <EmptyState
          title="No configuration files were discovered yet."
          detail="Run a scan from the Overview page."
        />
      </div>
    );
  }

  return (
    <div className="view view-files files-layout">
      <FileTree tree={scan.data.tree} selectedFileId={initialFileId} />
      <div className="file-detail">
        <DeleteNoticeBanner notice={deletion.notice} onDismiss={deletion.dismissNotice} />
        {!initialFileId ? (
          <EmptyState
            title="Select a file"
            detail="Choose a file from the tree to view its contents."
          />
        ) : docLoading ? (
          <LoadingState label="Loading file…" />
        ) : docError ? (
          <ErrorState message={docError} />
        ) : doc ? (
          <FileDetailPanel
            doc={doc}
            editing={editing}
            editLoading={editLoading}
            editContent={editContent}
            onEditContentChange={setEditContent}
            onStartEdit={() => void startEdit()}
            onCancelEdit={cancelEdit}
            onRequestSave={() => setShowConfirm(true)}
            revealed={revealed}
            revealingId={revealingId}
            onReveal={(id) => void revealChip(id)}
            theme={theme.resolved}
            successMessage={successMessage}
            writeRefusal={writeRefusal}
            onDismissRefusal={() => setWriteRefusal(undefined)}
            onReloadAfterConflict={() => void reloadAfterConflict()}
            deletion={deletion}
          />
        ) : null}

        {showConfirm && editDoc ? (
          <SaveConfirmation
            before={editDoc.content}
            after={editContent}
            saving={saving}
            onConfirm={() => void confirmSave()}
            onCancel={() => setShowConfirm(false)}
          />
        ) : null}
      </div>
    </div>
  );
}

function FileDetailPanel({
  doc,
  editing,
  editLoading,
  editContent,
  onEditContentChange,
  onStartEdit,
  onCancelEdit,
  onRequestSave,
  revealed,
  revealingId,
  onReveal,
  theme,
  successMessage,
  writeRefusal,
  onDismissRefusal,
  onReloadAfterConflict,
  deletion,
}: {
  doc: FileDocument;
  editing: boolean;
  editLoading: boolean;
  editContent: string;
  onEditContentChange: (value: string) => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onRequestSave: () => void;
  revealed: Map<string, string>;
  revealingId: string | undefined;
  onReveal: (redactionId: string) => void;
  theme: 'light' | 'dark';
  successMessage: string | undefined;
  writeRefusal: WriteRefusal | undefined;
  onDismissRefusal: () => void;
  onReloadAfterConflict: () => void;
  deletion: FileDeletion;
}): ReactElement {
  const file = doc.file;
  const isCredentialStore = file.sensitivity === 'credential-store';
  const canEdit = !doc.readOnly && !isCredentialStore;

  return (
    <div className="file-detail-panel">
      <div className="file-detail-header">
        <div>
          <h2>{file.name}</h2>
          <p className="muted file-path">{file.displayPath}</p>
          <p className="muted small file-directory">
            Directory: <code>{file.directory}</code> &middot; {file.locationLabel}
          </p>
        </div>
        <div className="file-detail-badges">
          <Badge variant={scopeVariant(file.scope)}>{SCOPE_LABELS[file.scope]}</Badge>
          <span className="chip">{file.providerName}</span>
          <span className="chip">{file.kind}</span>
          <span className="muted">{formatBytes(file.size)}</span>
        </div>
      </div>

      {file.note ? <p className="muted note">{file.note}</p> : null}
      {file.deprecated ? (
        <p role="status" className="notice notice-info">
          This location is deprecated in favor of a newer format.
        </p>
      ) : null}

      {successMessage ? (
        <p role="status" aria-live="polite" className="notice notice-ok">
          {successMessage}
        </p>
      ) : null}

      {writeRefusal ? (
        <div role="alert" className="notice notice-error">
          <p>{refusalMessage(writeRefusal)}</p>
          {writeRefusal.issues && writeRefusal.issues.length > 0 ? (
            <ul>
              {writeRefusal.issues.map((issue, index) => (
                <li key={index}>
                  {issue.message}
                  {issue.line !== undefined ? ` (line ${issue.line})` : ''}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="notice-actions">
            {writeRefusal.code === 'hash-mismatch' ? (
              <button type="button" onClick={onReloadAfterConflict}>
                Reload latest version
              </button>
            ) : null}
            <button type="button" onClick={onDismissRefusal}>
              Dismiss
            </button>
          </div>
        </div>
      ) : null}

      {isCredentialStore ? (
        <EmptyState
          title="This file's contents are never displayed."
          detail={doc.readOnlyReason ?? 'It exists purely to hold credentials.'}
        />
      ) : (
        <>
          {doc.issues.length > 0 ? (
            <div role="alert" className="notice notice-warning">
              <p>This file has parse problems:</p>
              <ul>
                {doc.issues.map((issue, index) => (
                  <li key={index}>
                    {issue.message}
                    {issue.line !== undefined ? ` (line ${issue.line})` : ''}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {!editing && doc.redactions.length > 0 ? (
            <div className="redaction-panel">
              <p>
                {doc.redactions.length} value{doc.redactions.length === 1 ? '' : 's'} masked in this
                file.
              </p>
              <ul className="chip-list">
                {doc.redactions.map((redaction) => (
                  <li key={redaction.id}>
                    {revealed.has(redaction.id) ? (
                      <code className="revealed-value">{revealed.get(redaction.id) ?? ''}</code>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onReveal(redaction.id)}
                        disabled={revealingId === redaction.id}
                      >
                        {revealingId === redaction.id
                          ? 'Revealing…'
                          : `Reveal ${describeRedaction(redaction)}`}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="file-detail-actions">
            {!editing ? (
              <button type="button" onClick={onStartEdit} disabled={!canEdit || editLoading}>
                {editLoading ? 'Opening for edit…' : 'Edit'}
              </button>
            ) : (
              <>
                <button type="button" onClick={onRequestSave}>
                  Save
                </button>
                <button type="button" onClick={onCancelEdit}>
                  Cancel
                </button>
              </>
            )}
            {!canEdit ? <span className="muted">{doc.readOnlyReason ?? 'Read-only.'}</span> : null}
            {!editing ? (
              <DeleteButton
                target={{ label: file.name, noun: 'file', displayPath: file.displayPath }}
                deletable={doc.deletable}
                reason={doc.notDeletableReason}
                expanded={deletion.confirmingId === file.id}
                busy={deletion.busyId !== undefined}
                controls="file-delete-confirm"
                onClick={() => deletion.request(file.id)}
              />
            ) : null}
          </div>

          {deletion.confirmingId === file.id ? (
            <DeleteConfirm
              id="file-delete-confirm"
              target={{ label: file.name, noun: 'file', displayPath: file.displayPath }}
              busy={deletion.busyId === file.id}
              onConfirm={() => deletion.confirm(file.id, file.name, doc.hash)}
              onCancel={deletion.cancel}
            />
          ) : null}

          <CodeEditor
            value={editing ? editContent : doc.content}
            language={doc.language}
            readOnly={!editing}
            theme={theme}
            onChange={editing ? onEditContentChange : undefined}
            ariaLabel={`${file.name} contents, ${editing ? 'editable' : 'read-only'}`}
          />
        </>
      )}
    </div>
  );
}

function refusalMessage(outcome: WriteRefusal): string {
  switch (outcome.code) {
    case 'read-only':
      return 'This session is read-only. No changes were saved.';
    case 'credential-store':
      return 'Credential stores are never editable here.';
    case 'invalid-content':
      return 'The content does not parse in this file\u2019s format. Fix the problems below and try again.';
    case 'hash-mismatch':
      return 'This file changed on disk since it was loaded. Reload to see the latest version before saving again.';
    case 'not-found':
      return 'This file could no longer be found. It may have been moved or deleted.';
    case 'not-declared':
      return 'That MCP server is not declared in this file, so there was nothing to remove.';
    case 'not-deletable':
      return outcome.message;
    case 'unsupported-format':
      return outcome.message;
    case 'write-failed':
      return outcome.message;
  }
}

function SaveConfirmation({
  before,
  after,
  saving,
  onConfirm,
  onCancel,
}: {
  before: string;
  after: string;
  saving: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): ReactElement {
  const diff = diffLines(before, after);
  const changed = diff.some((line) => line.kind !== 'context');
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Writing to a real config file is irreversible from here, so focus moves to
  // the confirmation instead of staying in the editor the user just left. This
  // is the only way a screen reader user learns the step exists.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <section className="save-confirm" aria-labelledby="save-confirm-heading">
      <h3 id="save-confirm-heading" ref={headingRef} tabIndex={-1}>
        Confirm changes
      </h3>
      {changed ? (
        <pre className="diff-view">
          {diff.map((line, index) => (
            <div key={index} className={`diff-line diff-${line.kind}`}>
              <span aria-hidden="true">
                {line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}
              </span>
              {/* The glyph alone is invisible to a screen reader, which would
                  leave additions and removals sounding identical. */}
              {line.kind === 'context' ? null : (
                <span className="visually-hidden">
                  {line.kind === 'add' ? 'Added: ' : 'Removed: '}
                </span>
              )}{' '}
              {line.text}
            </div>
          ))}
        </pre>
      ) : (
        <p>No changes detected.</p>
      )}
      <div className="save-confirm-actions">
        <button type="button" onClick={onConfirm} disabled={saving}>
          {saving ? 'Saving…' : 'Write to disk'}
        </button>
        <button type="button" onClick={onCancel} disabled={saving}>
          Back to editing
        </button>
      </div>
    </section>
  );
}
