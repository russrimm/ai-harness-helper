/**
 * Catches errors thrown while rendering, which `useAsync` cannot see because
 * they never pass through a promise it owns.
 *
 * Without a boundary React responds to any such throw by unmounting the whole
 * tree, so the symptom is a blank white page with the explanation visible
 * only in the developer console. That is the worst possible failure for a
 * tool people reach for when something is already wrong.
 *
 * `asTransportError` is applied because the throw may be a connection failure
 * rather than a defect: React's `lazy` surfaces a failed chunk request this
 * way, so the boundary keeps reporting a stopped server correctly if the
 * views are ever code-split.
 */

import { Component } from 'react';
import type { ReactNode } from 'react';
import { asTransportError } from '../api/client.js';
import { describeError, isRetryable } from '../hooks/useAsync.js';
import { ErrorState } from './StatusStates.js';

interface Props {
  children: ReactNode;
}

interface State {
  error: unknown;
}

export class ViewErrorBoundary extends Component<Props, State> {
  override state: State = { error: undefined };

  static getDerivedStateFromError(error: unknown): State {
    return { error: asTransportError(error) };
  }

  readonly #retry = (): void => {
    this.setState({ error: undefined });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (error === undefined) return this.props.children;

    return (
      <ErrorState
        message={describeError(error)}
        {...(isRetryable(error) ? { onRetry: this.#retry } : {})}
      />
    );
  }
}
