/**
 * The write path.
 *
 * Editing agentic configuration is genuinely dangerous: a corrupted
 * `settings.json` can silently disable a tool, and a clobbered `mcp.json` can
 * lose credentials the user has no other copy of. Every guard here is load
 * bearing, not polish:
 *
 * 1. Credential stores are refused outright.
 * 2. Content must parse in its declared format before it is written.
 * 3. The caller must present the hash it loaded, so concurrent external edits
 *    abort the write instead of being overwritten.
 * 4. A timestamped backup is taken before the file is touched.
 * 5. The replacement is written to a temp file and renamed, so a crash
 *    mid-write cannot leave a truncated config behind.
 */

import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { parseContent } from './parsers.js';
import type { FileFormat, Sensitivity } from './types.js';

/** Why a write was refused. */
export type WriteRefusalCode =
  | 'read-only'
  | 'credential-store'
  | 'invalid-content'
  | 'hash-mismatch'
  | 'not-found'
  /** The declaration the caller asked to remove is not in the file. */
  | 'not-declared'
  /** The file's format or layout cannot be edited structurally. */
  | 'unsupported-format'
  | 'write-failed';

/** A write that did not happen, and why. */
export interface WriteRefusal {
  readonly ok: false;
  readonly code: WriteRefusalCode;
  readonly message: string;
  /** Parse errors, when the content was rejected as invalid. */
  readonly issues?: readonly { message: string; line?: number; column?: number }[];
  /** The hash currently on disk, when it did not match the expected one. */
  readonly currentHash?: string;
}

/** A write that succeeded. */
export interface WriteSuccess {
  readonly ok: true;
  readonly path: string;
  /** Hash of the newly written content, for the client's next write. */
  readonly hash: string;
  /** Where the previous content was preserved. */
  readonly backupPath: string;
  readonly bytesWritten: number;
}

export type WriteOutcome = WriteSuccess | WriteRefusal;

export interface WriteRequest {
  /** Absolute path to write. Callers must have already authorized it. */
  readonly path: string;
  /** Replacement content. */
  readonly content: string;
  /** Format to validate against before writing. */
  readonly format: FileFormat;
  readonly sensitivity: Sensitivity;
  /**
   * SHA-256 the client last read. A mismatch aborts the write.
   * Pass `null` only to create a file that does not exist yet.
   */
  readonly expectedHash: string | null;
}

export interface WriterOptions {
  /** Blocks every write. Set by the CLI's `--read-only` flag. */
  readonly readOnly?: boolean;
  /** Root for backups. Defaults to `~/.ai-harness-helper/backups`. */
  readonly backupRoot?: string;
  /** Clock injection point, for deterministic tests. */
  readonly now?: () => Date;
}

/** Formats a strict parser must accept before the file is written. */
const VALIDATED_FORMATS = new Set<FileFormat>(['json', 'jsonc', 'toml', 'yaml']);

/** SHA-256 of a string, matching the scanner's file hashes. */
export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Default backup location, kept out of the scanned tree. */
export function defaultBackupRoot(home: string = homedir()): string {
  return join(home, '.ai-harness-helper', 'backups');
}

/**
 * Validates content without writing anything.
 *
 * Exposed so the UI can show a live parse error while the user types, using
 * exactly the rules the write path will apply.
 */
export function validateContent(
  content: string,
  format: FileFormat,
): { valid: true } | { valid: false; issues: readonly { message: string; line?: number }[] } {
  if (!VALIDATED_FORMATS.has(format)) return { valid: true };
  const parsed = parseContent(content, format);
  if (parsed.issues.length === 0) return { valid: true };
  return { valid: false, issues: parsed.issues };
}

/**
 * Writes a configuration file, refusing rather than risking data loss.
 *
 * Never throws for an expected condition; failures come back as a
 * {@link WriteRefusal} so the API layer can map them onto status codes.
 */
