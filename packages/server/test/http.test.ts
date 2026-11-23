import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildHttp } from '../src/http.js';
import { makeOffice } from './helpers.js';

// Real socket + fetch instead of app.inject(): inject pulls light-my-request → cookie@2 (ESM-only),
// which needs require(esm) and so Node ≥ 20.19. This keeps the tests running on Node 20.12.
const apps: FastifyInstance[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

async function setup() {
  const t = makeOffice();
  const { office, clock } = t;
  const app = buildHttp(t);
  apps.push(app);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const call = async (method: string, url: string, payload?: unknown) => {
    const res = await fetch(base + url, {
      method,
      headers: payload === undefined ? {} : { 'content-type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload)
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  return { office, clock, call, base };
}

describe('HTTP API', () => {
  it('serves the full state', async () => {
    const { call } = await setup();
    const res = await call('GET', '/api/state');
    expect(res.status).toBe(200);
    expect(res.body.agents).toHaveLength(6);
    expect(res.body.board).toHaveLength(8);
    expect(res.body.breakRoom.locked).toBe(false);
  });

  it('lets the human add a card to the backlog only', async () => {
    const { call } = await setup();
    const res = await call('POST', '/api/cards', { title: 'Nouvelle idée' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ col: 'BACKLOG', created_by: 'user' });
  });

  it('runs MCP tools and maps refusals to clear errors', async () => {
    const { call } = await setup();
    const created = await call('POST', '/api/tools/create_card', { agent: 'lead', title: 'T', column: 'TODO' });
    const id = created.body.result.id;
    const refused = await call('POST', '/api/tools/move_card', { agent: 'dev1', card_id: id, to: 'DONE' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('forbidden_transition');
    expect((await call('POST', '/api/tools/nope', {})).status).toBe(404);
    await call('POST', '/api/tools/assign_card', { agent: 'lead', card_id: id, assignee: 'dev1' });
    await call('POST', '/api/tools/move_card', { agent: 'dev1', card_id: id, to: 'IN PROGRESS' });
    const review = await call('POST', '/api/tools/move_card', { agent: 'dev1', card_id: id, to: 'IN REVIEW' });
    expect(review.body.result.next).toMatchObject({ to: ['reviewer'] });
    expect(review.body.result.next.todo).toMatch(/SendMessage/);
    expect((await call('POST', '/api/tools/move_card', { agent: 'dev1' })).status).toBe(400);
  });

  it('locks and unlocks the break room', async () => {
    const { call, office } = await setup();
    await call('POST', '/api/break-room/lock');
    expect(office.isBreakLocked()).toBe(true);
    const post = await call('POST', '/api/tools/break_room_post', { agent: 'lead', body: 'hi' });
    expect(post.status).toBe(423);
    expect(post.body.error.message).toMatch(/fermée/);
    await call('POST', '/api/break-room/unlock');
    expect(office.isBreakLocked()).toBe(false);
  });

  it('ingests the statusline payload seen in step 0', async () => {
    const { call, office } = await setup();
    const payload = { session_id: 's', rate_limits: { five_hour: { used_percentage: 15, resets_at: 1795358400 }, seven_day: { used_percentage: 4, resets_at: 1795809600 } } };
    expect((await call('POST', '/api/statusline', payload)).body).toMatchObject({ ok: true, recorded: true });
    expect(office.quotaView().latest?.fiveHour).toEqual({ usedPct: 15, resetsAt: 1795358400 });
    expect((await call('POST', '/api/statusline', { session_id: 's', rate_limits: null })).body).toMatchObject({ recorded: false });
  });

  it('stores hook payloads', async () => {
    const { call, office } = await setup();
    await call('POST', '/api/hooks/PreToolUse', { hook_event_name: 'PreToolUse', agent_type: 'dev1', tool_name: 'Edit' });
    expect(office.recordHook('x', null, {})).toBe(2);
  });

  it('streams live events over SSE', async () => {
    const { call, base } = await setup();
    const ctrl = new AbortController();
    const res = await fetch(base + '/api/events', { signal: ctrl.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    await call('POST', '/api/cards', { title: 'En direct' });
    let text = '';
    const dec = new TextDecoder();
    while (!text.includes('event: card\n')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += dec.decode(value);
    }
    ctrl.abort();
    expect(text).toContain('event: card_event');
    expect(text).toContain('En direct');
  });
});
