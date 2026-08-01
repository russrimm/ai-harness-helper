import { markdown } from '@codemirror/lang-markdown';
import type { ReactElement } from 'react';
import type { CodeEditorProps } from '../CodeEditor.js';
import { BaseEditor } from './BaseEditor.js';

const EXTENSIONS = [markdown()];

export default function MarkdownEditor(props: CodeEditorProps): ReactElement {
  return <BaseEditor {...props} extensions={EXTENSIONS} />;
}
