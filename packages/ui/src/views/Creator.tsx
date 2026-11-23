import { AnimatePresence, motion } from 'motion/react';
import { useMemo, useState } from 'react';
import { ago, type OfficeState, type Opinion, useFetch } from '../api';
import { colorFor, Sprite } from '../components/Sprite';
import { clarityColor, Dots } from '../components/ui';
import { href } from '../router';

interface Feedback {
  id: number;
  title: string;
  createdBy: string;
  count: number;
  avgClarity: number | null;
  items: { id: number; author: string; authorName: string; clarity: number; comment: string; at: number }[];
}

function CreatorSprite() {
  return (
    <svg width="78" height="78" viewBox="0 0 12 12" shapeRendering="crispEdges" aria-hidden="true" style={{ animation: 'bob 3s ease-in-out infinite' }}>
      <rect x="3" y="0" width="6" height="1" fill="#f2b45a" />
      <rect x="2" y="1" width="8" height="1" fill="#f2b45a" />
      <rect x="4" y="0" width="1" height="1" fill="#ffd28f" />
      <rect x="3" y="2" width="6" height="4" fill="#f1c27d" />
      <rect x="4" y="3" width="1" height="1" fill="#1a1a1a" />
      <rect x="7" y="3" width="1" height="1" fill="#1a1a1a" />
      <rect x="2" y="6" width="8" height="4" fill="#f4f1ea" />
      <rect x="5" y="6" width="2" height="4" fill="#f2b45a" />
      <rect x="3" y="10" width="2" height="2" fill="#3a3f4b" />
      <rect x="7" y="10" width="2" height="2" fill="#3a3f4b" />
    </svg>
  );
}

function History({ o }: { o: Opinion }) {
  const h = useFetch<Opinion[]>(`/api/opinions/history?author=${o.author}&about=creator`, o.id);
  const before = (h ?? []).filter((x) => x.id !== o.id).slice(-1)[0];
  if (!before) return null;
  return (
    <p className="muted" style={{ margin: 0, fontSize: 12.5, lineHeight: 1.45 }}>
      Avant ({ago(before.at)}) : « {before.body} »
    </p>
  );
}

const plural = (n: number, w: string) => `${n} ${w}${n > 1 ? 's' : ''}`;

