/**
 * Export the harness as JSON or Markdown. Downloads are triggered via a
 * fetched Blob (never a bare `<a href>`) because the request must carry the
 * auth header.
 */

import { useState } from 'react';
import type { ReactElement } from 'react';
import { fetchExport } from '../api/client.js';
import { describeError } from '../hooks/useAsync.js';

function download(filename: string, text: string, contentType: string): void {
  const blob = new Blob([text], { type: contentType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function ExportView(): ReactElement {
  const [busy, setBusy] = useState<'json' | 'markdown' | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [preview, setPreview] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<string | undefined>(undefined);

  const runExport = async (format: 'json' | 'markdown'): Promise<void> => {
    setBusy(format);
    setError(undefined);
    setStatus(undefined);
    try {
      const { text, contentType } = await fetchExport(format);
      download(`ai-harness-export.${format === 'json' ? 'json' : 'md'}`, text, contentType);
      if (format === 'markdown') setPreview(text);
      setStatus(`${format === 'json' ? 'JSON' : 'Markdown'} export downloaded.`);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div className="view view-export">
      <h2>Export</h2>
      <p className="muted">Download a complete snapshot of the harness for sharing or archiving.</p>

      <p className="notice notice-info">
        Exports are always redacted. They describe your harness — which tools are installed, where
        their config lives, and which MCP servers are defined — but never include file contents,
        environment variable values, or credentials. Safe to attach to a bug report.
      </p>

      <div className="export-actions">
        <button type="button" onClick={() => void runExport('json')} disabled={busy !== undefined}>
          {busy === 'json' ? 'Preparing JSON…' : 'Download JSON'}
        </button>
        <button
          type="button"
          onClick={() => void runExport('markdown')}
          disabled={busy !== undefined}
        >
          {busy === 'markdown' ? 'Preparing Markdown…' : 'Download Markdown'}
        </button>
      </div>

      <p aria-live="polite" className="muted">
        {status}
      </p>
      {error ? (
        <p role="alert" className="notice notice-error">
          {error}
        </p>
      ) : null}

      {preview ? (
        <section aria-labelledby="markdown-preview-heading">
          <h3 id="markdown-preview-heading">Markdown preview</h3>
          <pre className="markdown-preview">
            <code>{preview}</code>
          </pre>
        </section>
      ) : null}
    </div>
  );
}
