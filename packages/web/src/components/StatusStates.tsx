import type { ReactElement } from 'react';

/** Announced via `aria-live` so screen reader users hear when data arrives. */
export function LoadingState({ label = 'Loading…' }: { label?: string }): ReactElement {
  return (
    <p className="state-message" role="status" aria-live="polite">
      {label}
    </p>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}): ReactElement {
  return (
    <div className="state-message state-error" role="alert">
      <p>
        <strong>Something went wrong.</strong> {message}
      </p>
      {onRetry ? (
        <button type="button" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

export function EmptyState({ title, detail }: { title: string; detail?: string }): ReactElement {
  return (
    <div className="state-message state-empty">
      <p>
        <strong>{title}</strong>
      </p>
      {detail ? <p>{detail}</p> : null}
    </div>
  );
}
