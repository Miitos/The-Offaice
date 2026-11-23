import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { ago, clock, COLUMN_LABEL, displayName, fmtTokens, type OfficeState, type Opinion, pct, type RoomEvent, ROOM_LABEL, useFetch } from '../api';
import { colorFor, Sprite } from '../components/Sprite';
import { clarityColor, Icon } from '../components/ui';
import { href } from '../router';

interface Entry {
  at: number;
  kind: 'text' | 'tool' | 'result' | 'prompt';
  text: string;
  tool?: string;
  isError?: boolean;
}

const KIND: Record<Entry['kind'], { label: (e: Entry) => string; color: string; bg: string }> = {
  text: { label: () => 'texte', color: 'var(--text)', bg: 'transparent' },
  tool: { label: (e) => (e.tool ?? 'outil').replace('mcp__office__', 'office·'), color: 'var(--blue)', bg: 'var(--bg-2)' },
  result: { label: (e) => (e.isError ? 'erreur' : 'résultat'), color: 'var(--muted)', bg: 'transparent' },
  prompt: { label: () => 'message', color: 'var(--amber)', bg: '#1f1b12' }
};

function Identity({ state, name }: { state: OfficeState; name: string }) {
  const a = state.agents.find((x) => x.name === name)!;
  return (
    <section className="frame" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 22, padding: '18px 22px' }}>
      <motion.div initial={{ scale: 0.6, rotate: -8 }} animate={{ scale: 1, rotate: 0 }} transition={{ type: 'spring', stiffness: 300, damping: 14 }}>
        <Sprite name={name} scale={6} state={a.room === 'rest' ? 'sleeping' : 'idle'} />
      </motion.div>
      <div className="stack" style={{ flex: '1 1 280px', gap: 4 }}>
        <h1 className="pix" style={{ margin: 0, fontSize: 26, fontWeight: 400, color: colorFor(name) }}>
          {a.persona ? `${a.persona.firstName} ${a.persona.lastName ?? ''}`.toUpperCase() : name.toUpperCase()}
        </h1>
        <span style={{ color: 'var(--text-2)' }}>
          {name} · {a.role} · {a.model}
          {a.persona ? '' : ' · ne s’est pas encore présenté'}
        </span>
        {a.worktree && <span className="mono muted" style={{ fontSize: 12.5 }}>worktree {a.worktree.replace(/\\/g, '/')}</span>}
      </div>
      <div className="row" style={{ gap: 10 }}>
        <span className="frame" style={{ padding: '10px 14px', boxShadow: 'none', background: 'var(--bg-2)' }}>
          <div className="muted" style={{ fontSize: 12 }}>
            Pièce
          </div>
          <div className="pix" style={{ fontSize: 14 }}>
            {ROOM_LABEL[a.room].toUpperCase()}
          </div>
        </span>
        <span className="frame" style={{ padding: '10px 14px', boxShadow: 'none', background: 'var(--bg-2)', maxWidth: 300 }}>
          <div className="muted" style={{ fontSize: 12 }}>
            Carte en cours
          </div>
          <div style={{ fontWeight: 600 }}>{a.currentCard ? `#${a.currentCard.id} ${a.currentCard.title}` : 'aucune'}</div>
          {a.currentCard && <div className="muted" style={{ fontSize: 12 }}>{a.currentCard.status === 'waiting' ? 'en attente · ' : ''}{COLUMN_LABEL[a.currentCard.col]}</div>}
        </span>
      </div>
    </section>
  );
}

