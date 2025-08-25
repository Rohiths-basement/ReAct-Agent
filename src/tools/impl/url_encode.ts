import { z } from 'zod';
import { ToolSpec } from '../types.js';

const schema = z.object({
  text: z.string(),
  decode: z.boolean().default(false),
  component: z.boolean().default(true)
});

const tool: ToolSpec<typeof schema> = {
  name: 'url_encode',
  description: 'URL encode/decode text. Component mode encodes more characters for URL components.',
  schema,
  async run({ text, decode, component }) {
    try {
      if (decode) {
        const decoded = component ? decodeURIComponent(text) : decodeURI(text);
        return { operation: 'decode', input: text, output: decoded, component };
      } else {
        const encoded = component ? encodeURIComponent(text) : encodeURI(text);
        return { operation: 'encode', input: text, output: encoded, component };
      }
    } catch (error: any) {
      throw new Error(`URL ${decode ? 'decode' : 'encode'} failed: ${error.message}`);
    }
  }
};

export default tool;
