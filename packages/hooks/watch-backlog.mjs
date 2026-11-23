#!/usr/bin/env node
// The OffAIce — veilleur du BACKLOG, lancé par le lead avec l'outil Monitor de Claude Code.
// Chaque ligne imprimée réveille le lead : une par carte que Le créateur ajoute depuis l'UI,
// une par réponse de Le créateur sur une carte, plus une quand une rétrospective commence. Écoute le flux SSE du serveur et s'y reconnecte
// tout seul si le serveur redémarre.
const OFFICE_URL = process.env.OFFICE_URL ?? 'http://127.0.0.1:4317';
const seen = new Set();
let warnedDown = false;

async function cardOf(id) {
  try {
    const r = await fetch(`${OFFICE_URL}/api/cards/${id}`);
    const c = await r.json();
    return { title: c?.title ?? '', project: c?.project ?? null };
  } catch {
    return { title: '', project: null };
  }
}
const titleOf = async (id) => (await cardOf(id)).title;

/** Cards of another project wait for their turn: the team only works on the active one. */
async function inActiveProject(project) {
  if (!project) return true;
  try {
    const list = await (await fetch(`${OFFICE_URL}/api/projects`)).json();
    return list.find((p) => p.active)?.id === project;
  } catch {
    return true;
  }
}

async function onEvent(type, raw) {
  let e;
  try {
    e = JSON.parse(raw);
  } catch {
    return;
  }
  const d = e?.data ?? {};
  if (type === 'card_event' && d.kind === 'created' && d.actor === 'user' && !seen.has(d.card_id)) {
    seen.add(d.card_id);
    const card = await cardOf(d.card_id);
    if (!(await inActiveProject(card.project))) return;
    const title = d.card_title ?? card.title;
    console.log(`Nouvelle carte du créateur au BACKLOG : #${d.card_id} « ${title} ». Lis-la (get_card) et lance le travail.`);
  }
  if (type === 'comment' && d.author === 'user' && d.card_id) {
    const card = await cardOf(d.card_id);
    if (!(await inActiveProject(card.project))) return;
    const title = card.title;
    console.log(`Le créateur a répondu sur la carte #${d.card_id} « ${title} ». Préviens le designer (SendMessage) pour qu'il relise la carte.`);
  }
  if (type === 'retro' && d.status === 'open') console.log('Rétrospective lancée par le créateur : appelle retro_status et rejoins la salle de meeting.');
}

async function listen() {
  const res = await fetch(`${OFFICE_URL}/api/events`, { headers: { accept: 'text/event-stream' } });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  if (warnedDown) {
    console.log('Serveur The OffAIce de nouveau joignable : veille reprise.');
    warnedDown = false;
  }
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let type = 'message';
      const data = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) type = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (data.length) await onEvent(type, data.join('\n'));
    }
  }
}

for (;;) {
  try {
    await listen();
  } catch {
    if (!warnedDown) {
      console.log(`Serveur The OffAIce injoignable (${OFFICE_URL}) : la veille réessaie toute seule.`);
      warnedDown = true;
    }
  }
  await new Promise((r) => setTimeout(r, 5000));
}
