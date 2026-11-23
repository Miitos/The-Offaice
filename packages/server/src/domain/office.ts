import { activeProjectOf, ensureProjects, type Capability, type OfficeConfig } from '../config.js';
import type { DB } from '../db.js';
import { EventBus } from '../events.js';
import { OfficeError } from './errors.js';
import { COLUMNS, COLUMN_LABELS, type Column, type Room, cardStatusFor, checkMove, parseColumn } from './rules.js';

export interface Clock {
  now(): number;
}
export const systemClock: Clock = { now: () => Date.now() };

/** 'user' is the human using the UI; every other actor is an agent name. */
export type Actor = string;
export const USER: Actor = 'user';

interface AgentRow {
  name: string;
  role: string;
  capabilities: string;
  model: string;
  share: number;
  worktree: string | null;
  first_name: string | null;
  last_name: string | null;
  favorite_movie: string | null;
  favorite_music: string | null;
  room: Room;
  bubble: string | null;
  bubble_at: number | null;
  agent_id: string | null;
  updated_at: number;
  break_read_id: number | null;
  share_override: number | null;
}

export interface CardRow {
  id: number;
  title: string;
  description: string;
  col: Column;
  assignee: string | null;
  blocked_from: Column | null;
  created_by: string;
  created_at: number;
  updated_at: number;
  entered_col_at: number;
  project: string | null;
}

export interface CommentRow {
  id: number;
  card_id: number;
  at: number;
  author: string;
  kind: 'note' | 'review';
  body: string;
}

export interface CardEventRow {
  id: number;
  card_id: number;
  at: number;
  actor: string;
  kind: 'created' | 'moved' | 'move_refused' | 'assigned' | 'commented';
  from_col: Column | null;
  to_col: Column | null;
  detail: string | null;
}

export interface QuotaInput {
  source: string;
  fiveHourPct?: number | null;
  fiveHourResetsAt?: number | null;
  sevenDayPct?: number | null;
  sevenDayResetsAt?: number | null;
}

const ROOM_ALIASES: Record<string, Room> = {
  desk: 'desk',
  bureau: 'desk',
  office: 'desk',
  meeting: 'meeting',
  reunion: 'meeting',
  réunion: 'meeting',
  break: 'break',
  pause: 'break',
  rest: 'rest',
  repos: 'rest'
};

export const ROOM_LABELS: Record<Room, string> = {
  desk: 'Bureau',
  meeting: 'Salle de meeting',
  break: 'Salle de pause',
  rest: 'Salle de repos'
};

const MAX_TITLE = 200;
const MAX_TEXT = 4000;
const MAX_BUBBLE = 160;
const MAX_PERSONA_FIELD = 120;
const HOOK_EVENTS_KEPT = 20000;
const BREAK_CONVERSATION_WINDOW_MS = 30 * 60 * 1000;
const BREAK_CONVERSATION_LIMIT = 15;
const BREAK_WAKE_MAX_POSTS = 4;
const BREAK_WAIT_MAX_SECONDS = 240;
const BREAK_WAIT_POLL_MS = 2000;
const MAX_TRAIT = 80;
const MAX_TRAITS = 10;
const MAX_OPINION = 280;

/** The human, as the agents call them. */
export const CREATOR = 'creator';
export const CREATOR_LABEL = 'Le créateur';
const CREATOR_ALIASES = ['creator', 'le créateur', 'le createur', 'créateur', 'createur', 'user'];

type TraitKind = 'hobby' | 'dislike';

interface OpinionRow {
  id: number;
  author: string;
  about: string;
  body: string;
  at: number;
}

interface BreakPostRow {
  id: number;
  agent: string;
  at: number;
  body: string;
  reply_to: number | null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

export class Office {
  readonly bus: EventBus;

  constructor(
    readonly db: DB,
    private readonly cfg: OfficeConfig,
    opts: { bus?: EventBus; clock?: Clock } = {}
  ) {
    this.bus = opts.bus ?? new EventBus();
    this.clock = opts.clock ?? systemClock;
    ensureProjects(this.cfg);
    this.syncAgentsFromConfig();
    this.adoptOrphanCards();
  }
  private readonly clock: Clock;

  get config() {
    return this.cfg;
  }

  private now() {
    return this.clock.now();
  }

  clockNow() {
    return this.clock.now();
  }

  // ───────────────────────── Agents ─────────────────────────

  // ───────────────────────── Projects ─────────────────────────

  get activeProject(): string {
    return activeProjectOf(this.cfg).id;
  }

  isProject(id: string) {
    return this.cfg.projects.some((p) => p.id === id);
  }

  projectsView() {
    const counts = this.db.prepare("SELECT project, COUNT(*) AS n, SUM(CASE WHEN col NOT IN ('BACKLOG','DONE') THEN 1 ELSE 0 END) AS open FROM cards GROUP BY project").all() as { project: string; n: number; open: number }[];
    return this.cfg.projects.map((p) => {
      const c = counts.find((x) => x.project === p.id);
      return { id: p.id, name: p.name, repoPath: p.repoPath, mainBranch: p.mainBranch, active: p.id === this.activeProject, cards: c?.n ?? 0, openCards: c?.open ?? 0 };
    });
  }

  /** Cards created before projects existed belong to the project active at the time. */
  private adoptOrphanCards() {
    this.db.prepare('UPDATE cards SET project = ? WHERE project IS NULL').run(this.activeProject);
  }

  private syncAgentsFromConfig() {
    const up = this.db.prepare(
      `INSERT INTO agents (name, role, capabilities, model, share, worktree, updated_at)
       VALUES (@name, @role, @capabilities, @model, @share, @worktree, @now)
       ON CONFLICT(name) DO UPDATE SET role=excluded.role, capabilities=excluded.capabilities,
         model=excluded.model, share=excluded.share, worktree=excluded.worktree`
    );
    const now = this.now();
    this.db.transaction(() => {
      for (const a of this.cfg.agents) {
        up.run({ name: a.name, role: a.role, capabilities: JSON.stringify(a.capabilities), model: a.model, share: a.share, worktree: a.worktree ?? null, now });
      }
    })();
  }

  /** Settings saved from the UI: models and shares rewritten, retro overrides dropped when the shares change. */
  applyAgentSettings(opts: { resetShareOverrides: boolean; sharesBefore: Record<string, number> }) {
    const now = this.now();
    const before = this.shares();
    this.syncAgentsFromConfig();
    if (opts.resetShareOverrides) {
      this.db.prepare('UPDATE agents SET share_override = NULL').run();
      const after = this.shares();
      this.db.prepare("INSERT INTO share_changes (at, source, proposal_id, before, after) VALUES (?, 'settings', NULL, ?, ?)").run(now, JSON.stringify(before), JSON.stringify(after));
      this.bus.publish('shares', { shares: after, source: 'settings' }, now);
    }
  }

