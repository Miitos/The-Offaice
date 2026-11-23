import { AnimatePresence, LayoutGroup, motion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { type Agent, ago, clock, COLUMN_LABEL, displayName, fmtTokens, type OfficeState, pct, type Room, ROOM_LABEL } from '../api';
import { colorFor, Sprite, type SpriteState } from '../components/Sprite';
import { Icon } from '../components/ui';
import { href } from '../router';

const ROOM_META: Record<Room, { title: string; sub: string; color: string; floor: string }> = {
  desk: { title: 'BUREAU', sub: 'travail sur une carte', color: 'var(--blue)', floor: 'floor-desk' },
  meeting: { title: 'SALLE DE MEETING', sub: 'coordination', color: 'var(--violet)', floor: 'floor-meeting' },
  break: { title: 'SALLE DE PAUSE', sub: '1 msg / 5 min · 280 car.', color: 'var(--yellow)', floor: 'floor-break' },
  rest: { title: 'SALLE DE REPOS', sub: 'quota atteint → jusqu’au reset', color: 'var(--green)', floor: 'floor-rest' }
};

/** Seats per room: x in % of the room width, y = feet height in px from the bottom. */
const SEATS: Record<Room, { x: number; y: number }[]> = {
  desk: [
    { x: 17, y: 60 },
    { x: 50, y: 60 },
    { x: 83, y: 60 },
    { x: 17, y: 186 },
    { x: 50, y: 186 },
    { x: 83, y: 186 }
  ],
  meeting: [
    { x: 26, y: 150 },
    { x: 50, y: 150 },
    { x: 74, y: 150 },
    { x: 26, y: 30 },
    { x: 50, y: 30 },
    { x: 74, y: 30 }
  ],
  break: [
    { x: 12, y: 58 },
    { x: 27, y: 58 },
    { x: 42, y: 58 },
    { x: 60, y: 160 },
    { x: 76, y: 70 },
    { x: 40, y: 175 }
  ],
  rest: [
    { x: 20, y: 52 },
    { x: 50, y: 52 },
    { x: 80, y: 52 },
    { x: 20, y: 180 },
    { x: 50, y: 180 },
    { x: 80, y: 180 }
  ]
};

const BUBBLE_FRESH_MS = 4 * 60 * 1000;

function Typewriter({ text }: { text: string }) {
  const [n, setN] = useState(text.length);
  const prev = useRef(text);
  useEffect(() => {
    if (prev.current === text) return;
    prev.current = text;
    setN(0);
    const step = Math.max(1, Math.ceil(text.length / 40));
    const id = window.setInterval(() => {
      setN((v) => {
        if (v + step >= text.length) {
          window.clearInterval(id);
          return text.length;
        }
        return v + step;
      });
    }, 22);
    return () => window.clearInterval(id);
  }, [text]);
  return (
    <>
      {text.slice(0, n)}
      {n < text.length && <span className="caret" />}
    </>
  );
}

function spriteState(a: Agent, now: number, walking: boolean): SpriteState {
  if (walking) return 'walking';
  if (a.room === 'rest') return 'sleeping';
  const fresh = a.bubbleAt !== null && now - a.bubbleAt < 90_000;
  if (a.room === 'break' && a.lastBreakPostAt && now - a.lastBreakPostAt < 60_000) return 'talking';
  if (a.room === 'meeting' && fresh) return 'talking';
  if (a.room === 'desk' && fresh) return 'typing';
  return 'idle';
}

function Avatar({ agent, seat, now }: { agent: Agent; seat: { x: number; y: number }; now: number }) {
  const [walking, setWalking] = useState(false);
  const showBubble = !!agent.bubble && agent.bubbleAt !== null && now - agent.bubbleAt < BUBBLE_FRESH_MS && agent.room !== 'rest';
  const name = agent.persona?.firstName ?? agent.name;
  return (
    <div className="slot" style={{ left: `${seat.x}%`, bottom: seat.y }}>
      <motion.a
        layoutId={`agent-${agent.name}`}
        href={href.agent(agent.name)}
        className="avatar"
        aria-label={`${name} (${agent.name}), ${ROOM_LABEL[agent.room]}${agent.bubble ? ' : ' + agent.bubble : ''}`}
        title={agent.bubble ?? undefined}
        transition={{ layout: { duration: 1.3, ease: [0.45, 0, 0.25, 1] } }}
        onLayoutAnimationStart={() => setWalking(true)}
        onLayoutAnimationComplete={() => setWalking(false)}
        style={{ x: '-50%' }}
      >
        <AnimatePresence>
          {showBubble && !walking && (
            <motion.span
              key={agent.bubble}
              className={`bubble ${agent.room === 'break' ? 'break' : ''}`}
              initial={{ opacity: 0, scale: 0.6, y: 6, x: '-50%' }}
              animate={{ opacity: 1, scale: 1, y: 0, x: '-50%' }}
              exit={{ opacity: 0, scale: 0.8, x: '-50%' }}
              transition={{ type: 'spring', stiffness: 520, damping: 26 }}
            >
              <Typewriter text={agent.bubble!} />
            </motion.span>
          )}
        </AnimatePresence>
        <span className="nametag" style={{ color: colorFor(agent.name) }}>
          {name}
          {agent.currentCard && agent.room !== 'rest' && (
            <span className="cardtag" style={{ marginLeft: 5, padding: 0, background: 'none' }}>
              #{agent.currentCard.id}
              {agent.currentCard.status === 'waiting' ? ' ⏳' : ''}
            </span>
          )}
        </span>
        <span className="sprite-wrap">
          <Sprite name={agent.name} state={spriteState(agent, now, walking)} scale={3} />
          {agent.room === 'rest' && !walking && (
            <>
              <span className="zzz">z</span>
              <span className="zzz">z</span>
              <span className="zzz">z</span>
            </>
          )}
        </span>
      </motion.a>
    </div>
  );
}

function Furniture({ room, occupied, locked, retro }: { room: Room; occupied: boolean[]; locked: boolean; retro: boolean }) {
  if (room === 'desk') {
    return (
      <>
        {SEATS.desk.map((s, i) => (
          <div key={i}>
            <div className="f chair" style={{ left: `calc(${s.x}% - 11px)`, bottom: s.y + 34 }} />
            <div className="f desk-top" style={{ left: `calc(${s.x}% - 59px)`, bottom: s.y - 14, zIndex: 4 }} />
            <div className={`f monitor ${occupied[i] ? '' : 'off'}`} style={{ left: `calc(${s.x}% + 20px)`, bottom: s.y + 8, zIndex: 4 }}>
              <span className="code" />
            </div>
          </div>
        ))}
        <div className="f plant-leaf" style={{ right: 10, top: 40 }} />
        <div className="f plant-pot" style={{ right: 15, top: 62 }} />
      </>
    );
  }
  if (room === 'meeting') {
    return (
      <>
        <div className="f table" style={{ left: '14%', right: '14%', bottom: 88, zIndex: 4 }} />
        <div className="f board" style={{ right: 16, top: 44 }}>
          <i style={{ top: 10, width: 46 }} />
          <i style={{ top: 20, width: 34 }} />
          <i style={{ top: 30, width: 52 }} />
        </div>
        {retro && (
          <motion.div className="retro-banner pix" initial={{ y: -30, opacity: 0, x: '-50%' }} animate={{ y: 0, opacity: 1, x: '-50%' }} transition={{ type: 'spring', stiffness: 300, damping: 18 }}>
            RÉTROSPECTIVE
          </motion.div>
        )}
      </>
    );
  }
  if (room === 'break') {
    return (
      <>
        <div className="f sofa" style={{ left: '3%', bottom: 28, zIndex: 4 }} />
        <div className="f coffee" style={{ right: 22, bottom: 150 }} />
        <span className="steam" style={{ right: 40, bottom: 214 }} />
        <span className="steam" style={{ right: 34, bottom: 214, animationDelay: '0.8s' }} />
        <span className="steam" style={{ right: 44, bottom: 214, animationDelay: '1.6s' }} />
        <div className="f plant-leaf" style={{ right: 80, bottom: 26 }} />
        <div className="f plant-pot" style={{ right: 85, bottom: 12 }} />
        <div className={`f door ${locked ? 'closed' : 'open'}`} style={{ left: 0, top: 120 }} />
      </>
    );
  }
  return (
    <>
      {SEATS.rest.map((s, i) => (
        <div key={i} className="f bed" style={{ left: `calc(${s.x}% - 60px)`, bottom: s.y + 6 }} />
      ))}
    </>
  );
}

function RoomView({ room, agents, state, now }: { room: Room; agents: Agent[]; state: OfficeState; now: number }) {
  const meta = ROOM_META[room];
  const order = state.agents.map((a) => a.name);
  // Stable seats: an agent keeps "its" seat index in every room.
  const seated = agents.map((a) => ({ a, seat: SEATS[room][order.indexOf(a.name) % SEATS[room].length]! }));
  const occupied = SEATS[room].map((_, i) => seated.some((s) => order.indexOf(s.a.name) % SEATS[room].length === i));
  const locked = room === 'break' && state.breakRoom.locked;
  return (
    <section className={`room ${meta.floor} ${locked ? 'locked' : ''}`} aria-label={`${meta.title} : ${agents.length ? agents.map((a) => a.persona?.firstName ?? a.name).join(', ') : 'vide'}`}>
      <div className="room-wall" />
      <div className="room-label">
        <span className="pix" style={{ color: meta.color }}>
          {meta.title}
        </span>
        <small>
          {meta.sub} · {agents.length === 0 ? 'vide' : agents.length === 1 ? '1 agent' : `${agents.length} agents`}
        </small>
      </div>
      <Furniture room={room} occupied={occupied} locked={locked} retro={room === 'meeting' && !!state.retro.current} />
      {seated.map(({ a, seat }) => (
        <Avatar key={a.name} agent={a} seat={seat} now={now} />
      ))}
      {room === 'rest' && agents.length === 0 && (
        <p style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', width: 'min(340px, 86%)', textAlign: 'center', color: '#cfe0d4', fontSize: 13, margin: 0, zIndex: 5, padding: '10px 14px', background: 'rgba(14, 24, 19, 0.88)', border: '2px solid #2f4a3a', borderRadius: 4 }}>
          Personne ici. Un agent y va seul quand il atteint sa part du quota, et en ressort au reset.
        </p>
      )}
      <AnimatePresence>
        {locked && (
          <>
            <motion.div className="room-dim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
            <motion.div className="lock-badge" initial={{ scale: 0.5, opacity: 0, x: '-50%', y: '-50%' }} animate={{ scale: 1, opacity: 1, x: '-50%', y: '-50%' }} exit={{ scale: 0.6, opacity: 0, x: '-50%', y: '-50%' }} transition={{ type: 'spring', stiffness: 380, damping: 20 }}>
              <Icon name="lock" color="var(--amber)" size={18} />
              <span className="pix" style={{ color: 'var(--amber)', fontSize: 13 }}>
                SALLE FERMÉE
              </span>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </section>
  );
}

function Conversation({ state }: { state: OfficeState }) {
  const posts = [...state.breakRoom.posts].reverse().slice(-14);
  const present = state.agents.filter((a) => a.room === 'break');
  return (
    <section className="frame convo pad stack" aria-labelledby="convo-h">
      <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, alignItems: 'baseline' }}>
        <h2 id="convo-h" className="section-title" style={{ color: 'var(--yellow)' }}>
          Salle de pause · conversation
        </h2>
        <span style={{ fontSize: 12, color: '#c9bfa3' }}>{state.breakRoom.locked ? 'Salle fermée' : present.length ? 'Présents : ' + present.map((a) => a.persona?.firstName ?? a.name).join(', ') : 'Personne en pause'}</span>
      </div>
      {posts.length === 0 ? (
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          Pas encore de conversation. Les agents viennent ici quand ils n’ont pas de carte en cours, ou en attendant une review.
        </p>
      ) : (
        <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <AnimatePresence initial={false}>
            {posts.map((p) => (
              <motion.li key={p.id} className="msg" layout initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ type: 'spring', stiffness: 380, damping: 30 }}>
                <span style={{ flex: '0 0 auto', marginTop: 2 }}>
                  <Sprite name={p.agent} scale={1.6} />
                </span>
                <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                  <span>
                    <span className="who" style={{ color: colorFor(p.agent) }}>
                      {p.author}
                    </span>{' '}
                    {p.replyToAuthor && <span className="reply">↳ à {p.replyToAuthor}</span>}{' '}
                    <time className="mono muted" style={{ fontSize: 11 }}>
                      {clock(p.at)}
                    </time>
                  </span>
                  <span className="text">{p.body}</span>
                </span>
              </motion.li>
            ))}
          </AnimatePresence>
        </ol>
      )}
      <p style={{ margin: 0, fontSize: 11, color: '#a99f84' }}>Sans recherche web : un message sur l’actu précise que l’info peut dater. Les tokens de pause comptent dans le quota de chacun.</p>
    </section>
  );
}

