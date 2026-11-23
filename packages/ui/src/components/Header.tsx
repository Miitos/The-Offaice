import { motion } from 'motion/react';
import { useState } from 'react';
import { api, clock, type OfficeState } from '../api';
import { href, type Route } from '../router';
import { LogoMark } from './LogoMark';
import { Icon } from './ui';

function Gauge({ state }: { state: OfficeState }) {
  const q = state.quota;
  const five = q.latest?.fiveHour?.usedPct ?? null;
  const seven = q.latest?.sevenDay?.usedPct ?? null;
  const base = state.usage.baselinePct ?? 0;
  const value = state.usage.method === 'token_budget' ? state.usage.globalPct : five;
  const color = value === null ? 'var(--muted)' : value >= q.stopAtPct ? 'var(--rose)' : value >= q.autoLockBreakRoomPct ? 'var(--amber)' : 'var(--teal)';
  const resets = q.latest?.fiveHour?.resetsAt ? clock(q.latest.fiveHour.resetsAt * 1000) : null;
  return (
    <div className="gauge" aria-label="Quota">
      <div className="gauge-row">
        <span>
          Quota · fenêtre 5 h <strong style={{ color }}>{value === null ? '–' : `${value} %`}</strong>
        </span>
        <span>
          7 j : {seven === null ? '–' : `${seven} %`}
          {resets ? ` · reset à ${resets}` : ''}
        </span>
      </div>
      <div className="gauge-track">
        {state.usage.method !== 'token_budget' && base > 0 && <span className="gauge-base" style={{ width: `${Math.min(base, value ?? base)}%` }} title={`Déjà utilisé avant l’équipe : ${base} %`} />}
        <span className="gauge-fill" style={{ width: `${value ?? 0}%`, background: color, opacity: 0.92, left: 0, clipPath: `inset(0 0 0 ${value ? (Math.min(base, value) / value) * 100 : 0}%)` }} />
        <span className={`gauge-mark ${value !== null && value >= q.autoLockBreakRoomPct ? 'hot' : ''}`} style={{ left: `${q.autoLockBreakRoomPct}%`, background: 'var(--amber)' }} title="Fermeture auto de la pause" />
        <span className={`gauge-mark ${value !== null && value >= q.stopAtPct ? 'hot' : ''}`} style={{ left: `${q.stopAtPct}%`, background: 'var(--rose)' }} title="Arrêt des agents" />
        <span className="gauge-mark" style={{ left: `${q.hardCapPct}%`, background: '#ffffff' }} title="Plafond dur" />
      </div>
      <div className="gauge-row" style={{ fontSize: 11 }}>
        <span>{state.usage.method === 'rate_limits' ? 'Source : rate_limits (statusline)' : state.usage.method === 'token_budget' ? 'Source : budget de tokens' : 'En attente de la statusline'}</span>
        <span>
          <span style={{ color: 'var(--amber)' }}>{q.autoLockBreakRoomPct} % pause fermée</span> · <span style={{ color: 'var(--rose)' }}>{q.stopAtPct} % arrêt</span> · {q.hardCapPct} % plafond
        </span>
      </div>
    </div>
  );
}