  agentRow(name: string): AgentRow {
    const row = this.db.prepare('SELECT * FROM agents WHERE name = ?').get(name) as AgentRow | undefined;
    if (!row || !this.cfg.agents.some((a) => a.name === name)) {
      throw new OfficeError('unknown_agent', `Agent inconnu : « ${name} ». Agents connus : ${this.cfg.agents.map((a) => a.name).join(', ')}.`);
    }
    return row;
  }

  caps(name: string): Capability[] {
    if (name === USER) return [];
    return JSON.parse(this.agentRow(name).capabilities) as Capability[];
  }

  isAgent(name: string): boolean {
    return this.cfg.agents.some((a) => a.name === name);
  }

  private assertActor(actor: Actor) {
    if (actor !== USER) this.agentRow(actor);
  }

  introduceSelf(agent: string, input: { first_name?: unknown; last_name?: unknown; favorite_movie?: unknown; favorite_music?: unknown }) {
    this.agentRow(agent);
    const p = {
      first_name: str(input.first_name),
      last_name: str(input.last_name),
      favorite_movie: str(input.favorite_movie),
      favorite_music: str(input.favorite_music)
    };
    for (const [k, v] of Object.entries(p)) {
      if (!v) throw new OfficeError('invalid_input', `Champ « ${k} » manquant.`);
      if (v.length > MAX_PERSONA_FIELD) throw new OfficeError('too_long', `Champ « ${k} » trop long (${v.length} > ${MAX_PERSONA_FIELD}).`);
    }
    const taken = this.db
      .prepare('SELECT name, first_name FROM agents WHERE name != ? AND first_name IS NOT NULL')
      .all(agent) as { name: string; first_name: string }[];
    const clash = taken.find((t) => t.first_name.localeCompare(p.first_name, 'fr', { sensitivity: 'base' }) === 0);
    if (clash) {
      throw new OfficeError('name_taken', `Le prénom « ${p.first_name} » est déjà pris par ${clash.name}. Prénoms déjà pris : ${taken.map((t) => t.first_name).join(', ')}. Choisis-en un autre.`, {
        taken: taken.map((t) => t.first_name)
      });
    }
    this.db
      .prepare('UPDATE agents SET first_name=@first_name, last_name=@last_name, favorite_movie=@favorite_movie, favorite_music=@favorite_music, updated_at=@now WHERE name=@agent')
      .run({ ...p, agent, now: this.now() });
    const view = this.agentView(agent);
    this.bus.publish('agent', view, this.now());
    return view;
  }

  setBubble(agent: string, text: string) {
    this.agentRow(agent);
    const t = text.replace(/\s+/g, ' ').trim().slice(0, MAX_BUBBLE);
    const now = this.now();
    this.db.prepare('UPDATE agents SET bubble=?, bubble_at=?, updated_at=? WHERE name=?').run(t, now, now, agent);
    this.bus.publish('agent', { name: agent, bubble: t, bubble_at: now }, now);
  }

  touchAgentId(agent: string, agentId: string) {
    this.db.prepare('UPDATE agents SET agent_id=? WHERE name=? AND (agent_id IS NULL OR agent_id != ?)').run(agentId, agent, agentId);
  }

  /** The card the agent is on: an active one first, else one it waits on. */
  currentCard(agent: string): (CardRow & { status: 'active' | 'waiting' }) | null {
    const caps = this.caps(agent);
    const cards = this.db.prepare('SELECT * FROM cards WHERE assignee = ? AND project = ? ORDER BY updated_at DESC').all(agent, this.activeProject) as CardRow[];
    let waiting: (CardRow & { status: 'waiting' }) | null = null;
    for (const c of cards) {
      const s = cardStatusFor(c.col, caps);
      if (s === 'active') return { ...c, status: 'active' };
      if (s === 'waiting' && !waiting) waiting = { ...c, status: 'waiting' };
    }
    return waiting;
  }

  agentView(name: string) {
    const r = this.agentRow(name);
    const card = this.currentCard(name);
    return {
      name: r.name,
      role: r.role,
      capabilities: JSON.parse(r.capabilities) as Capability[],
      model: r.model,
      share: r.share_override ?? r.share,
      configShare: r.share,
      worktree: r.worktree,
      persona: r.first_name
        ? { firstName: r.first_name, lastName: r.last_name, favoriteMovie: r.favorite_movie, favoriteMusic: r.favorite_music }
        : null,
      room: r.room,
      bubble: r.bubble,
      bubbleAt: r.bubble_at,
      agentId: r.agent_id,
      currentCard: card ? { id: card.id, title: card.title, col: card.col, status: card.status } : null,
      lastBreakPostAt: this.lastBreakPostAt(name),
      hobbies: this.traits(name, 'hobby'),
      dislikes: this.traits(name, 'dislike')
    };
  }

  listAgents() {
    return this.cfg.agents.map((a) => this.agentView(a.name));
  }

  // ───────────────────────── Social life ─────────────────────────

  private traits(agent: string, kind: TraitKind): string[] {
    return (this.db.prepare('SELECT label FROM agent_traits WHERE agent = ? AND kind = ? AND removed_at IS NULL ORDER BY added_at, id').all(agent, kind) as { label: string }[]).map(
      (r) => r.label
    );
  }

  /** Social edits happen during conversations, i.e. from the break room. */
  private assertInBreakRoom(agent: string, what: string) {
    const row = this.agentRow(agent);
    if (row.room !== 'break') throw new OfficeError('not_in_room', `${what} se fait pendant les conversations, en salle de pause.`);
    if (this.isBreakLocked()) throw new OfficeError('break_room_locked', 'Salle de pause fermée. Retourne au bureau ou en meeting.');
  }

