import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

export class FileTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`File exceeds the ${limit} byte read limit.`);
    this.name = 'FileTooLargeError';
  }
}

export async function readRegularFile(path: string, maxBytes: number): Promise<Buffer> {
  const resolvedPath = resolve(path);
  const canonicalPath = await realpath(resolvedPath);
  if (!samePath(resolvedPath, canonicalPath)) {
    throw new Error('Path contains a symbolic link or junction.');
  }

  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error('Path is not a regular file.');
    const [openedPath, canonicalStats] = await Promise.all([
      realpath(resolvedPath),
      stat(canonicalPath),
    ]);
    if (
      !samePath(openedPath, canonicalPath) ||
      stats.dev !== canonicalStats.dev ||
      stats.ino !== canonicalStats.ino
    ) {
      throw new Error('Path changed while it was being opened.');
    }
    if (stats.size > maxBytes) throw new FileTooLargeError(maxBytes);

    const chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1));
    let total = 0;
    while (total <= maxBytes) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw new FileTooLargeError(maxBytes);
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

export async function readRegularText(path: string, maxBytes: number): Promise<string> {
  return (await readRegularFile(path, maxBytes)).toString('utf8');
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const withoutExtendedPrefix = value
      .replace(/^\\\\\?\\UNC\\/i, '\\\\')
      .replace(/^\\\\\?\\/i, '');
    return process.platform === 'win32'
      ? withoutExtendedPrefix.toLowerCase()
      : withoutExtendedPrefix;
  };
  return normalize(left) === normalize(right);
}
