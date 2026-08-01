import type { ReactElement, ReactNode } from 'react';

/**
 * A single dashboard metric.
 *
 * `href` turns the whole card into a link, because every headline number also
 * answers "…and where do I go to see those?", and a card that cannot be
 * followed is a dead end. Only real routes are accepted: routing is
 * hash-based, so an in-page `#anchor` would be read as a navigation.
 */
export function StatCard({
  label,
  value,
  tone,
  hint,
  href,
}: {
  label: string;
  value: number | string;
  tone?: 'error' | 'warning';
  hint?: ReactNode;
  href?: string;
}): ReactElement {
  const className = ['stat-card', tone ? `stat-card-${tone}` : '', href ? 'stat-card-link' : '']
    .filter((part) => part.length > 0)
    .join(' ');

  const body = (
    <>
      <p className="stat-card-value">{value}</p>
      <p className="stat-card-label">{label}</p>
      {hint !== undefined ? <p className="stat-card-hint">{hint}</p> : null}
    </>
  );

  if (href === undefined) return <div className={className}>{body}</div>;
  return (
    <a className={className} href={href}>
      {body}
    </a>
  );
}
