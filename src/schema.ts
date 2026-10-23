import type { ModelMessage } from 'ai';
import { sql } from 'drizzle-orm';
import { check, date, index, integer, jsonb, pgTable, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const topicStatuses = ['active', 'archived'] as const;

// Archived topics are kept for history but excluded from every read path (due lists, search, listings).
export const topics = pgTable(
  'topics',
  {
    id: uuid().primaryKey().defaultRandom(),
    title: text().notNull(),
    description: text(),
    // Append-only, dated knowledge dump.
    notes: text().notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastReviewedAt: timestamp('last_reviewed_at', { withTimezone: true }),
    lastScore: smallint('last_score'),
    intervalDays: integer('interval_days').notNull().default(1),
    // London calendar date, so "due tomorrow" means tomorrow evening regardless of the hour it was set.
    nextDueOn: date('next_due_on', { mode: 'string' }).notNull(),
    status: text({ enum: topicStatuses }).notNull().default('active'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [
    index('topics_next_due_idx').on(t.nextDueOn),
    check('topics_status_valid', sql`${t.status} IN ('active','archived')`),
  ],
);

export const reviews = pgTable(
  'reviews',
  {
    id: uuid().primaryKey().defaultRandom(),
    topicId: uuid('topic_id')
      .notNull()
      .references(() => topics.id, { onDelete: 'cascade' }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }).notNull().defaultNow(),
    score: smallint().notNull(),
    scoringNote: text('scoring_note').notNull(),
    notes: text().notNull(),
    transcriptExcerpt: text('transcript_excerpt'),
  },
  (t) => [
    check('reviews_score_range', sql`${t.score} BETWEEN 0 AND 5`),
    index('reviews_topic_idx').on(t.topicId, t.reviewedAt.desc()),
  ],
);

export const sessionStatuses = ['open', 'closing', 'closed', 'abandoned'] as const;

// Quiz transcripts kept for history; no code reads or writes this table.
// At most one open/closing session is enforced by the `sessions_one_open` index in a custom migration.
export const sessions = pgTable(
  'sessions',
  {
    id: uuid().primaryKey().defaultRandom(),
    topicId: uuid('topic_id')
      .notNull()
      .references(() => topics.id, { onDelete: 'cascade' }),
    status: text({ enum: sessionStatuses }).notNull().default('open'),
    // AI SDK ModelMessage[] stored verbatim so Gemini thought signatures survive between turns.
    messages: jsonb().$type<ModelMessage[]>().notNull().default([]),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    reviewId: uuid('review_id').references(() => reviews.id),
  },
  (t) => [check('sessions_status_valid', sql`${t.status} IN ('open','closing','closed','abandoned')`)],
);

// AI SDK ModelMessages, one row each, stored verbatim so Gemini thought signatures survive between turns.
export const chatMessages = pgTable('chat_messages', {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  message: jsonb().$type<ModelMessage>().notNull(),
});

export const appState = pgTable('app_state', {
  key: text().primaryKey(),
  value: text().notNull(),
});

export type Topic = typeof topics.$inferSelect;
export type Review = typeof reviews.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type ChatMessage = typeof chatMessages.$inferSelect;
