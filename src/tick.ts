import { env } from './env.js';
import { londonToday, shouldSendDaily } from './london.js';
import * as repo from './repo.js';
import { closedSummary, closeSession } from './review-writer.js';
import { sendDueList, sendText } from './telegram.js';

export async function runTick(now: Date): Promise<void> {
  const chatId = env.TELEGRAM_CHAT_ID;

  const stale = await repo.staleOpenSessions(60);
  console.log('[tick] ran', { staleSessions: stale.length });
  for (const session of stale) {
    try {
      const closed = await closeSession(session.id, 'idle');
      if (closed && chatId) await sendText(chatId, `Closed your idle session.\n${closedSummary(closed)}`);
    } catch (err) {
      console.error('[tick] idle close failed', { sessionId: session.id }, err);
    }
  }

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
