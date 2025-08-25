import { z } from 'zod';
import { ToolSpec } from '../types.js';
import { createHash } from 'node:crypto';

const schema = z.object({
  text: z.string(),
  algorithm: z.enum(['md5', 'sha1', 'sha256', 'sha512']).default('sha256')
});

const tool: ToolSpec<typeof schema> = {
  name: 'hash_generate',
  description: 'Generate cryptographic hashes (MD5, SHA1, SHA256, SHA512) for text input.',
  schema,
  async run({ text, algorithm }) {
    const hash = createHash(algorithm);
    hash.update(text, 'utf8');
    const digest = hash.digest('hex');
    
    return {
      algorithm,
      input: text,
      inputLength: text.length,
      hash: digest
    };
  }
};

export default tool;
