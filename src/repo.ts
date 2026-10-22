import type { ModelMessage } from 'ai';
import { and, asc, desc, eq, exists, ilike, lt, lte, or, sql } from 'drizzle-orm';
import { db } from './db.js';
import { appState, reviews, sessions, topics, type Review, type Session, type Topic } from './schema.js';
import { addDays } from './london.js';

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

/** Soft delete. Also abandons an open quiz on the topic so it is never reviewed. */
export async function archiveTopic(id: string): Promise<Topic | undefined> {
  const [[topic]] = await db.batch([
    db
      .update(topics)
      .set({ status: 'archived', archivedAt: sql`now()` })
      .where(and(eq(topics.id, id), isActive))
      .returning(),
    db
      .update(sessions)
      .set({ status: 'abandoned', closedAt: sql`now()` })
      .where(and(eq(sessions.topicId, id), eq(sessions.status, 'open'))),
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

// Sessions

export async function getOpenSession(): Promise<Session | undefined> {
  const [session] = await db.select().from(sessions).where(eq(sessions.status, 'open'));
  return session;
}

export async function getSession(id: string): Promise<Session | undefined> {
  const [session] = await db.select().from(sessions).where(eq(sessions.id, id));
  return session;
}

/** Throws a unique violation on `sessions_one_open` if another session is open or closing. */
export async function openSession(topicId: string): Promise<Session> {
  const [session] = await db.insert(sessions).values({ topicId }).returning();
  return session;
}

export async function appendMessages(sessionId: string, messages: ModelMessage[]): Promise<void> {
  await db
    .update(sessions)
    .set({
      messages: sql`${sessions.messages} || ${JSON.stringify(messages)}::jsonb`,
      lastActivityAt: sql`now()`,
    })
    .where(eq(sessions.id, sessionId));
}

/** Moves an open session to `closing`. Returns undefined if another caller already claimed it. */
export async function claimSessionForClose(id: string): Promise<Session | undefined> {
  const [session] = await db
    .update(sessions)
    .set({ status: 'closing' })
    .where(and(eq(sessions.id, id), eq(sessions.status, 'open')))
    .returning();
  return session;
}

export async function reopenSession(id: string): Promise<void> {
  await db
    .update(sessions)
    .set({ status: 'open' })
    .where(and(eq(sessions.id, id), eq(sessions.status, 'closing')));
}

export async function abandonSession(id: string): Promise<void> {
  await db.update(sessions).set({ status: 'abandoned', closedAt: sql`now()` }).where(eq(sessions.id, id));
}

export async function finishSession(input: {
  sessionId: string;
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
    db
      .update(sessions)
      .set({ status: 'closed', closedAt: sql`now()`, reviewId })
      .where(eq(sessions.id, input.sessionId)),
  ]);
  return reviewId;
}

export function staleOpenSessions(olderThanMinutes = 60): Promise<Session[]> {
  return db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.status, 'open'),
        lt(sessions.lastActivityAt, sql`now() - make_interval(mins => ${olderThanMinutes})`),
      ),
    );
}

export function isIdle(session: Session, now = new Date(), minutes = 60): boolean {
  return now.getTime() - session.lastActivityAt.getTime() > minutes * 60_000;
}

// App state

export async function getState(key: string): Promise<string | null> {
  const [row] = await db.select().from(appState).where(eq(appState.key, key));
  return row?.value ?? null;
}

export async function setState(key: string, value: string): Promise<void> {
  await db.insert(appState).values({ key, value }).onConflictDoUpdate({ target: appState.key, set: { value } });
}
