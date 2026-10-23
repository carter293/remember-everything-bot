import type { ModelMessage } from 'ai';
import { z } from 'zod';

/** The quiz in progress. Messages with id > afterMessageId belong to it. */
export type ActiveQuiz = { topicId: string; afterMessageId: number };

export function parseActiveQuiz(value: string | null): ActiveQuiz | undefined {
  if (value === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    const { topicId, afterMessageId } = (parsed ?? {}) as Partial<ActiveQuiz>;
    if (typeof topicId !== 'string' || typeof afterMessageId !== 'number') return undefined;
    return { topicId, afterMessageId };
  } catch {
    return undefined;
  }
}

/** Gemini rejects a history that starts mid tool exchange, so a window always starts at a user message. */
export function trimToUserTurn(messages: ModelMessage[]): ModelMessage[] {
  const start = messages.findIndex((m) => m.role === 'user');
  return start === -1 ? [] : messages.slice(start);
}

function textOf(content: ModelMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
    .trim();
}

export function transcriptOf(messages: ModelMessage[]): string {
  return messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => [m.role === 'user' ? 'User' : 'Bot', textOf(m.content)] as const)
    .filter(([, text]) => text)
    .map(([role, text]) => `${role}: ${text}`)
    .join('\n\n');
}

export const reviewInput = z.object({
  attempted: z.boolean().describe('False when the user never genuinely tried to answer a quiz question'),
  score: z.int().min(0).max(5),
  scoring_note: z.string().describe('One or two sentences justifying the score'),
  covered: z.array(z.string()).describe('Points the user recalled correctly'),
  missed: z.array(z.string()).describe('Points the user got wrong, could not recall, or were not reached'),
  summary: z.string().describe('Two or three sentences on the state of the user’s knowledge'),
});

export function reviewNotes(r: { covered: string[]; missed: string[]; summary: string }): string {
  return [
    'Covered:',
    ...r.covered.map((c) => `- ${c}`),
    'Missed:',
    ...r.missed.map((m) => `- ${m}`),
    `Summary: ${r.summary}`,
  ].join('\n');
}

export type RecordedReview =
  | { title: string; score: number; scoringNote: string; interval: number; nextDueOn: string }
  | { title: string; skipped: true };

export function closedSummary(r: RecordedReview): string {
  if ('skipped' in r) return `${r.title}: quiz ended without a review (no attempt). It stays due.`;
  return `${r.title}: score ${r.score}/5. ${r.scoringNote}\nNext review in ${r.interval} day${r.interval === 1 ? '' : 's'} (${r.nextDueOn}).`;
}
