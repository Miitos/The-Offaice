import { describe, expect, it } from 'vitest';
import { checkMove, parseColumn } from '../src/domain/rules.js';
import { cardInReview, makeOffice } from './helpers.js';

describe('parseColumn', () => {
  it('accepts several spellings', () => {
    expect(parseColumn('in review')).toBe('IN_REVIEW');
    expect(parseColumn('TO-DESIGN')).toBe('TO_DESIGN');
    expect(parseColumn('nope')).toBeNull();
  });
});

describe('checkMove', () => {
  const base = { blockedFrom: null, actorCapabilities: ['dev'] as const, hasReviewSinceEnteredReview: false };
  it('refuses skipping columns', () => {
    expect(checkMove({ ...base, from: 'BACKLOG', to: 'IN_PROGRESS' })).toMatchObject({ ok: false, code: 'forbidden_transition' });
  });
  it('only lets a reviewer enter IN_TEST', () => {
    expect(checkMove({ ...base, from: 'IN_REVIEW', to: 'IN_TEST', hasReviewSinceEnteredReview: true })).toMatchObject({ code: 'capability_required' });
    expect(checkMove({ ...base, actorCapabilities: ['reviewer'], from: 'IN_REVIEW', to: 'IN_TEST', hasReviewSinceEnteredReview: true })).toEqual({ ok: true });
  });
  it('only lets a tester enter DONE', () => {
    expect(checkMove({ ...base, actorCapabilities: ['reviewer'], from: 'IN_TEST', to: 'DONE' })).toMatchObject({ code: 'capability_required' });
    expect(checkMove({ ...base, actorCapabilities: ['tester'], from: 'IN_TEST', to: 'DONE' })).toEqual({ ok: true });
  });
  it('needs a review comment to leave IN_REVIEW, even backwards', () => {
    expect(checkMove({ ...base, actorCapabilities: ['reviewer'], from: 'IN_REVIEW', to: 'IN_PROGRESS' })).toMatchObject({ code: 'review_comment_required' });
  });
  it('lets any card but DONE be blocked, and only return where it came from', () => {
    expect(checkMove({ ...base, from: 'IN_REVIEW', to: 'BLOCKED' })).toEqual({ ok: true });
    expect(checkMove({ ...base, from: 'DONE', to: 'BLOCKED' })).toMatchObject({ code: 'forbidden_transition' });
    expect(checkMove({ ...base, from: 'BLOCKED', blockedFrom: 'IN_PROGRESS', to: 'TODO' })).toMatchObject({ code: 'forbidden_transition' });
    expect(checkMove({ ...base, from: 'BLOCKED', blockedFrom: 'IN_PROGRESS', to: 'IN_PROGRESS' })).toEqual({ ok: true });
  });
});

describe('Office kanban', () => {
  it('puts user cards in BACKLOG whatever is asked', () => {
    const { office } = makeOffice();
    const c = office.createCard('user', { title: 'Depuis l’UI', column: 'DONE' });
    expect(c.col).toBe('BACKLOG');
    expect(office.getCard(c.id).events[0]).toMatchObject({ kind: 'created', actor: 'user', to_col: 'BACKLOG' });
  });

  it('refuses user moves (UI is read-only)', () => {
    const { office } = makeOffice();
    const c = office.createCard('user', { title: 'x' });
    expect(() => office.moveCard('user', c.id, 'TODO')).toThrow(/lecture seule/);
  });

  it('records refused moves in the history', () => {
    const { office, clock } = makeOffice();
    const id = cardInReview(office, clock);
    expect(() => office.moveCard('dev1', id, 'IN TEST')).toThrowError(expect.objectContaining({ code: 'review_comment_required' }));
    const last = office.getCard(id).events.at(-1)!;
    expect(last).toMatchObject({ kind: 'move_refused', actor: 'dev1', from_col: 'IN_REVIEW', to_col: 'IN_TEST' });
  });

  it('runs the full review → test → done path', () => {
    const { office, clock } = makeOffice();
    const id = cardInReview(office, clock);
    expect(() => office.commentCard('dev1', id, 'LGTM', 'review')).toThrowError(expect.objectContaining({ code: 'capability_required' }));
    office.commentCard('reviewer', id, 'OK, deux détails corrigés', 'review');
    expect(() => office.moveCard('dev1', id, 'IN_TEST')).toThrowError(expect.objectContaining({ code: 'capability_required' }));
    office.moveCard('reviewer', id, 'IN_TEST');
    expect(() => office.moveCard('reviewer', id, 'DONE')).toThrowError(expect.objectContaining({ code: 'capability_required' }));
    office.moveCard('tester', id, 'DONE');
    const card = office.getCard(id);
    expect(card.col).toBe('DONE');
    expect(card.events.filter((e) => e.kind === 'moved').map((e) => e.to_col)).toEqual(['IN_PROGRESS', 'IN_REVIEW', 'IN_TEST', 'DONE']);
  });

  it('ignores a review written before the card came back to IN_REVIEW', () => {
    const { office, clock } = makeOffice();
    const id = cardInReview(office, clock);
    office.commentCard('reviewer', id, 'À reprendre', 'review');
    office.moveCard('reviewer', id, 'IN_PROGRESS');
    clock.advance(1000);
    office.moveCard('dev1', id, 'IN_REVIEW');
    clock.advance(1000);
    expect(() => office.moveCard('reviewer', id, 'IN_TEST')).toThrowError(expect.objectContaining({ code: 'review_comment_required' }));
  });

  it('lists the board with every column', () => {
    const { office, clock } = makeOffice();
    cardInReview(office, clock);
    const board = office.listBoard();
    expect(board.map((c) => c.column)).toEqual(['BACKLOG', 'TODO', 'TO_DESIGN', 'IN_PROGRESS', 'IN_REVIEW', 'IN_TEST', 'DONE', 'BLOCKED']);
    expect(board.find((c) => c.column === 'IN_REVIEW')!.cards).toHaveLength(1);
  });

  it('rejects unknown agents', () => {
    const { office } = makeOffice();
    expect(() => office.createCard('intrus', { title: 'x' })).toThrowError(expect.objectContaining({ code: 'unknown_agent' }));
  });
});
