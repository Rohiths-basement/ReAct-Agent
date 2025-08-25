import { z } from 'zod';
import { ToolSpec } from '../types.js';
import { readFile } from 'node:fs/promises';

const schema = z.object({
  path: z.string().min(1),
  pick: z.string().optional(),
});

function getByPath(obj: any, path: string) {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  let cur = obj;
  for (const p of parts) { if (!p) continue; cur = (cur as any)?.[p]; }
  return cur;
}

export default <ToolSpec<typeof schema>>{
  name: 'json_read',
  description: 'Read a local JSON file and optionally pick a dot-path value.',
  schema,
  sensitive: true,
  async run({ path, pick }) {
    const text = await readFile(path, 'utf-8');
    const data = JSON.parse(text);
    const picked = pick ? getByPath(data, pick) : undefined;
    return { path, data: pick ? undefined : data, picked, pick };
  }
}

