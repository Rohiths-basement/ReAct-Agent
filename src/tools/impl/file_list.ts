import { z } from 'zod';
import { ToolSpec } from '../types.js';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const schema = z.object({
  path: z.string().min(1),
  recursive: z.boolean().default(false),
  showHidden: z.boolean().default(false)
});

const tool: ToolSpec<typeof schema> = {
  name: 'file_list',
  description: 'List files and directories in a path. Can be recursive and show hidden files.',
  schema,
  async run({ path, recursive, showHidden }) {
    const items: Array<{ name: string; type: 'file' | 'directory'; size?: number; path: string }> = [];
    
    async function scan(currentPath: string, depth = 0) {
      if (depth > 10) return; // prevent infinite recursion
      
      const entries = await readdir(currentPath);
      for (const entry of entries) {
        if (!showHidden && entry.startsWith('.')) continue;
        
        const fullPath = join(currentPath, entry);
        const stats = await stat(fullPath);
        
        items.push({
          name: entry,
          type: stats.isDirectory() ? 'directory' : 'file',
          size: stats.isFile() ? stats.size : undefined,
          path: fullPath
        });
        
        if (recursive && stats.isDirectory()) {
          await scan(fullPath, depth + 1);
        }
      }
    }
    
    await scan(path);
    return { path, items, count: items.length };
  }
};

export default tool;
