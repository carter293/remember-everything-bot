import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().min(1),
  GEMINI_MODEL: z.string().default('gemini-3.8-flash'),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_WEBHOOK_SECRET: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/),
  TELEGRAM_CHAT_ID: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : undefined)),
  TICK_SECRET: z.string().min(16),
  MCP_TOKEN: z.string().min(16),
  PUBLIC_URL: z.string().optional(),
});

export const env = schema.parse(process.env);
