/**
 * The skills and agents workbench.
 *
 * Every capability on the machine — agents, skills, prompts, commands, and
 * chat modes — shares one shape: a YAML front-matter block of metadata over a
 * Markdown body of instructions. The Files view can already edit that as raw
 * text, but doing so makes renaming a skill or repointing it at a different
 * model a YAML-editing exercise, which is exactly the sort of change that
 * quietly breaks a harness when an indent or a quote goes missing.
 *
 * So this view edits the metadata as fields and the instructions as prose, and
 * shows the standard document the two compose into. The safety contract is the
 * one the raw editor already established: the form is populated from a *masked*
 * copy for reading, entering edit mode fetches the real text, and a save
 * carries the hash of the file it was loaded from so a concurrent external
 * edit aborts rather than being overwritten.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { getCapabilities, getCapability, putCapability } from '../api/client.js';
import { Badge, scopeVariant } from '../components/Badge.js';
import { CodeEditor } from '../components/CodeEditor.js';
import { EmptyState, ErrorState, LoadingState } from '../components/StatusStates.js';
import { describeError, useAsync } from '../hooks/useAsync.js';
import { useTheme } from '../hooks/useTheme.js';
import { COMMON_MODELS, parseToolList, previewDocument } from '../lib/capability.js';
import { diffLines } from '../lib/diff.js';
import { SCOPE_LABELS } from '../lib/scope.js';
import type {
  CapabilityDocument,
  CapabilityEdit,
  CapabilitySummary,
  EditableCapabilityKind,
  WriteRefusal,
} from '../api/types.js';

const KIND_LABELS: Record<EditableCapabilityKind, string> = {
  agent: 'Agents',
  skill: 'Skills',
  command: 'Commands',
  prompt: 'Prompts',
  chatmode: 'Chat modes',
};

const KIND_ORDER: EditableCapabilityKind[] = ['agent', 'skill', 'command', 'prompt', 'chatmode'];

/** How many "add this tool" shortcuts the form offers before it stops. */
const MAX_TOOL_SUGGESTIONS = 12;

/**
 * A read-only editor height that fits the document.
 *
 * CodeMirror needs a height, and a fixed one reserves most of a screen for a
 * four-line skill. Sizing from the line count keeps short capabilities compact
 * while still capping long ones so the page stays scrollable.
 */
function fitHeight(body: string): string {
  const lines = body.split('\n').length;
  return `${Math.min(Math.max(lines + 2, 8), 34) * 1.4}rem`;
}

/** The editable state of the form, all as strings the way an input holds them. */
interface FormState {
  name: string;
  description: string;
  model: string;
  version: string;
  tools: string;
  body: string;
}

function formFrom(doc: CapabilityDocument): FormState {
  return {
    name: doc.fields.name ?? '',
    description: doc.fields.description ?? '',
    model: doc.fields.model ?? '',
    version: doc.fields.version ?? '',
    tools: (doc.fields.tools ?? []).join(', '),
    body: doc.body,
  };
}

function editFrom(form: FormState): CapabilityEdit {
  // Every field is sent on every save, including the empty ones: the server
  // reads an empty string as "remove this key", which is how clearing Model in
  // the form actually clears it in the file rather than writing `model: ''`.
  return {
    name: form.name.trim(),
    description: form.description.trim(),
    model: form.model.trim(),
    version: form.version.trim(),
    tools: parseToolList(form.tools),
    body: form.body,
  };
}

