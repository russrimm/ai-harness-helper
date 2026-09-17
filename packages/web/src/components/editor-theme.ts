import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';

export const editorHighlightStyle = HighlightStyle.define([
  { tag: tags.comment, color: 'var(--ahh-text-muted)', fontStyle: 'italic' },
  { tag: [tags.keyword, tags.atom, tags.bool, tags.null], color: 'var(--ahh-link)' },
  { tag: [tags.string, tags.regexp], color: 'var(--ahh-ok)' },
  { tag: [tags.number, tags.escape], color: 'var(--ahh-warning)' },
  { tag: [tags.propertyName, tags.attributeName], color: 'var(--ahh-info)' },
  { tag: tags.heading, color: 'var(--ahh-link)', fontWeight: 'bold' },
  { tag: tags.link, color: 'var(--ahh-link)', textDecoration: 'underline' },
  { tag: tags.strong, fontWeight: 'bold' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.invalid, color: 'var(--ahh-error)' },
]);

function createEditorTheme(dark: boolean) {
  return [
    EditorView.theme(
      {
        '&': { color: 'var(--ahh-text)', backgroundColor: 'var(--ahh-bg-raised)' },
        '&.cm-focused': { outline: '2px solid var(--ahh-focus)' },
        '.cm-content': { caretColor: 'var(--ahh-focus)' },
        '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--ahh-focus)' },
        '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
          backgroundColor: 'var(--ahh-ring)',
        },
        '.cm-selectionMatch': { backgroundColor: 'var(--ahh-ring)' },
        '.cm-activeLine, .cm-activeLineGutter': {
          backgroundColor: 'var(--ahh-bg-sunken)',
        },
        '.cm-gutters': {
          color: 'var(--ahh-text-muted)',
          backgroundColor: 'var(--ahh-bg-raised)',
          borderColor: 'var(--ahh-border)',
        },
        '.cm-panels, .cm-tooltip': {
          color: 'var(--ahh-text)',
          backgroundColor: 'var(--ahh-bg-raised)',
          borderColor: 'var(--ahh-border)',
        },
        '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
          color: 'var(--ahh-accent-fg)',
          backgroundColor: 'var(--ahh-accent)',
        },
      },
      { dark },
    ),
    syntaxHighlighting(editorHighlightStyle),
  ];
}

export const editorThemes = {
  light: createEditorTheme(false),
  dark: createEditorTheme(true),
};
