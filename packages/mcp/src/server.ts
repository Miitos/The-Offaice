import { TOOLS } from './tools.js';

/** Key the PreToolUse hook adds to every office tool call: the caller's identity. */
export const IDENTITY_KEY = '_office_agent';

type Json = Record<string, unknown>;
interface Request {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: Json;
}

export interface Transport {
  callTool(tool: string, body: Json): Promise<{ ok: boolean; result?: unknown; error?: { code: string; message: string } }>;
}

/** HTTP transport to the The OffAIce server. */
export function httpTransport(baseUrl: string, timeoutMs = 10_000): Transport {
  return {
    async callTool(tool, body) {
      const res = await fetch(`${baseUrl}/api/tools/${tool}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(tool === 'break_room_wait' ? 300_000 : timeoutMs)
      });
      return (await res.json()) as { ok: boolean; result?: unknown; error?: { code: string; message: string } };
    }
  };
}

const text = (t: string, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

/** Handles one JSON-RPC message; returns the response, or null for notifications. */
export async function handle(msg: Request, transport: Transport, serverVersion = '0.1.0'): Promise<Json | null> {
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
  if (msg.id === undefined || msg.id === null) return null; // notification

  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: (msg.params?.protocolVersion as string) ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'office', version: serverVersion },
        instructions:
          'Outils du bureau The OffAIce : kanban, pièces, salle de pause, profils, rétrospective. Ton identité est ajoutée automatiquement : ne passe jamais de nom d’agent pour toi-même.'
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const name = String(msg.params?.name ?? '');
      if (!TOOLS.some((t) => t.name === name)) return fail(-32602, `Outil inconnu : ${name}`);
      const args = { ...((msg.params?.arguments as Json) ?? {}) };
      const agent = args[IDENTITY_KEY];
      delete args[IDENTITY_KEY];
      delete args.agent; // never trust a name the model typed
      if (typeof agent !== 'string' || !agent) {
        return reply(text('Identité manquante : le hook PreToolUse d’The OffAIce n’est pas actif dans cette session (voir .claude/settings.json).', true));
      }
      try {
        const res = await transport.callTool(name, { ...args, agent });
        if (res.ok) return reply(text(JSON.stringify(res.result, null, 1)));
        return reply(text(`Refusé (${res.error?.code ?? 'erreur'}) : ${res.error?.message ?? 'erreur inconnue'}`, true));
      } catch (e) {
        return reply(text(`Serveur The OffAIce injoignable (${e instanceof Error ? e.message : String(e)}). Lance-le avec « npm run dev:server » dans agent-office.`, true));
      }
    }
    default:
      return fail(-32601, `Méthode non gérée : ${msg.method}`);
  }
}
