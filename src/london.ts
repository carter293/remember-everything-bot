const DAILY_SEND_MINUTES = 20 * 60 + 30;

const formatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** London calendar date (YYYY-MM-DD) and minutes since London midnight. */
export function londonNow(now: Date): { date: string; minutes: number } {
  const parts = Object.fromEntries(formatter.formatToParts(now).map((p) => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

export function londonToday(now = new Date()): string {
  return londonNow(now).date;
}

export function shouldSendDaily(now: Date, lastSentOn: string | null): boolean {
  const { date, minutes } = londonNow(now);
  return minutes >= DAILY_SEND_MINUTES && lastSentOn !== date;
}

export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
