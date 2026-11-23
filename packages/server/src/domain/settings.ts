import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { applyActiveProject, OfficeConfigSchema, projectIdFor } from '../config.js';
import { OfficeError } from './errors.js';
import type { Office } from './office.js';
import type { Retro } from './retro.js';

/** Columns where a card means work in progress: switching project then needs a confirmation. */
const OPEN_COLUMNS = ['TODO', 'TO_DESIGN', 'IN_PROGRESS', 'IN_REVIEW', 'IN_TEST'];

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** What a folder is, for a project: missing (created at activation), a git repo, or a plain folder (refused). */
function inspectRepo(dir: string, mainBranch: string): { state: 'missing' | 'empty' | 'repo'; branches: string[] } {
  if (!fs.existsSync(dir)) return { state: 'missing', branches: [] };
  if (!fs.statSync(dir).isDirectory()) throw new OfficeError('invalid_input', `${dir} n'est pas un dossier.`);
  if (!fs.existsSync(path.join(dir, '.git'))) {
    if (fs.readdirSync(dir).length === 0) return { state: 'empty', branches: [] };
    throw new OfficeError('invalid_input', `${dir} n'est pas un dépôt git. Lance « git init » et fais un premier commit, ou choisis un dossier vide.`);
  }
  let branches: string[] = [];
  try {
    branches = git(dir, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean);
  } catch {
    throw new OfficeError('invalid_input', `Impossible de lire les branches de ${dir}.`);
  }
  if (branches.length && !branches.includes(mainBranch)) {
    throw new OfficeError('invalid_input', `La branche « ${mainBranch} » n'existe pas dans ${dir}. Branches : ${branches.join(', ')}.`);
  }
  return { state: 'repo', branches };
}

/** Models offered in the settings screen (any other model id stays accepted). */
export const MODEL_CHOICES = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  { id: 'claude-fable-5-2', label: 'Fable 5.2' },
  { id: 'opus', label: 'Opus (dernier)' },
  { id: 'sonnet', label: 'Sonnet (dernier)' },
  { id: 'haiku', label: 'Haiku (dernier)' }
];

/** Le créateur's quota comes first: the settings never let the team go past 90 %. */
export const MAX_HARD_CAP_PCT = 90;

const Patch = z.object({
  agents: z.array(z.object({ name: z.string(), model: z.string().trim().min(1).max(64).optional(), share: z.number().positive().max(100).optional() })).optional(),
  quota: z
    .object({
      hardCapPct: z.number().min(1).max(MAX_HARD_CAP_PCT).optional(),
      stopAtPct: z.number().min(1).max(MAX_HARD_CAP_PCT).optional(),
      autoLockBreakRoomPct: z.number().min(1).max(MAX_HARD_CAP_PCT).optional()
    })
    .optional(),
  breakRoom: z.object({ cooldownSeconds: z.number().int().min(0).max(3600).optional(), maxChars: z.number().int().min(40).max(1000).optional() }).optional(),
  retro: z.object({ autoApply: z.boolean().optional() }).optional()
});
export type SettingsPatch = z.infer<typeof Patch>;

const NewProject = z.object({ name: z.string().trim().min(1).max(60), repoPath: z.string().trim().min(1).max(400), mainBranch: z.string().trim().min(1).max(100).default('main') });

export interface SettingsDeps {
  /** Moves the retrospective agreements file along with the team. */
  retro?: Retro;
  /** office.config.json, rewritten on save (relative paths kept as written). */
  configFile: string;
  /** scripts/setup-team.mjs: regenerates the team's agent files after a model change. null = skip. */
  setupScript: string | null;
}

interface RawProject {
  id: string;
  name: string;
  repoPath: string;
  mainBranch?: string;
}

interface RawAgent {
  name: string;
  model: string;
  share: number;
  [k: string]: unknown;
}

/**
 * Application settings edited from the UI: model and share of each member, quota thresholds,
 * break room and retrospective. Saved to office.config.json and applied at once; a model change
 * only reaches the agents at the team's next launch.
 */
export class Settings {
  constructor(
    private readonly office: Office,
    private readonly deps: SettingsDeps
  ) {}

