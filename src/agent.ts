import { google, type GoogleLanguageModelOptions } from '@ai-sdk/google';
import { generateText, stepCountIs, tool, type UserModelMessage } from 'ai';
import { z } from 'zod';
import { nextInterval } from './cadence.js';
import { env } from './env.js';
import { addDays, londonToday } from './london.js';
import { closedSummary, reviewInput, reviewNotes, transcriptOf, type RecordedReview } from './quiz.js';
import * as repo from './repo.js';
import type { Review, Topic } from './schema.js';
import { dbTools } from './tools.js';

export const chatModel = () => google(env.GEMINI_MODEL);

const providerOptions = {
  google: { thinkingConfig: { thinkingLevel: 'low' } } satisfies GoogleLanguageModelOptions,
};

const HISTORY_LIMIT = 40;
const HISTORY_CAP = 200;

const CHAT_INSTRUCTIONS = `You are the user's spaced-repetition tutor and knowledge librarian, chatting on Telegram.
You see the recent conversation, so follow-up questions refer to it.

Librarian:
- Save new knowledge as a topic (search first; append to an existing topic instead of duplicating).
- Append notes, search topics, list what is due, and delete (archive) a topic the user asks to remove.
- Rename a topic or reschedule its next quiz with update_topic (e.g. "quiz me on X tomorrow" → due_in_days 1).
- When the user asks for a topic's notes, call get_topic and quote the notes in full.
- Use google_search to check or enrich facts before saving them.

Quiz:
- Start a quiz only when the user asks, by calling start_quiz. One quiz runs at a time.
- During a quiz ask one question at a time, recall over recognition (no multiple choice unless asked).
- Start from the gaps in the "Missed" items of past reviews, if any.
- After each answer, give brief corrective feedback, then ask the next question.
- If the user teaches you something new about the quiz topic, call append_to_topic.
- If the user wants to end the quiz, tell them to send /done; the review is recorded then.

Recording a review (only when asked to record it): score recall 0–5:
5 = full, fluent recall; 4 = minor gaps; 3 = core ideas correct, notable gaps;
2 = partial recall; 1 = mostly wrong; 0 = no recall.
Score only what the user showed, not what you said. Set attempted to false if the user never genuinely tried to answer.
The next quiz reads your covered/missed lists, so make them specific.

Plain text only, no Markdown. Keep messages under about 120 words unless quoting notes.
The user can also send /due to see due topics and tap one to start a quiz.`;

function quizBlock(topic: Topic, reviews: Review[]): string {
  const past = reviews.length
    ? reviews.map((r) => `Review ${r.reviewedAt.toISOString().slice(0, 10)} (score ${r.score}/5):\n${r.notes}`).join('\n\n')
    : 'No past reviews. This is the first quiz on this topic.';
  return `

A quiz is in progress.
Topic: ${topic.title} (topic_id ${topic.id})
Description: ${topic.description ?? '(none)'}
Notes:
${topic.notes || '(none)'}

Past reviews:
${past}`;
}

function replyText(text: string, finishReason: string, area: string): string {
  if (text.trim()) return text;
  console.error(`[agent] empty ${area} reply`, { finishReason });
  return '(no reply — try again)';
}

/** Shared by the start_quiz tool and the Telegram topic buttons. */
export async function startQuiz(topicId: string): Promise<{ ok: true; topic: Topic } | { error: string }> {
  const topic = await repo.getTopic(topicId);
  if (!topic || topic.status === 'archived') return { error: 'Topic not found or archived' };
  const active = await repo.getActiveQuiz();
  if (active?.topicId === topic.id) return { ok: true, topic };
  if (active) {
    const current = await repo.getTopic(active.topicId);
    return { error: `Finish the current quiz on ${current?.title ?? 'another topic'} with /done first` };
  }
  await repo.setActiveQuiz({ topicId: topic.id, afterMessageId: await repo.lastChatMessageId() });
  return { ok: true, topic };
}