  updateProfile(agent: string, input: { add_hobbies?: string[]; remove_hobbies?: string[]; add_dislikes?: string[]; remove_dislikes?: string[] }) {
    this.assertInBreakRoom(agent, 'Modifier ton profil');
    const now = this.now();
    const clean = (xs: string[] | undefined) => (xs ?? []).map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const same = (a: string, b: string) => a.localeCompare(b, 'fr', { sensitivity: 'base' }) === 0;
    this.db.transaction(() => {
      for (const [kind, add, remove] of [
        ['hobby', clean(input.add_hobbies), clean(input.remove_hobbies)],
        ['dislike', clean(input.add_dislikes), clean(input.remove_dislikes)]
      ] as const) {
        for (const label of remove) {
          const hit = (this.db.prepare('SELECT id, label FROM agent_traits WHERE agent = ? AND kind = ? AND removed_at IS NULL').all(agent, kind) as { id: number; label: string }[]).find((t) =>
            same(t.label, label)
          );
          if (hit) this.db.prepare('UPDATE agent_traits SET removed_at = ? WHERE id = ?').run(now, hit.id);
        }
        for (const label of add) {
          if (label.length > MAX_TRAIT) throw new OfficeError('too_long', `« ${label.slice(0, 30)}… » est trop long (${label.length} > ${MAX_TRAIT}).`);
          const current = this.traits(agent, kind);
          if (current.some((c) => same(c, label))) continue;
          if (current.length >= MAX_TRAITS) {
            throw new OfficeError('too_long', `${MAX_TRAITS} ${kind === 'hobby' ? 'hobbies' : '« n\'aime pas »'} au maximum : retire-en un d'abord.`);
          }
          this.db.prepare('INSERT INTO agent_traits (agent, kind, label, added_at) VALUES (?, ?, ?, ?)').run(agent, kind, label, now);
        }
      }
    })();
    const view = this.agentView(agent);
    this.bus.publish('profile', { agent, hobbies: view.hobbies, dislikes: view.dislikes }, now);
    return { hobbies: view.hobbies, dislikes: view.dislikes };
  }

  parseAbout(input: string): string {
    const v = input.trim();
    if (CREATOR_ALIASES.includes(v.toLowerCase())) return CREATOR;
    if (this.isAgent(v)) return v;
    const byFirstName = (this.db.prepare('SELECT name, first_name FROM agents WHERE first_name IS NOT NULL').all() as { name: string; first_name: string }[]).find(
      (a) => this.isAgent(a.name) && a.first_name.localeCompare(v, 'fr', { sensitivity: 'base' }) === 0
    );
    if (byFirstName) return byFirstName.name;
    throw new OfficeError('unknown_agent', `Personne ne s'appelle « ${input} ». Avis possibles : un membre de l'équipe (nom ou prénom) ou "creator" (Le créateur).`);
  }

  setOpinion(agent: string, aboutInput: string, body: string) {
    this.assertInBreakRoom(agent, 'Donner ton avis');
    const about = this.parseAbout(aboutInput);
    if (about === agent) throw new OfficeError('invalid_input', 'Pas d\'avis sur toi-même : ça, c\'est ton profil (update_profile).');
    const text = str(body);
    if (!text) throw new OfficeError('invalid_input', 'Avis vide.');
    if ([...text].length > MAX_OPINION) throw new OfficeError('too_long', `Avis trop long : ${[...text].length} caractères, ${MAX_OPINION} maximum.`);
    const now = this.now();
    const info = this.db.prepare('INSERT INTO opinions (author, about, body, at) VALUES (?, ?, ?, ?)').run(agent, about, text, now);
    const row = this.opinionView({ id: Number(info.lastInsertRowid), author: agent, about, body: text, at: now });
    this.bus.publish('opinion', row, now);
    return row;
  }

  private opinionView(o: OpinionRow) {
    return {
      id: o.id,
      author: o.author,
      authorName: this.displayName(o.author),
      about: o.about,
      aboutName: o.about === CREATOR ? CREATOR_LABEL : this.displayName(o.about),
      body: o.body,
      at: o.at
    };
  }

  /** Current opinions (latest per author/about pair). */
  currentOpinions(filter: { author?: string; about?: string } = {}) {
    const rows = this.db
      .prepare(
        `SELECT o.* FROM opinions o
         JOIN (SELECT author, about, MAX(id) AS id FROM opinions GROUP BY author, about) last ON last.id = o.id
         WHERE (@author IS NULL OR o.author = @author) AND (@about IS NULL OR o.about = @about)
         ORDER BY o.about, o.author`
      )
      .all({ author: filter.author ?? null, about: filter.about ?? null }) as OpinionRow[];
    return rows.filter((r) => this.isAgent(r.author)).map((r) => this.opinionView(r));
  }

  opinionHistory(author: string, about: string) {
    return (this.db.prepare('SELECT * FROM opinions WHERE author = ? AND about = ? ORDER BY at, id').all(author, about) as OpinionRow[]).map((r) => this.opinionView(r));
  }

  /**
   * What an agent can know about its teammates: personas, hobbies, dislikes (public),
   * plus the opinions it wrote itself. Others' opinions stay private: they can only be told in conversation.
   */
  teamProfiles(agent: string) {
    this.agentRow(agent);
    const mine = new Map(this.currentOpinions({ author: agent }).map((o) => [o.about, o.body]));
    return {
      you: agent,
      members: this.cfg.agents
        .filter((a) => a.name !== agent)
        .map((a) => {
          const v = this.agentView(a.name);
          return { name: v.name, role: v.role, persona: v.persona, hobbies: v.hobbies, dislikes: v.dislikes, yourOpinion: mine.get(v.name) ?? null };
        }),
      creator: { name: CREATOR_LABEL, about: CREATOR, yourOpinion: mine.get(CREATOR) ?? null }
    };
  }

  /** An agent's view on how clear / detailed a requested task is. Allowed at any time. */
  rateCard(agent: string, cardId: number, clarity: number, comment: string) {
    this.agentRow(agent);
    const card = this.cardRow(cardId);
    if (!Number.isInteger(clarity) || clarity < 1 || clarity > 5) throw new OfficeError('invalid_input', 'clarity est une note entière de 1 (très flou) à 5 (parfaitement clair).');
    const text = str(comment);
    if (!text) throw new OfficeError('invalid_input', 'Explique ta note en une phrase (ce qui manque ou ce qui est bien précisé).');
    if ([...text].length > MAX_OPINION) throw new OfficeError('too_long', `Commentaire trop long : ${[...text].length} caractères, ${MAX_OPINION} maximum.`);
    const now = this.now();
    const info = this.db.prepare('INSERT INTO card_feedback (card_id, author, clarity, comment, at) VALUES (?, ?, ?, ?, ?)').run(card.id, agent, clarity, text, now);
    const row = { id: Number(info.lastInsertRowid), cardId: card.id, cardTitle: card.title, author: agent, authorName: this.displayName(agent), clarity, comment: text, at: now };
    this.bus.publish('card_feedback', row, now);
    return { ...row, summary: this.cardFeedbackSummary(card.id) };
  }

