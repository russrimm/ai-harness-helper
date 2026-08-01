/**
 * Structured reading and writing of capability documents.
 *
 * Agents, skills, prompts, commands, and chat modes all share one shape: a
 * YAML front-matter block of metadata followed by a Markdown body of
 * instructions. Every tool that consumes them agrees on that much, even where
 * they disagree about individual keys.
 *
 * The raw editor can already change these files, but it makes the user
 * hand-edit YAML to rename a skill or point it at a different model, which is
 * exactly the sort of edit that quietly breaks a harness when a quote or an
 * indent goes missing. This module exposes the handful of fields people
 * actually change as data, so a form can drive them.
 *
 * The hard requirement is fidelity: a tool-specific key this module has never
 * heard of must survive an edit untouched, in its original position. Anything
 * less would mean the editor silently deletes configuration it did not
 * understand.
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { parseMarkdown, type ParseIssue } from './parsers.js';
import type { FileFormat } from './types.js';

/** Front-matter fields the form editor exposes directly. */
export interface CapabilityFields {
  /** Invocation name. `name` in every dialect we support. */
  readonly name?: string;
  /** One-line summary used by tools to decide when to load the capability. */
  readonly description?: string;
  /** Model the capability requests, e.g. `claude-opus-4.5`. */
  readonly model?: string;
  /** Author-declared version string, e.g. `1.2.0`. */
  readonly version?: string;
  /** Tool allowlist. Serialized back in the style the file already used. */
  readonly tools?: readonly string[];
}

/** The editable surface of one capability file. */
export interface CapabilityDocumentBody extends CapabilityFields {
  /** Markdown after the front matter, verbatim. */
  readonly body: string;
}

/** A capability file split into structured metadata and prose. */
export interface ParsedCapabilityDocument extends CapabilityDocumentBody {
  /** True when the file actually opened with a `---` block. */
  readonly hasFrontmatter: boolean;
  /**
   * Front-matter keys this module does not model, in file order.
   *
   * Surfaced so the UI can tell the user what it is preserving but will not
   * let them edit here, rather than pretending the file holds nothing else.
   */
  readonly extraKeys: readonly string[];
  /** Front-matter parse problems. Empty when the block is well formed. */
  readonly issues: readonly ParseIssue[];
}

/** Keys this module owns. Everything else is passed through untouched. */
const MANAGED_KEYS = ['name', 'description', 'model', 'version', 'tools'] as const;

type ManagedKey = (typeof MANAGED_KEYS)[number];

/**
 * Order new keys are appended in when a file did not already declare them.
 *
 * Matches the order the published skill and subagent templates use, so a file
 * this editor creates keys in still reads like one a human wrote.
 */
const PREFERRED_KEY_ORDER: readonly ManagedKey[] = [
  'name',
  'description',
  'model',
  'version',
  'tools',
];

