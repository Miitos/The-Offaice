import type { Capability } from '../config.js';

export const COLUMNS = ['BACKLOG', 'TODO', 'TO_DESIGN', 'IN_PROGRESS', 'IN_REVIEW', 'IN_TEST', 'DONE', 'BLOCKED'] as const;
export type Column = (typeof COLUMNS)[number];

export const COLUMN_LABELS: Record<Column, string> = {
  BACKLOG: 'BACKLOG',
  TODO: 'TODO',
  TO_DESIGN: 'TO DESIGN',
  IN_PROGRESS: 'IN PROGRESS',
  IN_REVIEW: 'IN REVIEW',
  IN_TEST: 'IN TEST',
  DONE: 'DONE',
  BLOCKED: 'BLOCKED'
};

export const ROOMS = ['desk', 'meeting', 'break', 'rest'] as const;
export type Room = (typeof ROOMS)[number];

/** Accepted spellings for a column ("IN REVIEW", "in-review", "in_review"…). */
export function parseColumn(input: string): Column | null {
  const norm = input.trim().toUpperCase().replace(/[\s-]+/g, '_');
  return (COLUMNS as readonly string[]).includes(norm) ? (norm as Column) : null;
}

/**
 * Forward/backward moves allowed between columns (BLOCKED handled separately:
 * any column but DONE can go to BLOCKED, and BLOCKED only goes back where it came from).
 */
const GRAPH: Record<Exclude<Column, 'BLOCKED'>, Column[]> = {
  BACKLOG: ['TODO'],
  TODO: ['BACKLOG', 'TO_DESIGN', 'IN_PROGRESS'],
  TO_DESIGN: ['TODO', 'IN_PROGRESS'],
  IN_PROGRESS: ['TODO', 'IN_REVIEW'],
  IN_REVIEW: ['IN_PROGRESS', 'IN_TEST'],
  IN_TEST: ['IN_PROGRESS', 'DONE'],
  DONE: []
};

/** Capability required to move a card INTO a column. */
export const ENTRY_CAPABILITY: Partial<Record<Column, Capability>> = {
  IN_TEST: 'reviewer',
  DONE: 'tester'
};

export type MoveCheck =
  | { ok: true }
  | { ok: false; code: 'same_column' | 'forbidden_transition' | 'capability_required' | 'review_comment_required'; message: string };

export interface MoveContext {
  from: Column;
  to: Column;
  blockedFrom: Column | null;
  actorCapabilities: readonly Capability[];
  /** A review comment was posted on the card since it entered IN_REVIEW. */
  hasReviewSinceEnteredReview: boolean;
  /** The team has a designer: only they take a card out of TODO (they check it is clear enough first). */
  designerGate?: boolean;
}

const CAPABILITY_LABEL: Partial<Record<Capability, string>> = { reviewer: 'reviewer', tester: 'testeur', designer: 'designer' };

export function checkMove(c: MoveContext): MoveCheck {
  if (c.from === c.to) return { ok: false, code: 'same_column', message: `La carte est déjà en ${COLUMN_LABELS[c.to]}.` };

  if (c.to === 'BLOCKED') {
    if (c.from === 'DONE') return { ok: false, code: 'forbidden_transition', message: 'Une carte DONE ne peut pas être bloquée.' };
  } else if (c.from === 'BLOCKED') {
    if (c.blockedFrom !== c.to) {
      return {
        ok: false,
        code: 'forbidden_transition',
        message: `Une carte BLOCKED ne peut repartir que vers sa colonne d'origine (${c.blockedFrom ? COLUMN_LABELS[c.blockedFrom] : 'inconnue'}).`
      };
    }
  } else if (!GRAPH[c.from].includes(c.to)) {
    const allowed = [...GRAPH[c.from], ...(c.from === 'DONE' ? [] : (['BLOCKED'] as Column[]))].map((x) => COLUMN_LABELS[x]);
    return {
      ok: false,
      code: 'forbidden_transition',
      message: `Passage ${COLUMN_LABELS[c.from]} → ${COLUMN_LABELS[c.to]} interdit. Depuis ${COLUMN_LABELS[c.from]} : ${allowed.join(', ') || 'aucun mouvement'}.`
    };
  }

  // Leaving IN_REVIEW (other than to BLOCKED) needs a review comment.
  if (c.from === 'IN_REVIEW' && c.to !== 'BLOCKED' && !c.hasReviewSinceEnteredReview) {
    return {
      ok: false,
      code: 'review_comment_required',
      message: 'Impossible de sortir de IN REVIEW sans commentaire de review : ajoute un comment_card de type "review" d\'abord.'
    };
  }

  const needed = c.to === 'BLOCKED' || c.from === 'BLOCKED' ? undefined : ENTRY_CAPABILITY[c.to];
  if (needed && !c.actorCapabilities.includes(needed)) {
    return {
      ok: false,
      code: 'capability_required',
      message: `Seul un agent ${CAPABILITY_LABEL[needed] ?? needed} peut passer une carte en ${COLUMN_LABELS[c.to]}.`
    };
  }
  if (c.designerGate && c.from === 'TODO' && (c.to === 'TO_DESIGN' || c.to === 'IN_PROGRESS') && !c.actorCapabilities.includes('designer')) {
    return {
      ok: false,
      code: 'capability_required',
      message: 'Seul le designer sort une carte de TODO : il vérifie d’abord que la demande est assez claire. Assigne-lui la carte et préviens-le.'
    };
  }
  return { ok: true };
}

/** Columns where an assigned card means "the agent is working on it". */
const WORK_COLUMNS: Column[] = ['TODO', 'TO_DESIGN', 'IN_PROGRESS', 'IN_REVIEW', 'IN_TEST'];

/**
 * A card assigned to an agent is *active* for it when the agent is the one expected to act.
 * In IN_REVIEW / IN_TEST, an agent without reviewer/tester capability is only waiting.
 */
export function cardStatusFor(col: Column, caps: readonly Capability[]): 'active' | 'waiting' | 'idle' {
  if (!WORK_COLUMNS.includes(col)) return 'idle';
  if (col === 'TODO') return caps.includes('designer') ? 'active' : 'idle';
  if (col === 'IN_REVIEW' && !caps.includes('reviewer')) return 'waiting';
  if (col === 'IN_TEST' && !caps.includes('tester')) return 'waiting';
  return 'active';
}
