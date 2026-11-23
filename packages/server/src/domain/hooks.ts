import path from 'node:path';
import type { Office } from './office.js';
import type { Retro } from './retro.js';
import type { Usage } from './usage.js';

/** Claude Code hook input (only the fields we use). */
export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  agent_id?: string;
  agent_type?: string;
  teammate_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  [k: string]: unknown;
}

type HookOutput = Record<string, unknown>;

const OFFICE_PREFIX = 'mcp__office__';
/** Coordination tools that stay usable during a retrospective. */
const COORDINATION_TOOLS = new Set(['SendMessage', 'TaskList', 'TaskGet', 'TaskUpdate', 'TaskCreate']);
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
/** Tools that mean "working", so an agent caught using them in the break room is back at its desk. */
const WORK_TOOLS = new Set([...WRITE_TOOLS, 'Bash', 'PowerShell']);
const WEB_TOOLS = new Set(['WebSearch', 'WebFetch']);

function deny(reason: string): HookOutput {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

function short(s: string, n = 70) {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function samePathOrInside(child: string, parent: string): boolean {
  const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p + path.sep.toLowerCase()) || c.startsWith(p + '/');
}

/**
 * Business logic of the Claude Code hooks. The hook script posts the raw input here
 * and prints back whatever JSON this returns.
 */
export class Hooks {
  constructor(
    private readonly office: Office,
    private readonly retro: Retro,
    private readonly usage: Usage
  ) {}

  /** Which office agent fired the hook. */
  identify(p: HookInput): string | null {
    for (const candidate of [p.teammate_name, p.agent_type]) {
      if (typeof candidate !== 'string') continue;
      if (this.office.isAgent(candidate)) return candidate;
      // A teammate respawned while the first one still exists is renamed "dev1-2", "dev1-3"…
      const base = /^(.+)-\d+$/.exec(candidate)?.[1];
      if (base && this.office.isAgent(base)) return base;
    }
    // The main session (no agent_id) is the lead, started with `claude --agent lead`.
    if (!p.agent_id) return this.office.config.team.leadAgent;
    return null;
  }

  handle(event: string, p: HookInput): HookOutput {
    const agent = this.identify(p);
    this.office.recordHook(event, agent, p);
    if (agent && p.agent_id) this.office.touchAgentId(agent, p.agent_id);
    switch (event) {
      case 'PreToolUse':
        return this.preToolUse(agent, p);
      case 'TeammateIdle':
        return this.teammateIdle(agent);
      case 'Stop':
        return this.stop(agent, p);
      default:
        return {};
    }
  }

  private preToolUse(agent: string | null, p: HookInput): HookOutput {
    const tool = p.tool_name ?? '';
    const input = (p.tool_input ?? {}) as Record<string, unknown>;
    const isOffice = tool.startsWith(OFFICE_PREFIX);

    if (!agent) {
      // A plain subagent we can't attribute: it may work, but not speak for an agent.
      return isOffice ? deny('The OffAIce : identité inconnue pour cet appel (sous-agent). Seuls les membres de l’équipe utilisent les outils office.') : {};
    }

    // 1. Quota: a resting agent does nothing.
    const rest = this.usage.restReason(agent);
    if (rest) return deny(rest);

    // 2. Retrospective: everyone in the meeting room, no work.
    if (this.office.isRetroOpen() && !isOffice && !COORDINATION_TOOLS.has(tool)) {
      return deny('Rétrospective en cours : le travail est suspendu. Rejoins la discussion avec mcp__office__retro_status puis retro_post / retro_propose / retro_vote.');
    }

    const room = this.office.agentRow(agent).room;

    // 3. Break room: no web research for chit-chat.
    if (room === 'break' && WEB_TOOLS.has(tool)) {
      return deny('Pas de recherche web en salle de pause : parle de ce que tu sais, et précise quand une info d’actu peut dater.');
    }

    // 4. Nobody pokes the office server from a shell (lock, retro, quota…).
    if ((tool === 'Bash' || tool === 'PowerShell') && typeof input.command === 'string') {
      const port = String(this.office.config.server.port);
      if (new RegExp(`(localhost|127\\.0\\.0\\.1|\\[::1\\]):${port}`).test(input.command) || /\/api\/(break-room|retro|statusline|hooks|tools)/.test(input.command)) {
        return deny('Le serveur The OffAIce ne s’utilise qu’à travers les outils mcp__office__*.');
      }
    }

    // 5. Devs write only in their own worktree.
    const worktree = this.office.agentRow(agent).worktree;
    if (worktree && WRITE_TOOLS.has(tool)) {
      const target = (input.file_path ?? input.notebook_path) as string | undefined;
      if (typeof target === 'string') {
        const abs = path.isAbsolute(target) ? target : path.resolve(p.cwd ?? worktree, target);
        if (!samePathOrInside(abs, worktree)) {
          return deny(`Tu travailles uniquement dans ton worktree ${worktree} : utilise un chemin absolu sous ce dossier.`);
        }
      }
    }

    // 6. Office tools: inject the caller's identity (the model never chooses it).
    if (isOffice) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: 'The OffAIce',
          updatedInput: { ...input, _office_agent: agent }
        }
      };
    }

    // 7. Room inference + bubble.
    if (WORK_TOOLS.has(tool) && room === 'break') this.office.enterRoom(agent, 'desk', 'hook', `${tool} : retour au travail`);
    const label = this.bubbleFor(tool, input);
    if (label) this.office.setBubble(agent, label);
    return {};
  }

  private bubbleFor(tool: string, input: Record<string, unknown>): string | null {
    const file = (input.file_path ?? input.notebook_path ?? input.path) as string | undefined;
    switch (tool) {
      case 'Edit':
      case 'MultiEdit':
      case 'Write':
      case 'Read':
      case 'NotebookEdit':
        return file ? `${tool} ${path.basename(file)}` : tool;
      case 'Bash':
      case 'PowerShell':
        return typeof input.command === 'string' ? `${tool} ${short(input.command, 60)}` : tool;
      case 'Grep':
      case 'Glob':
        return typeof input.pattern === 'string' ? `${tool} ${short(input.pattern, 50)}` : tool;
      case 'SendMessage':
        return typeof input.to === 'string' ? `Message à ${input.to}` : 'Message';
      default:
        return tool ? short(tool, 40) : null;
    }
  }

  /** Teammate about to go idle: keep it going for the retro, or to answer in the break room. */
  private teammateIdle(agent: string | null): HookOutput {
    if (!agent) return {};
    if (this.usage.restReason(agent)) return {};
    const retroNudge = this.retro.nudgeFor(agent);
    if (retroNudge) return { decision: 'block', reason: retroNudge };
    const personaNudge = this.personaNudge(agent);
    if (personaNudge) return { decision: 'block', reason: personaNudge };
    const workNudge = this.workNudge(agent);
    if (workNudge) return { decision: 'block', reason: workNudge };
    const breakNudge = this.breakNudge(agent);
    if (breakNudge) return { decision: 'block', reason: breakNudge };
    return {};
  }

  /** kv-backed "only once" guard. */
  private once(key: string): boolean {
    const done = this.office.db.prepare('SELECT 1 FROM kv WHERE key = ?').get(key);
    if (done) return false;
    this.office.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run(key, String(this.office.clockNow()));
    return true;
  }

  /** Not introduced yet: ask once. */
  private personaNudge(agent: string): string | null {
    if (this.office.agentView(agent).persona) return null;
    if (!this.once(`nudge:persona:${agent}`)) return null;
    return 'Tu ne t’es pas encore présenté : choisis toi-même un prénom, un nom, un film et une musique préférés, puis appelle mcp__office__introduce_self (voir CLAUDE.md).';
  }

  /** Going idle with an active card: remind once per card and column. */
  private workNudge(agent: string): string | null {
    const card = this.office.currentCard(agent);
    if (!card || card.status !== 'active') return null;
    if (!this.once(`nudge:work:${agent}:${card.id}:${card.col}:${card.entered_col_at}`)) return null;
    return `Tu as encore la carte #${card.id} « ${card.title} » en ${card.col} : termine-la et déplace-la (move_card), ou passe-la en BLOCKED avec la raison. Puis préviens le rôle suivant avec SendMessage.`;
  }

  /** Lead's main session about to stop: same retro duty. */
  private stop(agent: string | null, p: HookInput): HookOutput {
    if (!agent || p.agent_id) return {};
    if (p.stop_hook_active === true) return {};
    if (this.usage.restReason(agent)) return {};
    const retroNudge = this.retro.nudgeFor(agent);
    if (retroNudge) return { decision: 'block', reason: retroNudge };
    const personaNudge = this.personaNudge(agent);
    return personaNudge ? { decision: 'block', reason: personaNudge } : {};
  }

  /** Wakes an agent sitting in the break room once per batch of unread messages, when it may answer. */
  private breakNudge(agent: string): string | null {
    const { unread, repliesToMe } = this.office.breakUnreadFor(agent);
    if (!unread.length) return null;
    if (this.office.currentCard(agent)?.status === 'active') return null;
    const last = this.office.agentView(agent).lastBreakPostAt;
    const cooldown = this.office.config.breakRoom.cooldownSeconds * 1000;
    const waitS = last === null ? 0 : Math.ceil((cooldown - (this.office.clockNow() - last)) / 1000);
    const lastId = unread[unread.length - 1]!.id;
    const key = `break:nudge:${agent}`;
    const prev = this.office.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
    if (prev && Number(prev.value) >= lastId) return null;
    this.office.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(lastId));
    const sample = unread
      .slice(-3)
      .map((m) => `${m.author}${m.replyToAuthor ? ` (à ${m.replyToAuthor})` : ''} : « ${short(m.body, 120)} »`)
      .join(' / ');
    return `Salle de pause : ${unread.length} message(s) non lu(s)${repliesToMe ? `, dont ${repliesToMe} réponse(s) pour toi` : ''}. ${sample}. ${waitS > 0 ? `Tu pourras écrire dans ${waitS} s : appelle break_room_wait (il attend pour toi), puis réponds` : 'Réponds'} avec break_room_post (reply_to = id du message) et préviens par SendMessage ceux qu'indique « wake ». Ou retourne au travail si une carte t'attend.`;
  }
}
