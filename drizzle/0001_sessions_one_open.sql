CREATE UNIQUE INDEX "sessions_one_open" ON "sessions" ((true)) WHERE "status" IN ('open','closing');
