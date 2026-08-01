import CodeMirror, { type Extension } from '@uiw/react-codemirror';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { yaml } from '@codemirror/lang-yaml';
import { EditorView } from '@codemirror/view';
import type { ReactElement } from 'react';

export type EditorLanguage = 'json' | 'yaml' | 'markdown' | 'text';

function extensionsFor(language: EditorLanguage): Extension[] {
  switch (language) {
    case 'json':
      return [json()];
    case 'yaml':
      return [yaml()];
    case 'markdown':
      return [markdown()];
    case 'text':
      return [];
  }
}

export function CodeEditor({
  value,
  language,
  readOnly,
  theme,
  onChange,
  ariaLabel,
}: {
  value: string;
  language: EditorLanguage;
  readOnly: boolean;
  theme: 'light' | 'dark';
  onChange?: (next: string) => void;
  ariaLabel: string;
}): ReactElement {
  return (
    <div role="group" aria-label={ariaLabel}>
      <CodeMirror
        value={value}
        theme={theme}
        readOnly={readOnly}
        editable={!readOnly}
        height="60vh"
        extensions={[...extensionsFor(language), EditorView.lineWrapping]}
        onChange={onChange}
        basicSetup={{ foldGutter: true, highlightActiveLine: !readOnly }}
      />
    </div>
  );
}
