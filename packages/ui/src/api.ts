import { useCallback, useEffect, useRef, useState } from 'react';

// ───────────── Types (shape of GET /api/state)

export type Room = 'desk' | 'meeting' | 'break' | 'rest';
export type Column = 'BACKLOG' | 'TODO' | 'TO_DESIGN' | 'IN_PROGRESS' | 'IN_REVIEW' | 'IN_TEST' | 'DONE' | 'BLOCKED';

export interface Persona {
  firstName: string;
  lastName: string | null;
  favoriteMovie: string | null;
  favoriteMusic: string | null;
}

export interface Agent {
  name: string;
  role: string;
  capabilities: string[];
  model: string;
  share: number;
  configShare: number;
  worktree: string | null;
  persona: Persona | null;
  room: Room;
  bubble: string | null;
  bubbleAt: number | null;
  currentCard: { id: number; title: string; col: Column; status: 'active' | 'waiting' } | null;
  lastBreakPostAt: number | null;
  hobbies: string[];
  dislikes: string[];
}

export interface Project {
  id: string;
  name: string;
  repoPath: string;
  mainBranch: string;
  active: boolean;
  cards: number;
  openCards: number;
}

export interface Card {
  id: number;
  project: string | null;
  title: string;
  description: string;
  assignee: string | null;
  blockedFrom: Column | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  enteredColumnAt: number;
  commentCount: number;
  reviewCommentInColumn: boolean;
  feedback: { count: number; avgClarity: number | null };
}

export interface BoardColumn {
  column: Column;
  label: string;
  cards: Card[];
}

export interface BreakPost {
  id: number;
  agent: string;
  author: string;
  at: number;
  body: string;
  replyTo: number | null;
  replyToAuthor: string | null;
}

export interface Opinion {
  id: number;
  author: string;
  authorName: string;
  about: string;
  aboutName: string;
  body: string;
  at: number;
}

export interface CardEvent {
  id: number;
  card_id: number;
  card_title: string;
  at: number;
  actor: string;
  kind: 'created' | 'moved' | 'move_refused' | 'assigned' | 'commented';
  from_col: Column | null;
  to_col: Column | null;
  detail: string | null;
}

export interface RoomEvent {
  id: number;
  agent: string;
  at: number;
  from_room: Room | null;
  to_room: Room;
  source: string;
  reason: string | null;
}

export interface UsageAgent {
  name: string;
  tokens: number;
  pauseTokens: number;
  weighted: number;
  pctOfQuota: number;
  limitPct: number;
  usedOfSharePct: number;
  pausePct: number;
  stopAtPct: number;
}

export interface Proposal {
  id: number;
  kind: 'quota' | 'process' | 'other';
  title: string;
  details: string;
  shares: Record<string, number> | null;
  author: string;
  authorName: string;
  status: 'open' | 'adopted' | 'rejected';
  votesFor: string[];
  votesAgainst: string[];
  appliedAt: number | null;
  revertedAt: number | null;
}

export interface RetroCurrent {
  open: true;
  id: number;
  topic: string | null;
  startedAt: number;
  participants: string[];
  majority: number;
  messages: { id: number; agent: string; author: string; at: number; body: string; replyTo: number | null }[];
  proposals: Proposal[];
  currentShares: Record<string, number>;
  agreements: Agreement[];
}

export interface Agreement {
  id: number;
  proposalId: number | null;
  title: string;
  text: string;
  at: number;
}

export interface OfficeState {
  at: number;
  agents: Agent[];
  projects: Project[];
  activeProject: string;
  board: BoardColumn[];
  breakRoom: {
    locked: boolean;
    history: { id: number; at: number; locked: boolean; actor: string; reason: string | null }[];
    posts: BreakPost[];
    cooldownSeconds: number;
    maxChars: number;
  };
  quota: {
    source: string;
    hardCapPct: number;
    stopAtPct: number;
    autoLockBreakRoomPct: number;
    latest: null | { at: number; source: string; fiveHour: { usedPct: number; resetsAt: number | null } | null; sevenDay: { usedPct: number; resetsAt: number | null } | null };
    globalPct: number | null;
  };
  social: {
    creatorLabel: string;
    members: { name: string; persona: Persona | null; hobbies: string[]; dislikes: string[]; opinionsGiven: Opinion[]; opinionsReceived: Opinion[] }[];
    aboutCreator: Opinion[];
  };
  usage: { method: string; windowStart: number; baselinePct: number; resetsAt: number | null; globalPct: number | null; teamWeighted: number; agents: UsageAgent[] };
  retro: { current: RetroCurrent | null; agreements: Agreement[]; history: { id: number; topic: string | null; status: string; startedAt: number; closedAt: number | null; summary: string | null; proposals: Proposal[] }[] };
  recentCardEvents: CardEvent[];
  recentRoomEvents: RoomEvent[];
}

