import { describe, expect, it, vi } from 'vitest';

import { systemClock } from './clock.js';

describe('systemClock', () => {
  it('returns the current wall-clock time in milliseconds', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-04T12:00:00.000Z'));

    try {
      expect(systemClock.nowMs()).toBe(Date.parse('2026-10-04T12:00:00.000Z'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('measures durations with a monotonic source unaffected by wall-clock changes', () => {
    const before = systemClock.monotonicMs();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2000-01-01T00:00:00.000Z'));

    try {
      expect(systemClock.monotonicMs()).toBeGreaterThanOrEqual(before);
    } finally {
      vi.useRealTimers();
    }
  });
});
