import { createOfficeApp } from '../src/app.js';
import { OfficeConfigSchema, type OfficeConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import type { Clock, Office } from '../src/domain/office.js';

export function makeConfig(overrides: Partial<Record<string, unknown>> = {}): OfficeConfig {
  return OfficeConfigSchema.parse({
    server: { host: '127.0.0.1', port: 0, dbPath: ':memory:' },
    team: { repoPath: 'D:/tmp/office-team', leadAgent: 'lead' },
    quota: { source: 'rate_limits', hardCapPct: 90, stopAtPct: 88, autoLockBreakRoomPct: 75, fallbackTokenBudget: { windowHours: 5, tokens: 0 } },
    breakRoom: { cooldownSeconds: 300, maxChars: 280 },
    agents: [
      { name: 'lead', role: 'Lead', capabilities: ['lead'], model: 'sonnet', share: 15 },
      { name: 'archi', role: 'Archi', capabilities: ['architect'], model: 'opus', share: 20 },
      { name: 'dev1', role: 'Dev', capabilities: ['dev'], model: 'sonnet', share: 22.5, worktree: 'D:/tmp/office-team-wt-dev1' },
      { name: 'dev2', role: 'Dev', capabilities: ['dev'], model: 'sonnet', share: 22.5, worktree: 'D:/tmp/office-team-wt-dev2' },
      { name: 'reviewer', role: 'Reviewer', capabilities: ['reviewer'], model: 'sonnet', share: 10 },
      { name: 'tester', role: 'Testeur', capabilities: ['tester'], model: 'sonnet', share: 10 }
    ],
    ...overrides
  });
}

export const testConfig = makeConfig();

export class FakeClock implements Clock {
  constructor(public t = Date.UTC(2026, 10, 22, 9, 0, 0)) {}
  now() {
    return this.t;
  }
  advance(ms: number) {
    this.t += ms;
  }
}

export function makeOffice(cfg: OfficeConfig = testConfig, opts: { agreementsFile?: string | null } = {}) {
  const clock = new FakeClock();
  const db = openDb(':memory:');
  const ctx = createOfficeApp(db, cfg, { clock, agreementsFile: opts.agreementsFile ?? null });
  return { ...ctx, clock, db };
}

/** Walks a card to `IN_REVIEW`, assigned to dev1. */
export function cardInReview(office: Office, clock: FakeClock) {
  const c = office.createCard('lead', { title: 'Carte test', column: 'TODO' });
  office.assignCard('lead', c.id, 'dev1');
  clock.advance(1000);
  office.moveCard('dev1', c.id, 'IN PROGRESS');
  clock.advance(1000);
  office.moveCard('dev1', c.id, 'IN REVIEW');
  clock.advance(1000);
  return c.id;
}
