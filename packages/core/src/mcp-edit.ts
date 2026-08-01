/**
 * Surgical removal of a single MCP server declaration from a config file.
 *
 * Rewriting a whole file from its parsed value would be far simpler, and would
 * also silently destroy every comment, every key ordering choice, and every
 * bit of formatting the user put there — in files that frequently contain the
 * only copy of a credential. So each format is edited in place instead:
 * `jsonc-parser` computes a minimal text edit, the `yaml` document API mutates
 * a comment-preserving CST, and TOML tables are excised by line span.
 *
 * This module only produces the *new text*. Every safety guard — hash check,
 * backup, atomic write, read-only refusal — stays in `writer.ts`, so there is
 * exactly one path that touches disk.
 */

import { applyEdits, modify, type FormattingOptions } from 'jsonc-parser';
import { isMap, isSeq, parseDocument } from 'yaml';

import { MCP_CONTAINER_KEYS } from './aggregate.js';
import { parseContent } from './parsers.js';
import type { FileFormat } from './types.js';

/** Why a removal could not be performed. */
export type McpTextRemovalFailureCode = 'not-declared' | 'unsupported-format' | 'invalid-content';

export interface McpTextRemovalFailure {
  readonly ok: false;
  readonly code: McpTextRemovalFailureCode;
  readonly message: string;
}

export interface McpTextRemovalSuccess {
  readonly ok: true;
  /** The file's full new contents. */
  readonly content: string;
  /** Dotted paths the server was removed from, for the confirmation message. */
  readonly removedFrom: readonly string[];
}

export type McpTextRemovalResult = McpTextRemovalSuccess | McpTextRemovalFailure;

export interface McpTextRemovalOptions {
  /**
   * Provider that owns the file. Docker's MCP Toolkit keys servers directly
   * under `registry`, which is only safe to treat as a server map for Docker.
   */
  readonly providerId?: string;
}

