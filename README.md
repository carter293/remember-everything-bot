# Memory Tutor Bot

Single-user spaced-repetition tutor. Knowledge comes in through MCP (Claude, Perplexity, Pi) or Telegram. Every evening, Telegram lists up to 3 due topics. Tapping one opens a Gemini quiz. `/done`, or 1h of inactivity, makes Gemini write a scored review, and that review schedules the next quiz.

```
Telegram ─────────▶ POST /api/telegram ─┐
cron-job.org ─────▶ POST /api/tick ─────┼─▶ Hono app on Vercel ─▶ Gemini (AI SDK v7)
Claude/Perplexity/Pi ▶ /api/mcp ────────┘          │
                                                   └──▶ Neon Postgres (Drizzle, HTTP driver)
```

---

## Handoff: current state (2026-10-22)

**Live and verified end to end:** deploy, DB, Telegram quiz → `/done` → review → reschedule, and MCP auth and tools.

| Thing | Value |
|---|---|
| Production URL | `https://memory-tutor-bot.vercel.app` |
| Vercel | Project `carter293s-projects/memory-tutor-bot`, Hobby plan. Deploys run from the **local working tree** (`pnpm vercel deploy --prod --yes`). No git integration. |
| Neon | Org `org-old-glade-65894294`, project `dark-unit-05614188`, branch `production`. Linked in `.neon` (gitignored). `neon.ts` declares Postgres only. |
| Telegram bot | `@RememberEverything744Bot`. Webhook set to `/api/telegram`. Only `TELEGRAM_CHAT_ID` is served. |
| Gemini | `gemini-3.8-flash` through `@ai-sdk/google`, on the user's paid key |
| Migrations applied to prod | `0000` (tables), `0001` (one-open-session index), `0002` (topic `status` / `archived_at`) |
| Git | **Nothing committed.** The user commits. Agents must never commit, push or stash. |

**Not verified yet:**
- **cron-job.org:** the user created a job, but no run has been confirmed in the logs. The intended schedule is daily at 20:30 Europe/London, POST, `Authorization: Bearer <TICK_SECRET>`. Every authorised tick logs `[tick] ran`. A bad header logs `[tick] rejected`.
- **Pi MCP:** the entry `memory-tutor` was added to `~/.config/mcp/mcp.json` (URL with the path token). It needs `/reload` in Pi. A connection hasn't been confirmed.
- **Claude / Perplexity connectors:** not confirmed to be set up.
- **Google Search during quizzes:** native `googleSearch` combined with function tools (a Gemini Preview feature) hasn't been seen running in production.

---

## How it works

### Data model (`src/schema.ts`, the source of truth)

| Table | Purpose |
|---|---|
| `topics` | `title`, `description`, `notes`, schedule (`interval_days`, `next_due_on`, `last_score`, `last_reviewed_at`), `status` (`active` / `archived`), `archived_at`. `notes` is append-only, with dated entries like `[2026-10-22] …`. |
| `reviews` | One per finished quiz: `score` 0–5, `scoring_note`, `notes` (Covered / Missed / Summary), `transcript_excerpt` |
| `sessions` | Quiz chats. `messages` holds AI SDK `ModelMessage[]` **verbatim**, which keeps Gemini thought signatures. `status`: `open` → `closing` → `closed` / `abandoned`. A partial unique index allows at most one `open`/`closing` session. |
| `app_state` | Key/value. `daily_sent_on` = the London date the daily list was last sent. |

### Scheduling (`src/cadence.ts`, `src/london.ts`, both pure and unit-tested)
- **Dates:** `next_due_on` is a London **calendar date**, not a timestamp. A topic is due when `next_due_on <= London today`. Nothing counts down. Overdue topics stay due and sort first.
- **New topic:** due tomorrow, interval 1.
- **After a review:** `nextInterval(current, score)` over the ladder `1 → 3 → 7 → 14 → 30 → 90 → 180` days.
  - Score ≥4: step up one rung.
  - Score 3: stay on the same rung.
  - Score ≤2: reset to 1.
- **Manual reschedule:** `update_topic` with `next_due_on` or `due_in_days`. The server turns it into a date from its own London "today". It moves **only** the date, never the interval.
- **Daily list:** `shouldSendDaily` returns true at ≥20:30 London when `daily_sent_on !== today`. The list is sent once, and the day is marked sent even when nothing is due. Clock changes need no handling, because the code computes London time with `Intl`.

### Request flow
- **`/api/telegram`:** checks the `X-Telegram-Bot-Api-Secret-Token` header, returns 200 **immediately**, then runs `bot.handleUpdate` inside `waitUntil`. grammY's `webhookCallback` isn't used: it waits for the LLM, and Telegram re-sends any update that takes over 10s.
- **`/api/tick`:** checks the Bearer `TICK_SECRET`, returns 202, then in `waitUntil` it:
  1. Reviews sessions idle for more than 60 min.
  2. Sends the daily list if it's due.