export function CreatorView({ state }: { state: OfficeState }) {
  const feedback = useFetch<Feedback[]>('/api/feedback', state.at) ?? [];
  const all = feedback.flatMap((f) => f.items);
  const avg = all.length ? Math.round((all.reduce((s, i) => s + i.clarity, 0) / all.length) * 10) / 10 : null;
  const mine = feedback.filter((f) => f.createdBy === 'user');
  const opinions = state.social.aboutCreator;
  const last = opinions.reduce((m, o) => Math.max(m, o.at), 0);
  return (
    <div className="stack" style={{ gap: 24, maxWidth: 1320, margin: '0 auto' }}>
      <section style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 22 }}>
        <motion.div initial={{ y: -20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ type: 'spring', stiffness: 260, damping: 14 }}>
          <CreatorSprite />
        </motion.div>
        <div className="stack" style={{ flex: '1 1 340px', gap: 6 }}>
          <h1 style={{ margin: 0, fontFamily: 'var(--display)', fontSize: 30, color: 'var(--gold-2)' }}>Le créateur, vu par l’équipe</h1>
          <p style={{ margin: 0, color: 'var(--text-2)', maxWidth: 640 }}>Ce que l’équipe pense de toi, de tes demandes, et ce que ses membres pensent les uns des autres. Les agents écrivent ces avis eux-mêmes, en salle de pause ; tu es le seul à tous les voir.</p>
        </div>
        <div className="row" style={{ gap: 10 }}>
          <div className="frame tile">
            <span className="muted" style={{ fontSize: 12 }}>
              Clarté moyenne des cartes
            </span>
            <span className="big" style={{ color: clarityColor(avg) }}>
              {avg === null ? '–' : String(avg).replace('.', ',')}
              <span className="muted" style={{ fontSize: 14 }}>
                {' '}
                / 5
              </span>
            </span>
            <span className="muted" style={{ fontSize: 12 }}>
              {plural(all.length, 'note')} sur {plural(feedback.length, 'carte')} ({mine.length} de toi)
            </span>
          </div>
          <div className="frame tile">
            <span className="muted" style={{ fontSize: 12 }}>
              Avis sur toi
            </span>
            <span className="big">
              {opinions.length}
              <span className="muted" style={{ fontSize: 14 }}>
                {' '}
                / {state.agents.length} agents
              </span>
            </span>
            <span className="muted" style={{ fontSize: 12 }}>{last ? `dernier ${ago(last)}` : 'aucun pour l’instant'}</span>
          </div>
        </div>
      </section>

      <section className="stack" aria-labelledby="ops-h">
        <h2 id="ops-h" className="section-title">
          Ce qu’ils pensent de toi
        </h2>
        {opinions.length === 0 ? (
          <div className="frame empty">Pas encore d’avis : ils se forment en salle de pause, au fil des conversations.</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
            {opinions.map((o, i) => {
              const a = state.agents.find((x) => x.name === o.author);
              return (
                <motion.article key={o.id} className="frame" style={{ padding: '16px 18px', borderTop: `4px solid ${colorFor(o.author)}`, display: 'flex', flexDirection: 'column', gap: 10 }} initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.07 }}>
                  <a href={href.agent(o.author, 'profil')} style={{ display: 'flex', gap: 10, alignItems: 'center', textDecoration: 'none', color: 'var(--text)' }}>
                    <Sprite name={o.author} scale={2} />
                    <span className="stack" style={{ gap: 0 }}>
                      <strong>{o.authorName}</strong>
                      <span className="muted" style={{ fontSize: 12 }}>
                        {a?.role} · {ago(o.at)}
                      </span>
                    </span>
                  </a>
                  <p style={{ margin: 0, fontSize: 15, lineHeight: 1.55 }}>« {o.body} »</p>
                  <History o={o} />
                </motion.article>
              );
            })}
          </div>
        )}
      </section>

      <TeamOpinions state={state} />

      <section className="frame pad stack" aria-labelledby="clar-h">
        <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <h2 id="clar-h" className="section-title">
            Clarté des demandes · les moins claires d’abord
          </h2>
          <a href={href.kanban} style={{ fontSize: 13 }}>
            Voir le kanban
          </a>
        </div>
        {feedback.length === 0 && <p className="muted" style={{ margin: 0 }}>Aucune carte notée pour l’instant (rate_card).</p>}
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {feedback.map((c, i) => {
            const latest = [...c.items].sort((a, b) => b.at - a.at)[0];
            return (
              <motion.li key={c.id} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.04 }} style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 16px', alignItems: 'baseline', padding: '10px 0', borderTop: '1px solid var(--line)' }}>
                <span style={{ flex: '0 0 230px', display: 'flex', gap: 8, minWidth: 0 }}>
                  <span className="mono muted" style={{ fontSize: 12 }}>
                    #{c.id}
                  </span>
                  <strong>{c.title}</strong>
                </span>
                <span style={{ flex: '0 0 160px', display: 'flex', gap: 6, alignItems: 'center' }}>
                  <Dots value={c.avgClarity} color={clarityColor(c.avgClarity)} />
                  <strong style={{ color: clarityColor(c.avgClarity) }}>{String(c.avgClarity).replace('.', ',')}/5</strong>
                  <span className="muted" style={{ fontSize: 12 }}>
                    ({c.count})
                  </span>
                </span>
                {latest && (
                  <span style={{ flex: '1 1 320px', minWidth: 0, fontSize: 13, color: 'var(--text-2)' }}>
                    <strong style={{ color: colorFor(latest.author) }}>{latest.authorName}</strong> : « {latest.comment} »
                  </span>
                )}
              </motion.li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

/** What team members think of each other, grouped by the person they talk about. */
function TeamOpinions({ state }: { state: OfficeState }) {
  const [focus, setFocus] = useState<string | null>(null);
  const all = useMemo(
    () => state.social.members.flatMap((m) => m.opinionsGiven).filter((o) => o.about !== 'creator' && o.about !== o.author).sort((a, b) => b.at - a.at),
    [state.social.members]
  );
  const shown = focus ? all.filter((o) => o.about === focus || o.author === focus) : all;
  const subjects = state.agents.map((a) => a.name).filter((n) => shown.some((o) => o.about === n));
  const name = (n: string) => state.agents.find((a) => a.name === n)?.persona?.firstName ?? n;
  return (
    <section className="stack" aria-labelledby="team-ops-h">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 10 }}>
        <h2 id="team-ops-h" className="section-title">
          Ce qu’ils pensent les uns des autres
        </h2>
        <span className="muted" style={{ fontSize: 13 }}>
          {plural(all.length, 'avis')} entre membres
        </span>
      </div>
      <div className="op-filter" role="group" aria-label="Filtrer par membre">
        <button className={`op-chip ${focus === null ? 'on' : ''}`} onClick={() => setFocus(null)} aria-pressed={focus === null}>
          Toute l’équipe
        </button>
        {state.agents.map((a) => (
          <button key={a.name} className={`op-chip ${focus === a.name ? 'on' : ''}`} onClick={() => setFocus(focus === a.name ? null : a.name)} aria-pressed={focus === a.name} style={{ ['--c' as string]: colorFor(a.name) }}>
            <Sprite name={a.name} scale={1.2} />
            {name(a.name)}
          </button>
        ))}
      </div>
      {focus && <p className="muted" style={{ margin: 0, fontSize: 13 }}>Avis donnés par {name(focus)} et avis reçus par {name(focus)}.</p>}
      {all.length === 0 ? (
        <div className="frame empty">Pas encore d’avis entre eux : ils se forment en salle de pause, au fil des conversations.</div>
      ) : (
        <div className="op-grid">
          <AnimatePresence initial={false}>
            {subjects.map((about) => {
              const items = shown.filter((o) => o.about === about);
              return (
                <motion.article key={about} layout className="frame op-card" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.97 }} style={{ borderTop: `4px solid ${colorFor(about)}` }}>
                  <a href={href.agent(about, 'profil')} className="op-head">
                    <Sprite name={about} scale={2} />
                    <span className="stack" style={{ gap: 0 }}>
                      <span className="muted" style={{ fontSize: 12 }}>
                        Ce qu’on pense de
                      </span>
                      <strong>{name(about)}</strong>
                    </span>
                  </a>
                  <ul>
                    {items.map((o) => (
                      <li key={o.id}>
                        <span className="op-author" style={{ color: colorFor(o.author) }}>
                          {o.authorName}
                        </span>
                        <span className="muted" style={{ fontSize: 12 }}>
                          {' '}
                          · {ago(o.at)}
                        </span>
                        <p>« {o.body} »</p>
                      </li>
                    ))}
                  </ul>
                </motion.article>
              );
            })}
          </AnimatePresence>
        </div>
      )}
    </section>
  );
}
