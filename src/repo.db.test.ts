import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let repo: typeof import('./repo.js');
let db: typeof import('./db.js').db;
let schema: typeof import('./schema.js');
const createdTopicIds: string[] = [];
let savedQuiz: Awaited<ReturnType<typeof import('./repo.js').getActiveQuiz>>;

beforeAll(async () => {
  for (const [key, value] of Object.entries({
    GOOGLE_GENERATIVE_AI_API_KEY: 'unused',
    TELEGRAM_BOT_TOKEN: '123:unused',
    TELEGRAM_WEBHOOK_SECRET: 'unused',
    TICK_SECRET: 'unused-tick-secret-123',
    MCP_TOKEN: 'unused-mcp-token-12345',
  })) process.env[key] ??= value;
  repo = await import('./repo.js');
  db = (await import('./db.js')).db;
  schema = await import('./schema.js');
  // These tests share prod's single active-quiz slot; restore any real quiz afterwards.
  savedQuiz = await repo.getActiveQuiz();
});

afterAll(async () => {
  const { eq, inArray } = await import('drizzle-orm');
  await db.delete(schema.appState).where(eq(schema.appState.key, 'test_plain'));
  if (savedQuiz) await repo.setActiveQuiz(savedQuiz);
  if (createdTopicIds.length) await db.delete(schema.topics).where(inArray(schema.topics.id, createdTopicIds));
});

async function newTopic(title: string) {
  const topic = await repo.createTopic({ title, notes: 'first fact' }, '2026-10-22');
  createdTopicIds.push(topic.id);
  return topic;
}

describe('repo against Neon', () => {
  it('creates a topic due the next London day with dated notes', async () => {
    const topic = await newTopic(`test-create-${Date.now()}`);
    expect(topic.nextDueOn).toBe('2026-10-23');
    expect(topic.notes).toBe('[2026-10-22] first fact');
  });

  it('appends dated notes', async () => {
    const topic = await newTopic(`test-append-${Date.now()}`);
    const updated = await repo.appendTopicNote(topic.id, 'second fact', '2026-10-24');
    expect(updated?.notes).toBe('[2026-10-22] first fact\n\n[2026-10-24] second fact');
  });

  it('rolls back the whole batch when one statement fails', async () => {
    const { eq } = await import('drizzle-orm');
    const topic = await newTopic(`test-batch-${Date.now()}`);
    const valid = { topicId: topic.id, score: 4, scoringNote: 'ok', notes: 'ok' };
    await expect(
      db.batch([db.insert(schema.reviews).values(valid), db.insert(schema.reviews).values({ ...valid, score: 9 })]),
    ).rejects.toThrow();
    const rows = await db.select().from(schema.reviews).where(eq(schema.reviews.topicId, topic.id));
    expect(rows).toEqual([]);
  });

  it('records a review atomically and clears the active quiz', async () => {
    const topic = await newTopic(`test-review-${Date.now()}`);
    await repo.setActiveQuiz({ topicId: topic.id, afterMessageId: 0 });

    const reviewId = await repo.recordReview({
      topicId: topic.id,
      review: { score: 4, scoringNote: 'good', notes: 'Covered:\n- x', transcriptExcerpt: 'User: hi' },
      interval: 3,
      nextDueOn: '2026-10-25',
    });
    const after = await repo.getTopic(topic.id);
    expect([after?.lastScore, after?.intervalDays, after?.nextDueOn]).toEqual([4, 3, '2026-10-25']);
    expect(await repo.getActiveQuiz()).toBeUndefined();
    expect((await repo.recentReviews(topic.id))[0].id).toBe(reviewId);
  });

  it('archives a topic out of every read path and ends its active quiz', async () => {
    const title = `test-archive-${Date.now()}`;
    const topic = await newTopic(title);
    await db.update(schema.topics).set({ nextDueOn: '2026-10-01' }).where((await import('drizzle-orm')).eq(schema.topics.id, topic.id));
    // A non-JSON app_state value must not break the jsonb check in archiveTopic.
    await repo.setState('test_plain', '2026-10-22');
    await repo.setActiveQuiz({ topicId: topic.id, afterMessageId: 0 });

    expect((await repo.archiveTopic(topic.id))?.status).toBe('archived');
    expect(await repo.archiveTopic(topic.id)).toBeUndefined();
    expect(await repo.getActiveQuiz()).toBeUndefined();
    expect(await repo.getState('test_plain')).toBe('2026-10-22');
    expect((await repo.searchTopics(title)).map((t) => t.id)).toEqual([]);
    expect((await repo.listTopics()).map((t) => t.id)).not.toContain(topic.id);
    expect((await repo.dueTopics('2026-10-22', 50)).map((t) => t.id)).not.toContain(topic.id);
    expect(await repo.findTopicByTitle(title)).toBeUndefined();
  });

  it('keeps an active quiz on another topic when archiving', async () => {
    const quizTopic = await newTopic(`test-keep-quiz-${Date.now()}`);
    const other = await newTopic(`test-keep-other-${Date.now()}`);
    await repo.setActiveQuiz({ topicId: quizTopic.id, afterMessageId: 0 });
    await repo.archiveTopic(other.id);
    expect(await repo.getActiveQuiz()).toEqual({ topicId: quizTopic.id, afterMessageId: 0 });
    await repo.clearActiveQuiz();
  });

  it('returns no history when the window is empty', async () => {
    expect(await repo.chatHistory({ limit: 0, cap: 200 })).toEqual([]);
  });

  it('returns chat history starting at a user turn', async () => {
    const before = await repo.lastChatMessageId();
    await repo.appendChatMessages([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: [{ type: 'text', text: 'x' }] },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'Q1?' }] },
    ]);
    expect(await repo.chatHistory({ limit: 3, cap: 200 })).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'Q1?' }] },
    ]);
    // Ids come from a sequence that deleted test rows have already advanced, so count back from the last one.
    const last = await repo.lastChatMessageId();
    expect(await repo.chatHistory({ limit: 1, fromId: last - 3, cap: 200 })).toHaveLength(4);
    expect(await repo.chatHistory({ limit: 0, fromId: last - 1, cap: 200 })).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'Q1?' }] },
    ]);
    const { gt } = await import('drizzle-orm');
    await db.delete(schema.chatMessages).where(gt(schema.chatMessages.id, before));
  });

  it('reschedules only active topics', async () => {
    const topic = await newTopic(`test-reschedule-${Date.now()}`);
    expect((await repo.updateTopic(topic.id, { nextDueOn: '2026-12-01' }))?.nextDueOn).toBe('2026-12-01');
    await repo.archiveTopic(topic.id);
    expect(await repo.updateTopic(topic.id, { nextDueOn: '2026-12-05' })).toBeUndefined();
  });

  it('round-trips app state', async () => {
    await repo.setState('test_key', 'a');
    await repo.setState('test_key', 'b');
    expect(await repo.getState('test_key')).toBe('b');
    const { eq } = await import('drizzle-orm');
    await db.delete(schema.appState).where(eq(schema.appState.key, 'test_key'));
  });
});
