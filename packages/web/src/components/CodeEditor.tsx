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
  height = '60vh',
}: {
  value: string;
  language: EditorLanguage;
  readOnly: boolean;
  theme: 'light' | 'dark';
  onChange?: (next: string) => void;
  ariaLabel: string;
  /**
   * Editor height. The default suits a whole config file; a caller showing a
   * short excerpt can shrink it so the page is not mostly blank gutter.
   */
  height?: string;
}): ReactElement {
  return (
    <div role="group" aria-label={ariaLabel}>
      <CodeMirror
        value={value}
        theme={theme}
        readOnly={readOnly}
        editable={!readOnly}
        height={height}
        extensions={[...extensionsFor(language), EditorView.lineWrapping]}
        onChange={onChange}
        basicSetup={{ foldGutter: true, highlightActiveLine: !readOnly }}
      />
    </div>
  );
}
