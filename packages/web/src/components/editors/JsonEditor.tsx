import { json } from '@codemirror/lang-json';
import type { ReactElement } from 'react';
import type { CodeEditorProps } from '../CodeEditor.js';
import { BaseEditor } from './BaseEditor.js';

const EXTENSIONS = [json()];

export default function JsonEditor(props: CodeEditorProps): ReactElement {
  return <BaseEditor {...props} extensions={EXTENSIONS} />;
}
