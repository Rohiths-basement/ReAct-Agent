import { z } from 'zod';
import { ToolSpec } from '../types.js';

const schema = z.object({
  text: z.string(),
  decode: z.boolean().default(false)
});

const tool: ToolSpec<typeof schema> = {
  name: 'base64_encode',
  description: 'Encode text to base64 or decode base64 to text.',
  schema,
  async run({ text, decode }) {
    try {
      if (decode) {
        const decoded = Buffer.from(text, 'base64').toString('utf-8');
        return { operation: 'decode', input: text, output: decoded };
      } else {
        const encoded = Buffer.from(text, 'utf-8').toString('base64');
        return { operation: 'encode', input: text, output: encoded };
      }
    } catch (error: any) {
      throw new Error(`Base64 ${decode ? 'decode' : 'encode'} failed: ${error.message}`);
    }
  }
};

export default tool;