export function Header({ state, route, live, onNewCard }: { state: OfficeState | null; route: Route; live: string; onNewCard: () => void }) {
  const [busy, setBusy] = useState(false);
  const locked = !!state?.breakRoom.locked;
  const retroOpen = !!state?.retro.current;
  const tabs = [
    { key: 'office', label: 'Bureau', href: href.office },
    { key: 'kanban', label: 'Kanban', href: href.kanban },
    { key: 'retro', label: 'Rétro', href: href.retro },
    { key: 'creator', label: 'Avis', href: href.creator }
  ];
  const active = route.view === 'agent' ? 'office' : route.view;
  const toggle = async () => {
    setBusy(true);
    try {
      await api('POST', locked ? '/api/break-room/unlock' : '/api/break-room/lock');
    } finally {
      setBusy(false);
    }
  };
  return (
    <header className="topbar">
      <a className="brand" href={href.office}>
        <LogoMark size={30} />
        <span className="brand-stack">
          <span className="brand-name" aria-label="The OffAIce">
            THE OFF<span className="brand-ai">AI</span>CE
          </span>
          {state && <span className="brand-project" title={state.projects.find((p) => p.active)?.repoPath}>{state.projects.find((p) => p.active)?.name ?? ''}</span>}
        </span>
        <span className={`live-dot ${live}`} title={live === 'live' ? 'En direct' : live === 'offline' ? 'Serveur injoignable' : 'Connexion…'} />
      </a>
      <nav className="tabs" aria-label="Vues">
        {tabs.map((t) => (
          <a key={t.key} className="tab" href={t.href} aria-current={active === t.key ? 'page' : undefined}>
            {active === t.key && <motion.span layoutId="tab-pill" className="tab-pill" transition={{ type: 'spring', stiffness: 500, damping: 38 }} />}
            {t.label}
            {t.key === 'retro' && retroOpen && (
              <span className="chip badge" style={{ background: 'var(--violet)' }}>
                EN COURS
              </span>
            )}
          </a>
        ))}
      </nav>
      {state ? <Gauge state={state} /> : <div className="gauge" />}
      <button className={`btn switch ${locked ? 'on' : ''}`} onClick={toggle} disabled={busy || !state} aria-pressed={locked} style={locked ? { borderColor: 'var(--amber)', background: '#2b2416' } : undefined}>
        <Icon name={locked ? 'lock' : 'unlock'} color={locked ? 'var(--amber)' : 'var(--muted)'} />
        <span>{locked ? 'Salle de pause fermée' : 'Salle de pause ouverte'}</span>
        <span className="switch-track">
          <span className="switch-knob" />
        </span>
      </button>
      <a className={`btn icon-btn ${route.view === 'settings' ? 'on' : ''}`} href={href.settings} title="Paramètres" aria-label="Paramètres" aria-current={route.view === 'settings' ? 'page' : undefined}>
        <Icon name="gear" size={18} />
      </a>
      <button className="btn btn-primary" onClick={onNewCard}>
        <Icon name="plus" />
        Carte au backlog
      </button>
    </header>
  );
}

export function NewCardForm({ onDone, state, project: initialProject }: { onDone: () => void; state: OfficeState | null; project?: string }) {
  const [title, setTitle] = useState('');
  const [project, setProject] = useState(initialProject ?? state?.activeProject ?? '');
  const projects = state?.projects ?? [];
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/api/cards', { title, description, project: project || undefined });
      setTitle('');
      setDescription('');
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="stack">
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>
        La carte arrive au BACKLOG. Le lead la reprendra, et chaque agent notera sa clarté : plus elle est précise (contexte, critères d’acceptation), mieux c’est.
      </p>
      {projects.length > 1 && (
        <div>
          <label htmlFor="nc-project">Projet</label>
          <select id="nc-project" value={project} onChange={(e) => setProject(e.target.value)}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.active ? ' (projet actif)' : ' (attendra son tour)'}
              </option>
            ))}
          </select>
        </div>
      )}
      <div>
        <label htmlFor="nc-title">Titre</label>
        <input id="nc-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required autoFocus placeholder="Ex. : corriger le tri des dates" />
      </div>
      <div>
        <label htmlFor="nc-desc">Description et critères d’acceptation</label>
        <textarea id="nc-desc" rows={6} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={'Contexte…\nCritères :\n- …'} />
      </div>
      {error && <p style={{ margin: 0, color: 'var(--rose)' }}>{error}</p>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button type="button" className="btn btn-ghost" onClick={onDone}>
          Annuler
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy || !title.trim()}>
          Ajouter au BACKLOG
        </button>
      </div>
    </form>
  );
}
