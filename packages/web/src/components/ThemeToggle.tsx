import type { ReactElement, ReactNode } from 'react';
import type { ThemeChoice, ThemeState } from '../hooks/useTheme.js';

/**
 * Light / System / Dark as a segmented control.
 *
 * A `<select>` hid two of the three options behind a click and made the
 * current mode readable only after opening it. Three buttons keep every
 * option on screen and state the active one through `aria-pressed`.
 *
 * Each button is icon-only, so every one carries both a `title` and a
 * visually hidden name — the glyph alone would be unlabelled.
 */
const OPTIONS: Array<{ choice: ThemeChoice; label: string; icon: ReactNode }> = [
  {
    choice: 'light',
    label: 'Light',
    icon: (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
      </>
    ),
  },
  {
    choice: 'system',
    label: 'System',
    icon: (
      <>
        <rect x="2" y="4" width="20" height="13" rx="2" />
        <path d="M8 21h8m-4-4v4" />
      </>
    ),
  },
  {
    choice: 'dark',
    label: 'Dark',
    icon: <path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79Z" />,
  },
];

export function ThemeToggle({ theme }: { theme: ThemeState }): ReactElement {
  return (
    <div className="theme-toggle" role="group" aria-label="Colour theme">
      {OPTIONS.map((option) => (
        <button
          key={option.choice}
          type="button"
          aria-pressed={theme.choice === option.choice}
          title={`${option.label} theme`}
          onClick={() => theme.setChoice(option.choice)}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            {option.icon}
          </svg>
          <span className="visually-hidden">{option.label} theme</span>
        </button>
      ))}
    </div>
  );
}
