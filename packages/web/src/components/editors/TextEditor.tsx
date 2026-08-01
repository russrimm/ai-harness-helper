import type { ReactElement } from 'react';
import type { CodeEditorProps } from '../CodeEditor.js';
import { BaseEditor } from './BaseEditor.js';

export default function TextEditor(props: CodeEditorProps): ReactElement {
  return <BaseEditor {...props} extensions={[]} />;
}
