import { AnimatePresence, LayoutGroup, motion } from 'motion/react';
import { forwardRef, useEffect, useState } from 'react';
import { ago, api, type Card, clock, type Column, COLUMN_LABEL, displayName, type LiveEvent, type OfficeState, useFetch } from '../api';
import { colorFor, Sprite } from '../components/Sprite';
import { clarityColor, Dots, Drawer, Icon } from '../components/ui';

const COL_STYLE: Partial<Record<Column, { color: string; rule?: string; bg?: string; border?: string }>> = {
  BACKLOG: { color: 'var(--text)' },
  TODO: { color: 'var(--text)' },
  TO_DESIGN: { color: 'var(--violet)' },
  IN_PROGRESS: { color: 'var(--blue)' },
  IN_REVIEW: { color: 'var(--yellow)', rule: 'Sortie : un commentaire de review est obligatoire' },
  IN_TEST: { color: 'var(--green)', rule: 'Entrée : reviewer uniquement' },
  DONE: { color: 'var(--green)', rule: 'Entrée : testeur uniquement' },
  BLOCKED: { color: 'var(--rose)', bg: '#211618', border: '#4a2a2e', rule: 'Retour vers la colonne d’origine uniquement' }
};

/** GET /api/cards/:id returns the raw row (snake_case) plus its comments, events and feedback. */
interface CardDetail {
  id: number;
  title: string;
  description: string;
  col: Column;
  assignee: string | null;
  created_by: string;
  created_at: number;
  comments: { id: number; at: number; author: string; kind: 'note' | 'review'; body: string }[];
  events: { id: number; at: number; actor: string; kind: string; from_col: Column | null; to_col: Column | null; detail: string | null }[];
  feedback: { count: number; avgClarity: number | null; items: { id: number; author: string; authorName: string; clarity: number; comment: string; at: number }[] };
}

const KCard = forwardRef<HTMLButtonElement, { card: Card; state: OfficeState; highlight: 'flash' | 'refused' | null; onOpen: () => void }>(function KCard({ card, state, highlight, onOpen }, ref) {
  const fb = card.feedback;
  return (
    <motion.button
      ref={ref}
      layout
      layoutId={`card-${card.id}`}
      className={`kcard ${highlight ?? ''}`}
      onClick={onOpen}
      initial={{ opacity: 0, y: -10, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9 }}
      transition={{ layout: { type: 'spring', stiffness: 260, damping: 30 }, default: { duration: 0.25 } }}
      whileHover={{ y: -2 }}
    >
      <span style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }} className="muted">
        <span className="mono">#{card.id}</span>
        <span>{ago(card.enteredColumnAt)}</span>
      </span>
      <h3>{card.title}</h3>
      {fb.count > 0 && (
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: clarityColor(fb.avgClarity), background: 'var(--bg-2)', padding: '4px 6px', borderRadius: 2 }}>
          <Dots value={fb.avgClarity} color={clarityColor(fb.avgClarity)} />
          Clarté {String(fb.avgClarity).replace('.', ',')}/5 · {fb.count} avis
        </span>
      )}
      {card.blockedFrom && <span style={{ fontSize: 12, color: 'var(--rose)' }}>Bloquée depuis {COLUMN_LABEL[card.blockedFrom]}</span>}
      <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-2)' }}>
          {card.assignee ? (
            <>
              <Sprite name={card.assignee} scale={1.2} />
              {displayName(state, card.assignee)}
            </>
          ) : (
            <span className="muted">Non assignée</span>
          )}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }} className="muted">
          <Icon name="chat" size={12} />
          {card.commentCount}
        </span>
      </span>
    </motion.button>
  );
});