  view() {
    const cfg = this.office.config;
    const shares = this.office.shares();
    return {
      agents: cfg.agents.map((a) => ({ name: a.name, role: a.role, capabilities: a.capabilities, model: a.model, share: a.share, effectiveShare: shares[a.name] ?? a.share })),
      quota: { hardCapPct: cfg.quota.hardCapPct, stopAtPct: cfg.quota.stopAtPct, autoLockBreakRoomPct: cfg.quota.autoLockBreakRoomPct },
      breakRoom: { cooldownSeconds: cfg.breakRoom.cooldownSeconds, maxChars: cfg.breakRoom.maxChars },
      retro: { autoApply: cfg.retro.autoApply },
      models: MODEL_CHOICES,
      maxHardCapPct: MAX_HARD_CAP_PCT
    };
  }

  async update(input: unknown) {
    const patch = Patch.parse(input);
    const raw = JSON.parse(fs.readFileSync(this.deps.configFile, 'utf8')) as { agents: RawAgent[]; quota: Record<string, unknown>; breakRoom: Record<string, unknown>; retro?: Record<string, unknown> };
    const before = { models: Object.fromEntries(raw.agents.map((a) => [a.name, a.model])), shares: Object.fromEntries(raw.agents.map((a) => [a.name, a.share])) };

    for (const p of patch.agents ?? []) {
      const a = raw.agents.find((x) => x.name === p.name);
      if (!a) throw new OfficeError('unknown_agent', `Agent inconnu : ${p.name}.`);
      if (p.model !== undefined) a.model = p.model;
      if (p.share !== undefined) a.share = Math.round(p.share * 100) / 100;
    }
    Object.assign(raw.quota, patch.quota ?? {});
    Object.assign(raw.breakRoom, patch.breakRoom ?? {});
    if (patch.retro) raw.retro = { ...(raw.retro ?? {}), ...patch.retro };

    const q = raw.quota as { hardCapPct: number; stopAtPct: number; autoLockBreakRoomPct: number };
    if ((q.hardCapPct ?? 90) > MAX_HARD_CAP_PCT) throw new OfficeError('invalid_input', `Le plafond ne dépasse jamais ${MAX_HARD_CAP_PCT} %.`);
    if (q.autoLockBreakRoomPct > q.stopAtPct) throw new OfficeError('invalid_input', 'La fermeture de la salle de pause doit arriver avant l\'arrêt (seuil plus bas).');
    const parsed = OfficeConfigSchema.safeParse(raw);
    if (!parsed.success) throw new OfficeError('invalid_input', parsed.error.issues.map((i) => i.message).join(' ; '));

    fs.writeFileSync(this.deps.configFile, JSON.stringify(raw, null, 2) + '\n', 'utf8');

    // Apply in memory.
    const cfg = this.office.config;
    for (const a of cfg.agents) {
      const r = raw.agents.find((x) => x.name === a.name)!;
      a.model = r.model;
      a.share = r.share;
    }
    Object.assign(cfg.quota, parsed.data.quota);
    Object.assign(cfg.breakRoom, parsed.data.breakRoom);
    cfg.retro.autoApply = parsed.data.retro.autoApply;
    const sharesChanged = raw.agents.some((a) => before.shares[a.name] !== a.share);
    this.office.applyAgentSettings({ resetShareOverrides: sharesChanged, sharesBefore: before.shares });

    const modelsChanged = raw.agents.filter((a) => before.models[a.name] !== a.model).map((a) => a.name);
    const setup = modelsChanged.length ? await this.regenerateTeam() : null;
    this.office.bus.publish('settings', { modelsChanged, sharesChanged }, this.office.clockNow());
    return { ok: true, settings: this.view(), modelsChanged, sharesChanged, setup };
  }

  // ───────────── Projects

  private readRaw() {
    return JSON.parse(fs.readFileSync(this.deps.configFile, 'utf8')) as { team: { repoPath: string; activeProject?: string; [k: string]: unknown }; projects?: RawProject[]; [k: string]: unknown };
  }

  /** The file has no project list yet: write down the one the server made up from team.repoPath. */
  private rawProjects(raw: ReturnType<Settings['readRaw']>): RawProject[] {
    if (!raw.projects?.length) {
      raw.projects = this.office.config.projects.map((p) => ({ id: p.id, name: p.name, repoPath: p.repoPath, mainBranch: p.mainBranch }));
    }
    return raw.projects;
  }

  private save(raw: unknown) {
    const parsed = OfficeConfigSchema.safeParse(raw);
    if (!parsed.success) throw new OfficeError('invalid_input', parsed.error.issues.map((i) => i.message).join(' ; '));
    fs.writeFileSync(this.deps.configFile, JSON.stringify(raw, null, 2) + '\n', 'utf8');
  }

