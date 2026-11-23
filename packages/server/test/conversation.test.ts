import { describe, expect, it } from 'vitest';
import { makeOffice } from './helpers.js';

const persona = (first: string) => ({ first_name: first, last_name: 'X', favorite_movie: 'm', favorite_music: 'n' });

describe('break room conversation', () => {
  it('lets several agents talk to each other', () => {
    const { office, clock } = makeOffice();
    office.introduceSelf('lead', persona('Inès'));
    office.introduceSelf('archi', persona('Hugo'));
    office.introduceSelf('dev2', persona('Léa'));

    const a = office.breakRoomPost('lead', 'Vous avez lu quelque chose de bien récemment ?');
    clock.advance(20_000);
    const b = office.breakRoomPost('archi', 'Un essai sur l’histoire des cartes, passionnant.', a.post.id);
    expect(b.post).toMatchObject({ author: 'Hugo', replyTo: a.post.id, replyToAuthor: 'Inès' });
    expect(office.agentView('archi').bubble).toBe('@Inès Un essai sur l’histoire des cartes, passionnant.');
    // the reply comes back with the whole conversation, oldest first
    expect(b.conversation.posts.map((p) => p.author)).toEqual(['Inès', 'Hugo']);
    expect(b.conversation.present.map((p) => p.name).sort()).toEqual(['Hugo', 'Inès']);

    clock.advance(20_000);
    office.breakRoomPost('dev2', 'Moi je réécoute de vieux albums de jazz.', a.post.id);

    // lead has 2 unread messages, both replies to her
    expect(office.breakUnreadFor('lead')).toMatchObject({ repliesToMe: 2 });
    expect(office.breakUnreadFor('lead').unread.map((p) => p.author)).toEqual(['Hugo', 'Léa']);
    const read = office.breakRoomRead('lead');
    expect(read.posts).toHaveLength(3);
    expect(read.nextPostAllowedAt).toBe(a.post.at + 300_000);
    expect(office.breakUnreadFor('lead').unread).toHaveLength(0);

    // she still has to wait for her cooldown before answering
    expect(() => office.breakRoomPost('lead', 'Super !', b.post.id)).toThrowError(expect.objectContaining({ code: 'break_cooldown' }));
    clock.advance(300_000);
    office.breakRoomPost('lead', 'Super, tu me prêteras le livre ?', b.post.id);
    expect(office.breakUnreadFor('archi').repliesToMe).toBe(1);
  });

  it('refuses bad replies and reading from outside the room', () => {
    const { office } = makeOffice();
    const a = office.breakRoomPost('lead', 'Coucou');
    expect(() => office.breakRoomPost('archi', 'x', 999)).toThrowError(expect.objectContaining({ code: 'unknown_post' }));
    expect(() => office.breakRoomRead('dev1')).toThrowError(expect.objectContaining({ code: 'not_in_room' }));
    // replying to yourself is refused (and checked before the cooldown matters)
    expect(() => office.breakRoomPost('lead', 'Moi', a.post.id)).toThrowError(expect.objectContaining({ code: 'break_cooldown' }));
  });

  it('has nothing unread once the room is locked or the agent left', () => {
    const { office } = makeOffice();
    office.breakRoomPost('lead', 'Coucou');
    office.breakRoomPost('archi', 'Salut');
    expect(office.breakUnreadFor('lead').unread).toHaveLength(1);
    office.setBreakLock(true, 'user');
    expect(office.breakUnreadFor('lead').unread).toHaveLength(0);
  });
});
