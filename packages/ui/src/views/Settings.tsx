import { useEffect, useMemo, useState } from 'react';
import { api, displayName, type OfficeState, useFetch } from '../api';
import { colorFor, Sprite } from '../components/Sprite';
import { ProjectsSection } from './Projects';

interface SettingsData {
  agents: { name: string; role: string; capabilities: string[]; model: string; share: number; effectiveShare: number }[];
  quota: { hardCapPct: number; stopAtPct: number; autoLockBreakRoomPct: number };
  breakRoom: { cooldownSeconds: number; maxChars: number };
  retro: { autoApply: boolean };
  models: { id: string; label: string }[];
  maxHardCapPct: number;
}

interface SaveResult {
  modelsChanged: string[];
  sharesChanged: boolean;
  setup: { ok: boolean; output: string } | null;
}

type Draft = Omit<SettingsData, 'models' | 'maxHardCapPct'>;

const num = (v: string) => (v.trim() === '' ? NaN : Number(v.replace(',', '.')));

export function SettingsView({ state }: { state: OfficeState }) {
  const [reload, setReload] = useState(0);
  const data = useFetch<SettingsData>('/api/settings', reload);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SaveResult | null>(null);

  useEffect(() => {
    if (data) setDraft({ agents: data.agents.map((a) => ({ ...a })), quota: { ...data.quota }, breakRoom: { ...data.breakRoom }, retro: { ...data.retro } });
  }, [data]);

  const total = useMemo(() => (draft ? Math.round(draft.agents.reduce((s, a) => s + (Number.isFinite(a.share) ? a.share : 0), 0) * 100) / 100 : 0), [draft]);
  const dirty = useMemo(() => !!data && !!draft && JSON.stringify({ agents: data.agents, quota: data.quota, breakRoom: data.breakRoom, retro: data.retro }) !== JSON.stringify(draft), [data, draft]);

  if (!data || !draft) return <p className="muted">Chargement…</p>;

  const q = draft.quota;
  const problems: string[] = [];
  if (Math.abs(total - 100) > 0.01) problems.push(`La somme des parts doit faire 100 % (actuellement ${String(total).replace('.', ',')} %).`);
  if (!(q.hardCapPct <= data.maxHardCapPct)) problems.push(`Le plafond ne dépasse jamais ${data.maxHardCapPct} %.`);
  if (!(q.stopAtPct <= q.hardCapPct)) problems.push('L’arrêt des agents doit arriver avant le plafond.');
  if (!(q.autoLockBreakRoomPct <= q.stopAtPct)) problems.push('La fermeture de la pause doit arriver avant l’arrêt des agents.');

  const setAgent = (name: string, patch: Partial<Draft['agents'][number]>) => setDraft((d) => d && { ...d, agents: d.agents.map((a) => (a.name === name ? { ...a, ...patch } : a)) });

  const save = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await api<SaveResult>('PUT', '/api/settings', {
        agents: draft.agents.map((a) => ({ name: a.name, model: a.model, share: a.share })),
        quota: draft.quota,
        breakRoom: draft.breakRoom,
        retro: draft.retro
      });
      setResult(res);
      setReload((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack settings" style={{ gap: 18 }}>
      <ProjectsSection state={state} />
      <section className="frame pad stack">
        <h3 className="section-title">L’équipe</h3>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          Le modèle et la part du quota de chaque membre. Un changement de modèle réécrit les fichiers de l’équipe et s’applique au prochain lancement de l’équipe ; les parts s’appliquent tout de suite.
        </p>
        <div className="set-agents">
          {draft.agents.map((a) => {
            const known = data.models.some((m) => m.id === a.model);
            const before = data.agents.find((x) => x.name === a.name);
            return (
              <div key={a.name} className="set-agent">
                <div className="set-who">
                  <Sprite name={a.name} scale={1.6} />
                  <div>
                    <strong style={{ color: colorFor(a.name) }}>{displayName(state, a.name)}</strong>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {a.role} · <span className="mono">{a.name}</span>
                    </div>
                  </div>
                </div>
                <label className="set-field">
                  <span>Modèle</span>
                  <select value={a.model} onChange={(e) => setAgent(a.name, { model: e.target.value })}>
                    {!known && <option value={a.model}>{a.model}</option>}
                    {data.models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="set-field small">
                  <span>Part %</span>
                  <input type="number" min={0} max={100} step={0.5} value={Number.isFinite(a.share) ? a.share : ''} onChange={(e) => setAgent(a.name, { share: num(e.target.value) })} />
                </label>
                {before && before.effectiveShare !== before.share && (
                  <span className="muted" style={{ fontSize: 11, gridColumn: '1 / -1' }}>
                    Part actuelle {String(before.effectiveShare).replace('.', ',')} % (décidée en rétro) : enregistrer de nouvelles parts la remplace.
                  </span>
                )}
              </div>
            );
          })}
        </div>
        <p style={{ margin: 0, fontSize: 13, color: Math.abs(total - 100) > 0.01 ? 'var(--rose)' : 'var(--text-2)' }}>Total des parts : {String(total).replace('.', ',')} %</p>
      </section>

      <div className="set-grid">
        <section className="frame pad stack">
          <h3 className="section-title">Quota</h3>
          <Field label="Fermeture auto de la salle de pause" suffix="%" value={q.autoLockBreakRoomPct} onChange={(v) => setDraft({ ...draft, quota: { ...q, autoLockBreakRoomPct: v } })} />
          <Field label="Arrêt des agents (salle de repos)" suffix="%" value={q.stopAtPct} onChange={(v) => setDraft({ ...draft, quota: { ...q, stopAtPct: v } })} />
          <Field label={`Plafond dur (${data.maxHardCapPct} % maximum)`} suffix="%" max={data.maxHardCapPct} value={q.hardCapPct} onChange={(v) => setDraft({ ...draft, quota: { ...q, hardCapPct: v } })} />
        </section>
        <section className="frame pad stack">
          <h3 className="section-title">Salle de pause</h3>
          <Field label="Délai entre deux messages" suffix="s" value={draft.breakRoom.cooldownSeconds} onChange={(v) => setDraft({ ...draft, breakRoom: { ...draft.breakRoom, cooldownSeconds: v } })} />
          <Field label="Longueur maximale d’un message" suffix="car." value={draft.breakRoom.maxChars} onChange={(v) => setDraft({ ...draft, breakRoom: { ...draft.breakRoom, maxChars: v } })} />
        </section>
        <section className="frame pad stack">
          <h3 className="section-title">Rétrospective</h3>
          <label className="set-check">
            <input type="checkbox" checked={draft.retro.autoApply} onChange={(e) => setDraft({ ...draft, retro: { autoApply: e.target.checked } })} />
            Appliquer tout de suite les décisions adoptées (parts, accords)
          </label>
        </section>
      </div>

      {problems.length > 0 && (
        <ul style={{ margin: 0, color: 'var(--rose)', fontSize: 13 }}>
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {error && <p style={{ margin: 0, color: 'var(--rose)' }}>{error}</p>}
      {result && (
        <div className="frame pad stack" style={{ boxShadow: 'none', fontSize: 13 }} role="status">
          <strong style={{ color: 'var(--green)' }}>Paramètres enregistrés.</strong>
          {result.sharesChanged && <span>Nouvelles parts appliquées.</span>}
          {result.modelsChanged.length > 0 && (
            <span>
              Modèle changé pour {result.modelsChanged.map((n) => displayName(state, n)).join(', ')} :{' '}
              {result.setup?.ok ? 'fichiers de l’équipe réécrits, effet au prochain lancement de l’équipe.' : `réécriture des fichiers de l’équipe en échec (${result.setup?.output ?? 'raison inconnue'}).`}
            </span>
          )}
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn btn-ghost" disabled={!dirty || busy} onClick={() => setReload((n) => n + 1)}>
          Annuler les changements
        </button>
        <button className="btn btn-primary" disabled={!dirty || busy || problems.length > 0} onClick={save}>
          {busy ? 'Enregistrement…' : 'Enregistrer'}
        </button>
      </div>
    </div>
  );
}

function Field({ label, value, suffix, max, onChange }: { label: string; value: number; suffix: string; max?: number; onChange: (v: number) => void }) {
  return (
    <label className="set-field row">
      <span>{label}</span>
      <span className="set-input">
        <input type="number" min={0} max={max} value={Number.isFinite(value) ? value : ''} onChange={(e) => onChange(num(e.target.value))} />
        <span className="muted">{suffix}</span>
      </span>
    </label>
  );
}