function Activity({ state, name }: { state: OfficeState; name: string }) {
  const u = state.usage.agents.find((x) => x.name === name);
  const a = state.agents.find((x) => x.name === name)!;
  const transcript = useFetch<Entry[]>(`/api/agents/${name}/transcript?limit=60`, state.at, 6000);
  const detail = useFetch<{ roomEvents: RoomEvent[] }>(`/api/agents/${name}`, state.at);
  const used = Math.min(100, u?.usedOfSharePct ?? 0);
  return (
    <>
      <section className="grid-tiles" aria-label="Consommation">
        <div className="frame tile">
          <span className="muted" style={{ fontSize: 12 }}>
            Sa part du budget
          </span>
          <span className="big">
            {pct(u?.usedOfSharePct ?? 0)}
            <span className="muted" style={{ fontSize: 14, fontWeight: 400 }}>
              {' '}
              utilisés
            </span>
          </span>
          <span className="bar">
            <span style={{ width: `${used}%`, background: colorFor(name) }} />
            <span className="pause" style={{ width: `${used * ((u?.pausePct ?? 0) / 100)}%` }} />
          </span>
          <span className="muted" style={{ fontSize: 12 }}>
            Part : {String(a.share).replace('.', ',')} % du budget équipe = {pct(u?.limitPct)} du quota{a.share !== a.configShare ? ` (rétro : ${a.configShare} → ${a.share})` : ''}
          </span>
        </div>
        <div className="frame tile">
          <span className="muted" style={{ fontSize: 12 }}>
            Tokens de la fenêtre
          </span>
          <span className="big">{fmtTokens(u?.tokens ?? 0)}</span>
          <span className="muted" style={{ fontSize: 12 }}>
            {pct(u?.pctOfQuota)} du quota du forfait
          </span>
        </div>
        <div className="frame tile">
          <span className="muted" style={{ fontSize: 12 }}>
            Dont pause
          </span>
          <span className="big" style={{ color: 'var(--yellow)' }}>
            {pct(u?.pausePct ?? 0)}
          </span>
          <span className="muted" style={{ fontSize: 12 }}>
            {fmtTokens(u?.pauseTokens ?? 0)} tokens{a.lastBreakPostAt ? ` · dernier message ${ago(a.lastBreakPostAt)}` : ''}
          </span>
        </div>
        <div className="frame tile">
          <span className="muted" style={{ fontSize: 12 }}>
            Avant la salle de repos
          </span>
          <span className="big">{u ? pct(Math.max(0, u.stopAtPct - u.pctOfQuota)) : '–'}</span>
          <span className="muted" style={{ fontSize: 12 }}>
            du quota · arrêt à {pct(u?.stopAtPct)}
            {state.usage.resetsAt ? ` · reset à ${clock(state.usage.resetsAt)}` : ''}
          </span>
        </div>
      </section>
      <div className="row">
        <section className="frame pad stack" style={{ flex: '999 1 560px', minWidth: 0 }} aria-labelledby="tr-h">
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <h2 id="tr-h" className="section-title">
              Transcript récent
            </h2>
            <span className="muted" style={{ fontSize: 12 }}>
              <span className="live-dot live" /> en direct
            </span>
          </div>
          {!transcript ? (
            <p className="muted">Chargement…</p>
          ) : transcript.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              Rien encore : le transcript apparaît dès que l’agent travaille dans le dépôt de l’équipe.
            </p>
          ) : (
            <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2, fontFamily: 'var(--mono)', fontSize: 12, maxHeight: 560, overflowY: 'auto' }}>
              <AnimatePresence initial={false}>
                {[...transcript].reverse().map((e, i) => {
                  const k = KIND[e.kind];
                  return (
                    <motion.li key={`${e.at}-${i}-${e.text.slice(0, 12)}`} layout initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} style={{ display: 'flex', gap: 10, padding: '6px 8px', background: e.isError ? '#221719' : k.bg, borderRadius: 2 }}>
                      <span className="muted" style={{ flex: '0 0 40px' }}>
                        {e.at ? clock(e.at) : ''}
                      </span>
                      <span style={{ flex: '0 0 104px', color: e.isError ? 'var(--rose)' : k.color, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{k.label(e)}</span>
                      <span style={{ color: e.kind === 'result' ? 'var(--muted)' : 'var(--text-2)', minWidth: 0, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap', fontFamily: e.kind === 'text' || e.kind === 'prompt' ? 'var(--sans)' : undefined, fontSize: e.kind === 'text' ? 13 : undefined }}>{e.text}</span>
                    </motion.li>
                  );
                })}
              </AnimatePresence>
            </ol>
          )}
        </section>
        <section className="frame pad stack" style={{ flex: '1 1 280px', minWidth: 0 }} aria-labelledby="rooms-h">
          <h2 id="rooms-h" className="section-title">
            Ses déplacements
          </h2>
          <ul className="feed">
            {(detail?.roomEvents ?? []).slice(0, 14).map((r) => (
              <li key={r.id}>
                <time>{clock(r.at)}</time>
                <span className="chip" style={{ background: { desk: 'var(--blue)', meeting: 'var(--violet)', break: 'var(--yellow)', rest: 'var(--green)' }[r.to_room] }}>
                  {ROOM_LABEL[r.to_room]}
                </span>
                <span className="muted" style={{ fontSize: 12.5 }}>
                  {r.reason ?? (r.source === 'hook' ? 'déduit de son activité' : '')}
                </span>
              </li>
            ))}
            {detail && detail.roomEvents.length === 0 && <li className="muted">Pas encore bougé.</li>}
          </ul>
        </section>
      </div>
    </>
  );
}