- **`/api/mcp/:token` and `/api/mcp`:** the token is accepted in the URL path, in `Authorization: Bearer`, or in `x-api-key` (timing-safe compare). Then `mcp-handler` serves stateless Streamable HTTP. A wrong token gets a plain 401. `withMcpAuth` isn't used, because it would make Claude attempt OAuth.

### Telegram behaviour (`src/telegram.ts`)
- **Middleware:**
  1. Chat-id guard. While `TELEGRAM_CHAT_ID` is unset, only `/start` answers, with the chat id.
  2. Lazy close: an idle open session is reviewed before anything else is handled.
- **Commands:** `/due`, `/topics`, `/done`, `/help`, `/start`.
- **Buttons:** callback data is `q:<topicId>`. Tapping one opens a session, closing any other session first with a review.
- **Free text:** goes to the quiz if a session is open, otherwise to the librarian agent.
- **Replies:** plain text with no Markdown, split into chunks of 4000 characters or fewer.

### LLM (`src/agent.ts`, `src/review-writer.ts`, `src/tools.ts`)
- **Quiz:** gets the topic notes plus the last 3 reviews in its instructions. Tools: `google_search`, `append_to_topic`, `get_topic`, `search_topics`. Limit `stepCountIs(8)`, `thinkingLevel: 'low'`.
- **Librarian:** stateless, no history. Tools: all of `dbTools` (`search_topics`, `get_topic`, `create_topic`, `append_to_topic`, `update_topic`, `delete_topic`, `list_due`) plus `google_search`.
- **Review writer:** a `generateText` call with `Output.object` and no tools. Claim/close protocol: `claimSessionForClose` (open → closing), then the LLM call, then `finishSession`. `finishSession` is one atomic `db.batch` covering the review insert, the topic update and the session close. If anything throws, `reopenSession` runs, so the next tick retries.
- **Abandoned sessions:** a session with no real user answer is `abandoned` without a review. The synthetic opener `"Start the quiz."` doesn't count as an answer.

### MCP tools (`src/mcp.ts`)
`create_topic`, `append_to_topic`, `update_topic` (rename, describe, reschedule), `delete_topic` (archives), `search`, `get_topic`.
- **Shared logic:** `update_topic` uses `applyTopicUpdate` / `updateTopicInput` from `tools.ts`, the same code as the librarian.
- **Archived topics:** every read path excludes them: due lists, search, listings, title dedupe, update.

---

## Environment variables

`.env.local` is gitignored. Vercel production has the same values, stored as Sensitive.

| Var | Notes |
|---|---|
| `DATABASE_URL` | Pooled Neon URL. Written by `neon deploy` / `neon env pull`. |
| `DATABASE_URL_UNPOOLED`, `NEON_BRANCH` | Written by Neon. Local only. |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Paid Gemini key |
| `GEMINI_MODEL` | `gemini-3.8-flash` |
| `TELEGRAM_BOT_TOKEN` | From @BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | Random, `[A-Za-z0-9_-]` only |
| `TELEGRAM_CHAT_ID` | The single allowed chat |
| `TICK_SECRET` | Bearer for `/api/tick` |
| `MCP_TOKEN` | MCP auth. Rotate it by changing it in Vercel and redeploying, then updating the connectors. |
| `PUBLIC_URL` | `https://memory-tutor-bot.vercel.app` |
| `VERCEL_OIDC_TOKEN` | Written by `vercel link`. Local only. |

`src/env.ts` checks all of these with zod at startup. A missing var makes every route return 500.

---

## Commands

| Command | What it does |
|---|---|
| `pnpm typecheck` | `tsc --noEmit` (NodeNext). |
| `pnpm test` | Unit and in-process route tests. No external services. |
| `pnpm test:db` | Repo tests against the real `DATABASE_URL`. Creates and deletes `test-*` topics. Run it only when no quiz is open, because the tests open sessions. |
| `pnpm db:generate` | Writes a migration after you edit `src/schema.ts` |
| `pnpm db:migrate` | Applies pending migrations to `DATABASE_URL`, which is **prod**. |
| `pnpm db:studio` | DB browser |
| `pnpm telegram:setup` | Re-registers the webhook and command menu |
| `pnpm vercel deploy --prod --yes` | Deploy |
| `pnpm vercel logs --environment production --json` | Runtime logs. The Hobby plan keeps **30 min** only. |

