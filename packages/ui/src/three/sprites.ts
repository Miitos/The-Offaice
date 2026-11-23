import { lookFor } from '../components/Sprite';

/** 16×24 pixel characters for the HD-2D office. Same colors as the 2D sprites (lookFor). */

export type HairStyle = 'short' | 'long' | 'bun' | 'spiky' | 'cap';
export interface Look3D {
  hair: string;
  skin: string;
  cloth: string;
  pants: string;
  acc: string;
  style: HairStyle;
  glasses: boolean;
  cap?: string;
}

const STYLES: Record<string, { style: HairStyle; glasses?: boolean }> = {
  lead: { style: 'long' },
  archi: { style: 'short', glasses: true },
  dev1: { style: 'bun' },
  dev2: { style: 'spiky' },
  reviewer: { style: 'long', glasses: true },
  tester: { style: 'cap' },
  designer: { style: 'bun', glasses: true }
};
const FALLBACK_STYLES: HairStyle[] = ['short', 'long', 'bun', 'spiky', 'cap'];

export function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * f)));
  const r = c((n >> 16) & 255), g = c((n >> 8) & 255), b = c(n & 255);
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

export function look3d(name: string): Look3D {
  const l = lookFor(name);
  const h = [...name].reduce((s, c) => s + c.charCodeAt(0), 0);
  const s = STYLES[name] ?? { style: FALLBACK_STYLES[h % FALLBACK_STYLES.length]!, glasses: h % 3 === 0 };
  return { hair: l.hair, skin: l.skin, cloth: l.shirt, pants: '#2d3150', acc: '#f4efe2', style: s.style, glasses: !!s.glasses, cap: shade(l.shirt, 0.6) };
}

const BASE = [
  '................', '.....OOOOOO.....', '....OHHHHHHO....', '...OHHHHHHHHO...', '...OHHHHHHHHO...', '...OHSSSSSSHO...',
  '...OSSESSESSO...', '...OSSSSSSSSO...', '....OSSssSSO....', '.....OSSSSO.....', '....OCCCCCCO....', '...OCCCWWCCCO...',
  '..OSOCCWWCCOSO..', '..OSOCCCCCCOSO..', '..OsOCCCCCCOsO..', '...OOccccccOO...', '....OPPPPPPO....', '....OPPOOPPO....',
  '....OPPOOPPO....', '....OPPOOPPO....', '....OBBOOBBO....', '....OOOOOOOO....', '................', '................'
];
const WALK_A = ['....OPPPPPPO....', '....OPPOOPPO....', '...OPPO..OPPO...', '...OPPO..OPPO...', '...OBBO..OBBO...', '...OOOO..OOOO...'];
const WALK_B = ['....OPPPPPPO....', '.....OPPPPO.....', '.....OPPPPO.....', '.....OPPPPO.....', '.....OBBBBO.....', '.....OOOOOO.....'];

const setc = (rows: string[], r: number, c: number, ch: string) => {
  rows[r] = rows[r]!.slice(0, c) + ch + rows[r]!.slice(c + 1);
};

function styled(look: Look3D): string[] {
  const r = BASE.slice();
  if (look.style === 'long')
    for (let y = 5; y <= 11; y++) {
      setc(r, y, 3, 'H');
      setc(r, y, 12, 'H');
      if (r[y]![2] === '.') setc(r, y, 2, 'O');
      if (r[y]![13] === '.') setc(r, y, 13, 'O');
    }
  if (look.style === 'bun') {
    r[0] = '......OHHO......';
    r[1] = '.....OOHHOO.....';
  }
  if (look.style === 'spiky') {
    r[0] = '.....O..O..O....';
    r[1] = '....OHOOHOOHO...';
  }
  if (look.style === 'cap') {
    for (let y = 1; y <= 3; y++) r[y] = r[y]!.replace(/H/g, 'K');
    r[4] = '..OKKKKKKKKKKO..';
  }
  if (look.glasses) r[6] = '...OSGLGGLGSO...';
  return r;
}

export type FrameKey = 'idle0' | 'idle1' | 'walk0' | 'walk1' | 'sleep';
export function frames(look: Look3D): Record<FrameKey, string[]> {
  const b = styled(look);
  const bob = (rows: string[]) => ['................', ...rows.slice(0, 15), ...rows.slice(16)];
  const legs = (rows: string[], L: string[]) => [...rows.slice(0, 16), ...L, ...rows.slice(22)];
  const sleep = b.map((row, y) => (y === 6 ? row.replace(/[EL]/g, 's') : row));
  return { idle0: b, idle1: bob(b), walk0: legs(b, WALK_A), walk1: bob(legs(b, WALK_B)), sleep };
}

export function palette(look: Look3D): Record<string, string> {
  return {
    O: '#1b1522', H: look.hair, h: shade(look.hair, 0.75), S: look.skin, s: shade(look.skin, 0.8), E: '#1b1522',
    C: look.cloth, c: shade(look.cloth, 0.7), W: look.acc, P: look.pants, B: '#2a1f22', K: look.cap ?? look.hair, G: '#232633', L: '#a8dcff'
  };
}

export function drawRows(g: CanvasRenderingContext2D, rows: string[], pal: Record<string, string>, ox = 0, oy = 0, maxRow = 24) {
  for (let y = 0; y < Math.min(rows.length, maxRow); y++)
    for (let x = 0; x < 16; x++) {
      const ch = rows[y]![x]!;
      const c = pal[ch];
      if (ch !== '.' && c) {
        g.fillStyle = c;
        g.fillRect(ox + x, oy + y, 1, 1);
      }
    }
}

/** Draws the head and shoulders (or the whole body) of an agent into a small canvas. */
export function drawPortrait(cv: HTMLCanvasElement, name: string, rows = 14) {
  const g = cv.getContext('2d');
  if (!g) return;
  const look = look3d(name);
  g.clearRect(0, 0, cv.width, cv.height);
  drawRows(g, frames(look).idle0, palette(look), 0, rows >= 22 ? 0 : -1, rows);
}