/** Formats that can carry a capability document. */
export function isCapabilityFormat(format: FileFormat): boolean {
  return format === 'markdown' || format === 'md-frontmatter';
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  // `version: 1.2` parses as a number, and a form field is still the right
  // place to change it, so it is presented as the text the user would type.
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function asStringList(value: unknown): readonly string[] | undefined {
  if (Array.isArray(value)) {
    return value.map((item) => asString(item)).filter((item): item is string => item !== undefined);
  }
  const single = typeof value === 'string' ? value : undefined;
  if (single === undefined) return undefined;
  return single
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Splits a capability file into fields, preserved extras, and a body.
 *
 * Never throws. A file with broken front matter still yields its body and the
 * parse issue, so the UI can explain the problem instead of rendering blank.
 */
export function parseCapabilityDocument(text: string): ParsedCapabilityDocument {
  const parsed = parseMarkdown(text, 'md-frontmatter');
  const frontmatter = parsed.frontmatter;
  const body = parsed.body ?? text;

  if (!frontmatter) {
    return {
      body,
      hasFrontmatter: false,
      extraKeys: [],
      issues: parsed.issues,
    };
  }

  const managed = new Set<string>(MANAGED_KEYS);
  const extraKeys = Object.keys(frontmatter).filter((key) => !managed.has(key));

  const name = asString(frontmatter['name']);
  const description = asString(frontmatter['description']);
  const model = asString(frontmatter['model']);
  const version = asString(frontmatter['version']);
  const tools = asStringList(frontmatter['tools']);

  return {
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(tools !== undefined ? { tools } : {}),
    body,
    hasFrontmatter: true,
    extraKeys,
    issues: parsed.issues,
  };
}

/**
 * Rebuilds a capability file from the current text plus a set of edits.
 *
 * `current` is the file exactly as it sits on disk. Merging against it — as
 * opposed to against a payload the browser sent — is what guarantees an
 * unknown key cannot be dropped, reordered, or rewritten by a client that
 * never understood it.
 *
 * A field set to an empty string is a deletion: clearing "Model" removes the
 * key rather than writing `model: ''`, which several tools read as a request
 * for a model literally named the empty string.
 */
export function applyCapabilityEdits(
  current: string,
  edits: Partial<CapabilityDocumentBody>,
): string {
  const parsed = parseMarkdown(current, 'md-frontmatter');
  const existing = parsed.frontmatter ?? {};
  const body = edits.body ?? parsed.body ?? current;

  const next: Record<string, unknown> = { ...existing };

  for (const key of MANAGED_KEYS) {
    if (!(key in edits)) continue;

    if (key === 'tools') {
      const tools = edits.tools;
      if (tools === undefined || tools.length === 0) delete next.tools;
      else next.tools = [...tools];
      continue;
    }

    const value = edits[key];
    if (value === undefined || value.trim().length === 0) delete next[key];
    else next[key] = value;
  }

  // Keys the file already had keep the position they were written in, because
  // reshuffling a file the user did not ask to reshuffle produces a diff nobody
  // can review. A newly added key is slotted in at the point template order
  // says it belongs, rather than being dumped at the end after keys this
  // module does not manage.
  const pending = PREFERRED_KEY_ORDER.filter((key) => key in next && !(key in existing));
  const ordered: Record<string, unknown> = {};

  const flushBefore = (limit: number): void => {
    while (pending.length > 0) {
      const candidate = pending[0];
      if (candidate === undefined || PREFERRED_KEY_ORDER.indexOf(candidate) >= limit) break;
      ordered[candidate] = next[candidate];
      pending.shift();
    }
  };

  for (const key of Object.keys(existing)) {
    if (!(key in next)) continue;
    const index = PREFERRED_KEY_ORDER.indexOf(key as ManagedKey);
    if (index >= 0) flushBefore(index);
    ordered[key] = next[key];
  }

  flushBefore(PREFERRED_KEY_ORDER.length);
  for (const key of Object.keys(next)) {
    if (!(key in ordered)) ordered[key] = next[key];
  }

  return composeCapabilityDocument(ordered, body);
}

/** Serializes front matter and a body into a capability file. */
export function composeCapabilityDocument(
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  const normalizedBody = body.replace(/^\uFEFF/, '');

  if (Object.keys(frontmatter).length === 0) {
    return normalizedBody;
  }

  // `lineWidth: 0` stops the emitter folding a long description across lines.
  // The wrapping is valid YAML, but it turns a one-line edit into a multi-line
  // diff and reads as corruption to anyone reviewing the change.
  const yaml = stringifyYaml(frontmatter, { lineWidth: 0 }).replace(/\n+$/, '');
  const separator = normalizedBody.startsWith('\n') ? '' : '\n';
  return `---\n${yaml}\n---\n${separator}${normalizedBody}`;
}

/**
 * Checks a front-matter block would round-trip before it is written.
 *
 * The write path already validates YAML, but only for formats declared as
 * YAML; a Markdown file's front matter would otherwise reach disk unchecked.
 */
export function validateCapabilityDocument(text: string): readonly ParseIssue[] {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match?.[1]) return [];
  try {
    const value: unknown = parseYaml(match[1]);
    if (value === null || value === undefined) return [];
    if (typeof value !== 'object' || Array.isArray(value)) {
      return [{ message: 'Front matter must be a YAML mapping.' }];
    }
    return [];
  } catch (error) {
    return [{ message: error instanceof Error ? error.message : String(error) }];
  }
}
