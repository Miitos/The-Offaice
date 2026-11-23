import fs from 'node:fs';
import path from 'node:path';
import { transcriptsDirFor } from '../config.js';
import type { Office } from './office.js';

const FIVE_HOURS = 5 * 3600 * 1000;
const RATE_SAMPLE_FRESH_MS = 15 * 60 * 1000;

interface TranscriptUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/**
 * Token usage per agent, read from the team's Claude Code transcripts (JSONL), and the
 * quota guard built on it.
 *
 * Method: the plan-wide % comes from the statusline's rate_limits (source of truth, whole
 * account). It is split between agents in proportion to their weighted tokens in the current
 * 5-hour window. Everything not made by the team (your own sessions…) is therefore charged to
 * the team: the estimate errs on the safe side. Without rate_limits, a weighted-token budget
 * per window (quota.fallbackTokenBudget) is used instead.
 */
export class Usage {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly office: Office) {
    office.registerState('usage', () => this.view());
  }

  private get db() {
    return this.office.db;
  }
  private get cfg() {
    return this.office.config;
  }

  start() {
    if (this.timer) return;
    const tick = () => {
      try {
        // Every project's transcripts: the quota window spans project switches.
        for (const dir of this.transcriptDirs()) this.scanOnce(dir);
        this.evaluate();
      } catch (e) {
        console.error('[usage]', e);
      }
    };
    tick();
    this.timer = setInterval(tick, this.cfg.usage.pollSeconds * 1000);
  }

  transcriptDirs(): string[] {
    const cfg = this.cfg;
    if (cfg.usage.transcriptsDirFixed) return [cfg.usage.transcriptsDir!];
    return [...new Set([cfg.usage.transcriptsDir!, ...cfg.projects.map((p) => transcriptsDirFor(p.repoPath))])];
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ───────────── weights

  modelWeight(model: string | null | undefined): number {
    const w = this.cfg.usage.modelWeights;
    const m = (model ?? '').toLowerCase();
    for (const [family, weight] of Object.entries(w)) if (family !== 'default' && m.includes(family)) return weight;
    return w.default ?? 3;
  }

  weigh(model: string | null | undefined, u: { input: number; output: number; cacheCreation: number; cacheRead: number }): number {
    const t = this.cfg.usage.tokenWeights;
    return this.modelWeight(model) * (u.input * t.input + u.output * t.output + u.cacheCreation * t.cacheCreation + u.cacheRead * t.cacheRead);
  }

  // ───────────── ingestion

  /** Room an agent was in at a given time, from the room history. */
  private roomAt(agent: string, at: number): string {
    const r = this.db.prepare('SELECT to_room FROM room_events WHERE agent = ? AND at <= ? ORDER BY at DESC, id DESC LIMIT 1').get(agent, at) as { to_room: string } | undefined;
    return r?.to_room ?? 'desk';
  }

  /** Records one transcript entry. Repeated chunks of a message keep the highest counts. */
  ingestEntry(fileKey: string, agent: string, entry: any) {
    if (!entry || entry.type !== 'assistant') return false;
    const msg = entry.message;
    const usage: TranscriptUsage | undefined = msg?.usage;
    if (!usage) return false;
    const at = Date.parse(entry.timestamp ?? '') || this.office.clockNow();
    const key = `${fileKey}:${msg.id ?? entry.uuid ?? at}`;
    const u = {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheCreation: usage.cache_creation_input_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0
    };
    const existing = this.db.prepare('SELECT input, output, cache_creation, cache_read FROM usage_records WHERE message_key = ?').get(key) as
      | { input: number; output: number; cache_creation: number; cache_read: number }
      | undefined;
    if (existing) {
      u.input = Math.max(u.input, existing.input);
      u.output = Math.max(u.output, existing.output);
      u.cacheCreation = Math.max(u.cacheCreation, existing.cache_creation);
      u.cacheRead = Math.max(u.cacheRead, existing.cache_read);
    }
    const weighted = this.weigh(msg.model, u);
    const inBreak = this.roomAt(agent, at) === 'break' ? 1 : 0;
    this.db
      .prepare(
        `INSERT INTO usage_records (message_key, agent, at, model, input, output, cache_creation, cache_read, weighted, in_break)
         VALUES (@key, @agent, @at, @model, @input, @output, @cacheCreation, @cacheRead, @weighted, @inBreak)
         ON CONFLICT(message_key) DO UPDATE SET input=excluded.input, output=excluded.output, cache_creation=excluded.cache_creation,
           cache_read=excluded.cache_read, weighted=excluded.weighted`
      )
      .run({ key, agent, at, model: msg.model ?? null, ...u, weighted, inBreak });
    return true;
  }

  /** Which agent a transcript belongs to: main session = lead; teammates by their meta.json name. */
  private agentForFile(file: string): string {
    const lead = this.cfg.team.leadAgent;
    if (path.basename(path.dirname(file)) !== 'subagents') return lead;
    const meta = file.replace(/\.jsonl$/, '.meta.json');
    try {
      const m = JSON.parse(fs.readFileSync(meta, 'utf8')) as { name?: string; agentType?: string };
      for (const candidate of [m.name, m.agentType]) if (candidate && this.office.isAgent(candidate)) return candidate;
    } catch {
      /* meta not written yet */
    }
    // A plain subagent (Explore…) started by someone: charged to the lead, who runs the session.
    return lead;
  }

  private listTranscripts(dir: string): string[] {
    const out: string[] = [];
    if (!fs.existsSync(dir)) return out;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
      else if (e.isDirectory()) {
        const sub = path.join(p, 'subagents');
        if (fs.existsSync(sub)) for (const f of fs.readdirSync(sub)) if (f.endsWith('.jsonl')) out.push(path.join(sub, f));
      }
    }
    return out;
  }

  /** Reads what was appended to every transcript since last time. */
  scanOnce(dir = this.cfg.usage.transcriptsDir!) {
    let added = 0;
    for (const file of this.listTranscripts(dir)) {
      const row = this.db.prepare('SELECT offset, agent FROM transcript_offsets WHERE file = ?').get(file) as { offset: number; agent: string | null } | undefined;
      const size = fs.statSync(file).size;
      let offset = row?.offset ?? 0;
      if (size < offset) offset = 0; // file rewritten
      if (size === offset) continue;
      const agent = row?.agent && this.office.isAgent(row.agent) ? row.agent : this.agentForFile(file);
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);
      const text = buf.toString('utf8');
      const lastNl = text.lastIndexOf('\n');
      if (lastNl < 0) continue; // partial line: wait
      const complete = text.slice(0, lastNl);
      this.db.transaction(() => {
        for (const line of complete.split('\n')) {
          if (!line.trim()) continue;
          try {
            if (this.ingestEntry(path.basename(file), agent, JSON.parse(line))) added++;
          } catch {
            /* skip malformed line */
          }
        }
        const newOffset = offset + Buffer.byteLength(complete, 'utf8') + 1;
        this.db
          .prepare('INSERT INTO transcript_offsets (file, offset, agent) VALUES (?, ?, ?) ON CONFLICT(file) DO UPDATE SET offset = excluded.offset, agent = excluded.agent')
          .run(file, newOffset, agent);
      })();
    }
    if (added) this.office.bus.publish('usage', this.view(), this.office.clockNow());
    return added;
  }

  // ───────────── quota maths

  /** Start of the current 5-hour window (from rate_limits.resets_at when known). */
  windowStart(): number {
    const q = this.office.latestQuota();
    const now = this.office.clockNow();
    if (q?.five_hour_resets_at) {
      const resetMs = q.five_hour_resets_at * 1000;
      if (resetMs > now) return resetMs - FIVE_HOURS;
    }
    return now - this.cfg.quota.fallbackTokenBudget.windowHours * 3600 * 1000;
  }

  resetsAt(): number | null {
    const q = this.office.latestQuota();
    return q?.five_hour_resets_at ? q.five_hour_resets_at * 1000 : null;
  }

  private totals(since: number) {
    const rows = this.db
      .prepare('SELECT agent, SUM(weighted) AS w, SUM(CASE WHEN in_break = 1 THEN weighted ELSE 0 END) AS pw, SUM(input + output + cache_creation + cache_read) AS tokens, SUM(CASE WHEN in_break = 1 THEN input + output + cache_creation + cache_read ELSE 0 END) AS ptokens FROM usage_records WHERE at >= ? GROUP BY agent')
      .all(since) as { agent: string; w: number; pw: number; tokens: number; ptokens: number }[];
    const by = new Map(rows.map((r) => [r.agent, r]));
    const team = rows.filter((r) => this.office.isAgent(r.agent)).reduce((s, r) => s + r.w, 0);
    return { by, team };
  }

  private rateLimitsFresh(): boolean {
    const q = this.office.latestQuota();
    return !!q && q.source === 'rate_limits' && this.office.clockNow() - q.at < RATE_SAMPLE_FRESH_MS;
  }

  method(): 'rate_limits' | 'token_budget' | 'none' {
    if (this.cfg.quota.source === 'rate_limits' && this.rateLimitsFresh()) return 'rate_limits';
    if (this.cfg.quota.fallbackTokenBudget.tokens > 0) return 'token_budget';
    return this.office.latestQuota() ? 'rate_limits' : 'none';
  }

  /**
   * Plan % already used in this window before the team's first message (your own sessions…):
   * the first rate_limits sample of the window. Usage outside the team *after* that is still
   * charged to the team (safe side).
   */
  baselinePct(since: number): number {
    const r = this.db
      .prepare("SELECT five_hour_pct AS p FROM quota_samples WHERE source = 'rate_limits' AND at >= ? AND five_hour_pct IS NOT NULL ORDER BY at, id LIMIT 1")
      .get(since) as { p: number } | undefined;
    return r?.p ?? 0;
  }

  /** Plan % used, whole account. */
  globalPct(): number | null {
    const m = this.method();
    if (m === 'token_budget') {
      const { team } = this.totals(this.windowStart());
      return Math.round((team / this.cfg.quota.fallbackTokenBudget.tokens) * 1000) / 10;
    }
    return this.office.globalPct();
  }

  view() {
    const since = this.windowStart();
    const { by, team } = this.totals(since);
    const global = this.globalPct();
    const fiveHour = this.office.latestQuota()?.five_hour_pct ?? null;
    const baseline = this.baselinePct(since);
    const shares = this.office.shares();
    const stopAt = this.cfg.quota.stopAtPct;
    const agents = this.cfg.agents.map((a) => {
      const r = by.get(a.name);
      const w = r?.w ?? 0;
      const pw = r?.pw ?? 0;
      // Quota % this agent consumed (its slice of the 5-hour window).
      // What the team consumed: the window's % minus what was already used when the team started in it.
      const windowPct = this.method() === 'token_budget' ? global : fiveHour === null ? null : Math.max(0, fiveHour - baseline);
      const pctOfQuota = windowPct !== null && team > 0 ? (windowPct * w) / team : 0;
      const limitPct = (shares[a.name]! / 100) * this.cfg.quota.hardCapPct;
      return {
        name: a.name,
        tokens: r?.tokens ?? 0,
        pauseTokens: r?.ptokens ?? 0,
        weighted: Math.round(w),
        pctOfQuota: Math.round(pctOfQuota * 10) / 10,
        /** The agent's allowance, in % of the plan. */
        limitPct: Math.round(limitPct * 10) / 10,
        /** How much of its allowance it used. */
        usedOfSharePct: limitPct > 0 ? Math.round((pctOfQuota / limitPct) * 1000) / 10 : 0,
        /** "dont pause" : share of its consumption spent in the break room. */
        pausePct: w > 0 ? Math.round((pw / w) * 1000) / 10 : 0,
        stopAtPct: Math.round(((shares[a.name]! / 100) * stopAt) * 10) / 10
      };
    });
    return { method: this.method(), windowStart: since, baselinePct: baseline, resetsAt: this.resetsAt(), globalPct: global, teamWeighted: Math.round(team), agents };
  }

  /** Puts agents to rest when their allowance (or the global stop) is reached, wakes them after the reset. */
  evaluate() {
    const v = this.view();
    const stop = this.cfg.quota.stopAtPct;
    const sevenDay = this.office.latestQuota()?.seven_day_pct ?? null;
    const globalStop = (v.globalPct !== null && v.globalPct >= stop) || (sevenDay !== null && sevenDay >= stop);
    const resetLabel = v.resetsAt ? new Date(v.resetsAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : 'le reset';
    for (const a of v.agents) {
      const row = this.office.agentRow(a.name);
      const over = a.pctOfQuota >= a.stopAtPct && a.pctOfQuota > 0;
      if (row.room !== 'rest' && (globalStop || over)) {
        const reason = globalStop ? `quota global à ${v.globalPct ?? sevenDay} % (arrêt à ${stop} %)` : `part atteinte : ${a.pctOfQuota} % du quota pour ${a.stopAtPct} % autorisés`;
        this.office.enterRoom(a.name, 'rest', 'system', `${reason} · reprise vers ${resetLabel}`);
      } else if (row.room === 'rest' && !globalStop && !over) {
        this.office.enterRoom(a.name, 'desk', 'system', 'reset du quota');
      }
    }
    // Fallback mode: feed the break-room auto-lock with the computed %.
    if (v.method === 'token_budget' && v.globalPct !== null && this.office.latestQuota()?.five_hour_pct !== v.globalPct) {
      this.office.recordQuota({ source: 'token_budget', fiveHourPct: v.globalPct });
    }
    return v;
  }

  /** Message for a resting agent (used by hooks). */
  restReason(agent: string): string | null {
    const row = this.office.agentRow(agent);
    if (row.room !== 'rest') return null;
    const last = this.db.prepare("SELECT reason FROM room_events WHERE agent = ? AND to_room = 'rest' ORDER BY at DESC, id DESC LIMIT 1").get(agent) as { reason: string | null } | undefined;
    return `Salle de repos : ${last?.reason ?? 'quota atteint'}. Ne fais plus rien jusqu'au reset : termine ton tour sans autre outil.`;
  }
}
