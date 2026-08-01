import { lazy, Suspense } from 'react';
import type { ReactElement } from 'react';
import { LoadingState } from './StatusStates.js';

export type EditorLanguage = 'json' | 'yaml' | 'markdown' | 'text';

export interface CodeEditorProps {
  readonly value: string;
  readonly language: EditorLanguage;
  readonly readOnly: boolean;
  readonly theme: 'light' | 'dark';
  readonly onChange?: (next: string) => void;
  readonly ariaLabel: string;
}

const JsonEditor = lazy(() => import('./editors/JsonEditor.js'));
const MarkdownEditor = lazy(() => import('./editors/MarkdownEditor.js'));
const TextEditor = lazy(() => import('./editors/TextEditor.js'));
const YamlEditor = lazy(() => import('./editors/YamlEditor.js'));

export function CodeEditor(props: CodeEditorProps): ReactElement {
  return (
    <Suspense fallback={<LoadingState label="Loading syntax support…" />}>
      {props.language === 'json' ? <JsonEditor {...props} /> : null}
      {props.language === 'markdown' ? <MarkdownEditor {...props} /> : null}
      {props.language === 'text' ? <TextEditor {...props} /> : null}
      {props.language === 'yaml' ? <YamlEditor {...props} /> : null}
    </Suspense>
  );
}
