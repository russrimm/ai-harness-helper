import type { ReactElement } from 'react';

export function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone?: 'error' | 'warning';
}): ReactElement {
  return (
    <div className={`stat-card${tone ? ` stat-card-${tone}` : ''}`}>
      <p className="stat-card-value">{value}</p>
      <p className="stat-card-label">{label}</p>
    </div>
  );
}
