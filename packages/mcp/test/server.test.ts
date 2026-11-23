import { describe, expect, it } from 'vitest';
import { handle, IDENTITY_KEY, type Transport } from '../src/server.js';
import { TOOLS } from '../src/tools.js';

function recorder() {
  const calls: { tool: string; body: Record<string, unknown> }[] = [];
  const t: Transport = {
    async callTool(tool, body) {
      calls.push({ tool, body });
      if (tool === 'move_card') return { ok: false, error: { code: 'capability_required', message: 'Seul un agent reviewer peut passer une carte en IN TEST.' } };
      return { ok: true, result: { done: tool } };
    }
  };
  return { calls, t };
}

describe('office MCP server', () => {
  it('initializes and lists every tool with a JSON schema', async () => {
    const { t } = recorder();
    const init: any = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, t);
    expect(init.result.serverInfo.name).toBe('office');
    const list: any = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, t);
    const names = list.result.tools.map((x: any) => x.name);
    expect(names).toEqual(TOOLS.map((x) => x.name));
    expect(names).toContain('retro_propose');
    for (const tool of list.result.tools) expect(tool.inputSchema.type).toBe('object');
    expect(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' } as any, t)).toBeNull();
  });

  it('forwards the injected identity and drops any name the model typed', async () => {
    const { t, calls } = recorder();
    const res: any = await handle(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_board', arguments: { agent: 'reviewer', [IDENTITY_KEY]: 'dev1' } } },
      t
    );
    expect(calls[0]).toEqual({ tool: 'list_board', body: { agent: 'dev1' } });
    expect(JSON.parse(res.result.content[0].text)).toEqual({ done: 'list_board' });
  });

  it('refuses calls without identity and reports server refusals as tool errors', async () => {
    const { t, calls } = recorder();
    const noId: any = await handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_board', arguments: {} } }, t);
    expect(noId.result.isError).toBe(true);
    expect(calls).toHaveLength(0);
    const refused: any = await handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'move_card', arguments: { card_id: 1, to: 'IN TEST', [IDENTITY_KEY]: 'dev1' } } }, t);
    expect(refused.result.isError).toBe(true);
    expect(refused.result.content[0].text).toMatch(/Refusé \(capability_required\)/);
    const unknown: any = await handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope', arguments: {} } }, t);
    expect(unknown.error.code).toBe(-32602);
  });

  it('says clearly when the office server is down', async () => {
    const down: Transport = { callTool: async () => { throw new Error('ECONNREFUSED'); } };
    const res: any = await handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'list_board', arguments: { [IDENTITY_KEY]: 'lead' } } }, down);
    expect(res.result.content[0].text).toMatch(/injoignable/);
  });
});
