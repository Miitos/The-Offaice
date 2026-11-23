import { AnimatePresence, motion } from 'motion/react';
import { type ReactNode, useEffect } from 'react';

export function Icon({ name, size = 16, color = 'currentColor' }: { name: 'lock' | 'unlock' | 'plus' | 'back' | 'chat' | 'x' | 'spark' | 'users' | 'check' | 'undo' | 'gear'; size?: number; color?: string }) {
  const p = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: color, strokeWidth: 2.2, strokeLinecap: 'square' as const, 'aria-hidden': true };
  switch (name) {
    case 'lock':
      return (
        <svg {...p}>
          <rect x="4" y="11" width="16" height="10" />
          <path d="M8 11V7a4 4 0 0 1 8 0v4" />
        </svg>
      );
    case 'unlock':
      return (
        <svg {...p}>
          <rect x="4" y="11" width="16" height="10" />
          <path d="M8 11V7a4 4 0 0 1 7.5-2" />
        </svg>
      );
    case 'gear':
      return (
        <svg {...p}>
          <circle cx="12" cy="12" r="3.2" />
          <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" />
        </svg>
      );
    case 'plus':
      return (
        <svg {...p}>
          <path d="M12 5v14M5 12h14" />
        </svg>
      );
    case 'back':
      return (
        <svg {...p}>
          <path d="M15 5l-7 7 7 7" />
        </svg>
      );
    case 'chat':
      return (
        <svg {...p}>
          <path d="M4 5h16v11H9l-5 4z" />
        </svg>
      );
    case 'x':
      return (
        <svg {...p}>
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      );
    case 'spark':
      return (
        <svg {...p}>
          <path d="M12 3v5M12 16v5M3 12h5M16 12h5M6 6l3 3M15 15l3 3M18 6l-3 3M9 15l-3 3" />
        </svg>
      );
    case 'users':
      return (
        <svg {...p}>
          <circle cx="9" cy="8" r="3" />
          <path d="M3 20c0-3 3-5 6-5s6 2 6 5M16 5a3 3 0 0 1 0 6M18 15c2 1 3 3 3 5" />
        </svg>
      );
    case 'check':
      return (
        <svg {...p}>
          <path d="M5 12l5 5 9-10" />
        </svg>
      );
    case 'undo':
      return (
        <svg {...p}>
          <path d="M9 14L4 9l5-5" />
          <path d="M4 9h10a6 6 0 0 1 0 12h-3" />
        </svg>
      );
  }
}

export function Dots({ value, color }: { value: number | null; color: string }) {
  const n = Math.round(value ?? 0);
  return (
    <span className="dots" aria-hidden="true">
      {[1, 2, 3, 4, 5].map((i) => (
        <i key={i} style={{ background: i <= n ? color : '#323848' }} />
      ))}
    </span>
  );
}

export const clarityColor = (avg: number | null) => (avg === null ? 'var(--muted)' : avg >= 4 ? 'var(--green)' : avg >= 3 ? 'var(--yellow)' : 'var(--rose)');

export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div className="overlay" onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
          <motion.div
            className="modal frame"
            role="dialog"
            aria-modal="true"
            aria-label={title}
            initial={{ opacity: 0, y: 24, scale: 0.97, x: '-50%' }}
            animate={{ opacity: 1, y: 0, scale: 1, x: '-50%' }}
            exit={{ opacity: 0, y: 12, scale: 0.98, x: '-50%' }}
            transition={{ type: 'spring', stiffness: 420, damping: 32 }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h2 className="pix" style={{ margin: 0, fontSize: 15, fontWeight: 400 }}>
                {title}
              </h2>
              <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Fermer">
                <Icon name="x" />
              </button>
            </div>
            {children}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

export function Drawer({ open, onClose, children, label }: { open: boolean; onClose: () => void; children: ReactNode; label: string }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div className="overlay" onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
          <motion.aside className="drawer" role="dialog" aria-modal="true" aria-label={label} initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={{ type: 'spring', stiffness: 380, damping: 38 }}>
            {children}
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

export interface Toast {
  id: number;
  text: string;
  color: string;
}

export function Toasts({ items, onDone }: { items: Toast[]; onDone: (id: number) => void }) {
  useEffect(() => {
    const timers = items.map((t) => window.setTimeout(() => onDone(t.id), 5200));
    return () => timers.forEach(clearTimeout);
  }, [items, onDone]);
  return (
    <div className="toasts" aria-live="polite">
      <AnimatePresence>
        {items.map((t) => (
          <motion.div
            key={t.id}
            className="toast"
            style={{ borderLeftColor: t.color }}
            layout
            initial={{ opacity: 0, x: 60, scale: 0.95 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 40 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
          >
            {t.text}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

/** Animated number (counts toward the new value). */
export function Count({ value, suffix = '' }: { value: number; suffix?: string }) {
  return (
    <motion.span key={Math.round(value * 10)} initial={{ opacity: 0.4, y: -4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }}>
      {String(Math.round(value * 10) / 10).replace('.', ',')}
      {suffix}
    </motion.span>
  );
}
