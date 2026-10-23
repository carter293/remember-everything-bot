import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { closedSummary, parseActiveQuiz, reviewNotes, transcriptOf, trimToUserTurn } from './quiz.js';

const user = (text: string): ModelMessage => ({ role: 'user', content: text });
const bot = (text: string): ModelMessage => ({ role: 'assistant', content: [{ type: 'text', text }] });
const toolResult: ModelMessage = {
  role: 'tool',
  content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'get_topic', output: { type: 'json', value: {} } }],
};

describe('trimToUserTurn', () => {
  it('starts the window at the first user message', () =>
    expect(trimToUserTurn([toolResult, bot('x'), user('a'), bot('b')])).toEqual([user('a'), bot('b')]));
  it('returns nothing when there is no user message', () => expect(trimToUserTurn([bot('x')])).toEqual([]));
});

describe('parseActiveQuiz', () => {
  it('reads a stored quiz', () =>
    expect(parseActiveQuiz('{"topicId":"t1","afterMessageId":5}')).toEqual({ topicId: 't1', afterMessageId: 5 }));
  it('ignores missing or malformed values', () => {
    expect(parseActiveQuiz(null)).toBeUndefined();
    expect(parseActiveQuiz('nope')).toBeUndefined();
    expect(parseActiveQuiz('{"topicId":1}')).toBeUndefined();
    expect(parseActiveQuiz('null')).toBeUndefined();
  });
});

describe('transcriptOf', () => {
  it('keeps user and bot text only', () => expect(transcriptOf([user('hi'), bot('Q?'), toolResult])).toBe('User: hi\n\nBot: Q?'));
});

describe('reviewNotes', () => {
  it('formats covered, missed and summary', () =>
    expect(reviewNotes({ covered: ['a'], missed: ['b'], summary: 's' })).toBe('Covered:\n- a\nMissed:\n- b\nSummary: s'));
});

describe('closedSummary', () => {
  const scored = { title: 'T', score: 3, scoringNote: 'note', nextDueOn: '2026-10-23' };
  it('uses the singular for one day', () =>
    expect(closedSummary({ ...scored, interval: 1 })).toBe('T: score 3/5. note\nNext review in 1 day (2026-10-23).'));
  it('uses the plural for more days', () =>
    expect(closedSummary({ ...scored, interval: 3 })).toBe('T: score 3/5. note\nNext review in 3 days (2026-10-23).'));
  it('reports a skipped review', () =>
    expect(closedSummary({ title: 'T', skipped: true })).toBe('T: quiz ended without a review (no attempt). It stays due.'));
});
