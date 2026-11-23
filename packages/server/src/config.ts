import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

export const CAPABILITIES = ['lead', 'designer', 'architect', 'dev', 'reviewer', 'tester'] as const;
export type Capability = (typeof CAPABILITIES)[number];

const AgentConfig = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, 'nom en minuscules, sans espace'),
  role: z.string().min(1),
  capabilities: z.array(z.enum(CAPABILITIES)).min(1),
  model: z.string().min(1),
  /** % of the team budget (the team budget itself is quota.hardCapPct of the plan). */
  share: z.number().positive(),
  /**
   * The agent gets its own git worktree (devs). Whatever the value, it lives next to the active
   * project: <project folder>-wt-<agent name>, so it follows a project switch.
   */
  worktree: z.union([z.string(), z.boolean()]).optional()
});

const ProjectConfig = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'identifiant en minuscules, chiffres et tirets'),
  name: z.string().min(1).max(60),
  /** Local git repository (relative to the config file, or absolute). */
  repoPath: z.string().min(1),
  /** Branch the team merges into. */
  mainBranch: z.string().min(1).default('main')
});

export const OfficeConfigSchema = z
  .object({
    server: z.object({
      host: z.string().default('127.0.0.1'),
      port: z.number().int().default(4317),
      dbPath: z.string().default('./data/office.db')
    }),
    team: z
      .object({
        /** Local git repository the team works in. */
        repoPath: z.string().default('../office-team'),
        /** Agent the main session plays (claude --agent lead). */
        leadAgent: z.string().default('lead'),
        /** Project the team works on (id in projects). Its repoPath becomes team.repoPath. */
        activeProject: z.string().optional()
      })
      .default({ repoPath: '../office-team', leadAgent: 'lead' }),
    /** Projects the team can work on, one at a time. Empty: team.repoPath is the only project. */
    projects: z.array(ProjectConfig).default([]),
    quota: z.object({
      source: z.enum(['rate_limits', 'token_budget']).default('rate_limits'),
      hardCapPct: z.number().min(1).max(100).default(90),
      stopAtPct: z.number().min(1).max(100).default(88),
      autoLockBreakRoomPct: z.number().min(1).max(100).default(75),
      /** Used when source = token_budget, or while no rate_limits sample exists. Weighted units per window; 0 = disabled. */
      fallbackTokenBudget: z.object({ windowHours: z.number().positive(), tokens: z.number().min(0) })
    }),
    usage: z
      .object({
        /** Folder holding the team's transcripts. Default: ~/.claude/projects/<encoded repoPath>. */
        transcriptsDir: z.string().optional(),
        /** Set at load: transcriptsDir was given explicitly (it then does not follow the active project). */
        transcriptsDirFixed: z.boolean().optional(),
        pollSeconds: z.number().min(1).default(5),
        /** Relative cost of one token per model family (only ratios matter). */
        modelWeights: z.record(z.string(), z.number().positive()).default({ opus: 5, sonnet: 3, haiku: 1, default: 3 }),
        /** Relative cost per token type (only ratios matter). */
        tokenWeights: z
          .object({ input: z.number(), output: z.number(), cacheCreation: z.number(), cacheRead: z.number() })
          .default({ input: 1, output: 5, cacheCreation: 1.25, cacheRead: 0.1 })
      })
      .default({ pollSeconds: 5, modelWeights: { opus: 5, sonnet: 3, haiku: 1, default: 3 }, tokenWeights: { input: 1, output: 5, cacheCreation: 1.25, cacheRead: 0.1 } }),
    breakRoom: z.object({
      cooldownSeconds: z.number().int().min(0).default(300),
      maxChars: z.number().int().min(1).default(280)
    }),
    retro: z
      .object({
        /** Apply adopted decisions automatically (quota shares, team agreements). */
        autoApply: z.boolean().default(true),
        /** Max times a hook re-wakes the same agent for one retrospective. */
        nudgeLimit: z.number().int().min(0).default(4)
      })
      .default({ autoApply: true, nudgeLimit: 4 }),
    agents: z.array(AgentConfig).min(1)
  })
  .superRefine((c, ctx) => {
    const total = c.agents.reduce((s, a) => s + a.share, 0);
    if (Math.abs(total - 100) > 0.01) {
      ctx.addIssue({ code: 'custom', message: `la somme des parts des agents doit faire 100 (actuellement ${total})`, path: ['agents'] });
    }
    const names = new Set<string>();
    for (const a of c.agents) {
      if (names.has(a.name)) ctx.addIssue({ code: 'custom', message: `agent en double : ${a.name}`, path: ['agents'] });
      names.add(a.name);
    }
    if (!names.has(c.team.leadAgent)) ctx.addIssue({ code: 'custom', message: `team.leadAgent « ${c.team.leadAgent} » n'est pas un agent`, path: ['team', 'leadAgent'] });
    const ids = new Set<string>();
    for (const p of c.projects) {
      if (ids.has(p.id)) ctx.addIssue({ code: 'custom', message: `projet en double : ${p.id}`, path: ['projects'] });
      ids.add(p.id);
    }
    if (c.team.activeProject && !ids.has(c.team.activeProject)) {
      ctx.addIssue({ code: 'custom', message: `team.activeProject « ${c.team.activeProject} » n'est pas dans projects`, path: ['team', 'activeProject'] });
    }
    if (c.quota.stopAtPct > c.quota.hardCapPct) {
      ctx.addIssue({ code: 'custom', message: 'stopAtPct doit être ≤ hardCapPct', path: ['quota', 'stopAtPct'] });
    }
  });

