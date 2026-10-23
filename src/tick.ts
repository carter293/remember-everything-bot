import { env } from './env.js';
import { londonToday, shouldSendDaily } from './london.js';
import * as repo from './repo.js';
import { sendDueList } from './telegram.js';

export async function runTick(now: Date): Promise<void> {
  const chatId = env.TELEGRAM_CHAT_ID;
  console.log('[tick] ran');

  if (!chatId) {
    console.log('[tick] TELEGRAM_CHAT_ID unset, skipping daily list');
    return;
  }
  if (shouldSendDaily(now, await repo.getState('daily_sent_on'))) {
    const sent = await sendDueList(chatId);
    await repo.setState('daily_sent_on', londonToday(now));
    console.log('[tick] daily list', { sent });
  }
}
