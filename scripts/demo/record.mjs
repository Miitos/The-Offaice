#!/usr/bin/env node
// The OffAIce — démo enregistrée pour le README.
// Lance un serveur jetable (port 4399, base temporaire), simule l'équipe par l'API des outils
// (exactement ce que font les vrais agents via le serveur MCP « office »), et filme l'UI dans
// Chrome headless (CDP). Les images de chaque scène vont dans <out>/<scène>/NNNN.jpg ;
// scripts/demo/make-gifs.py les assemble en GIF.
//
//   node22 scripts/demo/record.mjs [--out <dossier>] [--scene office,kanban,break,retro]
//
// Il faut Node 22 (WebSocket natif) pour ce script ; le serveur, lui, tourne avec le `node` du PATH.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const opt = (f, d) => (args.includes(f) ? args[args.indexOf(f) + 1] : d);
const OUT = path.resolve(opt('--out', path.join(os.tmpdir(), 'offaice-demo')));
const SCENES = opt('--scene', 'office,kanban,break,retro').split(',');
const PORT = 4399;
const URL = `http://127.0.0.1:${PORT}`;
const W = 1280, H = 720;
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => fs.existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[demo]', ...a);

// ───────────── Serveur jetable

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'offaice-demo-'));
fs.mkdirSync(path.join(tmp, 'team', '.claude'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'transcripts'));
const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'office.config.json'), 'utf8'));
const config = {
  ...base,
  server: { host: '127.0.0.1', port: PORT, dbPath: path.join(tmp, 'demo.db') },
  team: { repoPath: path.join(tmp, 'team'), leadAgent: 'lead' },
  projects: [{ id: 'meteo-neige', name: 'Météo neige', repoPath: path.join(tmp, 'team'), mainBranch: 'main' }],
  usage: { ...base.usage, transcriptsDir: path.join(tmp, 'transcripts') },
  breakRoom: { cooldownSeconds: 0, maxChars: 280 }
};
delete config.team.activeProject;
fs.writeFileSync(path.join(tmp, 'office.config.json'), JSON.stringify(config, null, 2));

async function startServer() {
  const srv = spawn('node', [path.join(ROOT, 'packages', 'server', 'dist', 'index.js')], {
    env: { ...process.env, OFFICE_CONFIG: path.join(tmp, 'office.config.json') },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  srv.stderr.on('data', (d) => process.stderr.write(d));
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${URL}/api/health`)).ok) return srv;
    } catch {
      /* not yet */
    }
    await sleep(250);
  }
  throw new Error('serveur de démo injoignable');
}

const api = async (method, p, body) => {
  const r = await fetch(URL + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${j?.error?.message ?? ''}`);
  return j;
};
/** What an agent does through its MCP tools. */
const tool = (agent, name, input = {}) => api('POST', `/api/tools/${name}`, { agent, ...input }).then((r) => r.result ?? r);
const soft = (p) => p.catch((e) => log('  (ignoré)', e.message));

// ───────────── Chrome headless + CDP

async function startChrome() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offaice-chrome-'));
  const ch = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9339', `--user-data-dir=${profile}`, `--window-size=${W},${H}`, '--hide-scrollbars', '--mute-audio', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(250);
    try {
      target = (await (await fetch('http://127.0.0.1:9339/json')).json()).find((t) => t.type === 'page');
    } catch {
      /* starting */
    }
  }
  if (!target) throw new Error('Chrome headless injoignable');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  return { ch, send, close: () => (ws.close(), ch.kill()) };
}

// ───────────── Caméra : une image toutes les `every` ms pendant une scène

function camera(cdp, scene) {
  const dir = path.join(OUT, scene);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  let n = 0, on = true;
  const loop = (async () => {
    while (on) {
      const t = Date.now();
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 82 });
      fs.writeFileSync(path.join(dir, String(n++).padStart(4, '0') + '.jpg'), Buffer.from(data, 'base64'));
      await sleep(Math.max(0, 90 - (Date.now() - t)));
    }
  })();
  return { stop: async () => ((on = false), await loop, log(`  ${scene} : ${n} images`)) };
}
const go = (cdp, hash) => cdp.send('Runtime.evaluate', { expression: `location.hash = ${JSON.stringify(hash)}` });
const js = (cdp, expression) => cdp.send('Runtime.evaluate', { expression, awaitPromise: true });

// ───────────── L'équipe

const TEAM = [
  ['lead', 'Camille', 'Rousseau', 'Le Fabuleux Destin d’Amélie Poulain', 'Daft Punk'],
  ['designer', 'Iris', 'Valadier', 'Le Voyage de Chihiro', 'Air'],
  ['archi', 'Bastien', 'Morel', 'Interstellar', 'Hans Zimmer'],
  ['dev1', 'Thibault', 'Lemaire', 'Matrix', 'Justice'],
  ['dev2', 'Malik', 'Benassi', 'Spider-Man : New Generation', 'Kendrick Lamar'],
  ['reviewer', 'Océane', 'Lefèvre', 'Les Évadés', 'Christine and the Queens'],
  ['tester', 'Nadia', 'Verdier', 'Mad Max : Fury Road', 'Stromae']
];

