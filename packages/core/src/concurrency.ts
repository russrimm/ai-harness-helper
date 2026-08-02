/**
 * Maps asynchronous work with a fixed worker count while preserving input order.
 *
 * Filesystem scans can discover hundreds of capability files. Running every read
 * at once risks exhausting file descriptors, while awaiting each read serially
 * leaves most of the available I/O concurrency unused.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError('concurrency must be a positive integer');
  }

  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index]!;
      results[index] = await work(item, index);
    }
  };

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/**
 * Maps one bounded batch at a time and yields its results in input order.
 *
 * Unlike `mapConcurrent`, completed values from earlier batches can be released
 * while later work runs. Use this for large file contents or parsed documents.
 */
export async function* mapConcurrentBatches<T, R>(
  items: readonly T[],
  concurrency: number,
  work: (item: T, index: number) => Promise<R>,
): AsyncGenerator<{ item: T; index: number; result: R }> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError('concurrency must be a positive integer');
  }

  for (let start = 0; start < items.length; start += concurrency) {
    const batch = items.slice(start, start + concurrency);
    const results = await Promise.all(batch.map((item, offset) => work(item, start + offset)));
    for (let offset = 0; offset < batch.length; offset += 1) {
      yield {
        item: batch[offset]!,
        index: start + offset,
        result: results[offset]!,
      };
    }
  }
}
