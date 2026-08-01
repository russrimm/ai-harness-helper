import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';

export class FileTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`File exceeds the ${limit} byte read limit.`);
    this.name = 'FileTooLargeError';
  }
}

export async function readRegularText(path: string, maxBytes: number): Promise<string> {
  const pathStats = await lstat(path);
  if (pathStats.isSymbolicLink() || !pathStats.isFile()) {
    throw new Error('Path is not a regular file.');
  }

  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error('Path is not a regular file.');
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
    return Buffer.concat(chunks, total).toString('utf8');
  } finally {
    await handle.close();
  }
}