export async function writeConfigFile(
  request: WriteRequest,
  options: WriterOptions = {},
): Promise<WriteOutcome> {
  if (options.readOnly) {
    return {
      ok: false,
      code: 'read-only',
      message: 'This session is read-only. Restart without --read-only to make changes.',
    };
  }

  if (request.sensitivity === 'credential-store') {
    return {
      ok: false,
      code: 'credential-store',
      message:
        'This file exists to hold credentials and is never editable here. Use the owning tool to change it.',
    };
  }

  const validation = validateContent(request.content, request.format);
  if (!validation.valid) {
    const first = validation.issues[0];
    return {
      ok: false,
      code: 'invalid-content',
      message: `Content is not valid ${request.format.toUpperCase()}: ${
        first?.message ?? 'parse failed'
      }`,
      issues: validation.issues,
    };
  }

  let existing: string | undefined;
  let existingMode: number | undefined;
  try {
    const [content, metadata] = await Promise.all([
      readFile(request.path, 'utf8'),
      stat(request.path),
    ]);
    existing = content;
    existingMode = metadata.mode & 0o777;
  } catch (error) {
    if (!isNotFound(error)) {
      return {
        ok: false,
        code: 'write-failed',
        message: `Could not read the existing file: ${describeError(error)}`,
      };
    }
  }

  if (existing === undefined && request.expectedHash !== null) {
    return {
      ok: false,
      code: 'not-found',
      message: 'The file no longer exists. Re-scan before editing it.',
    };
  }

  if (existing !== undefined) {
    const currentHash = hashContent(existing);
    if (request.expectedHash === null) {
      return {
        ok: false,
        code: 'hash-mismatch',
        message: 'The file already exists. Load it before writing.',
        currentHash,
      };
    }
    if (currentHash !== request.expectedHash) {
      return {
        ok: false,
        code: 'hash-mismatch',
        message:
          'The file changed on disk since you loaded it. Reload to see the current contents, then reapply your edit.',
        currentHash,
      };
    }
  }

  const now = options.now?.() ?? new Date();
  const backupRoot = options.backupRoot ?? defaultBackupRoot();

  let backupPath = '';
  if (existing !== undefined) {
    try {
      backupPath = await createBackup(request.path, existing, backupRoot, now);
    } catch (error) {
      return {
        ok: false,
        code: 'write-failed',
        message: `Could not create a backup, so nothing was written: ${describeError(error)}`,
      };
    }
  }

  try {
    await atomicWrite(request.path, request.content, existingMode);
  } catch (error) {
    return {
      ok: false,
      code: 'write-failed',
      message: `Write failed: ${describeError(error)}`,
    };
  }

  return {
    ok: true,
    path: request.path,
    hash: hashContent(request.content),
    backupPath,
    bytesWritten: Buffer.byteLength(request.content, 'utf8'),
  };
}

/**
 * Copies the current contents somewhere recoverable.
 *
 * Backups are grouped by timestamp so everything written in one session sits
 * together, and the original file name is preserved so it is obvious what a
 * backup restores to.
 */
async function createBackup(
  path: string,
  content: string,
  backupRoot: string,
  now: Date,
): Promise<string> {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const directory = join(backupRoot, stamp);
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  await chmod(backupRoot, 0o700);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);

  // Two files in one batch can share a name (`settings.json` from two tools),
  // so a short path digest keeps them distinct without deep directory trees.
  // A nonce preserves both backups when one file is edited twice in a millisecond.
  const discriminator = createHash('sha256').update(path).digest('hex').slice(0, 8);
  const target = join(
    directory,
    `${discriminator}-${randomBytes(4).toString('hex')}-${basename(path)}`,
  );
  await writeFile(target, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return target;
}

/**
 * Writes via a temp file and a rename.
 *
 * A partial write to the real path would leave the tool that owns the file
 * with unparseable configuration; a rename is atomic on every platform we
 * support, so the file is either fully old or fully new.
 */
async function atomicWrite(path: string, content: string, existingMode?: number): Promise<void> {
  const nonce = randomBytes(6).toString('hex');
  const temporary = join(dirname(path), `.${basename(path)}.aihh-${process.pid}-${nonce}.tmp`);
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(temporary, content, {
      encoding: 'utf8',
      mode: existingMode ?? 0o600,
      flag: 'wx',
    });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  );
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
