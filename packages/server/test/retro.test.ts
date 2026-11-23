import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeOffice } from './helpers.js';

const fullShares = { lead: 15, archi: 15, dev1: 25, dev2: 25, reviewer: 10, tester: 10 };

describe('retrospective', () => {
  it('gathers everybody in the meeting room and freezes the break room', () => {
    const { office, retro } = makeOffice();
    office.breakRoomPost('lead', 'Pause');
    office.enterRoom('dev1', 'rest', 'system', 'quota');
    retro.start('user', 'Comment mieux découper les cartes ?');
    const rooms = Object.fromEntries(office.listAgents().map((a) => [a.name, a.room]));
    expect(rooms).toEqual({ lead: 'meeting', archi: 'meeting', dev1: 'rest', dev2: 'meeting', reviewer: 'meeting', tester: 'meeting' });
    expect(() => office.enterRoom('dev2', 'desk')).toThrowError(expect.objectContaining({ code: 'retro_in_progress' }));
    expect(() => office.breakRoomPost('archi', 'x')).toThrowError(expect.objectContaining({ code: 'retro_in_progress' }));
    expect(() => retro.post('dev1', 'Je suis là')).toThrowError(expect.objectContaining({ code: 'resting' }));
    expect(() => retro.start('user')).toThrowError(expect.objectContaining({ code: 'retro_in_progress' }));
    expect(retro.participants()).toHaveLength(5);
  });

  it('adopts by strict majority, applies quota shares and agreements, and can revert them', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retro-'));
    fs.mkdirSync(path.join(dir, '.claude'));
    const file = path.join(dir, '.claude', 'team-agreements.md');
    const { office, retro, clock } = makeOffice(undefined, { agreementsFile: file });
    retro.start('user');
    retro.post('dev1', 'On manque de budget pour les devs.');
    const q = retro.propose('dev1', { kind: 'quota', title: 'Plus de budget dev', details: 'Les devs saturent avant la fin de la fenêtre.', shares: fullShares });
    const p = retro.propose('tester', { kind: 'process', title: 'Critères d’acceptation', details: 'Chaque carte en TODO liste ses critères d’acceptation.' });
    const o = retro.propose('archi', { kind: 'other', title: 'Pause plus longue', details: 'Deux messages toutes les 5 minutes.' });
    // 6 participants → majority 4
    for (const a of ['dev2', 'reviewer', 'lead']) retro.vote(a, q.proposal.id, 'for');
    for (const a of ['dev1', 'dev2', 'lead', 'reviewer', 'archi']) retro.vote(a, p.proposal.id, 'for');
    for (const a of ['dev1', 'dev2', 'lead']) retro.vote(a, o.proposal.id, 'against');
    expect(() => retro.close('dev1')).toThrowError(expect.objectContaining({ code: 'capability_required' }));
    clock.advance(1000);
    const res = retro.close('lead', 'Plus de budget dev, critères d’acceptation obligatoires.');
    expect(res.majority).toBe(4);
    expect(res.decisions.map((d) => [d.title, d.adopted])).toEqual([
      ['Plus de budget dev', true],
      ['Critères d’acceptation', true],
      ['Pause plus longue', false]
    ]);
    expect(office.shares()).toEqual(fullShares);
    expect(office.agentView('dev1').share).toBe(25);
    expect(office.agentView('dev1').room).toBe('desk');
    expect(fs.readFileSync(file, 'utf8')).toContain('Critères d’acceptation');

    retro.revert(q.proposal.id, 'user');
    expect(office.shares()).toEqual({ lead: 15, archi: 20, dev1: 22.5, dev2: 22.5, reviewer: 10, tester: 10 });
    retro.revert(p.proposal.id, 'user');
    expect(retro.agreements()).toHaveLength(0);
    expect(fs.readFileSync(file, 'utf8')).toContain('Aucun accord');
    expect(() => retro.revert(p.proposal.id, 'user')).toThrow(/déjà annulée/);
  });

  it('validates quota proposals: all agents, ≥ 2 % each, total 100', () => {
    const { retro } = makeOffice();
    retro.start('user');
    const base = { kind: 'quota', title: 't', details: 'd' };
    expect(() => retro.propose('lead', { ...base, shares: { lead: 100 } })).toThrow(/Manquants/);
    expect(() => retro.propose('lead', { ...base, shares: { ...fullShares, lead: 20 } })).toThrow(/100 au total/);
    expect(() => retro.propose('lead', { ...base, shares: { ...fullShares, lead: 1, archi: 29 } })).toThrow(/minimum 2/);
    expect(() => retro.propose('lead', { ...base, shares: { ...fullShares, intrus: 0 } })).toThrowError(expect.objectContaining({ code: 'unknown_agent' }));
  });

  it('nudges agents who have not spoken or voted, a limited number of times', () => {
    const { retro } = makeOffice();
    retro.start('user');
    const p = retro.propose('dev1', { kind: 'process', title: 'Pair review', details: 'Deux relecteurs pour les grosses cartes.' });
    expect(retro.nudgeFor('dev2')).toMatch(/pas encore pris la parole.*pas voté sur #1/);
    for (let i = 1; i < 4; i++) retro.nudgeFor('dev2');
    expect(retro.nudgeFor('dev2')).toBeNull(); // limit 4 reached
    // the lead is asked to close once everyone spoke and voted
    for (const a of ['lead', 'archi', 'dev1', 'dev2', 'reviewer', 'tester']) {
      retro.post(a, 'Mon point');
      if (a !== 'dev1') retro.vote(a, p.proposal.id, 'for');
    }
    expect(retro.nudgeFor('lead')).toMatch(/retro_close/);
    expect(retro.nudgeFor('archi')).toBeNull();
  });
});
