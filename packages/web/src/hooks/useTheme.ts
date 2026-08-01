/**
 * Light/dark theme state.
 *
 * Defaults to the OS preference (`prefers-color-scheme`) but a manual choice
 * always wins once made, persisted in `localStorage` so it survives reloads.
 */

import { useEffect, useState } from 'react';

export type ThemeChoice = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'ahh-theme';

function readStoredChoice(): ThemeChoice {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === 'light' || stored === 'dark' ? stored : 'system';
}

function systemPrefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function resolvedTheme(choice: ThemeChoice): 'light' | 'dark' {
  if (choice === 'system') return systemPrefersDark() ? 'dark' : 'light';
  return choice;
}

export interface ThemeState {
  choice: ThemeChoice;
  resolved: 'light' | 'dark';
  setChoice: (choice: ThemeChoice) => void;
}

export function useTheme(): ThemeState {
  const [choice, setChoiceState] = useState<ThemeChoice>(readStoredChoice);
  const [resolved, setResolved] = useState<'light' | 'dark'>(() => resolvedTheme(choice));

  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
  }, [resolved]);

  useEffect(() => {
    setResolved(resolvedTheme(choice));
    if (choice !== 'system') return undefined;

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (): void => setResolved(resolvedTheme('system'));
    media.addEventListener('change', handler);
    return () => media.removeEventListener('change', handler);
  }, [choice]);

  const setChoice = (next: ThemeChoice): void => {
    setChoiceState(next);
    if (next === 'system') window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, next);
  };

  return { choice, resolved, setChoice };
}
