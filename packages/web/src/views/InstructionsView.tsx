/**
 * Rollup of instructions, capabilities, and guardrails across every tool —
 * the "policy" half of the harness, as opposed to the raw file listing.
 */

import type { ReactElement } from 'react';
import { getInventory } from '../api/client.js';
import { Badge, scopeVariant } from '../components/Badge.js';
import { EmptyState, ErrorState, LoadingState } from '../components/StatusStates.js';
import { useAsync } from '../hooks/useAsync.js';
import { SCOPE_LABELS } from '../lib/scope.js';
import type {
  CapabilityEntry,
  CapabilityKind,
  GuardrailEntry,
  InstructionEntry,
} from '../api/types.js';

const CAPABILITY_KIND_LABELS: Record<CapabilityKind, string> = {
  agent: 'Agents',
  skill: 'Skills',
  prompt: 'Prompts',
  command: 'Commands',
  chatmode: 'Chat modes',
};

const CAPABILITY_KIND_ORDER: CapabilityKind[] = ['agent', 'skill', 'command', 'prompt', 'chatmode'];

export function InstructionsView(): ReactElement {
  const inventory = useAsync(getInventory, []);

  if (inventory.loading) return <LoadingState label="Loading instructions…" />;
  if (inventory.error) {
    return (
      <ErrorState
        message={inventory.error}
        {...(inventory.retryable ? { onRetry: inventory.reload } : {})}
      />
    );
  }
  if (!inventory.data) return <EmptyState title="No data available." />;

  const { instructions, capabilities, guardrails } = inventory.data;
  const sortedInstructions = [...instructions].sort((a, b) => b.precedence - a.precedence);

  return (
    <div className="view view-instructions">
      <section aria-labelledby="instructions-heading">
        <h2 id="instructions-heading">Instructions</h2>
        {sortedInstructions.length === 0 ? (
          <EmptyState title="No instruction files were found." />
        ) : (
          <ol className="instruction-list">
            {sortedInstructions.map((entry) => (
              <InstructionRow key={entry.fileId} entry={entry} />
            ))}
          </ol>
        )}
      </section>

      <section aria-labelledby="capabilities-heading">
        <h2 id="capabilities-heading">Capabilities</h2>
        {capabilities.length === 0 ? (
          <EmptyState title="No agents, skills, prompts, commands, or chat modes were found." />
        ) : (
          <CapabilityRollup capabilities={capabilities} />
        )}
      </section>

      <section aria-labelledby="guardrails-heading">
        <h2 id="guardrails-heading">Guardrails</h2>
        {guardrails.length === 0 ? (
          <EmptyState title="No permission, ignore, or hook configuration was found." />
        ) : (
          <ul className="guardrail-list">
            {guardrails.map((entry) => (
              <GuardrailCard key={entry.fileId} entry={entry} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function InstructionRow({ entry }: { entry: InstructionEntry }): ReactElement {
  return (
    <li className="instruction-row">
      <div className="instruction-row-header">
        <Badge variant={scopeVariant(entry.scope)}>{SCOPE_LABELS[entry.scope]} precedence</Badge>
        <a href={`#/files/${encodeURIComponent(entry.fileId)}`} className="instruction-title">
          {entry.title}
        </a>
        <span className="chip">{entry.providerName}</span>
      </div>
      {entry.description ? <p className="instruction-description">{entry.description}</p> : null}
      <p className="muted small">
        {entry.displayPath} &middot; {entry.lineCount} line(s) &middot; {entry.bytes} bytes
        {entry.appliesTo ? (
          <>
            {' '}
            &middot; applies to <code>{entry.appliesTo}</code>
          </>
        ) : null}
      </p>
    </li>
  );
}

function CapabilityRollup({ capabilities }: { capabilities: CapabilityEntry[] }): ReactElement {
  const groups = new Map<CapabilityKind, CapabilityEntry[]>();
  for (const capability of capabilities) {
    const list = groups.get(capability.kind);
    if (list) list.push(capability);
    else groups.set(capability.kind, [capability]);
  }

  return (
    <div className="capability-groups">
      {CAPABILITY_KIND_ORDER.filter((kind) => (groups.get(kind)?.length ?? 0) > 0).map((kind) => (
        <div className="capability-group" key={kind}>
          <h3>
            {CAPABILITY_KIND_LABELS[kind]}{' '}
            <span className="muted">({groups.get(kind)?.length ?? 0})</span>
          </h3>
          <ul className="capability-list">
            {(groups.get(kind) ?? []).map((capability) => (
              <li className="capability-card" key={capability.fileId}>
                <div className="capability-card-header">
                  <a href={`#/files/${encodeURIComponent(capability.fileId)}`}>{capability.name}</a>
                  <Badge variant={scopeVariant(capability.scope)}>
                    {SCOPE_LABELS[capability.scope]}
                  </Badge>
                  <span className="chip">{capability.providerName}</span>
                </div>
                {capability.description ? <p>{capability.description}</p> : null}
                <p className="muted small">
                  {capability.model ? <>Model: {capability.model} &middot; </> : null}
                  {capability.tools && capability.tools.length > 0 ? (
                    <>Tools: {capability.tools.join(', ')}</>
                  ) : null}
                </p>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function GuardrailCard({ entry }: { entry: GuardrailEntry }): ReactElement {
  return (
    <li className="guardrail-card">
      <div className="guardrail-card-header">
        <a href={`#/files/${encodeURIComponent(entry.fileId)}`}>{entry.displayPath}</a>
        <Badge variant={scopeVariant(entry.scope)}>{SCOPE_LABELS[entry.scope]}</Badge>
        <span className="chip">{entry.providerName}</span>
        <span className="chip">{entry.kind}</span>
      </div>
      <div className="guardrail-rules">
        <RuleList label="Allow" rules={entry.allow} tone="ok" />
        <RuleList label="Deny" rules={entry.deny} tone="error" />
        <RuleList label="Ask" rules={entry.ask} tone="warning" />
        <RuleList label="Hooks" rules={entry.hooks} tone="neutral" />
        <RuleList label="Ignore patterns" rules={entry.ignorePatterns} tone="neutral" />
      </div>
    </li>
  );
}

function RuleList({
  label,
  rules,
  tone,
}: {
  label: string;
  rules: string[];
  tone: 'ok' | 'error' | 'warning' | 'neutral';
}): ReactElement | null {
  if (rules.length === 0) return null;
  return (
    <div className={`rule-list rule-list-${tone}`}>
      <h4>{label}</h4>
      <ul>
        {rules.map((rule, index) => (
          <li key={`${rule}-${index}`}>
            <code>{rule}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}