export function CapabilitiesView({
  initialFileId,
}: {
  initialFileId: string | undefined;
}): ReactElement {
  const list = useAsync(getCapabilities, []);
  const theme = useTheme();

  const [filter, setFilter] = useState('');
  const [kindFilter, setKindFilter] = useState<EditableCapabilityKind | 'all'>('all');

  const [doc, setDoc] = useState<CapabilityDocument | undefined>(undefined);
  const [docLoading, setDocLoading] = useState(false);
  const [docError, setDocError] = useState<string | undefined>(undefined);

  const [editing, setEditing] = useState(false);
  const [editHash, setEditHash] = useState<string | undefined>(undefined);
  const [original, setOriginal] = useState<FormState | undefined>(undefined);
  const [form, setForm] = useState<FormState | undefined>(undefined);
  const [editLoading, setEditLoading] = useState(false);

  const [showConfirm, setShowConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<WriteRefusal | undefined>(undefined);
  const [successMessage, setSuccessMessage] = useState<string | undefined>(undefined);

  useEffect(() => {
    setEditing(false);
    setForm(undefined);
    setOriginal(undefined);
    setEditHash(undefined);
    setRefusal(undefined);
    setShowConfirm(false);
    setSuccessMessage(undefined);

    if (!initialFileId) {
      setDoc(undefined);
      return;
    }

    let cancelled = false;
    setDocLoading(true);
    setDocError(undefined);
    getCapability(initialFileId)
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
    if (!initialFileId) return;
    setEditLoading(true);
    try {
      const revealed = await getCapability(initialFileId, true);
      const next = formFrom(revealed);
      setDoc(revealed);
      setForm(next);
      setOriginal(next);
      setEditHash(revealed.hash);
      setEditing(true);
      setRefusal(undefined);
      setSuccessMessage(undefined);
    } catch (caught) {
      setDocError(describeError(caught));
    } finally {
      setEditLoading(false);
    }
  };

  const cancelEdit = (): void => {
    setEditing(false);
    setShowConfirm(false);
    setRefusal(undefined);
    if (initialFileId) {
      void getCapability(initialFileId)
        .then(setDoc)
        .catch(() => undefined);
    }
  };

  const confirmSave = async (): Promise<void> => {
    if (!initialFileId || !form || !editHash) return;
    setSaving(true);
    try {
      const outcome = await putCapability(initialFileId, editFrom(form), editHash);
      if (outcome.ok) {
        setSuccessMessage(`Saved. Previous version backed up to ${outcome.backupPath}.`);
        setEditing(false);
        setShowConfirm(false);
        setRefusal(undefined);
        setDoc(await getCapability(initialFileId));
        list.reload();
      } else {
        setRefusal(outcome);
        setShowConfirm(false);
      }
    } catch (caught) {
      setRefusal({ ok: false, code: 'write-failed', message: describeError(caught) });
      setShowConfirm(false);
    } finally {
      setSaving(false);
    }
  };

  const reloadAfterConflict = async (): Promise<void> => {
    if (!initialFileId) return;
    setRefusal(undefined);
    const revealed = await getCapability(initialFileId, true);
    const next = formFrom(revealed);
    setDoc(revealed);
    setForm(next);
    setOriginal(next);
    setEditHash(revealed.hash);
  };

  const capabilities = list.data?.capabilities ?? [];
  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return capabilities.filter((entry) => {
      if (kindFilter !== 'all' && entry.kind !== kindFilter) return false;
      if (needle.length === 0) return true;
      return [
        entry.name,
        entry.description ?? '',
        entry.model ?? '',
        entry.providerName,
        entry.fileName,
        entry.directory,
        entry.tools.join(' '),
      ].some((value) => value.toLowerCase().includes(needle));
    });
  }, [capabilities, filter, kindFilter]);

  if (list.loading) return <LoadingState label="Loading agents and skills…" />;
  if (list.error) {
    return (
      <ErrorState message={list.error} {...(list.retryable ? { onRetry: list.reload } : {})} />
    );
  }
  if (capabilities.length === 0) {
    return (
      <EmptyState
        title="No agents or skills were discovered."
        detail="Agent and skill files live in folders such as ~/.copilot/agents, ~/.claude/skills, and .github/agents. Register a project root on the Overview page if yours are project-scoped."
      />
    );
  }

  const modelSuggestions = [...new Set([...(list.data?.knownModels ?? []), ...COMMON_MODELS])];
  const toolSuggestions = list.data?.knownTools ?? [];

  return (
    <div className="view view-capabilities capability-layout">
      <div className="capability-sidebar">
        <div className="toolbar toolbar-stacked">
          <label htmlFor="capability-filter">Filter agents and skills</label>
          <input
            id="capability-filter"
            type="search"
            value={filter}
            placeholder="reviewer, pdf, gpt-5.1"
            onChange={(event) => setFilter(event.target.value)}
          />
          <label htmlFor="capability-kind">Kind</label>
          <select
            id="capability-kind"
            value={kindFilter}
            onChange={(event) =>
              setKindFilter(event.target.value as EditableCapabilityKind | 'all')
            }
          >
            <option value="all">All kinds</option>
            {KIND_ORDER.map((kind) => (
              <option key={kind} value={kind}>
                {KIND_LABELS[kind]}
              </option>
            ))}
          </select>
        </div>
        <p className="muted small">
          {shown.length} of {capabilities.length} shown.
        </p>
        <CapabilityList entries={shown} selectedFileId={initialFileId} />
      </div>

      <div className="capability-detail">
        {!initialFileId ? (
          <EmptyState
            title="Select an agent or skill"
            detail="Choose one from the list to read it, then use Edit to change its name, model, version, tools, or instructions."
          />
        ) : docLoading ? (
          <LoadingState label="Loading capability…" />
        ) : docError ? (
          <ErrorState message={docError} />
        ) : doc ? (
          <>
            <CapabilityHeader doc={doc} />

            {successMessage ? (
              <p role="status" aria-live="polite" className="notice notice-ok">
                {successMessage}
              </p>
            ) : null}

            {refusal ? (
              <div role="alert" className="notice notice-error">
                <p>{refusalMessage(refusal)}</p>
                {refusal.issues && refusal.issues.length > 0 ? (
                  <ul>
                    {refusal.issues.map((issue, index) => (
                      <li key={index}>
                        {issue.message}
                        {issue.line !== undefined ? ` (line ${issue.line})` : ''}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <div className="notice-actions">
                  {refusal.code === 'hash-mismatch' ? (
                    <button type="button" onClick={() => void reloadAfterConflict()}>
                      Reload latest version
                    </button>
                  ) : null}
                  <button type="button" onClick={() => setRefusal(undefined)}>
                    Dismiss
                  </button>
                </div>
              </div>
            ) : null}

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

            {!doc.hasFrontmatter && !editing ? (
              <p className="notice notice-info">
                This file has no front matter. Saving an edit adds a standard <code>---</code> block
                above the instructions.
              </p>
            ) : null}

            {!editing && doc.redactions.length > 0 ? (
              <p className="notice notice-info">
                {doc.redactions.length} value{doc.redactions.length === 1 ? '' : 's'} in this file
                look like secrets and are masked below. Opening it for editing loads the real text.
              </p>
            ) : null}

            <div className="file-detail-actions">
              {!editing ? (
                <button
                  type="button"
                  onClick={() => void startEdit()}
                  disabled={doc.readOnly || editLoading}
                >
                  {editLoading ? 'Opening for edit…' : 'Edit'}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => setShowConfirm(true)}
                    disabled={!form || !original || !hasChanges(original, form)}
                  >
                    Review &amp; save
                  </button>
                  <button type="button" onClick={cancelEdit}>
                    Cancel
                  </button>
                </>
              )}
              <a
                className="capability-raw-link"
                href={`#/files/${encodeURIComponent(doc.file.id)}`}
              >
                Open raw file editor
              </a>
              {doc.readOnly ? (
                <span className="muted">{doc.readOnlyReason ?? 'Read-only.'}</span>
              ) : null}
            </div>

            {editing && form ? (
              <CapabilityForm
                form={form}
                onChange={setForm}
                extraKeys={doc.extraKeys}
                modelSuggestions={modelSuggestions}
                toolSuggestions={toolSuggestions}
                theme={theme.resolved}
              />
            ) : (
              <CapabilityReadout doc={doc} theme={theme.resolved} />
            )}

            {showConfirm && form && original ? (
              <SaveConfirmation
                before={original}
                after={form}
                saving={saving}
                onConfirm={() => void confirmSave()}
                onCancel={() => setShowConfirm(false)}
              />
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

function CapabilityList({
  entries,
  selectedFileId,
}: {
  entries: CapabilitySummary[];
  selectedFileId: string | undefined;
}): ReactElement {
  const groups = new Map<EditableCapabilityKind, CapabilitySummary[]>();
  for (const entry of entries) {
    const bucket = groups.get(entry.kind);
    if (bucket) bucket.push(entry);
    else groups.set(entry.kind, [entry]);
  }

  if (entries.length === 0) return <EmptyState title="Nothing matches this filter." />;

  return (
    <nav aria-label="Agents and skills" className="capability-nav">
      {KIND_ORDER.filter((kind) => (groups.get(kind)?.length ?? 0) > 0).map((kind) => (
        <section key={kind}>
          <h3>
            {KIND_LABELS[kind]} <span className="muted">({groups.get(kind)?.length ?? 0})</span>
          </h3>
          <ul className="capability-nav-list">
            {(groups.get(kind) ?? []).map((entry) => (
              <li key={entry.fileId}>
                <a
                  href={`#/capabilities/${encodeURIComponent(entry.fileId)}`}
                  aria-current={entry.fileId === selectedFileId ? 'true' : undefined}
                  className={entry.fileId === selectedFileId ? 'is-selected' : undefined}
                >
                  <span className="capability-nav-name">{entry.name}</span>
                  <span className="muted small">
                    {entry.providerName}
                    {entry.model ? ` · ${entry.model}` : ''}
                  </span>
                  {entry.malformed ? (
                    <span className="badge badge-warning">
                      <span aria-hidden="true">&#9888;</span> Front matter problem
                    </span>
                  ) : null}
                </a>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </nav>
  );
}

function CapabilityHeader({ doc }: { doc: CapabilityDocument }): ReactElement {
  const file = doc.file;
  return (
    <div className="file-detail-header">
      <div>
        <h2>{doc.fields.name ?? file.name}</h2>
        <p className="muted file-path">{file.displayPath}</p>
        <p className="muted small file-directory">
          Directory: <code>{file.directory}</code> &middot; {file.locationLabel}
        </p>
      </div>
      <div className="file-detail-badges">
        <Badge variant={scopeVariant(file.scope)}>{SCOPE_LABELS[file.scope]}</Badge>
        <span className="chip">{file.providerName}</span>
        <span className="chip">{doc.kind}</span>
      </div>
    </div>
  );
}

function CapabilityReadout({
  doc,
  theme,
}: {
  doc: CapabilityDocument;
  theme: 'light' | 'dark';
}): ReactElement {
  const tools = doc.fields.tools ?? [];
  return (
    <div className="capability-readout">
      <dl className="capability-facts">
        <div>
          <dt>Name</dt>
          <dd>{doc.fields.name ?? <span className="muted">Not declared</span>}</dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd>{doc.fields.model ?? <span className="muted">Not declared</span>}</dd>
        </div>
        <div>
          <dt>Version</dt>
          <dd>{doc.fields.version ?? <span className="muted">Not declared</span>}</dd>
        </div>
        <div>
          <dt>Description</dt>
          <dd>{doc.fields.description ?? <span className="muted">Not declared</span>}</dd>
        </div>
        <div>
          <dt>Tools</dt>
          <dd>
            {tools.length > 0 ? (
              <ul className="chip-list">
                {tools.map((tool) => (
                  <li key={tool}>
                    <span className="chip chip-quiet">{tool}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <span className="muted">Not declared</span>
            )}
          </dd>
        </div>
        {doc.extraKeys.length > 0 ? (
          <div>
            <dt>Other front matter</dt>
            <dd className="muted">{doc.extraKeys.join(', ')} — preserved when you save.</dd>
          </div>
        ) : null}
      </dl>

      <h3>Instructions</h3>
      <CodeEditor
        value={doc.body}
        language="markdown"
        readOnly
        theme={theme}
        ariaLabel="Capability instructions, read-only"
        height={fitHeight(doc.body)}
      />
    </div>
  );
}

function CapabilityForm({
  form,
  onChange,
  extraKeys,
  modelSuggestions,
  toolSuggestions,
  theme,
}: {
  form: FormState;
  onChange: (next: FormState) => void;
  extraKeys: readonly string[];
  modelSuggestions: readonly string[];
  toolSuggestions: readonly string[];
  theme: 'light' | 'dark';
}): ReactElement {
  const set = <K extends keyof FormState>(key: K, value: FormState[K]): void =>
    onChange({ ...form, [key]: value });

  const tools = parseToolList(form.tools);
  // Capped: a harness with fifty distinct tools would otherwise bury the field
  // it is meant to help with.
  const unusedSuggestions = toolSuggestions
    .filter((tool) => !tools.includes(tool))
    .slice(0, MAX_TOOL_SUGGESTIONS);
  const preview = previewDocument(
    {
      name: form.name.trim(),
      description: form.description.trim(),
      model: form.model.trim(),
      version: form.version.trim(),
      tools,
    },
    form.body,
    extraKeys,
  );

  return (
    <div className="capability-editor">
      <fieldset className="capability-fieldset">
        <legend>Front matter</legend>

        <div className="field">
          <label htmlFor="capability-name">Name</label>
          <input
            id="capability-name"
            type="text"
            value={form.name}
            onChange={(event) => set('name', event.target.value)}
            aria-describedby="capability-name-hint"
          />
          <p id="capability-name-hint" className="muted small">
            How the capability is invoked. Leave empty to remove the key entirely.
          </p>
        </div>

        <div className="field">
          <label htmlFor="capability-description">Description</label>
          <textarea
            id="capability-description"
            rows={3}
            value={form.description}
            onChange={(event) => set('description', event.target.value)}
            aria-describedby="capability-description-hint"
          />
          <p id="capability-description-hint" className="muted small">
            One line telling the tool when to load this. Written as a single YAML scalar.
          </p>
        </div>

        <div className="field-row">
          <div className="field">
            <label htmlFor="capability-model">Model</label>
            <input
              id="capability-model"
              type="text"
              list="capability-model-options"
              value={form.model}
              onChange={(event) => set('model', event.target.value)}
              aria-describedby="capability-model-hint"
            />
            {/* Free text with suggestions rather than a fixed list: a closed
                set would go stale and block a model this build never saw. */}
            <datalist id="capability-model-options">
              {modelSuggestions.map((model) => (
                <option key={model} value={model} />
              ))}
            </datalist>
            <p id="capability-model-hint" className="muted small">
              Model identifier, including its version — suggestions come from your own files.
            </p>
          </div>

          <div className="field">
            <label htmlFor="capability-version">Version</label>
            <input
              id="capability-version"
              type="text"
              value={form.version}
              onChange={(event) => set('version', event.target.value)}
              aria-describedby="capability-version-hint"
              placeholder="1.0.0"
            />
            <p id="capability-version-hint" className="muted small">
              Your own version for this capability, not the model&rsquo;s.
            </p>
          </div>
        </div>

        <div className="field">
          <label htmlFor="capability-tools">Tools</label>
          <input
            id="capability-tools"
            type="text"
            value={form.tools}
            onChange={(event) => set('tools', event.target.value)}
            aria-describedby="capability-tools-hint"
            placeholder="read, edit, search"
          />
          <p id="capability-tools-hint" className="muted small">
            Comma separated. Written as a YAML list. Leave empty to remove the key, which most tools
            read as &ldquo;no restriction&rdquo;.
          </p>
          {tools.length > 0 ? (
            <ul className="chip-list">
              {tools.map((tool, index) => (
                <li key={`${tool}-${index}`}>
                  <span className="chip chip-quiet">{tool}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {unusedSuggestions.length > 0 ? (
            <div className="capability-suggestions">
              <span className="muted small">Used elsewhere in your harness:</span>
              <ul className="chip-list">
                {unusedSuggestions.map((tool) => (
                  <li key={tool}>
                    <button
                      type="button"
                      className="chip chip-quiet chip-button"
                      onClick={() => set('tools', [...tools, tool].join(', '))}
                    >
                      + {tool}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        {extraKeys.length > 0 ? (
          <p className="muted small">
            {extraKeys.join(', ')} {extraKeys.length === 1 ? 'is' : 'are'} preserved exactly as
            written. Use the raw file editor to change {extraKeys.length === 1 ? 'it' : 'them'}.
          </p>
        ) : null}
      </fieldset>

      <fieldset className="capability-fieldset">
        <legend>Instructions</legend>
        <p className="muted small">
          Everything below the front matter, in Markdown. Conventionally opens with an{' '}
          <code># Heading</code> naming the capability.
        </p>
        <CodeEditor
          value={form.body}
          language="markdown"
          readOnly={false}
          theme={theme}
          onChange={(next) => set('body', next)}
          ariaLabel="Capability instructions, editable"
          height="40vh"
        />
      </fieldset>

      <section className="capability-preview" aria-labelledby="capability-preview-heading">
        <h3 id="capability-preview-heading">Document structure</h3>
        <p className="muted small">
          The shape this form writes. Front matter is re-serialized by the server, so quoting may
          differ slightly from what is shown.
        </p>
        <pre className="markdown-preview">{preview}</pre>
      </section>
    </div>
  );
}

const FIELD_LABELS: Record<keyof FormState, string> = {
  name: 'Name',
  description: 'Description',
  model: 'Model',
  version: 'Version',
  tools: 'Tools',
  body: 'Instructions',
};

function hasChanges(before: FormState, after: FormState): boolean {
  return (Object.keys(FIELD_LABELS) as (keyof FormState)[]).some(
    (key) => normalizeField(key, before[key]) !== normalizeField(key, after[key]),
  );
}

/** Compares fields the way they will be written, so whitespace alone is not a change. */
function normalizeField(key: keyof FormState, value: string): string {
  if (key === 'body') return value;
  if (key === 'tools') return parseToolList(value).join(', ');
  return value.trim();
}

/**
 * Confirms a save by describing the change, not by diffing the whole file.
 *
 * A text diff would have to be built from a client-side guess at how the
 * server will serialize the front matter, and a diff that is subtly wrong
 * about what is being written is worse than none. The metadata changes are
 * shown as before/after pairs, which is exact, and the body — which is sent
 * verbatim — gets a real line diff.
 */
function SaveConfirmation({
  before,
  after,
  saving,
  onConfirm,
  onCancel,
}: {
  before: FormState;
  after: FormState;
  saving: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): ReactElement {
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Writing to a real config file is irreversible from here, so focus moves to
  // the confirmation instead of staying in the form the user just left. This
  // is the only way a screen reader user learns the step exists.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const metadataKeys = (Object.keys(FIELD_LABELS) as (keyof FormState)[]).filter(
    (key) => key !== 'body' && normalizeField(key, before[key]) !== normalizeField(key, after[key]),
  );
  const bodyChanged = before.body !== after.body;
  const bodyDiff = bodyChanged ? diffLines(before.body, after.body) : [];

  return (
    <section className="save-confirm" aria-labelledby="capability-save-heading">
      <h3 id="capability-save-heading" ref={headingRef} tabIndex={-1}>
        Confirm changes
      </h3>

      {metadataKeys.length === 0 && !bodyChanged ? <p>No changes detected.</p> : null}

      {metadataKeys.length > 0 ? (
        <div
          className="table-scroll capability-change-scroll"
          role="region"
          aria-label="Front matter changes"
          tabIndex={0}
        >
          <table className="capability-change-table">
            <caption>Front matter</caption>
            <thead>
              <tr>
                <th scope="col">Field</th>
                <th scope="col">Before</th>
                <th scope="col">After</th>
              </tr>
            </thead>
            <tbody>
              {metadataKeys.map((key) => (
                <tr key={key}>
                  <th scope="row">{FIELD_LABELS[key]}</th>
                  <td>{before[key] || <span className="muted">removed</span>}</td>
                  <td>{after[key] || <span className="muted">removed</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {bodyChanged ? (
        <>
          <h4>Instructions</h4>
          <pre className="diff-view">
            {bodyDiff.map((line, index) => (
              <div key={index} className={`diff-line diff-${line.kind}`}>
                <span aria-hidden="true">
                  {line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}
                </span>
                {line.kind === 'context' ? null : (
                  <span className="visually-hidden">
                    {line.kind === 'add' ? 'Added: ' : 'Removed: '}
                  </span>
                )}{' '}
                {line.text}
              </div>
            ))}
          </pre>
        </>
      ) : null}

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

function refusalMessage(outcome: WriteRefusal): string {
  switch (outcome.code) {
    case 'read-only':
      return 'This session is read-only. No changes were saved.';
    case 'credential-store':
      return 'Credential stores are never editable here.';
    case 'invalid-content':
      return outcome.message;
    case 'hash-mismatch':
      return 'This file changed on disk since it was loaded. Reload to see the latest version before saving again.';
    case 'not-found':
      return 'This file could no longer be found. It may have been moved or deleted.';
    // MCP-server removal codes, which a capability write never produces; the
    // switch has to stay exhaustive over the shared refusal union.
    case 'not-declared':
    case 'unsupported-format':
      return outcome.message;
    case 'write-failed':
      return outcome.message;
  }
}
