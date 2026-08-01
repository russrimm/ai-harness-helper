import { describe, expect, it } from 'vitest';
import { runBounded } from '../src/bounded.js';

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

describe('runBounded', () => {
  it('never exceeds the configured concurrency under load', async () => {
    let active = 0;
    let maximum = 0;
    const tasks = Array.from({ length: 40 }, () => async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await delay(2);
      active -= 1;
    });

    await runBounded(tasks, 3);

    expect(maximum).toBe(3);
    expect(active).toBe(0);
  });

  it('stops starting queued work after cancellation', async () => {
    const controller = new AbortController();
    let started = 0;
    const tasks = Array.from({ length: 40 }, () => async () => {
      started += 1;
      if (started === 2) controller.abort();
      await delay(2);
    });

    await expect(runBounded(tasks, 2, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(started).toBe(2);
  });
});
