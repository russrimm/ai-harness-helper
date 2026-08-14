import type { ReactElement } from 'react';
import { DeleteButton, DeleteConfirm, deleteConfirmId } from './DeleteControl.js';
import type { FileDeletion } from '../hooks/useFileDeletion.js';
import type { ProviderGroup, TreeFile } from '../api/types.js';
import { SCOPE_LABELS, SCOPE_ORDER } from '../lib/scope.js';

/** Groups a provider's files by scope, in precedence order, dropping empty scopes. */
function groupByScope(files: TreeFile[]): Array<{ scope: TreeFile['scope']; files: TreeFile[] }> {
  return SCOPE_ORDER.map((scope) => ({
    scope,
    files: files.filter((file) => file.scope === scope),
  })).filter((group) => group.files.length > 0);
}

export function FileTree({
  tree,
  selectedFileId,
  deletion,
  readOnly,
}: {
  tree: ProviderGroup[];
  selectedFileId: string | undefined;
  deletion: FileDeletion;
  readOnly: boolean;
}): ReactElement {
  return (
    <nav aria-label="Discovered files" className="file-tree">
      {tree.map((group) => (
        <div key={group.providerId} className="file-tree-provider">
          <h3>
            {group.providerName} <span className="muted">({group.files.length})</span>
          </h3>
          {groupByScope(group.files).map((scopeGroup) => (
            <div key={scopeGroup.scope} className="file-tree-scope">
              <h4>
                {SCOPE_LABELS[scopeGroup.scope]}{' '}
                <span className="muted">({scopeGroup.files.length})</span>
              </h4>
              <ul>
                {scopeGroup.files.map((file) => (
                  <FileTreeItem
                    key={file.id}
                    file={file}
                    active={file.id === selectedFileId}
                    deletion={deletion}
                    readOnly={readOnly}
                  />
                ))}
              </ul>
            </div>
          ))}
        </div>
      ))}
    </nav>
  );
}

/**
 * One file in the tree, with its delete control against the name it removes.
 *
 * The trigger is hidden outright in a read-only session rather than shown
 * disabled, because `--read-only` applies to every row alike and repeating it
 * once per file would bury the tree in controls that can never do anything.
 */
function FileTreeItem({
  file,
  active,
  deletion,
  readOnly,
}: {
  file: TreeFile;
  active: boolean;
  deletion: FileDeletion;
  readOnly: boolean;
}): ReactElement {
  const target = { label: file.name, noun: 'file', displayPath: file.displayPath };
  const confirmId = deleteConfirmId('tree', file.id);

  return (
    <li className="file-tree-item">
      <div className="file-tree-row">
        <a
          href={`#/files/${encodeURIComponent(file.id)}`}
          aria-current={active ? 'page' : undefined}
          className={active ? 'file-tree-link active' : 'file-tree-link'}
          title={file.displayPath}
        >
          <span className="file-tree-name">{file.name}</span>
          <span className="muted file-tree-kind">{file.kind}</span>
        </a>
        {readOnly ? null : (
          <DeleteButton
            target={target}
            deletable={file.deletable}
            reason={file.notDeletableReason}
            expanded={deletion.confirmingId === file.id}
            busy={deletion.busyId !== undefined}
            controls={confirmId}
            compact
            onClick={() => deletion.request(file.id)}
          />
        )}
      </div>
      {deletion.confirmingId === file.id ? (
        <DeleteConfirm
          id={confirmId}
          target={target}
          busy={deletion.busyId === file.id}
          // The scan's hash is what the tree was drawn from, so a file changed
          // elsewhere since then is refused rather than silently removed.
          onConfirm={() => deletion.confirm(file.id, file.name, file.hash)}
          onCancel={deletion.cancel}
        />
      ) : null}
    </li>
  );
}