  addProject(input: unknown) {
    const p = NewProject.parse(input);
    const repoPath = path.resolve(path.dirname(this.deps.configFile), p.repoPath);
    const cfg = this.office.config;
    if (cfg.projects.some((x) => path.resolve(x.repoPath).toLowerCase() === repoPath.toLowerCase())) {
      throw new OfficeError('invalid_input', 'Ce dossier est déjà un projet de l\'équipe.');
    }
    const repo = inspectRepo(repoPath, p.mainBranch);
    let id = projectIdFor(p.name);
    for (let n = 2; cfg.projects.some((x) => x.id === id); n++) id = `${projectIdFor(p.name)}-${n}`;
    const raw = this.readRaw();
    this.rawProjects(raw).push({ id, name: p.name, repoPath, mainBranch: p.mainBranch });
    this.save(raw);
    cfg.projects.push({ id, name: p.name, repoPath, mainBranch: p.mainBranch });
    this.office.bus.publish('settings', { projectAdded: id }, this.office.clockNow());
    return { ok: true, project: id, folder: repo.state, projects: this.office.projectsView() };
  }

  removeProject(id: string) {
    const cfg = this.office.config;
    const p = cfg.projects.find((x) => x.id === id);
    if (!p) throw new OfficeError('invalid_input', `Projet inconnu : ${id}.`);
    if (id === this.office.activeProject) throw new OfficeError('invalid_input', 'On ne retire pas le projet actif : active d\'abord un autre projet.');
    const view = this.office.projectsView().find((x) => x.id === id)!;
    if (view.cards > 0) throw new OfficeError('invalid_input', `Le projet a encore ${view.cards} carte(s) : il reste dans la liste pour garder leur historique.`);
    const raw = this.readRaw();
    raw.projects = this.rawProjects(raw).filter((x) => x.id !== id);
    this.save(raw);
    cfg.projects.splice(cfg.projects.indexOf(p), 1);
    this.office.bus.publish('settings', { projectRemoved: id }, this.office.clockNow());
    return { ok: true, projects: this.office.projectsView() };
  }

  /**
   * Moves the team to another project: config rewritten, worktrees and permissions installed there
   * by the setup script. The lead session must then be relaunched from the project's folder.
   */
  async activateProject(id: string, opts: { force?: boolean } = {}) {
    const cfg = this.office.config;
    const p = cfg.projects.find((x) => x.id === id);
    if (!p) throw new OfficeError('invalid_input', `Projet inconnu : ${id}.`);
    if (id === this.office.activeProject) throw new OfficeError('invalid_input', `« ${p.name} » est déjà le projet actif.`);
    const open = this.office.listBoard().filter((c) => OPEN_COLUMNS.includes(c.column)).reduce((s, c) => s + c.cards.length, 0);
    if (open > 0 && !opts.force) {
      throw new OfficeError('work_first', `${open} carte(s) du projet actif sont en cours : elles attendront son retour. Confirme pour changer quand même.`, { openCards: open });
    }
    inspectRepo(p.repoPath, p.mainBranch);

    const raw = this.readRaw();
    const rp = this.rawProjects(raw).find((x) => x.id === id)!;
    raw.team.activeProject = id;
    raw.team.repoPath = rp.repoPath;
    this.save(raw);

    const previous = cfg.team.activeProject;
    cfg.team.activeProject = id;
    applyActiveProject(cfg);
    this.office.applyAgentSettings({ resetShareOverrides: false, sharesBefore: {} });
    const setup = await this.regenerateTeam();
    this.deps.retro?.setAgreementsFile(path.join(p.repoPath, '.claude', 'team-agreements.md'));
    this.office.bus.publish('settings', { activeProject: id, previous }, this.office.clockNow());
    return {
      ok: true,
      project: { id: p.id, name: p.name, repoPath: p.repoPath, mainBranch: p.mainBranch },
      setup,
      relaunch: { cwd: p.repoPath, command: 'claude --agent lead --no-chrome' },
      projects: this.office.projectsView()
    };
  }

  /** Rewrites the team's .claude/agents/*.md (model line) through the setup script. */
  private regenerateTeam(): Promise<{ ok: boolean; output: string }> {
    const script = this.deps.setupScript;
    if (!script || !fs.existsSync(script)) return Promise.resolve({ ok: false, output: 'script d\'installation introuvable' });
    return new Promise((resolve) => {
      execFile(process.execPath, [script, '--config', this.deps.configFile], { timeout: 60_000 }, (err, stdout, stderr) => {
        const output = `${stdout}${stderr}`.trim().split('\n').slice(-12).join('\n');
        resolve({ ok: !err, output });
      });
    });
  }
}
