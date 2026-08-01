import type { ReactElement } from 'react';
import type { DiscoveredFile, ProviderGroup } from '../api/types.js';
import { SCOPE_LABELS, SCOPE_ORDER } from '../lib/scope.js';

/** Groups a provider's files by scope, in precedence order, dropping empty scopes. */
function groupByScope(
  files: DiscoveredFile[],
): Array<{ scope: DiscoveredFile['scope']; files: DiscoveredFile[] }> {
  return SCOPE_ORDER.map((scope) => ({
    scope,
    files: files.filter((file) => file.scope === scope),
  })).filter((group) => group.files.length > 0);
}

export function FileTree({
  tree,
  selectedFileId,
}: {
  tree: ProviderGroup[];
  selectedFileId: string | undefined;
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
                {scopeGroup.files.map((file) => {
                  const active = file.id === selectedFileId;
                  return (
                    <li key={file.id}>
                      <a
                        href={`#/files/${encodeURIComponent(file.id)}`}
                        aria-current={active ? 'page' : undefined}
                        className={active ? 'file-tree-link active' : 'file-tree-link'}
                        title={file.displayPath}
                      >
                        <span className="file-tree-name">{file.name}</span>
                        <span className="muted file-tree-kind">{file.kind}</span>
                      </a>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      ))}
    </nav>
  );
}
