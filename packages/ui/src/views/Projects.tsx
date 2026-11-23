import { useState } from 'react';
import { api, type OfficeState } from '../api';

interface ActivateResult {
  project: { id: string; name: string; repoPath: string; mainBranch: string };
  setup: { ok: boolean; output: string } | null;
  relaunch: { cwd: string; command: string };
}

/** Settings → Projects: the folders the team can work on, one at a time. */
export function ProjectsSection({ state }: { state: OfficeState }) {
  const [name, setName] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [mainBranch, setMainBranch] = useState('main');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ id: string; message: string } | null>(null);
  const [done, setDone] = useState<ActivateResult | null>(null);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    void run('add', async () => {
      await api('POST', '/api/projects', { name, repoPath, mainBranch });
      setName('');
      setRepoPath('');
      setMainBranch('main');
    });
  };

  const activate = (id: string, force = false) =>
    run(`activate-${id}`, async () => {
      setDone(null);
      try {
        const res = await api<ActivateResult>('POST', `/api/projects/${id}/activate`, { force });
        setConfirm(null);
        setDone(res);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Open cards in the current project: ask before leaving them.
        if (!force && /en cours/.test(msg)) setConfirm({ id, message: msg });
        else throw e;
      }
    });

  return (
    <section className="frame pad stack">
      <h3 className="section-title">Projets</h3>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>
        L’équipe travaille sur un projet à la fois. Chaque projet a son Kanban. En changer installe l’équipe dans le dossier du projet (sans toucher à ses propres fichiers ni à son historique git) ; il faut ensuite relancer l’équipe depuis ce dossier.
      </p>
      <div className="proj-list">
        {state.projects.map((p) => (
          <div key={p.id} className={`proj-row ${p.active ? 'on' : ''}`}>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <strong>{p.name}</strong>
                {p.active && (
                  <span className="chip" style={{ background: 'var(--green)' }}>
                    ACTIF
                  </span>
                )}
              </div>
              <div className="mono muted proj-path">{p.repoPath}</div>
              <div className="muted" style={{ fontSize: 12 }}>
                branche {p.mainBranch} · {p.cards} carte{p.cards > 1 ? 's' : ''}
                {p.openCards ? ` dont ${p.openCards} en cours` : ''}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              {!p.active && (
                <button className="btn btn-sm btn-primary" disabled={!!busy} onClick={() => void activate(p.id)}>
                  {busy === `activate-${p.id}` ? 'Installation…' : 'Travailler dessus'}
                </button>
              )}
              {!p.active && p.cards === 0 && (
                <button className="btn btn-sm btn-ghost" disabled={!!busy} onClick={() => void run(`rm-${p.id}`, () => api('DELETE', `/api/projects/${p.id}`))}>
                  Retirer
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {confirm && (
        <div className="proj-confirm" role="alertdialog" aria-label="Changer de projet">
          <span>{confirm.message}</span>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn btn-sm btn-ghost" onClick={() => setConfirm(null)}>
              Annuler
            </button>
            <button className="btn btn-sm btn-primary" disabled={!!busy} onClick={() => void activate(confirm.id, true)}>
              Changer quand même
            </button>
          </div>
        </div>
      )}
      {done && (
        <div className="frame pad stack" style={{ boxShadow: 'none', fontSize: 13 }} role="status">
          <strong style={{ color: 'var(--green)' }}>L’équipe est installée dans « {done.project.name} ».</strong>
          {!done.setup?.ok && <span style={{ color: 'var(--rose)' }}>L’installation a signalé un problème : {done.setup?.output}</span>}
          <span>Pour qu’elle s’y mette, relance l’équipe depuis ce dossier, sans consigne au lancement :</span>
          <code className="proj-cmd">
            cd "{done.relaunch.cwd}"; {done.relaunch.command}
          </code>
        </div>
      )}
      {error && <p style={{ margin: 0, color: 'var(--rose)', fontSize: 13 }}>{error}</p>}

      <form className="proj-add" onSubmit={add}>
        <h4 style={{ margin: 0, fontSize: 13 }}>Ajouter un projet</h4>
        <label className="set-field">
          <span>Nom</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="Ex. : Kyudo" required />
        </label>
        <label className="set-field">
          <span>Dossier (dépôt git, ou dossier vide ou inexistant pour un nouveau projet)</span>
          <input value={repoPath} onChange={(e) => setRepoPath(e.target.value)} placeholder="D:\Dev\mon-projet" required />
        </label>
        <label className="set-field">
          <span>Branche principale</span>
          <input value={mainBranch} onChange={(e) => setMainBranch(e.target.value)} placeholder="main" required />
        </label>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button className="btn btn-sm" type="submit" disabled={!!busy || !name.trim() || !repoPath.trim()}>
            Ajouter
          </button>
        </div>
      </form>
    </section>
  );
}
