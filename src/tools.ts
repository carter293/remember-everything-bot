import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { resolveDueOn } from './cadence.js';
import type { Review, Topic } from './schema.js';
import * as repo from './repo.js';

export function topicSummary(topic: Topic) {
  return {
    id: topic.id,
    title: topic.title,
    description: topic.description,
    nextDueOn: topic.nextDueOn,
    intervalDays: topic.intervalDays,
    lastScore: topic.lastScore,
    status: topic.status,
  };
}

export function reviewSummary(review: Review) {
  return {
    reviewedAt: review.reviewedAt.toISOString().slice(0, 10),
    score: review.score,
    scoringNote: review.scoringNote,
    notes: review.notes,
  };
}

export const updateTopicInput = z.object({
  topic_id: z.string(),
  title: z.string().optional().describe('New title'),
  description: z.string().optional().describe('New one-line description'),
  next_due_on: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('Reschedule: the London date of the next quiz, YYYY-MM-DD'),
  due_in_days: z
    .int()
    .min(0)
    .max(730)
    .optional()
    .describe('Reschedule: days from today until the next quiz (0 = today). Use instead of next_due_on.'),
});

export const UPDATE_TOPIC_DESCRIPTION =
  'Rename a topic, change its description, or reschedule its next quiz (next_due_on or due_in_days). Rescheduling moves only the due date; the review interval still comes from quiz scores. Notes are append-only; use append_to_topic for those.';

/** Shared by the MCP server and the chat agent. */
export async function applyTopicUpdate(input: z.infer<typeof updateTopicInput>, todayLondon: string) {
  const nextDueOn = resolveDueOn({ nextDueOn: input.next_due_on, dueInDays: input.due_in_days }, todayLondon);
  const patch = {
    ...(input.title !== undefined && { title: input.title }),
    ...(input.description !== undefined && { description: input.description }),
    ...(nextDueOn !== undefined && { nextDueOn }),
  };
  if (Object.keys(patch).length === 0) return { error: 'Nothing to update' };
  const topic = await repo.updateTopic(input.topic_id, patch);
  return topic ? topicSummary(topic) : { error: 'Topic not found or archived' };
}

/** DB tools for the chat agent. */
export function dbTools(ctx: { todayLondon: string }) {
  return {
    search_topics: tool({
      description: 'Search saved topics by keyword across titles, descriptions, notes and past review notes.',
      inputSchema: z.object({ query: z.string().describe('A keyword or short phrase') }),
      execute: async ({ query }) => (await repo.searchTopics(query)).map(topicSummary),
    }),
    get_topic: tool({
      description: 'Get one topic with its full notes and its 3 most recent reviews.',
      inputSchema: z.object({ topic_id: z.string() }),
      execute: async ({ topic_id }) => {
        const topic = await repo.getTopic(topic_id);
        if (!topic) return { error: 'Topic not found' };
        const reviews = await repo.recentReviews(topic_id, 3);
        return { ...topicSummary(topic), notes: topic.notes, reviews: reviews.map(reviewSummary) };
      },
    }),
    create_topic: tool({
      description:
        'Save a new topic the user wants to remember and be quizzed on. Search first to avoid duplicates. Put the distilled facts in notes as short bullets.',
      inputSchema: z.object({
        title: z.string(),
        description: z.string().optional().describe('One line on what the topic covers'),
        notes: z.string().optional().describe('The knowledge to remember, as bullets'),
      }),
      execute: async (input) => {
        const existing = await repo.findTopicByTitle(input.title);
        if (existing) {
          return { error: 'A topic with this title exists. Use append_to_topic instead.', topic: topicSummary(existing) };
        }
        return topicSummary(await repo.createTopic(input, ctx.todayLondon));
      },
    }),
    append_to_topic: tool({
      description: 'Append a dated note with new knowledge to an existing topic.',
      inputSchema: z.object({ topic_id: z.string(), note: z.string() }),
      execute: async ({ topic_id, note }) => {
        const topic = await repo.appendTopicNote(topic_id, note, ctx.todayLondon);
        return topic ? { ok: true, title: topic.title } : { error: 'Topic not found' };
      },
    }),
    update_topic: tool({
      description: UPDATE_TOPIC_DESCRIPTION,
      inputSchema: updateTopicInput,
      execute: async (input) => {
        try {
          return await applyTopicUpdate(input, ctx.todayLondon);
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    }),
    delete_topic: tool({
      description:
        'Delete (archive) a topic the user no longer wants to be quizzed on. It disappears from due lists, search and listings. Only call this when the user clearly asks to delete or archive that specific topic.',
      inputSchema: z.object({ topic_id: z.string() }),
      execute: async ({ topic_id }) => {
        const topic = await repo.archiveTopic(topic_id);
        return topic ? { ok: true, archived: topic.title } : { error: 'Topic not found or already archived' };
      },
    }),
    list_due: tool({
      description: 'List topics due for review today or overdue.',
      inputSchema: z.object({}),
      execute: async () => (await repo.dueTopics(ctx.todayLondon, 20)).map(topicSummary),
    }),
  } satisfies ToolSet;
}
