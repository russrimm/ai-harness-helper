/**
 * Small helpers for rendering a capability in the standard skill/agent
 * Markdown shape.
 *
 * The authoritative serializer lives in the CLI process, which merges an edit
 * against the bytes on disk so front matter this build does not model survives
 * untouched. What is here is only ever used to *show* the user the structure
 * their edit produces, which is why it deliberately renders nothing it cannot
 * account for and says so instead.
 */

import type { CapabilityFields } from '../api/types.js';

/** Reserved words a bare YAML scalar must not collide with. */
const YAML_KEYWORDS = /^(y|n|yes|no|true|false|on|off|null|~)$/i;

/** Renders a string as YAML, quoting only when a bare scalar would misparse. */
export function yamlScalar(value: string): string {
  const safe =
    value.length > 0 &&
    !YAML_KEYWORDS.test(value) &&
    !/^[-?:,[\]{}#&*!|>'"%@`]/.test(value) &&
    !/[:#]\s|\s#|[\n\r\t]|^\s|\s$/.test(value) &&
    Number.isNaN(Number(value));
  if (safe) return value;
  return `'${value.replace(/'/g, "''")}'`;
}

/** Front matter in the order the published skill and agent templates use. */
export function frontmatterLines(fields: CapabilityFields): string[] {
  const lines: string[] = [];
  if (fields.name) lines.push(`name: ${yamlScalar(fields.name)}`);
  if (fields.description) lines.push(`description: ${yamlScalar(fields.description)}`);
  if (fields.model) lines.push(`model: ${yamlScalar(fields.model)}`);
  if (fields.version) lines.push(`version: ${yamlScalar(fields.version)}`);
  if (fields.tools && fields.tools.length > 0) {
    lines.push(`tools: [${fields.tools.map((tool) => yamlScalar(tool)).join(', ')}]`);
  }
  return lines;
}

/**
 * Assembles the document the form describes.
 *
 * `extraKeys` are named rather than rendered: their values were never sent to
 * the browser, so printing a guess would be worse than saying plainly that
 * they are preserved.
 */
export function previewDocument(
  fields: CapabilityFields,
  body: string,
  extraKeys: readonly string[],
): string {
  const lines = frontmatterLines(fields);
  const preserved =
    extraKeys.length > 0
      ? [`# ${extraKeys.length} further key(s) preserved unchanged: ${extraKeys.join(', ')}`]
      : [];

  if (lines.length === 0 && preserved.length === 0) return body;
  return `---\n${[...lines, ...preserved].join('\n')}\n---\n\n${body.replace(/^\n+/, '')}`;
}

/** Splits a comma or newline separated tool list into trimmed entries. */
export function parseToolList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Models offered as suggestions before anything on this machine names one.
 *
 * Suggestions only: the field stays free text, because a closed list would go
 * stale the week after it shipped and would stop someone naming a model this
 * build has never heard of.
 */
export const COMMON_MODELS: readonly string[] = [
  'claude-opus-4.5',
  'claude-sonnet-4.5',
  'claude-haiku-4.5',
  'gpt-5.1',
  'gpt-5.1-codex',
  'gpt-5-mini',
  'gemini-3-pro',
  'o4-mini',
  'inherit',
];
