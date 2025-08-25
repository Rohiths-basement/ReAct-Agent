import { z } from 'zod';
import { ToolSpec } from '../types.js';

const schema = z.object({
  input: z.string().optional(),
  format: z.string().default('ISO'),
  timezone: z.string().default('UTC'),
  operation: z.enum(['format', 'parse', 'now']).default('now')
});

const tool: ToolSpec<typeof schema> = {
  name: 'date_format',
  description: 'Format dates, parse date strings, or get current time in various formats.',
  schema,
  async run({ input, format, timezone, operation }) {
    const now = new Date();
    
    if (operation === 'now') {
      return {
        operation: 'now',
        timestamp: now.getTime(),
        iso: now.toISOString(),
        formatted: formatDate(now, format),
        timezone
      };
    }
    
    if (operation === 'parse' && input) {
      try {
        const parsed = new Date(input);
        if (isNaN(parsed.getTime())) {
          throw new Error('Invalid date string');
        }
        return {
          operation: 'parse',
          input,
          timestamp: parsed.getTime(),
          iso: parsed.toISOString(),
          formatted: formatDate(parsed, format)
        };
      } catch (error: any) {
        throw new Error(`Date parsing failed: ${error.message}`);
      }
    }
    
    if (operation === 'format' && input) {
      try {
        const date = new Date(input);
        if (isNaN(date.getTime())) {
          throw new Error('Invalid date string');
        }
        return {
          operation: 'format',
          input,
          formatted: formatDate(date, format),
          iso: date.toISOString()
        };
      } catch (error: any) {
        throw new Error(`Date formatting failed: ${error.message}`);
      }
    }
    
    throw new Error('Invalid operation or missing input');
  }
};

function formatDate(date: Date, format: string): string {
  switch (format.toLowerCase()) {
    case 'iso':
      return date.toISOString();
    case 'date':
      return date.toDateString();
    case 'time':
      return date.toTimeString();
    case 'locale':
      return date.toLocaleString();
    case 'unix':
      return Math.floor(date.getTime() / 1000).toString();
    default:
      return date.toISOString();
  }
}

export default tool;
