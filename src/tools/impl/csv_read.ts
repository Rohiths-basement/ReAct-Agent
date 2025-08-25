import { z } from 'zod';
import { ToolSpec } from '../types.js';
import { readFile } from 'node:fs/promises';
import Papa from 'papaparse';

const schema = z.object({
  path: z.string().min(1),
  limit: z.number().min(1).max(1000).default(100),
  header: z.boolean().default(true),
});

export default <ToolSpec<typeof schema>>{
  name: 'csv_read',
  description: 'Read a CSV file and return header + first N rows.',
  schema,
  async run({ path, limit, header }) {
    const csv = await readFile(path, 'utf-8');
    const parsed = Papa.parse(csv, { header, skipEmptyLines: true });
    const rows = (parsed.data as any[]).slice(0, limit);
    return { path, fields: (parsed as any).meta?.fields, rows, truncated: (parsed.data as any[]).length > limit };
  }
}

