import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeConfig, makeOffice } from './helpers.js';

const assistant = (id: string, at: number, u: Record<string, number>, model = 'claude-sonnet-5-5') =>
  JSON.stringify({ type: 'assistant', timestamp: new Date(at).toISOString(), message: { id, model, usage: u } }) + '\n';

function transcriptsDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcripts-'));
  const session = path.join(dir, 'sess1');
  fs.mkdirSync(path.join(session, 'subagents'), { recursive: true });
  return { dir, session };
}

describe('usage from transcripts', () => {
  it('attributes messages to the lead and to teammates, counts repeated chunks once, resumes from offsets', () => {
    const { usage, clock } = makeOffice();
    const { dir, session } = transcriptsDir();
    const t = clock.now();
    fs.writeFileSync(path.join(dir, 'sess1.jsonl'), assistant('m1', t, { input_tokens: 100, output_tokens: 10 }) + assistant('m1', t, { input_tokens: 100, output_tokens: 50 }));
    const sub = path.join(session, 'subagents', 'agent-abc.jsonl');
    fs.writeFileSync(sub.replace('.jsonl', '.meta.json'), JSON.stringify({ name: 'dev1', agentType: 'dev1' }));
    fs.writeFileSync(sub, assistant('m2', t, { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 1000 }) + '{"type":"assist'); // partial line
    expect(usage.scanOnce(dir)).toBe(3);
    fs.appendFileSync(sub, 'ant","timestamp":"' + new Date(t).toISOString() + '","message":{"id":"m3","model":"claude-opus-5-5","usage":{"input_tokens":1,"output_tokens":1}}}\n');
    expect(usage.scanOnce(dir)).toBe(1);
    const v = usage.view();
    const lead = v.agents.find((a) => a.name === 'lead')!;
    const dev1 = v.agents.find((a) => a.name === 'dev1')!;
    expect(lead.tokens).toBe(150); // m1 kept once, with the highest counts
    expect(lead.weighted).toBe(3 * (100 + 50 * 5));
    expect(dev1.tokens).toBe(1030 + 2);
  });

  it('splits the plan % between agents, marks break-room tokens, and sends over-budget agents to rest', () => {
    const { usage, office, clock } = makeOffice();
    const { dir } = transcriptsDir();
    const t = clock.now();
    office.breakRoomPost('archi', 'Pause !');
    clock.advance(1000);
    fs.writeFileSync(
      path.join(dir, 'sess1', 'subagents', 'agent-a.jsonl'),
      assistant('a1', clock.now(), { output_tokens: 100 }, 'claude-opus-5-5')
    );
    fs.writeFileSync(path.join(dir, 'sess1', 'subagents', 'agent-a.meta.json'), JSON.stringify({ name: 'archi' }));
    fs.writeFileSync(path.join(dir, 'sess1.jsonl'), assistant('l1', t, { output_tokens: 100 }));
    usage.scanOnce(dir);
    // archi (opus, weight 5) ≈ 62.5 % of team usage, lead 37.5 %. 10 % were used before the team started.
    office.recordQuota({ source: 'rate_limits', fiveHourPct: 10, fiveHourResetsAt: Math.floor((clock.now() + 3600_000) / 1000), sevenDayPct: 10 });
    office.recordQuota({ source: 'rate_limits', fiveHourPct: 50, fiveHourResetsAt: Math.floor((clock.now() + 3600_000) / 1000), sevenDayPct: 10 });
    const v = usage.evaluate();
    const archi = v.agents.find((a) => a.name === 'archi')!;
    expect(v.baselinePct).toBe(10);
    expect(archi.pctOfQuota).toBe(25);
    expect(archi.pausePct).toBe(100);
    expect(archi.limitPct).toBe(18); // 20 % of 90 %
    expect(office.agentView('archi').room).toBe('rest'); // 25 ≥ 17.6 (20 % of 88 %)
    // lead: 15 % of the plan for 13.2 % allowed (15 % of 88 %) → rest as well
    expect(v.agents.find((a) => a.name === 'lead')!.pctOfQuota).toBe(15);
    expect(office.agentView('lead').room).toBe('rest');
    expect(office.agentView('dev1').room).toBe('desk'); // used nothing
  });

  it('sends everyone to rest at the global stop and wakes them after the reset', () => {
    const { usage, office, clock } = makeOffice();
    office.recordQuota({ source: 'rate_limits', fiveHourPct: 89, fiveHourResetsAt: Math.floor((clock.now() + 600_000) / 1000), sevenDayPct: 30 });
    usage.evaluate();
    expect(office.listAgents().every((a) => a.room === 'rest')).toBe(true);
    clock.advance(700_000);
    office.recordQuota({ source: 'rate_limits', fiveHourPct: 1, fiveHourResetsAt: Math.floor((clock.now() + 5 * 3600_000) / 1000), sevenDayPct: 31 });
    usage.evaluate();
    expect(office.listAgents().every((a) => a.room === 'desk')).toBe(true);
  });

  it('falls back to a weighted-token budget when no rate_limits are known', () => {
    const cfg = makeConfig({ quota: { source: 'token_budget', hardCapPct: 90, stopAtPct: 88, autoLockBreakRoomPct: 75, fallbackTokenBudget: { windowHours: 5, tokens: 1000 } } });
    const { usage, clock, office } = makeOffice(cfg);
    const { dir } = transcriptsDir();
    fs.writeFileSync(path.join(dir, 'sess1.jsonl'), assistant('x', clock.now(), { output_tokens: 52 })); // 3*5*52 = 780 → 78 %
    usage.scanOnce(dir);
    const v = usage.evaluate();
    expect(v.method).toBe('token_budget');
    expect(v.globalPct).toBe(78);
    expect(office.isBreakLocked()).toBe(true);
  });
});
