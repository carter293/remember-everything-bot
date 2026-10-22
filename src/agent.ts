import { google, type GoogleLanguageModelOptions } from '@ai-sdk/google';
import { generateText, stepCountIs, type ModelMessage, type UserModelMessage } from 'ai';
import { env } from './env.js';
import { londonToday } from './london.js';
import { appendMessages } from './repo.js';
import type { Review, Session, Topic } from './schema.js';
import { dbTools } from './tools.js';

/** Synthetic first user message of every quiz session. The review writer ignores it. */
export const QUIZ_OPENER = 'Start the quiz.';

export const chatModel = () => google(env.GEMINI_MODEL);

const providerOptions = {
  google: { thinkingConfig: { thinkingLevel: 'low' } } satisfies GoogleLanguageModelOptions,
};

function tutorInstructions(topic: Topic, reviews: Review[], today: string): string {
  const past = reviews.length
    ? reviews.map((r) => `Review ${r.reviewedAt.toISOString().slice(0, 10)} (score ${r.score}/5):\n${r.notes}`).join('\n\n')
    : 'No past reviews. This is the first quiz on this topic.';
  return `You are a tutor quizzing the user on ONE topic. Today is ${today}.

Rules:
- Ask one question at a time.
- Start from the gaps in the "Missed" items of past reviews, if any.
- Prefer recall questions over recognition (no multiple choice unless the user asks).
- After each answer, give brief corrective feedback, then ask the next question.
- Use google_search only to check a fact or go deeper when the user asks.
- If the user teaches you something new about the topic, call append_to_topic with topic_id ${topic.id}.
- Keep each message under about 120 words. Plain text only, no Markdown.
- The user ends the session with /done. Do not end it yourself.

Topic: ${topic.title}
Description: ${topic.description ?? '(none)'}
Notes:
${topic.notes || '(none)'}

Past reviews:
${past}`;
}

const LIBRARIAN_INSTRUCTIONS = `You are the user's knowledge librarian for a spaced-repetition tutor.
No quiz session is open. You can:
- Save new knowledge as a topic (search first; append to an existing topic instead of duplicating).
- Append notes to a topic, search topics, list what is due, and delete (archive) a topic the user asks to remove.
- Rename a topic or reschedule its next quiz with update_topic (e.g. "quiz me on X tomorrow" → due_in_days 1).
- Use google_search to check or enrich facts before saving them.
Reply briefly in plain text, no Markdown. Say what you saved or found.
To start a quiz, the user taps a topic in the daily list or sends /due.`;

function replyText(text: string, finishReason: string, area: string): string {
  if (text.trim()) return text;
  console.error(`[agent] empty ${area} reply`, { finishReason });
  return '(no reply — try again)';
}

async function runQuiz(session: Session, topic: Topic, reviews: Review[], userText: string): Promise<string> {
  const today = londonToday();
  const userMessage: UserModelMessage = { role: 'user', content: userText };
  const tools = dbTools({ todayLondon: today });
  const result = await generateText({
    model: chatModel(),
    instructions: tutorInstructions(topic, reviews, today),
    messages: [...session.messages, userMessage],
    tools: {
      google_search: google.tools.googleSearch({}),
      append_to_topic: tools.append_to_topic,
      get_topic: tools.get_topic,
      search_topics: tools.search_topics,
    },
    stopWhen: stepCountIs(8),
    providerOptions,
  });
  const persisted: ModelMessage[] = [userMessage, ...result.responseMessages];
  await appendMessages(session.id, persisted);
  return replyText(result.text, result.finishReason, 'quiz');
}

export function quizOpen(session: Session, topic: Topic, reviews: Review[]): Promise<string> {
  return runQuiz(session, topic, reviews, QUIZ_OPENER);
}

export function quizTurn(session: Session, topic: Topic, reviews: Review[], userText: string): Promise<string> {
  return runQuiz(session, topic, reviews, userText);
}

export async function librarianTurn(userText: string): Promise<string> {
  const today = londonToday();
  const result = await generateText({
    model: chatModel(),
    instructions: `${LIBRARIAN_INSTRUCTIONS}\nToday is ${today}.`,
    prompt: userText,
    tools: { google_search: google.tools.googleSearch({}), ...dbTools({ todayLondon: today }) },
    stopWhen: stepCountIs(6),
    providerOptions,
  });
  return replyText(result.text, result.finishReason, 'librarian');
}
