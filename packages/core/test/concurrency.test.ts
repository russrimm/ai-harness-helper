import { describe, expect, it } from 'vitest';

import { mapConcurrent } from '../src/concurrency.js';

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
});
