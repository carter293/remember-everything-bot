import { generateText, Output, type ModelMessage } from 'ai';
import { z } from 'zod';
import { chatModel, QUIZ_OPENER } from './agent.js';
import { nextInterval } from './cadence.js';
import { addDays, londonToday } from './london.js';
import * as repo from './repo.js';
import type { Topic } from './schema.js';

export type CloseReason = 'done' | 'idle' | 'switch';

export type ClosedSession = {
  topic: Topic;
  score: number;
  scoringNote: string;
  interval: number;
  nextDueOn: string;
};

const reviewSchema = z.object({
  score: z.int().min(0).max(5),
  scoring_note: z.string().describe('One or two sentences justifying the score'),
  covered: z.array(z.string()).describe('Points the user recalled correctly'),
  missed: z.array(z.string()).describe('Points the user got wrong, could not recall, or were not reached'),
  summary: z.string().describe('Two or three sentences on the state of the user’s knowledge'),
});

const REVIEWER_INSTRUCTIONS = `You write the durable review of one spaced-repetition quiz session.
Score the user's recall 0–5:
5 = full, fluent recall; 4 = minor gaps; 3 = core ideas correct, notable gaps;
2 = partial recall; 1 = mostly wrong; 0 = no recall or no real attempt.
Score only what the user showed, not what the tutor said.
If the session ended early (idle), score what was covered and list the rest as missed.
The next quiz on this topic reads your covered/missed lists, so make them specific.`;

function textOf(content: ModelMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
    .trim();
}

function transcriptOf(messages: ModelMessage[]): string {
  return messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => [m.role === 'user' ? 'User' : 'Tutor', textOf(m.content)] as const)
    .filter(([role, text]) => text && !(role === 'User' && text === QUIZ_OPENER))
    .map(([role, text]) => `${role}: ${text}`)
    .join('\n\n');
}

function hasUserAnswer(messages: ModelMessage[]): boolean {
  return messages.some((m) => m.role === 'user' && textOf(m.content) !== QUIZ_OPENER);
}

/**
 * Closes a session with an LLM-written review and reschedules its topic.
 * Returns null when another caller already closed it or the user never answered.
 */
export async function closeSession(sessionId: string, reason: CloseReason): Promise<ClosedSession | null> {
  const session = await repo.claimSessionForClose(sessionId);
  if (!session) return null;

  try {
    const topic = await repo.getTopic(session.topicId);
    if (!topic || !hasUserAnswer(session.messages)) {
      await repo.abandonSession(session.id);
      return null;
    }

    const previous = await repo.recentReviews(topic.id, 3);
    const transcript = transcriptOf(session.messages);
    const { output } = await generateText({
      model: chatModel(),
      instructions: REVIEWER_INSTRUCTIONS,
      prompt: `Topic: ${topic.title}
Description: ${topic.description ?? '(none)'}
Topic notes:
${topic.notes || '(none)'}

Previous review notes:
${previous.map((r) => r.notes).join('\n---\n') || '(none)'}

Session ended because: ${reason}

Transcript:
${transcript}`,
      output: Output.object({ schema: reviewSchema }),
    });

    const notes = [
      'Covered:',
      ...output.covered.map((c) => `- ${c}`),
      'Missed:',
      ...output.missed.map((m) => `- ${m}`),
      `Summary: ${output.summary}`,
    ].join('\n');
    const interval = nextInterval(topic.intervalDays, output.score);
    const nextDueOn = addDays(londonToday(), interval);

    await repo.finishSession({
      sessionId: session.id,
      topicId: topic.id,
      review: {
        score: output.score,
        scoringNote: output.scoring_note,
        notes,
        transcriptExcerpt: transcript.slice(-4000),
      },
      interval,
      nextDueOn,
    });
    console.log('[review] closed session', { sessionId, reason, score: output.score, interval });
    return { topic, score: output.score, scoringNote: output.scoring_note, interval, nextDueOn };
  } catch (err) {
    await repo.reopenSession(session.id);
    console.error('[review] failed, session reopened', { sessionId }, err);
    throw err;
  }
}

export function closedSummary(closed: ClosedSession): string {
  return `${closed.topic.title}: score ${closed.score}/5. ${closed.scoringNote}\nNext review in ${closed.interval} day${closed.interval === 1 ? '' : 's'} (${closed.nextDueOn}).`;
}
