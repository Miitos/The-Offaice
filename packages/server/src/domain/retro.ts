import fs from 'node:fs';
import path from 'node:path';
import { OfficeError } from './errors.js';
import type { Office } from './office.js';

type Kind = 'quota' | 'process' | 'other';

interface RetroRow {
  id: number;
  started_at: number;
  started_by: string;
  topic: string | null;
  status: 'open' | 'closed';
  closed_at: number | null;
  closed_by: string | null;
  summary: string | null;
}

interface ProposalRow {
  id: number;
  retro_id: number;
  author: string;
  at: number;
  kind: Kind;
  title: string;
  details: string;
  payload: string | null;
  status: 'open' | 'adopted' | 'rejected';
  applied_at: number | null;
  reverted_at: number | null;
  reverted_by: string | null;
}

const MAX_MESSAGE = 1000;
const MAX_TITLE = 120;
const MAX_DETAILS = 2000;
const MIN_SHARE = 2;

function str(v: unknown) {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Retrospective: the human starts it from the UI, the whole team meets, discusses,
 * proposes changes (quota shares, process, anything) and votes; the lead closes it.
 * Adopted decisions are applied (when retro.autoApply) and can be reverted from the UI.
 * The global cap (quota.hardCapPct) is never something a retro can change.
 */
export class Retro {
  constructor(
    private readonly office: Office,
    private readonly opts: { agreementsFile?: string | null } = {}
  ) {
    office.registerState('retro', () => ({ current: this.currentView(), agreements: this.agreements(), history: this.history(5) }));
  }

  private get db() {
    return this.office.db;
  }
  private now() {
    return this.office.clockNow();
  }

  current(): RetroRow | null {
    return (this.db.prepare("SELECT * FROM retros WHERE status = 'open' ORDER BY id DESC LIMIT 1").get() as RetroRow | undefined) ?? null;
  }

  private requireOpen(): RetroRow {
    const r = this.current();
    if (!r) throw new OfficeError('no_retro', 'Aucune rétrospective en cours.');
    return r;
  }

  private assertParticipant(agent: string) {
    const row = this.office.agentRow(agent);
    if (row.room === 'rest') throw new OfficeError('resting', 'Tu es en salle de repos (quota atteint) : tu ne participes pas à cette rétrospective.');
  }

  start(actor: 'user', topic?: string) {
    if (this.current()) throw new OfficeError('retro_in_progress', 'Une rétrospective est déjà en cours.');
    const now = this.now();
    const info = this.db.prepare("INSERT INTO retros (started_at, started_by, topic, status) VALUES (?, ?, ?, 'open')").run(now, actor, str(topic) || null);
    const id = Number(info.lastInsertRowid);
    for (const a of this.office.config.agents) {
      if (this.office.agentRow(a.name).room !== 'rest') this.office.enterRoom(a.name, 'meeting', 'system', 'Rétrospective');
    }
    this.office.bus.publish('retro', { id, status: 'open', topic: str(topic) || null }, now);
    return this.currentView();
  }

  post(agent: string, body: string, replyTo?: number | null) {
    const retro = this.requireOpen();
    this.assertParticipant(agent);
    const text = str(body);
    if (!text) throw new OfficeError('invalid_input', 'Message vide.');
    if ([...text].length > MAX_MESSAGE) throw new OfficeError('too_long', `Message trop long (${[...text].length} > ${MAX_MESSAGE}).`);
    if (replyTo) {
      const parent = this.db.prepare('SELECT id FROM retro_messages WHERE id = ? AND retro_id = ?').get(replyTo, retro.id);
      if (!parent) throw new OfficeError('unknown_post', `Message #${replyTo} introuvable dans cette rétrospective.`);
    }
    const now = this.now();
    const info = this.db.prepare('INSERT INTO retro_messages (retro_id, agent, at, body, reply_to) VALUES (?, ?, ?, ?, ?)').run(retro.id, agent, now, text, replyTo ?? null);
    this.office.setBubble(agent, text);
    const msg = { id: Number(info.lastInsertRowid), agent, author: this.office.displayName(agent), at: now, body: text, replyTo: replyTo ?? null };
    this.office.bus.publish('retro_message', msg, now);
    return { message: msg, status: this.status(agent) };
  }

  propose(agent: string, input: { kind?: unknown; title?: unknown; details?: unknown; shares?: unknown }) {
    const retro = this.requireOpen();
    this.assertParticipant(agent);
    const kind = str(input.kind) as Kind;
    if (!['quota', 'process', 'other'].includes(kind)) throw new OfficeError('invalid_input', 'kind vaut "quota", "process" ou "other".');
    const title = str(input.title);
    const details = str(input.details);
    if (!title || !details) throw new OfficeError('invalid_input', 'Une proposition a un titre et des détails (le pourquoi et le comment).');
    if (title.length > MAX_TITLE || details.length > MAX_DETAILS) throw new OfficeError('too_long', `Titre ≤ ${MAX_TITLE} car., détails ≤ ${MAX_DETAILS} car.`);
    let payload: string | null = null;
    if (kind === 'quota') payload = JSON.stringify({ shares: this.validateShares(input.shares) });
    const now = this.now();
    const info = this.db
      .prepare("INSERT INTO retro_proposals (retro_id, author, at, kind, title, details, payload, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'open')")
      .run(retro.id, agent, now, kind, title, details, payload);
    const id = Number(info.lastInsertRowid);
    // The author votes for their own proposal.
    this.db.prepare("INSERT INTO retro_votes (proposal_id, agent, vote, at) VALUES (?, ?, 'for', ?)").run(id, agent, now);
    this.office.bus.publish('retro_proposal', { id, kind, title, author: agent }, now);
    return { proposal: this.proposalView(this.proposalRow(id), agent), status: this.status(agent) };
  }

  private validateShares(raw: unknown): Record<string, number> {
    if (!raw || typeof raw !== 'object') throw new OfficeError('invalid_input', 'Une proposition "quota" donne shares = { agent: part en %, ... } pour tous les agents, total 100.');
    const shares: Record<string, number> = {};
    const names = this.office.config.agents.map((a) => a.name);
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!names.includes(k)) throw new OfficeError('unknown_agent', `Agent inconnu dans shares : ${k}. Agents : ${names.join(', ')}.`);
      const n = Number(v);
      if (!Number.isFinite(n) || n < MIN_SHARE) throw new OfficeError('invalid_input', `Part de ${k} invalide : minimum ${MIN_SHARE} %.`);
      shares[k] = Math.round(n * 100) / 100;
    }
    const missing = names.filter((n) => !(n in shares));
    if (missing.length) throw new OfficeError('invalid_input', `shares doit couvrir tous les agents. Manquants : ${missing.join(', ')}.`);
    const total = Object.values(shares).reduce((s, x) => s + x, 0);
    if (Math.abs(total - 100) > 0.01) throw new OfficeError('invalid_input', `Les parts doivent faire 100 au total (actuellement ${total}). Elles se partagent le budget équipe, plafonné à ${this.office.config.quota.hardCapPct} % du quota : ce plafond-là ne change pas.`);
    return shares;
  }

  private proposalRow(id: number): ProposalRow {
    const p = this.db.prepare('SELECT * FROM retro_proposals WHERE id = ?').get(id) as ProposalRow | undefined;
    if (!p) throw new OfficeError('unknown_post', `Proposition #${id} introuvable.`);
    return p;
  }

  vote(agent: string, proposalId: number, vote: 'for' | 'against') {
    const retro = this.requireOpen();
    this.assertParticipant(agent);
    if (vote !== 'for' && vote !== 'against') throw new OfficeError('invalid_input', 'vote vaut "for" ou "against".');
    const p = this.proposalRow(proposalId);
    if (p.retro_id !== retro.id || p.status !== 'open') throw new OfficeError('invalid_input', `La proposition #${proposalId} n'est pas soumise au vote dans cette rétrospective.`);
    const now = this.now();
    this.db
      .prepare('INSERT INTO retro_votes (proposal_id, agent, vote, at) VALUES (?, ?, ?, ?) ON CONFLICT(proposal_id, agent) DO UPDATE SET vote = excluded.vote, at = excluded.at')
      .run(proposalId, agent, vote, now);
    this.office.bus.publish('retro_vote', { proposalId, agent, vote }, now);
    return { proposal: this.proposalView(this.proposalRow(proposalId), agent), status: this.status(agent) };
  }

  private tally(proposalId: number) {
    const rows = this.db.prepare('SELECT agent, vote FROM retro_votes WHERE proposal_id = ?').all(proposalId) as { agent: string; vote: 'for' | 'against' }[];
    return {
      for: rows.filter((r) => r.vote === 'for').map((r) => r.agent),
      against: rows.filter((r) => r.vote === 'against').map((r) => r.agent)
    };
  }

  /** Agents taking part: everyone not resting. */
  participants(): string[] {
    return this.office.config.agents.map((a) => a.name).filter((n) => this.office.agentRow(n).room !== 'rest');
  }

  /** Closes the retro: a proposal is adopted with a strict majority of the participants. */
  close(actor: string, summary?: string) {
    const retro = this.requireOpen();
    if (actor !== 'user' && !this.office.caps(actor).includes('lead')) {
      throw new OfficeError('capability_required', 'Seul le lead (ou le créateur depuis l\'UI) clôt la rétrospective.');
    }
    const now = this.now();
    const participants = this.participants();
    const needed = Math.floor(participants.length / 2) + 1;
    const decisions: { id: number; title: string; kind: Kind; adopted: boolean; for: number; against: number; applied: boolean }[] = [];
    const open = this.db.prepare("SELECT * FROM retro_proposals WHERE retro_id = ? AND status = 'open' ORDER BY id").all(retro.id) as ProposalRow[];
    for (const p of open) {
      const t = this.tally(p.id);
      const adopted = t.for.length >= needed && t.for.length > t.against.length;
      this.db.prepare('UPDATE retro_proposals SET status = ? WHERE id = ?').run(adopted ? 'adopted' : 'rejected', p.id);
      let applied = false;
      if (adopted && this.office.config.retro.autoApply) {
        this.apply(p, now);
        applied = true;
      }
      decisions.push({ id: p.id, title: p.title, kind: p.kind, adopted, for: t.for.length, against: t.against.length, applied });
    }
    this.db.prepare("UPDATE retros SET status = 'closed', closed_at = ?, closed_by = ?, summary = ? WHERE id = ?").run(now, actor, str(summary) || null, retro.id);
    for (const name of participants) {
      if (this.office.agentRow(name).room === 'meeting') this.office.enterRoom(name, 'desk', 'system', 'Fin de la rétrospective');
    }
    this.writeAgreementsFile();
    this.office.bus.publish('retro', { id: retro.id, status: 'closed', decisions }, now);
    return { retro: retro.id, participants, majority: needed, decisions, shares: this.office.shares(), agreements: this.agreements() };
  }

  private apply(p: ProposalRow, now: number) {
    if (p.kind === 'quota') {
      const { shares } = JSON.parse(p.payload ?? '{}') as { shares: Record<string, number> };
      const before = this.office.shares();
      const set = this.db.prepare('UPDATE agents SET share_override = ? WHERE name = ?');
      for (const [name, share] of Object.entries(shares)) set.run(share, name);
      this.db.prepare("INSERT INTO share_changes (at, source, proposal_id, before, after) VALUES (?, 'retro', ?, ?, ?)").run(now, p.id, JSON.stringify(before), JSON.stringify(shares));
      this.office.bus.publish('shares', { shares, proposalId: p.id }, now);
    } else {
      this.db.prepare('INSERT INTO team_agreements (proposal_id, title, text, at) VALUES (?, ?, ?, ?)').run(p.id, p.title, p.details, now);
    }
    this.db.prepare('UPDATE retro_proposals SET applied_at = ? WHERE id = ?').run(now, p.id);
  }

  /** The human undoes an applied decision from the UI. */
  revert(proposalId: number, actor: 'user') {
    const p = this.proposalRow(proposalId);
    if (p.status !== 'adopted' || !p.applied_at) throw new OfficeError('invalid_input', `La proposition #${proposalId} n'a pas été appliquée.`);
    if (p.reverted_at) throw new OfficeError('invalid_input', `La proposition #${proposalId} est déjà annulée.`);
    const now = this.now();
    if (p.kind === 'quota') {
      const change = this.db.prepare("SELECT * FROM share_changes WHERE proposal_id = ? AND source = 'retro' ORDER BY id DESC LIMIT 1").get(p.id) as { before: string } | undefined;
      if (change) {
        const before = JSON.parse(change.before) as Record<string, number>;
        const current = this.office.shares();
        const set = this.db.prepare('UPDATE agents SET share_override = ? WHERE name = ?');
        for (const a of this.office.config.agents) set.run(before[a.name] === a.share ? null : (before[a.name] ?? null), a.name);
        this.db.prepare("INSERT INTO share_changes (at, source, proposal_id, before, after) VALUES (?, 'revert', ?, ?, ?)").run(now, p.id, JSON.stringify(current), JSON.stringify(before));
        this.office.bus.publish('shares', { shares: this.office.shares(), reverted: p.id }, now);
      }
    } else {
      this.db.prepare('UPDATE team_agreements SET active = 0 WHERE proposal_id = ?').run(p.id);
      this.writeAgreementsFile();
    }
    this.db.prepare('UPDATE retro_proposals SET reverted_at = ?, reverted_by = ? WHERE id = ?').run(now, actor, p.id);
    this.office.bus.publish('retro_revert', { proposalId: p.id }, now);
    return this.proposalView(this.proposalRow(p.id));
  }

  agreements() {
    return this.db.prepare('SELECT id, proposal_id AS proposalId, title, text, at FROM team_agreements WHERE active = 1 ORDER BY id').all() as {
      id: number;
      proposalId: number | null;
      title: string;
      text: string;
      at: number;
    }[];
  }

  /** The active project changed: the agreements file moves with the team. */
  setAgreementsFile(file: string | null) {
    this.opts.agreementsFile = file;
    this.writeAgreementsFile();
  }

  /** Written in the team repo and imported by its CLAUDE.md, so new agents read it at spawn. */
  writeAgreementsFile() {
    const file = this.opts.agreementsFile;
    if (!file) return;
    if (!fs.existsSync(path.dirname(file))) return;
    const list = this.agreements();
    const lines = [
      '# Accords d\'équipe',
      '',
      '<!-- Généré par The OffAIce à chaque clôture de rétrospective. Ne pas modifier à la main. -->',
      '',
      list.length ? 'Décisions adoptées en rétrospective. Elles s\'appliquent à toute l\'équipe, au même titre que CLAUDE.md.' : 'Aucun accord pour le moment.',
      '',
      ...list.map((a) => `- **${a.title}** (rétro, décision #${a.proposalId}) : ${a.text.replace(/\s+/g, ' ')}`),
      ''
    ];
    fs.writeFileSync(file, lines.join('\n'), 'utf8');
  }

  private proposalView(p: ProposalRow, forAgent?: string) {
    const t = this.tally(p.id);
    const myVote = forAgent ? (t.for.includes(forAgent) ? 'for' : t.against.includes(forAgent) ? 'against' : null) : undefined;
    return {
      id: p.id,
      kind: p.kind,
      title: p.title,
      details: p.details,
      shares: p.payload ? (JSON.parse(p.payload) as { shares?: Record<string, number> }).shares ?? null : null,
      author: p.author,
      authorName: this.office.displayName(p.author),
      status: p.status,
      votesFor: t.for,
      votesAgainst: t.against,
      ...(forAgent ? { yourVote: myVote } : {}),
      appliedAt: p.applied_at,
      revertedAt: p.reverted_at
    };
  }

  /** What an agent needs to take part. */
  status(agent: string) {
    const retro = this.current();
    if (!retro) return { open: false as const, agreements: this.agreements(), shares: this.office.shares() };
    const messages = (this.db.prepare('SELECT * FROM retro_messages WHERE retro_id = ? ORDER BY id DESC LIMIT 40').all(retro.id) as {
      id: number;
      agent: string;
      at: number;
      body: string;
      reply_to: number | null;
    }[])
      .reverse()
      .map((m) => ({ id: m.id, agent: m.agent, author: this.office.displayName(m.agent), at: m.at, body: m.body, replyTo: m.reply_to }));
    const proposals = (this.db.prepare('SELECT * FROM retro_proposals WHERE retro_id = ? ORDER BY id').all(retro.id) as ProposalRow[]).map((p) => this.proposalView(p, agent));
    const participants = this.participants();
    return {
      open: true as const,
      id: retro.id,
      topic: retro.topic,
      startedAt: retro.started_at,
      participants,
      majority: Math.floor(participants.length / 2) + 1,
      messages,
      proposals,
      you: {
        agent,
        hasSpoken: messages.some((m) => m.agent === agent),
        toVote: proposals.filter((p) => p.status === 'open' && !p.yourVote).map((p) => p.id)
      },
      currentShares: this.office.shares(),
      agreements: this.agreements(),
      howTo:
        'Discute avec retro_post, propose un changement avec retro_propose (quota : parts de chaque agent, total 100 ; process ; other), vote avec retro_vote. Le lead clôt avec retro_close quand chacun a parlé et voté.'
    };
  }

  /**
   * Hook helper: why this agent should keep going instead of going idle, or null.
   * Counted so a stuck agent is not woken up forever.
   */
  nudgeFor(agent: string): string | null {
    const retro = this.current();
    if (!retro) return null;
    const row = this.office.agentRow(agent);
    if (row.room === 'rest') return null;
    const s = this.status(agent);
    if (!s.open) return null;
    const reasons: string[] = [];
    if (!s.you.hasSpoken) reasons.push('tu n\'as pas encore pris la parole (retro_post)');
    if (s.you.toVote.length) reasons.push(`tu n'as pas voté sur ${s.you.toVote.map((id) => '#' + id).join(', ')} (retro_vote)`);
    const isLead = this.office.caps(agent).includes('lead');
    const everyoneDone = s.participants.every((p) => {
      const st = this.status(p);
      return st.open && st.you.hasSpoken && st.you.toVote.length === 0;
    });
    if (isLead && everyoneDone) reasons.push('tout le monde a parlé et voté : clôture avec retro_close et un résumé');
    if (!reasons.length) return null;
    const key = `retro:${retro.id}:nudge:${agent}`;
    const count = Number((this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? 0);
    if (count >= this.office.config.retro.nudgeLimit) return null;
    this.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(count + 1));
    return `Rétrospective en cours${retro.topic ? ` (« ${retro.topic} »)` : ''} : ${reasons.join(' ; ')}. Commence par retro_status.`;
  }

  currentView() {
    const r = this.current();
    if (!r) return null;
    const s = this.status(this.office.config.team.leadAgent);
    return s.open ? { ...s, you: undefined } : null;
  }

  history(limit = 10) {
    const rows = this.db.prepare('SELECT * FROM retros ORDER BY id DESC LIMIT ?').all(limit) as RetroRow[];
    return rows.map((r) => ({
      id: r.id,
      topic: r.topic,
      status: r.status,
      startedAt: r.started_at,
      closedAt: r.closed_at,
      summary: r.summary,
      proposals: (this.db.prepare('SELECT * FROM retro_proposals WHERE retro_id = ? ORDER BY id').all(r.id) as ProposalRow[]).map((p) => this.proposalView(p))
    }));
  }
}
