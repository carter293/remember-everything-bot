import { describe, expect, it } from 'vitest';
import { nextInterval, resolveDueOn } from './cadence.js';

describe('nextInterval', () => {
  it('steps 1 → 3 on score 4', () => expect(nextInterval(1, 4)).toBe(3));
  it('steps 3 → 7 on score 5', () => expect(nextInterval(3, 5)).toBe(7));
  it('caps at 180', () => expect(nextInterval(180, 5)).toBe(180));
  it('steps an off-ladder 10 up to 14', () => expect(nextInterval(10, 4)).toBe(14));
  it('holds 7 on score 3', () => expect(nextInterval(7, 3)).toBe(7));
  it('resets 30 → 1 on score 2', () => expect(nextInterval(30, 2)).toBe(1));
  it('resets 30 → 1 on score 0', () => expect(nextInterval(30, 0)).toBe(1));
});

describe('resolveDueOn', () => {
  it('uses an explicit date', () => expect(resolveDueOn({ nextDueOn: '2026-11-05' }, '2026-10-22')).toBe('2026-11-05'));
  it('counts days from London today', () => expect(resolveDueOn({ dueInDays: 30 }, '2026-10-22')).toBe('2026-11-21'));
  it('treats 0 days as today', () => expect(resolveDueOn({ dueInDays: 0 }, '2026-10-22')).toBe('2026-10-22'));
  it('returns undefined when not rescheduling', () => expect(resolveDueOn({}, '2026-10-22')).toBeUndefined());
  it('rejects both inputs', () =>
    expect(() => resolveDueOn({ nextDueOn: '2026-11-05', dueInDays: 3 }, '2026-10-22')).toThrow(
      'Give next_due_on or due_in_days, not both',
    ));
});
