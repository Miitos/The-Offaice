import { describe, expect, it } from 'vitest';
import { makeOffice } from './helpers.js';

const persona = (first: string) => ({ first_name: first, last_name: 'X', favorite_movie: 'm', favorite_music: 'n' });

describe('keeping a break-room conversation alive', () => {
  it('tells the poster whom to wake, the person replied to first', () => {
    const { office, clock } = makeOffice();
    office.introduceSelf('lead', persona('Inès'));
    office.introduceSelf('dev1', persona('Théo'));
    office.introduceSelf('dev2', persona('Elias'));
    const a = office.breakRoomPost('dev1', 'Un bon film ?');
    expect(a.wake.to).toEqual([]);
    office.enterRoom('lead', 'break', 'agent');
    clock.advance(10_000);
    const b = office.breakRoomPost('dev2', 'Blade Runner !', a.post.id);
    expect(b.wake.to).toEqual(['dev1', 'lead']);
    expect(b.wake.message).toMatch(/SendMessage/);
  });

  it('stops waking anyone once an agent has talked a lot', () => {
    const { office, clock } = makeOffice();
    office.introduceSelf('dev1', persona('Théo'));
    office.introduceSelf('dev2', persona('Elias'));
    office.enterRoom('dev2', 'break', 'agent');
    let last;
    for (let i = 0; i < 5; i++) {
      last = office.breakRoomPost('dev1', `Message ${i}`);
      clock.advance(301_000);
    }
    expect(last!.wake.to).toEqual([]);
    expect(last!.wake.message).toMatch(/retomber/);
  });

  it('waits for the cooldown, then returns the unread messages', async () => {
    const { office, clock } = makeOffice();
    office.introduceSelf('dev1', persona('Théo'));
    office.introduceSelf('dev2', persona('Elias'));
    const a = office.breakRoomPost('dev1', 'Un bon film ?');
    clock.advance(60_000);
    office.breakRoomPost('dev2', 'Blade Runner !', a.post.id);
    const sleep = async (ms: number) => clock.advance(ms);
    const r = await office.breakRoomWait('dev1', 240, sleep);
    expect(r.reason).toBe('ready');
    expect(r.canPostNow).toBe(true);
    expect(r.repliesToMe).toBe(1);
    expect(r.waitedSeconds).toBeGreaterThanOrEqual(239);
  });

  it('gives up at the deadline when nothing new arrives, and refuses outside the room', async () => {
    const { office, clock } = makeOffice();
    office.introduceSelf('dev1', persona('Théo'));
    office.breakRoomPost('dev1', 'Il y a quelqu’un ?');
    const sleep = async (ms: number) => clock.advance(ms);
    const r = await office.breakRoomWait('dev1', 30, sleep);
    expect(r.reason).toBe('timeout');
    expect(r.waitedSeconds).toBe(30);
    await expect(office.breakRoomWait('dev2', 30, sleep)).rejects.toMatchObject({ code: 'not_in_room' });
  });
});
