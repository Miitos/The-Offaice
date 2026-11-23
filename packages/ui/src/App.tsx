import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { COLUMN_LABEL, displayName, type LiveEvent, type OfficeState, ROOM_LABEL, useOffice } from './api';
import { Header, NewCardForm } from './components/Header';
import { colorFor } from './components/Sprite';
import { Modal, type Toast, Toasts } from './components/ui';
import { href, useRoute } from './router';
import { AgentView } from './views/AgentView';
import { CreatorView } from './views/Creator';
import { SettingsView } from './views/Settings';
import { KanbanView } from './views/Kanban';
import { OfficeView } from './views/Office';
import { RetroView } from './views/Retro';

function toastFor(e: LiveEvent, s: OfficeState | null): Omit<Toast, 'id'> | null {
  const name = (a: string) => displayName(s, a);
  switch (e.type) {
    case 'card_event':
      if (e.data.kind === 'moved') return { text: `${name(e.data.actor)} : #${e.data.card_id} → ${COLUMN_LABEL[e.data.to_col as keyof typeof COLUMN_LABEL]}`, color: colorFor(e.data.actor) };
      if (e.data.kind === 'move_refused') return { text: `Refusé à ${name(e.data.actor)} : #${e.data.card_id} → ${COLUMN_LABEL[e.data.to_col as keyof typeof COLUMN_LABEL]}`, color: 'var(--rose)' };
      if (e.data.kind === 'created') return { text: `Nouvelle carte #${e.data.card_id}`, color: 'var(--amber)' };
      return null;
    case 'room':
      if (e.data.to === 'rest') return { text: `${name(e.data.agent)} part en salle de repos (quota)`, color: 'var(--green)' };
      if (e.data.from === 'rest') return { text: `${name(e.data.agent)} se réveille : ${ROOM_LABEL[e.data.to as keyof typeof ROOM_LABEL]}`, color: 'var(--green)' };
      return null;
    case 'break_lock':
      return { text: e.data.locked ? `Salle de pause fermée${e.data.actor === 'auto' ? ' automatiquement' : ''}` : 'Salle de pause rouverte', color: 'var(--amber)' };
    case 'retro':
      return { text: e.data.status === 'open' ? 'Rétrospective : toute l’équipe en salle de meeting' : 'Rétrospective close', color: 'var(--violet)' };
    case 'shares':
      return { text: 'Parts du budget modifiées', color: 'var(--amber)' };
    case 'agent':
      if (e.data.persona && !s?.agents.find((a) => a.name === e.data.name)?.persona) return { text: `${e.data.persona.firstName} rejoint l’équipe (${e.data.name})`, color: colorFor(e.data.name) };
      return null;
    default:
      return null;
  }
}

export function App() {
  const { state, live, onEvent } = useOffice();
  const route = useRoute();
  const [newCard, setNewCard] = useState<{ project?: string } | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const stateRef = useRef(state);
  stateRef.current = state;
  const nextId = useRef(1);

  useEffect(
    () =>
      onEvent((e) => {
        const t = toastFor(e, stateRef.current);
        if (t) setToasts((xs) => [...xs.slice(-3), { ...t, id: nextId.current++ }]);
      }),
    [onEvent]
  );
  const dismiss = useCallback((id: number) => setToasts((xs) => xs.filter((t) => t.id !== id)), []);

  // The 3D office fills the window under the header: expose the header height.
  useEffect(() => {
    const el = document.querySelector('.topbar');
    if (!el) return;
    const ro = new ResizeObserver(() => document.documentElement.style.setProperty('--topbar-h', `${Math.round(el.getBoundingClientRect().height)}px`));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The office is always the main screen; the other views open on top of it.
  const overlay = route.view !== 'office';
  const close = useCallback(() => {
    window.location.hash = href.office;
  }, []);
  useEffect(() => {
    if (!overlay) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('.drawer, .modal')) close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [overlay, close]);
  const titles: Record<string, string> = { kanban: 'Kanban', retro: 'Rétrospective', creator: 'Avis', settings: 'Paramètres' };
  const sheetTitle = route.view === 'agent' ? (state?.agents.find((a) => a.name === route.name)?.persona?.firstName ?? route.name) : (titles[route.view] ?? '');
  const key = route.view === 'agent' ? `agent-${route.name}` : route.view;

  return (
    <div className="app">
      <Header state={state} route={route} live={live} onNewCard={() => setNewCard({})} />
      <main className={`main ${state ? 'full' : ''}`}>
        {!state ? (
          <div className="empty pix" style={{ marginTop: 80 }}>
            {live === 'offline' ? 'Serveur The OffAIce injoignable (npm run dev:server)' : 'Ouverture du bureau…'}
          </div>
        ) : (
          <OfficeView state={state} />
        )}
      </main>
      <AnimatePresence>
        {state && overlay && (
          <motion.div key="sheet" className="sheet-backdrop" onClick={close} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
            <motion.section
              className="win sheet"
              role="dialog"
              aria-modal="true"
              aria-label={sheetTitle}
              onClick={(e) => e.stopPropagation()}
              initial={{ y: 40, opacity: 0, scale: 0.98 }}
              animate={{ y: 0, opacity: 1, scale: 1 }}
              exit={{ y: 30, opacity: 0, scale: 0.98 }}
              transition={{ type: 'spring', stiffness: 380, damping: 34 }}
            >
              <header className="sheet-head">
                <h2>{sheetTitle}</h2>
                <button className="x" onClick={close} aria-label="Fermer et revenir au bureau">
                  ×
                </button>
              </header>
              <div className="sheet-body">
                <AnimatePresence mode="wait">
                  <motion.div key={key} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}>
                    {route.view === 'kanban' && <KanbanView state={state} onEvent={onEvent} onNewCard={(project) => setNewCard({ project })} />}
                    {route.view === 'retro' && <RetroView state={state} />}
                    {route.view === 'creator' && <CreatorView state={state} />}
                    {route.view === 'settings' && <SettingsView state={state} />}
                    {route.view === 'agent' && <AgentView state={state} name={route.name} tab={route.tab} />}
                  </motion.div>
                </AnimatePresence>
              </div>
            </motion.section>
          </motion.div>
        )}
      </AnimatePresence>
      <Modal open={!!newCard} onClose={() => setNewCard(null)} title="Nouvelle carte au BACKLOG">
        {newCard && <NewCardForm state={state} project={newCard.project} onDone={() => setNewCard(null)} />}
      </Modal>
      <Toasts items={toasts} onDone={dismiss} />
    </div>
  );
}
