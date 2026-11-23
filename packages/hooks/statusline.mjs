#!/usr/bin/env node
// The OffAIce — statusline du lead.
// Transmet le JSON de la statusline (dont rate_limits, le % du quota) au serveur
// et affiche la ligne qu'il renvoie.
const OFFICE_URL = process.env.OFFICE_URL ?? 'http://127.0.0.1:4317';

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', async () => {
  let j = {};
  try {
    j = JSON.parse(raw || '{}');
  } catch {
    /* ignore */
  }
  const rl = j.rate_limits;
  const fallback = `The OffAIce (hors ligne) | 5h ${rl?.five_hour?.used_percentage ?? '–'}% · 7j ${rl?.seven_day?.used_percentage ?? '–'}%`;
  try {
    const res = await fetch(`${OFFICE_URL}/api/statusline`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: j.session_id, rate_limits: rl ?? null }),
      signal: AbortSignal.timeout(2000)
    });
    const out = await res.json();
    process.stdout.write(out?.line || fallback);
  } catch {
    process.stdout.write(fallback);
  }
});
