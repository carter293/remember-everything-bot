// Registers the Telegram webhook and the command menu. Run: pnpm telegram:setup
const { TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, PUBLIC_URL } = process.env;
if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_WEBHOOK_SECRET || !PUBLIC_URL) {
  console.error('Set TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and PUBLIC_URL in .env.local');
  process.exit(1);
}

async function call(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`${method}: ${json.description}`);
  return json.result;
}

await call('setWebhook', {
  url: `${PUBLIC_URL.replace(/\/$/, '')}/api/telegram`,
  secret_token: TELEGRAM_WEBHOOK_SECRET,
  allowed_updates: ['message', 'callback_query'],
  drop_pending_updates: true,
});
await call('setMyCommands', {
  commands: [
    { command: 'due', description: 'Show topics due now' },
    { command: 'topics', description: 'List all topics' },
    { command: 'done', description: 'End the quiz and get your score' },
    { command: 'help', description: 'How this works' },
  ],
});
console.log(await call('getWebhookInfo'));