function quizTools(ctx: { todayLondon: string; onRecorded: (r: RecordedReview) => void }) {
  return {
    start_quiz: tool({
      description: 'Start a quiz on one topic. Only call this when the user asks to be quizzed.',
      inputSchema: z.object({ topic_id: z.string() }),
      execute: async ({ topic_id }) => {
        try {
          const started = await startQuiz(topic_id);
          return 'error' in started ? started : { ok: true, title: started.topic.title };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    }),
    record_review: tool({
      description: 'Record the review of the quiz in progress and end it.',
      inputSchema: reviewInput,
      execute: async (input) => {
        const quiz = await repo.getActiveQuiz();
        if (!quiz) return { error: 'No quiz is active' };
        const topic = await repo.getTopic(quiz.topicId);
        if (!topic) return { error: 'Topic not found' };
        if (!input.attempted) {
          await repo.clearActiveQuiz();
          ctx.onRecorded({ title: topic.title, skipped: true });
          return { ok: true, skipped: true };
        }
        const interval = nextInterval(topic.intervalDays, input.score);
        const nextDueOn = addDays(ctx.todayLondon, interval);
        const transcript = transcriptOf(
          await repo.chatHistory({ limit: 0, fromId: quiz.afterMessageId + 1, cap: HISTORY_CAP }),
        );
        await repo.recordReview({
          topicId: topic.id,
          review: {
            score: input.score,
            scoringNote: input.scoring_note,
            notes: reviewNotes(input),
            transcriptExcerpt: transcript.slice(-4000),
          },
          interval,
          nextDueOn,
        });
        console.log('[review] recorded', { topicId: topic.id, score: input.score, interval });
        ctx.onRecorded({ title: topic.title, score: input.score, scoringNote: input.scoring_note, interval, nextDueOn });
        return { ok: true, score: input.score, interval, nextDueOn };
      },
    }),
  };
}

/**
 * One turn of the single chat agent. With `forceReview`, the model must call record_review,
 * and the reply is the server-written review summary.
 */
export async function chatTurn(userText: string, opts: { forceReview?: boolean } = {}): Promise<string> {
  const today = londonToday();
  const quiz = await repo.getActiveQuiz();
  const topic = quiz ? await repo.getTopic(quiz.topicId) : undefined;
  const reviews = topic ? await repo.recentReviews(topic.id, 3) : [];
  const history = await repo.chatHistory({
    limit: HISTORY_LIMIT,
    fromId: quiz ? quiz.afterMessageId + 1 : undefined,
    cap: HISTORY_CAP,
  });

  let recorded: RecordedReview | undefined;
  const qt = quizTools({ todayLondon: today, onRecorded: (r) => (recorded = r) });
  const userMessage: UserModelMessage = { role: 'user', content: userText };
  const base = {
    model: chatModel(),
    instructions: `${CHAT_INSTRUCTIONS}\nToday is ${today}.${topic ? quizBlock(topic, reviews) : ''}`,
    messages: [...history, userMessage],
    providerOptions,
  };

  if (opts.forceReview) {
    const result = await generateText({
      ...base,
      tools: { record_review: qt.record_review },
      toolChoice: { type: 'tool', toolName: 'record_review' },
      stopWhen: stepCountIs(1),
    });
    await repo.appendChatMessages([userMessage, ...result.responseMessages]);
    if (recorded) return closedSummary(recorded);
    console.error('[agent] review not recorded', { finishReason: result.finishReason });
    return '(review not recorded — try /done again)';
  }

  const result = await generateText({
    ...base,
    tools: { google_search: google.tools.googleSearch({}), ...dbTools({ todayLondon: today }), start_quiz: qt.start_quiz },
    stopWhen: stepCountIs(8),
  });
  await repo.appendChatMessages([userMessage, ...result.responseMessages]);
  return replyText(result.text, result.finishReason, 'chat');
}
