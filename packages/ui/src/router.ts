import { useEffect, useState } from 'react';

export type Route =
  | { view: 'office' }
  | { view: 'kanban' }
  | { view: 'retro' }
  | { view: 'creator' }
  | { view: 'settings' }
  | { view: 'agent'; name: string; tab: 'activite' | 'profil' };

export function parse(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  switch (parts[0]) {
    case 'kanban':
      return { view: 'kanban' };
    case 'retro':
      return { view: 'retro' };
    case 'avis':
    case 'createur':
      return { view: 'creator' };
    case 'parametres':
      return { view: 'settings' };
    case 'agent':
      return { view: 'agent', name: parts[1] ?? 'lead', tab: parts[2] === 'profil' ? 'profil' : 'activite' };
    default:
      return { view: 'office' };
  }
}

export const href = {
  office: '#/',
  kanban: '#/kanban',
  retro: '#/retro',
  creator: '#/avis',
  settings: '#/parametres',
  agent: (name: string, tab: 'activite' | 'profil' = 'activite') => `#/agent/${name}${tab === 'profil' ? '/profil' : ''}`
};

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(window.location.hash));
  useEffect(() => {
    const on = () => {
      setRoute(parse(window.location.hash));
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}
