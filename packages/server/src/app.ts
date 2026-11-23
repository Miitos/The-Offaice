import path from 'node:path';
import type { OfficeConfig } from './config.js';
import type { DB } from './db.js';
import { Hooks } from './domain/hooks.js';
import { type Clock, Office } from './domain/office.js';
import { Retro } from './domain/retro.js';
import { Usage } from './domain/usage.js';
import { EventBus } from './events.js';

export interface OfficeApp {
  office: Office;
  retro: Retro;
  usage: Usage;
  hooks: Hooks;
}

/** Wires the modules together. `agreementsFile` defaults to <team repo>/.claude/team-agreements.md. */
export function createOfficeApp(db: DB, cfg: OfficeConfig, opts: { clock?: Clock; bus?: EventBus; agreementsFile?: string | null } = {}): OfficeApp {
  const office = new Office(db, cfg, { clock: opts.clock, bus: opts.bus });
  const agreementsFile = opts.agreementsFile === undefined ? path.join(cfg.team.repoPath, '.claude', 'team-agreements.md') : opts.agreementsFile;
  const retro = new Retro(office, { agreementsFile });
  const usage = new Usage(office);
  const hooks = new Hooks(office, retro, usage);
  return { office, retro, usage, hooks };
}
