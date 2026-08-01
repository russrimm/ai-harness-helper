import { yaml } from '@codemirror/lang-yaml';
import type { ReactElement } from 'react';
import type { CodeEditorProps } from '../CodeEditor.js';
import { BaseEditor } from './BaseEditor.js';

const EXTENSIONS = [yaml()];

export default function YamlEditor(props: CodeEditorProps): ReactElement {
  return <BaseEditor {...props} extensions={EXTENSIONS} />;
}
