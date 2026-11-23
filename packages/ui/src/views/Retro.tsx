import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { ago, api, clock, displayName, type OfficeState, type Proposal } from '../api';
import { colorFor, Sprite } from '../components/Sprite';
import { Icon } from '../components/ui';

const KIND_LABEL = { quota: 'Quotas', process: 'Process', other: 'Autre' } as const;
const KIND_COLOR = { quota: 'var(--amber)', process: 'var(--teal)', other: 'var(--violet)' } as const;

function ProposalCard({ p, state, majority, total, canRevert }: { p: Proposal; state: OfficeState; majority?: number; total?: number; canRevert: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const forN = p.votesFor.length;
  const againstN = p.votesAgainst.length;
  const denom = Math.max(total ?? forN + againstN, 1);
  const revert = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api('POST', `/api/retro/proposals/${p.id}/revert`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const status = p.revertedAt ? { t: 'ANNULÉE', c: 'var(--muted)' } : p.status === 'adopted' ? { t: 'ADOPTÉE', c: 'var(--green)' } : p.status === 'rejected' ? { t: 'REJETÉE', c: 'var(--rose)' } : { t: 'AU VOTE', c: 'var(--yellow)' };
  return (
    <motion.article layout className="frame" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10, borderLeft: `5px solid ${KIND_COLOR[p.kind]}` }} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span className="chip" style={{ background: KIND_COLOR[p.kind] }}>
            {KIND_LABEL[p.kind].toUpperCase()}
          </span>
          <strong>{p.title}</strong>
        </span>
        <span className="chip" style={{ background: status.c }}>
          {status.t}
        </span>
      </div>
      <p style={{ margin: 0, color: 'var(--text-2)', whiteSpace: 'pre-wrap' }}>{p.details}</p>
      {p.shares && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 6 }}>
          {Object.entries(p.shares).map(([name, v]) => {
            const cur = state.agents.find((a) => a.name === name)?.configShare ?? 0;
            const d = Math.round((v - cur) * 10) / 10;
            return (
              <span key={name} className="frame" style={{ padding: '6px 8px', boxShadow: 'none', background: 'var(--bg-2)', fontSize: 12 }}>
                <span style={{ color: colorFor(name), fontWeight: 600 }}>{displayName(state, name)}</span> {String(v).replace('.', ',')} %{' '}
                {d !== 0 && <span style={{ color: d > 0 ? 'var(--green)' : 'var(--rose)' }}>({d > 0 ? '+' : ''}{String(d).replace('.', ',')})</span>}
              </span>
            );
          })}
        </div>
      )}
      <div className="stack" style={{ gap: 4 }}>
        <div className="vote-bar" aria-label={`${forN} pour, ${againstN} contre`}>
          <motion.span style={{ background: 'var(--green)' }} initial={{ width: 0 }} animate={{ width: `${(forN / denom) * 100}%` }} transition={{ type: 'spring', stiffness: 120, damping: 20 }} />
          <motion.span style={{ background: 'var(--rose)' }} initial={{ width: 0 }} animate={{ width: `${(againstN / denom) * 100}%` }} transition={{ type: 'spring', stiffness: 120, damping: 20 }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }} className="muted">
          <span>
            {forN} pour · {againstN} contre{majority ? ` · majorité à ${majority}` : ''} · proposé par {p.authorName}
          </span>
          <span style={{ display: 'flex', gap: 2 }}>
            {p.votesFor.map((n) => (
              <span key={n} title={`${displayName(state, n)} : pour`}>
                <Sprite name={n} scale={1.1} />
              </span>
            ))}
          </span>
        </div>
      </div>
      {canRevert && p.status === 'adopted' && p.appliedAt && !p.revertedAt && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn btn-sm btn-danger" onClick={revert} disabled={busy}>
            <Icon name="undo" size={14} /> Annuler cette décision
          </button>
          {err && <span style={{ color: 'var(--rose)', fontSize: 12 }}>{err}</span>}
        </div>
      )}
    </motion.article>
  );
}

