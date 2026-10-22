import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let repo: typeof import('./repo.js');
let db: typeof import('./db.js').db;
let schema: typeof import('./schema.js');
const createdTopicIds: string[] = [];

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
});

afterAll(async () => {
  const { inArray } = await import('drizzle-orm');
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

  it('runs a session from open to closed', async () => {
    const topic = await newTopic(`test-session-${Date.now()}`);
    const session = await repo.openSession(topic.id);
    await expect(repo.openSession(topic.id)).rejects.toThrow();

    await repo.appendMessages(session.id, [{ role: 'user', content: 'hi' }]);
    await repo.appendMessages(session.id, [{ role: 'assistant', content: [{ type: 'text', text: 'Q1?' }] }]);
    const open = await repo.getOpenSession();
    expect(open?.messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'Q1?' }] },
    ]);

    expect(await repo.claimSessionForClose(session.id)).toBeDefined();
    expect(await repo.claimSessionForClose(session.id)).toBeUndefined();

    const reviewId = await repo.finishSession({
      sessionId: session.id,
      topicId: topic.id,
      review: { score: 4, scoringNote: 'good', notes: 'Covered:\n- x', transcriptExcerpt: 'User: hi' },
      interval: 3,
      nextDueOn: '2026-10-25',
    });
    const after = await repo.getTopic(topic.id);
    expect([after?.lastScore, after?.intervalDays, after?.nextDueOn]).toEqual([4, 3, '2026-10-25']);
    expect((await repo.getSession(session.id))?.status).toBe('closed');
    expect((await repo.recentReviews(topic.id))[0].id).toBe(reviewId);
  });

  it('archives a topic out of every read path and abandons its open session', async () => {
    const title = `test-archive-${Date.now()}`;
    const topic = await newTopic(title);
    await db.update(schema.topics).set({ nextDueOn: '2026-10-01' }).where((await import('drizzle-orm')).eq(schema.topics.id, topic.id));
    const session = await repo.openSession(topic.id);

    expect((await repo.archiveTopic(topic.id))?.status).toBe('archived');
    expect(await repo.archiveTopic(topic.id)).toBeUndefined();
    expect((await repo.getSession(session.id))?.status).toBe('abandoned');
    expect((await repo.searchTopics(title)).map((t) => t.id)).toEqual([]);
    expect((await repo.listTopics()).map((t) => t.id)).not.toContain(topic.id);
    expect((await repo.dueTopics('2026-10-22', 50)).map((t) => t.id)).not.toContain(topic.id);
    expect(await repo.findTopicByTitle(title)).toBeUndefined();
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
