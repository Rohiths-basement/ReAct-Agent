import { z } from 'zod';
import { ToolSpec } from '../types.js';

const schema = z.object({
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
  pick: z.string().optional(), // dot.path[0].field
  maxBytes: z.number().min(1000).max(2_000_000).default(200_000),
});

function getByPath(obj: any, path: string) {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  let cur = obj;
  for (const p of parts) { if (!p) continue; cur = (cur as any)?.[p]; }
  return cur;
}

export default <ToolSpec<typeof schema>>{
  name: 'http_json_get',
  description: 'HTTP GET a JSON API endpoint with optional headers and dot-path selection.',
  schema,
  async run({ url, headers, pick, maxBytes }) {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const slice = text.slice(0, maxBytes);
    let data: any;
    try { data = JSON.parse(slice); } catch { throw new Error('Response not valid JSON (or exceeds maxBytes)'); }
    const picked = pick ? getByPath(data, pick) : undefined;
    return { url, data: pick ? undefined : data, picked, pick };
  }
}