  /** Latest feedback per agent for a card, and the average clarity. */
  cardFeedbackSummary(cardId: number) {
    const rows = this.db
      .prepare(
        `SELECT f.* FROM card_feedback f
         JOIN (SELECT author, MAX(id) AS id FROM card_feedback WHERE card_id = ? GROUP BY author) last ON last.id = f.id
         ORDER BY f.at`
      )
      .all(cardId) as { id: number; card_id: number; author: string; clarity: number; comment: string; at: number }[];
    const items = rows.map((r) => ({ id: r.id, author: r.author, authorName: this.displayName(r.author), clarity: r.clarity, comment: r.comment, at: r.at }));
    return { count: items.length, avgClarity: items.length ? Math.round((items.reduce((s, i) => s + i.clarity, 0) / items.length) * 10) / 10 : null, items };
  }

  /** Everything the human sees in the UI, opinions included. */
  socialView() {
    const opinions = this.currentOpinions();
    return {
      creatorLabel: CREATOR_LABEL,
      members: this.cfg.agents.map((a) => {
        const v = this.agentView(a.name);
        return {
          name: v.name,
          persona: v.persona,
          hobbies: v.hobbies,
          dislikes: v.dislikes,
          opinionsGiven: opinions.filter((o) => o.author === a.name),
          opinionsReceived: opinions.filter((o) => o.about === a.name)
        };
      }),
      aboutCreator: opinions.filter((o) => o.about === CREATOR)
    };
  }

  // ───────────────────────── Cards ─────────────────────────

  private cardRow(id: number): CardRow {
    const row = this.db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as CardRow | undefined;
    if (!row) throw new OfficeError('unknown_card', `Carte #${id} introuvable.`);
    return row;
  }

  private addCardEvent(e: Omit<CardEventRow, 'id'>) {
    const info = this.db
      .prepare('INSERT INTO card_events (card_id, at, actor, kind, from_col, to_col, detail) VALUES (@card_id, @at, @actor, @kind, @from_col, @to_col, @detail)')
      .run(e);
    const row = { id: Number(info.lastInsertRowid), ...e };
    this.bus.publish('card_event', row, e.at);
    return row;
  }

