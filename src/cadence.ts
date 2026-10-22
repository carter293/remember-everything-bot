import { addDays } from './london.js';

export const LADDER = [1, 3, 7, 14, 30, 90, 180] as const;

const MAX_INTERVAL = LADDER[LADDER.length - 1];

/** Next review interval in days from the current interval and a 0–5 recall score. */
export function nextInterval(currentDays: number, score: number): number {
  if (score <= 2) return 1;
  if (score === 3) return Math.max(currentDays, 1);
  return LADDER.find((days) => days > currentDays) ?? MAX_INTERVAL;
}

/**
 * Manual reschedule target as a London date. Returns undefined when no reschedule was asked for.
 * Only the due date moves; the interval still comes from the next quiz score.
 */
export function resolveDueOn(
  input: { nextDueOn?: string; dueInDays?: number },
  todayLondon: string,
): string | undefined {
  if (input.nextDueOn !== undefined && input.dueInDays !== undefined) {
    throw new Error('Give next_due_on or due_in_days, not both');
  }
  if (input.nextDueOn !== undefined) return input.nextDueOn;
  if (input.dueInDays !== undefined) return addDays(todayLondon, input.dueInDays);
  return undefined;
}
