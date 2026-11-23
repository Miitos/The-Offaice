import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { z } from 'zod';
import { OfficeError } from './domain/errors.js';
import type { OfficeApp } from './app.js';
import { USER } from './domain/office.js';
import { recentTranscript } from './domain/transcript.js';
import type { Settings } from './domain/settings.js';
import fs from 'node:fs';
import path from 'node:path';

const STATUS: Record<string, number> = {
  unknown_agent: 404,
  unknown_card: 404,
  invalid_input: 400,
  too_long: 400,
  same_column: 409,
  forbidden_transition: 409,
  capability_required: 403,
  review_comment_required: 409,
  break_room_locked: 423,
  break_cooldown: 429,
  work_first: 409,
  resting: 409,
  system_only: 403,
  name_taken: 409,
  not_in_room: 409,
  unknown_post: 404,
  retro_in_progress: 409,
  no_retro: 409,
  quota_exhausted: 429
};

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof OfficeError) {
    return reply.code(STATUS[err.code] ?? 400).send({ ok: false, error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err instanceof z.ZodError) {
    return reply.code(400).send({ ok: false, error: { code: 'invalid_input', message: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') } });
  }
  reply.log.error(err);
  return reply.code(500).send({ ok: false, error: { code: 'internal', message: err instanceof Error ? err.message : String(err) } });
}

const Id = z.coerce.number().int().positive();

/**
 * Tools called by the "office" MCP server (step 2). `agent` is the identity
 * injected by the PreToolUse hook, never a value the model chose.
 */
const ToolCalls = {
  create_card: z.object({ agent: z.string(), title: z.string(), description: z.string().optional(), column: z.string().optional() }),
  move_card: z.object({ agent: z.string(), card_id: Id, to: z.string(), reason: z.string().optional() }),
  assign_card: z.object({ agent: z.string(), card_id: Id, assignee: z.string().nullable() }),
  comment_card: z.object({ agent: z.string(), card_id: Id, body: z.string(), kind: z.enum(['note', 'review']).default('note') }),
  list_board: z.object({ agent: z.string() }),
  enter_room: z.object({ agent: z.string(), room: z.string(), reason: z.string().optional() }),
  break_room_post: z.object({ agent: z.string(), body: z.string(), reply_to: Id.nullish() }),
  break_room_read: z.object({ agent: z.string() }),
  break_room_wait: z.object({ agent: z.string(), max_seconds: z.number().int().positive().default(240) }),
  update_profile: z.object({
    agent: z.string(),
    add_hobbies: z.array(z.string()).optional(),
    remove_hobbies: z.array(z.string()).optional(),
    add_dislikes: z.array(z.string()).optional(),
    remove_dislikes: z.array(z.string()).optional()
  }),
  set_opinion: z.object({ agent: z.string(), about: z.string(), opinion: z.string() }),
  team_profiles: z.object({ agent: z.string() }),
  rate_card: z.object({ agent: z.string(), card_id: Id, clarity: z.coerce.number().int(), comment: z.string() }),
  introduce_self: z.object({ agent: z.string(), first_name: z.string(), last_name: z.string(), favorite_movie: z.string(), favorite_music: z.string() }),
  get_card: z.object({ agent: z.string(), card_id: Id }),
  team_agreements: z.object({ agent: z.string() }),
  retro_status: z.object({ agent: z.string() }),
  retro_post: z.object({ agent: z.string(), body: z.string(), reply_to: Id.nullish() }),
  retro_propose: z.object({ agent: z.string(), kind: z.enum(['quota', 'process', 'other']), title: z.string(), details: z.string(), shares: z.record(z.string(), z.number()).optional() }),
  retro_vote: z.object({ agent: z.string(), proposal_id: Id, vote: z.enum(['for', 'against']) }),
  retro_close: z.object({ agent: z.string(), summary: z.string().optional() })
} as const;
type ToolName = keyof typeof ToolCalls;

function runTool({ office, retro }: OfficeApp, name: ToolName, raw: unknown): unknown {
  switch (name) {
    case 'create_card': {
      const a = ToolCalls.create_card.parse(raw);
      return office.createCard(a.agent, a);
    }
    case 'move_card': {
      const a = ToolCalls.move_card.parse(raw);
      const card = office.moveCard(a.agent, a.card_id, a.to, a.reason);
      const next = office.handoffFor(card);
      const others = next ? next.to.filter((n) => n !== a.agent) : [];
      return {
        ...card,
        next: next && others.length ? { ...next, to: others, todo: `Préviens ${others.join(', ')} avec SendMessage : « ${next.message} » (un coéquipier inactif ne se réveille que sur un message).` } : null
      };
    }
    case 'assign_card': {
      const a = ToolCalls.assign_card.parse(raw);
      const card = office.assignCard(a.agent, a.card_id, a.assignee);
      const to = card.assignee && card.assignee !== a.agent ? card.assignee : null;
      return { ...card, next: to ? { to: [to], todo: `Préviens ${to} avec SendMessage (carte #${card.id}) : un coéquipier inactif ne se réveille que sur un message.` } : null };
    }
    case 'comment_card': {
      const a = ToolCalls.comment_card.parse(raw);
      return office.commentCard(a.agent, a.card_id, a.body, a.kind);
    }
    case 'list_board': {
      const a = ToolCalls.list_board.parse(raw);
      office.agentView(a.agent); // throws unknown_agent
      return office.listBoard();
    }
    case 'enter_room': {
      const a = ToolCalls.enter_room.parse(raw);
      return office.enterRoom(a.agent, a.room, 'agent', a.reason);
    }
    case 'break_room_post': {
      const a = ToolCalls.break_room_post.parse(raw);
      return office.breakRoomPost(a.agent, a.body, a.reply_to);
    }
    case 'break_room_read': {
      const a = ToolCalls.break_room_read.parse(raw);
      return office.breakRoomRead(a.agent);
    }
    case 'break_room_wait': {
      const a = ToolCalls.break_room_wait.parse(raw);
      return office.breakRoomWait(a.agent, a.max_seconds);
    }
    case 'update_profile': {
      const a = ToolCalls.update_profile.parse(raw);
      return office.updateProfile(a.agent, a);
    }
    case 'set_opinion': {
      const a = ToolCalls.set_opinion.parse(raw);
      return office.setOpinion(a.agent, a.about, a.opinion);
    }
    case 'team_profiles': {
      const a = ToolCalls.team_profiles.parse(raw);
      return office.teamProfiles(a.agent);
    }
    case 'rate_card': {
      const a = ToolCalls.rate_card.parse(raw);
      return office.rateCard(a.agent, a.card_id, a.clarity, a.comment);
    }
    case 'introduce_self': {
      const a = ToolCalls.introduce_self.parse(raw);
      return office.introduceSelf(a.agent, a);
    }
    case 'get_card': {
      const a = ToolCalls.get_card.parse(raw);
      office.agentView(a.agent);
      return office.getCard(a.card_id);
    }
    case 'team_agreements': {
      const a = ToolCalls.team_agreements.parse(raw);
      office.agentView(a.agent);
      return { agreements: retro.agreements(), shares: office.shares() };
    }
    case 'retro_status': {
      const a = ToolCalls.retro_status.parse(raw);
      office.agentView(a.agent);
      return retro.status(a.agent);
    }
    case 'retro_post': {
      const a = ToolCalls.retro_post.parse(raw);
      return retro.post(a.agent, a.body, a.reply_to);
    }
    case 'retro_propose': {
      const a = ToolCalls.retro_propose.parse(raw);
      return retro.propose(a.agent, a);
    }
    case 'retro_vote': {
      const a = ToolCalls.retro_vote.parse(raw);
      return retro.vote(a.agent, a.proposal_id, a.vote);
    }
    case 'retro_close': {
      const a = ToolCalls.retro_close.parse(raw);
      office.agentView(a.agent);
      return retro.close(a.agent, a.summary);
    }
  }
}

const RateWindow = z.object({ used_percentage: z.number(), resets_at: z.number().optional() }).nullish();
const StatuslineBody = z.object({
  rate_limits: z.object({ five_hour: RateWindow, seven_day: RateWindow }).partial().nullish()
});

/** One line for the lead's terminal statusline. */
function statusLine({ office, retro, usage }: OfficeApp): string {
  const q = office.quotaView();
  const five = q.latest?.fiveHour?.usedPct;
  const seven = q.latest?.sevenDay?.usedPct;
  const v = usage.view();
  const resting = v.agents.filter((a) => office.agentRow(a.name).room === 'rest').map((a) => a.name);
  const parts = [
    'The OffAIce',
    `5h ${five ?? '–'}% · 7j ${seven ?? '–'}% (arrêt ${q.stopAtPct}%)`,
    office.isBreakLocked() ? 'pause fermée' : 'pause ouverte',
    retro.current() ? 'RÉTRO EN COURS' : null,
    resting.length ? `repos : ${resting.join(', ')}` : null
  ];
  return parts.filter(Boolean).join(' | ');
}

export function buildHttp(ctx: OfficeApp, opts: { logger?: boolean | object; uiDir?: string; settings?: Settings } = {}): FastifyInstance {
  const { office, retro, usage, hooks } = ctx;
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 2 * 1024 * 1024 });

  // Local tool for one person: only the machine itself may call it.
  app.addHook('onRequest', async (req, reply) => {
    const ip = req.ip;
    if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
      return reply.code(403).send({ ok: false, error: { code: 'forbidden', message: 'local only' } });
    }
  });

  app.get('/api/health', async () => ({ ok: true }));

  // ── UI: read
  app.get('/api/state', async () => office.getState());
  app.get<{ Querystring: { project?: string } }>('/api/board', async (req, reply) => {
    const project = req.query.project;
    if (project && !office.isProject(project)) return reply.code(404).send({ ok: false, error: { code: 'unknown_project', message: `Projet inconnu : ${project}` } });
    return office.listBoard(project || undefined);
  });
  app.get('/api/projects', async () => office.projectsView());
  app.get('/api/agents', async () => office.listAgents());
  app.get<{ Params: { name: string } }>('/api/agents/:name', async (req, reply) => {
    try {
      return { ...office.agentView(req.params.name), roomEvents: office.recentRoomEvents(req.params.name) };
    } catch (e) {
      return sendError(reply, e);
    }
  });
  app.get<{ Params: { id: string } }>('/api/cards/:id', async (req, reply) => {
    try {
      return office.getCard(Id.parse(req.params.id));
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.get('/api/social', async () => office.socialView());
  app.get<{ Params: { name: string }; Querystring: { limit?: string } }>('/api/agents/:name/transcript', async (req, reply) => {
    try {
      office.agentView(req.params.name);
      return recentTranscript(office.db, req.params.name, Math.min(200, Number(req.query.limit ?? 40) || 40));
    } catch (e) {
      return sendError(reply, e);
    }
  });
  app.get('/api/feedback', async () =>
    office
      .listBoard()
      .flatMap((c) => c.cards)
      .map((c) => ({ id: c.id, title: c.title, createdBy: c.createdBy, ...office.cardFeedbackSummary(c.id) }))
      .filter((c) => c.count > 0)
      .sort((a, b) => (a.avgClarity ?? 0) - (b.avgClarity ?? 0))
  );
  app.get<{ Querystring: { author?: string; about?: string } }>('/api/opinions/history', async (req, reply) => {
    try {
      const q = z.object({ author: z.string(), about: z.string() }).parse(req.query);
      return office.opinionHistory(q.author, office.parseAbout(q.about));
    } catch (e) {
      return sendError(reply, e);
    }
  });

  // ── UI: the only writes the human can make
  app.post('/api/cards', async (req, reply) => {
    try {
      const body = z.object({ title: z.string(), description: z.string().optional(), project: z.string().optional() }).parse(req.body);
      return reply.code(201).send(office.createCard(USER, body));
    } catch (e) {
      return sendError(reply, e);
    }
  });
  // Le créateur answers a card's questions (the designer's, typically).
  app.post<{ Params: { id: string } }>('/api/cards/:id/comments', async (req, reply) => {
    try {
      const body = z.object({ body: z.string() }).parse(req.body);
      return reply.code(201).send(office.commentCard(USER, Id.parse(req.params.id), body.body, 'note'));
    } catch (e) {
      return sendError(reply, e);
    }
  });
  if (opts.settings) {
    const settings = opts.settings;
    app.get('/api/settings', async () => settings.view());
    app.put('/api/settings', async (req, reply) => {
      try {
        return await settings.update(req.body);
      } catch (e) {
        return sendError(reply, e);
      }
    });
    app.post('/api/projects', async (req, reply) => {
      try {
        return reply.code(201).send(settings.addProject(req.body));
      } catch (e) {
        return sendError(reply, e);
      }
    });
    app.delete<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
      try {
        return settings.removeProject(req.params.id);
      } catch (e) {
        return sendError(reply, e);
      }
    });
    app.post<{ Params: { id: string } }>('/api/projects/:id/activate', async (req, reply) => {
      try {
        const body = z.object({ force: z.boolean().optional() }).parse(req.body ?? {});
        return await settings.activateProject(req.params.id, body);
      } catch (e) {
        return sendError(reply, e);
      }
    });
  }
  app.post('/api/break-room/lock', async () => office.setBreakLock(true, 'user'));
  app.post('/api/break-room/unlock', async () => office.setBreakLock(false, 'user'));

  // ── Live updates
  app.get('/api/events', (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    reply.raw.write(`retry: 2000\n\n`);
    const unsubscribe = office.bus.subscribe((e) => {
      reply.raw.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    });
    const ping = setInterval(() => reply.raw.write(`: ping ${Date.now()}\n\n`), 15000);
    req.raw.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
    reply.hijack();
  });

  // ── MCP "office" server → business rules
  app.post<{ Params: { tool: string } }>('/api/tools/:tool', async (req, reply) => {
    const name = req.params.tool as ToolName;
    if (!(name in ToolCalls)) {
      return reply.code(404).send({ ok: false, error: { code: 'unknown_tool', message: `Outil inconnu : ${req.params.tool}` } });
    }
    try {
      return { ok: true, result: await runTool(ctx, name, req.body) };
    } catch (e) {
      return sendError(reply, e);
    }
  });

  // ── Claude Code hooks: the hook script posts the input, prints back this JSON.
  app.post<{ Params: { event: string } }>('/api/hooks/:event', async (req, reply) => {
    try {
      return hooks.handle(req.params.event, (req.body ?? {}) as Record<string, unknown>);
    } catch (e) {
      // Never break the agent's session on an internal error: log and let it through.
      reply.log.error(e);
      return {};
    }
  });

  // ── Retrospective (UI)
  app.get('/api/retro', async () => ({ current: retro.currentView(), agreements: retro.agreements(), history: retro.history(20) }));
  app.post('/api/retro/start', async (req, reply) => {
    try {
      const body = z.object({ topic: z.string().optional() }).parse(req.body ?? {});
      return reply.code(201).send(retro.start('user', body.topic));
    } catch (e) {
      return sendError(reply, e);
    }
  });
  app.post('/api/retro/close', async (req, reply) => {
    try {
      const body = z.object({ summary: z.string().optional() }).parse(req.body ?? {});
      return retro.close(USER, body.summary);
    } catch (e) {
      return sendError(reply, e);
    }
  });
  app.post<{ Params: { id: string } }>('/api/retro/proposals/:id/revert', async (req, reply) => {
    try {
      return retro.revert(Id.parse(req.params.id), 'user');
    } catch (e) {
      return sendError(reply, e);
    }
  });

  // ── Usage
  app.get('/api/usage', async () => usage.view());

  // ── Statusline: plan usage (rate_limits) pushed by the lead's statusline command.
  app.post('/api/statusline', async (req, reply) => {
    try {
      const body = StatuslineBody.parse(req.body);
      const rl = body.rate_limits;
      const recorded = !!rl && !!(rl.five_hour || rl.seven_day);
      if (recorded) {
        office.recordQuota({
          source: 'rate_limits',
          fiveHourPct: rl!.five_hour?.used_percentage ?? null,
          fiveHourResetsAt: rl!.five_hour?.resets_at ?? null,
          sevenDayPct: rl!.seven_day?.used_percentage ?? null,
          sevenDayResetsAt: rl!.seven_day?.resets_at ?? null
        });
        usage.evaluate();
      }
      return { ok: true, recorded, quota: office.quotaView(), line: statusLine(ctx) };
    } catch (e) {
      return sendError(reply, e);
    }
  });

  // ── Built UI (packages/ui/dist), when present: one URL for everything.
  if (opts.uiDir && fs.existsSync(path.join(opts.uiDir, 'index.html'))) {
    const uiDir = path.resolve(opts.uiDir);
    const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.json': 'application/json' };
    app.get('/*', async (req, reply) => {
      const rel = decodeURIComponent((req.url.split('?')[0] ?? '/').replace(/^\/+/, ''));
      let file = path.resolve(uiDir, rel || 'index.html');
      if (!file.startsWith(uiDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(uiDir, 'index.html');
      reply.header('content-type', types[path.extname(file)] ?? 'application/octet-stream');
      if (!file.endsWith('index.html')) reply.header('cache-control', 'public, max-age=31536000, immutable');
      return reply.send(fs.readFileSync(file));
    });
  }

  return app;
}
