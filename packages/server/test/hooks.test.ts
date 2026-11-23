import { describe, expect, it } from 'vitest';
import { makeOffice } from './helpers.js';

const pre = (agentType: string | undefined, tool: string, input: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  hook_event_name: 'PreToolUse',
  session_id: 's',
  cwd: 'D:/tmp/office-team',
  ...(agentType ? { agent_type: agentType, agent_id: `id-${agentType}` } : {}),
  tool_name: tool,
  tool_input: input,
  ...extra
});
const decision = (out: any) => out?.hookSpecificOutput?.permissionDecision ?? null;
const reason = (out: any) => out?.hookSpecificOutput?.permissionDecisionReason ?? '';

describe('hook identity', () => {
  it('maps teammates by name and the main session to the lead', () => {
    const { hooks } = makeOffice();
    expect(hooks.identify({ agent_type: 'dev1', agent_id: 'x' })).toBe('dev1');
    expect(hooks.identify({ teammate_name: 'tester' })).toBe('tester');
    expect(hooks.identify({ agent_type: 'dev1-2', agent_id: 'z' })).toBe('dev1');
    expect(hooks.identify({ teammate_name: 'reviewer-3' })).toBe('reviewer');
    expect(hooks.identify({ agent_type: 'Explore-2', agent_id: 'w' })).toBeNull();
    expect(hooks.identify({})).toBe('lead');
    expect(hooks.identify({ agent_type: 'Explore', agent_id: 'y' })).toBeNull();
  });

  it('injects the identity into office tools and refuses unknown callers', () => {
    const { hooks } = makeOffice();
    const out: any = hooks.handle('PreToolUse', pre('dev2', 'mcp__office__move_card', { card_id: 1, to: 'IN REVIEW', _office_agent: 'reviewer' }));
    expect(decision(out)).toBe('allow');
    expect(out.hookSpecificOutput.updatedInput).toEqual({ card_id: 1, to: 'IN REVIEW', _office_agent: 'dev2' });
    expect(decision(hooks.handle('PreToolUse', pre('Explore', 'mcp__office__list_board')))).toBe('deny');
  });
});

describe('hook guards', () => {
  it('keeps devs inside their worktree', () => {
    const { hooks } = makeOffice();
    expect(decision(hooks.handle('PreToolUse', pre('dev1', 'Edit', { file_path: 'D:/tmp/office-team-wt-dev1/src/a.ts' })))).toBeNull();
    const out = hooks.handle('PreToolUse', pre('dev1', 'Write', { file_path: 'D:/tmp/office-team/src/a.ts' }));
    expect(decision(out)).toBe('deny');
    expect(reason(out)).toMatch(/worktree/);
    expect(decision(hooks.handle('PreToolUse', pre('dev1', 'Edit', { file_path: 'D:/tmp/office-team-wt-dev2/x.ts' })))).toBe('deny');
    // agents without a worktree are not restricted
    expect(decision(hooks.handle('PreToolUse', pre('archi', 'Write', { file_path: 'D:/tmp/office-team/docs/design.md' })))).toBeNull();
  });

  it('blocks shell access to the office server', () => {
    const { hooks } = makeOffice();
    expect(decision(hooks.handle('PreToolUse', pre('dev1', 'Bash', { command: 'curl -X POST http://127.0.0.1:0/api/break-room/unlock' })))).toBe('deny');
    expect(decision(hooks.handle('PreToolUse', pre('dev1', 'Bash', { command: 'npm test' })))).toBeNull();
  });

  it('forbids web research in the break room and moves workers back to their desk', () => {
    const { hooks, office } = makeOffice();
    office.breakRoomPost('archi', 'Coucou');
    expect(decision(hooks.handle('PreToolUse', pre('archi', 'WebSearch', { query: 'actu' })))).toBe('deny');
    hooks.handle('PreToolUse', pre('archi', 'Bash', { command: 'git status' }));
    expect(office.agentView('archi').room).toBe('desk');
    expect(office.agentView('archi').bubble).toBe('Bash git status');
  });

  it('stops a resting agent and suspends work during a retro', () => {
    const { hooks, office, retro } = makeOffice();
    office.enterRoom('dev2', 'rest', 'system', 'part atteinte');
    expect(reason(hooks.handle('PreToolUse', pre('dev2', 'Read', { file_path: 'x' })))).toMatch(/Salle de repos : part atteinte/);
    retro.start('user');
    expect(reason(hooks.handle('PreToolUse', pre('dev1', 'Edit', { file_path: 'D:/tmp/office-team-wt-dev1/a' })))).toMatch(/Rétrospective en cours/);
    expect(decision(hooks.handle('PreToolUse', pre('dev1', 'mcp__office__retro_status')))).toBe('allow');
    expect(decision(hooks.handle('PreToolUse', pre('dev1', 'SendMessage', { to: 'lead' })))).toBeNull();
  });
});