function OpinionCard({ o, showAuthor }: { o: Opinion; showAuthor: boolean }) {
  const [open, setOpen] = useState(false);
  const history = useFetch<Opinion[]>(open ? `/api/opinions/history?author=${o.author}&about=${o.about}` : null, o.id);
  const who = showAuthor ? o.author : o.about;
  return (
    <motion.article layout className="frame" style={{ padding: '12px 14px', boxShadow: 'none', background: 'var(--panel-2)', borderTop: `3px solid ${who === 'creator' ? 'var(--text)' : colorFor(who)}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12, marginBottom: 6 }}>
        <strong style={{ color: who === 'creator' ? 'var(--text)' : colorFor(who), fontSize: 13 }}>{showAuthor ? o.authorName : `Sur ${o.aboutName}`}</strong>
        <span className="muted">{ago(o.at)}</span>
      </div>
      <p style={{ margin: 0, lineHeight: 1.5 }}>« {o.body} »</p>
      <button className="btn btn-ghost btn-sm" style={{ marginTop: 6, paddingLeft: 0 }} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? 'Masquer l’évolution' : 'Voir l’évolution'}
      </button>
      <AnimatePresence>
        {open && history && (
          <motion.ol initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} style={{ listStyle: 'none', margin: 0, padding: '0 0 0 12px', borderLeft: '2px solid var(--line)', overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {history.map((h) => (
              <li key={h.id} style={{ fontSize: 12.5, color: 'var(--text-2)' }}>
                <span className="mono muted">{ago(h.at)}</span> — {h.body}
              </li>
            ))}
            {history.length <= 1 && <li className="muted" style={{ fontSize: 12 }}>Jamais modifié.</li>}
          </motion.ol>
        )}
      </AnimatePresence>
    </motion.article>
  );
}

function Profile({ state, name }: { state: OfficeState; name: string }) {
  const a = state.agents.find((x) => x.name === name)!;
  const m = state.social.members.find((x) => x.name === name);
  const fb = useFetch<{ id: number; title: string; items: { author: string; clarity: number; comment: string; at: number }[] }[]>('/api/feedback', state.at);
  const ratings = (fb ?? []).flatMap((c) => c.items.filter((i) => i.author === name).map((i) => ({ ...i, id: c.id, title: c.title })));
  return (
    <div className="row" style={{ gap: 20 }}>
      <div className="stack" style={{ flex: '1 1 320px', minWidth: 0, gap: 16 }}>
        <section className="frame pad stack">
          <h2 className="section-title">Persona</h2>
          {a.persona ? (
            <div className="row" style={{ gap: 10 }}>
              <div className="frame" style={{ padding: '10px 14px', boxShadow: 'none', background: 'var(--bg-2)' }}>
                <div className="muted" style={{ fontSize: 12 }}>Film préféré</div>
                <div style={{ fontWeight: 600 }}>{a.persona.favoriteMovie}</div>
              </div>
              <div className="frame" style={{ padding: '10px 14px', boxShadow: 'none', background: 'var(--bg-2)' }}>
                <div className="muted" style={{ fontSize: 12 }}>Musique préférée</div>
                <div style={{ fontWeight: 600 }}>{a.persona.favoriteMusic}</div>
              </div>
            </div>
          ) : (
            <p className="muted" style={{ margin: 0 }}>Pas encore présenté.</p>
          )}
        </section>
        <section className="frame pad stack">
          <h2 className="section-title" style={{ color: 'var(--green)' }}>Hobbies</h2>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <AnimatePresence>
              {a.hobbies.map((h) => (
                <motion.span key={h} className="trait hobby" layout initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.6, opacity: 0 }}>
                  {h}
                </motion.span>
              ))}
            </AnimatePresence>
            {a.hobbies.length === 0 && <span className="muted">Aucun pour l’instant.</span>}
          </div>
          <h2 className="section-title" style={{ color: 'var(--rose)', marginTop: 8 }}>N’aime pas</h2>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {a.dislikes.map((h) => (
              <motion.span key={h} className="trait dislike" layout initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}>
                {h}
              </motion.span>
            ))}
            {a.dislikes.length === 0 && <span className="muted">Rien pour l’instant.</span>}
          </div>
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>Ajoutés et retirés par l’agent lui-même, pendant les conversations en salle de pause.</p>
        </section>
        <section className="frame pad stack">
          <h2 className="section-title">Ses notes de clarté</h2>
          {ratings.map((r) => (
            <div key={r.id} style={{ display: 'flex', gap: 10, fontSize: 13 }}>
              <span className="mono muted">#{r.id}</span>
              <strong style={{ color: clarityColor(r.clarity) }}>{r.clarity}/5</strong>
              <span style={{ color: 'var(--text-2)' }}>{r.comment}</span>
            </div>
          ))}
          {ratings.length === 0 && <span className="muted">Aucune note donnée.</span>}
        </section>
      </div>
      <div className="stack" style={{ flex: '2 1 520px', minWidth: 0, gap: 16 }}>
        <section className="frame pad stack">
          <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <h2 className="section-title">Ses avis</h2>
            <span className="muted" style={{ fontSize: 12 }}>Privés : seuls l’auteur et toi les voyez</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10 }}>
            {(m?.opinionsGiven ?? []).map((o) => (
              <OpinionCard key={o.id} o={o} showAuthor={false} />
            ))}
          </div>
          {(m?.opinionsGiven ?? []).length === 0 && <span className="muted">Pas encore d’avis.</span>}
        </section>
        <section className="frame pad stack">
          <h2 className="section-title">Ce que l’équipe pense de {a.persona?.firstName ?? name}</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10 }}>
            {(m?.opinionsReceived ?? []).map((o) => (
              <OpinionCard key={o.id} o={o} showAuthor />
            ))}
          </div>
          {(m?.opinionsReceived ?? []).length === 0 && <span className="muted">Personne n’a encore donné son avis.</span>}
        </section>
      </div>
    </div>
  );
}

export function AgentView({ state, name, tab }: { state: OfficeState; name: string; tab: 'activite' | 'profil' }) {
  if (!state.agents.some((a) => a.name === name)) return <p className="empty">Agent inconnu : {name}</p>;
  return (
    <div className="stack" style={{ gap: 18, maxWidth: 1320, margin: '0 auto' }}>
      <a href={href.office} className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start', paddingLeft: 0 }}>
        <Icon name="back" /> Retour au bureau
      </a>
      <Identity state={state} name={name} />
      <nav className="subtabs" aria-label="Onglets de l’agent">
        {(['activite', 'profil'] as const).map((t) => (
          <a key={t} href={href.agent(name, t)} className="subtab" aria-current={tab === t ? 'page' : undefined}>
            {t === 'activite' ? 'Activité' : 'Profil et avis'}
            {tab === t && <motion.span layoutId="subtab-line" className="subtab-line" style={{ background: colorFor(name) }} />}
          </a>
        ))}
        <span style={{ flex: 1 }} />
        {state.agents
          .filter((x) => x.name !== name)
          .map((x) => (
            <a key={x.name} href={href.agent(x.name, tab)} title={displayName(state, x.name)} style={{ alignSelf: 'center', padding: '0 3px' }}>
              <Sprite name={x.name} scale={1.4} />
            </a>
          ))}
      </nav>
      <AnimatePresence mode="wait">
        <motion.div key={tab + name} className="stack" style={{ gap: 18 }} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.22 }}>
          {tab === 'activite' ? <Activity state={state} name={name} /> : <Profile state={state} name={name} />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
