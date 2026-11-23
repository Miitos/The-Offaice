#!/usr/bin/env node
/**
 * Serveur MCP « office » (stdio, JSON-RPC délimité par des retours à la ligne).
 * Un seul processus sert le lead et tous les coéquipiers in-process : l'identité de
 * l'appelant arrive dans les arguments, ajoutée par le hook PreToolUse.
 */
import readline from 'node:readline';
import { handle, httpTransport } from './server.js';

const baseUrl = process.env.OFFICE_URL ?? 'http://127.0.0.1:4317';
const transport = httpTransport(baseUrl);
const write = (m: unknown) => process.stdout.write(JSON.stringify(m) + '\n');

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  handle(msg, transport)
    .then((res) => res && write(res))
    .catch((e) => write({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32603, message: String(e) } }));
});