function ReplyForm({ cardId, blocked }: { cardId: number; blocked: boolean }) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  useEffect(() => {
    setBody('');
    setSent(false);
    setError(null);
  }, [cardId]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('POST', `/api/cards/${cardId}/comments`, { body });
      setBody('');
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="stack reply-form" onSubmit={submit} style={{ gap: 8 }}>
      <label htmlFor={`reply-${cardId}`} className="section-title" style={{ margin: 0 }}>
        {blocked ? 'Répondre aux questions' : 'Ajouter un commentaire'}
      </label>
      {blocked && <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>La carte attend ta réponse. Le lead est prévenu dès que tu envoies, et le designer relit la carte.</p>}
      <textarea id={`reply-${cardId}`} rows={blocked ? 5 : 3} value={body} onChange={(e) => { setBody(e.target.value); setSent(false); }} placeholder={blocked ? '1. …\n2. …' : 'Une précision pour l’équipe…'} />
      {error && <p style={{ margin: 0, color: 'var(--rose)', fontSize: 13 }}>{error}</p>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 10 }}>
        {sent && <span style={{ color: 'var(--green)', fontSize: 13 }}>Envoyé.</span>}
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !body.trim()}>
          Envoyer
        </button>
      </div>
    </form>
  );
}

function CardDrawer({ id, state, onClose }: { id: number | null; state: OfficeState; onClose: () => void }) {
  const card = useFetch<CardDetail>(id ? `/api/cards/${id}` : null, state.at);
  return (
    <Drawer open={id !== null} onClose={onClose} label={card ? `Carte #${card.id}` : 'Carte'}>
      {!card ? (
        <p className="muted">Chargement…</p>
      ) : (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' }}>
            <div className="stack" style={{ gap: 4 }}>
              <span className="mono muted">#{card.id} · créée par {displayName(state, card.created_by)} · {ago(card.created_at)}</span>
              <h2 style={{ margin: 0, fontSize: 20 }}>{card.title}</h2>
              <span>
                <span className="chip" style={{ background: COL_STYLE[card.col]?.color ?? 'var(--text)' }}>
                  {COLUMN_LABEL[card.col]}
                </span>{' '}
                {card.assignee && <span className="muted">· {displayName(state, card.assignee)}</span>}
              </span>
            </div>
            <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Fermer">
              <Icon name="x" />
            </button>
          </div>
          {card.description && <p style={{ margin: 0, whiteSpace: 'pre-wrap', color: 'var(--text-2)' }}>{card.description}</p>}

          {card.feedback.count > 0 && (
            <section className="frame pad stack" style={{ boxShadow: 'none' }}>
              <h3 className="section-title">Clarté de la demande · {String(card.feedback.avgClarity).replace('.', ',')}/5</h3>
              {card.feedback.items.map((f) => (
                <div key={f.id} style={{ display: 'flex', gap: 10, fontSize: 13 }}>
                  <strong style={{ color: clarityColor(f.clarity), flex: '0 0 32px' }}>{f.clarity}/5</strong>
                  <span>
                    <strong style={{ color: colorFor(f.author) }}>{f.authorName}</strong> · {f.comment}
                  </span>
                </div>
              ))}
            </section>
          )}

          <section className="stack">
            <h3 className="section-title">Commentaires</h3>
            {card.comments.length === 0 && <p className="muted" style={{ margin: 0 }}>Aucun.</p>}
            {card.comments.map((c) => (
              <div key={c.id} className="frame" style={{ padding: '10px 12px', boxShadow: 'none', borderColor: c.kind === 'review' ? '#5a4f2a' : undefined }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                  <span>
                    <strong style={{ color: c.author === 'user' ? 'var(--gold)' : colorFor(c.author) }}>{c.author === 'user' ? 'Le créateur' : displayName(state, c.author)}</strong>
                    {c.kind === 'review' && (
                      <span className="chip" style={{ background: 'var(--yellow)', marginLeft: 6 }}>
                        REVIEW
                      </span>
                    )}
                  </span>
                  <span className="muted">{ago(c.at)}</span>
                </div>
                <div style={{ whiteSpace: 'pre-wrap', fontSize: 13.5 }}>{c.body}</div>
              </div>
            ))}
          </section>

          <ReplyForm cardId={card.id} blocked={card.col === 'BLOCKED'} />

          <section className="stack">
            <h3 className="section-title">Historique</h3>
            <ol style={{ listStyle: 'none', margin: 0, padding: '0 0 0 14px', borderLeft: '2px solid var(--line)', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {card.events.map((e) => (
                <li key={e.id} style={{ fontSize: 13, position: 'relative' }}>
                  <span style={{ position: 'absolute', left: -20, top: 5, width: 10, height: 10, background: e.kind === 'move_refused' ? 'var(--rose)' : colorFor(e.actor) }} />
                  <span className="mono muted" style={{ fontSize: 11.5 }}>
                    {clock(e.at)}
                  </span>{' '}
                  <strong>{displayName(state, e.actor)}</strong>{' '}
                  {e.kind === 'created' && 'a créé la carte'}
                  {e.kind === 'moved' && (
                    <>
                      {COLUMN_LABEL[e.from_col!]} → {COLUMN_LABEL[e.to_col!]}
                    </>
                  )}
                  {e.kind === 'move_refused' && <span style={{ color: 'var(--rose)' }}>refusé vers {COLUMN_LABEL[e.to_col!]} : {e.detail}</span>}
                  {e.kind === 'assigned' && <>assigne à {displayName(state, e.detail ?? '')}</>}
                  {e.kind === 'commented' && <>commente{e.detail === 'review' ? ' (review)' : ''}</>}
                  {e.kind === 'moved' && e.detail && <div className="muted">{e.detail}</div>}
                </li>
              ))}
            </ol>
          </section>
        </>
      )}
    </Drawer>
  );
}

export function KanbanView({ state, onEvent, onNewCard }: { state: OfficeState; onEvent: (fn: (e: LiveEvent) => void) => () => void; onNewCard: (project: string) => void }) {
  const [open, setOpen] = useState<number | null>(null);
  const [project, setProject] = useState(state.activeProject);
  const viewingActive = project === state.activeProject;
  // Another project's board is fetched on demand; the active one comes live with the state.
  const otherBoard = useFetch<OfficeState['board']>(viewingActive ? null : `/api/board?project=${encodeURIComponent(project)}`, state.at);
  const board = viewingActive ? state.board : (otherBoard ?? []);
  const current = state.projects.find((p) => p.id === project);
  const [marks, setMarks] = useState<Record<number, 'flash' | 'refused'>>({});
  useEffect(
    () =>
      onEvent((e) => {
        if (e.type !== 'card_event') return;
        const id = e.data.card_id as number;
        const kind = e.data.kind === 'move_refused' ? 'refused' : e.data.kind === 'moved' || e.data.kind === 'created' ? 'flash' : null;
        if (!kind) return;
        setMarks((m) => ({ ...m, [id]: kind }));
        window.setTimeout(() => setMarks((m) => {
          const { [id]: _, ...rest } = m;
          return rest;
        }), 1700);
      }),
    [onEvent]
  );
  const moves = !viewingActive ? [] : state.recentCardEvents.filter((e) => e.kind === 'moved' || e.kind === 'move_refused').slice(0, 10);
  return (
    <div className="stack" style={{ gap: 20 }}>
      {state.projects.length > 1 && (
        <nav className="proj-tabs" aria-label="Projets">
          {state.projects.map((p) => (
            <button key={p.id} className={`proj-tab ${p.id === project ? 'on' : ''}`} aria-pressed={p.id === project} onClick={() => setProject(p.id)}>
              <span>{p.name}</span>
              {p.active ? <span className="chip" style={{ background: 'var(--green)' }}>ACTIF</span> : <span className="muted" style={{ fontSize: 11 }}>{p.cards} carte{p.cards > 1 ? 's' : ''}</span>}
            </button>
          ))}
        </nav>
      )}
      {!viewingActive && current && (
        <p className="proj-note">
          L’équipe ne travaille pas sur « {current.name} » en ce moment : ses cartes attendent qu’il redevienne le projet actif (Paramètres → Projets).
        </p>
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <p className="muted" style={{ margin: 0 }}>
          Lecture seule : seuls les agents déplacent les cartes, via le serveur MCP « office ». Tu peux ajouter des cartes au BACKLOG.
        </p>
        <button className="btn" onClick={() => onNewCard(project)}>
          <Icon name="plus" /> Ajouter une carte
        </button>
      </div>
      <div className="board-scroll">
        <LayoutGroup>
          <div className="board-cols">
            {board.map((col, ci) => {
              const s = COL_STYLE[col.column] ?? { color: 'var(--text)' };
              return (
                <motion.section key={col.column} className="frame col" style={{ background: s.bg, borderColor: s.border }} aria-label={col.label} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: ci * 0.04 }}>
                  <div className="col-head">
                    <h2 className="section-title" style={{ color: s.color }}>
                      {col.label}
                    </h2>
                    <motion.span key={col.cards.length} className="col-count" initial={{ scale: 1.4 }} animate={{ scale: 1 }}>
                      {col.cards.length}
                    </motion.span>
                  </div>
                  {s.rule && (
                    <p className="col-rule">
                      <Icon name="lock" size={12} /> {s.rule}
                    </p>
                  )}
                  <AnimatePresence mode="popLayout">
                    {col.cards.map((c) => (
                      <KCard key={c.id} card={c} state={state} highlight={marks[c.id] ?? null} onOpen={() => setOpen(c.id)} />
                    ))}
                  </AnimatePresence>
                  {col.cards.length === 0 && <div className="muted" style={{ fontSize: 12, textAlign: 'center', padding: 14, border: '2px dashed var(--line)', borderRadius: 3 }}>vide</div>}
                </motion.section>
              );
            })}
          </div>
        </LayoutGroup>
      </div>
      <section className="frame pad stack" style={{ maxWidth: 1000 }} aria-labelledby="moves-h">
        <h2 id="moves-h" className="section-title">
          Derniers mouvements
        </h2>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13, minWidth: 560 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--muted)', fontSize: 12 }}>
                <th style={{ padding: '6px 8px', fontWeight: 500 }}>Heure</th>
                <th style={{ padding: '6px 8px', fontWeight: 500 }}>Carte</th>
                <th style={{ padding: '6px 8px', fontWeight: 500 }}>Mouvement</th>
                <th style={{ padding: '6px 8px', fontWeight: 500 }}>Par</th>
                <th style={{ padding: '6px 8px', fontWeight: 500 }}>Résultat</th>
              </tr>
            </thead>
            <tbody>
              {moves.map((m) => (
                <tr key={m.id} style={{ borderTop: '1px solid var(--line)' }}>
                  <td className="mono muted" style={{ padding: '7px 8px', fontSize: 12 }}>
                    {clock(m.at)}
                  </td>
                  <td className="mono" style={{ padding: '7px 8px', fontSize: 12 }}>
                    #{m.card_id}
                  </td>
                  <td style={{ padding: '7px 8px' }}>
                    {COLUMN_LABEL[m.from_col!]} → {COLUMN_LABEL[m.to_col!]}
                  </td>
                  <td style={{ padding: '7px 8px', fontWeight: 600, color: colorFor(m.actor) }}>{displayName(state, m.actor)}</td>
                  <td style={{ padding: '7px 8px', color: m.kind === 'move_refused' ? 'var(--rose)' : 'var(--green)' }}>{m.kind === 'move_refused' ? `Refusé : ${(m.detail ?? '').slice(0, 80)}` : 'OK'}</td>
                </tr>
              ))}
              {moves.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted" style={{ padding: 10 }}>
                    Aucun mouvement pour l’instant.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
      <CardDrawer id={open} state={state} onClose={() => setOpen(null)} />
    </div>
  );
}
