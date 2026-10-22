import { timingSafeEqual } from 'node:crypto';
import { createMcpHandler } from 'mcp-handler';
import { z } from 'zod';
import { env } from './env.js';
import { londonToday } from './london.js';
import * as repo from './repo.js';
import { applyTopicUpdate, reviewSummary, topicSummary, UPDATE_TOPIC_DESCRIPTION, updateTopicInput } from './tools.js';

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });

export const mcpHandler = createMcpHandler(
  (server) => {
    server.registerTool(
      'create_topic',
      {
        title: 'Create topic',
        description:
          'Save a new piece of knowledge the user wants to remember and be quizzed on later by their spaced-repetition tutor. Search first to avoid duplicates. Put the distilled facts in `notes` as short bullets. The first quiz is scheduled for tomorrow evening.',
        inputSchema: z.object({
          title: z.string().describe('Short, specific topic name'),
          description: z.string().optional().describe('One line on what the topic covers'),
          notes: z.string().optional().describe('The knowledge to remember, as bullets'),
        }),
      },
      async (input) => {
        const existing = await repo.findTopicByTitle(input.title);
        if (existing) {
          return text({ error: 'A topic with this title exists. Use append_to_topic.', topic: topicSummary(existing) });
        }
        return text(topicSummary(await repo.createTopic(input, londonToday())));
      },
    );

    server.registerTool(
      'append_to_topic',
      {
        title: 'Append to topic',
        description: 'Add new knowledge to an existing topic as a dated note. Use search to find the topic_id.',
        inputSchema: z.object({ topic_id: z.string(), note: z.string() }),
      },
      async ({ topic_id, note }) => {
        const topic = await repo.appendTopicNote(topic_id, note, londonToday());
        return text(topic ? { ok: true, topic: topicSummary(topic) } : { error: 'Topic not found' });
      },
    );

    server.registerTool(
      'update_topic',
      {
        title: 'Update topic',
        description: UPDATE_TOPIC_DESCRIPTION,
        inputSchema: updateTopicInput,
      },
      async (input) => {
        try {
          return text(await applyTopicUpdate(input, londonToday()));
        } catch (err) {
          return text({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    );

    server.registerTool(
      'delete_topic',
      {
        title: 'Delete topic',
        description:
          'Archive a topic so it is no longer quizzed, listed or searchable. Its reviews are kept. Only call this when the user explicitly asks to delete that topic.',
        inputSchema: z.object({ topic_id: z.string() }),
      },
      async ({ topic_id }) => {
        const topic = await repo.archiveTopic(topic_id);
        return text(topic ? { ok: true, archived: topicSummary(topic) } : { error: 'Topic not found or already archived' });
      },
    );

    server.registerTool(
      'search',
      {
        title: 'Search topics and reviews',
        description: "Keyword search across the user's saved topics (titles, descriptions, notes) and their past quiz reviews.",
        inputSchema: z.object({ query: z.string() }),
      },
      async ({ query }) => text((await repo.searchTopics(query)).map(topicSummary)),
    );

    server.registerTool(
      'get_topic',
      {
        title: 'Get topic',
        description: 'Get one topic with its full notes, schedule, and its 5 most recent quiz reviews (scores and what was missed).',
        inputSchema: z.object({ topic_id: z.string() }),
      },
      async ({ topic_id }) => {
        const topic = await repo.getTopic(topic_id);
        if (!topic) return text({ error: 'Topic not found' });
        const reviews = await repo.recentReviews(topic_id, 5);
        return text({ ...topicSummary(topic), notes: topic.notes, reviews: reviews.map(reviewSummary) });
      },
    );
  },
  { serverInfo: { name: 'memory-tutor', version: '0.1.0' } },
);

function tokenMatches(candidate: string | undefined): boolean {
  if (!candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(env.MCP_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Accepts the token from the URL path, `Authorization: Bearer`, or `x-api-key`. */
export function mcpAuthorized(req: Request, pathToken?: string): boolean {
  const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  return [pathToken, bearer, req.headers.get('x-api-key') ?? undefined].some(tokenMatches);
}
