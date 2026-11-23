import { describe, expect, it } from 'vitest';
import { buildHttp } from '../src/http.js';
import { makeOffice } from './helpers.js';

const persona = (first: string) => ({ first_name: first, last_name: 'X', favorite_movie: 'm', favorite_music: 'n' });

function office3() {
  const t = makeOffice();
  t.office.introduceSelf('lead', persona('Inès'));
  t.office.introduceSelf('archi', persona('Hugo'));
  t.office.introduceSelf('dev1', persona('Léa'));
  for (const a of ['lead', 'archi', 'dev1']) t.office.enterRoom(a, 'break');
  return t;
}

describe('profile', () => {
  it('lets agents add and remove hobbies and dislikes, from the break room only', () => {
    const { office } = office3();
    expect(office.updateProfile('archi', { add_hobbies: ['Escalade', 'Cartographie ancienne'], add_dislikes: ['Les réunions sans ordre du jour'] })).toEqual({
      hobbies: ['Escalade', 'Cartographie ancienne'],
      dislikes: ['Les réunions sans ordre du jour']
    });
    // duplicates ignored, removal is case/accent insensitive
    office.updateProfile('archi', { add_hobbies: ['escalade'], remove_hobbies: ['CARTOGRAPHIE ANCIENNE'] });
    expect(office.agentView('archi').hobbies).toEqual(['Escalade']);

    expect(() => office.updateProfile('dev2', { add_hobbies: ['x'] })).toThrowError(expect.objectContaining({ code: 'not_in_room' }));
    expect(() => office.updateProfile('archi', { add_hobbies: ['x'.repeat(81)] })).toThrowError(expect.objectContaining({ code: 'too_long' }));
  });

  it('caps each list at 10 entries', () => {
    const { office } = office3();
    office.updateProfile('lead', { add_hobbies: Array.from({ length: 10 }, (_, i) => `h${i}`) });
    expect(() => office.updateProfile('lead', { add_hobbies: ['un de trop'] })).toThrowError(expect.objectContaining({ code: 'too_long' }));
  });
});

describe('opinions', () => {
  it('keeps the history and exposes the latest one', () => {
    const { office, clock } = office3();
    office.setOpinion('dev1', 'Hugo', 'Très carré, un peu intimidant au début.');
    clock.advance(60_000);
    office.setOpinion('dev1', 'archi', 'En fait très drôle quand on le connaît.');
    expect(office.currentOpinions({ author: 'dev1', about: 'archi' }).map((o) => o.body)).toEqual(['En fait très drôle quand on le connaît.']);
    expect(office.opinionHistory('dev1', 'archi')).toHaveLength(2);
  });

  it('accepts opinions on the creator, refuses opinions on yourself', () => {
    const { office } = office3();
    const o = office.setOpinion('lead', 'Le créateur', 'Exigeant mais il sait ce qu’il veut.');
    expect(o).toMatchObject({ about: 'creator', aboutName: 'Le créateur' });
    expect(() => office.setOpinion('lead', 'Inès', 'Moi ?')).toThrowError(expect.objectContaining({ code: 'invalid_input' }));
    expect(() => office.setOpinion('lead', 'Personne', 'x')).toThrowError(expect.objectContaining({ code: 'unknown_agent' }));
  });

  it('keeps others’ opinions private from agents, but shows everything to the human', () => {
    const { office } = office3();
    office.updateProfile('archi', { add_hobbies: ['Escalade'] });
    office.setOpinion('dev1', 'archi', 'Un vrai roc.');
    office.setOpinion('lead', 'archi', 'Fiable.');
    office.setOpinion('lead', 'creator', 'Curieux de tout.');

    const seenByDev1 = office.teamProfiles('dev1');
    const archi = seenByDev1.members.find((m) => m.name === 'archi')!;
    expect(archi.hobbies).toEqual(['Escalade']);
    expect(archi.yourOpinion).toBe('Un vrai roc.');
    expect(JSON.stringify(seenByDev1)).not.toContain('Fiable.');
    expect(JSON.stringify(seenByDev1)).not.toContain('Curieux de tout.');

    const ui = office.socialView();
    expect(ui.members.find((m) => m.name === 'archi')!.opinionsReceived.map((o) => o.authorName).sort()).toEqual(['Inès', 'Léa']);
    expect(ui.aboutCreator.map((o) => o.body)).toEqual(['Curieux de tout.']);
  });
});

describe('card feedback', () => {
  it('rates how clear a requested task is, any time, latest per agent', () => {
    const { office, clock } = makeOffice();
    const c = office.createCard('user', { title: 'Faire le truc' });
    expect(() => office.rateCard('dev1', c.id, 6, 'x')).toThrowError(expect.objectContaining({ code: 'invalid_input' }));
    expect(() => office.rateCard('dev1', c.id, 2, '')).toThrowError(expect.objectContaining({ code: 'invalid_input' }));
    office.rateCard('dev1', c.id, 2, 'Il manque le format attendu et le cas d’erreur.');
    clock.advance(1000);
    office.rateCard('archi', c.id, 3, 'Le but est clair, pas les contraintes.');
    clock.advance(1000);
    const r = office.rateCard('dev1', c.id, 4, 'Mieux après les précisions en commentaire.');
    expect(r.summary).toMatchObject({ count: 2, avgClarity: 3.5 });
    expect(office.getCard(c.id).feedback.items.map((i) => i.clarity)).toEqual([3, 4]);
    expect(office.listBoard()[0]!.cards[0]!.feedback).toEqual({ count: 2, avgClarity: 3.5 });
  });
});

describe('social over HTTP', () => {
  it('exposes the tools and the UI routes', async () => {
    const t = office3();
    const { office } = t;
    const app = buildHttp(t);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address();
    const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    const post = (url: string, body: unknown) => fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json() as any);
    try {
      expect((await post('/api/tools/set_opinion', { agent: 'lead', about: 'creator', opinion: 'Patient.' })).ok).toBe(true);
      expect((await post('/api/tools/update_profile', { agent: 'lead', add_dislikes: ['Le café froid'] })).result.dislikes).toEqual(['Le café froid']);
      expect((await post('/api/tools/team_profiles', { agent: 'lead' })).result.creator.yourOpinion).toBe('Patient.');
      const social = (await fetch(base + '/api/social').then((r) => r.json())) as any;
      expect(social.aboutCreator[0].body).toBe('Patient.');
      const hist = (await fetch(base + '/api/opinions/history?author=lead&about=creator').then((r) => r.json())) as any[];
      expect(hist).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});
