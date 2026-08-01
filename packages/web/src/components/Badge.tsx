/**
 * A labelled status pill. Every variant pairs a color with a distinct icon
 * glyph and always renders its text, so status is never conveyed by color
 * alone.
 */

import type { ReactElement, ReactNode } from 'react';

export type BadgeVariant =
  | 'managed'
  | 'user'
  | 'project'
  | 'info'
  | 'warning'
  | 'error'
  | 'ok'
  | 'conflict'
  | 'duplicate'
  | 'disabled'
  | 'neutral';

const ICONS: Record<BadgeVariant, string> = {
  managed: '\u25B2', // ▲
  user: '\u25CF', // ●
  project: '\u25A0', // ■
  info: '\u2139', // ℹ
  warning: '\u26A0', // ⚠
  error: '\u2715', // ✕
  ok: '\u2713', // ✓
  conflict: '\u2715', // ✕
  duplicate: '\u29C9', // ⧉
  disabled: '\u23F8', // ⏸
  neutral: '\u2022', // •
};

export function Badge({
  variant,
  children,
}: {
  variant: BadgeVariant;
  children: ReactNode;
}): ReactElement {
  return (
    <span className={`badge badge-${variant}`}>
      <span aria-hidden="true">{ICONS[variant]}</span> {children}
    </span>
  );
}

export function scopeVariant(scope: 'managed' | 'user' | 'project'): BadgeVariant {
  return scope;
}
