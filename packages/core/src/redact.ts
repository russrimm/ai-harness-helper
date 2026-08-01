/**
 * Secret detection and redaction.
 *
 * Harness configuration routinely embeds live credentials — MCP `env` blocks
 * are the worst offender. The UI therefore renders redacted values by default
 * and reveals an individual value only on explicit user action.
 *
 * Detection is deliberately conservative in the direction that matters: it is
 * better to redact a harmless value than to leak a live token. Two independent
 * signals are used, and either is sufficient:
 *
 *   1. the *key* looks like a credential holder (`apiKey`, `GITHUB_TOKEN`)
 *   2. the *value* matches a known credential shape (`ghp_…`, `sk-…`, a JWT)
 */

/** Key names whose values are always masked, compared case-insensitively. */
const SECRET_KEY_SUBSTRINGS = [
  'apikey',
  'api_key',
  'accesskey',
  'access_key',
  'authorization',
  'auth_token',
  'authtoken',
  'client_secret',
  'clientsecret',
  'connectionstring',
  'connection_string',
  'credential',
  'passphrase',
  'password',
  'private_key',
  'privatekey',
  'refresh_token',
  'secret',
  'session_key',
  'signing_key',
  'subscription_key',
  'token',
  'pwd',
];

/**
 * Keys that contain a secret-ish substring but are safe configuration flags.
 * Without these, useful settings would be hidden for no benefit.
 */
const SECRET_KEY_ALLOWLIST = [
  'tokenizer',
  'token_limit',
  'tokenlimit',
  'max_tokens',
  'maxtokens',
  'token_count',
  'tokencount',
  'input_tokens',
  'output_tokens',
  'tokens_used',
  'password_policy',
  'secretsmanager',
  'token_budget',
  'authorization_endpoint',
  'token_endpoint',
  'token_url',
];

/**
 * Value shapes that identify a credential regardless of the key name.
 *
 * Order matters: more specific prefixes must precede broader ones, otherwise
 * a general pattern claims a value and mislabels its detector. The redaction
 * outcome is the same either way, but the label is shown to the user.
 */
const SECRET_VALUE_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'GitHub fine-grained token', pattern: /^github_pat_[A-Za-z0-9_]{20,}$/ },
  { name: 'GitHub personal access token', pattern: /^gh[pousr]_[A-Za-z0-9]{16,}$/ },
  { name: 'Anthropic API key', pattern: /^sk-ant-[A-Za-z0-9_-]{16,}$/ },
  { name: 'Stripe key', pattern: /^(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}$/ },
  { name: 'OpenAI API key', pattern: /^sk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}$/ },
  { name: 'Google API key', pattern: /^AIza[A-Za-z0-9_-]{35}$/ },
  { name: 'AWS access key id', pattern: /^(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}$/ },
  { name: 'Slack token', pattern: /^xox[abposr]-[A-Za-z0-9-]{10,}$/ },
  { name: 'Azure DevOps PAT', pattern: /^[a-z2-7]{52}$/ },
  {
    name: 'JSON Web Token',
    pattern: /^ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}$/,
  },
  { name: 'Private key block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'Bearer credential', pattern: /^Bearer\s+[A-Za-z0-9._~+/-]{20,}=*$/i },
  { name: 'Credentialed URL', pattern: /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i },
];

/** Why a value was redacted, surfaced in the UI as a chip label. */
export type RedactionReason = 'key-name' | 'value-shape';

/** A single masked value within a parsed document. */
export interface RedactionRecord {
  /** JSON-pointer-like path, e.g. `mcpServers.github.env.GITHUB_TOKEN`. */
  readonly path: string;
  /** Stable identifier the client passes back to reveal this value. */
  readonly id: string;
  /** What triggered the redaction. */
  readonly reason: RedactionReason;
  /** Human-readable detector name for `value-shape` redactions. */
  readonly detector?: string;
  /** Character length of the original value, useful context when masked. */
  readonly length: number;
}

/** A parsed document with secrets replaced by placeholders. */
export interface RedactionResult<T = unknown> {
  /** The document with every detected secret replaced by a mask. */
  readonly value: T;
  /** One record per masked value. */
  readonly redactions: readonly RedactionRecord[];
}

/** Placeholder substituted for a masked value. */
export const REDACTED_PLACEHOLDER = '••••••••';

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[\s-]/g, '_');
}

/** True when a key name alone justifies masking its value. */
export function isSecretKey(key: string): boolean {
  const normalized = normalizeKey(key);
  const collapsed = normalized.replace(/_/g, '');

  if (SECRET_KEY_ALLOWLIST.some((safe) => normalized.includes(safe))) return false;

  return SECRET_KEY_SUBSTRINGS.some(
    (needle) => normalized.includes(needle) || collapsed.includes(needle.replace(/_/g, '')),
  );
}

