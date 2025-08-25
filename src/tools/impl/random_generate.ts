import { z } from 'zod';
import { ToolSpec } from '../types.js';
import { randomInt, randomBytes } from 'node:crypto';

const schema = z.object({
  type: z.enum(['number', 'string', 'bytes']).default('number'),
  min: z.number().default(0),
  max: z.number().default(100),
  length: z.number().min(1).max(1000).default(10),
  charset: z.string().default('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')
});

const tool: ToolSpec<typeof schema> = {
  name: 'random_generate',
  description: 'Generate random numbers, strings, or bytes with customizable parameters.',
  schema,
  async run({ type, min, max, length, charset }) {
    switch (type) {
      case 'number':
        const num = randomInt(min, max + 1);
        return { type: 'number', value: num, min, max };
        
      case 'string':
        let result = '';
        for (let i = 0; i < length; i++) {
          result += charset[randomInt(0, charset.length)];
        }
        return { type: 'string', value: result, length, charset: charset.substring(0, 20) + '...' };
        
      case 'bytes':
        const bytes = randomBytes(length);
        return { 
          type: 'bytes', 
          value: bytes.toString('hex'), 
          length, 
          encoding: 'hex' 
        };
        
      default:
        throw new Error(`Unsupported type: ${type}`);
    }
  }
};

export default tool;
