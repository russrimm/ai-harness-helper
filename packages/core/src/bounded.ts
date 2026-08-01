/** Runs asynchronous tasks without exceeding the requested concurrency. */
export async function runBounded(
  tasks: readonly (() => Promise<void>)[],
  concurrency: number,
  signal?: AbortSignal,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      signal?.throwIfAborted();
      const task = tasks[next];
      next += 1;
      await task?.();
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), tasks.length) }, async () => worker()),
  );
  signal?.throwIfAborted();
}