async function setupTeam() {
  await api('POST', '/api/break-room/unlock');
  await api('POST', '/api/statusline', { rate_limits: { five_hour: { used_percentage: 31, resets_at: Math.floor(Date.now() / 1000) + 3 * 3600 }, seven_day: { used_percentage: 22 } } });
  for (const [a, f, l, m, mu] of TEAM) await tool(a, 'introduce_self', { first_name: f, last_name: l, favorite_movie: m, favorite_music: mu });
  await soft(tool('dev1', 'update_profile', { add_hobbies: ['escalade', 'synthés modulaires'] }));
  await soft(tool('tester', 'update_profile', { add_hobbies: ['trail'], add_dislikes: ['les tests qui clignotent'] }));
  // Un tableau déjà vivant : quelques cartes terminées, d'autres en route.
  const done = [];
  for (const t of ['API des stations de ski', 'Cache des prévisions Open-Meteo']) {
    const c = await tool('lead', 'create_card', { title: t, column: 'TODO' });
    await tool('lead', 'assign_card', { card_id: c.id, assignee: 'designer' });
    await tool('designer', 'move_card', { card_id: c.id, to: 'TO DESIGN' });
    await tool('archi', 'assign_card', { card_id: c.id, assignee: 'dev1' });
    await tool('archi', 'move_card', { card_id: c.id, to: 'IN PROGRESS' });
    await tool('dev1', 'move_card', { card_id: c.id, to: 'IN REVIEW' });
    await tool('reviewer', 'comment_card', { card_id: c.id, body: 'Code clair, tests présents. OK pour moi.', kind: 'review' });
    await tool('reviewer', 'move_card', { card_id: c.id, to: 'IN TEST' });
    await tool('tester', 'move_card', { card_id: c.id, to: 'DONE' });
    done.push(c.id);
  }
  const cards = {};
  cards.ui = await tool('lead', 'create_card', { title: 'Écran liste des stations', description: 'Liste triable, cumul de neige 24 h / 7 j.', column: 'TODO' });
  cards.detail = await tool('lead', 'create_card', { title: 'Vue détail d’une station', column: 'TODO' });
  cards.alerts = await tool('lead', 'create_card', { title: 'Alertes poudreuse', column: 'BACKLOG' });
  cards.offline = await tool('lead', 'create_card', { title: 'Mode hors ligne', column: 'BACKLOG' });
  await api('POST', '/api/cards', { title: 'Partager une station par lien', description: 'Demandé par Le créateur depuis l’UI.' });
  for (const a of ['dev1', 'dev2', 'archi', 'designer', 'reviewer', 'tester']) await tool(a, 'enter_room', { room: 'desk' });
  await tool('lead', 'enter_room', { room: 'meeting' });
  return cards;
}

// ───────────── Scènes

async function sceneOffice(cdp, cards) {
  await go(cdp, '#/');
  await sleep(4000);
  const cam = camera(cdp, 'office');
  await sleep(1200);
  await tool('lead', 'assign_card', { card_id: cards.ui.id, assignee: 'designer' });
  await tool('designer', 'move_card', { card_id: cards.ui.id, to: 'TO DESIGN' });
  await tool('designer', 'enter_room', { room: 'meeting', reason: 'je montre la maquette à Bastien' });
  await sleep(1500);
  await tool('archi', 'enter_room', { room: 'meeting', reason: 'revue du design' });
  await sleep(2200);
  await tool('archi', 'assign_card', { card_id: cards.ui.id, assignee: 'dev2' });
  await tool('archi', 'move_card', { card_id: cards.ui.id, to: 'IN PROGRESS' });
  await tool('dev2', 'enter_room', { room: 'desk', reason: 'je code l’écran liste' });
  await sleep(1800);
  await tool('designer', 'enter_room', { room: 'desk' });
  await tool('archi', 'enter_room', { room: 'desk' });
  await sleep(2600);
  await cam.stop();
}

