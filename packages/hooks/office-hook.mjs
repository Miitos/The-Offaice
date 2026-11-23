#!/usr/bin/env node
// The OffAIce — hook Claude Code (type "command").
// Envoie l'entrée du hook au serveur The OffAIce et réimprime sa réponse JSON
// (refus d'outil, identité injectée, relance d'un agent…).
// Serveur injoignable : PreToolUse est refusé (fermé par défaut, le quota passe avant tout),
// les autres événements passent sans rien faire.
const OFFICE_URL = process.env.OFFICE_URL ?? 'http://127.0.0.1:4317';
const TIMEOUT_MS = Number(process.env.OFFICE_HOOK_TIMEOUT_MS ?? 5000);

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', async () => {
  let input = {};
  try {
    input = JSON.parse(raw || '{}');
  } catch {
    process.exit(0);
  }
  const event = input.hook_event_name || process.argv[2] || 'unknown';
  try {
    const res = await fetch(`${OFFICE_URL}/api/hooks/${encodeURIComponent(event)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    const out = await res.json();
    if (out && Object.keys(out).length) process.stdout.write(JSON.stringify(out));
    process.exit(0);
  } catch (e) {
    if (event === 'PreToolUse') {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: `Serveur The OffAIce injoignable (${OFFICE_URL}) : aucun outil tant qu'il ne tourne pas, pour protéger le quota. Préviens Le créateur et termine ton tour.`
          }
        })
      );
    }
    process.exit(0);
  }
});
