import { describe, expect, it } from 'vitest';
import { addDays, londonNow, shouldSendDaily } from './london.js';

describe('londonNow', () => {
  it('reads BST as UTC+1', () => {
    expect(londonNow(new Date('2026-10-22T19:30:00Z'))).toEqual({ date: '2026-10-22', minutes: 1230 });
  });
  it('reads GMT as UTC+0 after the clocks change', () => {
    expect(londonNow(new Date('2026-10-26T20:30:00Z'))).toEqual({ date: '2026-10-26', minutes: 1230 });
  });
  it('rolls the date past UTC midnight in BST', () => {
    expect(londonNow(new Date('2026-07-01T23:30:00Z'))).toEqual({ date: '2026-07-02', minutes: 30 });
  });
});

describe('shouldSendDaily', () => {
  it('is false at 20:29 London', () => {
    expect(shouldSendDaily(new Date('2026-10-22T19:29:00Z'), null)).toBe(false);
  });
  it('is true at 20:30 London when never sent', () => {
    expect(shouldSendDaily(new Date('2026-10-22T19:30:00Z'), null)).toBe(true);
  });
  it('is false when already sent today', () => {
    expect(shouldSendDaily(new Date('2026-10-22T20:00:00Z'), '2026-10-22')).toBe(false);
  });
  it('is true when last sent yesterday', () => {
    expect(shouldSendDaily(new Date('2026-10-22T20:00:00Z'), '2026-10-21')).toBe(true);
  });
});

describe('addDays', () => {
  it('rolls over the month end', () => expect(addDays('2026-10-30', 3)).toBe('2026-11-02'));
});
