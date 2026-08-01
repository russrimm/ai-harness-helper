import CodeMirror, { type Extension } from '@uiw/react-codemirror';
import { EditorView } from '@codemirror/view';
import type { ReactElement } from 'react';
import type { CodeEditorProps } from '../CodeEditor.js';

const LINE_WRAPPING = EditorView.lineWrapping;

export function BaseEditor({
  value,
  readOnly,
  theme,
  onChange,
  ariaLabel,
  extensions,
}: Omit<CodeEditorProps, 'language'> & {
  readonly extensions: readonly Extension[];
}): ReactElement {
  return (
    <div role="group" aria-label={ariaLabel}>
      <CodeMirror
        value={value}
        theme={theme}
        readOnly={readOnly}
        editable={!readOnly}
        height="60vh"
        extensions={[...extensions, LINE_WRAPPING]}
        onChange={onChange}
        basicSetup={{ foldGutter: true, highlightActiveLine: !readOnly }}
      />
    </div>
  );
}
