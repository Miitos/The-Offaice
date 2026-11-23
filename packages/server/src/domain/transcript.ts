import fs from 'node:fs';
import type { DB } from '../db.js';

export interface TranscriptEntry {
  at: number;
  kind: 'text' | 'tool' | 'result' | 'prompt';
  text: string;
  tool?: string;
  isError?: boolean;
}

const TAIL_BYTES = 256 * 1024;

function short(s: string, n: number) {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function toolSummary(name: string, input: Record<string, unknown> = {}): string {
  const file = (input.file_path ?? input.notebook_path ?? input.path) as string | undefined;
  if (typeof input.command === 'string') return short(input.command, 140);
  if (file) return file.replace(/\\/g, '/').split('/').slice(-3).join('/');
  if (name.startsWith('mcp__office__')) {
    const rest = Object.entries(input)
      .filter(([k]) => k !== '_office_agent')
      .map(([k, v]) => `${k}=${typeof v === 'string' ? short(v, 50) : JSON.stringify(v)}`)
      .join(' ');
    return short(rest, 160);
  }
  if (typeof input.pattern === 'string') return input.pattern;
  if (typeof input.to === 'string') return `→ ${input.to}${typeof input.message === 'string' ? ' : ' + short(input.message, 100) : ''}`;
  return short(JSON.stringify(input), 140);
}

/** Recent, readable entries of an agent's transcripts (text, tool calls, results). */
export function recentTranscript(db: DB, agent: string, limit = 40): TranscriptEntry[] {
  const files = (db.prepare('SELECT file FROM transcript_offsets WHERE agent = ?').all(agent) as { file: string }[])
    .map((r) => r.file)
    .filter((f) => fs.existsSync(f))
    .map((f) => ({ f, m: fs.statSync(f).mtimeMs }))
    .sort((a, b) => b.m - a.m)
    .slice(0, 3);
  const out: TranscriptEntry[] = [];
  for (const { f } of files) {
    const size = fs.statSync(f).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const fd = fs.openSync(f, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // partial first line
    for (const line of lines) {
      if (!line.trim()) continue;
      let e: any;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      const at = Date.parse(e.timestamp ?? '') || 0;
      const content = e.message?.content;
      if (e.type === 'assistant' && Array.isArray(content)) {
        for (const c of content) {
          if (c.type === 'text' && c.text?.trim()) out.push({ at, kind: 'text', text: short(c.text, 600) });
          else if (c.type === 'tool_use') out.push({ at, kind: 'tool', tool: c.name, text: toolSummary(c.name, c.input) });
        }
      } else if (e.type === 'user') {
        if (typeof content === 'string' && content.trim()) out.push({ at, kind: 'prompt', text: short(content, 400) });
        else if (Array.isArray(content)) {
          for (const c of content) {
            if (c.type === 'tool_result') {
              const text = Array.isArray(c.content) ? c.content.map((x: any) => x.text ?? '').join(' ') : String(c.content ?? '');
              out.push({ at, kind: 'result', text: short(text, 240), isError: !!c.is_error });
            } else if (c.type === 'text' && c.text?.trim()) out.push({ at, kind: 'prompt', text: short(c.text, 400) });
          }
        }
      }
    }
  }
  return out.sort((a, b) => a.at - b.at).slice(-limit);
}