export function describeCardEvent(state: OfficeState, e: OfficeState['recentCardEvents'][number]) {
  const who = displayName(state, e.actor);
  switch (e.kind) {
    case 'created':
      return `${who} a créé #${e.card_id} « ${e.card_title} »`;
    case 'moved':
      return `${who} : #${e.card_id} ${COLUMN_LABEL[e.from_col!]} → ${COLUMN_LABEL[e.to_col!]}`;
    case 'move_refused':
      return `${who} : refusé #${e.card_id} → ${COLUMN_LABEL[e.to_col!]} (${(e.detail ?? '').slice(0, 70)})`;
    case 'assigned':
      return `${who} assigne #${e.card_id} à ${displayName(state, e.detail ?? '')}`;
    case 'commented':
      return `${who} commente #${e.card_id}${e.detail === 'review' ? ' (review)' : ''}`;
  }
}

function Activity({ state }: { state: OfficeState }) {
  const items = useMemo(() => {
    const cards = state.recentCardEvents.map((e) => ({ key: `c${e.id}`, at: e.at, agent: e.actor, text: describeCardEvent(state, e), bad: e.kind === 'move_refused' }));
    const rooms = state.recentRoomEvents.map((e) => ({
      key: `r${e.id}`,
      at: e.at,
      agent: e.agent,
      text: `${displayName(state, e.agent)} → ${ROOM_LABEL[e.to_room]}${e.reason ? ` (${e.reason})` : ''}`,
      bad: e.to_room === 'rest'
    }));
    return [...cards, ...rooms].sort((a, b) => b.at - a.at).slice(0, 12);
  }, [state]);
  return (
    <section className="frame pad stack" style={{ flex: '2 1 420px', minWidth: 0 }} aria-labelledby="act-h">
      <h2 id="act-h" className="section-title">
        Fil d’activité
      </h2>
      <ul className="feed">
        <AnimatePresence initial={false}>
          {items.map((i) => (
            <motion.li key={i.key} layout initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }}>
              <time>{clock(i.at)}</time>
              <span style={{ width: 8, height: 8, flex: '0 0 8px', background: colorFor(i.agent), alignSelf: 'center' }} />
              <span style={{ color: i.bad ? 'var(--rose)' : 'var(--text-2)' }}>{i.text}</span>
            </motion.li>
          ))}
        </AnimatePresence>
        {items.length === 0 && <li className="muted">Rien pour l’instant.</li>}
      </ul>
    </section>
  );
}

