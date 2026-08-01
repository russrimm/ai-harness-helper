import { parse as parseJsonc, type ParseError, printParseErrorCode } from 'jsonc-parser';
import { parse as parseToml, TomlError } from 'smol-toml';
import { parse as parseYaml, YAMLParseError } from 'yaml';
import type { FileFormat } from './types.js';

/** A recoverable problem encountered while parsing a file. */
export interface ParseIssue {
  readonly message: string;
  /** 1-based line number when the parser reports a position. */
  readonly line?: number;
  /** 1-based column number when the parser reports a position. */
  readonly column?: number;
}

/**
 * The outcome of parsing a configuration file.
 *
 * Parsing is deliberately tolerant: a malformed file still yields a result so
 * the UI can show the raw text alongside a precise error, rather than hiding
 * the file entirely.
 */
export interface ParseResult {
  /** Structured value, or `undefined` when the file could not be parsed. */
  readonly value: unknown;
  /** Front matter for Markdown documents that declare it. */
  readonly frontmatter?: Record<string, unknown>;
  /** Markdown body with front matter removed. */
  readonly body?: string;
  /** Problems encountered. Empty when parsing fully succeeded. */
  readonly issues: readonly ParseIssue[];
  /** Format actually used to parse the content. */
  readonly format: FileFormat;
}

/** Maps a byte offset in `text` to a 1-based line/column pair. */
function offsetToPosition(text: string, offset: number): { line: number; column: number } {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let lastNewline = -1;
  for (let i = 0; i < clamped; i += 1) {
    if (text.charCodeAt(i) === 10) {
      line += 1;
      lastNewline = i;
    }
  }
  return { line, column: clamped - lastNewline };
}

function parseJsonLike(text: string, format: 'json' | 'jsonc'): ParseResult {
  const errors: ParseError[] = [];
  // `jsonc-parser` recovers from errors, so a file with one bad line still
  // yields a usable object plus a precise diagnostic.
  const value = parseJsonc(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });

  const issues = errors.map((error) => {
    const { line, column } = offsetToPosition(text, error.offset);
    return {
      message: `${printParseErrorCode(error.error)} at offset ${error.offset}`,
      line,
      column,
    };
  });

  return { value: issues.length > 0 && value === undefined ? undefined : value, issues, format };
}

function parseTomlText(text: string): ParseResult {
  try {
    return { value: parseToml(text), issues: [], format: 'toml' };
  } catch (error) {
    if (error instanceof TomlError) {
      const { line, column } = offsetToPosition(text, error.line ?? 0);
      return {
        value: undefined,
        issues: [
          { message: error.message, line: error.line ?? line, column: error.column ?? column },
        ],
        format: 'toml',
      };
    }
    return { value: undefined, issues: [{ message: toMessage(error) }], format: 'toml' };
  }
}

function parseYamlText(text: string, format: FileFormat = 'yaml'): ParseResult {
  try {
    return { value: parseYaml(text, { prettyErrors: true }), issues: [], format };
  } catch (error) {
    if (error instanceof YAMLParseError) {
      const pos = error.linePos?.[0];
      return {
        value: undefined,
        issues: [{ message: error.message, line: pos?.line, column: pos?.col }],
        format,
      };
    }
    return { value: undefined, issues: [{ message: toMessage(error) }], format };
  }
}

/** Matches a leading YAML front matter block delimited by `---`. */
const FRONTMATTER_PATTERN = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * Splits a Markdown document into optional YAML front matter and a body.
 *
 * Used for `.mdc` rules, `*.instructions.md`, `*.chatmode.md`, `*.prompt.md`,
 * subagent definitions, and `SKILL.md` files, all of which carry metadata in
 * front matter that the UI surfaces separately from the prose.
 */
export function parseMarkdown(text: string, format: FileFormat = 'markdown'): ParseResult {
  const match = FRONTMATTER_PATTERN.exec(text);
  if (!match || match[1] === undefined) {
    return { value: undefined, body: text, issues: [], format };
  }

  const yamlText = match[1];
  const body = text.slice(match[0].length);
  const parsed = parseYamlText(yamlText, format);

  if (parsed.value === undefined || parsed.value === null) {
    return { value: undefined, body, issues: parsed.issues, format };
  }

  if (typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    return {
      value: undefined,
      body,
      issues: [{ message: 'Front matter must be a YAML mapping.' }],
      format,
    };
  }

  const frontmatter = parsed.value as Record<string, unknown>;
  return { value: frontmatter, frontmatter, body, issues: parsed.issues, format };
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Parses file content using the declared format.
 *
 * Never throws: unparseable content is reported through `issues` so callers
 * can still display the raw text.
 */
export function parseContent(text: string, format: FileFormat): ParseResult {
  switch (format) {
    case 'json':
      return parseJsonLike(text, 'json');
    case 'jsonc':
      return parseJsonLike(text, 'jsonc');
    case 'toml':
      return parseTomlText(text);
    case 'yaml':
      return parseYamlText(text);
    case 'markdown':
    case 'md-frontmatter':
      return parseMarkdown(text, format);
    case 'text':
      return { value: text, issues: [], format };
    default: {
      const exhaustive: never = format;
      return {
        value: undefined,
        issues: [{ message: `Unsupported format: ${exhaustive}` }],
        format,
      };
    }
  }
}

/** Infers a format from a filename when a location does not declare one. */
export function inferFormat(fileName: string): FileFormat {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.jsonc') || lower.endsWith('.json5')) return 'jsonc';
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.toml')) return 'toml';
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'yaml';
  if (lower.endsWith('.mdc')) return 'md-frontmatter';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  return 'text';
}

/** CodeMirror-compatible language identifier for a format. */
export function editorLanguage(format: FileFormat): 'json' | 'yaml' | 'markdown' | 'text' {
  switch (format) {
    case 'json':
    case 'jsonc':
      return 'json';
    case 'yaml':
      return 'yaml';
    case 'markdown':
    case 'md-frontmatter':
      return 'markdown';
    case 'toml':
    case 'text':
    default:
      return 'text';
  }
}
