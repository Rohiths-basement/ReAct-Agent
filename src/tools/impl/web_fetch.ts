import { z } from 'zod';
import { ToolSpec } from '../types.js';

const schema = z.object({ url: z.string().url(), maxBytes: z.number().min(1000).max(2000000).default(100000) });

const tool: ToolSpec<typeof schema> = {
  name: 'web_fetch',
  description: 'Fetch raw text content from a URL (no JS execution). Returns up to maxBytes.',
  schema,
  async run({ url, maxBytes }) {
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    return { url, snippet: text.slice(0, maxBytes) };
  }
};

export default tool;

