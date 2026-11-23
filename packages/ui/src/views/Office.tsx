import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { type Agent, ago, clock, COLUMN_LABEL, displayName, type OfficeState, pct, ROOM_LABEL } from '../api';
import { colorFor } from '../components/Sprite';
import { href } from '../router';
import type { Diorama } from '../three/Diorama';
import { drawPortrait } from '../three/sprites';
import { describeCardEvent, Office2DView } from './Office2D';

const MODE_KEY = 'agent-office:office-mode';
function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function readMode(): '3d' | '2d' {
  try {
    const m = window.localStorage.getItem(MODE_KEY);
    if (m === '2d') return '2d';
  } catch {
    /* storage blocked: default */
  }
  return webglAvailable() ? '3d' : '2d';
}
function saveMode(m: '3d' | '2d') {
  try {
    window.localStorage.setItem(MODE_KEY, m);
  } catch {
    /* ignore */
  }
}

export function OfficeView({ state }: { state: OfficeState }) {
  const [mode, setMode] = useState(readMode);
  const [failed, setFailed] = useState(false);
  const set = (m: '3d' | '2d') => {
    saveMode(m);
    setMode(m);
  };
  if (mode === '2d' || failed)
    return (
      <div className="stack" style={{ gap: 14, padding: '20px 24px 40px', maxWidth: 1640, margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          {failed ? (
            <span className="muted" style={{ fontSize: 12 }}>
              Vue 3D indisponible (WebGL) : plan 2D.
            </span>
          ) : (
            <button className="btn btn-sm" onClick={() => set('3d')}>
              Vue 3D
            </button>
          )}
        </div>
        <Office2DView state={state} />
      </div>
    );
  return <Office3D state={state} onFail={() => setFailed(true)} on2D={() => set('2d')} />;
}

function Portrait({ name, rows = 14, className }: { name: string; rows?: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) drawPortrait(ref.current, name, rows);
  }, [name, rows]);
  return <canvas ref={ref} className={className} width={16} height={rows >= 22 ? 22 : 14} aria-hidden="true" />;
}

const ROOM_CHIP: Record<Agent['room'], string> = { desk: 'BUREAU', meeting: 'RÉUNION', break: 'PAUSE', rest: 'REPOS' };

