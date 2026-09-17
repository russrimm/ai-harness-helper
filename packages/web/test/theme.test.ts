import { readFileSync } from 'node:fs';
import { EditorState } from '@uiw/react-codemirror';
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import { editorHighlightStyle, editorThemes } from '../src/components/editor-theme.js';

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const themes = [...css.matchAll(/--ahh-bg: ([\s\S]+?)--ahh-ring: ([^;]+);/g)].map((match) =>
  Object.fromEntries(
    [...match[0].matchAll(/--ahh-([\w-]+): ([^;]+);/g)].map((token) => [token[1], token[2]]),
  ),
);

function rgb(hex: string): number[] {
  return [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255);
}

function luminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = rgb(hex).map((value) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
  );
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

function contrast(a: string, b: string): number {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((values[0] ?? 0) + 0.05) / ((values[1] ?? 0) + 0.05);
}

describe('application palette', () => {
  it('defines matching automatic and explicit light/dark palettes', () => {
    expect(themes).toHaveLength(4);
    expect(themes[0]).toEqual(themes[2]);
    expect(themes[1]).toEqual(themes[3]);
  });

  it.each(themes)('keeps accents teal with legible links, buttons, and focus', (theme) => {
    for (const name of ['link', 'link-visited', 'focus', 'accent']) {
      const color = theme[name] ?? '';
      expect(color).toMatch(/^#[\da-f]{6}$/i);
      const [r = 0, g = 0, b = 0] = rgb(color);
      expect(g).toBeGreaterThan(r);
      expect(g).toBeGreaterThanOrEqual(b);
    }
    expect(contrast(theme['accent'] ?? '', theme['accent-fg'] ?? '')).toBeGreaterThanOrEqual(4.5);
    for (const surface of ['bg', 'bg-raised', 'bg-sunken']) {
      for (const text of ['link', 'link-visited']) {
        expect(contrast(theme[text] ?? '', theme[surface] ?? '')).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(theme['focus'] ?? '', theme[surface] ?? '')).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('editor palette', () => {
  it.each(['light', 'dark'] as const)('uses the %s editor mode', (mode) => {
    const state = EditorState.create({ extensions: editorThemes[mode] });
    expect(state.facet(EditorView.darkTheme)).toBe(mode === 'dark');
  });

  it('uses readable app tokens instead of the default purple syntax colors', () => {
    for (const spec of editorHighlightStyle.specs) {
      if (typeof spec.color !== 'string') continue;
      expect(spec.color).toMatch(/^var\(--ahh-[\w-]+\)$/);
      const token = spec.color.slice(10, -1);
      for (const theme of themes) {
        expect(contrast(theme[token] ?? '', theme['bg-raised'] ?? '')).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