function StartForm() {
  const [topic, setTopic] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api('POST', '/api/retro/start', { topic: topic.trim() || undefined });
      setTopic('');
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={start} className="frame pad stack" style={{ borderColor: '#4a3f66', background: 'linear-gradient(180deg, #211b30, var(--panel))' }}>
      <h2 className="section-title" style={{ color: 'var(--violet)' }}>
        Lancer une rétrospective
      </h2>
      <p style={{ margin: 0, color: 'var(--text-2)' }}>
        Toute l’équipe passe en salle de meeting, le travail et la pause sont suspendus. Les agents discutent, proposent des changements (quotas, process, n’importe quoi) et votent ; le lead clôt. Les décisions adoptées s’appliquent tout de suite, et tu peux les annuler ici. Le plafond de 90 % ne se vote pas.
      </p>
      <div>
        <label htmlFor="retro-topic">Sujet (facultatif)</label>
        <input id="retro-topic" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Ex. : les cartes restent trop longtemps en review" maxLength={200} />
      </div>
      {err && <p style={{ margin: 0, color: 'var(--rose)' }}>{err}</p>}
      <button className="btn btn-primary" style={{ alignSelf: 'flex-start', background: 'var(--violet)', borderColor: '#9c7fd1' }} disabled={busy}>
        <Icon name="users" /> Réunir l’équipe
      </button>
    </form>
  );
}