/** Returns the detector name when a value looks like a credential. */
export function detectSecretValue(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length < 8) return undefined;
  for (const { name, pattern } of SECRET_VALUE_PATTERNS) {
    if (pattern.test(trimmed)) return name;
  }
  return undefined;
}

/**
 * Masks a value while preserving enough shape to be recognisable.
 *
 * Short values are masked entirely; longer ones keep a four-character prefix
 * so a user can tell two different keys apart without revealing either.
 */
export function maskValue(value: string): string {
  if (value.length <= 8) return REDACTED_PLACEHOLDER;
  return `${value.slice(0, 4)}${REDACTED_PLACEHOLDER}`;
}

function joinPath(parent: string, segment: string | number): string {
  if (parent === '') return String(segment);
  return typeof segment === 'number' ? `${parent}[${segment}]` : `${parent}.${segment}`;
}

/**
 * Walks a parsed document and replaces every detected secret with a mask.
 *
 * Environment-variable maps (`env`, `headers`) are treated as fully sensitive
 * because their keys are arbitrary and their values are almost always
 * credentials in this domain.
 */
export function redactValue<T>(input: T): RedactionResult<T> {
  const redactions: RedactionRecord[] = [];
  const seen = new WeakSet<object>();

  function walk(node: unknown, path: string, parentKey: string | undefined): unknown {
    if (typeof node === 'string') {
      const keyIsSecret = parentKey !== undefined && isSecretKey(parentKey);
      const detector = detectSecretValue(node);

      if (keyIsSecret || detector !== undefined) {
        redactions.push({
          path,
          id: path,
          reason: keyIsSecret ? 'key-name' : 'value-shape',
          ...(detector !== undefined ? { detector } : {}),
          length: node.length,
        });
        return maskValue(node);
      }
      return node;
    }

    if (Array.isArray(node)) {
      if (seen.has(node)) return node;
      seen.add(node);
      return node.map((item, index) => walk(item, joinPath(path, index), parentKey));
    }

    if (node !== null && typeof node === 'object') {
      if (seen.has(node)) return node;
      seen.add(node);

      const out: Record<string, unknown> = {};
      const sensitiveContainer = parentKey !== undefined && isSensitiveContainer(parentKey);

      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        const childPath = joinPath(path, key);
        if (sensitiveContainer && typeof child === 'string') {
          redactions.push({
            path: childPath,
            id: childPath,
            reason: 'key-name',
            detector: `${parentKey} block`,
            length: child.length,
          });
          out[key] = maskValue(child);
          continue;
        }
        out[key] = walk(child, childPath, key);
      }
      return out;
    }

    return node;
  }

  const value = walk(input, '', undefined) as T;
  return { value, redactions };
}

/**
 * Containers whose *every* string member is treated as sensitive, because
 * their keys are user-defined and conventionally hold credentials.
 */
function isSensitiveContainer(key: string): boolean {
  const normalized = normalizeKey(key);
  return normalized === 'env' || normalized === 'headers' || normalized === 'environment';
}

/**
 * Resolves a redaction id back to its original value in the unredacted
 * document. Returns `undefined` when the path does not exist, so a stale or
 * forged id cannot be used to walk arbitrary data.
 */
export function resolveRedactionPath(source: unknown, path: string): string | undefined {
  const segments = parsePath(path);
  let current: unknown = source;

  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return undefined;
    if (typeof segment === 'number') {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
    } else {
      current = (current as Record<string, unknown>)[segment];
    }
  }

  return typeof current === 'string' ? current : undefined;
}

/** Splits `a.b[0].c` into `['a', 'b', 0, 'c']`. */
function parsePath(path: string): Array<string | number> {
  const segments: Array<string | number> = [];
  const pattern = /([^.[\]]+)|\[(\d+)\]/g;
  for (const match of path.matchAll(pattern)) {
    if (match[2] !== undefined) segments.push(Number(match[2]));
    else if (match[1] !== undefined) segments.push(match[1]);
  }
  return segments;
}

/**
 * Redacts secrets in free-form text, used for Markdown and plain-text files
 * where there is no key/value structure to walk.
 */
export function redactText(text: string): { value: string; redactions: RedactionRecord[] } {
  const redactions: RedactionRecord[] = [];
  let index = 0;

  const value = text.replace(/[A-Za-z0-9_\-./+=:~]{16,}/g, (candidate) => {
    const detector = detectSecretValue(candidate);
    if (detector === undefined) return candidate;
    const path = `text[${index}]`;
    redactions.push({
      path,
      id: path,
      reason: 'value-shape',
      detector,
      length: candidate.length,
    });
    index += 1;
    return maskValue(candidate);
  });

  return { value, redactions };
}