### Change workflow
1. Edit the code. Run `pnpm typecheck && pnpm test`.
2. If the schema changed:
   1. Edit `src/schema.ts`, then run `pnpm db:generate`.
   2. Read the SQL.
   3. Run `pnpm db:migrate`, then `pnpm test:db`.
   4. Migrate **before** deploying, and keep migrations additive so the running code keeps working.
3. Run `pnpm vercel deploy --prod --yes`, then smoke-test:
   - `/` → `{"ok":true}`
   - MCP `tools/list` with `x-api-key`
4. Never edit an applied migration. `0001` is hand-written (`--custom`), because Drizzle can't express the expression index.

---

## Gotchas already hit (don't repeat them)

- **Relative imports need `.js`** (`./env.js`). Vercel compiles each file to Node ESM, and a bare `./env` crashes at runtime with `ERR_MODULE_NOT_FOUND`. The tsconfig uses `NodeNext`, so the typecheck catches it.
- **`tsconfig` needs `typeRoots: ["./node_modules/@types"]`.** Otherwise Vercel's build fails with `TS2688 Cannot find type definition file for 'node'`.
- **Neon writes `DATABASE_URL` with surrounding quotes** in `.env.local`. When you push to Vercel, read the value through `node --env-file`, which strips the quotes, not through `cut`/`grep`. A quoted value gives `NeonDbError: … not a valid URL`.
- **AI SDK v7:** the step limit is `stepCountIs`, and `isStepCount` isn't exported. History is `result.responseMessages`. Structured output is `Output.object({ schema })`, read from `result.output`.
- **`vercel env add`** in this CLI version: pipe the value on stdin and use `--environment production --sensitive --yes`. Add `--force` to overwrite.
- **`/mcp-adapter reconnect` in Pi doesn't load new servers.** Use `/reload`.
- **The Drizzle neon-http batch is atomic.** Verified by `pnpm test:db`.

---

## Open items / known gaps

1. **`notes` is optional** in `create_topic`. A caller can create a topic with no content, and the quiz then relies on Gemini's general knowledge. Proposed: make it required and tell callers to include full detail.
2. **No `restore_topic`.** To restore an archived topic now: `UPDATE topics SET status='active', archived_at=NULL WHERE id=…`.
3. **No retry cap on reviews.** A review that keeps failing is retried on every tick.
4. **Long quiz histories aren't trimmed.** Each session is separate and gets summarised at close, so this rarely matters.
5. **Telegram duplicate delivery** isn't de-duplicated. The risk is low, because we return 200 at once.
6. **`drizzle.config.ts` uses the pooled URL.** Consider `DATABASE_URL_UNPOOLED` for migrations; this isn't verified as necessary.
7. **Secrets exposed in the chat transcript:** the Telegram bot token and the context7 API key. Rotate them: `/revoke` in @BotFather, then update `TELEGRAM_BOT_TOKEN` locally and in Vercel, redeploy, and run `pnpm telegram:setup`.
8. **Planning docs:** `../docs/PRPs/plans/memory-tutor-bot.plan.md` and `../docs/PRPs/reports/memory-tutor-bot-report.md`. The plan predates archive, reschedule and the deploy fixes, and isn't archived. Where they disagree, this README and the code are correct.

---

## Connecting MCP clients

The connector URL contains the secret: `https://memory-tutor-bot.vercel.app/api/mcp/<MCP_TOKEN>`.

- **Claude (app):** Settings → Connectors → Add custom connector → paste the URL. No OAuth.
- **Claude Code:** `claude mcp add --transport http --scope user memory-tutor "<URL>"`
- **Perplexity (Pro/Max):** Settings → Connectors → Add custom connector → the URL, Streamable HTTP, auth None.
- **Pi:** add `"memory-tutor": { "url": "<URL>" }` under `mcpServers` in `~/.config/mcp/mcp.json`, then `/reload`. This is already done; see Handoff.

## Fresh setup from zero (for reference)

1. `cp .env.example .env.local`. Generate the secrets with `openssl rand -hex 24`.
2. Neon: `npx neon@latest init …` then `npx neon@latest deploy`. This writes `DATABASE_URL`. Then run `pnpm db:migrate && pnpm test:db`.
3. Create the bot with @BotFather. Copy the token into `TELEGRAM_BOT_TOKEN`.
4. Vercel:
   - Run `pnpm vercel login` and `pnpm vercel link`.
   - Run `vercel env add` for each var.
   - Run `pnpm vercel deploy --prod --yes`.
   - Set `PUBLIC_URL`.
5. Run `pnpm telegram:setup`. Send `/start` to the bot, set `TELEGRAM_CHAT_ID` in Vercel, and redeploy.
6. Create the cron-job.org job (see Handoff), then connect the MCP clients.
