import { z } from 'zod';
import { ToolSpec } from '../types.js';
import { readFile } from 'node:fs/promises';

const schema = z.object({ path: z.string().min(1), maxBytes: z.number().min(1).max(2_000_000).default(100_000) });

const tool: ToolSpec<typeof schema> = {
  name: 'file_read',
  description: 'Read a local text file and return the first N bytes.',
  schema,
  sensitive: true, // mark as sensitive to demo approvals
  async run({ path, maxBytes }) {
    const buf = await readFile(path);
    return { path, content: buf.toString('utf-8', 0, Math.min(maxBytes, buf.length)) };
  }
};

export default tool;

