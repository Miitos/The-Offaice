#!/usr/bin/env node
// The OffAIce — logo pixel art (16×16) : un petit immeuble de bureau doré dont les fenêtres
// sont deux yeux qui s'allument, avec une antenne : le bureau des agents IA.
// Écrit docs/assets/logo.svg, packages/ui/public/favicon.svg et le module TSX du logo.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const GRID = [
  '.......t........',
  '.......a........',
  '.......a........',
  '...RRRRRRRRRR...',
  '..GGGGGGGGGGGG..',
  '..GHHHHHHHHHHG..',
  '..GHNNNHHNNNHG..',
  '..GHNTWHHNTWHG..',
  '..GHNTTHHNTTHG..',
  '..GHHHHHHHHHHG..',
  '..GHHHNNNNHHHG..',
  '..GHHHNddNHHHG..',
  '..GHHHNddNHHHG..',
  '..GHHHNddNHHHG..',
  '.SSSSSSSSSSSSSS.',
  '................'
];
export const COLORS = { t: '#5fe0d0', a: '#b97f2e', R: '#ffd27a', G: '#b97f2e', H: '#f2b45a', N: '#12141a', T: '#5fe0d0', W: '#e8fffb', d: '#2a2f45', S: '#7a5320' };

function rects() {
  const out = [];
  GRID.forEach((row, y) => [...row].forEach((c, x) => c !== '.' && out.push(`<rect x="${x}" y="${y}" width="1" height="1" fill="${COLORS[c]}"/>`)));
  return out.join('');
}
const svg = (bg) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${bg ? '-2 -2 20 20' : '0 0 16 16'}" shape-rendering="crispEdges">${bg ? '<rect x="-2" y="-2" width="20" height="20" rx="3" fill="#0b1020"/>' : ''}${rects()}</svg>\n`;

fs.writeFileSync(path.join(ROOT, 'docs', 'assets', 'logo.svg'), svg(true));
fs.writeFileSync(path.join(ROOT, 'packages', 'ui', 'public', 'favicon.svg'), svg(true));
const cells = [];
GRID.forEach((row, y) => [...row].forEach((c, x) => c !== '.' && cells.push(`[${x},${y},'${COLORS[c]}']`)));
fs.writeFileSync(
  path.join(ROOT, 'packages', 'ui', 'src', 'components', 'LogoMark.tsx'),
  `// Généré par scripts/make-logo.mjs : ne pas modifier à la main.\nconst CELLS: [number, number, string][] = [${cells.join(',')}];\n\nexport function LogoMark({ size = 30 }: { size?: number }) {\n  return (\n    <svg width={size} height={size} viewBox="0 0 16 16" shapeRendering="crispEdges" aria-hidden="true">\n      {CELLS.map(([x, y, c]) => (\n        <rect key={\`\${x}-\${y}\`} x={x} y={y} width="1" height="1" fill={c} />\n      ))}\n    </svg>\n  );\n}\n`
);
console.log('logo écrit');
