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
import { getReview } from '../api/client.js';
import { Badge, scopeVariant, type BadgeVariant } from '../components/Badge.js';
import { EmptyState, ErrorState, LoadingState } from '../components/StatusStates.js';
import { useAsync } from '../hooks/useAsync.js';
import { SCOPE_LABELS } from '../lib/scope.js';
import type {
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
        instructions, servers and guardrails. Everything is judged from the bytes already on your
        disk — nothing is fetched, executed, or sent to a model.{' '}
        <button type="button" className="link-button" onClick={() => setShowRules((on) => !on)}>
          {showRules ? 'Hide the rule list' : 'See what is checked'}
        </button>
      </p>

      {showRules ? <RuleList rules={rules} /> : null}

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
