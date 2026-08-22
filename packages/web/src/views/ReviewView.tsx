/**
 * The review: everything the harness gets *wrong*, as opposed to everything it
 * merely contains.
 *
 * Three decisions shape this view.
 *
 * Issues are grouped by file, not by severity. The user fixes one document at
 * a time, and a list sorted purely by severity makes them open the same file
 * four times. Severity still drives ordering *within* and *between* groups, so
 * the worst file is still first.
 *
 * Every issue states its fix inline rather than behind a disclosure. A finding
 * you have to click to act on is a finding most people scroll past.
 *
 * And the rules themselves are browsable, because "no issues found" only
 * reassures you if you can see what was actually looked for.
 */

import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import {
  getAdvisorPreview,
  getAdvisorStatus,
  getReview,
  postRecommendations,
} from '../api/client.js';
import { Badge, scopeVariant, type BadgeVariant } from '../components/Badge.js';
import { EmptyState, ErrorState, LoadingState } from '../components/StatusStates.js';
import { useAsync } from '../hooks/useAsync.js';
import { SCOPE_LABELS } from '../lib/scope.js';
import type {
  AdvisorFailure,
  AdvisorPayload,
  AdvisorResult,
  AdvisorStatus,
  Recommendation,
  ReviewCategory,
  ReviewIssue,
  ReviewReport,
  ReviewRuleMeta,
  ReviewSeverity,
} from '../api/types.js';

const SEVERITY_VARIANT: Record<ReviewSeverity, BadgeVariant> = {
  error: 'error',
  warning: 'warning',
  info: 'info',
};

const SEVERITY_RANK: Record<ReviewSeverity, number> = { error: 0, warning: 1, info: 2 };

const SEVERITY_LABELS: Record<ReviewSeverity, string> = {
  error: 'Errors',
  warning: 'Warnings',
  info: 'Suggestions',
};

const CATEGORY_LABELS: Record<ReviewCategory, string> = {
  capability: 'Skills & agents',
  instruction: 'Instructions',
  mcp: 'MCP servers',
  guardrail: 'Guardrails',
  freshness: 'Freshness',
};

const CATEGORIES: readonly ReviewCategory[] = [
  'capability',
  'instruction',
  'mcp',
  'guardrail',
  'freshness',
];

const SEVERITIES: readonly ReviewSeverity[] = ['error', 'warning', 'info'];

interface FileGroup {
  fileId: string;
  displayPath: string;
  providerName: string;
  scope: ReviewIssue['scope'];
  issues: ReviewIssue[];
  worst: ReviewSeverity;
}

