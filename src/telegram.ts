import { Bot, InlineKeyboard, type Context } from 'grammy';
import { librarianTurn, quizOpen, quizTurn } from './agent.js';
import { env } from './env.js';
import { londonToday } from './london.js';
import * as repo from './repo.js';
import { closedSummary, closeSession } from './review-writer.js';

const MAX_MESSAGE = 4000;

export const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

let ready: Promise<void> | undefined;
/** `handleUpdate` needs botInfo, which `init` fetches once per warm instance. */
export function ensureBotReady(): Promise<void> {
  ready ??= bot.init();
  return ready;
}

const HELP = `I quiz you on what you've saved, on a spaced-repetition schedule.
• Every evening at 20:30 I send what's due. Tap a topic to start.
• /due — show what's due now
• /topics — list all topics
• /done — end the quiz and get your score
• Outside a quiz, message me to save or search knowledge.`;

export async function sendText(chatId: number, text: string, keyboard?: InlineKeyboard): Promise<void> {
  for (let i = 0; i < text.length; i += MAX_MESSAGE) {
    const chunk = text.slice(i, i + MAX_MESSAGE);
    const isLast = i + MAX_MESSAGE >= text.length;
    await bot.api.sendMessage(chatId, chunk, isLast && keyboard ? { reply_markup: keyboard } : {});
  }
}

/** Sends up to 3 due topics as buttons. Returns false when nothing is due. */
export async function sendDueList(chatId: number): Promise<boolean> {
  const due = await repo.dueTopics(londonToday(), 3);
  if (due.length === 0) return false;
  const keyboard = new InlineKeyboard();
  for (const topic of due) keyboard.text(topic.title.slice(0, 40), `q:${topic.id}`).row();
  await sendText(chatId, `📚 Due today (${due.length}):`, keyboard);
  return true;
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === '23505' || e?.cause?.code === '23505';
}

async function reply(ctx: Context, text: string): Promise<void> {
  await sendText(ctx.chat!.id, text);
}

/** Runs a handler and reports any failure to the user instead of failing silently. */
function guarded(handler: (ctx: Context) => Promise<void>) {
  return async (ctx: Context) => {
    try {
      await handler(ctx);
    } catch (err) {
      console.error('[telegram] handler failed', err);
      await reply(ctx, `⚠️ Something went wrong: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
    }
  };
}

// Single user: until TELEGRAM_CHAT_ID is set, only /start answers, to reveal the chat id.
bot.use(async (ctx, next) => {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  if (env.TELEGRAM_CHAT_ID === undefined) {
    if (ctx.message?.text?.startsWith('/start')) {
      await ctx.reply(`Your chat id: ${chatId}. Set TELEGRAM_CHAT_ID to it and redeploy.`);
    }
    return;
  }
  if (chatId !== env.TELEGRAM_CHAT_ID) return;
  await next();
});

// A session idle for over an hour is reviewed before handling anything new.
bot.use(async (ctx, next) => {
  await guarded(async (ctx) => {
    const open = await repo.getOpenSession();
    if (open && repo.isIdle(open)) {
      const closed = await closeSession(open.id, 'idle');
      if (closed) await reply(ctx, `Closed your earlier session.\n${closedSummary(closed)}`);
    }
  })(ctx);
  await next();
});

bot.command(['start', 'help'], guarded((ctx) => reply(ctx, HELP)));

bot.command(
  'due',
  guarded(async (ctx) => {
    if (!(await sendDueList(ctx.chat!.id))) await reply(ctx, 'Nothing is due. 🎉');
  }),
);

bot.command(
  'topics',
  guarded(async (ctx) => {
    const all = await repo.listTopics();
    if (all.length === 0) return reply(ctx, 'No topics yet. Send me something to remember.');
    await reply(ctx, all.map((t) => `• ${t.title} — next ${t.nextDueOn}`).join('\n'));
  }),
);

bot.command(
  'done',
  guarded(async (ctx) => {
    const open = await repo.getOpenSession();
    if (!open) return reply(ctx, 'No quiz is open.');
    await ctx.replyWithChatAction('typing');
    const closed = await closeSession(open.id, 'done');
    await reply(ctx, closed ? closedSummary(closed) : 'Session closed without a review (no answers given).');
  }),
);

bot.callbackQuery(
  /^q:(.+)$/,
  guarded(async (ctx) => {
    await ctx.answerCallbackQuery();
    const topicId = ctx.match![1];
    const topic = await repo.getTopic(topicId);
    if (!topic || topic.status === 'archived') return reply(ctx, 'That topic was deleted.');

    const open = await repo.getOpenSession();
    if (open?.topicId === topic.id) return reply(ctx, `You're already in the ${topic.title} quiz. Keep going, or /done.`);
    if (open) {
      await ctx.replyWithChatAction('typing');
      const closed = await closeSession(open.id, 'switch');
      if (closed) await reply(ctx, `Closed the previous session.\n${closedSummary(closed)}`);
    }

    let session;
    try {
      session = await repo.openSession(topic.id);
    } catch (err) {
      if (isUniqueViolation(err)) return reply(ctx, 'A session is already open or being reviewed. Try again in a moment.');
      throw err;
    }
    await ctx.replyWithChatAction('typing');
    const reviews = await repo.recentReviews(topic.id, 3);
    await reply(ctx, `🧠 ${topic.title}\n\n${await quizOpen(session, topic, reviews)}`);
  }),
);

bot.on(
  'message:text',
  guarded(async (ctx) => {
    const text = ctx.message!.text!;
    if (text.startsWith('/')) return reply(ctx, HELP);
    await ctx.replyWithChatAction('typing');
    const open = await repo.getOpenSession();
    if (!open) return reply(ctx, await librarianTurn(text));
    const topic = await repo.getTopic(open.topicId);
    if (!topic) return reply(ctx, 'The topic for this session no longer exists. Send /done.');
    const reviews = await repo.recentReviews(topic.id, 3);
    await reply(ctx, await quizTurn(open, topic, reviews, text));
  }),
);

bot.catch((err) => console.error('[telegram]', err.error));