/** A container that holds server declarations, and how to address it. */
interface ContainerRef {
  /** Path from the document root to the container itself. */
  readonly path: readonly (string | number)[];
  /** Human-readable form of the same path. */
  readonly label: string;
  /** Key (object form) or index (array form) of the server inside it. */
  readonly member: string | number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Position of `name` inside a container, or undefined when absent. */
function memberOf(container: unknown, name: string): string | number | undefined {
  if (Array.isArray(container)) {
    // Continue's YAML form is a list of objects that carry their own name.
    const index = container.findIndex((item) => isRecord(item) && item['name'] === name);
    return index === -1 ? undefined : index;
  }
  if (isRecord(container) && Object.prototype.hasOwnProperty.call(container, name)) return name;
  return undefined;
}

/**
 * Every place in a parsed document that declares `name`.
 *
 * Mirrors the harvesting rules in `aggregate.ts`, including Claude Code's
 * per-project maps under `projects`, so anything the MCP table can show can
 * also be removed.
 */
function findContainers(
  value: unknown,
  name: string,
  options: McpTextRemovalOptions,
): ContainerRef[] {
  if (!isRecord(value)) return [];
  const found: ContainerRef[] = [];

  const consider = (path: readonly (string | number)[], container: unknown): void => {
    const member = memberOf(container, name);
    if (member === undefined) return;
    found.push({ path, label: path.join('.'), member });
  };

  for (const key of MCP_CONTAINER_KEYS) consider([key], value[key]);
  if (options.providerId === 'docker') consider(['registry'], value['registry']);

  const projects = value['projects'];
  if (isRecord(projects)) {
    for (const [projectPath, projectValue] of Object.entries(projects)) {
      if (!isRecord(projectValue)) continue;
      for (const key of MCP_CONTAINER_KEYS) {
        consider(['projects', projectPath, key], projectValue[key]);
      }
    }
  }

  return found;
}

/** Infers indentation and line endings so the edit matches the file. */
function detectFormatting(text: string): FormattingOptions {
  const match = /\r?\n([ \t]+)\S/.exec(text);
  const indent = match?.[1] ?? '  ';
  const insertSpaces = !indent.startsWith('\t');
  return {
    tabSize: insertSpaces ? indent.length : 1,
    insertSpaces,
    eol: text.includes('\r\n') ? '\r\n' : '\n',
  };
}

function removeFromJson(
  text: string,
  name: string,
  options: McpTextRemovalOptions,
): McpTextRemovalResult {
  const formatting = detectFormatting(text);
  const removedFrom: string[] = [];
  let current = text;

  // Each edit shifts every later offset, so the document is re-parsed between
  // removals rather than batching edits computed against stale positions.
  for (let guard = 0; guard < 64; guard += 1) {
    const parsed = parseContent(current, 'jsonc');
    // A recovered parse is good enough to *read*, but not to edit: the offsets
    // `modify` computes come from a document the parser had to guess at, and a
    // wrong offset here corrupts a file the user did not even open.
    if (parsed.value === undefined || parsed.issues.length > 0) {
      return {
        ok: false,
        code: 'invalid-content',
        message: 'The file could not be parsed cleanly, so nothing was changed.',
      };
    }
    const containers = findContainers(parsed.value, name, options);
    const target = containers[0];
    if (!target) break;

    const edits = modify(current, [...target.path, target.member], undefined, {
      formattingOptions: formatting,
    });
    const next = applyEdits(current, edits);
    if (next === current) {
      return {
        ok: false,
        code: 'unsupported-format',
        message: `"${name}" could not be removed automatically. Edit ${target.label} by hand.`,
      };
    }
    current = next;
    removedFrom.push(target.label);
  }

  if (removedFrom.length === 0) {
    return { ok: false, code: 'not-declared', message: `"${name}" is not declared in this file.` };
  }
  return { ok: true, content: current, removedFrom };
}

function removeFromYaml(
  text: string,
  name: string,
  options: McpTextRemovalOptions,
): McpTextRemovalResult {
  const document = parseDocument(text, { keepSourceTokens: true });
  if (document.errors.length > 0) {
    return {
      ok: false,
      code: 'invalid-content',
      message: 'The file could not be parsed, so nothing was changed.',
    };
  }

  const containers = findContainers(document.toJS() as unknown, name, options);
  if (containers.length === 0) {
    return { ok: false, code: 'not-declared', message: `"${name}" is not declared in this file.` };
  }

  const removedFrom: string[] = [];
  for (const container of containers) {
    const node = document.getIn(container.path, true);
    if (!isMap(node) && !isSeq(node)) continue;
    if (!document.deleteIn([...container.path, container.member])) continue;
    removedFrom.push(container.label);
  }

  if (removedFrom.length === 0) {
    return {
      ok: false,
      code: 'unsupported-format',
      message: `"${name}" could not be removed automatically. Edit the file by hand.`,
    };
  }
  return { ok: true, content: document.toString(), removedFrom };
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Removes a server from a TOML file.
 *
 * `smol-toml` parses but does not edit, and re-serializing a parsed table
 * would reorder keys and drop comments. Codex — the only TOML consumer in the
 * registry — writes each server as its own `[mcp_servers.name]` table, so the
 * edit is a line-span excision of that table and any sub-tables beneath it.
 */
function removeFromToml(
  text: string,
  name: string,
  options: McpTextRemovalOptions,
): McpTextRemovalResult {
  const parsed = parseContent(text, 'toml');
  if (parsed.value === undefined) {
    return {
      ok: false,
      code: 'invalid-content',
      message: 'The file could not be parsed, so nothing was changed.',
    };
  }

  const containers = findContainers(parsed.value, name, options);
  if (containers.length === 0) {
    return { ok: false, code: 'not-declared', message: `"${name}" is not declared in this file.` };
  }

  const escapedName = escapeForRegExp(name);
  const containerKeys = MCP_CONTAINER_KEYS.map(escapeForRegExp).join('|');
  const header = new RegExp(
    `^\\s*\\[\\s*(?:${containerKeys})\\s*\\.\\s*(?:"${escapedName}"|'${escapedName}'|${escapedName})\\s*(?:\\..*)?\\]`,
  );
  const anyHeader = /^\s*\[/;
  const inlineKey = new RegExp(`^\\s*(?:"${escapedName}"|'${escapedName}'|${escapedName})\\s*=`);
  const sectionHeader = new RegExp(`^\\s*\\[\\s*(?:${containerKeys})\\s*\\]`);

  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const keep: string[] = [];
  const removedFrom: string[] = [];
  let inServerTable = false;
  let inContainerSection = false;
  let skippingInline = false;

  for (const line of lines) {
    if (header.test(line)) {
      inServerTable = true;
      inContainerSection = false;
      skippingInline = false;
      if (removedFrom.length === 0) removedFrom.push(containers[0]!.label);
      continue;
    }

    if (anyHeader.test(line)) {
      inServerTable = false;
      skippingInline = false;
      inContainerSection = sectionHeader.test(line);
      keep.push(line);
      continue;
    }

    if (inServerTable) continue;

    // `[mcp_servers]` followed by `name = { ... }`, possibly spanning lines.
    if (inContainerSection && inlineKey.test(line)) {
      skippingInline = !isBalanced(line);
      if (removedFrom.length === 0) removedFrom.push(containers[0]!.label);
      continue;
    }
    if (skippingInline) {
      if (isBalanced(line)) skippingInline = false;
      continue;
    }

    keep.push(line);
  }

  if (removedFrom.length === 0) {
    return {
      ok: false,
      code: 'unsupported-format',
      message: `"${name}" is declared in a TOML layout this tool cannot edit safely. Remove it by hand.`,
    };
  }

  const content = collapseBlankRuns(keep).join(eol);
  const verification = parseContent(content, 'toml');
  if (verification.value === undefined) {
    return {
      ok: false,
      code: 'unsupported-format',
      message: `Removing "${name}" would have left invalid TOML, so nothing was changed.`,
    };
  }
  if (findContainers(verification.value, name, options).length > 0) {
    return {
      ok: false,
      code: 'unsupported-format',
      message: `"${name}" is declared in a TOML layout this tool cannot edit safely. Remove it by hand.`,
    };
  }

  return { ok: true, content, removedFrom };
}

/** True when a line closes every brace and bracket it opens. */
function isBalanced(line: string): boolean {
  let depth = 0;
  let quote: string | undefined;
  for (const character of line) {
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === '{' || character === '[') depth += 1;
    else if (character === '}' || character === ']') depth -= 1;
  }
  return depth <= 0;
}

/** Collapses the blank-line runs an excised table leaves behind. */
function collapseBlankRuns(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (line.trim().length === 0 && out.length > 0 && out[out.length - 1]?.trim().length === 0) {
      continue;
    }
    out.push(line);
  }
  while (out.length > 1 && out[out.length - 1]?.trim().length === 0) out.pop();
  return out;
}

/**
 * Produces the contents a file would have with one MCP server removed.
 *
 * Formatting and comments outside the removed declaration are preserved. The
 * containing map is left in place even when it becomes empty, because an empty
 * `mcpServers` is valid configuration whereas a missing one changes what the
 * file says.
 */
export function removeMcpServerFromText(
  text: string,
  format: FileFormat,
  name: string,
  options: McpTextRemovalOptions = {},
): McpTextRemovalResult {
  switch (format) {
    case 'json':
    case 'jsonc':
      return removeFromJson(text, name, options);
    case 'yaml':
      return removeFromYaml(text, name, options);
    case 'toml':
      return removeFromToml(text, name, options);
    default:
      return {
        ok: false,
        code: 'unsupported-format',
        message: `${format} files cannot be edited structurally. Remove "${name}" by hand.`,
      };
  }
}

/** True when `name` is declared anywhere this module knows how to look. */
export function declaresMcpServer(
  text: string,
  format: FileFormat,
  name: string,
  options: McpTextRemovalOptions = {},
): boolean {
  const parsed = parseContent(text, format);
  if (parsed.value === undefined) return false;
  return findContainers(parsed.value, name, options).length > 0;
}