function Office3D({ state, onFail, on2D }: { state: OfficeState; onFail: () => void; on2D: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const dio = useRef<Diorama | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const failRef = useRef(onFail);
  failRef.current = onFail;

  useEffect(() => {
    const host = hostRef.current, overlay = overlayRef.current;
    if (!host || !overlay) return;
    let cancelled = false;
    // three.js is loaded on demand: the other views don't pay for it.
    import('../three/Diorama')
      .then(({ Diorama }) => {
        if (cancelled) return;
        const d = new Diorama(host, overlay, { reducedMotion: reducedMotion() });
        d.onSelect = setSelected;
        d.sync(stateRef.current);
        dio.current = d;
      })
      .catch(() => !cancelled && failRef.current());
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target as HTMLElement).closest?.('input,textarea,[role=dialog]')) {
        setSelected(null);
        dio.current?.select(null);
        dio.current?.home();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      cancelled = true;
      window.removeEventListener('keydown', onKey);
      dio.current?.dispose();
      dio.current = null;
    };
  }, []);

  useEffect(() => {
    dio.current?.sync(state);
  }, [state]);

  const pickAgent = (name: string | null) => {
    setSelected(name);
    dio.current?.select(name);
  };

  const activity = useMemo(() => {
    const cards = state.recentCardEvents.map((e) => ({ key: `c${e.id}`, at: e.at, agent: e.actor, text: describeCardEvent(state, e), bad: e.kind === 'move_refused' }));
    const rooms = state.recentRoomEvents.map((e) => ({ key: `r${e.id}`, at: e.at, agent: e.agent, text: `${displayName(state, e.agent)} → ${ROOM_LABEL[e.to_room]}${e.reason ? ` (${e.reason})` : ''}`, bad: e.to_room === 'rest' }));
    return [...cards, ...rooms].sort((a, b) => b.at - a.at).slice(0, 8);
  }, [state]);
  // Whole recent conversation, oldest first, in a scrollable list that follows new messages.
  const posts = useMemo(() => [...state.breakRoom.posts].sort((a, b) => a.id - b.id), [state.breakRoom.posts]);
  const convoRef = useRef<HTMLOListElement>(null);
  const stickToEnd = useRef(true);
  const lastPostId = posts[posts.length - 1]?.id;
  useEffect(() => {
    const el = convoRef.current;
    if (el && stickToEnd.current) el.scrollTop = el.scrollHeight;
  }, [lastPostId]);
  const sel = state.agents.find((a) => a.name === selected) ?? null;
  const retro = state.retro.current;

  return (
    <div className="o3d">
      <div className="o3d-stage" ref={hostRef} />
      <div className="o3d-overlay" ref={overlayRef} />

      <AnimatePresence>
        {retro && (
          <motion.a href={href.retro} className="win o3d-banner" initial={{ y: -60, x: '-50%', opacity: 0 }} animate={{ y: 0, x: '-50%', opacity: 1 }} exit={{ y: -60, x: '-50%', opacity: 0 }}>
            Rétrospective en cours
            <small>{retro.topic ?? 'Toute l’équipe est en salle de réunion'}</small>
          </motion.a>
        )}
      </AnimatePresence>

      {/* Journal and break room share the left column: the journal gives way first, they never overlap. */}
      <div className="o3d-left">
      <section className="win o3d-journal" aria-labelledby="j-h">
        <h2 id="j-h" className="eyebrow">
          Journal
        </h2>
        <ol>
          <AnimatePresence initial={false}>
            {activity.map((i) => (
              <motion.li key={i.key} layout initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }}>
                <time>{clock(i.at)}</time>
                <i style={{ background: colorFor(i.agent) }} />
                <span style={i.bad ? { color: 'var(--rose)' } : undefined}>{i.text}</span>
              </motion.li>
            ))}
          </AnimatePresence>
          {activity.length === 0 && <li className="muted">Rien pour l’instant.</li>}
        </ol>
      </section>

      <section className="win o3d-convo" aria-labelledby="c-h">
        <h2 id="c-h" className="eyebrow" style={{ color: 'var(--green)' }}>
          Salle de pause{state.breakRoom.locked ? ' · fermée' : ''}
        </h2>
        {posts.length === 0 ? (
          <p className="muted">Pas encore de conversation.</p>
        ) : (
          <ol
            ref={convoRef}
            className="convo-scroll"
            tabIndex={0}
            aria-label="Messages de la salle de pause"
            onScroll={(e) => {
              const el = e.currentTarget;
              stickToEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
            }}
          >
            {posts.map((p) => (
              <li key={p.id}>
                <strong style={{ color: colorFor(p.agent) }}>{p.author}</strong>
                {p.replyToAuthor && <span className="muted"> à {p.replyToAuthor}</span>} <time>{clock(p.at)}</time>
                <span className="msg-body">{p.body}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
      </div>

      <div className="win o3d-cmds" role="group" aria-label="Caméra">
        <button className="cmd" onClick={() => { pickAgent(null); dio.current?.home(); }}>
          Vue d’ensemble <span className="k">Échap</span>
        </button>
        <div className="cam-row">
          <button onClick={() => dio.current?.zoomBy(0.8)} aria-label="Zoomer">+</button>
          <button onClick={() => dio.current?.zoomBy(1.25)} aria-label="Dézoomer">−</button>
          <button onClick={() => dio.current?.rotateBy(-0.3)} aria-label="Tourner à gauche">⟲</button>
          <button onClick={() => dio.current?.rotateBy(0.3)} aria-label="Tourner à droite">⟳</button>
        </div>
        <button className="cmd" onClick={on2D}>
          Plan 2D
        </button>
      </div>

      <AnimatePresence>
        {sel && (
          <motion.aside key={sel.name} className="win o3d-status" initial={{ x: 40, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 40, opacity: 0 }} transition={{ type: 'spring', stiffness: 360, damping: 30 }} aria-label={`Fiche de ${sel.persona?.firstName ?? sel.name}`}>
            <StatusCard state={state} agent={sel} onClose={() => pickAgent(null)} />
          </motion.aside>
        )}
      </AnimatePresence>

      <nav className="win o3d-party" aria-label="Équipe">
        {state.agents.map((a) => {
          const u = state.usage.agents.find((x) => x.name === a.name);
          const used = Math.min(100, u?.usedOfSharePct ?? 0);
          const left = 100 - used;
          return (
            <button key={a.name} className={`member ${selected === a.name ? 'sel' : ''}`} onClick={() => pickAgent(selected === a.name ? null : a.name)} title={`${a.persona?.firstName ?? a.name} · ${pct(used)} de sa part utilisés · dont pause ${pct(u?.pausePct ?? 0)}`}>
              <Portrait name={a.name} className="face" />
              <span className="m-body">
                <span className="nm">
                  <strong>{a.persona?.firstName ?? a.name}</strong>
                  <em>{a.role}</em>
                </span>
                <span className="where">
                  <span className={`st ${a.room}`}>{ROOM_CHIP[a.room]}</span>
                  {a.currentCard ? `#${a.currentCard.id}${a.currentCard.status === 'waiting' ? ' (attente)' : ''}` : 'sans carte'}
                </span>
                <span className="bars">
                  <span>PART</span>
                  <span className="mbar hp">
                    <i className={left < 15 ? 'bad' : left < 35 ? 'warn' : ''} style={{ width: `${Math.max(3, left)}%` }} />
                  </span>
                  <span>PAUSE</span>
                  <span className="mbar mp">
                    <i style={{ width: `${Math.min(100, u?.pausePct ?? 0)}%` }} />
                  </span>
                </span>
              </span>
            </button>
          );
        })}
      </nav>
      <noscript>Le bureau 3D a besoin de JavaScript.</noscript>
    </div>
  );
}

function StatusCard({ state, agent, onClose }: { state: OfficeState; agent: Agent; onClose: () => void }) {
  const u = state.usage.agents.find((x) => x.name === agent.name);
  const op = state.social.aboutCreator.find((o) => o.author === agent.name);
  const p = agent.persona;
  return (
    <>
      <button className="x" onClick={onClose} aria-label="Fermer la fiche">
        ×
      </button>
      <div className="st-head">
        <Portrait name={agent.name} rows={22} />
        <div>
          <div className="eyebrow">{agent.role}</div>
          <h2>{p ? `${p.firstName}${p.lastName ? ' ' + p.lastName : ''}` : agent.name}</h2>
          <p>
            {agent.name} · {agent.model} · part {String(agent.share).replace('.', ',')} %
          </p>
        </div>
      </div>
      <dl className="st-grid">
        <dt>Pièce</dt>
        <dd>{ROOM_LABEL[agent.room]}</dd>
        <dt>Carte</dt>
        <dd>{agent.currentCard ? `#${agent.currentCard.id} ${agent.currentCard.title} · ${COLUMN_LABEL[agent.currentCard.col]}` : 'aucune'}</dd>
        <dt>Quota</dt>
        <dd>
          {pct(u?.usedOfSharePct ?? 0)} de sa part · dont pause {pct(u?.pausePct ?? 0)}
        </dd>
        {agent.bubble && (
          <>
            <dt>Dernière action</dt>
            <dd>
              {agent.bubble} <span className="muted">{ago(agent.bubbleAt, state.at)}</span>
            </dd>
          </>
        )}
        {p?.favoriteMovie && (
          <>
            <dt>Film</dt>
            <dd>{p.favoriteMovie}</dd>
          </>
        )}
        {p?.favoriteMusic && (
          <>
            <dt>Musique</dt>
            <dd>{p.favoriteMusic}</dd>
          </>
        )}
        {agent.hobbies.length > 0 && (
          <>
            <dt>Hobbies</dt>
            <dd>{agent.hobbies.join(', ')}</dd>
          </>
        )}
        {agent.dislikes.length > 0 && (
          <>
            <dt>N’aime pas</dt>
            <dd>{agent.dislikes.join(', ')}</dd>
          </>
        )}
      </dl>
      {op && (
        <blockquote className="st-quote">
          <small>Avis sur Le créateur</small>« {op.body} »
        </blockquote>
      )}
      <div className="st-links">
        <a href={href.agent(agent.name)}>Activité</a>
        <a href={href.agent(agent.name, 'profil')}>Profil et avis</a>
      </div>
    </>
  );
}
