import { z } from 'zod';
import { ToolSpec } from '../types.js';

const schema = z.object({
  data: z.string(),
  indent: z.number().min(0).max(8).default(2),
  sortKeys: z.boolean().default(false)
});

const tool: ToolSpec<typeof schema> = {
  name: 'json_format',
  description: 'Parse and format JSON data with proper indentation and optional key sorting.',
  schema,
  async run({ data, indent, sortKeys }) {
    try {
      const parsed = JSON.parse(data);
      
      const formatted = JSON.stringify(
        sortKeys ? sortObjectKeys(parsed) : parsed,
        null,
        indent
      );
      
      return {
        valid: true,
        formatted,
        originalSize: data.length,
        formattedSize: formatted.length
      };
    } catch (error: any) {
      return {
        valid: false,
        error: error.message,
        originalSize: data.length
      };
    }
  }
};

function sortObjectKeys(obj: any): any {
  if (Array.isArray(obj)) {
    return obj.map(sortObjectKeys);
  } else if (obj !== null && typeof obj === 'object') {
    const sorted: any = {};
    Object.keys(obj).sort().forEach(key => {
      sorted[key] = sortObjectKeys(obj[key]);
    });
    return sorted;
  }
  return obj;
}

export default tool;