describe('idle / stop nudges', () => {
  it('keeps a teammate going for the retro, and the lead from stopping before closing it', () => {
    const { hooks, retro } = makeOffice();
    retro.start('user');
    const out: any = hooks.handle('TeammateIdle', { hook_event_name: 'TeammateIdle', teammate_name: 'tester', agent_id: 'i' });
    expect(out.decision).toBe('block');
    expect(out.reason).toMatch(/Rétrospective/);
    const stop: any = hooks.handle('Stop', { hook_event_name: 'Stop', stop_hook_active: false });
    expect(stop.decision).toBe('block');
    expect(hooks.handle('Stop', { hook_event_name: 'Stop', stop_hook_active: true })).toEqual({});
  });

  it('wakes an idle agent in the break room once per batch of unread messages', () => {
    const { hooks, office, clock } = makeOffice();
    office.introduceSelf('lead', { first_name: 'Inès', last_name: 'M', favorite_movie: 'm', favorite_music: 'n' });
    office.introduceSelf('dev2', { first_name: 'Malo', last_name: 'D', favorite_movie: 'm', favorite_music: 'n' });
    const first = office.breakRoomPost('dev2', 'Quelqu’un a un bon livre ?');
    clock.advance(400_000);
    office.breakRoomPost('lead', 'Oui, un roman sur les cartographes.', first.post.id);
    const idle = () => hooks.handle('TeammateIdle', { hook_event_name: 'TeammateIdle', teammate_name: 'dev2', agent_id: 'i' }) as any;
    const out = idle();
    expect(out.decision).toBe('block');
    expect(out.reason).toMatch(/dont 1 réponse\(s\) pour toi.*Inès \(à Malo\)/);
    expect(idle()).toEqual({}); // same batch: no second wake-up
  });

  it('still wakes an agent whose cooldown is running, and points it to break_room_wait', () => {
    const { hooks, office, clock } = makeOffice();
    office.introduceSelf('lead', { first_name: 'Inès', last_name: 'M', favorite_movie: 'm', favorite_music: 'n' });
    office.introduceSelf('dev2', { first_name: 'Malo', last_name: 'D', favorite_movie: 'm', favorite_music: 'n' });
    const first = office.breakRoomPost('dev2', 'Quelqu’un a un bon livre ?');
    clock.advance(60_000);
    office.breakRoomPost('lead', 'Oui !', first.post.id);
    const out: any = hooks.handle('TeammateIdle', { hook_event_name: 'TeammateIdle', teammate_name: 'dev2', agent_id: 'i' });
    expect(out.decision).toBe('block');
    expect(out.reason).toMatch(/dans 240 s : appelle break_room_wait/);
  });
});

describe('idle nudges for missing persona and unfinished work', () => {
  const idle = (hooks: any, name: string) => hooks.handle('TeammateIdle', { hook_event_name: 'TeammateIdle', teammate_name: name, agent_id: 'i' }) as any;

  it('asks once for a persona, to teammates and to the lead', () => {
    const { hooks } = makeOffice();
    expect(idle(hooks, 'tester').reason).toMatch(/introduce_self/);
    expect(idle(hooks, 'tester')).toEqual({});
    const stop: any = hooks.handle('Stop', { hook_event_name: 'Stop', stop_hook_active: false });
    expect(stop.reason).toMatch(/introduce_self/);
    expect(hooks.handle('Stop', { hook_event_name: 'Stop', stop_hook_active: false })).toEqual({});
  });

  it('reminds once per card and column when going idle with an active card', () => {
    const { hooks, office } = makeOffice();
    office.introduceSelf('dev1', { first_name: 'Théo', last_name: 'M', favorite_movie: 'm', favorite_music: 'n' });
    const c = office.createCard('lead', { title: 'Boulot', column: 'TODO' });
    office.assignCard('lead', c.id, 'dev1');
    office.moveCard('dev1', c.id, 'IN_PROGRESS');
    expect(idle(hooks, 'dev1').reason).toMatch(/carte #1 « Boulot » en IN_PROGRESS/);
    expect(idle(hooks, 'dev1')).toEqual({});
  });
});