function LockHistory({ state }: { state: OfficeState }) {
  return (
    <section className="frame pad stack" style={{ flex: '1 1 280px', minWidth: 0 }} aria-labelledby="lock-h">
      <h2 id="lock-h" className="section-title">
        Porte de la pause
      </h2>
      <ul className="feed">
        {state.breakRoom.history.slice(0, 6).map((h) => (
          <li key={h.id} style={{ justifyContent: 'space-between' }}>
            <span>
              <strong style={{ color: h.locked ? 'var(--amber)' : 'var(--green)' }}>{h.locked ? 'Fermée' : 'Rouverte'}</strong> par {h.actor === 'user' ? 'toi' : displayName(state, h.actor)}
              {h.reason ? <span className="muted"> · {h.reason}</span> : null}
            </span>
            <span className="muted" style={{ whiteSpace: 'nowrap', fontSize: 12 }}>
              {ago(h.at, state.at)}
            </span>
          </li>
        ))}
        {state.breakRoom.history.length === 0 && <li className="muted">Jamais fermée.</li>}
      </ul>
    </section>
  );
}

export function AgentRail({ state }: { state: OfficeState }) {
  return (
    <aside className="office-rail" aria-label="Équipe">
      <h2 className="section-title">Équipe · {state.agents.length} agents</h2>
      {state.agents.map((a, i) => {
        const u = state.usage.agents.find((x) => x.name === a.name);
        const used = Math.min(100, u?.usedOfSharePct ?? 0);
        const pausePart = used * ((u?.pausePct ?? 0) / 100);
        const color = colorFor(a.name);
        const roomColor = ROOM_META[a.room].color;
        return (
          <motion.a key={a.name} href={href.agent(a.name)} className="frame agent-row" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.05 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Sprite name={a.name} scale={2} state={a.room === 'rest' ? 'sleeping' : 'idle'} />
              <span style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
                <span style={{ fontWeight: 600 }}>
                  {a.persona?.firstName ?? a.name} <span className="muted" style={{ fontWeight: 400 }}>· {a.role}</span>
                </span>
                <span className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {a.name} · {a.model} · {a.currentCard ? `#${a.currentCard.id} ${COLUMN_LABEL[a.currentCard.col]}` : 'pas de carte'}
                </span>
              </span>
              <motion.span key={a.room} className="chip" style={{ background: roomColor }} initial={{ scale: 0.6 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 500, damping: 18 }}>
                {ROOM_LABEL[a.room]}
              </motion.span>
            </span>
            <span className="bar" aria-label={`${pct(used)} de sa part utilisés`}>
              <span style={{ width: `${used}%`, background: used >= 100 ? 'var(--rose)' : color }} />
              <span className="pause" style={{ width: `${pausePart}%` }} />
            </span>
            <span style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }} className="muted">
              <span>
                {pct(u?.usedOfSharePct ?? 0)} de sa part ({String(a.share).replace('.', ',')} %) · {fmtTokens(u?.tokens ?? 0)} tokens
              </span>
              <span>dont pause : {pct(u?.pausePct ?? 0)}</span>
            </span>
          </motion.a>
        );
      })}
    </aside>
  );
}

export function Office2DView({ state }: { state: OfficeState }) {
  const now = Date.now();
  const byRoom = (r: Room) => state.agents.filter((a) => a.room === r);
  return (
    <div className="office-layout">
      <div className="office-main">
        <LayoutGroup>
          <div className="plan">
            {(['desk', 'meeting', 'break', 'rest'] as Room[]).map((r) => (
              <RoomView key={r} room={r} agents={byRoom(r)} state={state} now={now} />
            ))}
          </div>
        </LayoutGroup>
        <Conversation state={state} />
        <div className="row">
          <Activity state={state} />
          <LockHistory state={state} />
        </div>
      </div>
      <AgentRail state={state} />
    </div>
  );
}
