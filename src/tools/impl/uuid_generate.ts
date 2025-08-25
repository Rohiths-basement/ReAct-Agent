import { z } from 'zod';
import { ToolSpec } from '../types.js';
import { randomUUID } from 'node:crypto';

const schema = z.object({
  count: z.number().min(1).max(100).default(1),
  version: z.enum(['v4']).default('v4')
});

const tool: ToolSpec<typeof schema> = {
  name: 'uuid_generate',
  description: 'Generate one or more UUIDs (currently supports v4 only).',
  schema,
  async run({ count, version }) {
    const uuids: string[] = [];
    
    for (let i = 0; i < count; i++) {
      uuids.push(randomUUID());
    }
    
    return {
      version,
      count,
      uuids: count === 1 ? uuids[0] : uuids
    };
  }
};

export default tool;