  createCard(actor: Actor, input: { title?: unknown; description?: unknown; column?: unknown; project?: unknown }) {
    this.assertActor(actor);
    // Le créateur may fill another project's BACKLOG; agents always work on the active one.
    const project = actor === USER && typeof input.project === 'string' && input.project ? input.project : this.activeProject;
    if (!this.isProject(project)) throw new OfficeError('invalid_input', `Projet inconnu : ${project}.`);
    const title = str(input.title);
    const description = str(input.description);
    if (!title) throw new OfficeError('invalid_input', 'Le titre de la carte est obligatoire.');
    if (title.length > MAX_TITLE) throw new OfficeError('too_long', `Titre trop long (${title.length} > ${MAX_TITLE}).`);
    if (description.length > MAX_TEXT) throw new OfficeError('too_long', `Description trop longue (${description.length} > ${MAX_TEXT}).`);
    let col: Column = 'BACKLOG';
    if (actor !== USER && input.column !== undefined && input.column !== null && input.column !== '') {
      const parsed = parseColumn(String(input.column));
      if (parsed !== 'BACKLOG' && parsed !== 'TODO') {
        throw new OfficeError('invalid_input', 'Une nouvelle carte se crée en BACKLOG ou en TODO.');
      }
      col = parsed;
    }
    const now = this.now();
    return this.db.transaction(() => {
      const info = this.db
        .prepare('INSERT INTO cards (title, description, col, created_by, created_at, updated_at, entered_col_at, project) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(title, description, col, actor, now, now, now, project);
      const card = this.cardRow(Number(info.lastInsertRowid));
      this.addCardEvent({ card_id: card.id, at: now, actor, kind: 'created', from_col: null, to_col: col, detail: null });
      this.bus.publish('card', card, now);
      return card;
    })();
  }

  private hasReviewSince(cardId: number, since: number): boolean {
    const rows = this.db.prepare("SELECT author FROM comments WHERE card_id = ? AND kind = 'review' AND at >= ?").all(cardId, since) as { author: string }[];
    return rows.some((r) => this.isAgent(r.author) && this.caps(r.author).includes('reviewer'));
  }

  /**
   * Who should act next on a card, and the message to send them. Idle teammates only wake up
   * on a message (SendMessage), so the agent that moves a card hands it over explicitly.
   */
  handoffFor(card: CardRow): { to: string[]; message: string } | null {
    const byCap = (cap: Capability) => this.cfg.agents.filter((a) => a.capabilities.includes(cap)).map((a) => a.name);
    const t = `carte #${card.id} « ${card.title} »`;
    const assigneeIs = (cap: Capability) => !!card.assignee && this.isAgent(card.assignee) && this.caps(card.assignee).includes(cap);
    switch (card.col) {
      case 'TODO': {
        const designers = byCap('designer');
        return designers.length ? { to: designers, message: `${t} est en TODO : vérifie que la demande est assez claire pour démarrer.` } : null;
      }
      case 'TO_DESIGN':
        if (assigneeIs('designer')) return { to: [card.assignee!], message: `${t} : le design technique est prêt, à toi pour la maquette.` };
        return { to: byCap('architect'), message: `${t} est en TO DESIGN : à toi pour le design.` };
      case 'IN_PROGRESS':
        return card.assignee ? { to: [card.assignee], message: `${t} est en IN PROGRESS pour toi (voir ses commentaires).` } : null;
      case 'IN_REVIEW':
        return { to: byCap('reviewer'), message: `${t} est en IN REVIEW : à relire.` };
      case 'IN_TEST':
        return { to: card.assignee && this.caps(card.assignee).includes('tester') ? [card.assignee] : byCap('tester'), message: `${t} est en IN TEST : à tester.` };
      case 'DONE':
        return { to: byCap('lead'), message: `${t} est DONE : à fusionner dans main.` };
      case 'BLOCKED':
        return { to: byCap('lead'), message: `${t} est BLOCKED : voir la raison sur la carte.` };
      default:
        return null;
    }
  }

  moveCard(actor: Actor, cardId: number, toInput: string, reason?: string) {
    if (actor === USER) throw new OfficeError('system_only', 'Le kanban est en lecture seule depuis l\'UI : seuls les agents déplacent les cartes.');
    this.assertActor(actor);
    const to = parseColumn(toInput);
    if (!to) throw new OfficeError('invalid_input', `Colonne inconnue « ${toInput} ». Colonnes : ${COLUMNS.map((c) => COLUMN_LABELS[c]).join(', ')}.`);
    const card = this.cardRow(cardId);
    this.assertActiveProject(card);
    const now = this.now();
    const check = checkMove({
      from: card.col,
      to,
      blockedFrom: card.blocked_from,
      actorCapabilities: this.caps(actor),
      designerGate: this.cfg.agents.some((a) => a.capabilities.includes('designer')),
      hasReviewSinceEnteredReview: card.col === 'IN_REVIEW' ? this.hasReviewSince(card.id, card.entered_col_at) : false
    });
    if (!check.ok) {
      this.addCardEvent({ card_id: card.id, at: now, actor, kind: 'move_refused', from_col: card.col, to_col: to, detail: check.message });
      throw new OfficeError(check.code, check.message, { card: card.id, from: card.col, to });
    }
    const detail = str(reason).slice(0, MAX_TEXT) || null;
    return this.db.transaction(() => {
      this.db
        .prepare('UPDATE cards SET col=?, blocked_from=?, entered_col_at=?, updated_at=? WHERE id=?')
        .run(to, to === 'BLOCKED' ? card.col : null, now, now, card.id);
      this.addCardEvent({ card_id: card.id, at: now, actor, kind: 'moved', from_col: card.col, to_col: to, detail });
      const updated = this.cardRow(card.id);
      this.bus.publish('card', updated, now);
      return updated;
    })();
  }

  assignCard(actor: Actor, cardId: number, assignee: string | null) {
    if (actor === USER) throw new OfficeError('system_only', 'L\'assignation se fait par les agents.');
    this.assertActor(actor);
    const card = this.cardRow(cardId);
    this.assertActiveProject(card);
    const target = assignee ? str(assignee) : null;
    if (target) this.agentRow(target);
    const now = this.now();
    return this.db.transaction(() => {
      this.db.prepare('UPDATE cards SET assignee=?, updated_at=? WHERE id=?').run(target, now, card.id);
      this.addCardEvent({ card_id: card.id, at: now, actor, kind: 'assigned', from_col: card.col, to_col: card.col, detail: target ?? 'personne' });
      const updated = this.cardRow(card.id);
      this.bus.publish('card', updated, now);
      return updated;
    })();
  }

  commentCard(actor: Actor, cardId: number, body: string, kind: 'note' | 'review' = 'note') {
    // Le créateur answers questions from the UI (plain notes only).
    if (actor === USER && kind !== 'note') throw new OfficeError('system_only', 'Depuis l’UI, seuls les commentaires simples sont possibles.');
    this.assertActor(actor);
    const card = this.cardRow(cardId);
    const text = str(body);
    if (!text) throw new OfficeError('invalid_input', 'Le commentaire est vide.');
    if (text.length > MAX_TEXT) throw new OfficeError('too_long', `Commentaire trop long (${text.length} > ${MAX_TEXT}).`);
    if (kind !== 'note' && kind !== 'review') throw new OfficeError('invalid_input', 'kind doit valoir "note" ou "review".');
    if (kind === 'review' && !this.caps(actor).includes('reviewer')) {
      throw new OfficeError('capability_required', 'Seul un agent reviewer peut poster un commentaire de type "review".');
    }
    const now = this.now();
    return this.db.transaction(() => {
      const info = this.db.prepare('INSERT INTO comments (card_id, at, author, kind, body) VALUES (?, ?, ?, ?, ?)').run(card.id, now, actor, kind, text);
      const comment: CommentRow = { id: Number(info.lastInsertRowid), card_id: card.id, at: now, author: actor, kind, body: text };
      this.db.prepare('UPDATE cards SET updated_at=? WHERE id=?').run(now, card.id);
      this.addCardEvent({ card_id: card.id, at: now, actor, kind: 'commented', from_col: card.col, to_col: card.col, detail: kind });
      this.bus.publish('comment', comment, now);
      return comment;
    })();
  }

  /** An agent only moves the active project's cards: the others wait for their project's turn. */
  private assertActiveProject(card: CardRow) {
    if (card.project && card.project !== this.activeProject) {
      const name = this.cfg.projects.find((p) => p.id === card.project)?.name ?? card.project;
      throw new OfficeError('forbidden_transition', `La carte #${card.id} appartient au projet « ${name} », qui n'est pas le projet actif : on n'y touche pas.`);
    }
  }

  listBoard(project = this.activeProject) {
    const cards = this.db
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM comments m WHERE m.card_id = c.id) AS comment_count,
                (SELECT COUNT(*) FROM comments m WHERE m.card_id = c.id AND m.kind = 'review' AND m.at >= c.entered_col_at) AS reviews_in_col
         FROM cards c WHERE c.project = ? ORDER BY c.updated_at DESC`
      )
      .all(project) as (CardRow & { comment_count: number; reviews_in_col: number })[];
    return COLUMNS.map((col) => ({
      column: col,
      label: COLUMN_LABELS[col],
      cards: cards
        .filter((c) => c.col === col)
        .map((c) => ({
          id: c.id,
          project: c.project,
          title: c.title,
          description: c.description,
          assignee: c.assignee,
          blockedFrom: c.blocked_from,
          createdBy: c.created_by,
          createdAt: c.created_at,
          updatedAt: c.updated_at,
          enteredColumnAt: c.entered_col_at,
          commentCount: c.comment_count,
          reviewCommentInColumn: c.reviews_in_col > 0,
          feedback: (({ count, avgClarity }) => ({ count, avgClarity }))(this.cardFeedbackSummary(c.id))
        }))
    }));
  }

  getCard(cardId: number) {
    const card = this.cardRow(cardId);
    const comments = this.db.prepare('SELECT * FROM comments WHERE card_id = ? ORDER BY at, id').all(cardId) as CommentRow[];
    const events = this.db.prepare('SELECT * FROM card_events WHERE card_id = ? ORDER BY at, id').all(cardId) as CardEventRow[];
    return { ...card, comments, events, feedback: this.cardFeedbackSummary(cardId) };
  }

  recentCardEvents(limit = 30) {
    return this.db
      .prepare('SELECT e.*, c.title AS card_title FROM card_events e JOIN cards c ON c.id = e.card_id WHERE c.project = ? ORDER BY e.at DESC, e.id DESC LIMIT ?')
      .all(this.activeProject, limit) as (CardEventRow & { card_title: string })[];
  }

  // ───────────────────────── Rooms ─────────────────────────

  parseRoom(input: string): Room {
    const r = ROOM_ALIASES[input.trim().toLowerCase()];
    if (!r) throw new OfficeError('invalid_input', `Pièce inconnue « ${input} ». Pièces : desk (bureau), meeting, break (pause).`);
    return r;
  }

  /** Throws if the agent may not be in the break room right now. */
  private assertBreakAllowed(agent: string) {
    if (this.isRetroOpen()) throw new OfficeError('retro_in_progress', 'Rétrospective en cours : toute l’équipe est en salle de meeting (retro_status).');
    if (this.isBreakLocked()) throw new OfficeError('break_room_locked', 'Salle de pause fermée. Retourne au bureau ou en meeting.');
    const card = this.currentCard(agent);
    if (card && card.status === 'active') {
      throw new OfficeError('work_first', `Pas de pause : tu as la carte #${card.id} « ${card.title} » en cours (${COLUMN_LABELS[card.col]}). La pause ne passe qu'après le travail.`, {
        card: card.id
      });
    }
  }

  enterRoom(agent: string, roomInput: string, source: 'agent' | 'hook' | 'system' = 'agent', reason?: string) {
    const row = this.agentRow(agent);
    const room = this.parseRoom(roomInput);
    if (source !== 'system') {
      if (room === 'rest') throw new OfficeError('system_only', 'La salle de repos est attribuée automatiquement quand ton quota est atteint.');
      if (row.room === 'rest') throw new OfficeError('resting', 'Tu es en salle de repos : ton quota est atteint, attends le reset de la fenêtre.');
      if (room === 'break') this.assertBreakAllowed(agent);
      if (room !== 'meeting' && this.isRetroOpen()) {
        throw new OfficeError('retro_in_progress', 'Rétrospective en cours : reste en salle de meeting jusqu’à sa clôture (retro_status).');
      }
    }
    if (row.room === room) return this.agentView(agent);
    const now = this.now();
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO room_events (agent, at, from_room, to_room, source, reason) VALUES (?, ?, ?, ?, ?, ?)').run(agent, now, row.room, room, source, reason ?? null);
      this.db.prepare('UPDATE agents SET room=?, updated_at=? WHERE name=?').run(room, now, agent);
    })();
    const view = this.agentView(agent);
    this.bus.publish('room', { agent, from: row.room, to: room, source, reason: reason ?? null }, now);
    return view;
  }

  recentRoomEvents(agent?: string, limit = 30) {
    return agent
      ? this.db.prepare('SELECT * FROM room_events WHERE agent = ? ORDER BY at DESC, id DESC LIMIT ?').all(agent, limit)
      : this.db.prepare('SELECT * FROM room_events ORDER BY at DESC, id DESC LIMIT ?').all(limit);
  }

  // ───────────────────────── Break room ─────────────────────────

  private lastBreakPostAt(agent: string): number | null {
    const r = this.db.prepare('SELECT MAX(at) AS at FROM break_posts WHERE agent = ?').get(agent) as { at: number | null };
    return r.at;
  }

  breakRoomPost(agent: string, body: string, replyTo?: number | null) {
    const row = this.agentRow(agent);
    if (row.room === 'rest') throw new OfficeError('resting', 'Tu es en salle de repos : ton quota est atteint, attends le reset de la fenêtre.');
    this.assertBreakAllowed(agent);
    const text = str(body);
    const max = this.cfg.breakRoom.maxChars;
    if (!text) throw new OfficeError('invalid_input', 'Message vide.');
    if ([...text].length > max) throw new OfficeError('too_long', `Message trop long : ${[...text].length} caractères, ${max} maximum.`, { length: [...text].length, max });
    const now = this.now();
    const last = this.lastBreakPostAt(agent);
    const cooldownMs = this.cfg.breakRoom.cooldownSeconds * 1000;
    if (last !== null && now - last < cooldownMs) {
      const remaining = Math.ceil((cooldownMs - (now - last)) / 1000);
      const m = Math.floor(remaining / 60);
      const s = remaining % 60;
      throw new OfficeError('break_cooldown', `Trop tôt : un message toutes les ${Math.round(cooldownMs / 60000)} min. Prochain message possible dans ${m ? `${m} min ` : ''}${s} s.`, {
        remainingSeconds: remaining
      });
    }
    let parent: BreakPostRow | null = null;
    if (replyTo !== undefined && replyTo !== null) {
      parent = (this.db.prepare('SELECT * FROM break_posts WHERE id = ?').get(replyTo) as BreakPostRow | undefined) ?? null;
      if (!parent) throw new OfficeError('unknown_post', `Message #${replyTo} introuvable en salle de pause.`);
      if (parent.agent === agent) throw new OfficeError('invalid_input', 'Tu ne peux pas te répondre à toi-même : réponds au message d\'un autre agent.');
    }
    if (row.room !== 'break') this.enterRoom(agent, 'break', 'agent', 'message en salle de pause');
    const info = this.db.prepare('INSERT INTO break_posts (agent, at, body, reply_to) VALUES (?, ?, ?, ?)').run(agent, now, text, parent?.id ?? null);
    const post: BreakPostRow = { id: Number(info.lastInsertRowid), agent, at: now, body: text, reply_to: parent?.id ?? null };
    this.markBreakRead(agent);
    this.setBubble(agent, parent ? `@${this.displayName(parent.agent)} ${text}` : text);
    this.bus.publish('break_post', this.breakPostView(post), now);
    return { post: this.breakPostView(post), nextPostAllowedAt: now + cooldownMs, conversation: this.breakConversation(), wake: this.breakWake(agent, parent?.agent ?? null) };
  }

  /**
   * Who to wake after a break-room post. Idle teammates only wake up on a SendMessage:
   * a post alone is read by nobody. A chatty agent (many posts lately) wakes nobody, so a
   * conversation winds down on its own instead of looping forever on the quota.
   */
  private breakWake(agent: string, repliedTo: string | null) {
    const recent = (this.db.prepare('SELECT COUNT(*) AS n FROM break_posts WHERE agent = ? AND at >= ?').get(agent, this.now() - BREAK_CONVERSATION_WINDOW_MS) as { n: number }).n;
    if (recent > BREAK_WAKE_MAX_POSTS) {
      return { to: [] as string[], message: 'Tu as déjà beaucoup parlé en pause : laisse la conversation retomber, ne réveille personne.' };
    }
    const present = (this.db.prepare("SELECT name FROM agents WHERE room = 'break' AND name != ?").all(agent) as { name: string }[]).map((r) => r.name).filter((n) => this.isAgent(n));
    const to = repliedTo && present.includes(repliedTo) ? [repliedTo, ...present.filter((n) => n !== repliedTo)] : present;
    if (!to.length) return { to, message: 'Personne d’autre en pause pour l’instant.' };
    return {
      to,
      message: `Envoie un SendMessage très court à ${to.join(', ')} (par exemple « je t’ai répondu en pause ») : un coéquipier inactif ne voit pas les messages de pause tout seul.`
    };
  }

  /**
   * Waits (server side, cheap for the agent) until it may post again and there is something
   * new to read, or until `maxSeconds`. Stops early if the agent leaves the break room, the
   * room closes, a retro starts or a card becomes active for it.
   */
  async breakRoomWait(agent: string, maxSeconds: number, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))) {
    const row = this.agentRow(agent);
    if (row.room !== 'break') throw new OfficeError('not_in_room', 'Tu n’es pas en salle de pause (enter_room "break").');
    const started = this.now();
    const deadline = started + Math.max(5, Math.min(maxSeconds, BREAK_WAIT_MAX_SECONDS)) * 1000;
    const cooldownMs = this.cfg.breakRoom.cooldownSeconds * 1000;
    let reason = 'timeout';
    for (;;) {
      const now = this.now();
      if (this.agentRow(agent).room !== 'break') { reason = 'left_room'; break; }
      if (this.isBreakLocked()) { reason = 'locked'; break; }
      if (this.isRetroOpen()) { reason = 'retro'; break; }
      if (this.currentCard(agent)?.status === 'active') { reason = 'work'; break; }
      const last = this.lastBreakPostAt(agent);
      const canPost = last === null || now - last >= cooldownMs;
      if (canPost && this.breakUnreadFor(agent).unread.length) { reason = 'ready'; break; }
      if (now >= deadline) break;
      await sleep(Math.min(BREAK_WAIT_POLL_MS, deadline - now));
    }
    const now = this.now();
    const last = this.lastBreakPostAt(agent);
    const { unread, repliesToMe } = this.breakUnreadFor(agent);
    const hint: Record<string, string> = {
      ready: 'Tu peux répondre maintenant (break_room_post avec reply_to).',
      timeout: 'Rien de neuf : tu peux laisser la conversation là.',
      left_room: 'Tu as quitté la salle de pause.',
      locked: 'Salle de pause fermée : retourne au bureau ou en meeting.',
      retro: 'Rétrospective en cours : va en salle de meeting (retro_status).',
      work: 'Une carte t’attend : retourne au travail.'
    };
    return {
      reason,
      hint: hint[reason],
      waitedSeconds: Math.round((now - started) / 1000),
      canPostNow: last === null || now - last >= cooldownMs,
      unread,
      repliesToMe
    };
  }

  /** First name chosen by the agent, else its technical name. */
  displayName(agent: string): string {
    const r = this.db.prepare('SELECT first_name FROM agents WHERE name = ?').get(agent) as { first_name: string | null } | undefined;
    return r?.first_name ?? agent;
  }

  private breakPostView(p: BreakPostRow) {
    const parent = p.reply_to ? (this.db.prepare('SELECT agent FROM break_posts WHERE id = ?').get(p.reply_to) as { agent: string } | undefined) : undefined;
    return {
      id: p.id,
      agent: p.agent,
      author: this.displayName(p.agent),
      at: p.at,
      body: p.body,
      replyTo: p.reply_to,
      replyToAuthor: parent ? this.displayName(parent.agent) : null
    };
  }

  /** Recent conversation, oldest first: what an agent needs to join in. */
  breakConversation(windowMs = BREAK_CONVERSATION_WINDOW_MS, limit = BREAK_CONVERSATION_LIMIT) {
    const since = this.now() - windowMs;
    const rows = this.db.prepare('SELECT * FROM break_posts WHERE at >= ? ORDER BY at DESC, id DESC LIMIT ?').all(since, limit) as BreakPostRow[];
    const present = (this.db.prepare("SELECT name FROM agents WHERE room = 'break'").all() as { name: string }[])
      .filter((a) => this.isAgent(a.name))
      .map((a) => ({ agent: a.name, name: this.displayName(a.name) }));
    return { present, posts: rows.reverse().map((p) => this.breakPostView(p)) };
  }

  /** Lets an agent in the break room read the conversation (marks it read). */
  breakRoomRead(agent: string) {
    const row = this.agentRow(agent);
    if (row.room !== 'break') throw new OfficeError('not_in_room', 'Tu n\'es pas en salle de pause : la conversation ne se lit que sur place (enter_room "break").');
    if (this.isBreakLocked()) throw new OfficeError('break_room_locked', 'Salle de pause fermée. Retourne au bureau ou en meeting.');
    const now = this.now();
    this.markBreakRead(agent);
    const last = this.lastBreakPostAt(agent);
    const cooldownMs = this.cfg.breakRoom.cooldownSeconds * 1000;
    return { ...this.breakConversation(), nextPostAllowedAt: last === null ? now : Math.max(now, last + cooldownMs) };
  }

  /**
   * Messages from others the agent has not seen yet, while it sits in the break room.
   * Used by the TeammateIdle hook (step 3) to wake it up so the conversation goes on.
   */
  breakUnreadFor(agent: string) {
    const row = this.agentRow(agent);
    if (row.room !== 'break' || this.isBreakLocked()) return { unread: [], repliesToMe: 0 };
    const readId = row.break_read_id ?? 0;
    const unread = (this.db.prepare('SELECT * FROM break_posts WHERE agent != ? AND id > ? ORDER BY id').all(agent, readId) as BreakPostRow[]).map((p) =>
      this.breakPostView(p)
    );
    const mine = new Set((this.db.prepare('SELECT id FROM break_posts WHERE agent = ?').all(agent) as { id: number }[]).map((r) => r.id));
    return { unread, repliesToMe: unread.filter((p) => p.replyTo !== null && mine.has(p.replyTo)).length };
  }

  private markBreakRead(agent: string) {
    this.db.prepare('UPDATE agents SET break_read_id = (SELECT MAX(id) FROM break_posts) WHERE name = ?').run(agent);
  }

  recentBreakPosts(limit = 30) {
    return (this.db.prepare('SELECT * FROM break_posts ORDER BY at DESC, id DESC LIMIT ?').all(limit) as BreakPostRow[]).map((p) => this.breakPostView(p));
  }

  isBreakLocked(): boolean {
    const r = this.db.prepare("SELECT value FROM kv WHERE key = 'break_locked'").get() as { value: string } | undefined;
    return r?.value === '1';
  }

  setBreakLock(locked: boolean, actor: 'user' | 'auto' | 'reset', reason?: string) {
    if (this.isBreakLocked() === locked) return { changed: false, locked };
    const now = this.now();
    const evicted: string[] = [];
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO kv (key, value) VALUES ('break_locked', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(locked ? '1' : '0');
      this.db.prepare('INSERT INTO break_lock_events (at, locked, actor, reason) VALUES (?, ?, ?, ?)').run(now, locked ? 1 : 0, actor, reason ?? null);
    })();
    this.bus.publish('break_lock', { locked, actor, reason: reason ?? null }, now);
    if (locked) {
      const inBreak = this.db.prepare("SELECT name FROM agents WHERE room = 'break'").all() as { name: string }[];
      for (const { name } of inBreak) {
        if (!this.isAgent(name)) continue;
        this.enterRoom(name, 'desk', 'system', 'Salle de pause fermée');
        evicted.push(name);
      }
    }
    return { changed: true, locked, evicted };
  }

  breakLockHistory(limit = 20) {
    return (this.db.prepare('SELECT * FROM break_lock_events ORDER BY at DESC, id DESC LIMIT ?').all(limit) as { id: number; at: number; locked: number; actor: string; reason: string | null }[]).map(
      (r) => ({ ...r, locked: r.locked === 1 })
    );
  }

  // ───────────────────────── Quota ─────────────────────────

  recordQuota(q: QuotaInput) {
    const now = this.now();
    const row = {
      at: now,
      source: q.source,
      five_hour_pct: q.fiveHourPct ?? null,
      five_hour_resets_at: q.fiveHourResetsAt ?? null,
      seven_day_pct: q.sevenDayPct ?? null,
      seven_day_resets_at: q.sevenDayResetsAt ?? null
    };
    this.db
      .prepare(
        'INSERT INTO quota_samples (at, source, five_hour_pct, five_hour_resets_at, seven_day_pct, seven_day_resets_at) VALUES (@at, @source, @five_hour_pct, @five_hour_resets_at, @seven_day_pct, @seven_day_resets_at)'
      )
      .run(row);
    this.bus.publish('quota', this.quotaView(), now);

    // Break room auto-lock / auto-unlock.
    const pct = this.globalPct();
    const threshold = this.cfg.quota.autoLockBreakRoomPct;
    if (pct !== null) {
      if (pct >= threshold && !this.isBreakLocked()) {
        this.setBreakLock(true, 'auto', `quota à ${pct} % (seuil ${threshold} %)`);
      } else if (pct < threshold && this.isBreakLocked()) {
        const last = this.breakLockHistory(1)[0];
        if (last && last.locked && last.actor === 'auto') this.setBreakLock(false, 'reset', `quota redescendu à ${pct} %`);
      }
    }
    return row;
  }

  latestQuota() {
    return this.db.prepare('SELECT * FROM quota_samples ORDER BY at DESC, id DESC LIMIT 1').get() as
      | { at: number; source: string; five_hour_pct: number | null; five_hour_resets_at: number | null; seven_day_pct: number | null; seven_day_resets_at: number | null }
      | undefined;
  }

  /** Highest of the known windows: the team must stay under the cap on both. */
  globalPct(): number | null {
    const q = this.latestQuota();
    if (!q) return null;
    const vals = [q.five_hour_pct, q.seven_day_pct].filter((v): v is number => typeof v === 'number');
    return vals.length ? Math.max(...vals) : null;
  }

  quotaView() {
    const q = this.latestQuota();
    return {
      source: this.cfg.quota.source,
      hardCapPct: this.cfg.quota.hardCapPct,
      stopAtPct: this.cfg.quota.stopAtPct,
      autoLockBreakRoomPct: this.cfg.quota.autoLockBreakRoomPct,
      latest: q
        ? {
            at: q.at,
            source: q.source,
            fiveHour: q.five_hour_pct === null ? null : { usedPct: q.five_hour_pct, resetsAt: q.five_hour_resets_at },
            sevenDay: q.seven_day_pct === null ? null : { usedPct: q.seven_day_pct, resetsAt: q.seven_day_resets_at }
          }
        : null,
      globalPct: this.globalPct()
    };
  }

  // ───────────────────────── Hooks ─────────────────────────

  recordHook(event: string, agent: string | null, payload: unknown) {
    const now = this.now();
    const info = this.db.prepare('INSERT INTO hook_events (at, event, agent, payload) VALUES (?, ?, ?, ?)').run(now, event, agent, JSON.stringify(payload));
    const id = Number(info.lastInsertRowid);
    if (id % 1000 === 0) this.db.prepare('DELETE FROM hook_events WHERE id <= ?').run(id - HOOK_EVENTS_KEPT);
    return id;
  }

  // ───────────────────────── Snapshot ─────────────────────────

  /** Extra sections added to the UI snapshot by other modules (retro, usage). */
  private stateExtras = new Map<string, () => unknown>();
  registerState(key: string, fn: () => unknown) {
    this.stateExtras.set(key, fn);
  }

  isRetroOpen(): boolean {
    return !!this.db.prepare("SELECT 1 FROM retros WHERE status = 'open' LIMIT 1").get();
  }

  /** Effective share (% of the team budget) per agent. */
  shares(): Record<string, number> {
    return Object.fromEntries(this.cfg.agents.map((a) => {
      const r = this.agentRow(a.name);
      return [a.name, r.share_override ?? r.share];
    }));
  }

  getState() {
    const extras = Object.fromEntries([...this.stateExtras].map(([k, fn]) => [k, fn()]));
    return {
      ...extras,
      at: this.now(),
      agents: this.listAgents(),
      projects: this.projectsView(),
      activeProject: this.activeProject,
      board: this.listBoard(),
      breakRoom: {
        locked: this.isBreakLocked(),
        history: this.breakLockHistory(),
        posts: this.recentBreakPosts(),
        cooldownSeconds: this.cfg.breakRoom.cooldownSeconds,
        maxChars: this.cfg.breakRoom.maxChars
      },
      quota: this.quotaView(),
      social: this.socialView(),
      recentCardEvents: this.recentCardEvents(),
      recentRoomEvents: this.recentRoomEvents()
    };
  }
}
