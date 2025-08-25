import { z } from 'zod';
import { ToolSpec } from '../types.js';
import { writeFile, stat } from 'node:fs/promises';

const schema = z.object({
  path: z.string().min(1),
  content: z.string().max(2_000_000),
  overwrite: z.boolean().default(false),
});

export default <ToolSpec<typeof schema>>{
  name: 'write_file',
  description: 'Write text content to a file. Use overwrite=false to avoid clobbering.',
  schema,
  sensitive: true,
  async run({ path, content, overwrite }) {
    if (!overwrite) {
      try {
        await stat(path);
        throw new Error('File exists; set overwrite=true to replace');
      } catch (err: any) {
        if (err?.code && err.code !== 'ENOENT') throw err;
        // if ENOENT, proceed to write
      }
    }
    await writeFile(path, content, 'utf-8');
    return { path, bytes: Buffer.byteLength(content) };
  }
}

