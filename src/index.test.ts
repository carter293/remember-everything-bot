import { beforeAll, describe, expect, it } from 'vitest';

const MCP_TOKEN = 'test-mcp-token-0123456789';
const TICK_SECRET = 'test-tick-secret-0123456789';

let app: typeof import('./index.js').default;

beforeAll(async () => {
  Object.assign(process.env, {
    DATABASE_URL: 'postgresql://user:pass@localhost/db',
    GOOGLE_GENERATIVE_AI_API_KEY: 'test',
    TELEGRAM_BOT_TOKEN: '123:test',
    TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret',
    TICK_SECRET,
    MCP_TOKEN,
  });
  app = (await import('./index.js')).default;
});

const mcpInit = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
};
const mcpHeaders = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

describe('routes', () => {
  it('serves health', async () => {
    const res = await app.request('/');
    expect(await res.json()).toEqual({ ok: true });
  });

  it('rejects Telegram updates without the secret header', async () => {
    const res = await app.request('/api/telegram', { method: 'POST', body: '{}' });
    expect(res.status).toBe(403);
  });

  it('rejects a tick without the bearer secret', async () => {
    const res = await app.request('/api/tick', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('rejects MCP with a wrong path token', async () => {
    const res = await app.request('/api/mcp/wrong', { method: 'POST', headers: mcpHeaders, body: JSON.stringify(mcpInit) });
    expect(res.status).toBe(401);
  });

  it('initialises MCP with the path token', async () => {
    const res = await app.request(`/api/mcp/${MCP_TOKEN}`, { method: 'POST', headers: mcpHeaders, body: JSON.stringify(mcpInit) });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('memory-tutor');
  });

  it('initialises MCP with an x-api-key header', async () => {
    const res = await app.request('/api/mcp', {
      method: 'POST',
      headers: { ...mcpHeaders, 'x-api-key': MCP_TOKEN },
      body: JSON.stringify(mcpInit),
    });
    expect(res.status).toBe(200);
  });

  it('lists the 6 MCP tools with a bearer token', async () => {
    const res = await app.request('/api/mcp', {
      method: 'POST',
      headers: { ...mcpHeaders, authorization: `Bearer ${MCP_TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    const body = await res.text();
    const names = [...body.matchAll(/"name":"([a-z_]+)"/g)].map((m) => m[1]);
    expect(names).toEqual(['create_topic', 'append_to_topic', 'update_topic', 'delete_topic', 'search', 'get_topic']);
  });
});
