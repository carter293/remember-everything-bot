import { Bot, InlineKeyboard, type Context } from 'grammy';
import { chatTurn, startQuiz } from './agent.js';
import { env } from './env.js';
import { londonToday } from './london.js';
import * as repo from './repo.js';

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
• Message me any time to save, search or reschedule topics, or say "quiz me on X".`;

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
    if (!(await repo.getActiveQuiz())) return reply(ctx, 'No quiz is open.');
    await ctx.replyWithChatAction('typing');
    await reply(ctx, await chatTurn('/done — end the quiz now and record the review.', { forceReview: true }));
  }),
);

bot.callbackQuery(
  /^q:(.+)$/,
  guarded(async (ctx) => {
    await ctx.answerCallbackQuery();
    const started = await startQuiz(ctx.match![1]);
    if ('error' in started) return reply(ctx, started.error);
    await ctx.replyWithChatAction('typing');
    const { title } = started.topic;
    await reply(ctx, `🧠 ${title}\n\n${await chatTurn(`Quiz me on "${title}".`)}`);
  }),
);

bot.on(
  'message:text',
  guarded(async (ctx) => {
    const text = ctx.message!.text!;
    if (text.startsWith('/')) return reply(ctx, HELP);
    await ctx.replyWithChatAction('typing');
    await reply(ctx, await chatTurn(text));
  }),
);

bot.catch((err) => console.error('[telegram]', err.error));