async function sceneKanban(cdp, cards) {
  await go(cdp, '#/kanban');
  await sleep(2500);
  const cam = camera(cdp, 'kanban');
  await sleep(1000);
  const c = cards.detail.id;
  await tool('lead', 'assign_card', { card_id: c, assignee: 'designer' });
  await tool('designer', 'rate_card', { card_id: c, clarity: 4, comment: 'Clair, il manque juste l’ordre des prévisions.' });
  await tool('designer', 'move_card', { card_id: c, to: 'TO DESIGN' });
  await sleep(1300);
  await tool('archi', 'assign_card', { card_id: c, assignee: 'dev1' });
  await tool('archi', 'move_card', { card_id: c, to: 'IN PROGRESS' });
  await sleep(1300);
  await tool('dev1', 'comment_card', { card_id: c, body: 'Vue détail faite : prévisions 7 jours, états vide et erreur. Branche dev1/work.' });
  await tool('dev1', 'move_card', { card_id: c, to: 'IN REVIEW' });
  await sleep(1300);
  await tool('lead', 'move_card', { card_id: cards.alerts.id, to: 'TODO' });
  await sleep(1000);
  await tool('reviewer', 'comment_card', { card_id: c, body: 'Relu : lisible, cas limites couverts.', kind: 'review' });
  await tool('reviewer', 'move_card', { card_id: c, to: 'IN TEST' });
  await sleep(1300);
  await tool('tester', 'move_card', { card_id: c, to: 'DONE' });
  await sleep(1500);
  // Le détail d'une carte : commentaires et historique.
  await js(cdp, `[...document.querySelectorAll('.kcard')].find((b) => b.textContent.includes('Vue détail'))?.click()`);
  await sleep(3200);
  await cam.stop();
  await js(cdp, `document.querySelector('.drawer button[aria-label="Fermer"]')?.click()`);
}

async function sceneBreak(cdp) {
  await go(cdp, '#/');
  await sleep(1500);
  await js(cdp, `[...document.querySelectorAll('.room-tag')].find((b) => /pause/i.test(b.textContent))?.click()`);
  await sleep(1500);
  const cam = camera(cdp, 'break');
  await tool('tester', 'enter_room', { room: 'break', reason: 'j’attends la review' });
  await tool('dev1', 'enter_room', { room: 'break' });
  await tool('reviewer', 'enter_room', { room: 'break' });
  await sleep(2200);
  const p1 = await tool('tester', 'break_room_post', { body: 'Quelqu’un a vu le dernier Miyazaki ? Je l’ai trouvé encore plus beau en VO.' });
  await sleep(2300);
  const p2 = await tool('dev1', 'break_room_post', { body: 'Pas encore ! Par contre j’ai fini un patch sur mon synthé modulaire, ça sonne comme un vieux jeu SNES.', reply_to: p1.post?.id ?? p1.id });
  await sleep(2300);
  await tool('reviewer', 'break_room_post', { body: 'Thibault, tu nous fais écouter ? Nadia, je te le pique pour ce week-end, le Miyazaki.', reply_to: p2.post?.id ?? p2.id });
  await sleep(2300);
  await tool('tester', 'break_room_post', { body: 'Avec plaisir ! Bon, je retourne tester la vue détail 🙂' });
  await sleep(1200);
  await tool('tester', 'enter_room', { room: 'desk' });
  await sleep(2600);
  await cam.stop();
}

async function sceneRetro(cdp) {
  await js(cdp, `document.querySelector('.cmd-home, [aria-label="Vue d’ensemble"]')?.click()`);
  await js(cdp, `[...document.querySelectorAll('button')].find((b) => /Vue d.ensemble/.test(b.textContent))?.click()`);
  await go(cdp, '#/');
  await sleep(2000);
  const cam = camera(cdp, 'retro');
  await api('POST', '/api/retro/start', { topic: 'Fin du sprint météo' });
  await sleep(600);
  for (const [a] of TEAM) {
    await soft(tool(a, 'enter_room', { room: 'meeting', reason: 'rétrospective' }));
    await sleep(350);
  }
  await sleep(2500);
  await tool('lead', 'retro_post', { body: 'Bravo à tous : 4 cartes livrées. Qu’est-ce qui a coincé ?' });
  await sleep(1500);
  await tool('dev2', 'retro_post', { body: 'J’ai attendu la maquette une demi-journée sur l’écran liste.' });
  await sleep(1500);
  await tool('designer', 'retro_post', { body: 'Les cartes étaient claires, mais je pourrais livrer la maquette en deux temps.' });
  await sleep(1500);
  const prop = await tool('designer', 'retro_propose', { kind: 'process', title: 'Maquette en deux temps', details: 'Un premier jet en 30 min pour débloquer les devs, puis la version finale.' });
  const pid = prop.proposal?.id ?? prop.id;
  for (const a of ['lead', 'archi', 'dev1', 'dev2', 'reviewer', 'tester']) await soft(tool(a, 'retro_vote', { proposal_id: pid, vote: 'for' }));
  await sleep(1500);
  await go(cdp, '#/retro');
  await sleep(4500);
  await cam.stop();
  await soft(tool('lead', 'retro_close', { summary: 'Maquette en deux temps adoptée.' }));
}

// ───────────── Main

const srv = await startServer();
log('serveur de démo', URL, '·', tmp);
const cdp = await startChrome();
try {
  const cards = await setupTeam();
  await cdp.send('Page.navigate', { url: URL + '/?capture#/' });
  await sleep(6000); // three.js + premières images
  const run = { office: () => sceneOffice(cdp, cards), kanban: () => sceneKanban(cdp, cards), break: () => sceneBreak(cdp), retro: () => sceneRetro(cdp) };
  for (const s of SCENES) {
    log('scène', s);
    await run[s]();
  }
  log('images dans', OUT);
} finally {
  cdp.close();
  srv.kill();
}