function Current({ state }: { state: OfficeState }) {
  const r = state.retro.current!;
  const [busy, setBusy] = useState(false);
  const close = async () => {
    setBusy(true);
    try {
      await api('POST', '/api/retro/close', { summary: 'Clôturée par Le créateur depuis l’UI' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack" style={{ gap: 16 }}>
      <motion.section className="frame pad" style={{ borderColor: '#4a3f66', background: 'linear-gradient(180deg, #241d35, var(--panel))', display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center' }} initial={{ scale: 0.98, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}>
        <div className="stack" style={{ gap: 4, flex: '1 1 360px' }}>
          <span className="chip" style={{ background: 'var(--violet)', alignSelf: 'flex-start' }}>
            RÉTROSPECTIVE EN COURS
          </span>
          <h1 style={{ margin: 0, fontSize: 22 }}>{r.topic ?? 'Comment améliorer l’équipe ?'}</h1>
          <span className="muted">
            Ouverte {ago(r.startedAt)} · {r.participants.length} participants · majorité à {r.majority}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {r.participants.map((p, i) => (
            <motion.span key={p} initial={{ y: -14, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ delay: i * 0.08, type: 'spring', stiffness: 300, damping: 14 }} title={displayName(state, p)}>
              <Sprite name={p} scale={2.4} state={r.messages.some((m) => m.agent === p && Date.now() - m.at < 60_000) ? 'talking' : 'idle'} />
            </motion.span>
          ))}
        </div>
        <button className="btn" onClick={close} disabled={busy}>
          Clore maintenant
        </button>
      </motion.section>
      <div className="row" style={{ gap: 16 }}>
        <section className="frame pad stack" style={{ flex: '1 1 420px', minWidth: 0 }} aria-labelledby="rm-h">
          <h2 id="rm-h" className="section-title">
            Discussion
          </h2>
          {r.messages.length === 0 && <p className="muted" style={{ margin: 0 }}>Les agents arrivent en salle de meeting…</p>}
          <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <AnimatePresence initial={false}>
              {r.messages.map((m) => (
                <motion.li key={m.id} className="msg" layout initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
                  <Sprite name={m.agent} scale={1.6} />
                  <span className="stack" style={{ gap: 2, minWidth: 0 }}>
                    <span>
                      <span className="who" style={{ color: colorFor(m.agent) }}>
                        {m.author}
                      </span>{' '}
                      <time className="mono muted" style={{ fontSize: 11 }}>
                        {clock(m.at)}
                      </time>
                    </span>
                    <span style={{ color: 'var(--text-2)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{m.body}</span>
                  </span>
                </motion.li>
              ))}
            </AnimatePresence>
          </ol>
        </section>
        <section className="stack" style={{ flex: '1 1 420px', minWidth: 0 }} aria-labelledby="rp-h">
          <h2 id="rp-h" className="section-title">
            Propositions
          </h2>
          {r.proposals.length === 0 && <div className="frame empty">Pas encore de proposition.</div>}
          {r.proposals.map((p) => (
            <ProposalCard key={p.id} p={p} state={state} majority={r.majority} total={r.participants.length} canRevert={false} />
          ))}
        </section>
      </div>
    </div>
  );
}

export function RetroView({ state }: { state: OfficeState }) {
  const past = state.retro.history.filter((h) => h.status === 'closed');
  return (
    <div className="stack" style={{ gap: 22, maxWidth: 1320, margin: '0 auto' }}>
      {state.retro.current ? <Current state={state} /> : <StartForm />}
      <div className="row" style={{ gap: 16 }}>
        <section className="frame pad stack" style={{ flex: '1 1 360px', minWidth: 0 }}>
          <h2 className="section-title">Accords d’équipe</h2>
          {state.retro.agreements.length === 0 && <p className="muted" style={{ margin: 0 }}>Aucun accord pour le moment.</p>}
          {state.retro.agreements.map((a) => (
            <div key={a.id} style={{ display: 'flex', gap: 10 }}>
              <span style={{ color: 'var(--teal)', marginTop: 2 }}>
                <Icon name="check" size={14} />
              </span>
              <span>
                <strong>{a.title}</strong>
                <div className="muted" style={{ fontSize: 13 }}>
                  {a.text}
                </div>
              </span>
            </div>
          ))}
        </section>
        <section className="frame pad stack" style={{ flex: '1 1 360px', minWidth: 0 }}>
          <h2 className="section-title">Parts du budget équipe</h2>
          {state.agents.map((a) => (
            <div key={a.name} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
              <Sprite name={a.name} scale={1.2} />
              <span style={{ flex: '0 0 110px' }}>{displayName(state, a.name)}</span>
              <span className="bar" style={{ flex: 1 }}>
                <motion.span style={{ background: colorFor(a.name) }} animate={{ width: `${a.share * 2}%` }} transition={{ type: 'spring', stiffness: 120, damping: 20 }} />
              </span>
              <span className="mono" style={{ flex: '0 0 60px', textAlign: 'right' }}>
                {String(a.share).replace('.', ',')} %
              </span>
              {a.share !== a.configShare && <span className="muted" style={{ fontSize: 11 }}>(config {a.configShare})</span>}
            </div>
          ))}
        </section>
      </div>
      <section className="stack">
        <h2 className="section-title">Rétrospectives passées</h2>
        {past.length === 0 && <div className="frame empty">Aucune pour l’instant.</div>}
        {past.map((h) => (
          <details key={h.id} className="frame pad" open={h === past[0]}>
            <summary style={{ cursor: 'pointer', display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <strong>{h.topic ?? 'Rétrospective'}</strong>
              <span className="muted" style={{ fontSize: 12 }}>
                {h.closedAt ? ago(h.closedAt) : ''} · {h.proposals.filter((p) => p.status === 'adopted').length} décision(s) adoptée(s)
              </span>
            </summary>
            {h.summary && <p style={{ color: 'var(--text-2)' }}>{h.summary}</p>}
            <div className="stack" style={{ marginTop: 10 }}>
              {h.proposals.map((p) => (
                <ProposalCard key={p.id} p={p} state={state} canRevert />
              ))}
            </div>
          </details>
        ))}
      </section>
    </div>
  );
}
