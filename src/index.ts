import { waitUntil } from '@vercel/functions';
import { Hono } from 'hono';
import { env } from './env.js';
import { mcpAuthorized, mcpHandler } from './mcp.js';
import { bot, ensureBotReady } from './telegram.js';
import { runTick } from './tick.js';

const app = new Hono();

app.get('/', (c) => c.json({ ok: true }));

// Telegram retries any update not acknowledged quickly, so the LLM work runs after the 200.
app.post('/api/telegram', async (c) => {
  if (c.req.header('x-telegram-bot-api-secret-token') !== env.TELEGRAM_WEBHOOK_SECRET) {
    return c.text('forbidden', 403);
  }
  const update = await c.req.json();
  waitUntil(
    ensureBotReady()
      .then(() => bot.handleUpdate(update))
      .catch((err) => console.error('[telegram] update failed', err)),
  );
  return c.text('ok');
});

app.on(['GET', 'POST'], '/api/tick', (c) => {
  if (c.req.header('authorization') !== `Bearer ${env.TICK_SECRET}`) {
    console.warn('[tick] rejected: bad or missing Authorization header');
    return c.text('unauthorized', 401);
  }
  waitUntil(runTick(new Date()).catch((err) => console.error('[tick] failed', err)));
  return c.text('accepted', 202);
});

app.all('/api/mcp/:token', async (c) =>
  mcpAuthorized(c.req.raw, c.req.param('token')) ? await mcpHandler(c.req.raw) : c.text('unauthorized', 401),
);
app.all('/api/mcp', async (c) => (mcpAuthorized(c.req.raw) ? await mcpHandler(c.req.raw) : c.text('unauthorized', 401)));

export default app;