export function ReviewView(): ReactElement {
  const state = useAsync(getReview, []);
  const [severities, setSeverities] = useState<Set<ReviewSeverity>>(new Set());
  const [categories, setCategories] = useState<Set<ReviewCategory>>(new Set());
  const [showRules, setShowRules] = useState(false);

  const issues = state.data?.issues ?? [];

  const visible = useMemo(
    () =>
      issues.filter(
        (issue) =>
          (severities.size === 0 || severities.has(issue.severity)) &&
          (categories.size === 0 || categories.has(issue.category)),
      ),
    [issues, severities, categories],
  );

  const groups = useMemo(() => groupByFile(visible), [visible]);

  if (state.loading)
    return <LoadingState label="Reviewing every capability, instruction, and server…" />;
  if (state.error) {
    return (
      <ErrorState message={state.error} {...(state.retryable ? { onRetry: state.reload } : {})} />
    );
  }
  if (!state.data) return <EmptyState title="No review available." />;

  const { summary, rules } = state.data;

  return (
    <div className="view view-review">
      <div className="view-header">
        <h2>Review</h2>
        <button type="button" onClick={state.reload}>
          Re-run review
        </button>
      </div>

      <ScoreBanner report={state.data} />

      <p className="muted">
        {summary.ruleCount} rules run against {summary.reviewedSubjectCount} capabilities,
        instructions, servers and guardrails. Every rule above is judged from the bytes already on
        your disk — nothing is fetched, executed, or sent to a model.{' '}
        <button type="button" className="link-button" onClick={() => setShowRules((on) => !on)}>
          {showRules ? 'Hide the rule list' : 'See what is checked'}
        </button>
      </p>

      {showRules ? <RuleList rules={rules} /> : null}

      <Recommendations />

      {issues.length === 0 ? (
        <EmptyState
          title="Nothing to fix."
          detail="Every capability has a description, every link resolves, and every server has what it needs to start."
        />
      ) : (
        <>
          <div className="review-filters">
            <ul className="chip-toggle-list" aria-label="Filter by severity">
              {SEVERITIES.filter(
                (severity) => countBy(issues, (i) => i.severity === severity) > 0,
              ).map((severity) => (
                <li key={severity}>
                  <button
                    type="button"
                    className="chip-toggle"
                    aria-pressed={severities.has(severity)}
                    onClick={() => setSeverities(toggle(severities, severity))}
                  >
                    {SEVERITY_LABELS[severity]} ({countBy(issues, (i) => i.severity === severity)})
                  </button>
                </li>
              ))}
            </ul>
            <ul className="chip-toggle-list" aria-label="Filter by area">
              {CATEGORIES.filter((category) => summary.byCategory[category] > 0).map((category) => (
                <li key={category}>
                  <button
                    type="button"
                    className="chip-toggle"
                    aria-pressed={categories.has(category)}
                    onClick={() => setCategories(toggle(categories, category))}
                  >
                    {CATEGORY_LABELS[category]} ({summary.byCategory[category]})
                  </button>
                </li>
              ))}
              {severities.size > 0 || categories.size > 0 ? (
                <li>
                  <button
                    type="button"
                    className="chip-toggle"
                    onClick={() => {
                      setSeverities(new Set());
                      setCategories(new Set());
                    }}
                  >
                    Clear filters
                  </button>
                </li>
              ) : null}
            </ul>
          </div>

          <p className="muted small" role="status" aria-live="polite">
            Showing {visible.length} of {issues.length} issues across {groups.length}{' '}
            {groups.length === 1 ? 'file' : 'files'}.
          </p>

          {groups.length === 0 ? (
            <EmptyState
              title="No issue matches those filters."
              detail="Clear them to see everything again."
            />
          ) : (
            <ul className="review-groups">
              {groups.map((group) => (
                <FileGroupCard key={group.fileId} group={group} />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function ScoreBanner({ report }: { report: ReviewReport }): ReactElement {
  const { summary } = report;
  const tone = summary.errorCount > 0 ? 'error' : summary.warningCount > 0 ? 'warning' : 'ok';

  return (
    <div className={`review-score review-score-${tone}`}>
      <div className="review-score-value">
        <strong>{summary.score}</strong>
        <span className="muted small">/ 100</span>
      </div>
      <div className="review-score-body">
        <p className="review-score-grade">
          Grade {summary.grade}
          {' \u00B7 '}
          {summary.issueCount === 0
            ? 'nothing to fix'
            : `${summary.issueCount} issue${summary.issueCount === 1 ? '' : 's'} across ${summary.affectedFileCount} file${summary.affectedFileCount === 1 ? '' : 's'}`}
        </p>
        <p className="muted small">
          {summary.errorCount} error, {summary.warningCount} warning, {summary.infoCount} suggestion
          {summary.infoCount === 1 ? '' : 's'}. The score is a prompt to look, not a measurement —
          its job is to make "did that edit help?" answerable at a glance.
        </p>
      </div>
    </div>
  );
}

/**
 * The optional model pass, sitting below the rules it complements.
 *
 * Three things drive the design. It is visually separated and always labelled
 * with the model that produced it, because a rule fired on bytes that are
 * definitely there while this is a machine's opinion. Nothing here can turn
 * egress on — the CLI flag already decided that, and this only reports it. And
 * the payload is readable in full before anything is sent, because a tool that
 * reads your credentials does not get to say "just trust me" about an upload.
 */
function Recommendations(): ReactElement | null {
  const status = useAsync(getAdvisorStatus, []);
  const [result, setResult] = useState<AdvisorResult | undefined>();
  const [failure, setFailure] = useState<string | undefined>();
  const [running, setRunning] = useState(false);
  const [preview, setPreview] = useState<AdvisorPayload | undefined>();
  const [showPreview, setShowPreview] = useState(false);

  if (status.loading || !status.data) return null;
  const advisor = status.data;

  async function run(): Promise<void> {
    setRunning(true);
    setFailure(undefined);
    try {
      const outcome = await postRecommendations();
      if (outcome.status === 'ok') {
        setResult(outcome);
      } else {
        setFailure(describeAdvisorFailure(outcome));
      }
    } catch {
      setFailure('The local server did not respond.');
    } finally {
      setRunning(false);
    }
  }

  async function togglePreview(): Promise<void> {
    if (showPreview) {
      setShowPreview(false);
      return;
    }
    setShowPreview(true);
    if (preview === undefined) {
      try {
        setPreview(await getAdvisorPreview());
      } catch {
        setShowPreview(false);
      }
    }
  }

  return (
    <section className="review-advisor" aria-labelledby="advisor-heading">
      <h3 id="advisor-heading">Model recommendations</h3>

      {advisor.status !== 'ready' ? (
        <p className="muted small">{describeAdvisorStatus(advisor)}</p>
      ) : (
        <>
          <p className="muted small">
            Asks <strong>{advisor.model}</strong>
            {advisor.local ? (
              <> on a local endpoint, so nothing leaves this machine.</>
            ) : (
              <>
                {' '}
                at <code>{advisor.endpoint}</code>. A summary of your capabilities and instructions
                — names, descriptions, and short excerpts, with secrets masked — is sent when you
                press the button. Whole files never are.
              </>
            )}
          </p>

          <div className="review-advisor-actions">
            <button type="button" onClick={() => void run()} disabled={running}>
              {running ? 'Asking…' : result ? 'Ask again' : `Ask ${advisor.model}`}
            </button>
            <button
              type="button"
              className="link-button"
              aria-expanded={showPreview}
              onClick={() => void togglePreview()}
            >
              {showPreview ? 'Hide what would be sent' : 'See exactly what would be sent'}
            </button>
          </div>

          {showPreview ? (
            preview ? (
              <>
                <p className="muted small">
                  {preview.subjects.length} subjects and {preview.knownIssues.length} existing
                  findings.
                  {preview.truncated
                    ? ' A large harness was sampled, so this is a partial view.'
                    : ''}{' '}
                  This is the exact request body; reading it sends nothing.
                </p>
                <pre className="review-advisor-preview">{JSON.stringify(preview, null, 2)}</pre>
              </>
            ) : (
              <p className="muted small">Assembling the payload…</p>
            )
          ) : null}
        </>
      )}

      <p className="muted small" role="status" aria-live="polite">
        {running ? 'Waiting for the model…' : ''}
      </p>

      {failure ? <p className="review-advisor-failure">{failure}</p> : null}

      {result ? (
        result.recommendations.length === 0 ? (
          <p className="muted small">{result.model} had nothing to add beyond the rules above.</p>
        ) : (
          <>
            <p className="muted small">
              {result.recommendations.length} suggestion
              {result.recommendations.length === 1 ? '' : 's'} from {result.model}. These are
              generated by a model, not rules — read them as opinions and check them before acting.
              {result.truncated ? ' A large harness was sampled, so this is a partial view.' : ''}
            </p>
            <ul className="review-issue-list">
              {result.recommendations.map((item) => (
                <RecommendationRow key={item.id} item={item} />
              ))}
            </ul>
          </>
        )
      ) : null}
    </section>
  );
}

function RecommendationRow({ item }: { item: Recommendation }): ReactElement {
  return (
    <li className={`review-issue review-issue-${item.severity}`}>
      <Badge variant={SEVERITY_VARIANT[item.severity]} className="finding-badge">
        {item.severity}
      </Badge>
      <div className="review-issue-body">
        <p className="review-issue-title">{item.title}</p>
        <p className="review-issue-detail">{item.detail}</p>
        <p className="review-issue-fix">
          <strong>Suggested:</strong> {item.remediation}
        </p>
        <p className="muted small review-issue-meta">
          <code>{item.subject}</code>
          {/* Linked only when the named subject matched something actually
              scanned, so a hallucinated path can never become a link. */}
          {item.fileId ? (
            <>
              {' \u00B7 '}
              <a href={`#/files/${encodeURIComponent(item.fileId)}`}>
                {item.displayPath ?? 'Open the file'}
              </a>
            </>
          ) : null}
        </p>
      </div>
    </li>
  );
}

function describeAdvisorStatus(advisor: AdvisorStatus): string {
  switch (advisor.status) {
    case 'disabled':
      return 'Off for this run. Restart with --advise to ask a model for suggestions the offline rules cannot make.';
    case 'incomplete':
      return `Enabled, but no endpoint is configured. Set ${advisor.missing.join(' and ')} and restart. A local model such as Ollama keeps everything on this machine.`;
    case 'invalid':
      return advisor.reason;
    case 'ready':
      return '';
  }
}

function describeAdvisorFailure(failure: AdvisorFailure): string {
  switch (failure.status) {
    case 'failed':
    case 'invalid':
      return failure.reason;
    case 'incomplete':
      return `No endpoint is configured. Set ${failure.missing.join(' and ')} and restart.`;
    case 'disabled':
      return 'Recommendations are off for this run. Restart with --advise.';
  }
}

function RuleList({ rules }: { rules: readonly ReviewRuleMeta[] }): ReactElement {
  return (
    <div className="review-rules">
      {CATEGORIES.map((category) => {
        const inCategory = rules.filter((rule) => rule.category === category);
        if (inCategory.length === 0) return null;
        return (
          <section key={category} aria-labelledby={`rules-${category}`}>
            <h3 id={`rules-${category}`}>{CATEGORY_LABELS[category]}</h3>
            <ul className="review-rule-list">
              {inCategory.map((rule) => (
                <li key={rule.id}>
                  <Badge variant={SEVERITY_VARIANT[rule.severity]}>{rule.severity}</Badge>{' '}
                  <strong>{rule.title}</strong>
                  <p className="muted small">{rule.rationale}</p>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function FileGroupCard({ group }: { group: FileGroup }): ReactElement {
  return (
    <li className={`review-group review-group-${group.worst}`}>
      <div className="review-group-header">
        <a href={`#/files/${encodeURIComponent(group.fileId)}`} className="review-group-path">
          {group.displayPath}
        </a>
        <Badge variant={scopeVariant(group.scope)}>{SCOPE_LABELS[group.scope]}</Badge>
        <span className="muted small">
          {group.providerName}
          {' \u00B7 '}
          {group.issues.length} issue{group.issues.length === 1 ? '' : 's'}
        </span>
      </div>
      <ul className="review-issue-list">
        {group.issues.map((issue) => (
          <IssueRow key={`${issue.id}:${issue.evidence ?? ''}`} issue={issue} />
        ))}
      </ul>
    </li>
  );
}

function IssueRow({ issue }: { issue: ReviewIssue }): ReactElement {
  return (
    <li className={`review-issue review-issue-${issue.severity}`}>
      <Badge variant={SEVERITY_VARIANT[issue.severity]} className="finding-badge">
        {issue.severity}
      </Badge>
      <div className="review-issue-body">
        <p className="review-issue-title">{issue.title}</p>
        <p className="review-issue-detail">{issue.detail}</p>
        <p className="review-issue-fix">
          <strong>Fix:</strong> {issue.remediation}
        </p>
        <p className="muted small review-issue-meta">
          <code>{issue.ruleId}</code>
          {issue.evidence ? (
            <>
              {' \u00B7 '}
              <code>{issue.evidence}</code>
            </>
          ) : null}
          {' \u00B7 '}
          <a href={`#/files/${encodeURIComponent(issue.fileId)}`}>Open the file</a>
          {issue.category === 'capability' ? (
            <>
              {' \u00B7 '}
              <a href={`#/capabilities/${encodeURIComponent(issue.fileId)}`}>Edit as a form</a>
            </>
          ) : null}
        </p>
      </div>
    </li>
  );
}

/**
 * Groups by file, then orders groups by their worst issue.
 *
 * Ties break on issue count and then path, so the order is stable across
 * re-runs; a list that reshuffles between scans is impossible to work through.
 */
function groupByFile(issues: readonly ReviewIssue[]): FileGroup[] {
  const groups = new Map<string, FileGroup>();

  for (const issue of issues) {
    const existing = groups.get(issue.fileId);
    if (existing) {
      existing.issues.push(issue);
      if (SEVERITY_RANK[issue.severity] < SEVERITY_RANK[existing.worst]) {
        existing.worst = issue.severity;
      }
      continue;
    }
    groups.set(issue.fileId, {
      fileId: issue.fileId,
      displayPath: issue.displayPath,
      providerName: issue.providerName,
      scope: issue.scope,
      issues: [issue],
      worst: issue.severity,
    });
  }

  const list = [...groups.values()];
  for (const group of list) {
    group.issues.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  }
  list.sort(
    (a, b) =>
      SEVERITY_RANK[a.worst] - SEVERITY_RANK[b.worst] ||
      b.issues.length - a.issues.length ||
      a.displayPath.localeCompare(b.displayPath),
  );
  return list;
}

function toggle<T>(current: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function countBy<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  let total = 0;
  for (const item of items) if (predicate(item)) total += 1;
  return total;
}
