import { z } from 'zod';
import { ToolSpec } from '../types.js';
import { writeFile } from 'node:fs/promises';

const schema = z.object({
  path: z.string().min(1),
  content: z.string(),
  append: z.boolean().default(false)
});

const tool: ToolSpec<typeof schema> = {
  name: 'file_write',
  description: 'Write content to a local file. Can append or overwrite.',
  schema,
  sensitive: true,
  async run({ path, content, append }) {
    const options = append ? { flag: 'a' } : {};
    await writeFile(path, content, options);
    return { path, bytesWritten: Buffer.byteLength(content, 'utf8'), mode: append ? 'append' : 'overwrite' };
  }
};

export default tool;
