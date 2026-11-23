import { describe, expect, it } from 'vitest';
import { cardInReview, makeOffice } from './helpers.js';

describe('rooms', () => {
  it('refuses the rest room to agents (system only)', () => {
    const { office } = makeOffice();
    expect(() => office.enterRoom('dev1', 'repos')).toThrowError(expect.objectContaining({ code: 'system_only' }));
    office.enterRoom('dev1', 'rest', 'system', 'quota atteint');
    expect(() => office.enterRoom('dev1', 'desk')).toThrowError(expect.objectContaining({ code: 'resting' }));
  });

  it('logs every room change', () => {
    const { office } = makeOffice();
    office.enterRoom('lead', 'meeting');
    office.enterRoom('lead', 'meeting'); // no-op
    office.enterRoom('lead', 'bureau');
    expect(office.recentRoomEvents('lead').map((e: any) => e.to_room)).toEqual(['desk', 'meeting']);
  });
});

describe('break room', () => {
  it('puts work first: no break with an active card', () => {
    const { office } = makeOffice();
    const c = office.createCard('lead', { title: 'x', column: 'TODO' });
    office.assignCard('lead', c.id, 'dev1');
    office.moveCard('dev1', c.id, 'IN_PROGRESS');
    expect(() => office.enterRoom('dev1', 'pause')).toThrowError(expect.objectContaining({ code: 'work_first' }));
    expect(() => office.breakRoomPost('dev1', 'Salut')).toThrowError(expect.objectContaining({ code: 'work_first' }));
  });

  it('allows a break while waiting for review', () => {
    const { office, clock } = makeOffice();
    cardInReview(office, clock);
    expect(office.currentCard('dev1')?.status).toBe('waiting');
    expect(office.enterRoom('dev1', 'break').room).toBe('break');
    // …but the reviewer, who has to act on it, may not
    const id = office.listBoard().find((c) => c.column === 'IN_REVIEW')!.cards[0]!.id;
    office.assignCard('reviewer', id, 'reviewer');
    expect(() => office.enterRoom('reviewer', 'break')).toThrowError(expect.objectContaining({ code: 'work_first' }));
  });

  it('enforces 280 characters and one message every 5 minutes', () => {
    const { office, clock } = makeOffice();
    expect(() => office.breakRoomPost('archi', 'x'.repeat(281))).toThrowError(expect.objectContaining({ code: 'too_long' }));
    const post = office.breakRoomPost('archi', 'Quelqu’un a vu un bon film récemment ?');
    expect(office.agentView('archi').room).toBe('break');
    expect(office.agentView('archi').bubble).toBe(post.post.body);
    clock.advance(3 * 60 * 1000 + 30 * 1000);
    try {
      office.breakRoomPost('archi', 'Encore moi');
      expect.unreachable();
    } catch (e: any) {
      expect(e.code).toBe('break_cooldown');
      expect(e.details.remainingSeconds).toBe(90);
      expect(e.message).toContain('1 min 30 s');
    }
    clock.advance(90 * 1000);
    expect(office.breakRoomPost('archi', 'Encore moi').post.body).toBe('Encore moi');
  });

  it('locking closes the room and sends agents back to their desk', () => {
    const { office } = makeOffice();
    office.breakRoomPost('lead', 'Pause café');
    const r = office.setBreakLock(true, 'user');
    expect(r).toMatchObject({ changed: true, evicted: ['lead'] });
    expect(office.agentView('lead').room).toBe('desk');
    expect(() => office.enterRoom('lead', 'break')).toThrowError(expect.objectContaining({ code: 'break_room_locked' }));
    expect(() => office.breakRoomPost('archi', 'hello')).toThrowError(expect.objectContaining({ code: 'break_room_locked' }));
    expect(office.breakLockHistory()[0]).toMatchObject({ locked: true, actor: 'user' });
    office.setBreakLock(false, 'user');
    expect(office.isBreakLocked()).toBe(false);
  });
});

describe('quota', () => {
  it('auto-locks at 75 % and reopens on reset only if it locked itself', () => {
    const { office } = makeOffice();
    office.recordQuota({ source: 'rate_limits', fiveHourPct: 60, sevenDayPct: 20 });
    expect(office.isBreakLocked()).toBe(false);
    office.recordQuota({ source: 'rate_limits', fiveHourPct: 76, sevenDayPct: 20 });
    expect(office.isBreakLocked()).toBe(true);
    expect(office.breakLockHistory()[0]).toMatchObject({ actor: 'auto' });
    office.recordQuota({ source: 'rate_limits', fiveHourPct: 3, sevenDayPct: 21 });
    expect(office.isBreakLocked()).toBe(false);
    expect(office.breakLockHistory()[0]).toMatchObject({ actor: 'reset' });

    office.setBreakLock(true, 'user');
    office.recordQuota({ source: 'rate_limits', fiveHourPct: 4, sevenDayPct: 21 });
    expect(office.isBreakLocked()).toBe(true); // the human's lock stays
  });

  it('uses the highest window', () => {
    const { office } = makeOffice();
    office.recordQuota({ source: 'rate_limits', fiveHourPct: 10, sevenDayPct: 80 });
    expect(office.globalPct()).toBe(80);
    expect(office.isBreakLocked()).toBe(true);
  });
});

describe('persona', () => {
  it('stores the persona and refuses a first name already taken', () => {
    const { office } = makeOffice();
    office.introduceSelf('dev1', { first_name: 'Camille', last_name: 'Duval', favorite_movie: 'Amélie', favorite_music: 'Stevie Wonder' });
    expect(office.agentView('dev1').persona).toMatchObject({ firstName: 'Camille' });
    expect(() => office.introduceSelf('dev2', { first_name: 'camille', last_name: 'Rousseau', favorite_movie: 'x', favorite_music: 'y' })).toThrowError(
      expect.objectContaining({ code: 'name_taken' })
    );
    // re-introducing yourself is fine
    office.introduceSelf('dev1', { first_name: 'Camille', last_name: 'Martin', favorite_movie: 'Amélie', favorite_music: 'Nujabes' });
  });
});
