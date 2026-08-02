import { describe, expect, it } from 'vitest';

import { mapConcurrent, mapConcurrentBatches } from '../src/concurrency.js';

describe('mapConcurrent', () => {
  it('runs work concurrently, respects the cap, and preserves input order', async () => {
    let active = 0;
    let peak = 0;

    const result = await mapConcurrent([5, 4, 3, 2, 1], 3, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, value));
      active -= 1;
      return value * 2;
    });

    expect(peak).toBe(3);
    expect(result).toEqual([10, 8, 6, 4, 2]);
  });

  it('rejects an invalid concurrency limit', async () => {
    await expect(mapConcurrent([1], 0, async (value) => value)).rejects.toThrow(/positive integer/);
  });

  it('yields ordered batches without starting later work early', async () => {
    const started: number[] = [];
    const yielded: number[] = [];
    const iterator = mapConcurrentBatches([0, 1, 2, 3, 4], 2, async (value) => {
      started.push(value);
      return value * 2;
    });

    for await (const entry of iterator) {
      yielded.push(entry.result);
      if (yielded.length === 1) expect(started).toEqual([0, 1]);
    }

    expect(yielded).toEqual([0, 2, 4, 6, 8]);
  });
});