export type OfficeConfig = z.infer<typeof OfficeConfigSchema>;
export type AgentConfig = z.infer<typeof AgentConfig>;
export type ProjectConfig = z.infer<typeof ProjectConfig>;

/** Id for a folder name: "Mon Projet" → "mon-projet". */
export function projectIdFor(name: string): string {
  const id = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return id || 'projet';
}

/** A dev's worktree for a project: a sibling folder <project>-wt-<agent>. */
export function worktreeFor(repoPath: string, agent: string): string {
  return path.join(path.dirname(repoPath), `${path.basename(repoPath)}-wt-${agent}`);
}

/** Claude Code stores a project's transcripts under ~/.claude/projects/<path with every non-alphanumeric char → '-'>. */
export function encodeProjectDir(absPath: string): string {
  return absPath.replace(/[^A-Za-z0-9]/g, '-');
}

/** Loads office.config.json. Relative paths in it are resolved against the file's folder. */
export function loadConfig(file = process.env.OFFICE_CONFIG ?? path.resolve(process.cwd(), 'office.config.json')): OfficeConfig & { configDir: string } {
  const abs = path.resolve(file);
  const raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const parsed = OfficeConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`office.config.json invalide :\n${parsed.error.issues.map((i) => ` - ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  }
  const configDir = path.dirname(abs);
  return resolvePaths(parsed.data, configDir);
}

export function resolvePaths(cfg: OfficeConfig, configDir: string): OfficeConfig & { configDir: string } {
  if (cfg.server.dbPath !== ':memory:' && !path.isAbsolute(cfg.server.dbPath)) cfg.server.dbPath = path.resolve(configDir, cfg.server.dbPath);
  cfg.team.repoPath = path.resolve(configDir, cfg.team.repoPath);
  for (const p of cfg.projects) p.repoPath = path.resolve(configDir, p.repoPath);
  ensureProjects(cfg);
  cfg.usage.transcriptsDirFixed = !!cfg.usage.transcriptsDir;
  if (cfg.usage.transcriptsDir) cfg.usage.transcriptsDir = path.resolve(configDir, cfg.usage.transcriptsDir);
  applyActiveProject(cfg);
  return { ...cfg, configDir };
}

/** No project list yet: the team folder is the one and only project (paths absolute). */
export function ensureProjects(cfg: OfficeConfig) {
  if (cfg.projects.length === 0) {
    cfg.projects.push({ id: projectIdFor(path.basename(cfg.team.repoPath)), name: path.basename(cfg.team.repoPath), repoPath: cfg.team.repoPath, mainBranch: 'main' });
  }
  if (!cfg.team.activeProject || !cfg.projects.some((p) => p.id === cfg.team.activeProject)) {
    cfg.team.activeProject = (cfg.projects.find((p) => samePath(p.repoPath, cfg.team.repoPath)) ?? cfg.projects[0]!).id;
  }
}

export function activeProjectOf(cfg: OfficeConfig): ProjectConfig {
  return cfg.projects.find((p) => p.id === cfg.team.activeProject) ?? cfg.projects[0]!;
}

/** Points team.repoPath, the devs' worktrees and the transcripts folder at the active project (paths already absolute). */
export function applyActiveProject(cfg: OfficeConfig) {
  const p = activeProjectOf(cfg);
  cfg.team.repoPath = p.repoPath;
  for (const a of cfg.agents) if (a.worktree) a.worktree = worktreeFor(p.repoPath, a.name);
  if (!cfg.usage.transcriptsDirFixed) cfg.usage.transcriptsDir = transcriptsDirFor(p.repoPath);
}

export function transcriptsDirFor(repoPath: string): string {
  return path.join(os.homedir(), '.claude', 'projects', encodeProjectDir(repoPath));
}

function samePath(a: string, b: string) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}