export interface LiveEvent {
  type: string;
  at: number;
  data: any;
}

// ───────────── HTTP

export async function api<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.message ?? `Erreur ${res.status}`);
  return json as T;
}

// ───────────── Live state: snapshot + SSE, refetched (debounced) on every event

export function useOffice() {
  const [state, setState] = useState<OfficeState | null>(null);
  const [live, setLive] = useState<'connecting' | 'live' | 'offline'>('connecting');
  const [tick, setTick] = useState(0);
  const listeners = useRef(new Set<(e: LiveEvent) => void>());
  const timer = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await api<OfficeState>('GET', '/api/state');
      setState(s);
      setTick((t) => t + 1);
    } catch {
      setLive('offline');
    }
  }, []);

  useEffect(() => {
    refresh();
    const es = new EventSource('/api/events');
    const schedule = () => {
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(refresh, 120);
    };
    es.onopen = () => {
      setLive('live');
      refresh();
    };
    es.onerror = () => setLive('offline');
    const onAny = (ev: MessageEvent) => {
      try {
        const e = JSON.parse(ev.data) as LiveEvent;
        listeners.current.forEach((fn) => fn(e));
      } catch {
        /* ignore */
      }
      schedule();
    };
    const types = ['card', 'card_event', 'comment', 'agent', 'room', 'break_post', 'break_lock', 'quota', 'profile', 'opinion', 'card_feedback', 'retro', 'retro_message', 'retro_proposal', 'retro_vote', 'retro_revert', 'shares', 'usage', 'settings'];
    types.forEach((t) => es.addEventListener(t, onAny as EventListener));
    // Clocks (cooldowns, "il y a…") move even without events.
    const clock = window.setInterval(() => setTick((t) => t + 1), 15_000);
    return () => {
      es.close();
      window.clearInterval(clock);
    };
  }, [refresh]);

  const onEvent = useCallback((fn: (e: LiveEvent) => void) => {
    listeners.current.add(fn);
    return () => {
      listeners.current.delete(fn);
    };
  }, []);

  return { state, live, refresh, onEvent, tick };
}

/** Polls a GET endpoint while mounted, and again whenever `dep` changes. */
export function useFetch<T>(path: string | null, dep: unknown, everyMs = 0) {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    const load = () => api<T>('GET', path).then((d) => alive && setData(d)).catch(() => {});
    load();
    const id = everyMs ? window.setInterval(load, everyMs) : 0;
    return () => {
      alive = false;
      if (id) window.clearInterval(id);
    };
  }, [path, dep, everyMs]);
  return data;
}

// ───────────── Helpers

export const COLUMN_LABEL: Record<Column, string> = {
  BACKLOG: 'BACKLOG',
  TODO: 'TODO',
  TO_DESIGN: 'TO DESIGN',
  IN_PROGRESS: 'IN PROGRESS',
  IN_REVIEW: 'IN REVIEW',
  IN_TEST: 'IN TEST',
  DONE: 'DONE',
  BLOCKED: 'BLOCKED'
};

export const ROOM_LABEL: Record<Room, string> = { desk: 'Bureau', meeting: 'Meeting', break: 'Pause', rest: 'Repos' };

export function displayName(state: OfficeState | null, agent: string): string {
  if (agent === 'user') return 'Le créateur';
  if (agent === 'creator') return 'Le créateur';
  if (agent === 'auto') return 'automatique';
  if (agent === 'reset') return 'reset du quota';
  return state?.agents.find((a) => a.name === agent)?.persona?.firstName ?? agent;
}

export function ago(at: number | null | undefined, now = Date.now()): string {
  if (!at) return '';
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return 'à l’instant';
  const m = Math.round(s / 60);
  if (m < 60) return `il y a ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `il y a ${h} h${m % 60 ? ' ' + String(m % 60).padStart(2, '0') : ''}`;
  return new Date(at).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }) + ' ' + clock(at);
}

export function clock(at: number) {
  return new Date(at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

export function fmtTokens(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace('.', ',') + ' M';
  if (n >= 1000) return Math.round(n / 1000) + ' k';
  return String(n);
}

export function pct(n: number | null | undefined) {
  if (n === null || n === undefined) return '–';
  return String(Math.round(n * 10) / 10).replace('.', ',') + ' %';
}
