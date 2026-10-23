import type { ModelMessage } from 'ai';
import { and, asc, desc, eq, exists, gte, ilike, lte, max, or, sql } from 'drizzle-orm';
import { db } from './db.js';
import { addDays } from './london.js';
import { parseActiveQuiz, trimToUserTurn, type ActiveQuiz } from './quiz.js';
import { appState, chatMessages, reviews, topics, type Review, type Topic } from './schema.js';

const ACTIVE_QUIZ = 'active_quiz';

const isActive = eq(topics.status, 'active');

// Topics

export async function createTopic(
  input: { title: string; description?: string; notes?: string },
  todayLondon: string,
): Promise<Topic> {
  const notes = input.notes ? `[${todayLondon}] ${input.notes}` : '';
  const [topic] = await db
    .insert(topics)
    .values({ title: input.title, description: input.description, notes, nextDueOn: addDays(todayLondon, 1) })
    .returning();
  return topic;
}

export async function appendTopicNote(id: string, text: string, todayLondon: string): Promise<Topic | undefined> {
  const entry = `[${todayLondon}] ${text}`;
  const [topic] = await db
    .update(topics)
    .set({ notes: sql`CASE WHEN ${topics.notes} = '' THEN ${entry} ELSE ${topics.notes} || ${'\n\n' + entry} END` })
    .where(eq(topics.id, id))
    .returning();
  return topic;
}

export async function updateTopic(
  id: string,
  patch: { title?: string; description?: string; nextDueOn?: string },
): Promise<Topic | undefined> {
  const [topic] = await db
    .update(topics)
    .set(patch)
    .where(and(eq(topics.id, id), isActive))
    .returning();
  return topic;
}

export async function getTopic(id: string): Promise<Topic | undefined> {
  const [topic] = await db.select().from(topics).where(eq(topics.id, id));
  return topic;
}

export function listTopics(): Promise<Topic[]> {
  return db.select().from(topics).where(isActive).orderBy(asc(topics.nextDueOn), asc(topics.title));
}

export function searchTopics(query: string): Promise<Topic[]> {
  const pattern = `%${query}%`;
  return db
    .select()
    .from(topics)
    .where(
      and(
        isActive,
        or(
          ilike(topics.title, pattern),
          ilike(topics.description, pattern),
          ilike(topics.notes, pattern),
          exists(
            db
              .select({ one: sql`1` })
              .from(reviews)
              .where(and(eq(reviews.topicId, topics.id), ilike(reviews.notes, pattern))),
          ),
        ),
      ),
    )
    .limit(10);
}

export function dueTopics(todayLondon: string, limit = 3): Promise<Topic[]> {
  return db
    .select()
    .from(topics)
    .where(and(isActive, lte(topics.nextDueOn, todayLondon)))
    .orderBy(asc(topics.nextDueOn), sql`${topics.lastScore} ASC NULLS FIRST`)
    .limit(limit);
}

export async function findTopicByTitle(title: string): Promise<Topic | undefined> {
  const [topic] = await db
    .select()
    .from(topics)
    .where(and(isActive, sql`lower(${topics.title}) = lower(${title})`));
  return topic;
}

/** Soft delete. Also ends an active quiz on the topic so it is never reviewed. */
export async function archiveTopic(id: string): Promise<Topic | undefined> {
  const [[topic]] = await db.batch([
    db
      .update(topics)
      .set({ status: 'archived', archivedAt: sql`now()` })
      .where(and(eq(topics.id, id), isActive))
      .returning(),
    // CASE fixes the evaluation order: other app_state values are not JSON and would fail the cast.
    db
      .delete(appState)
      .where(sql`CASE WHEN ${appState.key} = ${ACTIVE_QUIZ} THEN (${appState.value}::jsonb->>'topicId') = ${id} ELSE false END`),
  ]);
  return topic;
}

// Reviews

export function recentReviews(topicId: string, limit = 3): Promise<Review[]> {
  return db
    .select()
    .from(reviews)
    .where(eq(reviews.topicId, topicId))
    .orderBy(desc(reviews.reviewedAt))
    .limit(limit);
}

export async function recordReview(input: {
  topicId: string;
  review: { score: number; scoringNote: string; notes: string; transcriptExcerpt: string };
  interval: number;
  nextDueOn: string;
}): Promise<string> {
  // A batch cannot feed one statement's RETURNING into the next, so the review id is generated here.
  const reviewId = crypto.randomUUID();
  await db.batch([
    db.insert(reviews).values({ id: reviewId, topicId: input.topicId, ...input.review }),
    db
      .update(topics)
      .set({
        lastReviewedAt: sql`now()`,
        lastScore: input.review.score,
        intervalDays: input.interval,
        nextDueOn: input.nextDueOn,
      })
      .where(eq(topics.id, input.topicId)),
    db.delete(appState).where(eq(appState.key, ACTIVE_QUIZ)),
  ]);
  return reviewId;
}

// Chat history

export async function appendChatMessages(messages: ModelMessage[]): Promise<void> {
  if (messages.length === 0) return;
  await db.insert(chatMessages).values(messages.map((message) => ({ message })));
}

export async function lastChatMessageId(): Promise<number> {
  const [row] = await db.select({ id: max(chatMessages.id) }).from(chatMessages);
  return row?.id ?? 0;
}

/**
 * The newest `limit` messages, reaching further back to `fromId` when given, never more than `cap`.
 * The result always starts at a user message.
 */
export async function chatHistory(opts: { limit: number; fromId?: number; cap: number }): Promise<ModelMessage[]> {
  const window = await db
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .orderBy(desc(chatMessages.id))
    .limit(opts.limit);
  const starts = [window.at(-1)?.id, opts.fromId].filter((id): id is number => id !== undefined);
  if (starts.length === 0) return [];
  const from = Math.min(...starts);
  const rows = await db
    .select({ message: chatMessages.message })
    .from(chatMessages)
    .where(gte(chatMessages.id, from))
    .orderBy(desc(chatMessages.id))
    .limit(opts.cap);
  return trimToUserTurn(rows.reverse().map((r) => r.message));
}

// Active quiz

export async function getActiveQuiz(): Promise<ActiveQuiz | undefined> {
  return parseActiveQuiz(await getState(ACTIVE_QUIZ));
}

export function setActiveQuiz(quiz: ActiveQuiz): Promise<void> {
  return setState(ACTIVE_QUIZ, JSON.stringify(quiz));
}

export async function clearActiveQuiz(): Promise<void> {
  await db.delete(appState).where(eq(appState.key, ACTIVE_QUIZ));
}

// App state

export async function getState(key: string): Promise<string | null> {
  const [row] = await db.select().from(appState).where(eq(appState.key, key));
  return row?.value ?? null;
}

export async function setState(key: string, value: string): Promise<void> {
  await db.insert(appState).values({ key, value }).onConflictDoUpdate({ target: appState.key, set: { value } });
}
