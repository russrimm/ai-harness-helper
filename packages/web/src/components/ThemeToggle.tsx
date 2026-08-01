import type { ReactElement } from 'react';
import type { ThemeState } from '../hooks/useTheme.js';

export function ThemeToggle({ theme }: { theme: ThemeState }): ReactElement {
  return (
    <div className="theme-toggle">
      <label htmlFor="theme-select">Theme</label>
      <select
        id="theme-select"
        value={theme.choice}
        onChange={(event) => {
          const value = event.target.value;
          if (value === 'light' || value === 'dark' || value === 'system') {
            theme.setChoice(value);
          }
        }}
      >
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </div>
  );
}
